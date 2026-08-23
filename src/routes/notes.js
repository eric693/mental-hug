const express = require('express');
const { db, audit, today, nowStamp, getSetting, listQuery } = require('../db');
const { requireStaff, requireNoteAccess, canViewNote, isSupervisorOf, clientIp } = require('../auth');

const router = express.Router();

const NOTE_FIELDS = ['date', 'session_no', 'duration_min', 'subjective', 'objective', 'assessment',
  'plan', 'intervention', 'homework', 'risk_flag', 'risk_note'];

// 某個案的晤談紀錄；requireNoteAccess 已擋掉非主責／非督導
router.get('/clients/:clientId/notes', requireStaff('notes'), requireNoteAccess, (req, res) => {
  const rows = db.prepare(`SELECT n.*, u.name AS counselor_name FROM session_notes n
    LEFT JOIN users u ON u.id = n.counselor_id WHERE n.client_id = ?
    ORDER BY n.date DESC, n.id DESC`).all(req.client.id);
  audit('staff', req.user.id, req.user.name, '調閱晤談紀錄', req.client.code, { count: rows.length });
  res.json(rows);
});

// 待補紀錄：已完成但尚無晤談紀錄的晤談（諮商師看自己的）
router.get('/notes/pending', requireStaff('notes'), (req, res) => {
  const mine = req.user.role === 'counselor' ? 'AND a.counselor_id = ' + req.user.id : '';
  const rows = db.prepare(`SELECT a.id, a.date, a.start_time, a.type, a.counselor_id,
      c.id AS client_id, c.name AS client_name, c.code AS client_code, u.name AS counselor_name,
      CAST(julianday('now','localtime') - julianday(a.date) AS INTEGER) AS days_ago
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN users u ON u.id = a.counselor_id
    WHERE a.status = 'done' ${mine}
      AND NOT EXISTS (SELECT 1 FROM session_notes n WHERE n.appointment_id = a.id)
    ORDER BY a.date`).all();
  res.json({ lock_days: Number(getSetting('note_lock_days', '7')), rows });
});

// 待覆核清單：督導看自己督導的實習生，管理者／督導看全部
router.get('/notes/review-queue', requireStaff('notes'), (req, res) => {
  const all = req.user.role === 'admin' || req.user.role === 'supervisor';
  const rows = db.prepare(`SELECT n.id, n.date, n.session_no, n.submitted_at, n.review_status, n.review_comment,
      n.counselor_id, u.name AS counselor_name, c.id AS client_id, c.name AS client_name, c.code AS client_code,
      n.risk_flag,
      CAST(julianday('now','localtime') - julianday(substr(n.submitted_at,1,10)) AS INTEGER) AS days_waiting
    FROM session_notes n
    JOIN users u ON u.id = n.counselor_id
    JOIN clients c ON c.id = n.client_id
    WHERE n.review_status = 'pending' ${all ? '' : 'AND u.supervisor_id = ' + req.user.id}
    ORDER BY n.submitted_at`).all();
  // 實習生自己看得到「被退回待補正」的紀錄
  const returned = db.prepare(`SELECT n.id, n.date, n.session_no, n.review_comment, n.reviewed_at,
      c.id AS client_id, c.name AS client_name, c.code AS client_code, r.name AS reviewer_name
    FROM session_notes n JOIN clients c ON c.id = n.client_id LEFT JOIN users r ON r.id = n.reviewer_id
    WHERE n.review_status = 'returned' AND n.counselor_id = ? ORDER BY n.reviewed_at DESC`).all(req.user.id);
  res.json({
    can_review: all || !!db.prepare('SELECT 1 FROM users WHERE supervisor_id = ? AND active = 1').get(req.user.id),
    alert_days: Number(getSetting('note_review_days', '7')),
    rows, returned
  });
});

router.get('/notes/:id', requireStaff('notes'), (req, res) => {
  const n = db.prepare(`SELECT n.*, u.name AS counselor_name, c.name AS client_name, c.code AS client_code
    FROM session_notes n LEFT JOIN users u ON u.id = n.counselor_id
    LEFT JOIN clients c ON c.id = n.client_id WHERE n.id = ?`).get(req.params.id);
  if (!n) return res.status(404).json({ error: '找不到此紀錄' });
  if (!canViewNote(req.user, n)) return res.status(403).json({ error: '晤談紀錄僅限主責心理師、督導與管理者存取' });
  audit('staff', req.user.id, req.user.name, '調閱晤談紀錄', n.client_code, { note_id: n.id });
  res.json(n);
});

