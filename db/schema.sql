-- MindCare 心理諮商所管理系統
-- 設計原則：晤談紀錄屬高敏感個資，預設僅主責諮商師、督導與管理者可讀（見 src/auth.js canViewNote）

-- ---- 人員與權限 ----
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',          -- admin 管理者 / counselor 諮商師 / supervisor 督導 / staff 行政
  title TEXT NOT NULL DEFAULT '',
  license_type TEXT NOT NULL DEFAULT '',       -- 諮商心理師 / 臨床心理師 / 實習心理師
  license_no TEXT NOT NULL DEFAULT '',         -- 證書字號
  license_expiry TEXT NOT NULL DEFAULT '',     -- 執業執照更新日（每 6 年）
  specialty TEXT NOT NULL DEFAULT '',          -- 專長領域
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---- 個案 ----
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,                   -- 個案編號（對外文件以編號代替姓名）
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT '',             -- male/female/other
  birth_date TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  occupation TEXT NOT NULL DEFAULT '',
  marital TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',             -- 轉介來源：自行求助／學校／醫療院所／社會局／企業EAP
  referrer TEXT NOT NULL DEFAULT '',           -- 轉介單位／人
  counselor_id INTEGER REFERENCES users(id),   -- 主責諮商師
  status TEXT NOT NULL DEFAULT 'intake',       -- intake 初談 / active 進行中 / paused 暫停 / closed 已結案
  risk_level TEXT NOT NULL DEFAULT 'low',      -- low / medium / high
  main_issue TEXT NOT NULL DEFAULT '',         -- 主訴
  history TEXT NOT NULL DEFAULT '',            -- 過往就醫／諮商史、用藥
  diagnosis TEXT NOT NULL DEFAULT '',          -- 醫療診斷（如有）
  -- 未成年／受監護：需法定代理人同意
  is_minor INTEGER NOT NULL DEFAULT 0,
  guardian_name TEXT NOT NULL DEFAULT '',
  guardian_relationship TEXT NOT NULL DEFAULT '',
  guardian_phone TEXT NOT NULL DEFAULT '',
  emergency_name TEXT NOT NULL DEFAULT '',
  emergency_relationship TEXT NOT NULL DEFAULT '',
  emergency_phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  -- 個案端登入（手機號為帳號）
  password_hash TEXT NOT NULL DEFAULT '',
  must_change_password INTEGER NOT NULL DEFAULT 1,
  portal_enabled INTEGER NOT NULL DEFAULT 1,
  intake_date TEXT NOT NULL DEFAULT '',
  close_date TEXT NOT NULL DEFAULT '',
  close_reason TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_clients_counselor ON clients(counselor_id, status);

-- ---- 諮商室與可預約時段 ----
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  counselor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL,                    -- 0=週日 .. 6=週六
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

