const express = require('express');
const { db, audit, today, addDays, getSetting, nowStamp } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

// 排班與專業人員（M3）
//
// 這一段真正的重點是 M3-02：「可排時段」是產能的分母。
// 現行系統缺的不是排班表，而是「這個分母是誰說了算」——
// 心理師自己在格子上點一點就改掉分母，利用率就失去意義。
// 所以改成：按月／季提交 → 排班負責人核定 → 核定版本才進 availability。

const toMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
const HOURS = blocks => Math.round(blocks.reduce((n, b) => n + (toMin(b.end_time) - toMin(b.start_time)), 0) / 6) / 10;

function subRow(id) {
  return db.prepare(`SELECT s.*, u.name AS counselor_name, u.hire_date, si.name AS site_name,
      a.name AS approved_name
    FROM availability_submissions s
    JOIN users u ON u.id = s.counselor_id
    LEFT JOIN sites si ON si.id = s.site_id
    LEFT JOIN users a ON a.id = s.approved_by
    WHERE s.id = ?`).get(id);
}

function parseBlocks(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const b of arr) {
    const wd = Number(b.weekday);
    const st = String(b.start_time || '');
    const et = String(b.end_time || '');
    if (!(wd >= 0 && wd <= 6)) continue;
    if (!/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(et)) continue;
    if (toMin(et) <= toMin(st)) continue;
    out.push({ weekday: wd, start_time: st, end_time: et });
  }
  // 同一天相鄰或重疊的時段合併，避免分母被重複計算
  const byDay = new Map();
  for (const b of out) {
    if (!byDay.has(b.weekday)) byDay.set(b.weekday, []);
    byDay.get(b.weekday).push(b);
  }
  const merged = [];
  for (const [wd, list] of byDay) {
    list.sort((a, b) => a.start_time.localeCompare(b.start_time));
    let cur = null;
    for (const b of list) {
      if (cur && b.start_time <= cur.end_time) {
        if (b.end_time > cur.end_time) cur.end_time = b.end_time;
      } else {
        cur = { weekday: wd, start_time: b.start_time, end_time: b.end_time };
        merged.push(cur);
      }
    }
  }
  return merged.sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time));
}

// ---- 提交與核定 ----
router.get('/availability/submissions', requireStaff('schedule'), (req, res) => {
  const where = [], args = [];
  if (req.query.period) { where.push('s.period = ?'); args.push(String(req.query.period)); }
  if (req.query.status) { where.push('s.status = ?'); args.push(String(req.query.status)); }
  if (req.query.mine === '1') { where.push('s.counselor_id = ?'); args.push(req.user.id); }
  const rows = db.prepare(`SELECT s.*, u.name AS counselor_name, si.name AS site_name, a.name AS approved_name
    FROM availability_submissions s
    JOIN users u ON u.id = s.counselor_id
    LEFT JOIN sites si ON si.id = s.site_id
    LEFT JOIN users a ON a.id = s.approved_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.period DESC, s.status = 'submitted' DESC, u.id`).all(...args);
  res.json({
    rows: rows.map(r => ({ ...r, blocks: JSON.parse(r.blocks || '[]') })),
    counts: {
      submitted: db.prepare("SELECT COUNT(*) n FROM availability_submissions WHERE status = 'submitted'").get().n,
      approved: db.prepare("SELECT COUNT(*) n FROM availability_submissions WHERE status = 'approved'").get().n,
      returned: db.prepare("SELECT COUNT(*) n FROM availability_submissions WHERE status = 'returned'").get().n
    },
    // 這個期間還沒送審的心理師——排班負責人最需要看的就是這一份
    missing: db.prepare(`SELECT u.id, u.name FROM users u
      WHERE u.active = 1 AND u.role IN ('counselor','supervisor')
        AND NOT EXISTS (SELECT 1 FROM availability_submissions s
          WHERE s.counselor_id = u.id AND s.period = ?)
      ORDER BY u.id`).all(String(req.query.period || today().slice(0, 7)))
  });
});