// 諮商紀錄列印版：帶機構抬頭與心理師署名，供轉介、法院調閱或個案申請時輸出。
// 權限與調閱一致（主責心理師／督導／管理者），且列印一樣寫入稽核軌跡。
router.get('/notes/:id/print', requireStaff('notes'), (req, res) => {
  const n = db.prepare(`SELECT n.*, u.name AS counselor_name, u.license_type, u.license_no,
      c.name AS client_name, c.code AS client_code, c.birth_date, c.gender,
      a.date AS appt_date, a.start_time, a.end_time, a.type AS appt_type, a.mode
    FROM session_notes n
    LEFT JOIN users u ON u.id = n.counselor_id
    LEFT JOIN clients c ON c.id = n.client_id
    LEFT JOIN appointments a ON a.id = n.appointment_id
    WHERE n.id = ?`).get(req.params.id);
  if (!n) return res.status(404).json({ error: '找不到此紀錄' });
  if (!canViewNote(req.user, n)) return res.status(403).json({ error: '晤談紀錄僅限主責心理師、督導與管理者存取' });
  audit('staff', req.user.id, req.user.name, '列印晤談紀錄', n.client_code, { note_id: n.id });
  res.json({
    ...n,
    printed_by: req.user.name,
    printed_at: nowStamp(),
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address'),
    center_license_no: getSetting('center_license_no'),
    center_director: getSetting('center_director')
  });
});

// ---- 批次列印（M8-05～11）----
// 批次列印一次把多筆心理紀錄輸出成紙本，等同特種個資的大量匯出，
// 因此不是「多一個按鈕」而已：用途必填、留不可修改的批次軌跡、每頁浮水印、
// 異常樣態主動示警。這些是規格明訂不可延後的部分。

const PRINT_PURPOSES = ['督考', '司法調閱', '個案申請', '內部歸檔', '其他'];
const BATCH_BG_THRESHOLD = 50;     // 超過此筆數轉背景工作（M8-11）

function nextBatchNo() {
  const day = today().replace(/-/g, '');
  const row = db.prepare("SELECT batch_no FROM print_batches WHERE batch_no LIKE ? ORDER BY batch_no DESC LIMIT 1")
    .get(`PB-${day}-%`);
  const seq = row ? Number(row.batch_no.slice(-4)) + 1 : 1;
  return `PB-${day}-${String(seq).padStart(4, '0')}`;
}

// 依篩選條件解出要印哪些紀錄。ids 優先；否則以個案／日期／心理師／類型篩選。
// 這個函式同時服務「預覽數量」與「實際列印」，兩邊看到的 N 必然一致（反向選取要靠它）。
function resolveNotes(filters) {
  const f = filters || {};
  if (Array.isArray(f.ids) && f.ids.length) {
    const ids = f.ids.map(Number).filter(Boolean).slice(0, 500);
    if (!ids.length) return [];
    return db.prepare(`SELECT * FROM session_notes WHERE id IN (${ids.map(() => '?').join(',')})
      ORDER BY client_id, date, session_no`).all(...ids);
  }
  const where = [], args = [];
  if (f.client_id) { where.push('client_id = ?'); args.push(Number(f.client_id)); }
  if (f.counselor_id) { where.push('counselor_id = ?'); args.push(Number(f.counselor_id)); }
  if (f.record_type) { where.push('record_type = ?'); args.push(String(f.record_type)); }
  if (f.from) { where.push('date >= ?'); args.push(String(f.from).slice(0, 10)); }
  if (f.to) { where.push('date <= ?'); args.push(String(f.to).slice(0, 10)); }
  if (!where.length) return [];
  return db.prepare(`SELECT * FROM session_notes WHERE ${where.join(' AND ')}
    ORDER BY client_id, date, session_no LIMIT 500`).all(...args);
}

// 目前篩選條件下「我看得到幾筆」——反向選取與「全選全部結果（N）」都以這個數字為準
router.post('/notes/print-scope', requireStaff('notes'), (req, res) => {
  const rows = resolveNotes(req.body || {});
  const visible = rows.filter(n => canViewNote(req.user, n));
  res.json({
    total: visible.length,
    hidden: rows.length - visible.length,
    ids: visible.map(n => n.id),
    background: visible.length > BATCH_BG_THRESHOLD,
    threshold: BATCH_BG_THRESHOLD,
    purposes: PRINT_PURPOSES
  });
});

// 異常樣態（M8-10）：不阻擋，但要讓管理者看得到
function batchAnomalies(user) {
  const out = [];
  const dayCount = db.prepare(`SELECT COALESCE(SUM(count),0) n FROM print_batches
    WHERE user_id = ? AND substr(created_at,1,10) = ?`).get(user.id, today()).n;
  const limit = Number(getSetting('print_batch_daily_limit', '100'));
  if (dayCount > limit) out.push(`今日已批次列印 ${dayCount} 筆，超過所內門檻 ${limit} 筆`);
  const hour = new Date().getHours();
  const [openH, closeH] = getSetting('office_hours', '08:00-21:00').split('-')
    .map(t => Number(String(t).slice(0, 2)));
  if (hour < openH || hour >= closeH) out.push(`於非上班時段（${String(hour).padStart(2, '0')} 時）執行批次列印`);
  const recent = db.prepare(`SELECT COUNT(*) n FROM print_batches
    WHERE user_id = ? AND created_at >= datetime('now','localtime','-1 hour')`).get(user.id).n;
  if (recent >= 3) out.push(`一小時內已執行 ${recent} 次批次列印`);
  return out;
}

