const express = require('express');
const bcrypt = require('bcryptjs');
const { db, audit, today, addDays, getSetting, nowStamp } = require('../db');
const {
  CLIENT_COOKIE, signToken, setAuthCookie, clearAuthCookie, requireClient,
  loginLockedMinutes, loginFailed, loginSucceeded, rateLimit, clientIp
} = require('../auth');
const { SCALE_KEYS, score, publicScales } = require('../scales');
const { freeSlots, conflictOf } = require('./schedule');

const router = express.Router();
const loginRateLimit = rateLimit({ windowMs: 5 * 60 * 1000, max: 30, prefix: 'portal:' });

// 個案端只提供行政功能（預約、量表、費用、同意書），不提供任何晤談紀錄內容
router.post('/login', loginRateLimit, (req, res) => {
  const { phone = '', password = '' } = req.body || {};
  const lockKey = `client:${phone}`;
  const locked = loginLockedMinutes(lockKey);
  if (locked) return res.status(429).json({ error: `登入失敗次數過多，請 ${locked} 分鐘後再試` });
  const c = db.prepare('SELECT * FROM clients WHERE phone = ? AND active = 1 AND portal_enabled = 1').get(phone);
  if (!c || !c.password_hash || !bcrypt.compareSync(password, c.password_hash)) {
    loginFailed(lockKey);
    return res.status(401).json({ error: '手機號碼或密碼錯誤' });
  }
  loginSucceeded(lockKey);
  setAuthCookie(res, CLIENT_COOKIE, signToken({ t: 'client', id: c.id }));
  audit('client', c.id, c.name, '個案端登入');
  res.json({ ok: true, must_change_password: !!c.must_change_password });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res, CLIENT_COOKIE);
  res.json({ ok: true });
});

