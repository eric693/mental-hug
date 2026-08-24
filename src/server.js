const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db, audit, getSetting, UI_TEXT_KEYS, DATA_DIR, UPLOAD_DIR } = require('./db');
const { buildCalendar } = require('./ics');
const {
  STAFF_COOKIE, signToken, setAuthCookie, clearAuthCookie,
  requireStaff, requireAdmin, disabledModules, featureOn,
  loginLockedMinutes, loginFailed, loginSucceeded, rateLimit
} = require('./auth');

const loginRateLimit = rateLimit({ windowMs: 5 * 60 * 1000, max: 30, prefix: 'login:' });

const app = express();
app.disable('x-powered-by');
// LINE webhook 需要未經解析的原始 body 來驗簽章，故在此保留一份
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => { if (req.originalUrl === '/line/webhook') req.rawBody = buf; }
}));

// ---- 公開端點：登入頁文字 ----
app.get('/api/public/ui-texts', (req, res) => {
  const out = {
    center_name: getSetting('center_name', '擁抱心理諮商所'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address')
  };
  for (const k of UI_TEXT_KEYS) out[k] = getSetting(k);
  res.json(out);
});

// ---- 員工登入 ----
app.post('/api/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const lockKey = `staff:${username || ''}`;
  const locked = loginLockedMinutes(lockKey);
  if (locked) return res.status(429).json({ error: `登入失敗次數過多，請 ${locked} 分鐘後再試` });
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    loginFailed(lockKey);
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  loginSucceeded(lockKey);
  setAuthCookie(res, STAFF_COOKIE, signToken({ t: 'staff', id: user.id }));
  audit('staff', user.id, user.name, '員工登入');
  res.json({ id: user.id, name: user.name, role: user.role });
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(res, STAFF_COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', requireStaff(), (req, res) => {
  res.json({
    id: req.user.id, username: req.user.username, name: req.user.name,
    role: req.user.role, title: req.user.title, license_type: req.user.license_type,
    // 實習生：紀錄簽核走督導覆核；is_supervisor 決定「待覆核紀錄」頁是否出現
    is_intern: !!req.user.is_intern,
    is_supervisor: req.user.role === 'admin' || req.user.role === 'supervisor'
      || !!db.prepare('SELECT 1 FROM users WHERE supervisor_id = ? AND active = 1').get(req.user.id),
    modules: req.userModules,
    // 未啟用模組與細項開關：前端據此隱藏側欄項目與看板區塊
    disabled_modules: disabledModules(),
    features: { ce: featureOn('ce') },
    center_name: getSetting('center_name', '擁抱心理諮商所')
  });
});

// ---- 行事曆訂閱（.ics，免登入以 token 驗證）----
// 手機日曆 App 無法帶 Cookie，故以每人一組隨機 token 的網址提供；
// 內容不含個案姓名等識別資料，token 可於「我的排班」頁隨時重設。
app.get('/calendar/:token/mindcare.ics', (req, res) => {
  const cal = buildCalendar(String(req.params.token || ''));
  if (!cal) return res.status(404).type('text/plain').send('calendar not found');
  res.type('text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="mindcare.ics"');
  res.set('Cache-Control', 'no-store');
  res.send(cal.body);
});

// ---- 模組路由 ----
app.use('/api/portal', require('./routes/portal'));
app.use('/api', require('./routes/clients'));
app.use('/api', require('./routes/intake'));
app.use('/api', require('./routes/groups'));
app.use('/api', require('./routes/partners'));
app.use('/api', require('./routes/hr'));
app.use('/api', require('./routes/schedule'));
app.use('/api', require('./routes/notes'));
app.use('/api', require('./routes/assessments'));
app.use('/api', require('./routes/risk'));
app.use('/api', require('./routes/safety'));
app.use('/api', require('./routes/aftercare'));
app.use('/api', require('./routes/billing'));
app.use('/api', require('./routes/org'));
app.use('/api', require('./routes/attachments'));
app.use('/api', require('./routes/imports'));
// LINE 傳話機器人：/line/webhook（免登入、驗簽章）與 /api/reschedule-requests 等系統端 API
app.use(require('./routes/line'));
// 對外預約頁的公開 API（免登入、有流量限制，只吐空檔不吐個案資料）
app.use(require('./routes/booking'));
// 客戶分級與財務儀表板（只用行政層資料，不碰晤談內容）
app.use('/api', require('./routes/insights'));
// AI 助理：以唯讀工具查後台資料，晤談內容不進模型上下文
app.use('/api', require('./routes/ai'));
// 非個案服務（外派演講、講座）與歷史虛擬個案重新標記
app.use('/api', require('./routes/nonclient'));
// LINE 溝通儀表板：個案訊息的多層次人工審核（AI 初篩 → 行政初審 → 心理師擬稿 → 行政複審 → 送出）
app.use('/api', require('./routes/inquiries'));
// 分帳引擎：規則版本化、模擬器、拆帳與人員月結
app.use('/api', require('./routes/split'));
// 機構專案：主檔、個案額度與對帳單
app.use('/api', require('./routes/projects'));
// 收費對帳：自動確認與人工佇列、金流入帳、三方勾稽、收據雙版本與月度匯出
app.use('/api', require('./routes/reconcile'));
// 排班與專業人員：可預約時段提交核定、產能、Ramp-up、請假異動
app.use('/api', require('./routes/staffing'));

// 手動觸發備份與附件同步：換機、要立刻帶走資料，或剛上傳完重要附件時不必等排程。
// 僅管理者可用，並回報備份檔與同步的附件數，方便確認真的做了。
app.post('/api/maintenance/backup', requireAdmin, async (req, res) => {
  try {
    await dailyMaintenance(true);
    const backups = fs.existsSync(BACKUP_DIR)
      ? fs.readdirSync(BACKUP_DIR).filter(f => /^mindcare-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort()
      : [];
    const uploads = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).length : 0;
    const mirrored = BACKUP_MIRROR && fs.existsSync(path.join(BACKUP_MIRROR, 'uploads'))
      ? fs.readdirSync(path.join(BACKUP_MIRROR, 'uploads')).length : 0;
    audit('staff', req.user.id, req.user.name, '手動執行備份', '', { backups: backups.length });
    res.json({
      ok: true,
      latest_backup: backups[backups.length - 1] || null,
      backup_count: backups.length,
      mirror: BACKUP_MIRROR || null,
      uploads_total: uploads,
      uploads_mirrored: mirrored
    });
  } catch (e) {
    res.status(500).json({ error: '備份失敗：' + e.message });
  }
});

// ---- 靜態檔 ----
// uploads 目錄不對外開放：附件含個案敏感資料，一律經 /api/attachments/:id/download
// 逐筆檢查權限後才回傳（個案端另有只能讀自己檔案的路由）。
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', index: 'index.html' }));

app.use('/api', (req, res) => res.status(404).json({ error: '找不到此 API' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '系統發生錯誤，請稍後再試' });
});

