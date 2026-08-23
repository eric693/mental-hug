const Anthropic = require('@anthropic-ai/sdk');
const { db, getSetting, today, addDays } = require('./db');
const { computeTiers, financeSummary } = require('./routes/insights');

// AI 助理：讓所方用自然語言問後台資料（「這個月收多少」「誰快流失了」「林心理師下週幾個空檔」）。
//
// 兩條紅線，寫在工具層而不是提示詞裡——提示詞會被繞過，工具不會：
//   1. 一律唯讀。所有工具都是 SELECT，沒有任何寫入或刪除的能力。
//   2. 晤談內容永不外傳。工具查得到「有沒有寫紀錄、幾號寫的」，
//      但 S/O/A/P、風險描述、安全計畫、團體歷程等內容一概不進模型的上下文。
//      這是《心理師法》的保密邊界，也是把資料送到外部服務時最該守住的一條。
//
// 另外，工具全部依「發問者本人的模組權限」再過濾一次：行政人員問不到他在畫面上
// 本來就看不到的東西。

const MODEL = 'claude-opus-5';

function apiKey() {
  return (getSetting('ai_api_key', '') || process.env.ANTHROPIC_API_KEY || '').trim();
}
function enabled() { return !!apiKey(); }

// ---- 後台欄位字典 ----
// 心理師與行政常問「這個欄位到底要填什麼」，做成資料讓 AI 查得到，
// 也可直接在畫面上當說明用。
const FIELD_GUIDE = {
  '晤談紀錄 S（主觀陳述）': '個案自己說的：主訴、這週發生什麼、他如何描述自己的狀態。用個案的語言，避免先下判斷。',
  '晤談紀錄 O（客觀觀察）': '心理師觀察到的：外觀、情緒表現、語速、互動方式、出席與準時狀況等可被第三者核對的事實。',
  '晤談紀錄 A（評估）': '把 S 與 O 整合成專業判斷：概念化、症狀變化、風險評估、與處遇目標的關係。',
  '晤談紀錄 P（處遇計畫）': '下一步要做什麼：下次晤談方向、家庭作業、是否轉介或調整頻率。',
  '介入技術／取向': '本次實際使用的技術（CBT、動力取向、EMDR…），供督導與成效檢視時參考。',
  '風險註記': 'none 無／ideation 有意念／plan 有計畫／attempt 有行為。非 none 會進入危機追蹤與總覽警示。',
  '個案風險等級': 'low／medium／high。high 會在總覽與今日看板標紅，並列入安全計畫列管。',
  '預約狀態': 'booked 已預約、arrived 已報到、done 已完成、cancelled 已取消、no_show 未到。標記 done 會依方案扣次或產生收費單；no_show 依設定比例計費。',
  '收費單狀態': 'unpaid 未收款、paid 已收款、void 作廢、refunded 已退費。作廢與退費都不刪單，保留勾稽。',
  '付款人別': '自費、企業EAP、學校方案、社會局補助等。報表與請款依此分類。',
  '方案（packages）': '預付堂數。完成晤談時自動扣次；扣過次數的方案不可刪除。',
  '同意書版本': '範本內容一改版本就加一，已簽署者需重新簽署；簽署時保存當下全文快照。',
  '客戶分級': '依累計完成晤談、付費狀況、出席率三面向計分。出席率＝完成÷(完成＋未到)，取消不計入。',
  '據點（sites）': '分館。諮商室屬於某據點，心理師可跨據點駐點；預約的據點跟著諮商室走。',
  '改期申請狀態': 'new 待審核轉達、relayed 待心理師回覆、replied 待行政簽核、approved 已簽核改期、denied 未轉達、rejected 已退回。'
};

// ---- 工具實作（全部唯讀）----

function can(user, mod) {
  return user.role === 'admin' || (user.modules || []).includes(mod);
}

