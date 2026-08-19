const express = require('express');
const { db, audit, today, nowStamp, getSetting } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

// 合作單位：學校認輔、企業 EAP、社會局委託、司法轉介。
// 這類案源的費用不向個案收，而是按月彙整向單位請款。
const FIELDS = ['name', 'type', 'contact', 'phone', 'email', 'address', 'tax_id', 'contract_no',
  'contract_start', 'contract_end', 'rate', 'quota_sessions', 'settle_note', 'note'];

router.get('/partners', requireStaff('partners'), (req, res) => {
  const rows = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM clients c WHERE c.partner_id = p.id AND c.active = 1) AS client_count,
      (SELECT COUNT(*) FROM appointments a JOIN clients c ON c.id = a.client_id
        WHERE c.partner_id = p.id AND a.status = 'done') AS used_sessions
    FROM partners p ORDER BY p.active DESC, p.id`).all();
  res.json(rows.map(p => ({
    ...p,
    remaining: p.quota_sessions ? p.quota_sessions - p.used_sessions : null,
    expiring: p.contract_end && p.contract_end <= require('../db').addDays(today(), 60)
  })));
});

router.post('/partners', requireStaff('partners'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫單位名稱' });
  const cols = FIELDS.filter(f => b[f] !== undefined);
  const info = db.prepare(`INSERT INTO partners (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(f => ['rate', 'quota_sessions'].includes(f) ? (Number(b[f]) || 0) : String(b[f] ?? '')));
  audit('staff', req.user.id, req.user.name, '新增合作單位', b.name);
  res.json({ id: info.lastInsertRowid });
});

