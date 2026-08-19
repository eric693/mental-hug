const express = require('express');
const { db, audit, today, getSetting } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

// 團體諮商：團體本身 + 成員名單 + 每次聚會（含出席與歷程紀錄）。
// 團體聚會不放進 appointments（那是一對一模型），但週檢視會一併顯示、諮商室也會檢查衝突。

const FIELDS = ['name', 'counselor_id', 'co_counselor_id', 'partner_id', 'capacity', 'sessions_total',
  'fee_per_session', 'start_date', 'end_date', 'status', 'description'];

router.get('/groups', requireStaff('groups'), (req, res) => {
  const { status = '' } = req.query;
  res.json(db.prepare(`SELECT g.*, u.name AS counselor_name, u2.name AS co_counselor_name, p.name AS partner_name,
      (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'active') AS member_count,
      (SELECT COUNT(*) FROM group_sessions s WHERE s.group_id = g.id AND s.status = 'done') AS done_sessions
    FROM groups g LEFT JOIN users u ON u.id = g.counselor_id
    LEFT JOIN users u2 ON u2.id = g.co_counselor_id
    LEFT JOIN partners p ON p.id = g.partner_id
    ${status ? 'WHERE g.status = ?' : ''} ORDER BY g.status = 'done', g.id DESC`)
    .all(...(status ? [status] : [])));
});

router.get('/groups/:id', requireStaff('groups'), (req, res) => {
  const g = db.prepare(`SELECT g.*, u.name AS counselor_name, u2.name AS co_counselor_name, p.name AS partner_name
    FROM groups g LEFT JOIN users u ON u.id = g.counselor_id
    LEFT JOIN users u2 ON u2.id = g.co_counselor_id
    LEFT JOIN partners p ON p.id = g.partner_id WHERE g.id = ?`).get(req.params.id);
  if (!g) return res.status(404).json({ error: '找不到此團體' });
  const canNote = ['admin', 'supervisor'].includes(req.user.role)
    || (req.user.role === 'counselor' && [g.counselor_id, g.co_counselor_id].includes(req.user.id));
  const sessions = db.prepare(`SELECT s.*, r.name AS room_name,
      (SELECT COUNT(*) FROM group_attendance a WHERE a.session_id = s.id AND a.attended = 1) AS present
    FROM group_sessions s LEFT JOIN rooms r ON r.id = s.room_id
    WHERE s.group_id = ? ORDER BY s.session_no, s.date`).all(g.id);
  // 團體歷程紀錄比照晤談紀錄保密，非帶領者不回傳內容
  if (!canNote) for (const s of sessions) s.process_note = '';
  res.json({
    ...g,
    can_view_note: canNote,
    members: db.prepare(`SELECT m.*, c.name AS client_name, c.code AS client_code, c.risk_level
      FROM group_members m JOIN clients c ON c.id = m.client_id
      WHERE m.group_id = ? ORDER BY m.status, m.id`).all(g.id),
    sessions
  });
});

router.post('/groups', requireStaff('groups'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '請填寫團體名稱' });
  if (!b.counselor_id) return res.status(400).json({ error: '請選擇帶領者' });
  const cols = FIELDS.filter(f => b[f] !== undefined);
  const info = db.prepare(`INSERT INTO groups (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(f => ['counselor_id', 'co_counselor_id', 'partner_id'].includes(f) ? (Number(b[f]) || null)
      : ['capacity', 'sessions_total', 'fee_per_session'].includes(f) ? (Number(b[f]) || 0) : String(b[f] ?? '')));
  audit('staff', req.user.id, req.user.name, '新增團體', b.name);
  res.json({ id: info.lastInsertRowid });
});

router.put('/groups/:id', requireStaff('groups'), (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: '找不到此團體' });
  const b = req.body || {};
  const data = {};
  for (const f of FIELDS) {
    if (b[f] === undefined) continue;
    data[f] = ['counselor_id', 'co_counselor_id', 'partner_id'].includes(f) ? (Number(b[f]) || null)
      : ['capacity', 'sessions_total', 'fee_per_session'].includes(f) ? (Number(b[f]) || 0) : String(b[f] ?? '');
  }
  if (!Object.keys(data).length) return res.json({ ok: true });
  db.prepare(`UPDATE groups SET ${Object.keys(data).map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(data), g.id);
  res.json({ ok: true });
});

