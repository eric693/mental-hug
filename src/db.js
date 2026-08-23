const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// 資料目錄可由環境變數覆寫，冒煙測試（scripts/smoke.js）藉此跑在拋棄式資料庫上，
// 不會動到正式資料；未設定時維持專案內的 data/。
const DATA_DIR = process.env.MINDCARE_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
// 附件實體檔目錄（同樣可覆寫，冒煙測試才不會把測試檔案寫進正式的 uploads/）
const UPLOAD_DIR = process.env.MINDCARE_UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'mindcare.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));

// 既有資料庫的欄位遷移（日後加欄位補在此，新裝走 schema.sql）
function ensureColumns(table, cols) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  for (const [name, ddl] of Object.entries(cols)) {
    if (!existing.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}
ensureColumns('clients', {
  partner_id: 'INTEGER REFERENCES partners(id)',     // 合作單位（學校／EAP／社會局委託案）
  id_no: "TEXT NOT NULL DEFAULT ''"                  // 身分證統一編號／居留證號（通報與補助核銷用）
});
ensureColumns('clients', {
  // LINE 官方帳號綁定：個案在官方帳號傳訊時據此對應到個案
  line_user_id: "TEXT NOT NULL DEFAULT ''",
  // 主要就診據點：各館為不同法律主體，同意書與收據抬頭依此決定
  site_id: 'INTEGER REFERENCES sites(id)'
});
ensureColumns('users', {
  // 該心理師的 LINE 群組：個案的請假／改期訊息轉達到這裡等回覆
  line_group_id: "TEXT NOT NULL DEFAULT ''",
  // 心理師的固定視訊會議室連結：排視訊晤談時自動帶入，不必每次貼
  meeting_room_url: "TEXT NOT NULL DEFAULT ''",
  // 行事曆訂閱（.ics）用的隨機字串：手機日曆以網址訂閱，故不走 Cookie 驗證。
  // 可隨時重設，舊網址即失效；輸出內容不含個案姓名。
  calendar_token: "TEXT NOT NULL DEFAULT ''",
  // 實習心理師：晤談紀錄需經指定督導覆核後才定稿（心理師法第 2 條實習制度）
  is_intern: 'INTEGER NOT NULL DEFAULT 0',
  supervisor_id: 'INTEGER REFERENCES users(id)'
});
ensureColumns('session_notes', {
  // 覆核狀態：none 不需覆核（正式心理師）／pending 待督導覆核／approved 已覆核／returned 退回補正
  review_status: "TEXT NOT NULL DEFAULT 'none'",
  reviewer_id: 'INTEGER REFERENCES users(id)',
  reviewed_at: "TEXT NOT NULL DEFAULT ''",
  review_comment: "TEXT NOT NULL DEFAULT ''",
  submitted_at: "TEXT NOT NULL DEFAULT ''"
});
ensureColumns('reschedule_requests', {
  // 轉達前的人工審核：行政人員可修訂要送進心理師群組的文字，並記錄是誰放行的
  relay_text: "TEXT NOT NULL DEFAULT ''",
  relay_approved_by: 'INTEGER REFERENCES users(id)',
  relay_approved_at: "TEXT NOT NULL DEFAULT ''"
});
ensureColumns('consent_templates', {
  // 停用的範本不再要求新個案簽署，但已簽署的紀錄仍保留
  active: 'INTEGER NOT NULL DEFAULT 1',
  // 據點別同意書：各館為不同法律主體，同意書抬頭與收費條款不同。
  // 留空表示全所適用；填了就只有該據點的個案需要簽。
  site_id: 'INTEGER REFERENCES sites(id)'
});
ensureColumns('intakes', {
  id_no: "TEXT NOT NULL DEFAULT ''",
  // 候補遞補：最近一次通知釋出時段的時間與內容，避免重複打擾同一位
  waitlist_notified_at: "TEXT NOT NULL DEFAULT ''",
  waitlist_notified_slot: "TEXT NOT NULL DEFAULT ''"
});
ensureColumns('appointments', {
  reminded_at: "TEXT NOT NULL DEFAULT ''",           // 晤談提醒已通知時間
  meeting_url: "TEXT NOT NULL DEFAULT ''",           // 視訊晤談連結（mode=online 時使用）
  // 是否已因此次預約產生費用（開立收費單或扣方案次數）。
  // 狀態在「完成／未到」與其他狀態間來回切換時，用它避免重複計費與漏退次數。
  charged: 'INTEGER NOT NULL DEFAULT 0',
  // 改期軌跡：保留原時間並累計改期次數，櫃檯看得出這筆被移動過幾次
  rescheduled_from: "TEXT NOT NULL DEFAULT ''",
  reschedule_count: 'INTEGER NOT NULL DEFAULT 0',
  // 個案端逾期取消只能提出申請，由櫃檯決定是否計費；此欄記申請時間與事由
  cancel_requested_at: "TEXT NOT NULL DEFAULT ''",
  cancel_request_reason: "TEXT NOT NULL DEFAULT ''"
});
ensureColumns('invoices', {
  partner_id: 'INTEGER REFERENCES partners(id)',     // 由合作單位付款時填
  settlement_id: 'INTEGER REFERENCES settlements(id)',
  group_session_id: 'INTEGER REFERENCES group_sessions(id)',  // 團體場次收費：用於避免重複點名時重複開單
  // 電子發票（營利事業登記者適用；執行業務所得者僅開收據，留空即可）
  buyer_tax_id: "TEXT NOT NULL DEFAULT ''",          // 買受人統一編號（開立三聯式時填）
  buyer_title: "TEXT NOT NULL DEFAULT ''",           // 發票抬頭
  invoice_no: "TEXT NOT NULL DEFAULT ''",            // 發票號碼（如 AB-12345678）
  invoice_date: "TEXT NOT NULL DEFAULT ''",
  carrier: "TEXT NOT NULL DEFAULT ''",               // 載具號碼（手機條碼／自然人憑證）
  love_code: "TEXT NOT NULL DEFAULT ''",             // 捐贈碼
  // 政府補助方案（如衛福部年輕族群心理健康支持方案）：補助額與自付差額分開記
  subsidy_program: "TEXT NOT NULL DEFAULT ''",
  subsidy_no: "TEXT NOT NULL DEFAULT ''",            // 方案序號／個案代碼
  subsidy_amount: 'INTEGER NOT NULL DEFAULT 0',      // 由方案支付金額
  self_pay: 'INTEGER NOT NULL DEFAULT 0'             // 個案自付差額
});
ensureColumns('risk_events', {
  // 責任通報時限：建案時依類型帶入應完成通報時間，逾時未通報會在清單警示
  report_due_at: "TEXT NOT NULL DEFAULT ''"
});

// 個案附件：轉介單、診斷證明、同意書掃描、衡鑑報告等。
// 檔案存在 uploads/ 下並以隨機檔名保存，原始檔名另存資料庫，
// 下載一律經 API 檢查權限，不開放靜態目錄直接讀取。
db.exec(`CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT '其他',           -- 轉介單／診斷證明／同意書掃描／衡鑑報告／其他
  filename TEXT NOT NULL,                      -- 原始檔名（顯示與下載用）
  stored_name TEXT NOT NULL,                   -- 實際落地檔名（隨機，避免路徑穿越與撞名）
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  visible_to_client INTEGER NOT NULL DEFAULT 0, -- 是否開放個案端下載
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_att_client ON attachments(client_id, created_at);`);

// 心理師報酬與扣繳（外聘心理師／督導多為執行業務所得）
db.exec(`CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                         -- YYYY-MM
  item TEXT NOT NULL DEFAULT '',               -- 晤談鐘點／督導費／團體帶領
  sessions INTEGER NOT NULL DEFAULT 0,
  gross INTEGER NOT NULL DEFAULT 0,            -- 給付總額
  income_type TEXT NOT NULL DEFAULT '9B',      -- 9A 執行業務所得 / 9B 稿費講演 / 50 薪資所得
  withholding INTEGER NOT NULL DEFAULT 0,      -- 代扣所得稅
  nhi_supplement INTEGER NOT NULL DEFAULT 0,   -- 二代健保補充保費
  net INTEGER NOT NULL DEFAULT 0,              -- 實付金額
  status TEXT NOT NULL DEFAULT 'pending',      -- pending 待付 / paid 已付
  paid_at TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_payout_user ON payouts(user_id, month);

-- 對外提醒發送紀錄（簡訊／LINE 走 webhook；未設定時記為待人工發送）
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'reminder',       -- reminder 晤談提醒 / custom
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'manual',      -- webhook / manual
  target TEXT NOT NULL DEFAULT '',             -- 手機號或 LINE ID
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',      -- sent 已送出 / failed 失敗 / manual 人工發送
  error TEXT NOT NULL DEFAULT '',
  sent_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at);`);

// 心理衡鑑報告書（WAIS、MMPI、魏氏、投射測驗等）：屬晤談內容層級的高敏感資料，
// 讀寫比照晤談紀錄的保密邊界（僅主責心理師、督導、管理者），定稿後不可修改。
db.exec(`CREATE TABLE IF NOT EXISTS assessment_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  counselor_id INTEGER NOT NULL REFERENCES users(id),
  test_date TEXT NOT NULL,                     -- 施測日期
  report_date TEXT NOT NULL DEFAULT '',        -- 報告完成日
  purpose TEXT NOT NULL DEFAULT '',            -- 轉介問題／評估目的
  referral_source TEXT NOT NULL DEFAULT '',    -- 轉介單位／人
  instruments TEXT NOT NULL DEFAULT '',        -- 施測工具（每行一項）
  background TEXT NOT NULL DEFAULT '',         -- 背景資料與病史
  observation TEXT NOT NULL DEFAULT '',        -- 行為觀察與測驗態度
  results TEXT NOT NULL DEFAULT '',            -- 測驗結果敘述
  scores TEXT NOT NULL DEFAULT '[]',           -- 分數表 JSON：[{instrument,index,score,norm,interpretation}]
  impression TEXT NOT NULL DEFAULT '',         -- 綜合摘要與臨床印象
  recommendation TEXT NOT NULL DEFAULT '',     -- 建議
  validity TEXT NOT NULL DEFAULT 'valid',      -- valid 結果可信 / caution 解釋需保留 / invalid 不宜採用
  locked INTEGER NOT NULL DEFAULT 0,
  signed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_report_client ON assessment_reports(client_id, test_date);`);

// 個案端自填初談問卷：派案／建檔前先由個案在手機填寫，櫃檯建檔時一鍵帶入，
// 內容屬行政與主訴層級（非晤談紀錄），來電登記人員即可檢視。
db.exec(`CREATE TABLE IF NOT EXISTS intake_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intake_id INTEGER REFERENCES intakes(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,                  -- 免登入填寫連結用的隨機碼
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  birth_date TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  occupation TEXT NOT NULL DEFAULT '',
  marital TEXT NOT NULL DEFAULT '',
  emergency_name TEXT NOT NULL DEFAULT '',
  emergency_relationship TEXT NOT NULL DEFAULT '',
  emergency_phone TEXT NOT NULL DEFAULT '',
  guardian_name TEXT NOT NULL DEFAULT '',
  guardian_relationship TEXT NOT NULL DEFAULT '',
  guardian_phone TEXT NOT NULL DEFAULT '',
  main_issue TEXT NOT NULL DEFAULT '',         -- 主訴
  history TEXT NOT NULL DEFAULT '',            -- 過往就醫／諮商史、用藥
  expectation TEXT NOT NULL DEFAULT '',        -- 期待
  preferred_time TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  bsrs_answers TEXT NOT NULL DEFAULT '',       -- BSRS-5 作答（JSON，選填）
  bsrs_total INTEGER NOT NULL DEFAULT -1,      -- -1 表示未填
  bsrs_alert INTEGER NOT NULL DEFAULT 0,       -- 附加題（自殺意念）命中
  status TEXT NOT NULL DEFAULT 'sent',         -- sent 已發送 / done 已填寫 / used 已建檔帶入
  expires_at TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_intakeform_status ON intake_forms(status, created_at);`);
// 初談表欄位（對齊擁抱心理紙本初談表）
ensureColumns('intake_forms', {
  id_no: "TEXT NOT NULL DEFAULT ''",
  prior_counseling: "TEXT NOT NULL DEFAULT ''",   // 接受諮商經驗：無／有（約多久前、持續多久）
  prior_medical: "TEXT NOT NULL DEFAULT ''",      // 就醫經驗：無／曾經就診／就醫中
  service_mode: "TEXT NOT NULL DEFAULT ''",       // 諮商模式：個別／家庭伴侶／團體
  topics: "TEXT NOT NULL DEFAULT ''",             // 主訴議題（可複選，逗號分隔）
  referral_note: "TEXT NOT NULL DEFAULT ''"       // 轉介資訊
});


// ---- 紀錄類型與非個案服務（M8-01～04）----
// 外派演講、企業講座這類「沒有個案」的服務，過去被迫掛在虛擬個案底下，
// 汙染個案統計。改成獨立資料表：表單裡根本沒有個案欄位，報表也自然分流。
db.exec(`CREATE TABLE IF NOT EXISTS nonclient_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type TEXT NOT NULL DEFAULT 'outreach_talk',  -- outreach_talk 外派演講 / lecture 講座課程 / other 其他非個案服務
  date TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  org_name TEXT NOT NULL DEFAULT '',           -- 對象單位
  topic TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  site_id INTEGER REFERENCES sites(id),
  user_id INTEGER REFERENCES users(id),        -- 執行人員
  attendees INTEGER NOT NULL DEFAULT 0,
  fee INTEGER NOT NULL DEFAULT 0,
  fee_method TEXT NOT NULL DEFAULT '',         -- 收費方式：單位付款／個人付款／無償
  note TEXT NOT NULL DEFAULT '',
  migrated_from_note_id INTEGER,               -- 由歷史虛擬個案紀錄轉入時保留來源
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_nonclient_date ON nonclient_services(date);

-- 列印批次紀錄（M8-09）：批次列印等於特種個資的大量匯出，必須留下完整軌跡且不可修改
CREATE TABLE IF NOT EXISTS print_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT NOT NULL UNIQUE,               -- 例 PB-20260819-0007
  user_id INTEGER REFERENCES users(id),
  user_name TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL,                       -- 督考／司法調閱／個案申請／內部歸檔／其他（必填）
  purpose_note TEXT NOT NULL DEFAULT '',
  filters TEXT NOT NULL DEFAULT '',            -- 當時的篩選條件（JSON）
  note_ids TEXT NOT NULL DEFAULT '',           -- 實際輸出的紀錄 id（JSON 陣列）
  count INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,          -- 因權限被略過的筆數
  mode TEXT NOT NULL DEFAULT 'merged',         -- merged 合併一份 / split 分檔
  status TEXT NOT NULL DEFAULT 'done',         -- done 已產生 / queued 背景處理中
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_print_batch_time ON print_batches(created_at);`);
ensureColumns('session_notes', {
  // 紀錄類型（M8-01）：個案晤談／團體／心理衡鑑；非個案服務另存 nonclient_services
  record_type: "TEXT NOT NULL DEFAULT 'individual'"
});

// ---- 據點（分館）----
// 多據點諮商所：諮商室屬於某個據點，心理師可跨據點看診（多對多），
// 預約的據點由諮商室決定，視訊晤談則沿用心理師的主要據點。
db.exec(`CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT '',          -- 交通方式（印在給個案的通知與對外預約頁）
  note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS user_sites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, site_id)
);`);
ensureColumns('rooms', { site_id: 'INTEGER REFERENCES sites(id)' });
ensureColumns('appointments', { site_id: 'INTEGER REFERENCES sites(id)' });

// 前台可編輯文字（系統設定頁維護；清空即隱藏該區塊）
const UI_TEXT_DEFAULTS = {
  ui_staff_login_title: '擁抱心理',
  ui_staff_login_sub: '擁抱心理，擁抱愛與自己',
  ui_demo_staff: '展示用測試帳號\n管理者：admin / mindcare123\n諮商師：lin / 123456',
  ui_portal_title: '擁抱心理 個案專區',
  ui_portal_login_sub: '預約、量表填寫與費用查詢',
  ui_portal_login_hint: '首次登入密碼為手機末 6 碼；忘記密碼請來電諮商所。',
  ui_demo_portal: '展示用測試帳號\n個案：0912345678 / 345678',
  ui_portal_note: '本專區僅提供預約與行政事項；晤談內容請於晤談時與心理師討論。',
  ui_crisis_note: '如遇立即危機請撥打 1925（安心專線）或 119；本系統非緊急通報管道。'
};
const UI_TEXT_KEYS = Object.keys(UI_TEXT_DEFAULTS);

{
  const SETTING_DEFAULTS = {
    ...UI_TEXT_DEFAULTS,
    center_name: '擁抱心理諮商所',
    center_phone: '',
    center_address: '',
    // 機構登記資料：收據／報表抬頭與核銷文件需載明
    center_license_no: '',              // 諮商所開業執照字號
    center_director: '',                // 負責心理師
    center_tax_id: '',                  // 機構統一編號（營利事業登記者）
    center_email: '',
    session_minutes: '50',
    default_fee: '2000',
    intake_fee: '2500',
    couple_fee: '3200',                 // 伴侶／家庭諮商（80 分鐘）
    late_cancel_fee: '600',             // 24 小時內臨時取消，下次預約加收
    extend_unit_minutes: '25',          // 延長晤談以半節為單位
    cancel_hours: '24',                 // 免收費取消門檻（小時）
    no_show_fee_rate: '0.5',            // 未到收費比例
    case_code_prefix: 'C',
    receipt_prefix: 'MC',
    counseling_types: '初談,個別諮商,伴侶諮商,家族諮商,團體諮商,心理衡鑑',
    approach_options: 'CBT 認知行為,個人中心,心理動力,家族系統,DBT 辯證行為,ACT 接納承諾,敘事治療,遊戲治療,EMDR,其他',
    source_options: '自行求助,親友介紹,學校輔導室,醫療院所轉介,社會局／家防中心,企業EAP,法院裁定,其他',
    close_reasons: '目標達成,個案自行結束,轉介他處,失聯,搬遷,經濟因素,其他',
    risk_types: '自殺意念,自傷行為,傷人威脅,兒少保護,家庭暴力,性侵害,精神症狀惡化,其他',
    report_channels: '113保護專線,關懷e起來,自殺防治通報系統,警政單位,衛生局,醫療院所,學校,其他',
    pay_methods: '現金,轉帳,信用卡,行動支付,其他',
    payer_types: '自費,企業EAP,學校方案,社會局補助,心理健康支持方案,保險給付,其他',
    payer_type_default: '自費',
    // 責任通報時限：下列類型建案時自動帶出應完成通報時間，逾時未通報在危機清單警示
    mandatory_report_types: '兒少保護,家庭暴力,性侵害,自殺意念,自傷行為',
    report_deadline_hours: '24',
    // 政府補助方案：開立收費單時可選，補助額與自付差額分開記帳以利核銷
    subsidy_programs: '年輕族群心理健康支持方案,長者心理健康支持方案,女性心理健康支持方案',
    // 成年年齡（民法 112 年起為 18 歲）：依生日自動判定是否需法定代理人同意
    adult_age: '18',
    // 執行業務所得扣繳：稅率與起扣點、二代健保補充保費費率與起扣門檻
    withholding_rate: '0.1',
    withholding_min: '20010',           // 單次給付達此金額才扣繳所得稅
    nhi_supplement_rate: '0.0211',
    nhi_supplement_min: '20000',        // 單次給付達此金額才扣補充保費
    // 對外提醒發送：填入 webhook 後由系統送出，留空則僅產生訊息供人工發送
    notify_webhook_url: '',
    notify_webhook_token: '',
    supervision_required_hours: '20',   // 年度督導時數目標
    audit_retention_days: '1825',       // 心理紀錄相關稽核軌跡保留 5 年
    note_lock_days: '7',                // 晤談紀錄應於幾日內完成簽核
    portal_booking_enabled: '1',        // 個案端可否自行送出預約申請
    portal_book_lead_days: '1',         // 個案端最早可約幾天後
    portal_book_max_days: '60',
    // 紀錄保存：心理師法施行細則規定紀錄應保存，所內政策以此年限提示可歸檔／銷毀
    record_retention_years: '7',
    // 繼續教育：執業執照每 6 年更新一次，期間應完成之積分與特定類別下限
    ce_cycle_years: '6',
    ce_required_credits: '120',
    ce_required_special: '12',          // 專業品質＋專業倫理＋專業相關法規合計下限
    ce_required_ethics: '2',            // 其中「專業倫理」類別之個別下限
    ce_categories: '專業課程,專業品質,專業倫理,專業相關法規',
    license_alert_days: '180',          // 執照更新提前提醒天數
    // 晤談提醒訊息範本（可貼到 LINE／簡訊；{} 內為代入欄位）
    reminder_template: '{client} 您好，提醒您與 {counselor} 心理師的晤談時間為 {date}（{weekday}）{time}，地點 {center}。如需改期請提前 {cancel_hours} 小時來電 {phone}。',
    // 收費逾期：未收款超過此天數列入催繳清單；催繳訊息比照晤談提醒，可貼可自動發送
    overdue_days: '14',
    dunning_template: '{client} 您好，您於 {date} 的「{item}」費用 {amount} 元尚未繳納（已逾期 {days} 天），'
      + '請於下次晤談時或來電 {phone} 完成繳費。如已繳納請忽略本訊息。—— {center}',
    // 排班表：格子的起訖時間與每格分鐘數（所別作息不同，一律可調）
    shift_start: '08:00',
    shift_end: '21:00',
    shift_step: '30',
    // 排班快填按鈕：每行一組「名稱|星期(0=日,逗號分隔)|時段(逗號分隔)」
    shift_quick_fills: '平日 09-12、14-17|1,2,3,4,5|09:00-12:00,14:00-17:00\n平日 18-21|1,2,3,4,5|18:00-21:00\n週六上午|6|09:00-12:00',
    // 結案後追蹤：結案時自動建立的追蹤點（天數，逗號分隔；留空表示不自動建立）
    follow_up_days: '30,90',
    follow_up_channels: '電話,簡訊,LINE,面談,信件',
    referral_targets: '精神科／身心科門診,醫院急診,社福中心／家防中心,學校輔導室,其他諮商所／心理治療所,自殺防治中心,其他',
    // 安全計畫：預設檢視週期，以及印在計畫上的危機資源（可依縣市調整）
    safety_plan_review_days: '90',
    safety_plan_resources: '安心專線 1925（24 小時免費）\n生命線 1995\n張老師 1980\n緊急救護 119／報案 110',
    // 實習心理師紀錄覆核：逾此天數未覆核於待覆核清單以紅字標示
    note_review_days: '7',
    // 候補遞補：時段釋出時通知候補名單的訊息範本
    waitlist_template: '{name} 您好，{center} 有時段釋出：{date}（{weekday}）{time}，{counselor}心理師。'
      + '如需預約請於今日內來電 {phone}，逾時將通知下一位候補。',
    waitlist_match_days: '14',          // 只媒合登記後幾天內仍在候補的來電
    // 個案端是否可自行改期；逾取消期限者一律只能提出申請由櫃檯處理
    portal_reschedule_enabled: '1',
    // 個案端自填初談問卷連結的有效天數
    intake_form_days: '14',
    partner_types: '學校,企業EAP,政府社政,司法轉介,醫療院所,其他',
    // ---- LINE 傳話機器人 ----
    // 官方帳號 Messaging API 憑證；未填則 webhook 一律拒收、系統不對外送出任何訊息
    line_channel_secret: '',
    line_channel_token: '',
    // 找不到心理師專屬群組時的預設群組（留空則只留在系統待簽核清單，不外送）
    line_default_group_id: '',
    // 個案端來的訊息是否要先經行政人員審核才轉給心理師群組（雙向人工審核）
    line_relay_requires_approval: '1',
    // 個案在官方帳號輸入哪些字視為請假／改期（逗號分隔）
    line_keywords: '改期,請假,取消,調整時間,換時間,不能來,無法出席',
    // 轉達給心理師群組的訊息範本
    line_relay_template: '【改期／請假申請 #{req}】\n個案：{client}（{code}）\n原訂：{date}（{weekday}）{time}\n個案訊息：{text}\n\n請直接在群組回覆可否改期與建議時段，行政人員會據以簽核。',
    // 個案未綁定時的引導語
    line_bind_hint: '您好，這裡是{center}。為了確認您的身分，請先傳送「綁定 您的手機號碼」（例如：綁定 0912345678），之後即可於此傳達請假或改期需求。',
    // 收到個案訊息後的自動回覆
    line_ack_client: '已收到您的訊息，我們會轉達給您的心理師，確認後再回覆您。若為緊急事項請直接來電 {phone}。',
    // 簽核完成後回覆個案與群組的範本
    line_done_client: '{client} 您好，您的晤談已改期為 {new_date}（{new_weekday}）{new_time}，心理師 {counselor}。如有問題請來電 {phone}。—— {center}',
    line_done_group: '【已簽核 #{req}】{client}（{code}）原訂 {date} {time} 已改期為 {new_date}（{new_weekday}）{new_time}。',
    line_reject_client: '{client} 您好，關於您提出的改期需求，請來電 {phone} 與我們確認後續安排。—— {center}',
    // 未啟用模組（逗號分隔的模組代碼）：側欄不出現、API 一律 403，權限勾選保留不動
    disabled_modules: 'partners,risk,supervision,groups',
    // 細項開關：繼續教育積分區塊（關閉後「請假與繼續教育」只留請假）
    feature_ce: '0',
    time_off_reasons: '特休,病假,事假,研習,督導,公假,其他',
    group_topics: '情緒調適,人際關係,壓力管理,親職教養,悲傷輔導,正念練習',
    // 批次列印稽核（M8-10）：單日超量門檻與所內上班時段，用於異常示警
    print_batch_daily_limit: '100',
    office_hours: '08:00-21:00',
    // AI 助理：Anthropic API 金鑰（留空則改讀環境變數 ANTHROPIC_API_KEY；兩者都沒有就停用）
    ai_api_key: '',
    // 客戶分級門檻：各所標準不同，一律做成設定
    tier_vip_sessions: '12',            // 累計完成晤談達此數視為長期個案
    tier_regular_sessions: '4',
    tier_good_attendance: '90',         // 出席率（%）達此為良好
    tier_poor_attendance: '70',         // 低於此列入需關注
    tier_dormant_days: '60',            // 幾天未晤談且無後續預約視為沉睡
    // 對外預約頁（免登入）：關閉後 /booking.html 只顯示請來電
    public_booking_enabled: '1',
    public_booking_notice: '本所為全預約制。送出後我們會在服務時間內與您電話確認時段與費用，'
      + '確認完成才算預約成功。若為未滿 18 歲之未成年人，需由法定代理人陪同並簽署同意書。',
    // 諮商主題：來電登記、對外預約頁與心理師專長共用的清單
    topic_options: '情緒困擾（憂鬱、焦慮）,壓力與職場適應,婚姻與伴侶關係,性治療與親密關係,家族與親子關係,'
      + '親職教養,人際關係,自我探索與生涯,創傷與失落,成癮議題,兒童與青少年,性別與多元性別議題,'
      + '催眠治療,睡眠困擾,其他'
  };
  const has = db.prepare('SELECT 1 FROM settings WHERE key = ?');
  const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) if (!has.get(k)) ins.run(k, v);
}

