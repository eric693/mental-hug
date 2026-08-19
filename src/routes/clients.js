const express = require('express');
const bcrypt = require('bcryptjs');
const { db, audit, today, nextClientCode, ageYears, getSetting } = require('../db');
const { requireStaff, canViewClientNotes, clientIp } = require('../auth');

const { createCloseFollowUps } = require('./aftercare');

const router = express.Router();

const CLIENT_FIELDS = [
  'name', 'id_no', 'gender', 'birth_date', 'phone', 'email', 'address', 'occupation', 'marital',
  'source', 'referrer', 'partner_id', 'counselor_id', 'status', 'risk_level', 'main_issue', 'history', 'diagnosis',
  'is_minor', 'guardian_name', 'guardian_relationship', 'guardian_phone',
  'emergency_name', 'emergency_relationship', 'emergency_phone', 'note',
  'intake_date', 'close_date', 'close_reason', 'portal_enabled'
];

function pick(body) {
  const out = {};
  for (const f of CLIENT_FIELDS) {
    if (body[f] === undefined) continue;
    out[f] = ['counselor_id', 'partner_id'].includes(f) ? (Number(body[f]) || null)
      : ['is_minor', 'portal_enabled'].includes(f) ? (body[f] ? 1 : 0)
        : String(body[f] ?? '');
  }
  if (out.id_no) out.id_no = out.id_no.toUpperCase().trim();
  return out;
}

// 民法成年年齡（112 年起為 18 歲）：有生日就依生日判定，避免漏勾而跳過法定代理人同意書。
// 受監護宣告者仍需人工勾選，故只在「未滿成年」時強制設 1，不會把人工勾選的成年案改回 0。
function applyMinor(data, birthDate) {
  const bd = data.birth_date || birthDate || '';
  if (!bd) return;
  const age = ageYears(bd);
  if (age !== null && age < Number(getSetting('adult_age', '18'))) data.is_minor = 1;
}

// 身分證統一編號格式檢核（A123456789）；居留證號等其他格式僅存不檢核
function idNoWarning(idNo) {
  if (!idNo) return '';
  if (!/^[A-Z][12]\d{8}$/.test(idNo)) return '';
  const letters = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
  const n = letters.indexOf(idNo[0]) + 10;
  let sum = Math.floor(n / 10) + (n % 10) * 9;
  for (let i = 1; i < 9; i++) sum += Number(idNo[i]) * (9 - i);
  sum += Number(idNo[9]);
  return sum % 10 === 0 ? '' : '身分證統一編號檢查碼不符，請確認是否輸入錯誤';
}

