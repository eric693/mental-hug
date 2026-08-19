const express = require('express');
const { db, audit, today, nowStamp, listSetting, getSetting } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

// 責任通報時限：兒少保護、家暴、性侵害等屬法定責任通報，知悉起算需於期限內完成通報。
// 建案時依事件類型帶出應完成時間，未通報且已逾時者在清單以紅字警示。
function isMandatory(type) {
  return listSetting('mandatory_report_types').includes(type);
}
function reportDueAt(type, dateStr, createdAt) {
  if (!isMandatory(type)) return '';
  const hours = Number(getSetting('report_deadline_hours', '24')) || 24;
  const base = createdAt || `${dateStr} ${nowStamp().slice(11)}`;
  const t = new Date(base.replace(' ', 'T'));
  if (isNaN(t)) return '';
  t.setHours(t.getHours() + hours);
  const p = n => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}
// 回傳給前端的通報狀態：none 無需通報／done 已通報／due 期限內未通報／overdue 逾時未通報
function withReportState(r) {
  // 舊資料沒有 report_due_at，改以事件類型與建檔時間即時推算，不必回填
  const due = r.report_due_at || reportDueAt(r.type, r.date, r.created_at);
  if (r.reported) return { ...r, report_due_at: due, report_state: 'done', minutes_left: null };
  if (!due) return { ...r, report_due_at: '', report_state: 'none', minutes_left: null };
  const left = Math.round((new Date(due.replace(' ', 'T')) - new Date()) / 60000);
  return { ...r, report_due_at: due, report_state: left < 0 ? 'overdue' : 'due', minutes_left: left };
}

// 危機事件：涉及法定通報，僅心理師／督導／管理者可存取（行政人員預設無 risk 模組權限）
router.get('/risk-events', requireStaff('risk'), (req, res) => {
  const { status = '', client_id = '', from = '', to = '' } = req.query;
  const where = [], args = [];
  if (status) { where.push('r.status = ?'); args.push(status); }
  if (client_id) { where.push('r.client_id = ?'); args.push(Number(client_id)); }
  if (from) { where.push('r.date >= ?'); args.push(from); }
  if (to) { where.push('r.date <= ?'); args.push(to); }
  res.json(db.prepare(`SELECT r.*, c.name AS client_name, c.code AS client_code, c.phone AS client_phone,
      c.emergency_name, c.emergency_phone, u.name AS handler_name, cu.name AS counselor_name
    FROM risk_events r JOIN clients c ON c.id = r.client_id
    LEFT JOIN users u ON u.id = r.handler_id
    LEFT JOIN users cu ON cu.id = c.counselor_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.status = 'closed', r.date DESC, r.id DESC`).all(...args)
    .map(withReportState)
    .filter(r => req.query.overdue !== '1' || r.report_state === 'overdue'));
});