router.post('/notes/print-batch', requireStaff('notes'), (req, res) => {
  const b2 = req.body || {};
  const purpose = String(b2.purpose || '').trim();
  if (!PRINT_PURPOSES.includes(purpose)) {
    return res.status(400).json({ error: `請選擇列印用途（${PRINT_PURPOSES.join('／')}）` });
  }
  if (purpose === '其他' && !String(b2.purpose_note || '').trim()) {
    return res.status(400).json({ error: '用途選「其他」時請說明' });
  }
  const rows = resolveNotes(b2);
  if (!rows.length) return res.status(400).json({ error: '沒有符合條件的紀錄' });

  const out = [];
  let skipped = 0;
  for (const n of rows) {
    if (!canViewNote(req.user, n)) { skipped++; continue; }
    const extra = db.prepare(`SELECT u.name AS counselor_name, u.license_type, u.license_no,
        c.name AS client_name, c.code AS client_code, c.birth_date, c.gender,
        a.start_time, a.end_time, a.type AS appt_type, a.mode
      FROM session_notes n
      LEFT JOIN users u ON u.id = n.counselor_id
      LEFT JOIN clients c ON c.id = n.client_id
      LEFT JOIN appointments a ON a.id = n.appointment_id
      WHERE n.id = ?`).get(n.id);
    out.push({ ...n, ...extra });
  }
  if (!out.length) return res.status(403).json({ error: '這些紀錄都不在您的存取範圍內' });

  const batchNo = nextBatchNo();
  const background = out.length > BATCH_BG_THRESHOLD;
  db.prepare(`INSERT INTO print_batches (batch_no, user_id, user_name, purpose, purpose_note,
      filters, note_ids, count, skipped, mode, status, ip)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    batchNo, req.user.id, req.user.name, purpose, String(b2.purpose_note || '').slice(0, 200),
    JSON.stringify({ ...b2, ids: undefined }), JSON.stringify(out.map(n => n.id)),
    out.length, skipped, b2.mode === 'split' ? 'split' : 'merged',
    background ? 'queued' : 'done', clientIp(req));
  // 每一筆都各自留調閱軌跡，跟單筆列印一致
  for (const n of out) {
    audit('staff', req.user.id, req.user.name, '批次列印晤談紀錄', n.client_code || '',
      { note_id: n.id, batch_no: batchNo, purpose });
  }
  audit('staff', req.user.id, req.user.name, '建立列印批次', batchNo,
    { count: out.length, purpose, skipped });

  res.json({
    batch_no: batchNo,
    rows: out,
    skipped,
    background,
    anomalies: batchAnomalies(req.user),
    purpose,
    purpose_note: String(b2.purpose_note || ''),
    printed_by: req.user.name,
    printed_at: nowStamp(),
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address'),
    center_license_no: getSetting('center_license_no'),
    center_director: getSetting('center_director')
  });
});

// 背景批次完成回報（前端把大批列印畫完後回呼，用於 M8-11 的「完成後通知」）
router.post('/print-batches/:batch/done', requireStaff('notes'), (req, res) => {
  const row = db.prepare('SELECT * FROM print_batches WHERE batch_no = ?').get(req.params.batch);
  if (!row) return res.status(404).json({ error: '找不到此批次' });
  if (row.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只有建立者或管理者可更新此批次' });
  }
  db.prepare("UPDATE print_batches SET status = 'done' WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

// 批次列印軌跡：不提供修改與刪除端點，只能查
router.get('/print-batches', requireStaff('notes'), (req, res) => {
  const where = [], args = [];
  if (!['admin', 'supervisor'].includes(req.user.role)) { where.push('user_id = ?'); args.push(req.user.id); }
  if (req.query.purpose) { where.push('purpose = ?'); args.push(String(req.query.purpose)); }
  if (req.query.from) { where.push('created_at >= ?'); args.push(String(req.query.from)); }
  if (req.query.to) { where.push('created_at <= ?'); args.push(String(req.query.to) + ' 23:59:59'); }
  const page = listQuery({
    from: 'print_batches', where, args,
    search: String(req.query.q || ''),
    searchFields: ['batch_no', 'user_name', 'purpose', 'purpose_note'],
    order: 'id DESC', page: req.query.page, size: Number(req.query.size) || 50, maxSize: 200
  });
  res.json({
    ...page,
    rows: page.rows.map(r => ({ ...r, filters: JSON.parse(r.filters || '{}'), note_ids: JSON.parse(r.note_ids || '[]') })),
    purposes: PRINT_PURPOSES,
    daily_limit: Number(getSetting('print_batch_daily_limit', '100')),
    anomalies: batchAnomalies(req.user)
  });
});

router.post('/notes', requireStaff('notes'), requireNoteAccess, (req, res) => {
  const b = req.body || {};
  if (req.user.role === 'staff') return res.status(403).json({ error: '僅心理師可撰寫晤談紀錄' });
  const appt = b.appointment_id ? db.prepare('SELECT * FROM appointments WHERE id = ?').get(b.appointment_id) : null;
  if (appt && db.prepare('SELECT 1 FROM session_notes WHERE appointment_id = ?').get(appt.id)) {
    return res.status(400).json({ error: '此次晤談已有紀錄' });
  }
  const last = db.prepare('SELECT MAX(session_no) n FROM session_notes WHERE client_id = ?').get(req.client.id).n || 0;
  const info = db.prepare(`INSERT INTO session_notes
    (client_id, appointment_id, counselor_id, date, session_no, duration_min, subjective, objective,
     assessment, plan, intervention, homework, risk_flag, risk_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.client.id, appt ? appt.id : null, req.user.id,
    b.date || (appt ? appt.date : today()),
    Number(b.session_no) || last + 1,
    Number(b.duration_min) || Number(getSetting('session_minutes', '50')),
    b.subjective || '', b.objective || '', b.assessment || '', b.plan || '',
    b.intervention || '', b.homework || '', b.risk_flag || 'none', b.risk_note || '');
  // 紀錄中標註風險即同步拉高個案風險等級，讓總覽與個案清單看得到
  if (b.risk_flag && b.risk_flag !== 'none') {
    db.prepare("UPDATE clients SET risk_level = ? WHERE id = ?")
      .run(b.risk_flag === 'ideation' ? 'medium' : 'high', req.client.id);
  }
  audit('staff', req.user.id, req.user.name, '新增晤談紀錄', req.client.code, { note_id: info.lastInsertRowid });
  res.json({ id: info.lastInsertRowid });
});

router.put('/notes/:id', requireStaff('notes'), (req, res) => {
  const n = db.prepare('SELECT * FROM session_notes WHERE id = ?').get(req.params.id);
  if (!n) return res.status(404).json({ error: '找不到此紀錄' });
  if (!canViewNote(req.user, n)) return res.status(403).json({ error: '無權限修改此紀錄' });
  if (n.locked) return res.status(400).json({ error: '紀錄已簽核定稿，不可修改' });
  if (n.review_status === 'pending') return res.status(400).json({ error: '紀錄已送出督導覆核，如需修改請先請督導退回' });
  if (req.user.role === 'supervisor' && n.counselor_id !== req.user.id) {
    return res.status(403).json({ error: '督導僅可調閱，不可代為修改紀錄' });
  }
  const data = {};
  for (const f of NOTE_FIELDS) if (req.body[f] !== undefined) data[f] = req.body[f];
  if (!Object.keys(data).length) return res.json({ ok: true });
  db.prepare(`UPDATE session_notes SET ${Object.keys(data).map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(data), n.id);
  // 被退回補正的紀錄一經修改即回到草稿，需重新送覆核（保留督導意見供對照）
  if (n.review_status === 'returned') {
    db.prepare("UPDATE session_notes SET review_status = 'none' WHERE id = ?").run(n.id);
  }
  audit('staff', req.user.id, req.user.name, '修改晤談紀錄', String(n.client_id), { note_id: n.id });
  res.json({ ok: true });
});

// 簽核定稿：定稿後不可再改（比照病歷不得事後塗改）。
// 實習心理師的紀錄不會因本人簽核就定稿，而是轉為「待督導覆核」，
// 由指定督導（或督導／管理者）覆核通過後才鎖定；退回補正者可修改後再送。
// 刪除晤談紀錄：只允許本人刪自己「尚未簽核」的草稿。
// 已簽核定稿的紀錄依《心理師法》應保存，系統一律不提供刪除。
router.delete('/notes/:id', requireStaff('notes'), (req, res) => {
  const n = db.prepare(`SELECT n.*, c.code AS client_code FROM session_notes n
    LEFT JOIN clients c ON c.id = n.client_id WHERE n.id = ?`).get(req.params.id);
  if (!n) return res.status(404).json({ error: '找不到此紀錄' });
  if (!canViewNote(req.user, n)) return res.status(403).json({ error: '晤談紀錄僅限主責心理師、督導與管理者存取' });
  if (n.locked) return res.status(400).json({ error: '已簽核定稿的紀錄不可刪除' });
  if (n.review_status === 'pending') return res.status(400).json({ error: '已送出督導覆核，請先請督導退回再刪除' });
  if (n.counselor_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只能刪除自己撰寫的草稿' });
  }
  db.prepare('DELETE FROM session_notes WHERE id = ?').run(n.id);
  audit('staff', req.user.id, req.user.name, '刪除晤談紀錄草稿', n.client_code || '', { note_id: n.id, date: n.date });
  res.json({ ok: true });
});

router.post('/notes/:id/sign', requireStaff('notes'), (req, res) => {
  const n = db.prepare('SELECT * FROM session_notes WHERE id = ?').get(req.params.id);
  if (!n) return res.status(404).json({ error: '找不到此紀錄' });
  if (n.counselor_id !== req.user.id) return res.status(403).json({ error: '僅撰寫者本人可簽核' });
  if (n.locked) return res.status(400).json({ error: '此紀錄已簽核' });
  if (n.review_status === 'pending') return res.status(400).json({ error: '此紀錄已送出覆核，請等待督導處理' });
  if (req.user.is_intern) {
    if (!req.user.supervisor_id) {
      return res.status(400).json({ error: '尚未指定督導，請聯繫管理者於帳號設定指定督導後再送覆核' });
    }
    db.prepare("UPDATE session_notes SET review_status = 'pending', submitted_at = ?, reviewer_id = ? WHERE id = ?")
      .run(nowStamp(), req.user.supervisor_id, n.id);
    audit('staff', req.user.id, req.user.name, '送出紀錄覆核', String(n.client_id), { note_id: n.id });
    return res.json({ ok: true, review_status: 'pending', message: '已送出督導覆核，覆核通過後才會定稿' });
  }
  db.prepare('UPDATE session_notes SET locked = 1, signed_at = ? WHERE id = ?').run(nowStamp(), n.id);
  audit('staff', req.user.id, req.user.name, '簽核晤談紀錄', String(n.client_id), { note_id: n.id });
  res.json({ ok: true, review_status: 'none' });
});

// 督導覆核：通過即定稿鎖定（同時記下覆核者與時間），退回則附意見供實習生補正
router.post('/notes/:id/review', requireStaff('notes'), (req, res) => {
  const n = db.prepare('SELECT * FROM session_notes WHERE id = ?').get(req.params.id);
  if (!n) return res.status(404).json({ error: '找不到此紀錄' });
  if (n.review_status !== 'pending') return res.status(400).json({ error: '此紀錄目前不在待覆核狀態' });
  if (n.counselor_id === req.user.id) return res.status(403).json({ error: '不可覆核自己撰寫的紀錄' });
  if (!isSupervisorOf(req.user, n.counselor_id)) {
    return res.status(403).json({ error: '僅該實習生的指定督導、督導或管理者可覆核' });
  }
  const { action = '', comment = '' } = req.body || {};
  if (action === 'approve') {
    db.prepare(`UPDATE session_notes SET review_status = 'approved', reviewer_id = ?, reviewed_at = ?,
      review_comment = ?, locked = 1, signed_at = ? WHERE id = ?`)
      .run(req.user.id, nowStamp(), comment || '', n.signed_at || nowStamp(), n.id);
    audit('staff', req.user.id, req.user.name, '覆核通過晤談紀錄', String(n.client_id), { note_id: n.id });
    return res.json({ ok: true });
  }
  if (action === 'return') {
    if (!String(comment).trim()) return res.status(400).json({ error: '退回補正請填寫意見' });
    db.prepare(`UPDATE session_notes SET review_status = 'returned', reviewer_id = ?, reviewed_at = ?,
      review_comment = ? WHERE id = ?`).run(req.user.id, nowStamp(), String(comment).trim(), n.id);
    audit('staff', req.user.id, req.user.name, '退回晤談紀錄補正', String(n.client_id), { note_id: n.id });
    return res.json({ ok: true });
  }
  res.status(400).json({ error: '請指定覆核結果' });
});

// ---- 心理衡鑑報告書 ----
// 保密層級比照晤談紀錄：僅主責心理師、督導、管理者可讀；定稿後不可修改，
// 需更正時另立新報告（比照病歷不得事後塗改）。

const REPORT_FIELDS = ['test_date', 'report_date', 'purpose', 'referral_source', 'instruments',
  'background', 'observation', 'results', 'impression', 'recommendation', 'validity'];

function reportScores(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return JSON.stringify(arr.filter(r => r && (r.instrument || r.index)).map(r => ({
    instrument: String(r.instrument || ''),
    index: String(r.index || ''),
    score: String(r.score || ''),
    norm: String(r.norm || ''),
    interpretation: String(r.interpretation || '')
  })));
}

router.get('/clients/:clientId/reports', requireStaff('notes'), requireNoteAccess, (req, res) => {
  const rows = db.prepare(`SELECT r.*, u.name AS counselor_name FROM assessment_reports r
    LEFT JOIN users u ON u.id = r.counselor_id WHERE r.client_id = ?
    ORDER BY r.test_date DESC, r.id DESC`).all(req.client.id);
  audit('staff', req.user.id, req.user.name, '調閱衡鑑報告', req.client.code, { count: rows.length });
  res.json(rows.map(r => ({ ...r, scores: JSON.parse(r.scores || '[]') })));
});

// 待完成的衡鑑報告：已完成的「心理衡鑑」晤談但尚無報告，或報告仍是草稿。
// 衡鑑報告常是轉介單位在等的文件，逾期未出會直接影響個案權益，故獨立列管。
router.get('/reports/pending', requireStaff('notes'), (req, res) => {
  const mine = req.user.role === 'counselor' ? 'AND a.counselor_id = ' + req.user.id : '';
  const mineR = req.user.role === 'counselor' ? 'AND r.counselor_id = ' + req.user.id : '';
  res.json({
    lock_days: Number(getSetting('note_lock_days', '7')),
    // 已施測但還沒有任何報告
    missing: db.prepare(`SELECT a.id, a.date, a.counselor_id, c.id AS client_id, c.name AS client_name, c.code AS client_code,
        u.name AS counselor_name,
        CAST(julianday('now','localtime') - julianday(a.date) AS INTEGER) AS days_ago
      FROM appointments a JOIN clients c ON c.id = a.client_id
      LEFT JOIN users u ON u.id = a.counselor_id
      WHERE a.status = 'done' AND a.type = 'assessment' ${mine}
        AND NOT EXISTS (SELECT 1 FROM assessment_reports r WHERE r.client_id = a.client_id AND r.test_date = a.date)
      ORDER BY a.date`).all(),
    // 已建立但尚未簽核定稿
    drafts: db.prepare(`SELECT r.id, r.test_date, r.client_id, c.name AS client_name, c.code AS client_code,
        u.name AS counselor_name,
        CAST(julianday('now','localtime') - julianday(r.test_date) AS INTEGER) AS days_ago
      FROM assessment_reports r JOIN clients c ON c.id = r.client_id
      LEFT JOIN users u ON u.id = r.counselor_id
      WHERE r.locked = 0 ${mineR} ORDER BY r.test_date`).all()
  });
});

router.get('/reports/:id', requireStaff('notes'), (req, res) => {
  const r = db.prepare(`SELECT r.*, u.name AS counselor_name, u.license_type, u.license_no,
      c.name AS client_name, c.code AS client_code, c.birth_date, c.gender,
      c.counselor_id AS client_counselor_id
    FROM assessment_reports r LEFT JOIN users u ON u.id = r.counselor_id
    LEFT JOIN clients c ON c.id = r.client_id WHERE r.id = ?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此報告' });
  // canViewNote 判斷的是撰寫者；報告改以個案主責關係判斷，與晤談紀錄一致
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(r.client_id);
  if (!require('../auth').canViewClientNotes(req.user, client)) {
    return res.status(403).json({ error: '衡鑑報告僅限主責心理師、督導與管理者存取' });
  }
  audit('staff', req.user.id, req.user.name, '調閱衡鑑報告', r.client_code, { report_id: r.id });
  res.json({ ...r, scores: JSON.parse(r.scores || '[]') });
});

router.post('/reports', requireStaff('notes'), requireNoteAccess, (req, res) => {
  const b = req.body || {};
  if (req.user.role === 'staff') return res.status(403).json({ error: '僅心理師可撰寫衡鑑報告' });
  const info = db.prepare(`INSERT INTO assessment_reports
    (client_id, counselor_id, test_date, report_date, purpose, referral_source, instruments,
     background, observation, results, scores, impression, recommendation, validity)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.client.id, req.user.id, b.test_date || today(), b.report_date || today(),
    b.purpose || '', b.referral_source || '', b.instruments || '',
    b.background || '', b.observation || '', b.results || '', reportScores(b.scores),
    b.impression || '', b.recommendation || '', b.validity || 'valid');
  audit('staff', req.user.id, req.user.name, '新增衡鑑報告', req.client.code, { report_id: info.lastInsertRowid });
  res.json({ id: info.lastInsertRowid });
});

router.put('/reports/:id', requireStaff('notes'), (req, res) => {
  const r = db.prepare('SELECT * FROM assessment_reports WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此報告' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(r.client_id);
  if (!require('../auth').canViewClientNotes(req.user, client)) return res.status(403).json({ error: '無權限修改此報告' });
  if (r.locked) return res.status(400).json({ error: '報告已簽核定稿，不可修改；如需更正請另立新報告' });
  if (r.counselor_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '僅撰寫者本人可修改報告' });
  }
  const data = {};
  for (const f of REPORT_FIELDS) if (req.body[f] !== undefined) data[f] = req.body[f];
  if (req.body.scores !== undefined) data.scores = reportScores(req.body.scores);
  if (!Object.keys(data).length) return res.json({ ok: true });
  db.prepare(`UPDATE assessment_reports SET ${Object.keys(data).map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(data), r.id);
  audit('staff', req.user.id, req.user.name, '修改衡鑑報告', String(r.client_id), { report_id: r.id });
  res.json({ ok: true });
});

router.post('/reports/:id/sign', requireStaff('notes'), (req, res) => {
  const r = db.prepare('SELECT * FROM assessment_reports WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此報告' });
  if (r.counselor_id !== req.user.id) return res.status(403).json({ error: '僅撰寫者本人可簽核' });
  if (r.locked) return res.status(400).json({ error: '此報告已簽核' });
  db.prepare('UPDATE assessment_reports SET locked = 1, signed_at = ? WHERE id = ?').run(nowStamp(), r.id);
  audit('staff', req.user.id, req.user.name, '簽核衡鑑報告', String(r.client_id), { report_id: r.id });
  res.json({ ok: true });
});

router.delete('/reports/:id', requireStaff('notes'), (req, res) => {
  const r = db.prepare('SELECT * FROM assessment_reports WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此報告' });
  if (r.locked) return res.status(400).json({ error: '已簽核的報告不可刪除' });
  if (r.counselor_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '僅撰寫者本人或管理者可刪除' });
  }
  db.prepare('DELETE FROM assessment_reports WHERE id = ?').run(r.id);
  audit('staff', req.user.id, req.user.name, '刪除衡鑑報告', String(r.client_id), { report_id: r.id });
  res.json({ ok: true });
});

