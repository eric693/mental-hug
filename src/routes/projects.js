const express = require('express');
const { db, audit, today, addDays, listQuery } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

// 機構專案（M7）
//
// 專案不是「另一種收費方式」，而是一組限制：價格固定、時長固定、
// 兩次之間要隔幾天、總共幾次、什麼時候到期，而且多半不向個案收費。
// 這些限制要在「排預約的當下」就檢核——等到月底請款才發現超額，錢已經收不回來了。

const FIELDS = ['code', 'name', 'contract_party', 'contact', 'price', 'duration_min',
  'interval_days', 'valid_months', 'total_sessions', 'charge_client', 'note'];

function clean(b, base = {}) {
  const out = { ...base };
  for (const f of FIELDS) {
    if (b[f] === undefined) continue;
    if (['price', 'duration_min', 'interval_days', 'valid_months', 'total_sessions'].includes(f)) {
      out[f] = Number(b[f]) || 0;
    } else if (f === 'charge_client') out[f] = b[f] ? 1 : 0;
    else out[f] = String(b[f] ?? '');
  }
  return out;
}

// ---- 專案主檔 ----
router.get('/projects', requireStaff('billing'), (req, res) => {
  const where = [], args = [];
  if (req.query.active === '1') where.push('p.active = 1');
  res.json(listQuery({
    select: `p.*,
      (SELECT COUNT(*) FROM client_projects cp WHERE cp.project_id = p.id AND cp.status = 'active') AS active_clients,
      (SELECT COALESCE(SUM(cp.used_sessions),0) FROM client_projects cp WHERE cp.project_id = p.id) AS used_total`,
    from: 'projects p', where, args,
    search: String(req.query.q || ''),
    searchFields: ['p.name', 'p.code', 'p.contract_party'],
    order: 'p.active DESC, p.id DESC',
    page: req.query.page, size: Number(req.query.size) || 50, maxSize: 300
  }));
});

router.post('/projects', requireStaff('billing'), (req, res) => {
  const b = clean(req.body || {});
  if (!String(b.name || '').trim()) return res.status(400).json({ error: '請填寫專案名稱' });
  const cols = Object.keys(b);
  const info = db.prepare(`INSERT INTO projects (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(c => b[c]));
  audit('staff', req.user.id, req.user.name, '新增機構專案', b.name);
  res.json({ id: info.lastInsertRowid });
});

router.put('/projects/:id', requireStaff('billing'), (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此專案' });
  const b = clean(req.body || {}, p);
  if (req.body.active !== undefined) b.active = req.body.active ? 1 : 0;
  const cols = [...FIELDS, 'active'].filter(f => b[f] !== undefined);
  db.prepare(`UPDATE projects SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map(c => b[c]), p.id);
  audit('staff', req.user.id, req.user.name, '修改機構專案', p.name);
  res.json({ ok: true });
});

router.delete('/projects/:id', requireStaff('billing'), (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此專案' });
  const used = db.prepare('SELECT COUNT(*) n FROM client_projects WHERE project_id = ?').get(p.id).n;
  if (used) {
    db.prepare('UPDATE projects SET active = 0 WHERE id = ?').run(p.id);
    audit('staff', req.user.id, req.user.name, '停用機構專案', p.name, { used });
    return res.json({ ok: true, disabled: true, message: `此專案已核給 ${used} 位個案，改為停用（歷史請款不受影響）` });
  }
  db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  audit('staff', req.user.id, req.user.name, '刪除機構專案', p.name);
  res.json({ ok: true, disabled: false });
});

// ---- 個案的專案額度 ----
function quotaRow(id) {
  return db.prepare(`SELECT cp.*, p.name AS project_name, p.code, p.price, p.duration_min,
      p.interval_days, p.total_sessions, p.charge_client, p.contract_party,
      c.name AS client_name, c.code AS client_code
    FROM client_projects cp
    JOIN projects p ON p.id = cp.project_id
    JOIN clients c ON c.id = cp.client_id
    WHERE cp.id = ?`).get(id);
}

// 額度即時餘量（M7-02）：畫面與預約檢核共用同一份計算
function quotaOf(cp) {
  const limit = cp.granted_sessions || cp.total_sessions || 0;
  return {
    ...cp,
    limit,
    remaining: limit ? Math.max(0, limit - cp.used_sessions) : null,   // null＝不限次數
    expired: !!(cp.expire_date && cp.expire_date < today())
  };
}

router.get('/clients/:id/projects', requireStaff('billing'), (req, res) => {
  const rows = db.prepare(`SELECT cp.*, p.name AS project_name, p.code, p.price, p.duration_min,
      p.interval_days, p.total_sessions, p.charge_client, p.contract_party
    FROM client_projects cp JOIN projects p ON p.id = cp.project_id
    WHERE cp.client_id = ? ORDER BY cp.status = 'active' DESC, cp.id DESC`).all(req.params.id);
  res.json(rows.map(quotaOf));
});

router.post('/clients/:id/projects', requireStaff('billing'), (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const b = req.body || {};
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND active = 1').get(Number(b.project_id) || 0);
  if (!p) return res.status(400).json({ error: '請選擇啟用中的專案' });
  const start = String(b.start_date || today()).slice(0, 10);
  // 使用期限由核給日推算，之後改專案設定不影響已核給的個案
  const expire = String(b.expire_date || '').slice(0, 10)
    || (p.valid_months ? addDays(start, p.valid_months * 30) : '');
  try {
    const info = db.prepare(`INSERT INTO client_projects
        (client_id, project_id, granted_sessions, start_date, expire_date, case_no, note)
      VALUES (?,?,?,?,?,?,?)`).run(c.id, p.id, Number(b.granted_sessions) || p.total_sessions,
      start, expire, String(b.case_no || ''), String(b.note || ''));
    audit('staff', req.user.id, req.user.name, '核給專案額度', c.code, { project: p.name });
    res.json({ id: info.lastInsertRowid });
  } catch {
    res.status(400).json({ error: '此個案已有同一專案與案號的額度' });
  }
});

