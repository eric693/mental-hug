const express = require('express');
const { db, audit, today, listQuery } = require('../db');
const { requireStaff } = require('../auth');
const split = require('../split');

const router = express.Router();

// 分帳規則的維護、模擬與月結（M6）

const V_FIELDS = ['counselor_id', 'project_id', 'site_id', 'appt_type', 'item_type', 'designated',
  'effective_from', 'effective_to', 'counselor_pct', 'fixed_counselor', 'fixed_center', 'priority'];

function cleanVersion(b, base = {}) {
  const out = { ...base };
  for (const f of V_FIELDS) {
    if (b[f] === undefined) continue;
    if (['counselor_id', 'project_id', 'site_id'].includes(f)) out[f] = Number(b[f]) || null;
    else if (['fixed_counselor', 'fixed_center', 'priority'].includes(f)) out[f] = Number(b[f]) || 0;
    else if (f === 'counselor_pct') out[f] = Math.min(100, Math.max(0, Number(b[f]) || 0));
    else out[f] = String(b[f] ?? '');
  }
  if (!out.item_type) out.item_type = 'session';
  if (!out.priority) out.priority = 100;
  return out;
}

router.get('/split-rules', requireStaff('payouts'), (req, res) => {
  const rules = db.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM split_rule_versions v WHERE v.rule_id = r.id) AS versions,
      (SELECT COUNT(*) FROM invoice_splits s WHERE s.rule_id = r.id) AS used
    FROM split_rules r ORDER BY r.active DESC, r.id`).all();
  const versions = db.prepare(`SELECT v.*, u.name AS counselor_name, s.name AS site_name
    FROM split_rule_versions v
    LEFT JOIN users u ON u.id = v.counselor_id
    LEFT JOIN sites s ON s.id = v.site_id
    ORDER BY v.rule_id, v.version DESC`).all();
  res.json({
    rules: rules.map(r => ({ ...r, version_list: versions.filter(v => v.rule_id === r.id) })),
    current: split.currentVersions(today())
  });
});

router.post('/split-rules', requireStaff('payouts'), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: '請填寫規則名稱' });
  const info = db.prepare('INSERT INTO split_rules (name, note) VALUES (?,?)').run(name, String(b.note || ''));
  const v = cleanVersion(b, { rule_id: info.lastInsertRowid, version: 1 });
  const cols = Object.keys(v);
  db.prepare(`INSERT INTO split_rule_versions (${cols.join(',')}, created_by)
    VALUES (${cols.map(() => '?').join(',')}, ?)`).run(...cols.map(c => v[c]), req.user.id);
  audit('staff', req.user.id, req.user.name, '新增分帳規則', name);
  res.json({ id: info.lastInsertRowid });
});

// 改規則＝發新版本。舊版本留著，歷史拆帳仍指向它。
router.post('/split-rules/:id/versions', requireStaff('payouts'), (req, res) => {
  const r = db.prepare('SELECT * FROM split_rules WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此規則' });
  const last = db.prepare('SELECT MAX(version) n FROM split_rule_versions WHERE rule_id = ?').get(r.id).n || 0;
  const prev = db.prepare('SELECT * FROM split_rule_versions WHERE rule_id = ? AND version = ?').get(r.id, last);
  const v = cleanVersion(req.body || {}, { ...(prev || {}), rule_id: r.id, version: last + 1 });
  delete v.id; delete v.created_at; delete v.created_by; delete v.rule_name; delete v.active;
  const cols = Object.keys(v);
  const info = db.prepare(`INSERT INTO split_rule_versions (${cols.join(',')}, created_by)
    VALUES (${cols.map(() => '?').join(',')}, ?)`).run(...cols.map(c => v[c]), req.user.id);
  audit('staff', req.user.id, req.user.name, '新增分帳規則版本', r.name, { version: last + 1 });
  res.json({ id: info.lastInsertRowid, version: last + 1 });
});

router.put('/split-rules/:id', requireStaff('payouts'), (req, res) => {
  const r = db.prepare('SELECT * FROM split_rules WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此規則' });
  const b = req.body || {};
  db.prepare('UPDATE split_rules SET name = ?, note = ?, active = ? WHERE id = ?')
    .run(String(b.name ?? r.name), String(b.note ?? r.note), b.active === undefined ? r.active : (b.active ? 1 : 0), r.id);
  audit('staff', req.user.id, req.user.name, '修改分帳規則', r.name);
  res.json({ ok: true });
});

// 用過的規則不刪除，只停用——刪了歷史拆帳就對不回規則
router.delete('/split-rules/:id', requireStaff('payouts'), (req, res) => {
  const r = db.prepare('SELECT * FROM split_rules WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此規則' });
  const used = db.prepare('SELECT COUNT(*) n FROM invoice_splits WHERE rule_id = ?').get(r.id).n;
  if (used) {
    db.prepare('UPDATE split_rules SET active = 0 WHERE id = ?').run(r.id);
    audit('staff', req.user.id, req.user.name, '停用分帳規則', r.name, { used });
    return res.json({ ok: true, disabled: true, message: `此規則已用於 ${used} 筆拆帳，改為停用（歷史帳不受影響）` });
  }
  db.prepare('DELETE FROM split_rules WHERE id = ?').run(r.id);
  audit('staff', req.user.id, req.user.name, '刪除分帳規則', r.name);
  res.json({ ok: true, disabled: false });
});

// 模擬器（M6-03）
router.post('/split-rules/simulate', requireStaff('payouts'), (req, res) => {
  const b = req.body || {};
  res.json(split.simulate({
    date: b.date || today(),
    amount: Number(b.amount) || 0,
    counselor_id: Number(b.counselor_id) || null,
    site_id: Number(b.site_id) || null,
    project_id: Number(b.project_id) || null,
    appt_type: String(b.appt_type || ''),
    item_type: String(b.item_type || 'session'),
    designated: !!b.designated
  }));
});

// 拆帳結果查詢
router.get('/splits', requireStaff('payouts'), (req, res) => {
  const where = [], args = [];
  if (req.query.month) { where.push('s.month = ?'); args.push(String(req.query.month)); }
  if (req.query.counselor_id) { where.push('s.counselor_id = ?'); args.push(Number(req.query.counselor_id)); }
  res.json(listQuery({
    select: `s.*, u.name AS counselor_name, c.name AS client_name, c.code AS client_code, i.item, i.date`,
    from: `invoice_splits s
      LEFT JOIN users u ON u.id = s.counselor_id
      LEFT JOIN invoices i ON i.id = s.invoice_id
      LEFT JOIN clients c ON c.id = i.client_id`,
    where, args,
    search: String(req.query.q || ''),
    searchFields: ['u.name', 'c.name', 'c.code', 's.rule_label', 'i.item'],
    order: 's.id DESC',
    page: req.query.page, size: Number(req.query.size) || 50, maxSize: 300
  }));
});

// 對單張收費單重新套規則（規則改版後補算，或原本沒規則現在有了）
router.post('/invoices/:id/split', requireStaff('payouts'), (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: '找不到此收費單' });
  const out = split.applySplit(inv, { force: true });
  if (!out.ok) return res.status(400).json({ error: out.reason, ctx: out.ctx });
  audit('staff', req.user.id, req.user.name, '重新拆帳', String(inv.id), { rule: out.split.rule_label });
  res.json(out);
});

// 整月補算：把還沒拆的收款單一次跑完，回報哪些拆不出來
router.post('/splits/recalculate', requireStaff('payouts'), (req, res) => {
  const month = String((req.body || {}).month || today().slice(0, 7));
  const force = !!(req.body || {}).force;
  const rows = db.prepare(`SELECT * FROM invoices WHERE substr(date,1,7) = ? AND status IN ('paid','refunded')
    ORDER BY date, id`).all(month);
  const done = [], failed = [];
  for (const inv of rows) {
    const out = split.applySplit(inv, { force });
    if (out.ok) done.push(inv.id);
    else failed.push({ invoice_id: inv.id, date: inv.date, amount: inv.amount, reason: out.reason });
  }
  audit('staff', req.user.id, req.user.name, '整月重算分帳', month, { done: done.length, failed: failed.length });
  res.json({ month, done: done.length, failed });
});

// 人員月結表（M6-04）
router.get('/splits/settlement', requireStaff('payouts'), (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  res.json(split.monthlySettlement(month, req.query.counselor_id));
});

module.exports = router;