-- ---- 預約與晤談 ----
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  counselor_id INTEGER NOT NULL REFERENCES users(id),
  room_id INTEGER REFERENCES rooms(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'individual',     -- intake 初談 / individual 個別 / couple 伴侶 / family 家族 / group 團體 / assessment 心理衡鑑
  mode TEXT NOT NULL DEFAULT 'onsite',         -- onsite 到所 / online 視訊
  status TEXT NOT NULL DEFAULT 'booked',       -- booked 已預約 / arrived 已報到 / done 已完成 / cancelled 已取消 / no_show 未到
  fee INTEGER NOT NULL DEFAULT 0,
  package_id INTEGER REFERENCES packages(id),  -- 由方案扣次時填
  source TEXT NOT NULL DEFAULT 'staff',        -- staff 櫃檯 / portal 個案自行預約
  note TEXT NOT NULL DEFAULT '',
  cancel_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(date, counselor_id);
CREATE INDEX IF NOT EXISTS idx_appt_client ON appointments(client_id, date);

-- 晤談紀錄（SOAP）；locked=1 表示已簽核定稿，不可再改
CREATE TABLE IF NOT EXISTS session_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  counselor_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  session_no INTEGER NOT NULL DEFAULT 1,       -- 第幾次晤談
  duration_min INTEGER NOT NULL DEFAULT 50,
  subjective TEXT NOT NULL DEFAULT '',         -- S 個案主觀陳述
  objective TEXT NOT NULL DEFAULT '',          -- O 觀察（情緒、外觀、行為）
  assessment TEXT NOT NULL DEFAULT '',         -- A 概念化與評估
  plan TEXT NOT NULL DEFAULT '',               -- P 下次方向
  intervention TEXT NOT NULL DEFAULT '',       -- 使用技術／取向
  homework TEXT NOT NULL DEFAULT '',           -- 家庭作業
  risk_flag TEXT NOT NULL DEFAULT 'none',      -- none / ideation 意念 / plan 計畫 / attempt 行為 — 非 none 會進危機追蹤提醒
  risk_note TEXT NOT NULL DEFAULT '',
  locked INTEGER NOT NULL DEFAULT 0,
  signed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_note_client ON session_notes(client_id, date);

-- ---- 處遇計畫 ----
CREATE TABLE IF NOT EXISTS treatment_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  counselor_id INTEGER NOT NULL REFERENCES users(id),
  start_date TEXT NOT NULL,
  review_date TEXT NOT NULL DEFAULT '',        -- 預定檢視日
  approach TEXT NOT NULL DEFAULT '',           -- 取向：CBT／個人中心／家族系統／心理動力／DBT／ACT
  planned_sessions INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',            -- 個案概念化
  status TEXT NOT NULL DEFAULT 'active',       -- active / achieved / revised / closed
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS plan_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  indicator TEXT NOT NULL DEFAULT '',          -- 具體評估指標
  progress INTEGER NOT NULL DEFAULT 0,         -- 0-100
  sort INTEGER NOT NULL DEFAULT 0
);

-- ---- 心理測驗／量表 ----
CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  scale TEXT NOT NULL,                         -- PHQ9 / GAD7 / BSRS5 / PSS10 / ISI
  date TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '[]',          -- JSON 陣列
  total INTEGER NOT NULL DEFAULT 0,
  severity TEXT NOT NULL DEFAULT '',
  alert INTEGER NOT NULL DEFAULT 0,            -- 命中危險題（如 PHQ-9 第 9 題）
  filled_by TEXT NOT NULL DEFAULT 'staff',     -- staff / client
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_assess_client ON assessments(client_id, date);

