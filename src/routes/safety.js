const express = require('express');
const { db, audit, today, nowStamp, addDays, getSetting } = require('../db');
const { requireStaff, requireNoteAccess, canViewClientNotes } = require('../auth');

const router = express.Router();

// 安全計畫（Safety Plan）
//
// 與危機事件的分工：危機事件記錄「已經發生的事」與法定通報；安全計畫是「事前與個案一起
// 約定好狀況變差時怎麼做」，是高風險個案的標準照護文件，也是事後最關鍵的紀錄。
//
// 保密層級比照晤談紀錄（主責心理師／督導／管理者），故一律經 requireNoteAccess 把關，
// 且每次調閱都寫入稽核軌跡。
//
// 版本：安全計畫會隨狀況更新，直接覆蓋會失去「當時約定了什麼」的證據力，
// 因此新版本 version+1、舊版本轉 archived 保留可查。

const FIELDS = ['date', 'warning_signs', 'coping_strategies', 'distractions', 'support_contacts',
  'professional_contacts', 'crisis_resources', 'environment_safety', 'reasons_living',
  'note', 'review_date', 'agreed_with_client'];

function pick(b, base = {}) {
  const out = {};
  for (const f of FIELDS) {
    if (b[f] !== undefined) out[f] = f === 'agreed_with_client' ? (b[f] ? 1 : 0) : String(b[f] ?? '');
    else if (base[f] !== undefined) out[f] = base[f];
    else out[f] = f === 'agreed_with_client' ? 1 : '';
  }
  return out;
}

router.get('/clients/:clientId/safety-plans', requireStaff('risk'), requireNoteAccess, (req, res) => {
  const rows = db.prepare(`SELECT s.*, u.name AS counselor_name FROM safety_plans s
    LEFT JOIN users u ON u.id = s.counselor_id WHERE s.client_id = ?
    ORDER BY s.version DESC`).all(req.client.id);
  if (rows.length) audit('staff', req.user.id, req.user.name, '調閱安全計畫', req.client.code, { count: rows.length });
  res.json({
    rows,
    // 新建時預帶：危機資源與預定檢視日由系統設定帶入，減少每次重打
    defaults: {
      crisis_resources: getSetting('safety_plan_resources', ''),
      review_date: addDays(today(), Number(getSetting('safety_plan_review_days', '90'))),
      professional_contacts: [
        req.client.counselor_id
          ? `主責心理師：${(db.prepare('SELECT name FROM users WHERE id = ?').get(req.client.counselor_id) || {}).name || ''}`
          : '',
        `${getSetting('center_name')}　${getSetting('center_phone')}`
      ].filter(Boolean).join('\n')
    }
  });
});

// 新增（或建立新版本）：舊的現行版本轉為 archived
router.post('/clients/:clientId/safety-plans', requireStaff('risk'), requireNoteAccess, (req, res) => {
  if (req.user.role === 'staff') return res.status(403).json({ error: '僅心理師可建立安全計畫' });
  const b = req.body || {};
  const data = pick(b);
  if (!String(data.warning_signs).trim() || !String(data.coping_strategies).trim()) {
    return res.status(400).json({ error: '「警訊」與「自己可以做的因應方式」為必填' });
  }
  const last = db.prepare('SELECT MAX(version) v FROM safety_plans WHERE client_id = ?').get(req.client.id).v || 0;
  const tx = db.transaction(() => {
    db.prepare("UPDATE safety_plans SET status = 'archived' WHERE client_id = ? AND status = 'active'").run(req.client.id);
    return db.prepare(`INSERT INTO safety_plans (client_id, counselor_id, version, date, status,
        warning_signs, coping_strategies, distractions, support_contacts, professional_contacts,
        crisis_resources, environment_safety, reasons_living, note, review_date, agreed_with_client)
      VALUES (?,?,?,?, 'active', ?,?,?,?,?,?,?,?,?,?,?)`).run(
      req.client.id, req.user.id, last + 1, data.date || today(),
      data.warning_signs, data.coping_strategies, data.distractions, data.support_contacts,
      data.professional_contacts, data.crisis_resources, data.environment_safety, data.reasons_living,
      data.note, data.review_date, data.agreed_with_client).lastInsertRowid;
  });
  const id = tx();
  audit('staff', req.user.id, req.user.name, '建立安全計畫', req.client.code, { plan_id: id, version: last + 1 });
  res.json({ id, version: last + 1 });
});

