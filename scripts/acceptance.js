// 驗收腳本：逐項對照客戶提出的需求，並驗證跨模組的資料是否真的串通。
//
//   npm run accept
//
// 與 smoke.js 的分工：smoke 是「每個端點行為對不對」的回歸測試；
// 這支是「客戶要的那幾件事，從頭到尾走一遍會不會通」的驗收。
// 它刻意走完整條鏈：排班核定 → 預約 → 完成 → 收費 → 入帳 → 拆帳 → 財務指標 → 績效，
// 每一站都檢查前一站的數字有沒有正確傳過去——資料沒同步的話這裡就會斷。
//
// 全程在拋棄式資料庫上跑，不碰正式資料。

process.env.TZ = process.env.TZ || 'Asia/Taipei';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcare-accept-'));
const KEEP = process.argv.includes('--keep');
const env = {
  ...process.env,
  TZ: 'Asia/Taipei',
  MINDCARE_DATA_DIR: path.join(tmp, 'data'),
  MINDCARE_UPLOAD_DIR: path.join(tmp, 'uploads'),
  MINDCARE_BACKUP_MIRROR: path.join(tmp, 'mirror')
};

let BASE = '';
const results = [];
let currentGroup = '';

function group(name) { currentGroup = name; console.log(`\n【${name}】`); }
async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ group: currentGroup, name, ok: true });
    console.log(`  ✓ ${name}${detail ? `　${detail}` : ''}`);
  } catch (e) {
    results.push({ group: currentGroup, name, ok: false, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function must(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}（預期 ${b}，實際 ${a}）`); }

function session() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    async ok(method, url, body) {
      const r = await call(method, url, body);
      if (r.status !== 200) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
      return r.data;
    },
    call
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

let server;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('node', [path.join(ROOT, 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('伺服器啟動逾時：\n' + out)), 20000);
    server.stdout.on('data', d => { out += d; if (out.includes('個案專區')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', d => { out += d; });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`伺服器結束（code ${code}）：\n${out}`)); });
  });
}

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };

(async () => {
  const port = await freePort();
  env.PORT = String(port);
  BASE = `http://127.0.0.1:${port}`;
  console.log(`驗收環境：${tmp}（埠 ${port}）`);
  execFileSync('node', [path.join(ROOT, 'scripts', 'seed.js')], { env, stdio: 'ignore' });
  await startServer();

  const admin = session(), lin = session();
  await admin.ok('POST', '/api/login', { username: 'admin', password: 'mindcare123' });
  await lin.ok('POST', '/api/login', { username: 'lin', password: '123456' });

  const today = ymd(new Date());
  const month = today.slice(0, 7);
  // 找一個未來的週一，避開 seed 既有排程
  let day = addDays(today, 10);
  while (new Date(day + 'T00:00:00').getDay() !== 1) day = addDays(day, 1);

  let siteId, roomId, clientId, apptId, invoiceId;

  // ── 需求 1：買斷制營運管理系統 ────────────────────────────────
  group('預約管理與排班（含產能分母）');
  await step('建立據點與諮商室', async () => {
    const s = await admin.ok('POST', '/api/sites', { name: '驗收館', short_name: '驗收', legal_entity: '驗收心理諮商所', tax_id: '12345675', receipt_prefix: 'AC' });
    siteId = s.id;
    const r = await admin.ok('POST', '/api/rooms', { name: '驗收室', site_id: siteId, capacity: 2, rent_rate: 800 });
    roomId = r.id;
    return `據點 #${siteId}、諮商室 #${roomId}`;
  });
  await step('心理師提交可預約時段並由排班負責人核定', async () => {
    const sub = await lin.ok('POST', '/api/availability/submissions', {
      period: month, site_id: siteId,
      blocks: [{ weekday: 1, start_time: '09:00', end_time: '18:00' }]
    });
    const before = (await admin.ok('GET', `/api/staffing/capacity?month=${month}`)).rows.find(u => u.id === 2).capacity_hours;
    await admin.ok('POST', `/api/availability/submissions/${sub.id}/approve`, {});
    const after = (await admin.ok('GET', `/api/staffing/capacity?month=${month}`)).rows.find(u => u.id === 2).capacity_hours;
    must(after > before, '核定後產能分母應增加');
    return `每週 9 小時 → 本月可排 ${after} 小時`;
  });
  await step('建立個案並排定預約（衝突與據點自動帶入）', async () => {
    const c = await admin.ok('POST', '/api/clients', { name: '驗收個案', phone: '0912000111', counselor_id: 2 });
    clientId = c.id;
    const a = await admin.ok('POST', '/api/appointments', {
      client_id: clientId, counselor_id: 2, room_id: roomId, date: day, start_time: '10:00', fee: 2000, designated: 1
    });
    apptId = a.id;
    const dup = await admin.call('POST', '/api/appointments', {
      client_id: clientId, counselor_id: 2, room_id: roomId, date: day, start_time: '10:00'
    });
    eq(dup.status, 400, '同時段重複預約應被擋下');
    const row = (await admin.ok('GET', `/api/appointments?client_id=${clientId}`)).find(x => x.id === apptId);
    eq(row.site_id, siteId, '預約的據點應由諮商室自動帶入');
    return `#${apptId} ${day} 10:00`;
  });

  group('收據開立與收費對帳');
  await step('完成晤談自動開單，收款後產生收據號與金流紀錄', async () => {
    await admin.ok('POST', '/api/split-rules', { name: '驗收預設 60:40', counselor_pct: 60, priority: 500 });
    await admin.ok('POST', `/api/appointments/${apptId}/status`, { status: 'done' });
    const inv = (await admin.ok('GET', `/api/invoices?client_id=${clientId}&status=unpaid`)).rows
      .find(x => x.appointment_id === apptId);
    must(inv, '完成晤談應自動開立收費單');
    invoiceId = inv.id;
    await admin.ok('POST', `/api/invoices/${invoiceId}/pay`, { method: '現金' });
    const paid = (await admin.ok('GET', `/api/invoices?client_id=${clientId}&status=paid`)).rows
      .find(x => x.id === invoiceId);
    must(paid.receipt_no, '收款後應產生收據號');
    const pay = (await admin.ok('GET', '/api/payments?size=200')).rows.find(p => p.invoice_id === invoiceId);
    must(pay && pay.amount === paid.amount, '應有對應的金流入帳紀錄');
    return `收據 ${paid.receipt_no}，入帳 ${pay.amount} 元`;
  });
  await step('收據雙版本，補印必須留原因與軌跡', async () => {
    await admin.ok('GET', `/api/invoices/${invoiceId}/receipt-doc?variant=plain`);
    const blocked = await admin.call('GET', `/api/invoices/${invoiceId}/receipt-doc?variant=stamped`);
    eq(blocked.status, 400, '第二次列印未填原因應被擋下');
    const stamped = await admin.ok('GET',
      `/api/invoices/${invoiceId}/receipt-doc?variant=stamped&reason=${encodeURIComponent('個案遺失')}`);
    must(stamped.stamp_note.includes('印花稅'), '含章版應註明印花稅總繳');
    const log = await admin.ok('GET', `/api/invoices/${invoiceId}/receipt-prints`);
    must(log.length >= 2 && log.some(x => x.reason === '個案遺失'), '補印應留軌跡');
    return `已留 ${log.length} 筆列印軌跡`;
  });
  await step('三方勾稽（預約 ↔ 交易 ↔ 金流）無異常', async () => {
    const r = await admin.ok('GET', `/api/reconcile/report?month=${day.slice(0, 7)}`);
    must(!r.paid_no_payment.some(x => x.id === invoiceId), '這筆不應出現在「已收款沒入帳」');
    must(!r.amount_mismatch.some(x => x.id === invoiceId), '這筆不應出現在「金額不符」');
    const site = r.by_site.find(s => s.site === '驗收館');
    must(site, '應有該據點的收付對照');
    return `據點開單 ${site.invoiced} 元／入帳 ${site.received} 元`;
  });

  group('諮商紀錄批次列印');
  await step('撰寫紀錄並批次列印（用途必填、留批次軌跡與浮水印資訊）', async () => {
    const n = await lin.ok('POST', '/api/notes', {
      client_id: clientId, date: day, subjective: 'S', objective: 'O', assessment: 'A', plan: 'P'
    });
    const noReason = await lin.call('POST', '/api/notes/print-batch', { ids: [n.id] });
    eq(noReason.status, 400, '未填用途應被擋下');
    const out = await lin.ok('POST', '/api/notes/print-batch', { ids: [n.id], purpose: '督考' });
    must(/^PB-\d{8}-\d{4}$/.test(out.batch_no), '應產生批次編號');
    must(out.printed_by && out.printed_at, '應帶列印者與時間（浮水印用）');
    const batches = await admin.ok('GET', '/api/print-batches?size=50');
    must(batches.rows.some(b => b.batch_no === out.batch_no), '批次軌跡應查得到');
    return `批次 ${out.batch_no}，1 份`;
  });

  group('客戶價值分級');
  await step('分級依出席與付費計算，且取消不計入出席率', async () => {
    const d = await admin.ok('GET', '/api/client-tiers');
    const c = d.rows.find(x => x.id === clientId);
    must(c, '應列出該個案');
    const scheduled = c.done + c.no_show;
    eq(c.attendance, scheduled ? Math.round(c.done / scheduled * 100) : null, '出席率算法');
    must(d.labels[c.tier], '應有對應的等級標籤');
    return `${c.name}：${d.labels[c.tier]}（出席率 ${c.attendance}%）`;
  });

  group('財務報表視覺化的資料來源');
  await step('營收、成本、分攤、EBITDA 串得起來', async () => {
    await admin.ok('POST', '/api/cost-entries', { month: day.slice(0, 7), site_id: siteId, kind: 'direct', category: '租金', amount: 10000 });
    await admin.ok('POST', '/api/cost-entries', { month: day.slice(0, 7), kind: 'overhead', category: '總部', amount: 5000 });
    await admin.ok('POST', '/api/cost-entries', { month: day.slice(0, 7), site_id: siteId, kind: 'depreciation', category: '裝潢', amount: 1000 });
    const f = await admin.ok('GET', `/api/metrics/finance?month=${day.slice(0, 7)}`);
    const row = f.rows.find(r => r.site_id === siteId);
    must(row.revenue > 0, '該據點應有營收（來自剛才那筆收款）');
    eq(row.contribution, row.revenue - row.direct_cost, '貢獻毛利定義');
    eq(row.pretax, row.contribution - row.overhead_share, '稅前損益定義');
    eq(row.ebitda, row.pretax + row.interest + row.depreciation + row.amortization, 'EBITDA 定義');
    must(f.trend.length === 12, '應提供近 12 個月趨勢供長條圖使用');
    must(f.ar.rows.every(r => r.total === r['30'] + r['60'] + r['90'] + r['90+']), '帳齡分桶加總一致');
    return `營收 ${row.revenue}／貢獻 ${row.contribution}／稅前 ${row.pretax}／EBITDA ${row.ebitda}`;
  });
  await step('療程包套按次攤提（不在購買當月整筆認列）', async () => {
    const before = (await admin.ok('GET', `/api/metrics/finance?month=${day.slice(0, 7)}`)).all.package_recognized;
    const p = await admin.ok('POST', '/api/packages', {
      client_id: clientId, name: '驗收方案', sessions_total: 4, amount: 8000, start_date: day
    });
    const mid = (await admin.ok('GET', `/api/metrics/finance?month=${day.slice(0, 7)}`)).all.package_recognized;
    eq(mid, before, '購買當下不應認列');
    const a2 = await admin.ok('POST', '/api/appointments', {
      client_id: clientId, counselor_id: 2, date: addDays(day, 7), start_time: '10:00', package_id: p.id
    });
    await admin.ok('POST', `/api/appointments/${a2.id}/status`, { status: 'done' });
    const after = (await admin.ok('GET', `/api/metrics/finance?month=${addDays(day, 7).slice(0, 7)}`)).all.package_recognized;
    must(after >= 2000, '使用一次應認列 8000 ÷ 4 = 2000');
    return `攤提 ${after} 元`;
  });

  group('心理師績效儀表板');
  await step('拆帳 → 個人營收 → 貢獻毛利 → 利用率 全鏈打通', async () => {
    const sp = (await admin.ok('GET', `/api/splits?month=${day.slice(0, 7)}`)).rows.find(s => s.invoice_id === invoiceId);
    must(sp, '收款後應自動拆帳');
    eq(sp.counselor_amount + sp.center_amount, sp.amount, '拆分守恆');
    const m = await admin.ok('GET', `/api/metrics/staff?month=${day.slice(0, 7)}`);
    const u = m.rows.find(x => x.id === 2);
    must(u.revenue >= sp.amount, '個人營收應含這筆拆帳');
    eq(u.contribution, u.revenue - u.direct_cost, '貢獻毛利定義');
    must(u.utilization !== null, '應算得出利用率（分母來自核定時段）');
    must(u.designated_ratio !== null, '應算得出指名比例');
    return `營收 ${u.revenue}／每小時 ${u.hourly_rate}／利用率 ${u.utilization}%／指名 ${u.designated_ratio}%`;
  });

  group('AI 助理自然語言查詢');
  await step('工具唯讀且不含晤談內容；未設金鑰時明確提示', async () => {
    const st = await admin.ok('GET', '/api/ai/status');
    must(st.tools.length >= 5, '應提供多個查詢工具');
    const ai = require(path.join(ROOT, 'src', 'ai.js'));
    const dump = Object.values(ai.TOOLS).map(t => JSON.stringify(t.run({}))).join('');
    for (const secret of ['subjective', 'objective', 'assessment', 'process_note']) {
      must(!dump.includes(secret), `工具輸出不應包含晤談內容欄位 ${secret}`);
    }
    const r = await admin.call('POST', '/api/ai/ask', { question: '這個月收多少' });
    must(r.status === 400 && String(r.data.error).includes('金鑰'), '未設金鑰時應明確提示');
    return `${st.tools.length} 個唯讀工具，晤談內容不外流`;
  });

  // ── 需求 2：LINE 多層次人工審核 ────────────────────────────────
  group('LINE 溝通：AI 初篩 → 行政初審 → 心理師擬稿 → 行政複審 → 發送');
  let inqId;
  await step('① AI 初篩：分類、情緒與急迫度（危機字眼一律高標）', async () => {
    const r = await admin.ok('POST', '/api/inquiries', {
      client_id: clientId, raw_text: '這週真的撐不下去，想請假'
    });
    inqId = r.id;
    const row = (await admin.ok('GET', '/api/inquiries?status=new')).rows.find(x => x.id === inqId);
    eq(row.ai_category, '危機疑慮', '危機字眼應標為危機疑慮');
    eq(row.ai_urgency, 'high', '急迫度');
    eq(row.draft, '', 'AI 不應代寫回覆');
    return `分類 ${row.ai_category}／情緒 ${row.ai_sentiment}／急迫 ${row.ai_urgency}`;
  });
  await step('② 行政初審後才轉心理師（未初審不得擬稿）', async () => {
    const early = await lin.call('POST', `/api/inquiries/${inqId}/draft`, { draft: '偷跑' });
    eq(early.status, 400, '未經初審不應能擬稿');
    await admin.ok('POST', `/api/inquiries/${inqId}/relay`, { counselor_id: 2, admin_note: '請優先處理' });
    const row = (await admin.ok('GET', '/api/inquiries?status=relayed')).rows.find(x => x.id === inqId);
    eq(row.status, 'relayed', '狀態');
    must(row.relayed_by, '應記錄初審人');
    return '已轉心理師，並記錄初審人';
  });
  await step('③④ 心理師擬稿、行政複審可退回', async () => {
    await lin.ok('POST', `/api/inquiries/${inqId}/draft`, { draft: '我們很在意你的狀況' });
    const noReason = await admin.call('POST', `/api/inquiries/${inqId}/return`, { review_note: '' });
    eq(noReason.status, 400, '退回必須寫原因');
    await admin.ok('POST', `/api/inquiries/${inqId}/return`, { review_note: '請補上聯繫時間' });
    const row = (await admin.ok('GET', '/api/inquiries?status=returned')).rows.find(x => x.id === inqId);
    eq(row.status, 'returned', '退回後狀態');
    return '退回並附修改說明';
  });
  await step('⑤ 複審通過才送出，原擬稿保留供對照', async () => {
    await lin.ok('POST', `/api/inquiries/${inqId}/draft`, { draft: '我們很在意你的狀況，明天上午會致電' });
    await admin.ok('POST', `/api/inquiries/${inqId}/approve`, {
      final_reply: '我們很在意你的狀況，明天上午 10 點會由心理師致電給你。'
    });
    const row = (await admin.ok('GET', '/api/inquiries?status=sent')).rows.find(x => x.id === inqId);
    eq(row.status, 'sent', '送出後狀態');
    must(row.draft && row.final_reply !== row.draft, '原擬稿應保留且與送出版本可對照');
    must(row.approved_by && row.sent_at, '應記錄複審人與送出時間');
    const msgs = await admin.ok('GET', `/api/messages?client_id=${clientId}`);
    must(msgs.some(m => m.content.includes('明天上午 10 點')), '回覆應同步進個案訊息串');
    const del = await admin.call('DELETE', `/api/inquiries/${inqId}`);
    eq(del.status, 400, '已回覆的訊息不應可刪除');
    return '五段流程完成，全程留痕';
  });

  group('多分所（法律實體）與帳務歸屬');
  await step('各據點各自的主體、收據前綴與收款連結', async () => {
    const inv = await admin.ok('POST', '/api/invoices', {
      client_id: clientId, date: today, item: '驗收收款連結', amount: 1500
    });
    const noSite = await admin.call('POST', '/api/payment-links', { invoice_id: inv.id });
    eq(noSite.status, 400, '未歸屬據點時應擋下（無法判斷收款主體）');
    await admin.ok('PUT', `/api/invoices/${inv.id}`, { site_id: siteId });
    const link = await admin.ok('POST', '/api/payment-links', { invoice_id: inv.id });
    eq(link.site.legal_entity, '驗收心理諮商所', '連結應帶該主體');
    const pub = await admin.ok('GET', `/api/public/pay/${link.token}`);
    eq(pub.amount, 1500, '公開頁金額');
    must(!JSON.stringify(pub).includes('驗收個案'), '公開頁不應洩漏個案姓名');
    return `主體 ${link.site.legal_entity}，公開頁不含個資`;
  });

  group('搜尋、篩選與分頁（資料量大時仍可用）');
  await step('主要清單都支援搜尋與分頁', async () => {
    const checks = [
      ['個案', '/api/clients?q=驗收個案', d => d.length === 1],
      ['收費單', '/api/invoices?status=&q=驗收', d => d.rows.length >= 1 && d.pages >= 1],
      ['稽核軌跡', '/api/audit-logs?q=列印&size=5', d => d.rows.length <= 5 && d.total >= 1],
      ['改期／訊息', '/api/inquiries?status=all&q=撐不下去', d => d.rows.length >= 1],
      ['專案', '/api/projects?q=不存在zzz', d => d.rows.length === 0],
      ['成本', '/api/cost-entries?q=租金', d => d.rows.length >= 1],
      ['列印批次', '/api/print-batches?purpose=督考', d => d.rows.every(r => r.purpose === '督考')]
    ];
    for (const [label, url, test] of checks) {
      const d = await admin.ok('GET', url);
      must(test(d), `${label} 的搜尋／分頁結果不如預期`);
    }
    return `${checks.length} 個清單通過`;
  });

  // ── 結果 ────────────────────────────────
  const failed = results.filter(r => !r.ok);
  console.log('\n' + '─'.repeat(58));
  if (failed.length) {
    console.log(`✗ 驗收 ${results.length} 項，未通過 ${failed.length} 項：`);
    for (const f of failed) console.log(`   · ${f.group} / ${f.name}：${f.error}`);
  } else {
    console.log(`✓ 驗收全部通過（${results.length} 項）`);
  }
  server.kill();
  if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})().catch(e => {
  console.error('驗收中斷：', e);
  if (server) server.kill();
  process.exit(1);
});
