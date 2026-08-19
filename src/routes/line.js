const express = require('express');
const { db, audit, today, getSetting, nowStamp } = require('../db');
const { requireStaff } = require('../auth');
const line = require('../line');
const { conflictOf, endTime } = require('./schedule');

const router = express.Router();

// ---- 共用 ----

function requestRow(id) {
  return db.prepare(`SELECT r.*, c.name AS client_name, c.code AS client_code, c.phone AS client_phone,
      c.line_user_id, u.name AS counselor_name, u.line_group_id,
      a.date, a.start_time, a.end_time, a.status AS appt_status, a.type AS appt_type, a.room_id
    FROM reschedule_requests r
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN users u ON u.id = r.counselor_id
    LEFT JOIN appointments a ON a.id = r.appointment_id
    WHERE r.id = ?`).get(id);
}

// 範本共用欄位
function varsOf(r, extra = {}) {
  return {
    req: r.id,
    client: r.client_name || '',
    code: r.client_code || '',
    counselor: r.counselor_name || '',
    date: r.date || '',
    weekday: r.date ? line.weekdayName(r.date) : '',
    time: r.date ? `${r.start_time}-${r.end_time}` : '',
    text: r.raw_text || '',
    center: getSetting('center_name'),
    phone: getSetting('center_phone'),
    new_date: r.new_date || '',
    new_weekday: r.new_date ? line.weekdayName(r.new_date) : '',
    new_time: r.new_start_time ? `${r.new_start_time}-${r.new_end_time}` : '',
    ...extra
  };
}

// 轉達給心理師群組；沒有群組（或憑證未設）時只留紀錄，狀態仍推進到「待心理師回覆」，
// 讓行政人員可以自行用電話問完再代錄回覆，流程不會卡住。
async function relayToGroup(r) {
  const gid = line.groupIdFor(r.counselor_id);
  const text = line.fill(getSetting('line_relay_template'), varsOf(r));
  // 先推進狀態再送訊息：LINE 送不出去時（沒設群組、對方 API 慢或掛掉）
  // 申請仍會出現在「待心理師回覆」，行政人員可以自己打電話問完再代錄，流程不會卡在「待轉達」。
  db.prepare("UPDATE reschedule_requests SET status = 'relayed', relayed_at = ? WHERE id = ? AND status = 'new'")
    .run(nowStamp(), r.id);
  return line.send({
    to: gid, text,
    meta: { source_type: 'group', client_id: r.client_id, counselor_id: r.counselor_id, request_id: r.id }
  });
}

// ---- Webhook（LINE 平台呼叫，免登入，以簽章驗證）----
// 掛在 /line/webhook；未設定憑證時一律 403，不做任何處理。
router.post('/line/webhook', async (req, res) => {
  if (!line.enabled()) return res.status(403).json({ error: 'LINE 通道未啟用' });
  if (!line.verifySignature(req.rawBody, req.get('X-Line-Signature'))) {
    return res.status(401).json({ error: 'signature 驗證失敗' });
  }
  // LINE 要求 webhook 盡快回 200，處理過程中的錯誤不回丟給平台（否則會被停用 webhook）
  res.json({ ok: true });
  for (const ev of (req.body && req.body.events) || []) {
    try { await handleEvent(ev); } catch (e) { console.error('line webhook', e); }
  }
});

async function handleEvent(ev) {
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  const text = String(ev.message.text || '').trim().slice(0, 1000);
  const src = ev.source || {};
  if (src.type === 'group' || src.type === 'room') return handleGroupMessage(src.groupId || src.roomId, text, ev.replyToken);
  if (src.type === 'user') return handleUserMessage(src.userId, text, ev.replyToken);
}