// ---- 處遇計畫 ----

router.get('/clients/:clientId/plans', requireStaff('plans'), requireNoteAccess, (req, res) => {
  const plans = db.prepare(`SELECT p.*, u.name AS counselor_name FROM treatment_plans p
    LEFT JOIN users u ON u.id = p.counselor_id WHERE p.client_id = ? ORDER BY p.id DESC`).all(req.client.id);
  for (const p of plans) p.goals = db.prepare('SELECT * FROM plan_goals WHERE plan_id = ? ORDER BY sort, id').all(p.id);
  res.json(plans);
});

router.post('/plans', requireStaff('plans'), requireNoteAccess, (req, res) => {
  const b = req.body || {};
  const info = db.prepare(`INSERT INTO treatment_plans
    (client_id, counselor_id, start_date, review_date, approach, planned_sessions, summary)
    VALUES (?,?,?,?,?,?,?)`).run(
    req.client.id, Number(b.counselor_id) || req.user.id, b.start_date || today(),
    b.review_date || '', b.approach || '', Number(b.planned_sessions) || 0, b.summary || '');
  const planId = info.lastInsertRowid;
  (Array.isArray(b.goals) ? b.goals : []).forEach((g, i) => {
    if (!g.content) return;
    db.prepare('INSERT INTO plan_goals (plan_id, content, indicator, progress, sort) VALUES (?,?,?,?,?)')
      .run(planId, g.content, g.indicator || '', Number(g.progress) || 0, i);
  });
  audit('staff', req.user.id, req.user.name, '新增處遇計畫', req.client.code);
  res.json({ id: planId });
});