const TOOLS = {
  // 所務概況
  overview: {
    module: null,
    def: {
      name: 'overview',
      description: '諮商所目前的概況：服務中個案數、今日與本週預約、待補紀錄、未收款、待處理來電。問「現在所裡狀況如何」時用這個。',
      input_schema: { type: 'object', properties: {}, additionalProperties: false }
    },
    run: () => ({
      服務中個案: db.prepare("SELECT COUNT(*) n FROM clients WHERE active = 1 AND status != 'closed'").get().n,
      今日預約: db.prepare("SELECT COUNT(*) n FROM appointments WHERE date = ? AND status IN ('booked','arrived')").get(today()).n,
      未來七日預約: db.prepare("SELECT COUNT(*) n FROM appointments WHERE date BETWEEN ? AND ? AND status IN ('booked','arrived')").get(today(), addDays(today(), 7)).n,
      本月完成晤談: db.prepare("SELECT COUNT(*) n FROM appointments WHERE substr(date,1,7) = ? AND status = 'done'").get(today().slice(0, 7)).n,
      待補晤談紀錄: db.prepare(`SELECT COUNT(*) n FROM appointments a WHERE a.status = 'done'
        AND NOT EXISTS (SELECT 1 FROM session_notes n WHERE n.appointment_id = a.id)`).get().n,
      未收款金額: db.prepare("SELECT COALESCE(SUM(amount),0) n FROM invoices WHERE status = 'unpaid'").get().n,
      待處理來電: db.prepare("SELECT COUNT(*) n FROM intakes WHERE status IN ('new','waiting')").get().n,
      待審核的改期申請: db.prepare("SELECT COUNT(*) n FROM reschedule_requests WHERE status IN ('new','relayed','replied')").get().n
    })
  },

  // 排程查詢
  schedule: {
    module: 'schedule',
    def: {
      name: 'schedule',
      description: '查某段日期的預約與空檔。可指定心理師姓名。回傳每筆預約的時間、心理師、狀態與個案代號（不含姓名以外的個資），以及該心理師當日剩餘可預約時段。',
      input_schema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '起始日 YYYY-MM-DD，預設今天' },
          to: { type: 'string', description: '結束日 YYYY-MM-DD，預設同起始日' },
          counselor: { type: 'string', description: '心理師姓名，可省略' }
        },
        additionalProperties: false
      }
    },
    run: a => {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(a.from || '') ? a.from : today();
      const to = /^\d{4}-\d{2}-\d{2}$/.test(a.to || '') ? a.to : from;
      const cond = a.counselor ? 'AND u.name LIKE ?' : '';
      const args = a.counselor ? [from, to, `%${a.counselor}%`] : [from, to];
      return {
        期間: `${from} ~ ${to}`,
        預約: db.prepare(`SELECT a.date, a.start_time, a.end_time, a.status, a.type, a.mode,
            u.name AS counselor, c.code AS client_code, r.name AS room, s.name AS site
          FROM appointments a
          LEFT JOIN users u ON u.id = a.counselor_id
          LEFT JOIN clients c ON c.id = a.client_id
          LEFT JOIN rooms r ON r.id = a.room_id
          LEFT JOIN sites s ON s.id = a.site_id
          WHERE a.date BETWEEN ? AND ? ${cond}
          ORDER BY a.date, a.start_time LIMIT 200`).all(...args)
      };
    }
  },

  // 個案查詢（僅行政層欄位）
  clients: {
    module: 'clients',
    def: {
      name: 'clients',
      description: '查個案清單與行政層資訊（代號、姓名、主責心理師、狀態、風險等級、初談日、完成次數、未收款）。不包含任何晤談內容。可用關鍵字、主責心理師、狀態篩選。',
      input_schema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '姓名或代號關鍵字' },
          counselor: { type: 'string', description: '主責心理師姓名' },
          status: { type: 'string', enum: ['active', 'closed', 'paused'], description: '個案狀態' },
          limit: { type: 'integer', description: '最多回幾筆，預設 30' }
        },
        additionalProperties: false
      }
    },
    run: a => {
      const where = ['c.active = 1'], args = [];
      if (a.keyword) { where.push('(c.name LIKE ? OR c.code LIKE ?)'); args.push(`%${a.keyword}%`, `%${a.keyword}%`); }
      if (a.counselor) { where.push('u.name LIKE ?'); args.push(`%${a.counselor}%`); }
      if (a.status) { where.push('c.status = ?'); args.push(a.status); }
      args.push(Math.min(Number(a.limit) || 30, 100));
      return db.prepare(`SELECT c.code, c.name, c.status, c.risk_level, c.intake_date,
          u.name AS counselor,
          (SELECT COUNT(*) FROM appointments x WHERE x.client_id = c.id AND x.status = 'done') AS 完成次數,
          (SELECT COALESCE(SUM(i.amount),0) FROM invoices i WHERE i.client_id = c.id AND i.status = 'unpaid') AS 未收款
        FROM clients c LEFT JOIN users u ON u.id = c.counselor_id
        WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ?`).all(...args);
    }
  },

  // 客戶分級
  tiers: {
    module: 'clients',
    def: {
      name: 'client_tiers',
      description: '客戶分級結果：長期穩定／固定／觀察／新收／沉睡／需關注。想知道「誰快流失」「誰欠款」「哪些人該優先聯繫」時用這個。',
      input_schema: {
        type: 'object',
        properties: { tier: { type: 'string', description: 'vip/regular/watch/new/dormant/attention，可省略表示全部' } },
        additionalProperties: false
      }
    },
    run: a => {
      const rows = computeTiers();
      const list = a.tier ? rows.filter(r => r.tier === a.tier) : rows;
      const counts = {};
      for (const r of rows) counts[r.tier] = (counts[r.tier] || 0) + 1;
      return {
        各級人數: counts,
        名單: list.slice(0, 60).map(c => ({
          代號: c.code, 姓名: c.name, 等級: c.tier, 主責: c.counselor_name,
          完成: c.done, 未到: c.no_show, 出席率: c.attendance, 距上次天數: c.days_since,
          未收款: c.unpaid_amount, 判定依據: c.why
        }))
      };
    }
  },

  // 財務
  finance: {
    module: 'billing',
    def: {
      name: 'finance',
      description: '財務數字：指定月份的實收、未收、退費、完成晤談數、平均單次、心理師報酬，以及近幾個月趨勢與逾期未收款。',
      input_schema: {
        type: 'object',
        properties: {
          month: { type: 'string', description: '月份 YYYY-MM，預設本月' },
          months: { type: 'integer', description: '要看幾個月的趨勢，預設 6' }
        },
        additionalProperties: false
      }
    },
    run: a => financeSummary(a.month, Math.min(Number(a.months) || 6, 24))
  },

  // 心理師服務量（第 3 項：後台表單欄位理解心理師出產）
  counselor_output: {
    module: 'reports',
    def: {
      name: 'counselor_output',
      description: '心理師的產出概況：完成晤談數、未到與取消、服務個案數、晤談紀錄完成率與平均補紀錄天數（只看有沒有寫、何時寫，不看內容）。用於檢視工作量與紀錄品質管理。',
      input_schema: {
        type: 'object',
        properties: {
          month: { type: 'string', description: '月份 YYYY-MM，預設本月' },
          counselor: { type: 'string', description: '心理師姓名，可省略表示全部' }
        },
        additionalProperties: false
      }
    },
    run: a => {
      const month = /^\d{4}-\d{2}$/.test(a.month || '') ? a.month : today().slice(0, 7);
      const like = month + '%';
      const cond = a.counselor ? 'AND u.name LIKE ?' : '';
      const args = a.counselor ? [like, like, like, like, like, `%${a.counselor}%`] : [like, like, like, like, like];
      return {
        月份: month,
        資料: db.prepare(`SELECT u.name AS 心理師, u.license_type AS 證照,
            SUM(CASE WHEN a.status = 'done' AND a.date LIKE ? THEN 1 ELSE 0 END) AS 完成晤談,
            SUM(CASE WHEN a.status = 'no_show' AND a.date LIKE ? THEN 1 ELSE 0 END) AS 未到,
            SUM(CASE WHEN a.status = 'cancelled' AND a.date LIKE ? THEN 1 ELSE 0 END) AS 取消,
            COUNT(DISTINCT CASE WHEN a.status = 'done' AND a.date LIKE ? THEN a.client_id END) AS 服務個案數,
            (SELECT COUNT(*) FROM session_notes n WHERE n.counselor_id = u.id AND n.date LIKE ?) AS 已寫紀錄,
            (SELECT COUNT(*) FROM appointments b WHERE b.counselor_id = u.id AND b.status = 'done'
              AND NOT EXISTS (SELECT 1 FROM session_notes n2 WHERE n2.appointment_id = b.id)) AS 待補紀錄
          FROM users u LEFT JOIN appointments a ON a.counselor_id = u.id
          WHERE u.active = 1 AND u.role IN ('counselor','supervisor','admin') ${cond}
          GROUP BY u.id ORDER BY 完成晤談 DESC`).all(...args)
      };
    }
  },

  // 欄位字典
  field_guide: {
    module: null,
    def: {
      name: 'field_guide',
      description: '後台表單欄位的意義與填寫原則（SOAP 各欄、風險註記、預約與收費狀態、方案、同意書版本、客戶分級等）。有人問「這個欄位要填什麼」時用這個。',
      input_schema: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '欄位關鍵字，可省略表示全部' } },
        additionalProperties: false
      }
    },
    run: a => {
      const kw = String(a.keyword || '').trim();
      const entries = Object.entries(FIELD_GUIDE)
        .filter(([k, v]) => !kw || k.includes(kw) || v.includes(kw));
      return Object.fromEntries(entries);
    }
  }
};