// ---- 個案端（官方帳號一對一）----
async function handleUserMessage(userId, text, replyToken) {
  const client = db.prepare('SELECT * FROM clients WHERE line_user_id = ? AND active = 1').get(userId);
  line.logEvent({
    direction: 'in', source_type: 'user', source_id: userId, text,
    client_id: client ? client.id : null
  });

  if (!client) {
    // 綁定：個案輸入「綁定 0912345678」，比對留存的手機號碼
    const m = text.match(/綁定\s*([0-9\-+ ]{8,20})/);
    if (m) {
      const phone = m[1].replace(/[^0-9]/g, '');
      const hit = db.prepare(`SELECT * FROM clients WHERE active = 1
        AND REPLACE(REPLACE(phone,'-',''),' ','') = ?`).get(phone);
      if (!hit) {
        return line.send({ kind: 'reply', replyToken, to: userId, text: '查不到這個手機號碼的資料，請確認號碼是否與登記時相同，或直接來電諮商所。', meta: { source_type: 'user' } });
      }
      if (hit.line_user_id && hit.line_user_id !== userId) {
        return line.send({ kind: 'reply', replyToken, to: userId, text: '此號碼已綁定其他 LINE 帳號，請來電諮商所協助處理。', meta: { source_type: 'user', client_id: hit.id } });
      }
      db.prepare('UPDATE clients SET line_user_id = ? WHERE id = ?').run(userId, hit.id);
      audit('system', null, 'LINE', '個案綁定 LINE', String(hit.id));
      return line.send({
        kind: 'reply', replyToken, to: userId,
        text: `${hit.name} 您好，已完成綁定。日後如需請假或改期，直接在此傳訊息告訴我們即可。`,
        meta: { source_type: 'user', client_id: hit.id }
      });
    }
    return line.send({
      kind: 'reply', replyToken, to: userId,
      text: line.fill(getSetting('line_bind_hint'), { center: getSetting('center_name'), phone: getSetting('center_phone') }),
      meta: { source_type: 'user' }
    });
  }

  // 最近一筆未來的有效預約：改期／請假都以它為對象
  const appt = db.prepare(`SELECT * FROM appointments WHERE client_id = ? AND status IN ('booked','arrived')
      AND (date > ? OR (date = ? AND end_time >= ?))
    ORDER BY date, start_time LIMIT 1`).get(client.id, today(), today(), new Date().toTimeString().slice(0, 5));

  const isReschedule = line.looksLikeReschedule(text);
  if (!isReschedule) {
    // 非請假／改期的訊息一律進「個案訊息」讓櫃檯回覆，不打擾心理師群組
    db.prepare("INSERT INTO messages (client_id, sender, content) VALUES (?, 'client', ?)").run(client.id, text);
    return line.send({
      kind: 'reply', replyToken, to: userId,
      text: line.fill(getSetting('line_ack_client'), { phone: getSetting('center_phone') }),
      meta: { source_type: 'user', client_id: client.id }
    });
  }

  const kind = /取消|不來|不能來/.test(text) && !/改期|換時間|調整/.test(text) ? 'cancel' : 'reschedule';
  const info = db.prepare(`INSERT INTO reschedule_requests
      (appointment_id, client_id, counselor_id, kind, source, raw_text)
    VALUES (?,?,?,?, 'line', ?)`)
    .run(appt ? appt.id : null, client.id, (appt && appt.counselor_id) || client.counselor_id || null, kind, text);
  const r = requestRow(info.lastInsertRowid);
  audit('system', null, 'LINE', '收到改期／請假申請', String(r.id), { client_id: client.id });

  // 先轉達心理師群組（這步會把申請推進到「待心理師回覆」），再回覆個案已收到
  await relayToGroup(r);
  await line.send({
    kind: 'reply', replyToken, to: userId,
    text: line.fill(getSetting('line_ack_client'), { phone: getSetting('center_phone') }),
    meta: { source_type: 'user', client_id: client.id, request_id: r.id }
  });
}

