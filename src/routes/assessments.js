const express = require('express');
const { db, audit, today } = require('../db');
const { requireStaff } = require('../auth');
const { SCALE_KEYS, score, publicScales } = require('../scales');

const router = express.Router();

router.get('/scales', requireStaff(), (req, res) => res.json(publicScales()));

router.get('/assessments', requireStaff('assessments'), (req, res) => {
  const { client_id = '', scale = '', alert = '' } = req.query;
  const where = [], args = [];
  if (client_id) { where.push('a.client_id = ?'); args.push(Number(client_id)); }
  if (scale) { where.push('a.scale = ?'); args.push(scale); }
  if (alert) where.push('a.alert = 1');
  res.json(db.prepare(`SELECT a.*, c.name AS client_name, c.code AS client_code
    FROM assessments a JOIN clients c ON c.id = a.client_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.date DESC, a.id DESC LIMIT 300`).all(...args));
});

router.get('/assessments/:id', requireStaff('assessments'), (req, res) => {
  const a = db.prepare(`SELECT a.*, c.name AS client_name, c.code AS client_code
    FROM assessments a JOIN clients c ON c.id = a.client_id WHERE a.id = ?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此紀錄' });
  a.answers = JSON.parse(a.answers || '[]');
  res.json(a);
});

// 建立填答結果（櫃檯或心理師代填；個案自填走 portal.js）
router.post('/assessments', requireStaff('assessments'), (req, res) => {
  const { client_id, scale, answers, date, note = '' } = req.body || {};
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(client_id) || 0);
  if (!c) return res.status(400).json({ error: '請選擇個案' });
  if (!SCALE_KEYS.includes(scale)) return res.status(400).json({ error: '未知的量表' });
  let s;
  try { s = score(scale, answers); } catch (e) { return res.status(400).json({ error: e.message }); }
  const info = db.prepare(`INSERT INTO assessments (client_id, scale, date, answers, total, severity, alert, filled_by, note)
    VALUES (?,?,?,?,?,?,?, 'staff', ?)`).run(
    c.id, scale, date || today(), JSON.stringify(answers), s.total, s.severity, s.alert, note);
  // 命中危險題即拉高風險等級，交由危機模組追蹤
  if (s.alert) db.prepare("UPDATE clients SET risk_level = 'high' WHERE id = ?").run(c.id);
  audit('staff', req.user.id, req.user.name, '登錄量表結果', c.code, { scale, total: s.total });
  res.json({ id: info.lastInsertRowid, ...s });
});

// 編輯量表紀錄：只開放施測日期與備註。
// 分數與判讀由作答算出，改了會與作答對不上；答錯要重登請先刪除再登錄一次。
router.put('/assessments/:id', requireStaff('assessments'), (req, res) => {
  const a2 = db.prepare('SELECT * FROM assessments WHERE id = ?').get(req.params.id);
  if (!a2) return res.status(404).json({ error: '找不到此紀錄' });
  const b2 = req.body || {};
  const date = b2.date === undefined ? a2.date : String(b2.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期格式不正確' });
  db.prepare('UPDATE assessments SET date = ?, note = ? WHERE id = ?')
    .run(date, b2.note === undefined ? a2.note : String(b2.note), a2.id);
  audit('staff', req.user.id, req.user.name, '修改量表紀錄', String(a2.client_id), { scale: a2.scale, date });
  res.json({ ok: true });
});

router.delete('/assessments/:id', requireStaff('assessments'), (req, res) => {
  const a = db.prepare('SELECT * FROM assessments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此紀錄' });
  db.prepare('DELETE FROM assessments WHERE id = ?').run(a.id);
  audit('staff', req.user.id, req.user.name, '刪除量表結果', String(a.client_id), { scale: a.scale });
  res.json({ ok: true });
});

// 同一量表的分數趨勢（處遇成效佐證）
router.get('/clients/:id/assessment-trend', requireStaff('assessments'), (req, res) => {
  const rows = db.prepare('SELECT id, scale, date, total, severity, alert, filled_by, note FROM assessments WHERE client_id = ? ORDER BY date').all(req.params.id);
  const out = {};
  for (const r of rows) (out[r.scale] = out[r.scale] || []).push(r);
  res.json(out);
});

// ---- 指派量表給個案填寫 ----

router.get('/assessment-tasks', requireStaff('assessments'), (req, res) => {
  const { client_id = '', pending = '' } = req.query;
  const where = [], args = [];
  if (client_id) { where.push('t.client_id = ?'); args.push(Number(client_id)); }
  if (pending) where.push('t.done_id IS NULL');
  res.json(db.prepare(`SELECT t.*, c.name AS client_name, c.code AS client_code, u.name AS assigner_name
    FROM assessment_tasks t JOIN clients c ON c.id = t.client_id
    LEFT JOIN users u ON u.id = t.assigned_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.done_id IS NOT NULL, t.due_date, t.id DESC`).all(...args));
});

router.post('/assessment-tasks', requireStaff('assessments'), (req, res) => {
  const { client_id, scale, due_date = '' } = req.body || {};
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(client_id) || 0);
  if (!c) return res.status(400).json({ error: '請選擇個案' });
  if (!SCALE_KEYS.includes(scale)) return res.status(400).json({ error: '未知的量表' });
  if (db.prepare('SELECT 1 FROM assessment_tasks WHERE client_id = ? AND scale = ? AND done_id IS NULL').get(c.id, scale)) {
    return res.status(400).json({ error: '此個案已有相同量表的待填任務' });
  }
  const info = db.prepare('INSERT INTO assessment_tasks (client_id, scale, assigned_by, due_date) VALUES (?,?,?,?)')
    .run(c.id, scale, req.user.id, due_date);
  audit('staff', req.user.id, req.user.name, '指派量表', c.code, { scale });
  res.json({ id: info.lastInsertRowid });
});

router.delete('/assessment-tasks/:id', requireStaff('assessments'), (req, res) => {
  db.prepare('DELETE FROM assessment_tasks WHERE id = ? AND done_id IS NULL').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