router.put('/password', requireClient, (req, res) => {
  const { old_password = '', new_password = '' } = req.body || {};
  if (!bcrypt.compareSync(old_password, req.client.password_hash)) return res.status(400).json({ error: '舊密碼不正確' });
  if (new_password.length < 6) return res.status(400).json({ error: '新密碼至少 6 碼' });
  db.prepare('UPDATE clients SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(new_password, 10), req.client.id);
  res.json({ ok: true });
});

router.get('/me', requireClient, (req, res) => {
  const c = req.client;
  const templates = db.prepare('SELECT * FROM consent_templates WHERE active = 1 ORDER BY sort, id').all()
    .filter(t => !t.minor_only || c.is_minor);
  const signed = db.prepare('SELECT key, version, agreed FROM consents WHERE client_id = ?').all(c.id);
  res.json({
    id: c.id, name: c.name, code: c.code, phone: c.phone,
    must_change_password: !!c.must_change_password,
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address'),
    portal_note: getSetting('ui_portal_note'),
    crisis_note: getSetting('ui_crisis_note'),
    booking_enabled: getSetting('portal_booking_enabled', '1') === '1',
    reschedule_enabled: getSetting('portal_reschedule_enabled', '1') === '1',
    cancel_hours: Number(getSetting('cancel_hours', '24')),
    no_show_fee_rate: Number(getSetting('no_show_fee_rate', '0.5')),
    counselor: c.counselor_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(c.counselor_id) : null,
    pending_consents: templates
      .filter(t => !signed.some(s => s.key === t.key && s.version === t.version))
      .map(t => ({ key: t.key, title: t.title })),
    pending_tasks: db.prepare('SELECT id, scale, due_date FROM assessment_tasks WHERE client_id = ? AND done_id IS NULL').all(c.id),
    unread: db.prepare("SELECT COUNT(*) n FROM messages WHERE client_id = ? AND sender = 'staff' AND read_at = ''").get(c.id).n
  });
});

// ---- 我的預約 ----
router.get('/appointments', requireClient, (req, res) => {
  const hours = Number(getSetting('cancel_hours', '24'));
  const rows = db.prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.type, a.mode, a.status, a.fee, a.note,
      a.meeting_url, a.counselor_id, a.reschedule_count, a.cancel_requested_at,
      u.name AS counselor_name, r.name AS room_name
    FROM appointments a LEFT JOIN users u ON u.id = a.counselor_id LEFT JOIN rooms r ON r.id = a.room_id
    WHERE a.client_id = ? ORDER BY a.date DESC, a.start_time DESC LIMIT 60`).all(req.client.id);
  // 由後端算出「還能不能自行改期／取消」，前端只負責顯示，規則不會兩邊各算一套
  res.json(rows.map(a => {
    const msLeft = new Date(`${a.date}T${a.start_time}:00`).getTime() - Date.now();
    return {
      ...a,
      can_self_serve: a.status === 'booked' && msLeft >= hours * 3600 * 1000 && !a.cancel_requested_at,
      // 已過的時間不再顯示「申請取消」，那是櫃檯要結案的狀態
      late: a.status === 'booked' && msLeft > 0 && msLeft < hours * 3600 * 1000
    };
  }));
});

// 可預約時段：僅開放主責心理師（未指定則全所心理師）
router.get('/slots', requireClient, (req, res) => {
  const date = req.query.date || today();
  const minDate = addDays(today(), Number(getSetting('portal_book_lead_days', '1')));
  const maxDate = addDays(today(), Number(getSetting('portal_book_max_days', '60')));
  if (date < minDate || date > maxDate) return res.json({ min_date: minDate, max_date: maxDate, counselors: [] });
  const counselors = req.client.counselor_id
    ? db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').all(req.client.counselor_id)
    : db.prepare("SELECT id, name FROM users WHERE active = 1 AND role IN ('counselor','supervisor') ORDER BY id").all();
  res.json({
    min_date: minDate, max_date: maxDate,
    counselors: counselors.map(u => ({ ...u, slots: freeSlots(u.id, date) }))
  });
});

// 個案自行送出預約（狀態為 booked，櫃檯可再調整；不可自行指定費用）
router.post('/appointments', requireClient, (req, res) => {
  if (getSetting('portal_booking_enabled', '1') !== '1') return res.status(403).json({ error: '目前未開放線上預約，請來電預約' });
  const { date = '', start_time = '', counselor_id, note = '' } = req.body || {};
  const minDate = addDays(today(), Number(getSetting('portal_book_lead_days', '1')));
  const maxDate = addDays(today(), Number(getSetting('portal_book_max_days', '60')));
  if (!date || date < minDate || date > maxDate) return res.status(400).json({ error: `可預約範圍為 ${minDate} 至 ${maxDate}` });
  const cid = Number(counselor_id) || req.client.counselor_id;
  if (!cid) return res.status(400).json({ error: '請選擇心理師' });
  if (req.client.counselor_id && cid !== req.client.counselor_id) {
    return res.status(400).json({ error: '如需更換心理師請來電洽詢' });
  }
  const slot = freeSlots(cid, date).find(s => s.start_time === start_time);
  if (!slot) return res.status(400).json({ error: '此時段已被預約或非開放時段，請重新選擇' });
  const type = db.prepare("SELECT 1 FROM appointments WHERE client_id = ? AND status = 'done'").get(req.client.id) ? 'individual' : 'intake';
  const fee = Number(getSetting(type === 'intake' ? 'intake_fee' : 'default_fee', '2000'));
  const info = db.prepare(`INSERT INTO appointments
    (client_id, counselor_id, date, start_time, end_time, type, status, fee, source, note)
    VALUES (?,?,?,?,?,?, 'booked', ?, 'portal', ?)`).run(
    req.client.id, cid, date, start_time, slot.end_time, type, fee, note);
  audit('client', req.client.id, req.client.name, '個案端預約', req.client.code, { date, start_time });
  res.json({ id: info.lastInsertRowid });
});

// 改期：與線上預約走同一套規則（開放時段、提前天數、不換心理師），
// 且必須在免收費取消期限之前；逾期者一律只能提出申請由櫃檯處理。
router.post('/appointments/:id/reschedule', requireClient, (req, res) => {
  if (getSetting('portal_reschedule_enabled', '1') !== '1') {
    return res.status(403).json({ error: '目前未開放線上改期，請來電洽詢' });
  }
  const a = db.prepare('SELECT * FROM appointments WHERE id = ? AND client_id = ?').get(req.params.id, req.client.id);
  if (!a) return res.status(404).json({ error: '找不到此預約' });
  if (a.status !== 'booked') return res.status(400).json({ error: '此預約無法自行改期，請來電洽詢' });
  const hours = Number(getSetting('cancel_hours', '24'));
  if (new Date(`${a.date}T${a.start_time}:00`).getTime() - Date.now() < hours * 3600 * 1000) {
    return res.status(400).json({ error: `距晤談時間已不足 ${hours} 小時，請直接來電改期` });
  }
  const { date = '', start_time = '' } = req.body || {};
  const minDate = addDays(today(), Number(getSetting('portal_book_lead_days', '1')));
  const maxDate = addDays(today(), Number(getSetting('portal_book_max_days', '60')));
  if (!date || date < minDate || date > maxDate) return res.status(400).json({ error: `可改期範圍為 ${minDate} 至 ${maxDate}` });
  const slot = freeSlots(a.counselor_id, date).find(s => s.start_time === start_time);
  if (!slot) return res.status(400).json({ error: '此時段已被預約或非開放時段，請重新選擇' });
  const original = `${a.date} ${a.start_time}`;
  // 可預約時段只看心理師，不看諮商室；若原本的諮商室在新時段已被別人用了，
  // 就把諮商室清空交由櫃檯重新安排（並在備註標明），避免兩組人被排到同一間。
  let roomId = a.room_id;
  let roomNote = '';
  if (roomId && conflictOf({
    id: a.id, date, start_time, end_time: slot.end_time, counselor_id: a.counselor_id, room_id: roomId
  })) {
    roomId = null;
    roomNote = '；改期後諮商室待重新安排';
  }
  db.prepare(`UPDATE appointments SET date = ?, start_time = ?, end_time = ?, reminded_at = '',
      room_id = ?, rescheduled_from = ?, reschedule_count = reschedule_count + 1,
      note = ? WHERE id = ?`).run(
    date, start_time, slot.end_time, roomId, original,
    (a.note ? a.note + '；' : '') + `個案自行改期（原 ${original}）` + roomNote, a.id);
  audit('client', req.client.id, req.client.name, '個案端改期', req.client.code, { from: original, to: `${date} ${start_time}` });
  res.json({ ok: true, date, start_time, end_time: slot.end_time });
});

// 取消：期限內直接取消；不足時數者留下取消申請與事由，並同步發一則訊息給櫃檯，
// 由櫃檯決定是否依未到比例計費（不讓個案端自行決定收費結果）
router.post('/appointments/:id/cancel', requireClient, (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ? AND client_id = ?').get(req.params.id, req.client.id);
  if (!a) return res.status(404).json({ error: '找不到此預約' });
  if (a.status !== 'booked') return res.status(400).json({ error: '此預約無法自行取消，請來電洽詢' });
  const reason = String((req.body && req.body.reason) || '').trim();
  const hours = Number(getSetting('cancel_hours', '24'));
  const start = new Date(`${a.date}T${a.start_time}:00`);
  if (start.getTime() < Date.now()) return res.status(400).json({ error: '此晤談時間已過，請來電與我們聯繫' });
  if (start.getTime() - Date.now() < hours * 3600 * 1000) {
    if (a.cancel_requested_at) return res.status(400).json({ error: '已收到您的取消申請，我們會盡快與您聯繫' });
    const rate = Number(getSetting('no_show_fee_rate', '0.5'));
    db.prepare('UPDATE appointments SET cancel_requested_at = ?, cancel_request_reason = ? WHERE id = ?')
      .run(nowStamp(), reason || '個案申請取消', a.id);
    db.prepare("INSERT INTO messages (client_id, sender, content) VALUES (?, 'client', ?)").run(
      req.client.id,
      `【取消申請】${a.date} ${a.start_time} 的晤談，事由：${reason || '未填寫'}（距晤談不足 ${hours} 小時）`);
    audit('client', req.client.id, req.client.name, '個案端申請取消', req.client.code, { date: a.date });
    return res.json({
      ok: true, pending: true,
      message: `距晤談時間已不足 ${hours} 小時，已為您送出取消申請並通知櫃檯；`
        + `依所內規定，逾期取消可能收取原費用之 ${Math.round(rate * 100)}%。`
    });
  }
  db.prepare("UPDATE appointments SET status = 'cancelled', cancel_reason = ? WHERE id = ?")
    .run(reason || '個案自行取消', a.id);
  audit('client', req.client.id, req.client.name, '個案端取消預約', req.client.code, { date: a.date });
  res.json({ ok: true, pending: false, message: '已取消預約' });
});

// ---- 量表填寫 ----
router.get('/scales', requireClient, (req, res) => res.json(publicScales()));

router.post('/assessments', requireClient, (req, res) => {
  const { scale = '', answers, task_id } = req.body || {};
  if (!SCALE_KEYS.includes(scale)) return res.status(400).json({ error: '未知的量表' });
  let s;
  try { s = score(scale, answers); } catch (e) { return res.status(400).json({ error: e.message }); }
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO assessments (client_id, scale, date, answers, total, severity, alert, filled_by)
      VALUES (?,?,?,?,?,?,?, 'client')`).run(
      req.client.id, scale, today(), JSON.stringify(answers), s.total, s.severity, s.alert);
    if (task_id) db.prepare('UPDATE assessment_tasks SET done_id = ? WHERE id = ? AND client_id = ?')
      .run(info.lastInsertRowid, Number(task_id), req.client.id);
    if (s.alert) db.prepare("UPDATE clients SET risk_level = 'high' WHERE id = ?").run(req.client.id);
    return info.lastInsertRowid;
  });
  const id = tx();
  audit('client', req.client.id, req.client.name, '個案端填寫量表', req.client.code, { scale, total: s.total });
  // 命中危險題時，回傳求助資訊由前端顯著提示
  res.json({
    id, total: s.total, severity: s.severity, alert: s.alert,
    crisis_note: s.alert ? getSetting('ui_crisis_note') : ''
  });
});