// 心理師提交（管理者可代提交）
router.post('/availability/submissions', requireStaff('schedule'), (req, res) => {
  const b = req.body || {};
  const counselorId = Number(b.counselor_id) || req.user.id;
  if (counselorId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只能提交自己的可預約時段' });
  }
  const period = String(b.period || today().slice(0, 7));
  if (!/^\d{4}-(\d{2}|Q[1-4])$/.test(period)) return res.status(400).json({ error: '期間格式應為 2026-09 或 2026-Q4' });
  const blocks = parseBlocks(b.blocks);
  if (!blocks.length) return res.status(400).json({ error: '請至少提交一個可預約時段' });
  const siteId = Number(b.site_id) || null;
  const exist = db.prepare(`SELECT * FROM availability_submissions
    WHERE counselor_id = ? AND period = ? AND (site_id IS ? OR site_id = ?)`)
    .get(counselorId, period, siteId, siteId);
  if (exist && exist.status === 'approved' && !b.resubmit) {
    return res.status(400).json({ error: '此期間已核定；如需調整請按「重新送審」' });
  }
  const payload = [JSON.stringify(blocks), HOURS(blocks), String(b.note || ''), nowStamp()];
  if (exist) {
    db.prepare(`UPDATE availability_submissions SET blocks = ?, weekly_hours = ?, note = ?, submitted_at = ?,
        status = 'submitted', approved_by = NULL, approved_at = '', review_note = '' WHERE id = ?`)
      .run(...payload, exist.id);
    audit('staff', req.user.id, req.user.name, '重新提交可預約時段', String(exist.id), { period });
    return res.json({ id: exist.id, resubmitted: true });
  }
  const info = db.prepare(`INSERT INTO availability_submissions
      (counselor_id, period, period_type, site_id, status, blocks, weekly_hours, note, submitted_at)
    VALUES (?,?,?,?, 'submitted', ?,?,?,?)`)
    .run(counselorId, period, period.includes('Q') ? 'quarter' : 'month', siteId,
      JSON.stringify(blocks), HOURS(blocks), String(b.note || ''), nowStamp());
  audit('staff', req.user.id, req.user.name, '提交可預約時段', String(info.lastInsertRowid), { period });
  res.json({ id: info.lastInsertRowid });
});