// 同意書範本（後台可改內容並遞增版本；已簽署者保存全文快照，不受改版影響）
// 注意：以下為參考範本，正式使用前請由諮商所依《心理師法》與所內規範確認。
{
  const CONSENT_DEFAULTS = [
    {
      key: 'informed', title: '心理諮商知情同意書', sort: 1, required: 1, allow_decline: 0, minor_only: 0,
      body: `一、服務內容：本所提供之心理諮商由領有證照之心理師提供，每次晤談時間約 50 分鐘，次數依評估與雙方討論後決定。

二、保密原則：心理師依《心理師法》第 17 條負保密義務，晤談內容非經您同意不對外揭露。惟有下列情形，心理師應依法揭露或通報：
　（一）您有危及自己或他人生命、身體、自由或財產之虞。
　（二）涉及兒童及少年、老人、身心障礙者受虐或家庭暴力、性侵害等應通報情事。
　（三）法院命令或其他法律規定應提供之情形。

三、紀錄保存：心理師依規定製作晤談紀錄並妥善保存，您得依個人資料保護法申請查閱或複製與您有關之紀錄；涉及第三人或可能造成傷害之部分，本所得部分限制提供。

四、您的權利：您有權隨時詢問處遇方式與進度、要求更換心理師、或終止諮商關係，並不因此影響您接受其他服務之權益。

五、費用與取消：收費標準與退費、改期規則依本所公告辦理；未於規定時間前告知之取消或未到，本所得依公告收取部分費用。

本人已充分閱讀並理解上述內容，同意接受本所提供之心理諮商服務。`
    },
    {
      key: 'guardian', title: '未成年人接受心理諮商法定代理人同意書', sort: 2, required: 1, allow_decline: 0, minor_only: 1,
      body: `本人為受服務者之法定代理人，同意其接受本所之心理諮商服務，並瞭解下列事項：

一、為建立信任關係，心理師與未成年人之晤談內容原則上予以保密；惟涉及安全風險、依法應通報事項，或經評估有告知必要者，心理師將以適當方式告知法定代理人。
二、法定代理人得與心理師約定親職諮詢時段，瞭解整體處遇方向與可配合之家庭作法。
三、本人同意配合必要之聯繫，並於接獲心理師安全通知時，採取保護未成年人之必要措施。

本人已充分閱讀並理解上述內容，同意上開未成年人接受本所心理諮商服務。`
    },
    {
      key: 'privacy', title: '個人資料蒐集、處理及利用告知同意書', sort: 3, required: 1, allow_decline: 0, minor_only: 0,
      body: `依個人資料保護法第 8 條規定，向您告知下列事項：

一、蒐集機構：本心理諮商所。
二、蒐集目的：辦理心理諮商與心理衡鑑服務、預約與費用管理、依法令應為之通報與紀錄保存、健康與安全之緊急聯繫。
三、個人資料類別：姓名、出生年月日、聯絡方式、地址、緊急聯絡人、心理及健康狀況、晤談與衡鑑紀錄等為提供服務所必要之資料。
四、利用期間、地區、對象及方式：於服務關係存續期間及法令規定之保存期限內，於中華民國境內，由本所及依法令應提供之機關，以電子或紙本方式於蒐集目的必要範圍內利用。
五、當事人權利：您得請求查詢、閱覽、製給複製本、補充或更正、停止蒐集處理利用或刪除您的個人資料。
六、不提供之影響：若不提供必要資料，本所將無法完成報到與服務安排。`
    },
    {
      key: 'recording', title: '晤談錄音／錄影同意書', sort: 4, required: 0, allow_decline: 1, minor_only: 0,
      body: `為提升服務品質，心理師於接受督導或個案研討時，可能需要錄製晤談之錄音或錄影，其使用方式如下：

一、僅供心理師接受專業督導與所內個案研討使用，不作其他用途，不公開播放。
二、檔案以加密方式保存，於督導目的完成後刪除，保存期間最長不超過一年。
3、參與研討之人員均負相同之保密義務。
四、您得隨時撤回本項同意，撤回後不再錄製，已錄製之檔案將立即刪除，且不影響您接受服務之權益。

本人已瞭解上述內容，並就晤談錄音／錄影乙事表示同意與否如下。`
    },
    {
      key: 'contact', title: '緊急聯絡與危機處理同意書', sort: 5, required: 1, allow_decline: 0, minor_only: 0,
      body: `一、當心理師評估您有危及自身或他人生命安全之虞時，得聯繫您所指定之緊急聯絡人、協助送醫，或通知警消及相關主管機關。
二、前項聯繫以維護生命安全為限，心理師僅告知必要之資訊，不揭露其他晤談內容。
三、您應提供正確之緊急聯絡人資訊，如有異動請即時通知本所更新。
四、非晤談時段之緊急狀況，請撥打 1925 安心專線或 119；本所留言與線上訊息非即時回覆管道。

本人已瞭解並同意上述緊急聯絡與危機處理方式。`
    }
  ];
  const hasT = db.prepare('SELECT 1 FROM consent_templates WHERE key = ?');
  const insT = db.prepare(`INSERT INTO consent_templates (key, title, body, version, required, allow_decline, minor_only, sort)
                           VALUES (?, ?, ?, 1, ?, ?, ?, ?)`);
  for (const t of CONSENT_DEFAULTS) {
    if (!hasT.get(t.key)) insT.run(t.key, t.title, t.body, t.required, t.allow_decline, t.minor_only, t.sort);
  }
}