router.get('/assessments', requireClient, (req, res) => {
  res.json(db.prepare(`SELECT id, scale, date, total, severity FROM assessments
    WHERE client_id = ? ORDER BY date DESC`).all(req.client.id));
});

// ---- 同意書線上簽署 ----
router.get('/consents', requireClient, (req, res) => {
  const templates = db.prepare('SELECT * FROM consent_templates WHERE active = 1 ORDER BY sort, id').all()
    .filter(t => !t.minor_only || req.client.is_minor);
  const signed = db.prepare('SELECT key, version, agreed, signer_name, signed_at FROM consents WHERE client_id = ?').all(req.client.id);
  res.json(templates.map(t => ({
    key: t.key, title: t.title, body: t.body, version: t.version,
    required: t.required, allow_decline: t.allow_decline, minor_only: t.minor_only,
    signed: signed.find(s => s.key === t.key && s.version === t.version) || null
  })));
});

router.post('/consents', requireClient, (req, res) => {
  const { key = '', agreed = 1, signer_name = '', signature = '' } = req.body || {};
  const t = db.prepare('SELECT * FROM consent_templates WHERE key = ?').get(key);
  if (!t) return res.status(400).json({ error: '找不到此同意書' });
  if (!agreed && !t.allow_decline) return res.status(400).json({ error: '此同意書為必要項目' });
  if (!signer_name) return res.status(400).json({ error: '請填寫簽署人姓名' });
  if (!signature) return res.status(400).json({ error: '請完成簽名' });
  if (t.minor_only && !req.client.is_minor) return res.status(400).json({ error: '此同意書不適用' });
  const role = t.minor_only ? 'guardian' : 'client';
  db.prepare(`INSERT INTO consents (client_id, key, title, body, version, agreed, signer_name, signer_role, signature, signed_ip)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    req.client.id, t.key, t.title, t.body, t.version, agreed ? 1 : 0, signer_name, role, signature, clientIp(req));
  audit('client', req.client.id, req.client.name, '個案端簽署同意書', `${req.client.code}/${t.key}`);
  res.json({ ok: true });
});

// ---- 費用與方案 ----
router.get('/billing', requireClient, (req, res) => {
  res.json({
    invoices: db.prepare(`SELECT id, date, item, amount, status, method, receipt_no, payer
      FROM invoices WHERE client_id = ? AND status != 'void' ORDER BY date DESC, id DESC LIMIT 60`).all(req.client.id),
    packages: db.prepare(`SELECT name, sessions_total, sessions_used, (sessions_total - sessions_used) AS remaining,
      expire_date, status FROM packages WHERE client_id = ? ORDER BY id DESC`).all(req.client.id),
    unpaid: db.prepare("SELECT COALESCE(SUM(amount),0) n FROM invoices WHERE client_id = ? AND status = 'unpaid'").get(req.client.id).n
  });
});

// ---- 訊息與公告 ----
router.get('/messages', requireClient, (req, res) => {
  const rows = db.prepare(`SELECT m.id, m.sender, m.content, m.created_at, u.name AS staff_name
    FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.client_id = ? ORDER BY m.id`).all(req.client.id);
  db.prepare("UPDATE messages SET read_at = datetime('now','localtime') WHERE client_id = ? AND sender = 'staff' AND read_at = ''")
    .run(req.client.id);
  res.json(rows);
});
router.post('/messages', requireClient, (req, res) => {
  const content = String((req.body && req.body.content) || '').trim();
  if (!content) return res.status(400).json({ error: '請輸入內容' });
  if (content.length > 1000) return res.status(400).json({ error: '訊息過長' });
  const info = db.prepare("INSERT INTO messages (client_id, sender, content) VALUES (?, 'client', ?)").run(req.client.id, content);
  res.json({ id: info.lastInsertRowid });
});

router.get('/announcements', requireClient, (req, res) => {
  res.json(db.prepare(`SELECT id, title, content, publish_date FROM announcements
    WHERE audience IN ('all','client') AND publish_date <= date('now','localtime')
    ORDER BY pinned DESC, publish_date DESC LIMIT 20`).all());
});

module.exports = router;