// ---- 每日維護：備份與稽核軌跡清理 ----
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_MIRROR = process.env.MINDCARE_BACKUP_MIRROR !== undefined
  ? process.env.MINDCARE_BACKUP_MIRROR
  : '/root/backups/mental-hug';   // 與同機其他諮商所的鏡像目錄分開，避免互相覆蓋
const BACKUP_KEEP = 14;

function unlinkBackup(dir, name) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(path.join(dir, name + suffix)); } catch { /* 不存在即略過 */ }
  }
}
function sweepBackupDir(dir) {
  if (!fs.existsSync(dir)) return;
  const all = fs.readdirSync(dir);
  const dbs = all.filter(f => /^mindcare-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  while (dbs.length > BACKUP_KEEP) unlinkBackup(dir, dbs.shift());
  const kept = new Set(dbs);
  for (const f of all) {
    const m = f.match(/^(mindcare-\d{4}-\d{2}-\d{2}\.db)-(wal|shm)$/);
    if (!m) continue;
    const p = path.join(dir, f);
    let drop = !kept.has(m[1]) || m[2] === 'shm';
    if (!drop) { try { drop = fs.statSync(p).size === 0; } catch { drop = true; } }
    if (drop) { try { fs.unlinkSync(p); } catch { /* 略過 */ } }
  }
}
// 附件備份：資料庫只存檔名，實體檔在 uploads/，兩者要一起備份才救得回來。
// 以「檔名相同且大小相同就跳過」判斷是否需複製，避免每次全量複製。
function mirrorUploads(destRoot) {
  const src = UPLOAD_DIR;
  if (!fs.existsSync(src)) return 0;
  const dest = path.join(destRoot, 'uploads');
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const f of fs.readdirSync(src)) {
    const sp = path.join(src, f), dp = path.join(dest, f);
    try {
      const ss = fs.statSync(sp);
      if (!ss.isFile()) continue;
      if (fs.existsSync(dp) && fs.statSync(dp).size === ss.size) continue;
      fs.copyFileSync(sp, dp);
      copied++;
    } catch { /* 個別檔案失敗不影響其他檔 */ }
  }
  return copied;
}