// 系統簽章密鑰（首次啟動自動產生）
const secretFile = path.join(DATA_DIR, '.secret');
if (!fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, require('crypto').randomBytes(48).toString('hex'), { mode: 0o600 });
}
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function listSetting(key, fallback = '') {
  return getSetting(key, fallback).split(',').map(s => s.trim()).filter(Boolean);
}

// ---- 清單查詢共用：搜尋、篩選、分頁 ----
// 資料量一大，各頁自己 LIMIT 200 就會開始漏資料，而且每頁的寫法都不一樣。
// 統一成這個函式：回傳 { rows, total, page, size, pages }，前端用同一個分頁元件。
//
//   listQuery({ select, from, where, args, search, searchFields, order, page, size })
//
// search 會對 searchFields 逐欄做 LIKE，任何一欄命中即算命中（OR）。
function listQuery({ select = '*', from, where = [], args = [], search = '',
  searchFields = [], order = 'id DESC', page = 1, size = 50, maxSize = 500 }) {
  const conds = [...where];
  const params = [...args];
  const kw = String(search || '').trim();
  if (kw && searchFields.length) {
    conds.push('(' + searchFields.map(f => `${f} LIKE ?`).join(' OR ') + ')');
    for (const _ of searchFields) params.push(`%${kw}%`);
  }
  const whereSql = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM ${from} ${whereSql}`).get(...params).n;
  const sz = Math.min(Math.max(Number(size) || 50, 1), maxSize);
  const pg = Math.max(Number(page) || 1, 1);
  const rows = db.prepare(`SELECT ${select} FROM ${from} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, sz, (pg - 1) * sz);
  return { rows, total, page: pg, size: sz, pages: Math.max(1, Math.ceil(total / sz)) };
}