router.put('/client-projects/:id', requireStaff('billing'), (req, res) => {
  const cp = quotaRow(req.params.id);
  if (!cp) return res.status(404).json({ error: '找不到此額度' });
  const b = req.body || {};
  db.prepare(`UPDATE client_projects SET granted_sessions = ?, start_date = ?, expire_date = ?,
      case_no = ?, status = ?, note = ? WHERE id = ?`).run(
    b.granted_sessions === undefined ? cp.granted_sessions : Number(b.granted_sessions) || 0,
    b.start_date === undefined ? cp.start_date : String(b.start_date),
    b.expire_date === undefined ? cp.expire_date : String(b.expire_date),
    b.case_no === undefined ? cp.case_no : String(b.case_no),
    b.status === undefined ? cp.status : String(b.status),
    b.note === undefined ? cp.note : String(b.note), cp.id);
  audit('staff', req.user.id, req.user.name, '修改專案額度', String(cp.id));
  res.json({ ok: true });
});

router.delete('/client-projects/:id', requireStaff('billing'), (req, res) => {
  const cp = quotaRow(req.params.id);
  if (!cp) return res.status(404).json({ error: '找不到此額度' });
  if (cp.used_sessions > 0) {
    return res.status(400).json({ error: `此額度已使用 ${cp.used_sessions} 次，不可刪除；如要停止請改為結案` });
  }
  db.prepare('DELETE FROM client_projects WHERE id = ?').run(cp.id);
  audit('staff', req.user.id, req.user.name, '刪除專案額度', String(cp.id));
  res.json({ ok: true });
});

// 預約前檢核（M7-02）：餘量、期限、間隔天數
// 回 { ok, reason, warn }：ok=false 擋下；warn 只提示（例如剩最後一次）
function checkQuota(clientProjectId, date, ignoreAppointmentId) {
  const cp = quotaRow(clientProjectId);
  if (!cp) return { ok: false, reason: '找不到此專案額度' };
  const q = quotaOf(cp);
  const STATUS_LABEL = { used_up: '已用畢', expired: '已到期', closed: '已結案' };
  if (cp.status !== 'active') {
    return { ok: false, reason: `此專案額度${STATUS_LABEL[cp.status] || '（' + cp.status + '）'}，不可再使用` };
  }
  if (cp.start_date && date < cp.start_date) return { ok: false, reason: `此專案自 ${cp.start_date} 起生效` };
  if (cp.expire_date && date > cp.expire_date) return { ok: false, reason: `此專案額度已於 ${cp.expire_date} 到期` };
  if (q.remaining !== null && q.remaining <= 0) {
    return { ok: false, reason: `此專案核給 ${q.limit} 次已用畢` };
  }
  if (cp.interval_days > 0) {
    const prev = db.prepare(`SELECT date FROM appointments
      WHERE client_project_id = ? AND status IN ('booked','arrived','done') AND id <> ?
        AND date <= ? ORDER BY date DESC LIMIT 1`).get(cp.id, Number(ignoreAppointmentId) || 0, date);
    if (prev) {
      const gap = Math.round((new Date(date) - new Date(prev.date)) / 86400000);
      if (gap < cp.interval_days) {
        return { ok: false, reason: `此專案規定兩次至少間隔 ${cp.interval_days} 天（上次 ${prev.date}，相隔 ${gap} 天）` };
      }
    }
  }
  const warn = q.remaining !== null && q.remaining === 1 ? '這是此專案的最後一次額度' : '';
  return { ok: true, warn, quota: q };
}

router.get('/client-projects/:id/check', requireStaff('schedule'), (req, res) => {
  res.json(checkQuota(req.params.id, String(req.query.date || today()), req.query.appointment_id));
});

// ---- 專案對帳單與請款明細（M7-03）----
router.get('/projects/:id/statement', requireStaff('billing'), (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此專案' });
  const month = String(req.query.month || today().slice(0, 7));
  const rows = db.prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.status,
      c.name AS client_name, c.code AS client_code, cp.case_no,
      u.name AS counselor_name, s.name AS site_name,
      i.id AS invoice_id, i.amount, i.status AS invoice_status
    FROM appointments a
    JOIN client_projects cp ON cp.id = a.client_project_id
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN users u ON u.id = a.counselor_id
    LEFT JOIN sites s ON s.id = a.site_id
    LEFT JOIN invoices i ON i.appointment_id = a.id
    WHERE cp.project_id = ? AND substr(a.date,1,7) = ? AND a.status = 'done'
    ORDER BY a.date, a.start_time`).all(p.id, month);
  const amount = rows.reduce((n, r) => n + (r.amount || p.price), 0);
  audit('staff', req.user.id, req.user.name, '產生專案對帳單', p.name, { month, sessions: rows.length });
  res.json({
    project: p, month, rows,
    summary: {
      sessions: rows.length,
      clients: new Set(rows.map(r => r.client_code)).size,
      amount,
      unit_price: p.price,
      charge_client: !!p.charge_client
    }
  });
});

module.exports = router;
module.exports.checkQuota = checkQuota;
module.exports.quotaOf = quotaOf;
