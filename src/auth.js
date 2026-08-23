const jwt = require('jsonwebtoken');
const { db, SECRET, getSetting } = require('./db');

const STAFF_COOKIE = 'mc_staff';
const CLIENT_COOKIE = 'mc_client';
const TOKEN_TTL = '7d';

// 模組權限清單（非 admin 帳號逐一勾選）
const MODULES = [
  { key: 'schedule', label: '預約排程' },
  { key: 'intake', label: '來電登記與派案' },
  { key: 'clients', label: '個案管理' },
  { key: 'groups', label: '團體諮商' },
  { key: 'notes', label: '晤談紀錄' },
  { key: 'plans', label: '處遇計畫' },
  { key: 'assessments', label: '心理測驗量表' },
  { key: 'risk', label: '危機事件與通報' },
  { key: 'supervision', label: '督導紀錄' },
  { key: 'consents', label: '同意書' },
  { key: 'billing', label: '收費與方案' },
  { key: 'partners', label: '合作單位與請款' },
  { key: 'hr', label: '請假與繼續教育' },
  { key: 'payouts', label: '報酬與扣繳' },
  { key: 'messages', label: '個案訊息' },
  { key: 'line', label: 'LINE 傳話與改期簽核' },
  { key: 'ai', label: 'AI 助理' },
  { key: 'announcements', label: '公告' },
  { key: 'reports', label: '統計報表' },
  { key: 'users', label: '帳號權限' },
  { key: 'settings', label: '系統設定' }
];
const MODULE_KEYS = MODULES.map(m => m.key);

// 未啟用模組：所方用不到的功能（如合作單位請款、危機通報、督導紀錄）於系統設定關閉。
// 關閉後側欄不出現、API 一律 403，權限勾選仍保留，重新啟用即回復原本設定。
// 這裡不快取，設定改完立即生效。
function disabledModules() {
  return String(getSetting('disabled_modules', '')).split(',').map(s => s.trim()).filter(Boolean);
}
function moduleEnabled(key) { return !disabledModules().includes(key); }
function enabledModuleKeys() {
  const off = disabledModules();
  return MODULE_KEYS.filter(k => !off.includes(k));
}
// 模組以外的細項開關（如繼續教育積分區塊，附在「請假與繼續教育」頁內）
function featureOn(key) { return getSetting('feature_' + key, '1') === '1'; }

// 行政人員預設不含晤談紀錄與危機事件（保密考量），建立帳號時可再調整
const ROLE_DEFAULT_MODULES = {
  counselor: ['schedule', 'intake', 'clients', 'groups', 'notes', 'plans', 'assessments', 'risk', 'supervision', 'consents', 'hr', 'messages', 'announcements', 'reports', 'line', 'ai'],
  supervisor: ['schedule', 'intake', 'clients', 'groups', 'notes', 'plans', 'assessments', 'risk', 'supervision', 'consents', 'hr', 'messages', 'announcements', 'reports', 'line', 'ai'],
  staff: ['schedule', 'intake', 'clients', 'groups', 'assessments', 'consents', 'billing', 'partners', 'messages', 'announcements', 'line', 'ai']
};

// 登入暴力嘗試防護：同一帳號連續失敗 5 次鎖定 15 分鐘
const loginAttempts = new Map();
const LOGIN_MAX_FAILS = 5, LOGIN_LOCK_MS = 15 * 60 * 1000;
function loginLockedMinutes(key) {
  const a = loginAttempts.get(key);
  if (a && a.lockedUntil && a.lockedUntil > Date.now()) return Math.ceil((a.lockedUntil - Date.now()) / 60000);
  return 0;
}
function loginFailed(key) {
  if (loginAttempts.size > 10000) loginAttempts.clear();
  const a = loginAttempts.get(key) || { fails: 0 };
  a.fails++;
  if (a.fails >= LOGIN_MAX_FAILS) { a.lockedUntil = Date.now() + LOGIN_LOCK_MS; a.fails = 0; }
  loginAttempts.set(key, a);
}
function loginSucceeded(key) { loginAttempts.delete(key); }

// 服務跑在 nginx 後方，req.ip 一律是 127.0.0.1
function clientIp(req) {
  return (req.headers['x-real-ip'] || '').trim()
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
}

// 僅套在未登入的攻擊面（登入），不套一般 API：整所常共用一個對外 IP
function rateLimit({ windowMs, max, prefix = '' }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = prefix + clientIp(req);
    if (hits.size > 20000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    let e = hits.get(key);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(key, e); }
    e.count++;
    if (e.count > max) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    }
    next();
  };
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function signToken(payload) { return jwt.sign(payload, SECRET, { expiresIn: TOKEN_TTL }); }
function setAuthCookie(res, name, token) {
  res.setHeader('Set-Cookie', `${name}=${token}; HttpOnly; Path=/; Max-Age=${7 * 86400}; SameSite=Lax`);
}
function clearAuthCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function parsePermissions(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter(k => MODULE_KEYS.includes(k)) : [];
  } catch { return []; }
}