const SYSTEM = `你是台灣一間心理諮商所後台系統的內部助理，服務對象是所內的行政人員、心理師與管理者。

回答規則：
- 一律使用繁體中文，語氣像同事之間講話，直接講重點，不要客套開場白。
- 只根據工具查到的資料回答。查不到就說查不到，不要推測或編造數字。
- 金額用新台幣，寫成「12,000 元」這種讀得懂的格式；日期寫「8/23（六）」這種。
- 需要多個角度時可以連續呼叫多個工具，但不要為了湊字數重複查。
- 回答完如果有明顯該處理的事（逾期未收款、待補紀錄、快流失的個案），用一兩句提醒即可。

保密限制（不可違反）：
- 你沒有、也不會取得任何晤談紀錄內容、安全計畫內容或團體歷程紀錄。
  這些是《心理師法》保護的心理紀錄，只有主責心理師、督導與管理者能在系統裡直接調閱。
- 若有人要你提供晤談內容、個案的談話細節或臨床評估文字，說明系統不提供，
  請他到個案頁的「晤談紀錄」分頁自行查閱（該處會留下調閱軌跡）。
- 你可以說「某次晤談有沒有寫紀錄、何時寫的」，那是行政層資訊。

你不能修改任何資料。要新增、修改或刪除，請對方到對應頁面自己操作。`;