// 從 query string 取出分頁與搜尋參數（各路由共用，避免每支各寫一次）
function listParams(q = {}) {
  return {
    search: String(q.q || '').slice(0, 60),
    page: Number(q.page) || 1,
    size: Math.min(Number(q.size) || 50, 500)
  };
}

function audit(actorType, actorId, actorName, action, target = '', detail = '') {
  db.prepare('INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, target, detail) VALUES (?,?,?,?,?,?)')
    .run(actorType, actorId, actorName, action, target, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function nowStamp() { return `${today()} ${nowTime()}`; }

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ageYears(birthDate, onDate) {
  if (!birthDate) return null;
  const b = new Date(birthDate), t = onDate ? new Date(onDate) : new Date();
  if (isNaN(b) || isNaN(t)) return null;
  let y = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) y -= 1;
  return Math.max(0, y);
}

// 產生個案編號：前綴 + 西元年 + 三碼流水（同年內遞增）
function nextClientCode() {
  const prefix = getSetting('case_code_prefix', 'C');
  const year = new Date().getFullYear();
  const like = `${prefix}${year}%`;
  const row = db.prepare('SELECT code FROM clients WHERE code LIKE ? ORDER BY code DESC LIMIT 1').get(like);
  const seq = row ? Number(row.code.slice(-3)) + 1 : 1;
  return `${prefix}${year}${String(seq).padStart(3, '0')}`;
}

// 安全計畫（Safety Plan）：高風險個案的標準照護文件。
// 與危機事件分開——危機事件記錄「已經發生的事」，安全計畫是「事前約定好怎麼做」，
// 需隨狀況更新，因此保留歷次版本：新版本 version+1，舊版本轉為 archived 仍可查閱。
// 保密層級比照晤談紀錄（主責心理師／督導／管理者）。
db.exec(`CREATE TABLE IF NOT EXISTS safety_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  counselor_id INTEGER NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',       -- active 現行版本 / archived 舊版本
  warning_signs TEXT NOT NULL DEFAULT '',      -- 1 警訊（想法、情緒、行為、身體感受）
  coping_strategies TEXT NOT NULL DEFAULT '',  -- 2 自己可以做的因應方式
  distractions TEXT NOT NULL DEFAULT '',       -- 3 可轉移注意力的人事地
  support_contacts TEXT NOT NULL DEFAULT '',   -- 4 可求助的親友（姓名與電話）
  professional_contacts TEXT NOT NULL DEFAULT '', -- 5 專業協助（心理師、醫療院所）
  crisis_resources TEXT NOT NULL DEFAULT '',   -- 6 危機資源（安心專線等）
  environment_safety TEXT NOT NULL DEFAULT '', -- 7 環境安全（降低致命工具可及性）
  reasons_living TEXT NOT NULL DEFAULT '',     -- 8 值得活下去的理由／保護因子
  note TEXT NOT NULL DEFAULT '',
  review_date TEXT NOT NULL DEFAULT '',        -- 預定重新檢視日
  agreed_with_client INTEGER NOT NULL DEFAULT 1, -- 是否與個案共同討論並取得同意
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_safety_client ON safety_plans(client_id, status);`);

// 轉介與結案後追蹤：
// 轉介出去（醫療、社政、其他諮商所）是諮商所天天在做卻最容易沒留痕的一段，
// 出事時「有沒有轉介、對方有沒有接到」是關鍵；結案後的關懷追蹤同理。
// 兩者都掛在個案下，保密層級比照晤談紀錄（僅主責心理師、督導、管理者）。
db.exec(`CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  counselor_id INTEGER REFERENCES users(id),
  date TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'out',       -- out 轉出 / in 轉入（由他處轉介而來）
  target TEXT NOT NULL DEFAULT '',             -- 轉介對象（醫院、社福中心、其他諮商所）
  contact TEXT NOT NULL DEFAULT '',            -- 聯絡方式／窗口
  reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent',         -- sent 已轉出 / accepted 對方已接案 / declined 未接案 / unknown 無回覆
  replied_at TEXT NOT NULL DEFAULT '',
  reply_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_referral_client ON referrals(client_id, date);

CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  counselor_id INTEGER REFERENCES users(id),
  due_date TEXT NOT NULL,                      -- 預定追蹤日
  kind TEXT NOT NULL DEFAULT '結案追蹤',        -- 結案追蹤／轉介追蹤／其他
  status TEXT NOT NULL DEFAULT 'pending',      -- pending 待追蹤 / done 已完成 / skipped 不需追蹤
  channel TEXT NOT NULL DEFAULT '',            -- 電話／簡訊／LINE／面談
  result TEXT NOT NULL DEFAULT '',             -- 追蹤結果摘要
  done_at TEXT NOT NULL DEFAULT '',
  done_by INTEGER REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_followup_due ON follow_ups(status, due_date);`);

// 退費：已收款的收費單若需退還（個案終止方案、重複收費、所方因素取消），
// 不直接改動原收費單金額（收款是已發生的事實），而是另立退費單與原單勾稽，
// 原收費單狀態改為 refunded，報表與對帳皆以「收款 - 退費」計算。
db.exec(`CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT '',             -- 現金／轉帳／原卡退刷
  reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_refund_client ON refunds(client_id, date);`);

module.exports = {
  db, SECRET, DATA_DIR, UPLOAD_DIR, getSetting, setSetting, listSetting, audit,
  today, nowTime, nowStamp, addDays, ageYears, nextClientCode, UI_TEXT_KEYS,
  listQuery, listParams
};