-- 量表指派（個案端待填）
CREATE TABLE IF NOT EXISTS assessment_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  scale TEXT NOT NULL,
  assigned_by INTEGER REFERENCES users(id),
  due_date TEXT NOT NULL DEFAULT '',
  done_id INTEGER REFERENCES assessments(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---- 危機事件與通報 ----
CREATE TABLE IF NOT EXISTS risk_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL,                          -- 自殺意念／自傷行為／傷人威脅／兒少保護／家庭暴力／性侵害／其他
  severity TEXT NOT NULL DEFAULT 'medium',     -- low / medium / high
  description TEXT NOT NULL DEFAULT '',
  actions TEXT NOT NULL DEFAULT '',            -- 已採取處置：安全計畫／通知緊急聯絡人／轉介急診
  reported INTEGER NOT NULL DEFAULT 0,         -- 是否法定通報
  report_channel TEXT NOT NULL DEFAULT '',     -- 113／關懷e起來／警政／衛生局
  report_at TEXT NOT NULL DEFAULT '',
  report_no TEXT NOT NULL DEFAULT '',
  handler_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open',         -- open 追蹤中 / closed 已結案
  follow_up TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---- 督導 ----
CREATE TABLE IF NOT EXISTS supervisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  counselor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supervisor_id INTEGER REFERENCES users(id),
  supervisor_name TEXT NOT NULL DEFAULT '',    -- 外聘督導填此欄
  date TEXT NOT NULL,
  hours REAL NOT NULL DEFAULT 1,
  type TEXT NOT NULL DEFAULT 'individual',     -- individual 個督 / group 團督 / peer 同儕
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  content TEXT NOT NULL DEFAULT '',
  suggestion TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---- 同意書 ----
CREATE TABLE IF NOT EXISTS consent_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  required INTEGER NOT NULL DEFAULT 1,
  allow_decline INTEGER NOT NULL DEFAULT 0,
  minor_only INTEGER NOT NULL DEFAULT 0,       -- 僅未成年個案需簽（法定代理人同意）
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,                          -- 簽署當下全文快照
  version INTEGER NOT NULL DEFAULT 1,
  agreed INTEGER NOT NULL DEFAULT 1,
  signer_name TEXT NOT NULL DEFAULT '',
  signer_role TEXT NOT NULL DEFAULT 'client',  -- client 本人 / guardian 法定代理人
  signature TEXT NOT NULL DEFAULT '',
  signed_ip TEXT NOT NULL DEFAULT '',
  signed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---- 方案與收費 ----
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sessions_total INTEGER NOT NULL DEFAULT 1,
  sessions_used INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL DEFAULT '',
  expire_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',       -- active / used_up / expired / refunded
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  item TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid',       -- unpaid / paid / void
  method TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL DEFAULT '',
  receipt_no TEXT NOT NULL DEFAULT '',
  payer TEXT NOT NULL DEFAULT '',              -- 自費／企業EAP／學校方案／社會局補助
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_inv_client ON invoices(client_id, date);

-- ---- 訊息與公告 ----
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,                        -- client / staff
  user_id INTEGER REFERENCES users(id),
  content TEXT NOT NULL,
  read_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT 'all',        -- all / staff / client
  pinned INTEGER NOT NULL DEFAULT 0,
  publish_date TEXT NOT NULL DEFAULT (date('now','localtime')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---- 系統 ----
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);

-- ================= 第二階段：對齊台灣諮商所實務 =================

-- ---- 來電登記與派案（初談前的漏斗；台灣諮商所多為「來電→初談評估→派案」）----
CREATE TABLE IF NOT EXISTS intakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  birth_date TEXT NOT NULL DEFAULT '',
  is_minor INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  partner_id INTEGER REFERENCES partners(id),
  issue TEXT NOT NULL DEFAULT '',              -- 來電主訴
  preferred_time TEXT NOT NULL DEFAULT '',     -- 希望時段（自由文字：平日晚上、週六上午）
  preferred_counselor_id INTEGER REFERENCES users(id),
  urgency TEXT NOT NULL DEFAULT 'normal',      -- low / normal / high（自傷風險或危機來電標 high）
  status TEXT NOT NULL DEFAULT 'new',          -- new 待處理 / waiting 候補中 / assigned 已派案 / converted 已建檔 / closed 未成案
  assigned_counselor_id INTEGER REFERENCES users(id),
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  taken_by INTEGER REFERENCES users(id),       -- 接聽／登記人
  note TEXT NOT NULL DEFAULT '',
  close_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_intake_status ON intakes(status, created_at);

-- ---- 心理師請假／不可預約時段（優先於 availability）----
CREATE TABLE IF NOT EXISTS time_off (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  counselor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 1,
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_timeoff ON time_off(counselor_id, start_date, end_date);

-- ---- 合作單位（學校認輔、企業EAP、社會局委託、法院裁定）----
CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'school',         -- school 學校 / eap 企業 / gov 政府社政 / court 司法 / medical 醫療 / other
  contact TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  tax_id TEXT NOT NULL DEFAULT '',             -- 統一編號（請款用）
  contract_no TEXT NOT NULL DEFAULT '',
  contract_start TEXT NOT NULL DEFAULT '',
  contract_end TEXT NOT NULL DEFAULT '',
  rate INTEGER NOT NULL DEFAULT 0,             -- 每次晤談議定價
  quota_sessions INTEGER NOT NULL DEFAULT 0,   -- 契約總次數（0 為不限）
  settle_note TEXT NOT NULL DEFAULT '',        -- 請款方式說明
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 月結請款單（對合作單位）
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                         -- YYYY-MM
  sessions INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',        -- draft 草稿 / sent 已請款 / paid 已入帳
  sent_at TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL DEFAULT '',
  invoice_no TEXT NOT NULL DEFAULT '',         -- 發票／收據號
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(partner_id, month)
);

-- ---- 繼續教育積分（心理師執業執照每 6 年更新需完成積分）----
CREATE TABLE IF NOT EXISTS ce_credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  organizer TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '專業課程',   -- 專業課程／專業品質／專業倫理／專業相關法規
  hours REAL NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,             -- 積分點數
  cert_no TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ce_user ON ce_credits(user_id, date);

-- ---- 團體諮商 ----
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  counselor_id INTEGER NOT NULL REFERENCES users(id),
  co_counselor_id INTEGER REFERENCES users(id),
  partner_id INTEGER REFERENCES partners(id),
  capacity INTEGER NOT NULL DEFAULT 10,
  sessions_total INTEGER NOT NULL DEFAULT 8,
  fee_per_session INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',         -- open 招募中 / running 進行中 / done 已結束
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL DEFAULT (date('now','localtime')),
  status TEXT NOT NULL DEFAULT 'active',       -- active / dropped
  note TEXT NOT NULL DEFAULT '',
  UNIQUE(group_id, client_id)
);
CREATE TABLE IF NOT EXISTS group_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  session_no INTEGER NOT NULL DEFAULT 1,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  room_id INTEGER REFERENCES rooms(id),
  topic TEXT NOT NULL DEFAULT '',
  process_note TEXT NOT NULL DEFAULT '',       -- 團體歷程紀錄（比照晤談紀錄保密）
  status TEXT NOT NULL DEFAULT 'planned',      -- planned / done / cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS group_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  attended INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  UNIQUE(session_id, client_id)
);