// 修改：只能改現行版本；要留下「當時約定了什麼」請改用新版本
router.put('/safety-plans/:id', requireStaff('risk'), (req, res) => {
  const p = db.prepare('SELECT * FROM safety_plans WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此安全計畫' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
  if (!canViewClientNotes(req.user, client)) return res.status(403).json({ error: '安全計畫僅限主責心理師、督導與管理者存取' });
  if (p.status !== 'active') return res.status(400).json({ error: '舊版本僅供查閱，不可修改' });
  const data = pick(req.body || {}, p);
  db.prepare(`UPDATE safety_plans SET date = ?, warning_signs = ?, coping_strategies = ?, distractions = ?,
      support_contacts = ?, professional_contacts = ?, crisis_resources = ?, environment_safety = ?,
      reasons_living = ?, note = ?, review_date = ?, agreed_with_client = ?, updated_at = ? WHERE id = ?`).run(
    data.date, data.warning_signs, data.coping_strategies, data.distractions, data.support_contacts,
    data.professional_contacts, data.crisis_resources, data.environment_safety, data.reasons_living,
    data.note, data.review_date, data.agreed_with_client, nowStamp(), p.id);
  audit('staff', req.user.id, req.user.name, '修改安全計畫', String(p.client_id), { plan_id: p.id });
  res.json({ ok: true });
});

// 列印用（抬頭帶所別資訊）：安全計畫要印一份給個案帶走，這是它跟其他紀錄最大的不同
router.get('/safety-plans/:id/print', requireStaff('risk'), (req, res) => {
  const p = db.prepare(`SELECT s.*, u.name AS counselor_name, u.license_type, u.license_no,
      c.name AS client_name, c.code AS client_code, c.phone AS client_phone,
      c.emergency_name, c.emergency_phone, c.emergency_relationship
    FROM safety_plans s LEFT JOIN users u ON u.id = s.counselor_id
    JOIN clients c ON c.id = s.client_id WHERE s.id = ?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此安全計畫' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
  if (!canViewClientNotes(req.user, client)) return res.status(403).json({ error: '安全計畫僅限主責心理師、督導與管理者存取' });
  audit('staff', req.user.id, req.user.name, '列印安全計畫', p.client_code, { plan_id: p.id });
  res.json({
    ...p,
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address')
  });
});

// 列管清單：高風險個案是否都有現行安全計畫、是否已逾檢視日
router.get('/safety-plans/overview', requireStaff('risk'), (req, res) => {
  const mine = req.user.role === 'counselor' ? 'AND c.counselor_id = ' + req.user.id : '';
  const rows = db.prepare(`SELECT c.id AS client_id, c.name AS client_name, c.code AS client_code,
      c.risk_level, c.counselor_id, u.name AS counselor_name,
      s.id AS plan_id, s.version, s.date AS plan_date, s.review_date,
      CASE WHEN s.id IS NULL THEN 'missing'
        WHEN s.review_date != '' AND s.review_date <= date('now','localtime') THEN 'due'
        ELSE 'ok' END AS state
    FROM clients c
    LEFT JOIN users u ON u.id = c.counselor_id
    LEFT JOIN safety_plans s ON s.client_id = c.id AND s.status = 'active'
    WHERE c.active = 1 AND c.status != 'closed' AND (c.risk_level IN ('high','medium') OR s.id IS NOT NULL) ${mine}
    ORDER BY (s.id IS NOT NULL), c.risk_level = 'medium', c.code`).all();
  res.json({
    rows,
    // 沒有安全計畫的高風險個案是最該補的，前端據此排序與示警
    missing_high: rows.filter(r => r.state === 'missing' && r.risk_level === 'high').length,
    due: rows.filter(r => r.state === 'due').length
  });
});

// 刪除安全計畫：只允許刪現行版本，刪掉後把上一版改回現行，
// 避免個案在系統裡變成「沒有安全計畫」卻其實談過。
router.delete('/safety-plans/:id', requireStaff('risk'), (req, res) => {
  const p = db.prepare('SELECT * FROM safety_plans WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此安全計畫' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
  if (!canViewClientNotes(req.user, client)) {
    return res.status(403).json({ error: '安全計畫僅限主責心理師、督導與管理者存取' });
  }
  if (p.status !== 'active') return res.status(400).json({ error: '舊版本僅供查閱，不可刪除' });
  const prev = db.prepare(`SELECT * FROM safety_plans WHERE client_id = ? AND id <> ?
    ORDER BY version DESC LIMIT 1`).get(p.client_id, p.id);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM safety_plans WHERE id = ?').run(p.id);
    if (prev) db.prepare("UPDATE safety_plans SET status = 'active' WHERE id = ?").run(prev.id);
  });
  tx();
  audit('staff', req.user.id, req.user.name, '刪除安全計畫', client.code, { version: p.version, restored: prev ? prev.version : null });
  res.json({ ok: true, restored_version: prev ? prev.version : null });
});

module.exports = router;