// 依使用者權限決定這次能用哪些工具
function toolsFor(user) {
  return Object.values(TOOLS).filter(t => !t.module || can(user, t.module));
}

async function ask({ question, user, history = [] }) {
  if (!enabled()) throw new Error('尚未設定 AI 助理的 API 金鑰');
  const client = new Anthropic({ apiKey: apiKey() });
  const available = toolsFor(user);
  const byName = Object.fromEntries(available.map(t => [t.def.name, t]));

  const messages = [
    ...history.slice(-8).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) })),
    { role: 'user', content: String(question).slice(0, 2000) }
  ];

  const used = [];
  // 自己跑 tool loop：工具都是本機唯讀查詢，跑得很快，不需要串流
  for (let turn = 0; turn < 6; turn++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: `${SYSTEM}\n\n今天是 ${today()}。提問者：${user.name}（${user.role}）。`,
      tools: available.map(t => t.def),
      messages
    });
    messages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason !== 'tool_use') {
      const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return { answer: text || '（沒有產生回覆）', tools_used: used, usage: resp.usage };
    }

    const results = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      const tool = byName[block.name];
      used.push(block.name);
      let out;
      try {
        out = tool ? tool.run(block.input || {}) : { error: '沒有這個工具或您無此模組權限' };
      } catch (e) {
        out = { error: String(e.message || e).slice(0, 300) };
      }
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(out).slice(0, 60000),
        ...(out && out.error ? { is_error: true } : {})
      });
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: '查詢步驟過多，請把問題問得更具體一點。', tools_used: used };
}

module.exports = { ask, enabled, FIELD_GUIDE, TOOLS, MODEL };
