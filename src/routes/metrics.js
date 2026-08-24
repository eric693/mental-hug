const express = require('express');
const { db, audit, today, listQuery } = require('../db');
const { requireStaff } = require('../auth');
const metrics = require('../metrics');

const router = express.Router();

// 財務與人員績效指標（6.3／6.4）＋ 成本登錄與總部分攤規則

router.get('/metrics/finance', requireStaff('reports'), (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  const profit = metrics.siteProfit(month);
  const all = metrics.revenueOfMonth(month);
  res.json({
    ...profit,
    all,
    ar: metrics.arAging(),
    // 近 12 個月趨勢（圖表用）
    trend: (() => {
      const out = [];
      const [y, m] = month.split('-').map(Number);
      for (let i = 11; i >= 0; i--) {
        const d = new Date(y, m - 1 - i, 1);
        const mm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const r = metrics.revenueOfMonth(mm);
        out.push({ month: mm, revenue: r.revenue, self_pay: r.self_pay });
      }
      return out;
    })()
  });
});

router.get('/metrics/staff', requireStaff('reports'), (req, res) => {
  res.json(metrics.staffMetrics(String(req.query.month || today().slice(0, 7))));
});

// ---- 成本登錄 ----
router.get('/cost-entries', requireStaff('reports'), (req, res) => {
  const where = [], args = [];
  if (req.query.month) { where.push('c.month = ?'); args.push(String(req.query.month)); }
  if (req.query.kind) { where.push('c.kind = ?'); args.push(String(req.query.kind)); }
  res.json(listQuery({
    select: 'c.*, s.name AS site_name, u.name AS user_name',
    from: 'cost_entries c LEFT JOIN sites s ON s.id = c.site_id LEFT JOIN users u ON u.id = c.user_id',
    where, args,
    search: String(req.query.q || ''),
    searchFields: ['c.category', 'c.note', 's.name', 'u.name'],
    order: 'c.month DESC, c.id DESC',
    page: req.query.page, size: Number(req.query.size) || 100, maxSize: 500
  }));
});

router.post('/cost-entries', requireStaff('reports'), (req, res) => {
  const b = req.body || {};
  const month = String(b.month || today().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: '月份格式應為 2026-08' });
  const amount = Number(b.amount) || 0;
  if (!amount) return res.status(400).json({ error: '請填寫金額' });
  const kind = ['direct', 'staff', 'overhead', 'interest', 'depreciation', 'amortization']
    .includes(b.kind) ? b.kind : 'direct';
  // 總部費用不掛據點；據點與人員成本要指定歸屬，否則分攤與績效都算不出來
  if (kind !== 'overhead' && !Number(b.site_id) && !Number(b.user_id)) {
    return res.status(400).json({ error: '請指定歸屬的據點或人員（總部費用請選「總部費用」類別）' });
  }
  const info = db.prepare(`INSERT INTO cost_entries (month, site_id, user_id, kind, category, amount, note, created_by)
    VALUES (?,?,?,?,?,?,?,?)`).run(month, Number(b.site_id) || null, Number(b.user_id) || null,
    kind, String(b.category || ''), amount, String(b.note || ''), req.user.id);
  audit('staff', req.user.id, req.user.name, '登錄成本', month, { kind, amount });
  res.json({ id: info.lastInsertRowid });
});

router.put('/cost-entries/:id', requireStaff('reports'), (req, res) => {
  const c = db.prepare('SELECT * FROM cost_entries WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此成本紀錄' });
  const b = { ...c, ...req.body };
  db.prepare(`UPDATE cost_entries SET month = ?, site_id = ?, user_id = ?, kind = ?, category = ?,
      amount = ?, note = ? WHERE id = ?`).run(b.month, Number(b.site_id) || null, Number(b.user_id) || null,
    b.kind, b.category || '', Number(b.amount) || 0, b.note || '', c.id);
  audit('staff', req.user.id, req.user.name, '修改成本紀錄', String(c.id));
  res.json({ ok: true });
});

router.delete('/cost-entries/:id', requireStaff('reports'), (req, res) => {
  const c = db.prepare('SELECT * FROM cost_entries WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此成本紀錄' });
  db.prepare('DELETE FROM cost_entries WHERE id = ?').run(c.id);
  audit('staff', req.user.id, req.user.name, '刪除成本紀錄', String(c.id), { amount: c.amount });
  res.json({ ok: true });
});

// ---- 總部分攤規則（變更留紀錄）----
router.get('/overhead-rules', requireStaff('reports'), (req, res) => {
  res.json({
    rows: db.prepare(`SELECT o.*, u.name AS by_name FROM overhead_rules o
      LEFT JOIN users u ON u.id = o.created_by ORDER BY o.effective_from DESC, o.id DESC`).all(),
    current: metrics.overheadRule(String(req.query.month || today().slice(0, 7)))
  });
});

router.post('/overhead-rules', requireStaff('reports'), (req, res) => {
  const b = req.body || {};
  const from = String(b.effective_from || today().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(from)) return res.status(400).json({ error: '生效月份格式應為 2026-08' });
  const method = ['revenue', 'sessions', 'headcount', 'equal'].includes(b.method) ? b.method : 'revenue';
  const info = db.prepare(`INSERT INTO overhead_rules (effective_from, method, note, created_by)
    VALUES (?,?,?,?)`).run(from, method, String(b.note || ''), req.user.id);
  // 規則變更本身就是要留痕的事：舊規則不覆蓋，歷史月份仍套用當時的規則
  audit('staff', req.user.id, req.user.name, '新增總部分攤規則', from, { method, note: b.note || '' });
  res.json({ id: info.lastInsertRowid });
});

module.exports = router;