// 刪除團體：已有完成場次者不可刪（屬服務紀錄），請改將狀態設為結束
router.delete('/groups/:id', requireStaff('groups'), (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: '找不到此團體' });
  const done = db.prepare("SELECT COUNT(*) n FROM group_sessions WHERE group_id = ? AND status = 'done'").get(g.id).n;
  if (done) return res.status(400).json({ error: `此團體已有 ${done} 場完成紀錄，不可刪除；請將狀態改為「已結束」` });
  db.transaction(() => {
    db.prepare('DELETE FROM group_attendance WHERE session_id IN (SELECT id FROM group_sessions WHERE group_id = ?)').run(g.id);
    db.prepare('DELETE FROM group_sessions WHERE group_id = ?').run(g.id);
    db.prepare('DELETE FROM group_members WHERE group_id = ?').run(g.id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
  })();
  audit('staff', req.user.id, req.user.name, '刪除團體', g.name);
  res.json({ ok: true });
});

// ---- 成員 ----
router.post('/groups/:id/members', requireStaff('groups'), (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: '找不到此團體' });
  const clientId = Number(req.body && req.body.client_id) || 0;
  if (!db.prepare('SELECT 1 FROM clients WHERE id = ? AND active = 1').get(clientId)) {
    return res.status(400).json({ error: '請選擇個案' });
  }
  const n = db.prepare("SELECT COUNT(*) n FROM group_members WHERE group_id = ? AND status = 'active'").get(g.id).n;
  if (g.capacity && n >= g.capacity) return res.status(400).json({ error: `團體人數已達上限 ${g.capacity} 人` });
  try {
    db.prepare('INSERT INTO group_members (group_id, client_id) VALUES (?,?)').run(g.id, clientId);
  } catch { return res.status(400).json({ error: '此個案已在名單中' }); }
  res.json({ ok: true });
});

// 移除團體成員：已有出席紀錄者不硬刪（會影響出席率與計費），改標為退出
router.delete('/group-members/:id', requireStaff('groups'), (req, res) => {
  const m = db.prepare('SELECT * FROM group_members WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '找不到此成員' });
  const att = db.prepare(`SELECT COUNT(*) n FROM group_attendance ga
    JOIN group_sessions gs ON gs.id = ga.session_id
    WHERE ga.client_id = ? AND gs.group_id = ?`).get(m.client_id, m.group_id).n;
  if (att) {
    db.prepare("UPDATE group_members SET status = 'dropped' WHERE id = ?").run(m.id);
    audit('staff', req.user.id, req.user.name, '團體成員標為退出', String(m.group_id), { attendance: att });
    return res.json({ ok: true, dropped: true, message: `此成員已有 ${att} 筆出席紀錄，改標為退出` });
  }
  db.prepare('DELETE FROM group_members WHERE id = ?').run(m.id);
  audit('staff', req.user.id, req.user.name, '移除團體成員', String(m.group_id));
  res.json({ ok: true, dropped: false });
});

router.put('/group-members/:id', requireStaff('groups'), (req, res) => {
  const m = db.prepare('SELECT * FROM group_members WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '找不到此成員' });
  db.prepare('UPDATE group_members SET status = ?, note = ? WHERE id = ?')
    .run((req.body && req.body.status) || m.status, (req.body && req.body.note) || m.note, m.id);
  res.json({ ok: true });
});

// ---- 聚會場次 ----
router.post('/groups/:id/sessions', requireStaff('groups'), (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: '找不到此團體' });
  const b = req.body || {};
  if (!b.date || !b.start_time || !b.end_time) return res.status(400).json({ error: '請填寫日期與起訖時間' });
  // 諮商室衝突：同時檢查一對一預約與其他團體
  if (b.room_id) {
    const hit = db.prepare(`SELECT 1 FROM appointments WHERE room_id = ? AND date = ?
        AND status IN ('booked','arrived') AND start_time < ? AND end_time > ?`)
      .get(Number(b.room_id), b.date, b.end_time, b.start_time)
      || db.prepare(`SELECT 1 FROM group_sessions WHERE room_id = ? AND date = ?
        AND status != 'cancelled' AND start_time < ? AND end_time > ?`)
        .get(Number(b.room_id), b.date, b.end_time, b.start_time);
    if (hit) return res.status(400).json({ error: '該時段諮商室已被使用' });
  }
  const last = db.prepare('SELECT MAX(session_no) n FROM group_sessions WHERE group_id = ?').get(g.id).n || 0;
  const info = db.prepare(`INSERT INTO group_sessions (group_id, session_no, date, start_time, end_time, room_id, topic)
    VALUES (?,?,?,?,?,?,?)`).run(g.id, Number(b.session_no) || last + 1, b.date, b.start_time, b.end_time,
    Number(b.room_id) || null, b.topic || '');
  if (g.status === 'open') db.prepare("UPDATE groups SET status = 'running' WHERE id = ?").run(g.id);
  res.json({ id: info.lastInsertRowid });
});

