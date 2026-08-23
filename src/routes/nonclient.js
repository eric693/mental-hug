const express = require('express');
const { db, audit, today, getSetting, nowStamp, listQuery } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

// 非個案服務（M8-01～04）：外派演講、企業講座、其他沒有「個案」的服務。
//
// 過去這類服務只能掛在虛擬個案底下，結果個案數、服務量、初診轉銜率全部被灌水。
// 這裡把它拆成獨立資料表——表單上根本沒有個案欄位，個案統計自然不會算到它，
// 不需要在每張報表上各自記得排除。

const TYPES = { outreach_talk: '外派演講', lecture: '講座課程', other: '其他非個案服務' };
const FIELDS = ['record_type', 'date', 'start_time', 'end_time', 'org_name', 'topic',
  'location', 'site_id', 'user_id', 'attendees', 'fee', 'fee_method', 'note'];

function clean(b, base = {}) {
  const out = { ...base };
  for (const f of FIELDS) {
    if (b[f] === undefined) continue;
    out[f] = ['site_id', 'user_id', 'attendees', 'fee'].includes(f)
      ? (Number(b[f]) || (f === 'site_id' || f === 'user_id' ? null : 0))
      : String(b[f] ?? '');
  }
  if (!TYPES[out.record_type]) out.record_type = 'outreach_talk';
  return out;
}

router.get('/nonclient-services', requireStaff('notes'), (req, res) => {
  const { from = '', to = '', type = '', user_id = '' } = req.query;
  const where = [], args = [];
  if (from) { where.push('n.date >= ?'); args.push(from); }
  if (to) { where.push('n.date <= ?'); args.push(to); }
  if (type) { where.push('n.record_type = ?'); args.push(type); }
  if (user_id) { where.push('n.user_id = ?'); args.push(Number(user_id)); }
  const page = listQuery({
    select: 'n.*, u.name AS user_name, s.name AS site_name',
    from: `nonclient_services n LEFT JOIN users u ON u.id = n.user_id LEFT JOIN sites s ON s.id = n.site_id`,
    where, args,
    search: String(req.query.q || ''),
    searchFields: ['n.org_name', 'n.topic', 'n.location', 'u.name'],
    order: 'n.date DESC, n.id DESC',
    page: req.query.page, size: Number(req.query.size) || 50, maxSize: 300
  });
  const rows = page.rows;
  res.json({
    rows, total: page.total, page: page.page, size: page.size, pages: page.pages,
    types: TYPES,
    // 這些數字刻意與個案統計分開呈現，避免又被混在一起看
    summary: {
      count: rows.length,
      attendees: rows.reduce((n, r) => n + r.attendees, 0),
      fee: rows.reduce((n, r) => n + r.fee, 0)
    }
  });
});

router.post('/nonclient-services', requireStaff('notes'), (req, res) => {
  const b = clean(req.body || {}, { date: today(), user_id: req.user.id });
  if (!b.date) return res.status(400).json({ error: '請填寫日期' });
  if (!String(b.org_name || '').trim()) return res.status(400).json({ error: '請填寫對象單位' });
  const cols = Object.keys(b);
  const info = db.prepare(`INSERT INTO nonclient_services (${cols.join(',')}, created_by)
    VALUES (${cols.map(() => '?').join(',')}, ?)`).run(...cols.map(c => b[c]), req.user.id);
  audit('staff', req.user.id, req.user.name, '新增非個案服務紀錄', String(info.lastInsertRowid),
    { type: b.record_type, org: b.org_name });
  res.json({ id: info.lastInsertRowid });
});

router.put('/nonclient-services/:id', requireStaff('notes'), (req, res) => {
  const r = db.prepare('SELECT * FROM nonclient_services WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此紀錄' });
  const b = clean(req.body || {}, r);
  const cols = FIELDS.filter(f => b[f] !== undefined);
  db.prepare(`UPDATE nonclient_services SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map(c => b[c]), r.id);
  audit('staff', req.user.id, req.user.name, '修改非個案服務紀錄', String(r.id));
  res.json({ ok: true });
});

router.delete('/nonclient-services/:id', requireStaff('notes'), (req, res) => {
  const r = db.prepare('SELECT * FROM nonclient_services WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此紀錄' });
  db.prepare('DELETE FROM nonclient_services WHERE id = ?').run(r.id);
  audit('staff', req.user.id, req.user.name, '刪除非個案服務紀錄', String(r.id), { org: r.org_name });
  res.json({ ok: true });
});

// ---- 歷史虛擬個案紀錄的批次重新標記（M8-04）----
// 舊資料裡「外派演講」被記在虛擬個案名下。這裡把指定個案（或指定紀錄）的晤談紀錄
// 轉為非個案服務：原紀錄刪除前先把內容摘要寫進備註，並在稽核軌跡留下對照，
// 確保「這筆資料去哪了」查得出來。
router.get('/nonclient-services/migration-candidates', requireStaff('notes'), (req, res) => {
  const kw = String(req.query.q || '').trim();
  res.json(db.prepare(`SELECT c.id, c.code, c.name,
      (SELECT COUNT(*) FROM session_notes n WHERE n.client_id = c.id) AS notes,
      (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id) AS appts
    FROM clients c
    WHERE (${kw ? 'c.name LIKE ? OR c.code LIKE ?' : "c.name LIKE '%演講%' OR c.name LIKE '%講座%' OR c.name LIKE '%外派%' OR c.name LIKE '%虛擬%'"})
    ORDER BY notes DESC LIMIT 50`).all(...(kw ? [`%${kw}%`, `%${kw}%`] : [])));
});

router.post('/nonclient-services/migrate', requireStaff('notes'), (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '批次重新標記僅限管理者' });
  const b = req.body || {};
  const ids = Array.isArray(b.note_ids) ? b.note_ids.map(Number).filter(Boolean) : [];
  const clientId = Number(b.client_id) || 0;
  const rows = ids.length
    ? db.prepare(`SELECT * FROM session_notes WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : (clientId ? db.prepare('SELECT * FROM session_notes WHERE client_id = ?').all(clientId) : []);
  if (!rows.length) return res.status(400).json({ error: '請指定要轉換的紀錄或虛擬個案' });
  const type = TYPES[b.record_type] ? b.record_type : 'outreach_talk';
  const org = String(b.org_name || '').trim();
  if (!org) return res.status(400).json({ error: '請填寫對象單位（轉換後的紀錄不再有個案欄位）' });

  const ins = db.prepare(`INSERT INTO nonclient_services
      (record_type, date, org_name, topic, location, user_id, note, migrated_from_note_id, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const del = db.prepare('DELETE FROM session_notes WHERE id = ?');
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      // 只留摘要不留臨床內容：轉出後這筆不再是心理紀錄，不該把 SOAP 帶進非個案表
      const summary = `由歷史紀錄轉入（原紀錄 #${r.id}，${r.date}）`;
      ins.run(type, r.date, org, String(b.topic || ''), String(b.location || ''),
        r.counselor_id, summary, r.id, req.user.id);
      del.run(r.id);
      audit('staff', req.user.id, req.user.name, '歷史紀錄重新標記為非個案服務', String(r.id),
        { to_type: type, org });
      n++;
    }
  });
  tx();
  audit('staff', req.user.id, req.user.name, '批次重新標記完成', String(clientId || ''), { count: n, org });
  res.json({ ok: true, migrated: n, note: '原晤談紀錄已轉為非個案服務，稽核軌跡可查對照' });
});

module.exports = router;