// ---- 心理師群組 ----
// 群組回覆會對應到「該群組最近一筆待回覆的申請」；同時有多筆時可在訊息開頭寫 #編號 指定。
async function handleGroupMessage(groupId, text, replyToken) {
  const counselor = db.prepare('SELECT * FROM users WHERE line_group_id = ? AND active = 1').get(groupId);
  line.logEvent({
    direction: 'in', source_type: 'group', source_id: groupId, text,
    counselor_id: counselor ? counselor.id : null
  });

  const m = text.match(/#(\d+)/);
  let r = m ? requestRow(Number(m[1])) : null;
  if (r && counselor && r.counselor_id && r.counselor_id !== counselor.id) r = null;   // 不是這個群組的案子
  if (!r) {
    const cond = counselor ? 'r.counselor_id = ?' : "1 = 1";
    const args = counselor ? [counselor.id] : [];
    const row = db.prepare(`SELECT r.id FROM reschedule_requests r
      WHERE ${cond} AND r.status IN ('relayed','replied') ORDER BY r.id DESC LIMIT 1`).get(...args);
    r = row ? requestRow(row.id) : null;
  }
  if (!r) return;   // 群組閒聊，不做任何事

  const stamp = nowStamp();
  const reply = (r.counselor_reply ? r.counselor_reply + '\n' : '') + text;
  db.prepare("UPDATE reschedule_requests SET counselor_reply = ?, replied_at = ?, status = 'replied' WHERE id = ?")
    .run(reply.slice(0, 2000), stamp, r.id);
  line.logEvent({
    direction: 'in', source_type: 'group', source_id: groupId, text: '（已記入申請 #' + r.id + '）',
    counselor_id: r.counselor_id, request_id: r.id
  });
  await line.send({
    kind: 'reply', replyToken, to: groupId,
    text: `已記錄您對 #${r.id}（${r.client_name}）的回覆，行政人員簽核後會同步通知個案。`,
    meta: { source_type: 'group', counselor_id: r.counselor_id, request_id: r.id }
  });
}

// ---- 系統端 API ----

router.get('/api/reschedule-requests', requireStaff('line'), (req, res) => {
  const status = String(req.query.status || 'open');
  const where = status === 'open' ? "r.status IN ('new','relayed','replied')"
    : status === 'all' ? '1 = 1' : 'r.status = ?';
  const args = (status === 'open' || status === 'all') ? [] : [status];
  res.json(db.prepare(`SELECT r.*, c.name AS client_name, c.code AS client_code, c.phone AS client_phone,
      c.line_user_id, u.name AS counselor_name, u.line_group_id,
      a.date, a.start_time, a.end_time, a.status AS appt_status, a.type AS appt_type, a.room_id, a.mode
    FROM reschedule_requests r
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN users u ON u.id = r.counselor_id
    LEFT JOIN appointments a ON a.id = r.appointment_id
    WHERE ${where} ORDER BY r.id DESC LIMIT 200`).all(...args));
});

// 櫃檯代錄（個案打電話來、或還沒接上 LINE 時）
router.post('/api/reschedule-requests', requireStaff('line'), async (req, res) => {
  const { appointment_id = null, raw_text = '', kind = 'reschedule' } = req.body || {};
  const appt = appointment_id
    ? db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(appointment_id)) : null;
  if (!appt) return res.status(400).json({ error: '請選擇要改期的預約' });
  if (!String(raw_text).trim()) return res.status(400).json({ error: '請填寫個案的需求內容' });
  const info = db.prepare(`INSERT INTO reschedule_requests
      (appointment_id, client_id, counselor_id, kind, source, raw_text) VALUES (?,?,?,?, 'staff', ?)`)
    .run(appt.id, appt.client_id, appt.counselor_id, kind, String(raw_text).trim());
  const r = requestRow(info.lastInsertRowid);
  audit('staff', req.user.id, req.user.name, '登記改期申請', String(r.id));
  const out = await relayToGroup(r);
  res.json({ id: r.id, relay: out });
});