router.put('/plans/:id', requireStaff('plans'), (req, res) => {
  const p = db.prepare('SELECT * FROM treatment_plans WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此計畫' });
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
  if (!require('../auth').canViewClientNotes(req.user, c)) return res.status(403).json({ error: '無權限修改此計畫' });
  const b = req.body || {};
  db.prepare(`UPDATE treatment_plans SET start_date = ?, review_date = ?, approach = ?, planned_sessions = ?,
    summary = ?, status = ? WHERE id = ?`).run(
    b.start_date || p.start_date, b.review_date ?? p.review_date, b.approach ?? p.approach,
    Number(b.planned_sessions) || p.planned_sessions, b.summary ?? p.summary, b.status || p.status, p.id);
  if (Array.isArray(b.goals)) {
    db.prepare('DELETE FROM plan_goals WHERE plan_id = ?').run(p.id);
    b.goals.forEach((g, i) => {
      if (!g.content) return;
      db.prepare('INSERT INTO plan_goals (plan_id, content, indicator, progress, sort) VALUES (?,?,?,?,?)')
        .run(p.id, g.content, g.indicator || '', Number(g.progress) || 0, i);
    });
  }
  audit('staff', req.user.id, req.user.name, '修改處遇計畫', String(p.client_id));
  res.json({ ok: true });
});