-- ---- LINE 傳話機器人 ----
-- 官方帳號收到個案的請假／改期訊息後轉給該心理師的 LINE 群組，
-- 心理師在群組回覆，行政人員於系統簽核後才真正改期，並同步回覆兩邊。
CREATE TABLE IF NOT EXISTS reschedule_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  counselor_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'reschedule',     -- reschedule 改期 / cancel 請假取消 / other 其他詢問
  source TEXT NOT NULL DEFAULT 'line',         -- line 官方帳號 / staff 櫃檯代錄
  raw_text TEXT NOT NULL DEFAULT '',           -- 個案原話
  status TEXT NOT NULL DEFAULT 'new',          -- new 待轉達 / relayed 已轉心理師 / replied 心理師已回 / approved 已簽核改期 / rejected 已退回 / closed 已結束
  relayed_at TEXT NOT NULL DEFAULT '',
  counselor_reply TEXT NOT NULL DEFAULT '',
  replied_at TEXT NOT NULL DEFAULT '',
  new_date TEXT NOT NULL DEFAULT '',
  new_start_time TEXT NOT NULL DEFAULT '',
  new_end_time TEXT NOT NULL DEFAULT '',
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT NOT NULL DEFAULT '',
  decision_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_resched_status ON reschedule_requests(status, created_at);

-- LINE 收送訊息軌跡：只留傳話本文，不含晤談內容
CREATE TABLE IF NOT EXISTS line_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,                     -- in 收到 / out 送出
  source_type TEXT NOT NULL DEFAULT '',        -- user 個案 / group 心理師群組 / system
  source_id TEXT NOT NULL DEFAULT '',          -- LINE userId / groupId
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  counselor_id INTEGER REFERENCES users(id),
  request_id INTEGER REFERENCES reschedule_requests(id) ON DELETE SET NULL,
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',           -- ok / failed / skipped
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_line_events_time ON line_events(created_at);