// 核定：核定過的版本才寫進 availability（實際可被預約的時段）
router.post('/availability/submissions/:id/approve', requireStaff('settings'), (req, res) => {
  const s = subRow(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此提交' });
  if (s.status === 'approved') return res.status(400).json({ error: '此提交已核定' });
  const blocks = JSON.parse(s.blocks || '[]');
  const tx = db.transaction(() => {
    // 同一位心理師、同一據點的舊時段先清掉，再寫入這次核定的
    db.prepare(`DELETE FROM availability WHERE counselor_id = ?
      AND (site_id IS ? OR site_id = ?)`).run(s.counselor_id, s.site_id, s.site_id);
    const ins = db.prepare(`INSERT INTO availability (counselor_id, weekday, start_time, end_time, site_id, submission_id)
      VALUES (?,?,?,?,?,?)`);
    for (const b of blocks) ins.run(s.counselor_id, b.weekday, b.start_time, b.end_time, s.site_id, s.id);
    db.prepare(`UPDATE availability_submissions SET status = 'approved', approved_by = ?, approved_at = ?,
      review_note = ? WHERE id = ?`).run(req.user.id, nowStamp(), String((req.body || {}).review_note || ''), s.id);
  });
  tx();
  audit('staff', req.user.id, req.user.name, '核定可預約時段', String(s.id),
    { counselor: s.counselor_name, period: s.period, hours: s.weekly_hours });
  res.json({ ok: true, blocks: blocks.length, weekly_hours: s.weekly_hours });
});

router.post('/availability/submissions/:id/return', requireStaff('settings'), (req, res) => {
  const s = subRow(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此提交' });
  const note = String((req.body || {}).review_note || '').trim();
  if (!note) return res.status(400).json({ error: '請說明退回原因，心理師才知道要怎麼改' });
  db.prepare("UPDATE availability_submissions SET status = 'returned', review_note = ? WHERE id = ?")
    .run(note, s.id);
  audit('staff', req.user.id, req.user.name, '退回可預約時段', String(s.id), { note });
  res.json({ ok: true });
});

router.delete('/availability/submissions/:id', requireStaff('schedule'), (req, res) => {
  const s = subRow(req.params.id);
  if (!s) return res.status(404).json({ error: '找不到此提交' });
  if (s.counselor_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只能刪除自己的提交' });
  }
  if (s.status === 'approved') return res.status(400).json({ error: '已核定的版本不可刪除；請重新送審取代' });
  db.prepare('DELETE FROM availability_submissions WHERE id = ?').run(s.id);
  audit('staff', req.user.id, req.user.name, '刪除可預約時段提交', String(s.id));
  res.json({ ok: true });
});

// ---- 產能（利用率的分母）----
// 分母＝核定後的每週可排時數 × 該月週數；分子＝實際完成的晤談時數（未到不算）
function capacityOf(counselorId, month) {
  const subs = db.prepare(`SELECT * FROM availability_submissions
    WHERE counselor_id = ? AND status = 'approved'`).all(counselorId);
  const weekly = subs.reduce((n, s) => n + s.weekly_hours, 0);
  const [y, m] = month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  return Math.round(weekly * (days / 7) * 10) / 10;
}

router.get('/staffing/capacity', requireStaff('schedule'), (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  const rows = db.prepare(`SELECT id, name, hire_date, target_utilization, license_type, contract_type
    FROM users WHERE active = 1 AND role IN ('counselor','supervisor') ORDER BY id`).all();
  const target = Number(getSetting('target_utilization', '70'));
  const out = rows.map(u => {
    const capacity = capacityOf(u.id, month);
    const done = db.prepare(`SELECT COALESCE(SUM((strftime('%s', date || ' ' || end_time)
        - strftime('%s', date || ' ' || start_time)) / 3600.0), 0) h,
        COUNT(*) n
      FROM appointments WHERE counselor_id = ? AND substr(date,1,7) = ? AND status = 'done'`).get(u.id, month);
    const hours = Math.round(done.h * 10) / 10;
    return {
      ...u,
      capacity_hours: capacity,
      done_hours: hours,
      sessions: done.n,
      // 未到不計入分子：那段時間確實被佔住，但沒有產生服務
      utilization: capacity ? Math.round(hours / capacity * 1000) / 10 : null,
      target: u.target_utilization || target
    };
  });
  res.json({ month, target, rows: out });
});

// ---- Ramp-up 追蹤（M3-05）----
// 到職後連續兩個月達標即視為完成 Ramp-up
router.get('/staffing/rampup', requireStaff('hr'), (req, res) => {
  const limit = Number(getSetting('rampup_months', '6'));
  const target = Number(getSetting('target_utilization', '70'));
  const rows = db.prepare(`SELECT id, name, hire_date, target_utilization FROM users
    WHERE active = 1 AND role IN ('counselor','supervisor') AND hire_date <> '' ORDER BY hire_date DESC`).all();
  const out = rows.map(u => {
    const t = u.target_utilization || target;
    const months = [];
    const start = new Date(u.hire_date + 'T00:00:00');
    for (let i = 0; i < limit + 6; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (m > today().slice(0, 7)) break;
      const cap = capacityOf(u.id, m);
      const done = db.prepare(`SELECT COALESCE(SUM((strftime('%s', date || ' ' || end_time)
          - strftime('%s', date || ' ' || start_time)) / 3600.0), 0) h
        FROM appointments WHERE counselor_id = ? AND substr(date,1,7) = ? AND status = 'done'`).get(u.id, m).h;
      months.push({ month: m, capacity: cap, hours: Math.round(done * 10) / 10,
        utilization: cap ? Math.round(done / cap * 1000) / 10 : null });
    }
    // 連續兩個月達標的那一刻
    let rampMonths = null;
    for (let i = 1; i < months.length; i++) {
      if ((months[i - 1].utilization || 0) >= t && (months[i].utilization || 0) >= t) { rampMonths = i + 1; break; }
    }
    return {
      ...u, target: t, months,
      months_since_hire: months.length,
      rampup_months: rampMonths,
      status: rampMonths ? 'done' : (months.length > limit ? 'over' : 'ramping')
    };
  });
  res.json({ target, limit, rows: out });
});

// ---- 請假造成的預約異動（M3-03）----
router.get('/time-off/:id/impact', requireStaff('schedule'), (req, res) => {
  const t = db.prepare(`SELECT t.*, u.name AS counselor_name FROM time_off t
    JOIN users u ON u.id = t.counselor_id WHERE t.id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此請假' });
  const rows = db.prepare(`SELECT a.*, c.name AS client_name, c.code AS client_code, c.phone,
      r.name AS room_name
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN rooms r ON r.id = a.room_id
    WHERE a.counselor_id = ? AND a.date BETWEEN ? AND ?
      AND a.status IN ('booked','arrived')
      AND (? = 1 OR (a.start_time < ? AND a.end_time > ?))
    ORDER BY a.date, a.start_time`).all(t.counselor_id, t.start_date, t.end_date,
    t.all_day ? 1 : 0, t.end_time || '23:59', t.start_time || '00:00');
  res.json({
    time_off: t,
    rows,
    // 每一筆都要有結論：改期、換人或取消，否則排班表上會留下無人負責的時段
    pending: rows.length,
    resolved: !!t.resolved
  });
});

router.post('/time-off/:id/resolve', requireStaff('schedule'), (req, res) => {
  const t = db.prepare('SELECT * FROM time_off WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此請假' });
  const remain = db.prepare(`SELECT COUNT(*) n FROM appointments
    WHERE counselor_id = ? AND date BETWEEN ? AND ? AND status IN ('booked','arrived')
      AND (? = 1 OR (start_time < ? AND end_time > ?))`)
    .get(t.counselor_id, t.start_date, t.end_date, t.all_day ? 1 : 0,
      t.end_time || '23:59', t.start_time || '00:00').n;
  if (remain && !(req.body || {}).force) {
    return res.status(400).json({ error: `仍有 ${remain} 筆預約未處理，請逐案改期、換人或取消`, remain });
  }
  db.prepare("UPDATE time_off SET resolved = 1, resolved_at = ? WHERE id = ?").run(nowStamp(), t.id);
  audit('staff', req.user.id, req.user.name, '請假異動處理完成', String(t.id), { remain });
  res.json({ ok: true, remain });
});

// 換人：把預約改派給另一位心理師（會檢查對方時段是否衝突）
router.post('/appointments/:id/reassign', requireStaff('schedule'), (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '找不到此預約' });
  const to = Number((req.body || {}).counselor_id) || 0;
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND active = 1 AND role IN ('counselor','supervisor','admin')").get(to);
  if (!u) return res.status(400).json({ error: '請選擇要接手的心理師' });
  const { conflictOf } = require('./schedule');
  const hit = conflictOf({ ...a, counselor_id: to, id: a.id });
  if (hit) return res.status(400).json({ error: `${hit.kind}時段衝突：${hit.row.start_time}-${hit.row.end_time} 已有預約` });
  db.prepare('UPDATE appointments SET counselor_id = ? WHERE id = ?').run(to, a.id);
  audit('staff', req.user.id, req.user.name, '預約改派心理師', String(a.id),
    { from: a.counselor_id, to, date: a.date });
  res.json({ ok: true });
});

module.exports = router;
module.exports.capacityOf = capacityOf;