router.put('/partners/:id', requireStaff('partners'), (req, res) => {
  const p = db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此單位' });
  const b = req.body || {};
  const data = {};
  for (const f of FIELDS) if (b[f] !== undefined) data[f] = ['rate', 'quota_sessions'].includes(f) ? (Number(b[f]) || 0) : String(b[f] ?? '');
  if (b.active !== undefined) data.active = b.active ? 1 : 0;
  if (!Object.keys(data).length) return res.json({ ok: true });
  db.prepare(`UPDATE partners SET ${Object.keys(data).map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(data), p.id);
  audit('staff', req.user.id, req.user.name, '修改合作單位', p.name);
  res.json({ ok: true });
});

// 刪除合作單位：還有個案或請款紀錄時只能停用，避免把歷史帳務的來源砍掉
router.delete('/partners/:id', requireStaff('partners'), (req, res) => {
  const p = db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此單位' });
  const clients = db.prepare('SELECT COUNT(*) n FROM clients WHERE partner_id = ?').get(p.id).n;
  const settlements = db.prepare('SELECT COUNT(*) n FROM settlements WHERE partner_id = ?').get(p.id).n;
  if (clients || settlements) {
    db.prepare('UPDATE partners SET active = 0 WHERE id = ?').run(p.id);
    audit('staff', req.user.id, req.user.name, '停用合作單位', p.name, { clients, settlements });
    return res.json({ ok: true, disabled: true, message: `此單位仍有 ${clients} 位個案、${settlements} 筆請款紀錄，已改為停用` });
  }
  db.prepare('DELETE FROM partners WHERE id = ?').run(p.id);
  audit('staff', req.user.id, req.user.name, '刪除合作單位', p.name);
  res.json({ ok: true, disabled: false });
});

// 單位明細：個案名單與請款紀錄
router.get('/partners/:id', requireStaff('partners'), (req, res) => {
  const p = db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此單位' });
  res.json({
    ...p,
    clients: db.prepare(`SELECT c.id, c.code, c.name, c.status, u.name AS counselor_name,
        (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id AND a.status = 'done') AS sessions
      FROM clients c LEFT JOIN users u ON u.id = c.counselor_id
      WHERE c.partner_id = ? AND c.active = 1 ORDER BY c.id DESC`).all(p.id),
    settlements: db.prepare('SELECT * FROM settlements WHERE partner_id = ? ORDER BY month DESC').all(p.id),
    groups: db.prepare('SELECT id, name, status, start_date FROM groups WHERE partner_id = ?').all(p.id)
  });
});

// 產生某月請款單：彙整該單位個案當月已完成的晤談，依議定價計費
router.post('/settlements', requireStaff('partners'), (req, res) => {
  const partnerId = Number(req.body && req.body.partner_id) || 0;
  const month = (req.body && req.body.month) || today().slice(0, 7);
  const p = db.prepare('SELECT * FROM partners WHERE id = ?').get(partnerId);
  if (!p) return res.status(400).json({ error: '請選擇合作單位' });
  if (db.prepare('SELECT 1 FROM settlements WHERE partner_id = ? AND month = ?').get(partnerId, month)) {
    return res.status(400).json({ error: '該月請款單已存在' });
  }
  const rows = db.prepare(`SELECT a.id, a.fee FROM appointments a JOIN clients c ON c.id = a.client_id
    WHERE c.partner_id = ? AND a.status = 'done' AND substr(a.date,1,7) = ?`).all(partnerId, month);
  if (!rows.length) return res.status(400).json({ error: '該月無可請款的晤談紀錄' });
  const rate = p.rate || 0;
  const amount = rate ? rows.length * rate : rows.reduce((s, r) => s + r.fee, 0);
  const info = db.prepare(`INSERT INTO settlements (partner_id, month, sessions, amount, created_by)
    VALUES (?,?,?,?,?)`).run(partnerId, month, rows.length, amount, req.user.id);
  audit('staff', req.user.id, req.user.name, '產生請款單', p.name, { month, sessions: rows.length, amount });
  res.json({ id: info.lastInsertRowid, sessions: rows.length, amount });
});

router.get('/settlements', requireStaff('partners'), (req, res) => {
  const { status = '', partner_id = '' } = req.query;
  const where = [], args = [];
  if (status) { where.push('s.status = ?'); args.push(status); }
  if (partner_id) { where.push('s.partner_id = ?'); args.push(Number(partner_id)); }
  res.json(db.prepare(`SELECT s.*, p.name AS partner_name, p.tax_id, p.contact
    FROM settlements s JOIN partners p ON p.id = s.partner_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.status = 'paid', s.month DESC`).all(...args));
});

// 請款單明細（可列印的對帳單：以個案編號列示，不列姓名）
router.get('/settlements/:id', requireStaff('partners'), (req, res) => {
  const s = db.prepare(`SELECT s.*, p.name AS partner_name, p.tax_id, p.contact, p.address, p.rate
    FROM settlements s JOIN partners p ON p.id = s.partner_id WHERE s.id = ?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此請款單' });
  const items = db.prepare(`SELECT a.date, a.start_time, a.type, a.fee, c.code AS client_code,
      u.name AS counselor_name
    FROM appointments a JOIN clients c ON c.id = a.client_id
    LEFT JOIN users u ON u.id = a.counselor_id
    WHERE c.partner_id = ? AND a.status = 'done' AND substr(a.date,1,7) = ?
    ORDER BY a.date, a.start_time`).all(s.partner_id, s.month);

  // 明細是即時查詢，總額卻是建立當下的快照。若期間有晤談補登或狀態異動，兩者會對不起來。
  // 這裡只回報差異、不自動改寫金額——請款單是對外文件，數字要由人決定何時更新。
  const current = { sessions: items.length, amount: s.rate ? items.length * s.rate : items.reduce((t, r) => t + r.fee, 0) };
  const mismatch = current.sessions !== s.sessions || current.amount !== s.amount ? current : null;
  res.json({
    ...s, items, mismatch,
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address'),
    center_license_no: getSetting('center_license_no'),
    center_director: getSetting('center_director'),
    center_tax_id: getSetting('center_tax_id')
  });
});

// 依目前晤談紀錄重新計算金額。已送出或入帳者不開放，避免對外文件被無聲改動。
router.post('/settlements/:id/recalculate', requireStaff('partners'), (req, res) => {
  const s = db.prepare('SELECT s.*, p.rate FROM settlements s JOIN partners p ON p.id = s.partner_id WHERE s.id = ?')
    .get(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此請款單' });
  if (s.status !== 'draft') return res.status(400).json({ error: '已送出或已入帳的請款單不可重新計算' });
  const rows = db.prepare(`SELECT a.fee FROM appointments a JOIN clients c ON c.id = a.client_id
    WHERE c.partner_id = ? AND a.status = 'done' AND substr(a.date,1,7) = ?`).all(s.partner_id, s.month);
  const amount = s.rate ? rows.length * s.rate : rows.reduce((t, r) => t + r.fee, 0);
  db.prepare('UPDATE settlements SET sessions = ?, amount = ? WHERE id = ?').run(rows.length, amount, s.id);
  audit('staff', req.user.id, req.user.name, '重算請款單', String(s.id),
    { before: { sessions: s.sessions, amount: s.amount }, after: { sessions: rows.length, amount } });
  res.json({ ok: true, sessions: rows.length, amount });
});

router.post('/settlements/:id/status', requireStaff('partners'), (req, res) => {
  const s = db.prepare('SELECT * FROM settlements WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此請款單' });
  const { status, invoice_no = s.invoice_no, note = s.note } = req.body || {};
  if (!['draft', 'sent', 'paid'].includes(status)) return res.status(400).json({ error: '狀態不正確' });
  db.prepare(`UPDATE settlements SET status = ?, invoice_no = ?, note = ?,
    sent_at = CASE WHEN ? IN ('sent','paid') AND sent_at = '' THEN ? ELSE sent_at END,
    paid_at = CASE WHEN ? = 'paid' THEN ? ELSE paid_at END WHERE id = ?`)
    .run(status, invoice_no, note, status, nowStamp(), status, nowStamp(), s.id);
  audit('staff', req.user.id, req.user.name, '請款單狀態異動', String(s.id), { status });
  res.json({ ok: true });
});

router.delete('/settlements/:id', requireStaff('partners'), (req, res) => {
  const s = db.prepare('SELECT * FROM settlements WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此請款單' });
  if (s.status === 'paid') return res.status(400).json({ error: '已入帳的請款單不可刪除' });
  db.prepare('DELETE FROM settlements WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

module.exports = router;
