const express = require('express');
const bcrypt = require('bcryptjs');
const { db, audit, today, nowStamp, addDays, nextClientCode, ageYears, getSetting, listQuery, pageHeaders } = require('../db');
const { requireStaff, rateLimit } = require('../auth');
const { score, publicScales } = require('../scales');
const { sendNotification } = require('../notify');

const router = express.Router();

// 來電登記 → 派案 → 建檔的漏斗。台灣諮商所多由行政接電話登記，
// 再由所長／督導評估後派給合適的心理師，滿檔時進候補名單。
const FIELDS = ['name', 'id_no', 'phone', 'gender', 'birth_date', 'is_minor', 'source', 'referrer', 'partner_id',
  'issue', 'preferred_time', 'preferred_counselor_id', 'urgency', 'note'];

function pick(b) {
  const out = {};
  for (const f of FIELDS) {
    if (b[f] === undefined) continue;
    out[f] = ['partner_id', 'preferred_counselor_id'].includes(f) ? (Number(b[f]) || null)
      : f === 'is_minor' ? (b[f] ? 1 : 0) : String(b[f] ?? '');
  }
  return out;
}

router.get('/intakes', requireStaff('intake'), (req, res) => {
  const { status = '', q = '' } = req.query;
  const where = [], args = [];
  if (status) { where.push('i.status = ?'); args.push(status); }
  else where.push("i.status IN ('new','waiting','assigned')");
  if (req.query.urgency) { where.push('i.urgency = ?'); args.push(String(req.query.urgency)); }
  if (req.query.counselor_id) {
    where.push('(i.assigned_counselor_id = ? OR i.preferred_counselor_id = ?)');
    args.push(Number(req.query.counselor_id), Number(req.query.counselor_id));
  }
  const page = listQuery({
    select: `i.*, u.name AS assigned_name, p.name AS preferred_name,
      t.name AS taken_name, pa.name AS partner_name,
      CAST(julianday('now','localtime') - julianday(substr(i.created_at,1,10)) AS INTEGER) AS wait_days,
      (SELECT f.status FROM intake_forms f WHERE f.intake_id = i.id ORDER BY f.id DESC LIMIT 1) AS form_status,
      (SELECT f.bsrs_total FROM intake_forms f WHERE f.intake_id = i.id ORDER BY f.id DESC LIMIT 1) AS form_bsrs_total,
      (SELECT f.bsrs_alert FROM intake_forms f WHERE f.intake_id = i.id ORDER BY f.id DESC LIMIT 1) AS form_bsrs_alert`,
    from: `intakes i
      LEFT JOIN users u ON u.id = i.assigned_counselor_id
      LEFT JOIN users p ON p.id = i.preferred_counselor_id
      LEFT JOIN users t ON t.id = i.taken_by
      LEFT JOIN partners pa ON pa.id = i.partner_id`,
    where, args,
    search: String(q || ''),
    searchFields: ['i.name', 'i.phone', 'i.issue', 'i.note'],
    order: "i.urgency = 'high' DESC, i.created_at DESC",
    page: req.query.page, size: Number(req.query.size) || 200, maxSize: 500
  });
  res.json(pageHeaders(res, page));
});