// 個案清單：諮商師預設只看自己的個案，可切換全所（僅顯示基本欄位，不含晤談內容）
router.get('/clients', requireStaff('clients'), (req, res) => {
  const { status = '', q = '', counselor_id = '', risk = '' } = req.query;
  const where = ['c.active = 1'], args = [];
  if (status) { where.push('c.status = ?'); args.push(status); }
  if (risk) { where.push('c.risk_level = ?'); args.push(risk); }
  if (counselor_id) { where.push('c.counselor_id = ?'); args.push(Number(counselor_id)); }
  if (q) { where.push('(c.name LIKE ? OR c.code LIKE ? OR c.phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(`
    SELECT c.*, u.name AS counselor_name,
      (SELECT COUNT(*) FROM session_notes n WHERE n.client_id = c.id) AS note_count,
      (SELECT MAX(date) FROM appointments a WHERE a.client_id = c.id AND a.status = 'done') AS last_session,
      (SELECT MIN(date) FROM appointments a WHERE a.client_id = c.id AND a.date >= date('now','localtime') AND a.status IN ('booked','arrived')) AS next_session
    FROM clients c LEFT JOIN users u ON u.id = c.counselor_id
    WHERE ${where.join(' AND ')} ORDER BY c.status = 'closed', c.created_at DESC`).all(...args);
  res.json(rows.map(r => ({ ...r, age: ageYears(r.birth_date) })));
});

router.get('/clients/:id', requireStaff('clients'), (req, res) => {
  const c = db.prepare(`SELECT c.*, u.name AS counselor_name, p.name AS partner_name FROM clients c
    LEFT JOIN users u ON u.id = c.counselor_id
    LEFT JOIN partners p ON p.id = c.partner_id WHERE c.id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  delete c.password_hash;
  const consents = db.prepare('SELECT id, key, title, agreed, signer_name, signer_role, version, signed_at FROM consents WHERE client_id = ? ORDER BY signed_at DESC').all(c.id);
  const templates = db.prepare('SELECT * FROM consent_templates WHERE active = 1 ORDER BY sort, id').all()
    .filter(t => !t.minor_only || c.is_minor);
  res.json({
    ...c,
    age: ageYears(c.birth_date),
    can_view_notes: canViewClientNotes(req.user, c),
    consents,
    pending_consents: templates.filter(t => !consents.some(s => s.key === t.key && s.version === t.version)).map(t => ({ key: t.key, title: t.title })),
    appointments: db.prepare(`SELECT a.*, u.name AS counselor_name FROM appointments a
      LEFT JOIN users u ON u.id = a.counselor_id WHERE a.client_id = ?
      ORDER BY a.date DESC, a.start_time DESC LIMIT 30`).all(c.id),
    assessments: db.prepare('SELECT id, scale, date, total, severity, alert, filled_by FROM assessments WHERE client_id = ? ORDER BY date DESC').all(c.id),
    packages: db.prepare('SELECT * FROM packages WHERE client_id = ? ORDER BY id DESC').all(c.id),
    invoices: db.prepare('SELECT * FROM invoices WHERE client_id = ? ORDER BY date DESC, id DESC LIMIT 30').all(c.id),
    risk_events: db.prepare('SELECT * FROM risk_events WHERE client_id = ? ORDER BY date DESC').all(c.id),
    unpaid: db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM invoices WHERE client_id = ? AND status = 'unpaid'").get(c.id).n,
    groups: db.prepare(`SELECT g.id, g.name, g.status, m.status AS member_status FROM group_members m
      JOIN groups g ON g.id = m.group_id WHERE m.client_id = ?`).all(c.id)
  });
});

router.post('/clients', requireStaff('clients'), (req, res) => {
  const data = pick(req.body);
  if (!data.name) return res.status(400).json({ error: '請填寫姓名' });
  data.code = req.body.code || nextClientCode();
  if (db.prepare('SELECT 1 FROM clients WHERE code = ?').get(data.code)) {
    return res.status(400).json({ error: '個案編號重複' });
  }
  if (!data.intake_date) data.intake_date = today();
  applyMinor(data);
  const warn = idNoWarning(data.id_no);
  // 個案端預設密碼為手機末 6 碼（首次登入強制更換）
  const phone = (data.phone || '').replace(/\D/g, '');
  data.password_hash = phone.length >= 6 ? bcrypt.hashSync(phone.slice(-6), 10) : '';
  const cols = Object.keys(data);
  const info = db.prepare(`INSERT INTO clients (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(k => data[k]));
  audit('staff', req.user.id, req.user.name, '新增個案', data.code);
  res.json({ id: info.lastInsertRowid, code: data.code, warning: warn });
});

router.put('/clients/:id', requireStaff('clients'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const data = pick(req.body);
  if (!Object.keys(data).length) return res.json({ ok: true });
  if (data.status === 'closed' && !data.close_date) data.close_date = today();
  applyMinor(data, c.birth_date);
  const warn = idNoWarning(data.id_no);
  db.prepare(`UPDATE clients SET ${Object.keys(data).map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(data), c.id);
  audit('staff', req.user.id, req.user.name, '修改個案資料', c.code);
  // 由未結案轉為結案時，依系統設定自動建立結案後的關懷追蹤點
  let followUps = 0;
  if (data.status === 'closed' && c.status !== 'closed') {
    followUps = createCloseFollowUps({ ...c, ...data }, req.user.id);
  }
  res.json({ ok: true, warning: warn, follow_ups: followUps });
});

// 停用（軟刪除）：心理紀錄依規定需保存，不提供實體刪除。
// 未來的預約要一併取消，否則會繼續佔用心理師時段與諮商室，排班表上出現已結案個案的幽靈預約。
router.delete('/clients/:id', requireStaff('clients'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  let cancelled = 0;
  db.transaction(() => {
    db.prepare("UPDATE clients SET active = 0, status = 'closed', close_date = CASE WHEN close_date = '' THEN ? ELSE close_date END WHERE id = ?")
      .run(today(), c.id);
    const info = db.prepare(`UPDATE appointments SET status = 'cancelled', cancel_reason = '個案停用'
      WHERE client_id = ? AND status IN ('booked','arrived') AND date >= ?`).run(c.id, today());
    cancelled = info.changes;
    // 未完成的團體成員身分一併標記退出
    db.prepare("UPDATE group_members SET status = 'dropped' WHERE client_id = ? AND status = 'active'").run(c.id);
  })();
  const followUps = c.status !== 'closed'
    ? createCloseFollowUps({ ...c, status: 'closed', close_date: c.close_date || today() }, req.user.id)
    : 0;
  audit('staff', req.user.id, req.user.name, '停用個案', c.code, { cancelled_appointments: cancelled });
  res.json({ ok: true, cancelled_appointments: cancelled, follow_ups: followUps });
});

// 重設個案端密碼為手機末 6 碼
router.post('/clients/:id/reset-password', requireStaff('clients'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const phone = (c.phone || '').replace(/\D/g, '');
  if (phone.length < 6) return res.status(400).json({ error: '個案未留存有效手機號碼，無法重設' });
  db.prepare('UPDATE clients SET password_hash = ?, must_change_password = 1 WHERE id = ?')
    .run(bcrypt.hashSync(phone.slice(-6), 10), c.id);
  audit('staff', req.user.id, req.user.name, '重設個案端密碼', c.code);
  res.json({ ok: true, password: phone.slice(-6) });
});

// ---- 同意書 ----

router.get('/consent-templates', requireStaff(), (req, res) => {
  res.json(db.prepare('SELECT * FROM consent_templates ORDER BY sort, id').all());
});

// 新增同意書範本：key 是程式用的識別碼，僅收英數與底線，避免與既有範本撞號
router.post('/consent-templates', requireStaff('settings'), (req, res) => {
  const b = req.body || {};
  const key = String(b.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  const title = String(b.title || '').trim();
  if (!key) return res.status(400).json({ error: '請填寫識別碼（英數與底線）' });
  if (!title) return res.status(400).json({ error: '請填寫標題' });
  if (db.prepare('SELECT 1 FROM consent_templates WHERE key = ?').get(key)) {
    return res.status(400).json({ error: '此識別碼已存在' });
  }
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0) n FROM consent_templates').get().n;
  const info = db.prepare(`INSERT INTO consent_templates (key, title, body, required, allow_decline, minor_only, sort)
    VALUES (?,?,?,?,?,?,?)`).run(key, title, String(b.body || ''),
    b.required ? 1 : 0, b.allow_decline ? 1 : 0, b.minor_only ? 1 : 0, maxSort + 1);
  audit('staff', req.user.id, req.user.name, '新增同意書範本', key);
  res.json({ id: info.lastInsertRowid });
});

// 刪除範本：已有人簽署過就只能停用，簽署紀錄必須留著
router.delete('/consent-templates/:id', requireStaff('settings'), (req, res) => {
  const t = db.prepare('SELECT * FROM consent_templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此範本' });
  const signed = db.prepare('SELECT COUNT(*) n FROM consents WHERE key = ?').get(t.key).n;
  if (signed) {
    db.prepare('UPDATE consent_templates SET active = 0 WHERE id = ?').run(t.id);
    audit('staff', req.user.id, req.user.name, '停用同意書範本', t.key, { signed });
    return res.json({ ok: true, disabled: true, message: `已有 ${signed} 筆簽署紀錄，改為停用（不再要求新個案簽署）` });
  }
  db.prepare('DELETE FROM consent_templates WHERE id = ?').run(t.id);
  audit('staff', req.user.id, req.user.name, '刪除同意書範本', t.key);
  res.json({ ok: true, disabled: false });
});

router.put('/consent-templates/:id', requireStaff('settings'), (req, res) => {
  const t = db.prepare('SELECT * FROM consent_templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此範本' });
  const { title = t.title, body = t.body, required, allow_decline, minor_only } = req.body || {};
  // 內容有變動即遞增版本，已簽署者需重新簽署新版
  const version = body !== t.body ? t.version + 1 : t.version;
  const active = (req.body || {}).active;
  db.prepare(`UPDATE consent_templates SET title = ?, body = ?, version = ?, required = ?, allow_decline = ?,
      minor_only = ?, active = ? WHERE id = ?`)
    .run(title, body, version,
      required === undefined ? t.required : (required ? 1 : 0),
      allow_decline === undefined ? t.allow_decline : (allow_decline ? 1 : 0),
      minor_only === undefined ? t.minor_only : (minor_only ? 1 : 0),
      active === undefined ? t.active : (active ? 1 : 0), t.id);
  audit('staff', req.user.id, req.user.name, '修改同意書範本', t.key, { version });
  res.json({ ok: true, version });
});

router.get('/clients/:id/consents/:key', requireStaff('consents'), (req, res) => {
  const t = db.prepare('SELECT * FROM consent_templates WHERE key = ?').get(req.params.key);
  if (!t) return res.status(404).json({ error: '找不到此同意書' });
  const signed = db.prepare('SELECT * FROM consents WHERE client_id = ? AND key = ? ORDER BY id DESC LIMIT 1')
    .get(req.params.id, req.params.key);
  res.json({ template: t, signed: signed || null });
});

// 由所內裝置當場簽署（個案端也可簽，見 portal.js）
router.post('/clients/:id/consents', requireStaff('consents'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const { key, agreed = 1, signer_name = '', signer_role = 'client', signature = '' } = req.body || {};
  const t = db.prepare('SELECT * FROM consent_templates WHERE key = ?').get(key || '');
  if (!t) return res.status(400).json({ error: '找不到此同意書範本' });
  if (!agreed && !t.allow_decline) return res.status(400).json({ error: '此同意書為必要項目，不得選擇不同意' });
  if (!signer_name) return res.status(400).json({ error: '請填寫簽署人姓名' });
  if (c.is_minor && t.minor_only && signer_role !== 'guardian') {
    return res.status(400).json({ error: '此同意書須由法定代理人簽署' });
  }
  db.prepare(`INSERT INTO consents (client_id, key, title, body, version, agreed, signer_name, signer_role, signature, signed_ip)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(c.id, t.key, t.title, t.body, t.version, agreed ? 1 : 0, signer_name, signer_role, signature, clientIp(req));
  audit('staff', req.user.id, req.user.name, '登錄同意書', `${c.code}/${t.key}`, { agreed: !!agreed });
  res.json({ ok: true });
});

// 撤銷已登錄的同意書：簽錯人、重複登錄時用；一律留稽核軌跡
router.delete('/consents/:id', requireStaff('consents'), (req, res) => {
  const row = db.prepare('SELECT * FROM consents WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到此紀錄' });
  const c = db.prepare('SELECT code FROM clients WHERE id = ?').get(row.client_id);
  db.prepare('DELETE FROM consents WHERE id = ?').run(row.id);
  audit('staff', req.user.id, req.user.name, '撤銷同意書簽署紀錄',
    `${c ? c.code : row.client_id}/${row.key}`, { version: row.version, signer: row.signer_name });
  res.json({ ok: true });
});

router.get('/consents/:id', requireStaff('consents'), (req, res) => {
  const row = db.prepare('SELECT * FROM consents WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到此紀錄' });
  res.json(row);
});

// ---- 結案摘要（結案時產出，內容取自處遇計畫與晤談次數）----
router.get('/clients/:id/summary', requireStaff('clients'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const done = db.prepare("SELECT COUNT(*) n FROM appointments WHERE client_id = ? AND status = 'done'").get(c.id).n;
  const first = db.prepare("SELECT MIN(date) d FROM appointments WHERE client_id = ? AND status = 'done'").get(c.id).d;
  const last = db.prepare("SELECT MAX(date) d FROM appointments WHERE client_id = ? AND status = 'done'").get(c.id).d;
  const plan = db.prepare('SELECT * FROM treatment_plans WHERE client_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
  const goals = plan ? db.prepare('SELECT * FROM plan_goals WHERE plan_id = ? ORDER BY sort, id').all(plan.id) : [];
  const scales = db.prepare(`SELECT scale, MIN(date) first_date, MAX(date) last_date FROM assessments
                             WHERE client_id = ? GROUP BY scale`).all(c.id).map(s => {
    const f = db.prepare('SELECT total, severity FROM assessments WHERE client_id = ? AND scale = ? ORDER BY date LIMIT 1').get(c.id, s.scale);
    const l = db.prepare('SELECT total, severity FROM assessments WHERE client_id = ? AND scale = ? ORDER BY date DESC LIMIT 1').get(c.id, s.scale);
    return { ...s, first_total: f.total, first_severity: f.severity, last_total: l.total, last_severity: l.severity };
  });
  res.json({
    client: { code: c.code, name: c.name, main_issue: c.main_issue, intake_date: c.intake_date, close_date: c.close_date, close_reason: c.close_reason },
    sessions: done, first_date: first, last_date: last,
    center_name: getSetting('center_name'),
    plan: plan ? { ...plan, goals } : null,
    scales,
    risk_events: db.prepare('SELECT date, type, severity, status FROM risk_events WHERE client_id = ? ORDER BY date').all(c.id),
    referrals: db.prepare('SELECT date, direction, target, reason, status FROM referrals WHERE client_id = ? ORDER BY date').all(c.id),
    follow_ups: db.prepare('SELECT due_date, kind, status, channel, result FROM follow_ups WHERE client_id = ? ORDER BY due_date').all(c.id)
  });
});

module.exports = router;