// 重新轉達（群組換了、或第一次送失敗）
router.post('/api/reschedule-requests/:id/relay', requireStaff('line'), async (req, res) => {
  const r = requestRow(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此申請' });
  db.prepare("UPDATE reschedule_requests SET status = 'new' WHERE id = ? AND status = 'relayed'").run(r.id);
  const out = await relayToGroup(requestRow(r.id));
  res.json(out);
});

// 代錄心理師回覆（心理師用電話或口頭回覆時）
router.post('/api/reschedule-requests/:id/reply', requireStaff('line'), (req, res) => {
  const r = requestRow(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此申請' });
  const text = String((req.body || {}).counselor_reply || '').trim();
  if (!text) return res.status(400).json({ error: '請填寫心理師的回覆' });
  db.prepare("UPDATE reschedule_requests SET counselor_reply = ?, replied_at = ?, status = 'replied' WHERE id = ?")
    .run(((r.counselor_reply ? r.counselor_reply + '\n' : '') + `（${req.user.name} 代錄）` + text).slice(0, 2000), nowStamp(), r.id);
  audit('staff', req.user.id, req.user.name, '代錄心理師回覆', String(r.id));
  res.json({ ok: true });
});

// 行政簽核：真正改期，並同步回覆個案與心理師群組
router.post('/api/reschedule-requests/:id/approve', requireStaff('line'), async (req, res) => {
  const r = requestRow(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此申請' });
  if (r.status === 'approved') return res.status(400).json({ error: '此申請已簽核' });
  if (!r.appointment_id) return res.status(400).json({ error: '此申請沒有對應的預約，請改用退回並手動處理' });
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(r.appointment_id);
  if (!appt) return res.status(400).json({ error: '原預約已不存在' });
  if (appt.status === 'done') return res.status(400).json({ error: '已完成的晤談不可改期' });

  const b = req.body || {};
  const date = String(b.new_date || '').trim();
  const start = String(b.new_start_time || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start)) {
    return res.status(400).json({ error: '請填寫新的日期與時間' });
  }
  const end = String(b.new_end_time || '').trim() || endTime(start, getSetting('session_minutes', '50'));
  const counselorId = Number(b.counselor_id) || appt.counselor_id;
  const hit = conflictOf({
    id: appt.id, date, start_time: start, end_time: end,
    counselor_id: counselorId, room_id: appt.room_id
  });
  if (hit) return res.status(400).json({ error: `${hit.kind}時段衝突：${hit.row.date} ${hit.row.start_time}-${hit.row.end_time} 已有預約` });

  db.prepare(`UPDATE appointments SET date = ?, start_time = ?, end_time = ?, counselor_id = ?,
      reschedule_count = reschedule_count + 1, reminded_at = '' WHERE id = ?`)
    .run(date, start, end, counselorId, appt.id);
  db.prepare(`UPDATE reschedule_requests SET status = 'approved', new_date = ?, new_start_time = ?, new_end_time = ?,
      approved_by = ?, approved_at = ?, decision_note = ? WHERE id = ?`)
    .run(date, start, end, req.user.id, nowStamp(), String(b.decision_note || ''), r.id);
  audit('staff', req.user.id, req.user.name, '簽核改期', String(r.id),
    { appointment_id: appt.id, from: `${appt.date} ${appt.start_time}`, to: `${date} ${start}` });

  // 同步回覆：個案的官方帳號對話框與心理師群組
  const fresh = requestRow(r.id);
  const v = varsOf(fresh);
  const toClient = await line.send({
    to: fresh.line_user_id, text: line.fill(getSetting('line_done_client'), v),
    meta: { source_type: 'user', client_id: fresh.client_id, request_id: fresh.id }
  });
  const toGroup = await line.send({
    to: line.groupIdFor(fresh.counselor_id), text: line.fill(getSetting('line_done_group'), v),
    meta: { source_type: 'group', counselor_id: fresh.counselor_id, request_id: fresh.id }
  });
  res.json({ ok: true, client: toClient, group: toGroup });
});

// 退回：不改期，通知個案改以電話處理
router.post('/api/reschedule-requests/:id/reject', requireStaff('line'), async (req, res) => {
  const r = requestRow(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此申請' });
  const note = String((req.body || {}).decision_note || '').trim();
  db.prepare(`UPDATE reschedule_requests SET status = 'rejected', approved_by = ?, approved_at = ?,
      decision_note = ? WHERE id = ?`).run(req.user.id, nowStamp(), note, r.id);
  audit('staff', req.user.id, req.user.name, '退回改期申請', String(r.id), { note });
  const v = varsOf(requestRow(r.id));
  const out = (req.body || {}).notify === false ? { status: 'skipped' } : await line.send({
    to: r.line_user_id, text: line.fill(getSetting('line_reject_client'), v),
    meta: { source_type: 'user', client_id: r.client_id, request_id: r.id }
  });
  res.json({ ok: true, client: out });
});

// 傳話軌跡（最近 200 筆），供行政確認訊息有沒有真的送出去
router.get('/api/line/events', requireStaff('line'), (req, res) => {
  res.json(db.prepare(`SELECT e.*, c.name AS client_name, u.name AS counselor_name
    FROM line_events e LEFT JOIN clients c ON c.id = e.client_id LEFT JOIN users u ON u.id = e.counselor_id
    ORDER BY e.id DESC LIMIT 200`).all());
});

// LINE 綁定狀態：哪些個案已綁、哪些心理師設了群組
router.get('/api/line/status', requireStaff('line'), (req, res) => {
  res.json({
    enabled: line.enabled(),
    webhook_url: '/line/webhook',
    default_group: !!getSetting('line_default_group_id', '').trim(),
    bound_clients: db.prepare("SELECT COUNT(*) n FROM clients WHERE active = 1 AND line_user_id <> ''").get().n,
    active_clients: db.prepare('SELECT COUNT(*) n FROM clients WHERE active = 1').get().n,
    counselors: db.prepare(`SELECT id, name, line_group_id FROM users
      WHERE active = 1 AND role IN ('counselor','supervisor','admin') ORDER BY id`).all()
  });
});

// 設定／清除心理師群組
router.put('/api/line/counselors/:id/group', requireStaff('line'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '找不到此帳號' });
  const gid = String((req.body || {}).line_group_id || '').trim();
  db.prepare('UPDATE users SET line_group_id = ? WHERE id = ?').run(gid, u.id);
  audit('staff', req.user.id, req.user.name, '設定 LINE 群組', String(u.id));
  res.json({ ok: true });
});

// 解除個案綁定（換手機、綁錯人）
router.delete('/api/line/clients/:id/bind', requireStaff('line'), (req, res) => {
  db.prepare("UPDATE clients SET line_user_id = '' WHERE id = ?").run(req.params.id);
  audit('staff', req.user.id, req.user.name, '解除個案 LINE 綁定', String(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