// 點名 + 歷程紀錄；完成時依團體收費為出席者產生收費單
router.post('/group-sessions/:id/complete', requireStaff('groups'), (req, res) => {
  const s = db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此場次' });
  const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(s.group_id);
  const canNote = ['admin', 'supervisor'].includes(req.user.role)
    || (req.user.role === 'counselor' && [g.counselor_id, g.co_counselor_id].includes(req.user.id));
  if (!canNote) return res.status(403).json({ error: '僅團體帶領者、督導與管理者可撰寫歷程紀錄' });
  const b = req.body || {};
  const attendance = Array.isArray(b.attendance) ? b.attendance : [];
  const tx = db.transaction(() => {
    db.prepare("UPDATE group_sessions SET topic = ?, process_note = ?, status = 'done' WHERE id = ?")
      .run(b.topic || s.topic, b.process_note || s.process_note, s.id);
    for (const a of attendance) {
      db.prepare(`INSERT INTO group_attendance (session_id, client_id, attended, note) VALUES (?,?,?,?)
        ON CONFLICT(session_id, client_id) DO UPDATE SET attended = excluded.attended, note = excluded.note`)
        .run(s.id, Number(a.client_id), a.attended ? 1 : 0, a.note || '');
      // 出席者計費（合作單位付費的個案不另開個人收費單）。
      // 點名可以重複送出（補點名、改記錄），故先確認此場次此人尚未開單才建立；
      // 若改判為缺席，未收款的該筆收費單一併移除。
      const existing = db.prepare(`SELECT * FROM invoices
        WHERE group_session_id = ? AND client_id = ? AND status != 'void'`).get(s.id, Number(a.client_id));
      if (a.attended && g.fee_per_session > 0) {
        const c = db.prepare('SELECT partner_id FROM clients WHERE id = ?').get(Number(a.client_id));
        if (c && !c.partner_id && !existing) {
          db.prepare(`INSERT INTO invoices (client_id, date, item, amount, status, payer, group_session_id)
            VALUES (?,?,?,?, 'unpaid', ?, ?)`).run(Number(a.client_id), s.date,
            `${g.name} 第 ${s.session_no} 次`, g.fee_per_session, getSetting('payer_type_default', '自費'), s.id);
        }
      } else if (!a.attended && existing && existing.status === 'unpaid') {
        db.prepare('DELETE FROM invoices WHERE id = ?').run(existing.id);
      }
    }
    const done = db.prepare("SELECT COUNT(*) n FROM group_sessions WHERE group_id = ? AND status = 'done'").get(g.id).n;
    if (g.sessions_total && done >= g.sessions_total) db.prepare("UPDATE groups SET status = 'done' WHERE id = ?").run(g.id);
  });
  tx();
  audit('staff', req.user.id, req.user.name, '完成團體場次', g.name, { session_no: s.session_no });
  res.json({ ok: true });
});

router.get('/group-sessions/:id', requireStaff('groups'), (req, res) => {
  const s = db.prepare(`SELECT s.*, g.name AS group_name, g.counselor_id, g.co_counselor_id
    FROM group_sessions s JOIN groups g ON g.id = s.group_id WHERE s.id = ?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此場次' });
  const canNote = ['admin', 'supervisor'].includes(req.user.role)
    || (req.user.role === 'counselor' && [s.counselor_id, s.co_counselor_id].includes(req.user.id));
  if (!canNote) s.process_note = '';
  res.json({
    ...s, can_view_note: canNote,
    attendance: db.prepare(`SELECT m.client_id, c.name AS client_name, c.code AS client_code,
        COALESCE(a.attended, 1) AS attended, COALESCE(a.note,'') AS note
      FROM group_members m JOIN clients c ON c.id = m.client_id
      LEFT JOIN group_attendance a ON a.session_id = ? AND a.client_id = m.client_id
      WHERE m.group_id = ? AND m.status = 'active' ORDER BY m.id`).all(s.id, s.group_id)
  });
});

router.delete('/group-sessions/:id', requireStaff('groups'), (req, res) => {
  const s = db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此場次' });
  if (s.status === 'done') return res.status(400).json({ error: '已完成的場次不可刪除' });
  db.prepare('DELETE FROM group_sessions WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

module.exports = router;