// 孤兒檔清理：資料庫已無對應紀錄的實體檔（例如上傳成功但寫入失敗、或人工刪過資料列）。
// 只清超過 24 小時的檔案，避免誤刪正在上傳中的暫存檔。
function sweepOrphanUploads() {
  const dir = UPLOAD_DIR;
  if (!fs.existsSync(dir)) return 0;
  const known = new Set(db.prepare('SELECT stored_name FROM attachments').all().map(r => r.stored_name));
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (known.has(f)) continue;
    const p2 = path.join(dir, f);
    try {
      if (Date.now() - fs.statSync(p2).mtimeMs < 24 * 3600 * 1000) continue;
      fs.unlinkSync(p2);
      removed++;
    } catch { /* 略過 */ }
  }
  return removed;
}

// force=true 時即使當天已備份過也重做一次（手動觸發備份用，
// 否則當天稍後上傳的資料不會進到那份備份檔裡）
async function dailyMaintenance(force = false) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const name = `mindcare-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.db`;
    const dest = path.join(BACKUP_DIR, name);
    if (force || !fs.existsSync(dest)) {
      await db.backup(dest);
      console.log(`資料庫已備份：${dest}`);
      if (BACKUP_MIRROR) {
        try {
          fs.mkdirSync(BACKUP_MIRROR, { recursive: true });
          fs.copyFileSync(dest, path.join(BACKUP_MIRROR, name));
          sweepBackupDir(BACKUP_MIRROR);
        } catch (e) { console.error('異地備份失敗：', e.message); }
      }
    }
    // 附件同步每輪都做（不只在產生新備份時），當天上傳的檔案才不會延到隔天才進備份
    if (BACKUP_MIRROR) {
      try {
        const n = mirrorUploads(BACKUP_MIRROR);
        if (n) console.log(`附件已同步至異地備份：${n} 個檔案`);
      } catch (e) { console.error('附件異地備份失敗：', e.message); }
    }
    sweepBackupDir(BACKUP_DIR);
    const orphans = sweepOrphanUploads();
    if (orphans) console.log(`已清理孤兒附件檔：${orphans} 個`);
    // WAL 檔會隨寫入持續變大，備份後截斷回收空間並確保資料已落地主檔
    db.pragma('wal_checkpoint(TRUNCATE)');
    const retention = Number(getSetting('audit_retention_days', '1825'));
    if (retention > 0) {
      db.prepare("DELETE FROM audit_logs WHERE created_at < datetime('now','localtime',?)").run(`-${retention} days`);
    }
  } catch (e) { console.error('每日維護作業失敗：', e.message); }
}
dailyMaintenance();
setInterval(dailyMaintenance, 6 * 3600 * 1000);

const PORT = process.env.PORT || 3350;
app.listen(PORT, () => {
  console.log(`擁抱心理諮商所管理系統 http://localhost:${PORT}`);
  console.log(`個案專區 http://localhost:${PORT}/portal.html`);
});