function requireStaff(moduleKey) {
  return (req, res, next) => {
    const token = parseCookies(req)[STAFF_COOKIE];
    if (!token) return res.status(401).json({ error: '請先登入' });
    let payload;
    try { payload = jwt.verify(token, SECRET); } catch { return res.status(401).json({ error: '登入已過期，請重新登入' }); }
    if (payload.t !== 'staff') return res.status(401).json({ error: '請先登入' });
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(payload.id);
    if (!user) return res.status(401).json({ error: '帳號不存在或已停用' });
    req.user = user;
    const off = disabledModules();
    req.userModules = (user.role === 'admin' ? MODULE_KEYS : parsePermissions(user.permissions))
      .filter(k => !off.includes(k));
    if (moduleKey && off.includes(moduleKey)) {
      return res.status(403).json({ error: '此模組未啟用' });
    }
    if (moduleKey && user.role !== 'admin' && !req.userModules.includes(moduleKey)) {
      return res.status(403).json({ error: '無此模組使用權限' });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  requireStaff()(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理者權限' });
    next();
  });
}

// 晤談紀錄保密邊界：僅主責諮商師本人、督導與管理者可讀寫，行政人員即使有 notes 權限也擋下。
// 這是本系統與一般客戶管理系統最大的差異，所有讀取晤談內容的端點都必須經過這裡。
function canViewNote(user, note) {
  if (user.role === 'admin' || user.role === 'supervisor') return true;
  if (user.role !== 'counselor') return false;
  if (note.counselor_id === user.id) return true;
  // 實習生的紀錄：其指定督導可調閱與覆核
  return isSupervisorOf(user, note.counselor_id);
}
// 實習心理師的紀錄，其指定督導必須看得到；督導角色本來就全看得到，
// 這裡處理的是「指定督導本身是 counselor 角色」的所別（小型諮商所常見）。
function isSupervisorOf(user, counselorId) {
  if (user.role === 'admin' || user.role === 'supervisor') return true;
  const c = db.prepare('SELECT supervisor_id FROM users WHERE id = ?').get(Number(counselorId) || 0);
  return !!c && Number(c.supervisor_id) === user.id;
}

// 個案層級：可否讀取該個案的晤談內容（主責諮商師／督導／管理者）
function canViewClientNotes(user, client) {
  if (user.role === 'admin' || user.role === 'supervisor') return true;
  if (user.role !== 'counselor') return false;
  if (client.counselor_id === user.id) return true;
  // 主責心理師為自己督導的實習生時，督導亦可讀（覆核紀錄需要看得到個案脈絡）
  return client.counselor_id ? isSupervisorOf(user, client.counselor_id) : false;
}
function requireNoteAccess(req, res, next) {
  const clientId = Number(req.params.clientId || req.body.client_id || req.query.client_id);
  const client = clientId ? db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) : null;
  if (!client) return res.status(404).json({ error: '找不到此個案' });
  if (!canViewClientNotes(req.user, client)) {
    return res.status(403).json({ error: '晤談紀錄僅限主責心理師、督導與管理者存取' });
  }
  req.client = client;
  next();
}

// 個案端
function requireClient(req, res, next) {
  const token = parseCookies(req)[CLIENT_COOKIE];
  if (!token) return res.status(401).json({ error: '請先登入' });
  let payload;
  try { payload = jwt.verify(token, SECRET); } catch { return res.status(401).json({ error: '登入已過期，請重新登入' }); }
  if (payload.t !== 'client') return res.status(401).json({ error: '請先登入' });
  const c = db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1 AND portal_enabled = 1').get(payload.id);
  if (!c) return res.status(401).json({ error: '帳號不存在或已停用' });
  req.client = c;
  next();
}

function requireAnyUser(req, res, next) {
  const cookies = parseCookies(req);
  for (const [name, type] of [[STAFF_COOKIE, 'staff'], [CLIENT_COOKIE, 'client']]) {
    const token = cookies[name];
    if (!token) continue;
    try {
      if (jwt.verify(token, SECRET).t === type) return next();
    } catch { /* 換下一種 cookie */ }
  }
  res.status(403).json({ error: '請先登入' });
}

module.exports = {
  MODULES, MODULE_KEYS, ROLE_DEFAULT_MODULES, disabledModules, moduleEnabled, enabledModuleKeys, featureOn, STAFF_COOKIE, CLIENT_COOKIE,
  signToken, setAuthCookie, clearAuthCookie, parsePermissions,
  requireStaff, requireAdmin, requireClient, requireAnyUser, requireNoteAccess,
  canViewNote, canViewClientNotes, isSupervisorOf,
  loginLockedMinutes, loginFailed, loginSucceeded, rateLimit, clientIp
};