router.post('/intakes', requireStaff('intake'), (req, res) => {
  const d = pick(req.body);
  if (!d.name) return res.status(400).json({ error: '請填寫姓名' });
  d.taken_by = req.user.id;
  const cols = Object.keys(d);
  const info = db.prepare(`INSERT INTO intakes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(k => d[k]));
  audit('staff', req.user.id, req.user.name, '新增來電登記', d.name);
  res.json({ id: info.lastInsertRowid });
});

router.put('/intakes/:id', requireStaff('intake'), (req, res) => {
  const i = db.prepare('SELECT * FROM intakes WHERE id = ?').get(req.params.id);
  if (!i) return res.status(404).json({ error: '找不到此登記' });
  const d = pick(req.body);
  if (req.body.status) d.status = req.body.status;
  if (req.body.close_reason !== undefined) d.close_reason = req.body.close_reason;
  if (!Object.keys(d).length) return res.json({ ok: true });
  db.prepare(`UPDATE intakes SET ${Object.keys(d).map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(d), i.id);
  res.json({ ok: true });
});

// 派案：指定心理師，狀態轉 assigned（尚未建檔，初談到所後才正式成為個案）
router.post('/intakes/:id/assign', requireStaff('intake'), (req, res) => {
  const i = db.prepare('SELECT * FROM intakes WHERE id = ?').get(req.params.id);
  if (!i) return res.status(404).json({ error: '找不到此登記' });
  const cid = Number(req.body && req.body.counselor_id) || 0;
  if (!cid) return res.status(400).json({ error: '請選擇心理師' });
  db.prepare("UPDATE intakes SET assigned_counselor_id = ?, status = 'assigned' WHERE id = ?").run(cid, i.id);
  audit('staff', req.user.id, req.user.name, '派案', i.name, { counselor_id: cid });
  res.json({ ok: true });
});

// 建檔：轉為正式個案，可一併建立初談預約
router.post('/intakes/:id/convert', requireStaff('intake'), (req, res) => {
  const i = db.prepare('SELECT * FROM intakes WHERE id = ?').get(req.params.id);
  if (!i) return res.status(404).json({ error: '找不到此登記' });
  if (i.client_id) return res.status(400).json({ error: '此登記已建檔' });
  const b = req.body || {};
  const counselorId = Number(b.counselor_id) || i.assigned_counselor_id;
  if (!counselorId) return res.status(400).json({ error: '請先派案' });
  // 個案自填的初談問卷（若有）用來補齊登記時沒問到的欄位；已填欄位以問卷為準
  const form = db.prepare("SELECT * FROM intake_forms WHERE intake_id = ? AND status = 'done' ORDER BY id DESC").get(i.id);
  const fv = (k, fallback = '') => (form && String(form[k] || '').trim()) || fallback;
  const phone = (fv('phone', i.phone) || '').replace(/\D/g, '');
  const tx = db.transaction(() => {
    const code = nextClientCode();
    // 轉個案時一併帶入成年判定，避免登記時漏勾未成年
    const birthDate = fv('birth_date', i.birth_date);
    const age = ageYears(birthDate);
    const isMinor = age !== null && age < Number(getSetting('adult_age', '18')) ? 1 : i.is_minor;
    const info = db.prepare(`INSERT INTO clients
      (code, name, id_no, gender, birth_date, phone, email, address, occupation, marital,
       source, referrer, partner_id, counselor_id,
       status, main_issue, history, is_minor, guardian_name, guardian_relationship, guardian_phone,
       emergency_name, emergency_relationship, emergency_phone, intake_date, password_hash, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'intake', ?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      code, i.name, i.id_no || '', fv('gender', i.gender), birthDate, fv('phone', i.phone),
      fv('email'), fv('address'), fv('occupation'), fv('marital'),
      fv('source', i.source), i.referrer, i.partner_id, counselorId,
      fv('main_issue', i.issue), fv('history'), isMinor,
      fv('guardian_name'), fv('guardian_relationship'), fv('guardian_phone'),
      fv('emergency_name'), fv('emergency_relationship'), fv('emergency_phone'),
      today(), phone.length >= 6 ? bcrypt.hashSync(phone.slice(-6), 10) : '',
      [i.note, form && form.expectation ? `個案期待：${form.expectation}` : ''].filter(Boolean).join('\n'));
    const clientId = info.lastInsertRowid;
    // 問卷附的 BSRS-5 一併轉為量表施測紀錄，成為療效追蹤的基線
    if (form) {
      if (form.bsrs_total >= 0) {
        const s = score('BSRS5', JSON.parse(form.bsrs_answers || '[]'));
        db.prepare(`INSERT INTO assessments (client_id, scale, date, answers, total, severity, alert, filled_by, note)
          VALUES (?, 'BSRS5', ?, ?, ?, ?, ?, 'client', '初談問卷自填')`).run(
          clientId, (form.submitted_at || today()).slice(0, 10), form.bsrs_answers, s.total, s.severity, s.alert);
        if (s.alert) db.prepare("UPDATE clients SET risk_level = 'high' WHERE id = ?").run(clientId);
      }
      db.prepare("UPDATE intake_forms SET status = 'used' WHERE id = ?").run(form.id);
    }
    db.prepare("UPDATE intakes SET status = 'converted', client_id = ?, assigned_counselor_id = ? WHERE id = ?")
      .run(clientId, counselorId, i.id);
    // 一併建立初談預約
    if (b.date && b.start_time) {
      const { endTime, conflictOf } = require('./schedule');
      const end = b.end_time || endTime(b.start_time, require('../db').getSetting('session_minutes', '50'));
      const hit = conflictOf({ date: b.date, start_time: b.start_time, end_time: end, counselor_id: counselorId, room_id: b.room_id });
      if (hit) throw new Error(`${hit.kind}時段衝突：${hit.row.start_time}-${hit.row.end_time} 已有預約`);
      db.prepare(`INSERT INTO appointments (client_id, counselor_id, room_id, date, start_time, end_time,
        type, status, fee, created_by) VALUES (?,?,?,?,?,?, 'intake', 'booked', ?, ?)`).run(
        clientId, counselorId, Number(b.room_id) || null, b.date, b.start_time, end,
        Number(require('../db').getSetting('intake_fee', '2500')), req.user.id);
    }
    return { clientId, code };
  });
  let r;
  try { r = tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  audit('staff', req.user.id, req.user.name, '來電登記建檔', r.code);
  res.json({ client_id: r.clientId, code: r.code });
});

// ---- 個案端自填初談問卷 ----
// 派案前先讓來電者用手機填基本資料、主訴與 BSRS-5，櫃檯建檔時一鍵帶入，省去逐筆謄打；
// 高風險（附加題命中）在來電清單即標紅，初談前就看得到。
// 連結以隨機 token 免登入開啟（此時尚未有個案帳號），設有效期限，填寫後即不可再改。

const FORM_FIELDS = ['name', 'phone', 'gender', 'birth_date', 'email', 'address', 'occupation', 'marital',
  'emergency_name', 'emergency_relationship', 'emergency_phone',
  'guardian_name', 'guardian_relationship', 'guardian_phone',
  'main_issue', 'history', 'expectation', 'preferred_time', 'source',
  // 對齊擁抱心理紙本初談表的欄位
  'id_no', 'prior_counseling', 'prior_medical', 'service_mode', 'topics', 'referral_note'];

function formPublic(f) {
  const out = { token: f.token, status: f.status, expires_at: f.expires_at, submitted_at: f.submitted_at };
  for (const k of FORM_FIELDS) out[k] = f[k];
  return out;
}

router.post('/intakes/:id/form', requireStaff('intake'), (req, res) => {
  const i = db.prepare('SELECT * FROM intakes WHERE id = ?').get(req.params.id);
  if (!i) return res.status(404).json({ error: '找不到此登記' });
  const existing = db.prepare("SELECT * FROM intake_forms WHERE intake_id = ? AND status != 'used' ORDER BY id DESC").get(i.id);
  if (existing && existing.status === 'done') {
    return res.status(400).json({ error: '此登記的問卷已填寫完成，請直接檢視內容' });
  }
  if (existing && existing.expires_at >= today()) {
    return res.json({ token: existing.token, expires_at: existing.expires_at, reused: true });
  }
  const token = require('crypto').randomBytes(18).toString('hex');
  const expires = addDays(today(), Number(getSetting('intake_form_days', '14')) || 14);
  db.prepare(`INSERT INTO intake_forms (intake_id, token, name, phone, gender, birth_date, source, expires_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    i.id, token, i.name || '', i.phone || '', i.gender || '', i.birth_date || '', i.source || '', expires, req.user.id);
  audit('staff', req.user.id, req.user.name, '產生初談問卷連結', i.name);
  res.json({ token, expires_at: expires });
});

// 尚未來電登記也能先發問卷（例如網站表單、合作單位轉介名單），
// 填完後可一鍵轉為來電登記，接回原本的派案流程。
router.post('/intake-forms', requireStaff('intake'), (req, res) => {
  const b = req.body || {};
  const token = require('crypto').randomBytes(18).toString('hex');
  const expires = addDays(today(), Number(getSetting('intake_form_days', '14')) || 14);
  const info = db.prepare(`INSERT INTO intake_forms (intake_id, token, name, phone, expires_at, created_by)
    VALUES (NULL,?,?,?,?,?)`).run(token, String(b.name || ''), String(b.phone || ''), expires, req.user.id);
  audit('staff', req.user.id, req.user.name, '產生初談問卷連結', String(b.name || '（未指定對象）'));
  res.json({ id: info.lastInsertRowid, token, expires_at: expires });
});

router.get('/intake-forms', requireStaff('intake'), (req, res) => {
  const { status = '' } = req.query;
  const where = status ? 'WHERE f.status = ?' : '';
  const rows = db.prepare(`SELECT f.id, f.intake_id, f.token, f.name, f.phone, f.status, f.expires_at, f.submitted_at,
      f.bsrs_total, f.bsrs_alert, f.main_issue, f.created_at, u.name AS created_by_name,
      i.status AS intake_status
    FROM intake_forms f LEFT JOIN users u ON u.id = f.created_by
    LEFT JOIN intakes i ON i.id = f.intake_id
    ${where} ORDER BY f.id DESC LIMIT 200`).all(...(status ? [status] : []));
  const t = today();
  res.json(rows.map(r => ({ ...r, expired: r.status === 'sent' && r.expires_at && r.expires_at < t })));
});

router.get('/intake-forms/:id', requireStaff('intake'), (req, res) => {
  const f = db.prepare('SELECT * FROM intake_forms WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: '找不到此問卷' });
  res.json({
    ...formPublic(f), id: f.id, intake_id: f.intake_id,
    bsrs_total: f.bsrs_total, bsrs_alert: f.bsrs_alert,
    bsrs_answers: f.bsrs_answers ? JSON.parse(f.bsrs_answers) : null
  });
});

// 把問卷連結用簡訊／LINE 送出（未設定通道時記為人工發送，內容僅含連結與所名）
router.post('/intake-forms/:id/send', requireStaff('intake'), async (req, res) => {
  const f = db.prepare('SELECT * FROM intake_forms WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: '找不到此問卷' });
  if (f.status !== 'sent') return res.status(400).json({ error: '此問卷已填寫完成' });
  const target = String((req.body && req.body.phone) || f.phone || '');
  const content = String((req.body && req.body.message) || '')
    || `${f.name ? f.name + ' 您好，' : ''}這是 ${getSetting('center_name')} 的初談問卷，`
      + `請於 ${f.expires_at} 前撥空填寫，可省去到所後填寫的時間：${req.body && req.body.url ? req.body.url : ''}`;
  const result = await sendNotification({ kind: 'intake_form', client_id: null, target, content, user: req.user });
  res.json({ ok: true, ...result });
});

// 問卷（非來電登記產生者）轉為來電登記，接回派案流程
router.post('/intake-forms/:id/to-intake', requireStaff('intake'), (req, res) => {
  const f = db.prepare('SELECT * FROM intake_forms WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: '找不到此問卷' });
  if (f.intake_id) return res.status(400).json({ error: '此問卷已對應一筆來電登記' });
  if (f.status !== 'done') return res.status(400).json({ error: '問卷尚未填寫完成' });
  const info = db.prepare(`INSERT INTO intakes (name, phone, gender, birth_date, source, issue, preferred_time,
      urgency, status, taken_by, note)
    VALUES (?,?,?,?,?,?,?,?, 'new', ?, ?)`).run(
    f.name || '（未填姓名）', f.phone, f.gender, f.birth_date, f.source, f.main_issue, f.preferred_time,
    f.bsrs_alert ? 'high' : 'normal', req.user.id, '由個案自填初談問卷建立');
  db.prepare('UPDATE intake_forms SET intake_id = ? WHERE id = ?').run(info.lastInsertRowid, f.id);
  audit('staff', req.user.id, req.user.name, '問卷轉來電登記', f.name || '');
  res.json({ id: info.lastInsertRowid });
});

router.get('/intakes/:id/form', requireStaff('intake'), (req, res) => {
  const f = db.prepare('SELECT * FROM intake_forms WHERE intake_id = ? ORDER BY id DESC').get(req.params.id);
  if (!f) return res.status(404).json({ error: '尚未產生問卷' });
  res.json({
    ...formPublic(f),
    bsrs_total: f.bsrs_total, bsrs_alert: f.bsrs_alert,
    bsrs_answers: f.bsrs_answers ? JSON.parse(f.bsrs_answers) : null
  });
});

// ---- 公開（免登入）：以 token 開啟與送出 ----
const formRateLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, prefix: 'intakeform:' });

function loadForm(token) {
  const f = db.prepare('SELECT * FROM intake_forms WHERE token = ?').get(String(token || ''));
  if (!f) return { error: '連結無效，請與諮商所聯繫' };
  if (f.status !== 'sent') return { error: '此問卷已填寫完成，如需修改請來電諮商所' };
  if (f.expires_at && f.expires_at < today()) return { error: '連結已逾期，請與諮商所聯繫重新取得' };
  return { form: f };
}

router.get('/public/intake-form/:token', formRateLimit, (req, res) => {
  const r = loadForm(req.params.token);
  if (r.error) return res.status(404).json({ error: r.error });
  res.json({
    ...formPublic(r.form),
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    crisis_note: getSetting('ui_crisis_note'),
    scale: publicScales().BSRS5
  });
});

router.post('/public/intake-form/:token', formRateLimit, (req, res) => {
  const r = loadForm(req.params.token);
  if (r.error) return res.status(400).json({ error: r.error });
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: '請填寫姓名' });
  const data = {};
  for (const k of FORM_FIELDS) data[k] = String(b[k] ?? '').slice(0, 1000);

  // BSRS-5 為選填；有作答才計分，命中附加題即標為高風險並在來電清單示警
  let bsrs = { total: -1, alert: 0, answers: '' };
  if (Array.isArray(b.bsrs_answers) && b.bsrs_answers.length) {
    try {
      const s = score('BSRS5', b.bsrs_answers);
      bsrs = { total: s.total, alert: s.alert, answers: JSON.stringify(b.bsrs_answers) };
    } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  db.prepare(`UPDATE intake_forms SET ${FORM_FIELDS.map(k => `${k} = ?`).join(', ')},
      bsrs_answers = ?, bsrs_total = ?, bsrs_alert = ?, status = 'done', submitted_at = ?
    WHERE id = ?`).run(
    ...FORM_FIELDS.map(k => data[k]), bsrs.answers, bsrs.total, bsrs.alert, nowStamp(), r.form.id);

  // 同步回來電登記，讓櫃檯不必開問卷就看得到主訴與風險
  if (r.form.intake_id) {
    const up = { issue: data.main_issue, preferred_time: data.preferred_time };
    if (bsrs.alert) up.urgency = 'high';
    if (data.phone) up.phone = data.phone;
    if (data.birth_date) up.birth_date = data.birth_date;
    db.prepare(`UPDATE intakes SET ${Object.keys(up).map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...Object.values(up), r.form.intake_id);
  }
  audit('client', null, data.name, '填寫初談問卷', '', { bsrs_total: bsrs.total, alert: bsrs.alert });
  res.json({ ok: true, alert: bsrs.alert, crisis_note: bsrs.alert ? getSetting('ui_crisis_note') : '' });
});

router.post('/intakes/:id/close', requireStaff('intake'), (req, res) => {
  const i = db.prepare('SELECT * FROM intakes WHERE id = ?').get(req.params.id);
  if (!i) return res.status(404).json({ error: '找不到此登記' });
  db.prepare("UPDATE intakes SET status = 'closed', close_reason = ? WHERE id = ?")
    .run((req.body && req.body.close_reason) || '', i.id);
  audit('staff', req.user.id, req.user.name, '結束來電登記', i.name);
  res.json({ ok: true });
});

// 刪除來電登記：已建檔（converted）的不能刪，個案資料還連著；誤登的用這個清掉
router.delete('/intakes/:id', requireStaff('intake'), (req, res) => {
  const i = db.prepare('SELECT * FROM intakes WHERE id = ?').get(req.params.id);
  if (!i) return res.status(404).json({ error: '找不到此登記' });
  if (i.status === 'converted' || i.client_id) {
    return res.status(400).json({ error: '此登記已建檔為個案，不可刪除；如需結束請用「結束登記」' });
  }
  db.prepare('DELETE FROM intakes WHERE id = ?').run(i.id);
  audit('staff', req.user.id, req.user.name, '刪除來電登記', i.name);
  res.json({ ok: true });
});

// 刪除初談問卷連結：已填寫並帶入建檔的不刪，避免抽掉建檔依據
router.delete('/intake-forms/:id', requireStaff('intake'), (req, res) => {
  const f = db.prepare('SELECT * FROM intake_forms WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: '找不到此問卷' });
  if (f.status === 'used') return res.status(400).json({ error: '此問卷已用於建檔，不可刪除' });
  db.prepare('DELETE FROM intake_forms WHERE id = ?').run(f.id);
  audit('staff', req.user.id, req.user.name, '刪除初談問卷', f.name || String(f.id));
  res.json({ ok: true });
});

module.exports = router;