// 待檢視的處遇計畫（檢視日已到）
// 刪除處遇計畫：連同目標一起刪；保密邊界同讀取（僅主責、督導、管理者）
router.delete('/plans/:id', requireStaff('plans'), (req, res) => {
  const p2 = db.prepare(`SELECT p.*, c.code AS client_code, c.counselor_id FROM treatment_plans p
    JOIN clients c ON c.id = p.client_id WHERE p.id = ?`).get(req.params.id);
  if (!p2) return res.status(404).json({ error: '找不到此計畫' });
  if (!canViewNote(req.user, { counselor_id: p2.counselor_id })) {
    return res.status(403).json({ error: '處遇計畫僅限主責心理師、督導與管理者存取' });
  }
  db.prepare('DELETE FROM plan_goals WHERE plan_id = ?').run(p2.id);
  db.prepare('DELETE FROM treatment_plans WHERE id = ?').run(p2.id);
  audit('staff', req.user.id, req.user.name, '刪除處遇計畫', p2.client_code, { plan_id: p2.id });
  res.json({ ok: true });
});

router.get('/plans/due', requireStaff('plans'), (req, res) => {
  const mine = req.user.role === 'counselor' ? 'AND p.counselor_id = ' + req.user.id : '';
  res.json(db.prepare(`SELECT p.*, c.name AS client_name, c.code AS client_code FROM treatment_plans p
    JOIN clients c ON c.id = p.client_id
    WHERE p.status = 'active' AND p.review_date != '' AND p.review_date <= date('now','localtime') ${mine}
    ORDER BY p.review_date`).all());
});

