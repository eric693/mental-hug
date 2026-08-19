const express = require('express');
const { db, audit, today, getSetting, setSetting, nowStamp } = require('../db');
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
  const v = varsOf(r);
  const text = line.fill(getSetting('line_relay_template'), v);
  const flex = line.bubble({
    title: `${r.kind === 'cancel' ? '請假／取消' : '改期'}申請 #${r.id}`,
    tone: 'warn',
    fields: [
      line.fieldRow('個案', `${v.client}${v.code ? '（' + v.code + '）' : ''}`),
      line.fieldRow('原訂', v.date ? `${v.date}（${v.weekday}）${v.time}` : '（查無對應預約）'),
      line.fieldRow('收到時間', String(r.created_at || '').slice(5, 16))
    ],
    body: `個案訊息：\n${v.text}`,
    footer: `請直接在群組回覆可否改期與建議時段；同時有多筆時請在訊息裡寫 #${r.id} 指定。行政人員會據以簽核。`
  });
  // 先推進狀態再送訊息：LINE 送不出去時（沒設群組、對方 API 慢或掛掉）
  // 申請仍會出現在「待心理師回覆」，行政人員可以自己打電話問完再代錄，流程不會卡在「待轉達」。
  db.prepare("UPDATE reschedule_requests SET status = 'relayed', relayed_at = ? WHERE id = ? AND status = 'new'")
    .run(nowStamp(), r.id);
  return line.send({
    to: gid, text, flex,
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
  const src0 = ev.source || {};
  // 被拉進群組（join）當下就把 groupId 記下來，行政人員不必自己去翻 ID
  if (ev.type === 'join' && (src0.type === 'group' || src0.type === 'room')) {
    const gid = src0.groupId || src0.roomId;
    const known = db.prepare('SELECT name FROM users WHERE line_group_id = ?').get(gid);
    line.logEvent({ direction: 'in', source_type: 'group', source_id: gid, text: '（官方帳號加入此群組）' });
    const joinText = known
      ? `已連結到 ${known.name} 心理師的群組，個案的改期／請假訊息會轉到這裡。`
      : '已加入。請所方到系統的「LINE 傳話設定」把這個群組指派給對應的心理師，之後個案的改期／請假訊息就會轉到這裡。';
    return line.send({
      kind: 'reply', replyToken: ev.replyToken, to: gid,
      text: joinText,
      flex: line.bubble({
        title: known ? '傳話機器人已就緒' : '傳話機器人已加入',
        tone: known ? 'ok' : 'warn',
        fields: [line.fieldRow('諮商所', getSetting('center_name')),
          line.fieldRow('對應心理師', known ? known.name : '尚未指派')],
        body: joinText
      }),
      meta: { source_type: 'group' }
    });
  }
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
        const t = '查不到這個手機號碼的資料，請確認號碼是否與登記時相同，或直接來電諮商所。';
        return line.send({
          kind: 'reply', replyToken, to: userId, text: t,
          flex: line.bubble({ title: '綁定失敗', tone: 'danger', body: t,
            footer: getSetting('center_phone') ? '諮商所電話：' + getSetting('center_phone') : '' }),
          meta: { source_type: 'user' }
        });
      }
      if (hit.line_user_id && hit.line_user_id !== userId) {
        const t = '此號碼已綁定其他 LINE 帳號，請來電諮商所協助處理。';
        return line.send({
          kind: 'reply', replyToken, to: userId, text: t,
          flex: line.bubble({ title: '綁定失敗', tone: 'danger', body: t }),
          meta: { source_type: 'user', client_id: hit.id }
        });
      }
      db.prepare('UPDATE clients SET line_user_id = ? WHERE id = ?').run(userId, hit.id);
      audit('system', null, 'LINE', '個案綁定 LINE', String(hit.id));
      return line.send({
        kind: 'reply', replyToken, to: userId,
        text: `${hit.name} 您好，已完成綁定。日後如需請假或改期，直接在此傳訊息告訴我們即可。`,
        flex: line.bubble({
          title: '綁定完成', tone: 'ok',
          fields: [line.fieldRow('姓名', hit.name), line.fieldRow('諮商所', getSetting('center_name'))],
          body: '日後如需請假或改期，直接在此傳訊息告訴我們即可，我們會轉達給您的心理師。',
          footer: '本對話僅處理預約與行政事項；晤談內容請於晤談時與心理師討論。'
        }),
        meta: { source_type: 'user', client_id: hit.id }
      });
    }
    const hint = line.fill(getSetting('line_bind_hint'),
      { center: getSetting('center_name'), phone: getSetting('center_phone') });
    return line.send({
      kind: 'reply', replyToken, to: userId, text: hint,
      flex: line.bubble({
        title: '請先完成身分綁定', tone: 'warn', body: hint,
        footer: '格式範例：綁定 0912345678'
      }),
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
    const ack = line.fill(getSetting('line_ack_client'), { phone: getSetting('center_phone') });
    return line.send({
      kind: 'reply', replyToken, to: userId, text: ack,
      flex: line.bubble({ title: '已收到您的訊息', tone: 'info', body: ack }),
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
  const ackText = line.fill(getSetting('line_ack_client'), { phone: getSetting('center_phone') });
  await line.send({
    kind: 'reply', replyToken, to: userId, text: ackText,
    flex: line.bubble({
      title: kind === 'cancel' ? '已收到您的請假需求' : '已收到您的改期需求',
      tone: 'info',
      fields: [
        line.fieldRow('原訂時段', appt ? `${appt.date}（${line.weekdayName(appt.date)}）${appt.start_time}-${appt.end_time}` : '（查無預約，將由櫃檯確認）'),
        line.fieldRow('申請編號', '#' + r.id)
      ],
      body: ackText,
      footer: '確認後我們會在這個對話框回覆您新的時間。'
    }),
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
    flex: line.bubble({
      title: `已記錄回覆 #${r.id}`, tone: 'ok',
      fields: [line.fieldRow('個案', r.client_name || ''), line.fieldRow('您的回覆', text)],
      body: '行政人員簽核後，系統會同步通知個案並更新時間表。'
    }),
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
  const site = appt.site_id ? db.prepare('SELECT name, address FROM sites WHERE id = ?').get(appt.site_id) : null;
  const toClient = await line.send({
    to: fresh.line_user_id, text: line.fill(getSetting('line_done_client'), v),
    flex: line.bubble({
      title: '改期完成', tone: 'ok',
      fields: [
        line.fieldRow('新時間', `${v.new_date}（${v.new_weekday}）${v.new_time}`),
        line.fieldRow('心理師', v.counselor),
        ...(site ? [line.fieldRow('地點', site.name + (site.address ? '　' + site.address : ''))] : []),
        line.fieldRow('原訂', `${v.date}（${v.weekday}）${v.time}`)
      ],
      body: line.fill(getSetting('line_done_client'), v),
      footer: getSetting('center_phone') ? `如有問題請來電 ${getSetting('center_phone')}` : ''
    }),
    meta: { source_type: 'user', client_id: fresh.client_id, request_id: fresh.id }
  });
  const toGroup = await line.send({
    to: line.groupIdFor(fresh.counselor_id), text: line.fill(getSetting('line_done_group'), v),
    flex: line.bubble({
      title: `已簽核改期 #${fresh.id}`, tone: 'ok',
      fields: [
        line.fieldRow('個案', `${v.client}${v.code ? '（' + v.code + '）' : ''}`),
        line.fieldRow('原訂', `${v.date}（${v.weekday}）${v.time}`),
        line.fieldRow('改為', `${v.new_date}（${v.new_weekday}）${v.new_time}`),
        line.fieldRow('簽核人', req.user.name)
      ],
      body: '時間表已更新，個案端也已同步通知。'
    }),
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
    flex: line.bubble({
      title: '關於您的改期需求', tone: 'warn',
      fields: [line.fieldRow('原訂', v.date ? `${v.date}（${v.weekday}）${v.time}` : '-')],
      body: line.fill(getSetting('line_reject_client'), v),
      footer: getSetting('center_phone') ? `諮商所電話：${getSetting('center_phone')}` : ''
    }),
    meta: { source_type: 'user', client_id: r.client_id, request_id: r.id }
  });
  res.json({ ok: true, client: out });
});

// 刪除改期申請：誤建或個案自己取消時清掉；已簽核（已真的改期）的不刪，留著當軌跡
router.delete('/api/reschedule-requests/:id', requireStaff('line'), (req, res) => {
  const r = requestRow(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此申請' });
  if (r.status === 'approved') return res.status(400).json({ error: '已簽核改期的申請不可刪除' });
  db.prepare('UPDATE line_events SET request_id = NULL WHERE request_id = ?').run(r.id);
  db.prepare('DELETE FROM reschedule_requests WHERE id = ?').run(r.id);
  audit('staff', req.user.id, req.user.name, '刪除改期申請', String(r.id), { client: r.client_name });
  res.json({ ok: true });
});

// 傳話軌跡（最近 200 筆），供行政確認訊息有沒有真的送出去
router.get('/api/line/events', requireStaff('line'), (req, res) => {
  res.json(db.prepare(`SELECT e.*, c.name AS client_name, u.name AS counselor_name
    FROM line_events e LEFT JOIN clients c ON c.id = e.client_id LEFT JOIN users u ON u.id = e.counselor_id
    ORDER BY e.id DESC LIMIT 200`).all());
});

// LINE 綁定狀態：哪些個案已綁、哪些心理師設了群組
// 憑證只回遮罩後的樣子：畫面上要看得出「填了沒、是不是同一組」，但不把完整值再送出去
function mask(v) {
  const s2 = String(v || '').trim();
  if (!s2) return '';
  return s2.length <= 8 ? '••••' : `${s2.slice(0, 4)}••••${s2.slice(-4)}（${s2.length} 字）`;
}

router.get('/api/line/status', requireStaff('line'), (req, res) => {
  // 曾經傳過訊息、但還沒指派給任何心理師的群組：直接列出來讓行政一鍵指派
  const unassigned = db.prepare(`SELECT e.source_id,
      MAX(e.created_at) AS last_at, COUNT(*) AS n,
      (SELECT text FROM line_events x WHERE x.source_id = e.source_id AND x.direction = 'in'
        ORDER BY x.id DESC LIMIT 1) AS last_text
    FROM line_events e
    WHERE e.source_type = 'group' AND e.source_id <> ''
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.line_group_id = e.source_id)
      AND e.source_id <> ?
    GROUP BY e.source_id ORDER BY last_at DESC LIMIT 20`).all(getSetting('line_default_group_id', '').trim());
  res.json({
    enabled: line.enabled(),
    webhook_url: '/line/webhook',
    has_secret: !!getSetting('line_channel_secret', '').trim(),
    has_token: !!getSetting('line_channel_token', '').trim(),
    secret_masked: mask(getSetting('line_channel_secret', '')),
    token_masked: mask(getSetting('line_channel_token', '')),
    default_group_id: getSetting('line_default_group_id', '').trim(),
    keywords: getSetting('line_keywords', ''),
    unassigned_groups: unassigned,
    default_group: !!getSetting('line_default_group_id', '').trim(),
    bound_clients: db.prepare("SELECT COUNT(*) n FROM clients WHERE active = 1 AND line_user_id <> ''").get().n,
    active_clients: db.prepare('SELECT COUNT(*) n FROM clients WHERE active = 1').get().n,
    counselors: db.prepare(`SELECT id, name, line_group_id FROM users
      WHERE active = 1 AND role IN ('counselor','supervisor','admin') ORDER BY id`).all()
  });
});

// 在「LINE 傳話設定」頁直接填憑證：留空的欄位不動（避免遮罩值把原本的蓋掉）
router.put('/api/line/credentials', requireStaff('line'), (req, res) => {
  const b = req.body || {};
  const fields = {
    line_channel_secret: b.line_channel_secret,
    line_channel_token: b.line_channel_token,
    line_default_group_id: b.line_default_group_id,
    line_keywords: b.line_keywords
  };
  const changed = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    const val = String(v).trim();
    // 憑證留空＝不變更；要清空請用 clear_secret / clear_token
    if (!val && (k === 'line_channel_secret' || k === 'line_channel_token')) continue;
    setSetting(k, val);
    changed.push(k);
  }
  if (b.clear_secret) { setSetting('line_channel_secret', ''); changed.push('line_channel_secret(清除)'); }
  if (b.clear_token) { setSetting('line_channel_token', ''); changed.push('line_channel_token(清除)'); }
  audit('staff', req.user.id, req.user.name, '設定 LINE 憑證', '', changed.join(','));
  res.json({ ok: true, changed });
});

// 驗證憑證：真的打一次 LINE API 問「這個 token 是哪個官方帳號」，
// 順便回報目前登記的 webhook 網址與配額，才不用等個案傳訊息才發現填錯。
router.post('/api/line/verify', requireStaff('line'), async (req, res) => {
  const token = String((req.body || {}).line_channel_token || '').trim()
    || getSetting('line_channel_token', '').trim();
  if (!token) return res.status(400).json({ error: '請先填入 Channel access token' });
  const out = { ok: false, bot: null, webhook: null, quota: null, errors: [] };
  try {
    out.bot = await line.callLine('/info', undefined, 'GET', token);
    out.ok = true;
  } catch (e) {
    return res.status(400).json({ error: `token 驗證失敗：${e.message}` });
  }
  try { out.webhook = await line.callLine('/channel/webhook/endpoint', undefined, 'GET', token); }
  catch (e) { out.errors.push(`讀取 webhook 設定失敗：${e.message}`); }
  try { out.quota = await line.callLine('/message/quota', undefined, 'GET', token); }
  catch (e) { out.errors.push(`讀取訊息配額失敗：${e.message}`); }
  out.expected_webhook = `${req.protocol}://${req.get('host')}/line/webhook`;
  out.secret_set = !!getSetting('line_channel_secret', '').trim();
  audit('staff', req.user.id, req.user.name, '驗證 LINE 憑證', '', out.bot && out.bot.basicId);
  res.json(out);
});

// 由系統代為把 webhook 網址寫回 LINE，並要求 LINE 實際打一次測試
router.post('/api/line/webhook-endpoint', requireStaff('line'), async (req, res) => {
  const url = `${req.protocol}://${req.get('host')}/line/webhook`;
  try {
    await line.callLine('/channel/webhook/endpoint', { endpoint: url }, 'PUT');
    const test = await line.callLine('/channel/webhook/test', { endpoint: url });
    audit('staff', req.user.id, req.user.name, '設定 LINE webhook 網址', '', url);
    res.json({ ok: true, endpoint: url, test });
  } catch (e) {
    res.status(400).json({ error: `設定失敗：${e.message}` });
  }
});

// 對指定對象送一則測試訊息，確認真的到得了群組
router.post('/api/line/test-push', requireStaff('line'), async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  if (!to) return res.status(400).json({ error: '請指定要測試的對象（群組 ID 或使用者 ID）' });
  const out = await line.send({
    to, text: `${getSetting('center_name')} 系統測試訊息：這個群組已與傳話機器人連線成功。`,
    flex: line.bubble({
      title: '連線測試', tone: 'ok',
      fields: [line.fieldRow('諮商所', getSetting('center_name')), line.fieldRow('測試人', req.user.name)],
      body: '看得到這則卡片，表示傳話機器人可以正常送訊息到這裡。'
    }),
    meta: { source_type: 'group' }
  });
  res.json(out);
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