router.post('/risk-events', requireStaff('risk'), (req, res) => {
  const b = req.body || {};
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(b.client_id) || 0);
  if (!c) return res.status(400).json({ error: '請選擇個案' });
  if (!b.type) return res.status(400).json({ error: '請選擇事件類型' });
  const due = reportDueAt(b.type, b.date || today(), nowStamp());
  const info = db.prepare(`INSERT INTO risk_events
    (client_id, date, type, severity, description, actions, reported, report_channel, report_at, report_no,
     handler_id, follow_up, report_due_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    c.id, b.date || today(), b.type, b.severity || 'medium', b.description || '', b.actions || '',
    b.reported ? 1 : 0, b.report_channel || '', b.reported ? (b.report_at || nowStamp()) : '',
    b.report_no || '', Number(b.handler_id) || req.user.id, b.follow_up || '', due);
  // 高風險事件同步標記個案風險等級
  db.prepare('UPDATE clients SET risk_level = ? WHERE id = ?')
    .run(b.severity === 'low' ? 'medium' : 'high', c.id);
  audit('staff', req.user.id, req.user.name, '新增危機事件', c.code, { type: b.type, reported: !!b.reported });
  res.json({ id: info.lastInsertRowid, report_due_at: due });
});

router.put('/risk-events/:id', requireStaff('risk'), (req, res) => {
  const r = db.prepare('SELECT * FROM risk_events WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此事件' });
  const b = { ...r, ...req.body };
  const reported = b.reported ? 1 : 0;
  // 類型改變時重算通報期限，仍以原始建案時間起算
  const due = b.type === r.type ? r.report_due_at : reportDueAt(b.type, b.date, r.created_at);
  db.prepare(`UPDATE risk_events SET date = ?, type = ?, severity = ?, description = ?, actions = ?,
    reported = ?, report_channel = ?, report_at = ?, report_no = ?, handler_id = ?, status = ?, follow_up = ?,
    report_due_at = ? WHERE id = ?`).run(
    b.date, b.type, b.severity, b.description || '', b.actions || '',
    reported, b.report_channel || '', reported ? (b.report_at || r.report_at || nowStamp()) : '',
    b.report_no || '', Number(b.handler_id) || null, b.status || 'open', b.follow_up || '', due, r.id);
  audit('staff', req.user.id, req.user.name, '更新危機事件', String(r.client_id), { id: r.id, status: b.status });
  res.json({ ok: true });
});

// 結案：需填寫後續追蹤結果，並回推個案風險等級
router.post('/risk-events/:id/close', requireStaff('risk'), (req, res) => {
  const r = db.prepare('SELECT * FROM risk_events WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此事件' });
  const { follow_up = '', risk_level = 'medium' } = req.body || {};
  if (!follow_up) return res.status(400).json({ error: '請填寫追蹤結果後再結案' });
  db.prepare("UPDATE risk_events SET status = 'closed', follow_up = ? WHERE id = ?").run(follow_up, r.id);
  const stillOpen = db.prepare("SELECT COUNT(*) n FROM risk_events WHERE client_id = ? AND status = 'open'").get(r.client_id).n;
  if (!stillOpen) db.prepare('UPDATE clients SET risk_level = ? WHERE id = ?').run(risk_level, r.client_id);
  audit('staff', req.user.id, req.user.name, '危機事件結案', String(r.client_id), { id: r.id });
  res.json({ ok: true });
});

// 責任通報表套印：欄位比照社政通報表的共同項目（通報人、被害人／當事人、事件概要、處置）。
// 各縣市表單格式略有不同，這裡輸出的是「內容齊備、可直接抄寫或附件」的版本，
// 並在頁尾註明實際通報仍須循主管機關指定管道（113、關懷e起來等）辦理。
router.get('/risk-events/:id/report-form', requireStaff('risk'), (req, res) => {
  const r = db.prepare(`SELECT r.*, c.name AS client_name, c.code AS client_code, c.id_no, c.gender,
      c.birth_date, c.phone AS client_phone, c.address, c.is_minor,
      c.guardian_name, c.guardian_relationship, c.guardian_phone,
      c.emergency_name, c.emergency_relationship, c.emergency_phone,
      u.name AS handler_name, u.license_type, u.license_no,
      cu.name AS counselor_name
    FROM risk_events r JOIN clients c ON c.id = r.client_id
    LEFT JOIN users u ON u.id = r.handler_id
    LEFT JOIN users cu ON cu.id = c.counselor_id
    WHERE r.id = ?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此事件' });
  audit('staff', req.user.id, req.user.name, '列印通報表', r.client_code, { risk_id: r.id });
  res.json({
    ...withReportState(r),
    mandatory: isMandatory(r.type),
    // 通報人資訊：實務上由知悉的專業人員具名，預設帶目前操作者
    reporter: {
      name: req.user.name, title: req.user.title || '',
      license_type: req.user.license_type || '', license_no: req.user.license_no || '',
      phone: req.user.phone || ''
    },
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address'),
    center_license_no: getSetting('center_license_no'),
    report_channels: listSetting('report_channels'),
    deadline_hours: Number(getSetting('report_deadline_hours', '24'))
  });
});

// 刪除危機事件：誤登才用；已完成通報的不刪（通報紀錄要留存），改用結案
router.delete('/risk-events/:id', requireStaff('risk'), (req, res) => {
  const e = db.prepare(`SELECT r.*, c.code AS client_code FROM risk_events r
    LEFT JOIN clients c ON c.id = r.client_id WHERE r.id = ?`).get(req.params.id);
  if (!e) return res.status(404).json({ error: '找不到此事件' });
  if (e.reported) return res.status(400).json({ error: '已完成通報的事件不可刪除；如已處理完畢請改用結案' });
  // risk_events 沒有建立者欄位，以處理人判斷；未指定處理人時僅管理者可刪
  if (req.user.role !== 'admin' && e.handler_id !== req.user.id) {
    return res.status(403).json({ error: '只有處理人或管理者可刪除此事件' });
  }
  db.prepare('DELETE FROM risk_events WHERE id = ?').run(e.id);
  audit('staff', req.user.id, req.user.name, '刪除危機事件', e.client_code || '', { type: e.type, date: e.date });
  res.json({ ok: true });
});

module.exports = router;
module.exports.withReportState = withReportState;