// ---- 督導紀錄 ----

router.get('/supervisions', requireStaff('supervision'), (req, res) => {
  const { counselor_id = '', from = '', to = '' } = req.query;
  const where = [], args = [];
  // 諮商師只看自己的督導紀錄；督導與管理者看全部
  if (req.user.role === 'counselor') { where.push('s.counselor_id = ?'); args.push(req.user.id); }
  else if (counselor_id) { where.push('s.counselor_id = ?'); args.push(Number(counselor_id)); }
  if (from) { where.push('s.date >= ?'); args.push(from); }
  if (to) { where.push('s.date <= ?'); args.push(to); }
  res.json(db.prepare(`SELECT s.*, u.name AS counselor_name, su.name AS supervisor_user_name, c.code AS client_code
    FROM supervisions s
    LEFT JOIN users u ON u.id = s.counselor_id
    LEFT JOIN users su ON su.id = s.supervisor_id
    LEFT JOIN clients c ON c.id = s.client_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.date DESC, s.id DESC`).all(...args));
});

router.post('/supervisions', requireStaff('supervision'), (req, res) => {
  const b = req.body || {};
  const counselorId = Number(b.counselor_id) || req.user.id;
  if (req.user.role === 'counselor' && counselorId !== req.user.id) {
    return res.status(403).json({ error: '僅能登錄自己的督導紀錄' });
  }
  const info = db.prepare(`INSERT INTO supervisions
    (counselor_id, supervisor_id, supervisor_name, date, hours, type, client_id, content, suggestion)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    counselorId, Number(b.supervisor_id) || null, b.supervisor_name || '',
    b.date || today(), Number(b.hours) || 1, b.type || 'individual',
    Number(b.client_id) || null, b.content || '', b.suggestion || '');
  audit('staff', req.user.id, req.user.name, '新增督導紀錄');
  res.json({ id: info.lastInsertRowid });
});

router.delete('/supervisions/:id', requireStaff('supervision'), (req, res) => {
  const s = db.prepare('SELECT * FROM supervisions WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此紀錄' });
  if (req.user.role !== 'admin' && s.counselor_id !== req.user.id) {
    return res.status(403).json({ error: '僅能刪除自己的督導紀錄' });
  }
  db.prepare('DELETE FROM supervisions WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

// 年度督導時數統計（心理師繼續教育／實習時數佐證）
router.get('/supervisions/hours', requireStaff('supervision'), (req, res) => {
  const year = req.query.year || String(new Date().getFullYear());
  res.json({
    year,
    required: Number(getSetting('supervision_required_hours', '20')),
    rows: db.prepare(`SELECT u.id, u.name, u.license_type,
        COALESCE(SUM(CASE WHEN s.type = 'individual' THEN s.hours END), 0) AS individual_hours,
        COALESCE(SUM(CASE WHEN s.type = 'group' THEN s.hours END), 0) AS group_hours,
        COALESCE(SUM(s.hours), 0) AS total_hours
      FROM users u LEFT JOIN supervisions s ON s.counselor_id = u.id AND substr(s.date,1,4) = ?
      WHERE u.active = 1 AND u.role IN ('counselor','supervisor')
      GROUP BY u.id ORDER BY u.id`).all(year)
  });
});

module.exports = router;
