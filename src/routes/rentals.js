const express = require('express');
const { db, audit, today, getSetting, listQuery } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

// 場地租借（M4）
//
// 租借與諮商共用同一間房間，但它不是諮商：不進個案系統、不算進服務量與初診轉銜率。
// 兩者唯一交集是「同一個時段不能被佔兩次」，所以衝突檢查要雙向做——
// 排諮商要看租借，排租借也要看諮商。這是整段最容易漏的地方。

const toMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
const hoursOf = (st, et) => Math.round((toMin(et) - toMin(st)) / 6) / 10;

// 雙向衝突：同一間房、同一天、時間交疊者，不論是諮商預約、團體場次或其他租借
function roomConflict({ id, room_id, date, start_time, end_time }) {
  const roomId = Number(room_id) || 0;
  if (!roomId) return null;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  // 虛擬空間（到府外出、視訊）不佔實體房間，可重複使用
  if (room && room.is_virtual) return null;

  const appt = db.prepare(`SELECT a.*, c.name AS client_name FROM appointments a
    LEFT JOIN clients c ON c.id = a.client_id
    WHERE a.room_id = ? AND a.date = ? AND a.status IN ('booked','arrived')
      AND a.start_time < ? AND a.end_time > ? LIMIT 1`).get(roomId, date, end_time, start_time);
  if (appt) return { kind: '諮商預約', row: appt };

  const gs = db.prepare(`SELECT s.*, g.name AS group_name FROM group_sessions s
    JOIN groups g ON g.id = s.group_id
    WHERE s.room_id = ? AND s.date = ? AND s.status != 'cancelled'
      AND s.start_time < ? AND s.end_time > ? LIMIT 1`).get(roomId, date, end_time, start_time);
  if (gs) return { kind: '團體場次', row: gs };

  const rb = db.prepare(`SELECT b.*, r.name AS renter_name FROM room_bookings b
    JOIN renters r ON r.id = b.renter_id
    WHERE b.room_id = ? AND b.date = ? AND b.status != 'cancelled' AND b.id <> ?
      AND b.start_time < ? AND b.end_time > ? LIMIT 1`)
    .get(roomId, date, Number(id) || 0, end_time, start_time);
  if (rb) return { kind: '場地租借', row: rb };
  return null;
}

// ---- 租用人主檔（M4-04）----
const R_FIELDS = ['kind', 'name', 'tax_id', 'contact', 'phone', 'email', 'address', 'contract_no',
  'contract_start', 'contract_end', 'rate_type', 'hourly_rate', 'package_note', 'note'];

router.get('/renters', requireStaff('billing'), (req, res) => {
  res.json(listQuery({
    select: `r.*,
      (SELECT COUNT(*) FROM room_bookings b WHERE b.renter_id = r.id AND b.status <> 'cancelled') AS bookings,
      (SELECT COALESCE(SUM(b.amount),0) FROM room_bookings b
        WHERE b.renter_id = r.id AND b.status = 'done' AND b.settled = 0) AS unsettled`,
    from: 'renters r',
    where: req.query.active === '1' ? ['r.active = 1'] : [],
    args: [],
    search: String(req.query.q || ''),
    searchFields: ['r.name', 'r.tax_id', 'r.contact', 'r.contract_no'],
    order: 'r.active DESC, r.id DESC',
    page: req.query.page, size: Number(req.query.size) || 50, maxSize: 300
  }));
});

router.post('/renters', requireStaff('billing'), (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: '請填寫租用人名稱' });
  const vals = R_FIELDS.map(f => (f === 'hourly_rate' ? Number(b[f]) || 0 : String(b[f] ?? '')));
  const info = db.prepare(`INSERT INTO renters (${R_FIELDS.join(',')})
    VALUES (${R_FIELDS.map(() => '?').join(',')})`).run(...vals);
  audit('staff', req.user.id, req.user.name, '新增租用人', b.name);
  res.json({ id: info.lastInsertRowid });
});

router.put('/renters/:id', requireStaff('billing'), (req, res) => {
  const r = db.prepare('SELECT * FROM renters WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此租用人' });
  const b = { ...r, ...req.body };
  db.prepare(`UPDATE renters SET ${R_FIELDS.map(f => `${f} = ?`).join(', ')}, active = ? WHERE id = ?`)
    .run(...R_FIELDS.map(f => (f === 'hourly_rate' ? Number(b[f]) || 0 : String(b[f] ?? ''))),
      req.body.active === undefined ? r.active : (req.body.active ? 1 : 0), r.id);
  audit('staff', req.user.id, req.user.name, '修改租用人', r.name);
  res.json({ ok: true });
});

router.delete('/renters/:id', requireStaff('billing'), (req, res) => {
  const r = db.prepare('SELECT * FROM renters WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此租用人' });
  const used = db.prepare('SELECT COUNT(*) n FROM room_bookings WHERE renter_id = ?').get(r.id).n;
  if (used) {
    db.prepare('UPDATE renters SET active = 0 WHERE id = ?').run(r.id);
    audit('staff', req.user.id, req.user.name, '停用租用人', r.name, { used });
    return res.json({ ok: true, disabled: true, message: `此租用人有 ${used} 筆租借紀錄，改為停用` });
  }
  db.prepare('DELETE FROM renters WHERE id = ?').run(r.id);
  audit('staff', req.user.id, req.user.name, '刪除租用人', r.name);
  res.json({ ok: true, disabled: false });
});

// ---- 租借預約（M4-05）----
router.get('/room-bookings', requireStaff('schedule'), (req, res) => {
  const where = [], args = [];
  if (req.query.from) { where.push('b.date >= ?'); args.push(String(req.query.from)); }
  if (req.query.to) { where.push('b.date <= ?'); args.push(String(req.query.to)); }
  if (req.query.renter_id) { where.push('b.renter_id = ?'); args.push(Number(req.query.renter_id)); }
  if (req.query.room_id) { where.push('b.room_id = ?'); args.push(Number(req.query.room_id)); }
  if (req.query.status) { where.push('b.status = ?'); args.push(String(req.query.status)); }
  res.json(listQuery({
    select: `b.*, r.name AS renter_name, r.kind AS renter_kind, rm.name AS room_name, s.name AS site_name`,
    from: `room_bookings b JOIN renters r ON r.id = b.renter_id
      JOIN rooms rm ON rm.id = b.room_id
      LEFT JOIN sites s ON s.id = b.site_id`,
    where, args,
    search: String(req.query.q || ''),
    searchFields: ['r.name', 'rm.name', 'b.purpose', 'b.note'],
    order: 'b.date DESC, b.start_time',
    page: req.query.page, size: Number(req.query.size) || 50, maxSize: 300
  }));
});

router.post('/room-bookings', requireStaff('schedule'), (req, res) => {
  const b = req.body || {};
  const renter = db.prepare('SELECT * FROM renters WHERE id = ? AND active = 1').get(Number(b.renter_id) || 0);
  if (!renter) return res.status(400).json({ error: '請選擇啟用中的租用人' });
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND active = 1').get(Number(b.room_id) || 0);
  if (!room) return res.status(400).json({ error: '請選擇可用的空間' });
  const date = String(b.date || '').slice(0, 10);
  const st = String(b.start_time || ''), et = String(b.end_time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(et)) {
    return res.status(400).json({ error: '請填寫日期與起訖時間' });
  }
  if (toMin(et) <= toMin(st)) return res.status(400).json({ error: '結束時間必須晚於開始時間' });
  // 合約期間外的租借要擋，否則月結會算到沒有合約的時段
  if (renter.contract_start && date < renter.contract_start) {
    return res.status(400).json({ error: `此租用人的合約自 ${renter.contract_start} 起生效` });
  }
  if (renter.contract_end && date > renter.contract_end) {
    return res.status(400).json({ error: `此租用人的合約已於 ${renter.contract_end} 到期` });
  }
  const hit = roomConflict({ room_id: room.id, date, start_time: st, end_time: et });
  if (hit) return res.status(400).json({ error: `此空間已被${hit.kind}佔用：${hit.row.start_time}-${hit.row.end_time}` });

  const hours = hoursOf(st, et);
  // 費率順序：本次指定 > 租用人時薪 > 空間牌價
  const rate = Number(b.rate) || renter.hourly_rate || room.rent_rate || 0;
  const amount = renter.rate_type === 'package'
    ? Number(b.amount) || 0                     // 方案制：金額另計，這裡只記時數
    : Math.round(hours * rate);
  const info = db.prepare(`INSERT INTO room_bookings (room_id, renter_id, site_id, date, start_time, end_time,
      hours, rate, amount, purpose, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(room.id, renter.id, room.site_id || null, date, st, et,
    hours, rate, amount, String(b.purpose || ''), String(b.note || ''), req.user.id);
  audit('staff', req.user.id, req.user.name, '新增場地租借', renter.name, { date, room: room.name, hours });
  res.json({ id: info.lastInsertRowid, hours, amount, rate_type: renter.rate_type });
});

router.put('/room-bookings/:id', requireStaff('schedule'), (req, res) => {
  const r = db.prepare('SELECT * FROM room_bookings WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此租借' });
  if (r.settled) return res.status(400).json({ error: '已結算的租借不可修改' });
  const b = { ...r, ...req.body };
  const hit = roomConflict({ id: r.id, room_id: b.room_id, date: b.date, start_time: b.start_time, end_time: b.end_time });
  if (hit) return res.status(400).json({ error: `此空間已被${hit.kind}佔用：${hit.row.start_time}-${hit.row.end_time}` });
  const hours = hoursOf(b.start_time, b.end_time);
  const amount = Number(b.rate) ? Math.round(hours * Number(b.rate)) : Number(b.amount) || 0;
  db.prepare(`UPDATE room_bookings SET room_id = ?, date = ?, start_time = ?, end_time = ?, hours = ?,
      rate = ?, amount = ?, purpose = ?, status = ?, note = ? WHERE id = ?`)
    .run(Number(b.room_id), b.date, b.start_time, b.end_time, hours, Number(b.rate) || 0, amount,
      b.purpose || '', b.status || r.status, b.note || '', r.id);
  audit('staff', req.user.id, req.user.name, '修改場地租借', String(r.id));
  res.json({ ok: true, hours, amount });
});

router.delete('/room-bookings/:id', requireStaff('schedule'), (req, res) => {
  const r = db.prepare('SELECT * FROM room_bookings WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此租借' });
  if (r.settled) return res.status(400).json({ error: '已結算的租借不可刪除' });
  db.prepare('DELETE FROM room_bookings WHERE id = ?').run(r.id);
  audit('staff', req.user.id, req.user.name, '刪除場地租借', String(r.id));
  res.json({ ok: true });
});

// ---- 月結對帳單（M4-06）----
router.get('/rentals/statement', requireStaff('billing'), (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  const renterId = Number(req.query.renter_id) || 0;
  const where = ["substr(b.date,1,7) = ?", "b.status <> 'cancelled'"];
  const args = [month];
  if (renterId) { where.push('b.renter_id = ?'); args.push(renterId); }
  const rows = db.prepare(`SELECT b.*, r.name AS renter_name, r.kind AS renter_kind, r.tax_id,
      r.rate_type, r.package_note, rm.name AS room_name, s.name AS site_name
    FROM room_bookings b
    JOIN renters r ON r.id = b.renter_id
    JOIN rooms rm ON rm.id = b.room_id
    LEFT JOIN sites s ON s.id = b.site_id
    WHERE ${where.join(' AND ')} ORDER BY b.renter_id, b.date, b.start_time`).all(...args);

  const groups = [];
  for (const r of rows) {
    let g = groups.find(x => x.renter_id === r.renter_id);
    if (!g) {
      g = {
        renter_id: r.renter_id, renter_name: r.renter_name, kind: r.renter_kind,
        tax_id: r.tax_id, rate_type: r.rate_type, package_note: r.package_note,
        hours: 0, amount: 0, sessions: 0, settled: 0, rows: []
      };
      groups.push(g);
    }
    g.hours = Math.round((g.hours + r.hours) * 10) / 10;
    g.amount += r.amount;
    g.sessions++;
    if (r.settled) g.settled += r.amount;
    g.rows.push(r);
  }
  res.json({
    month, groups,
    total: {
      hours: Math.round(rows.reduce((n, r) => n + r.hours, 0) * 10) / 10,
      amount: rows.reduce((n, r) => n + r.amount, 0),
      bookings: rows.length,
      unsettled: rows.filter(r => !r.settled).reduce((n, r) => n + r.amount, 0)
    },
    center_name: getSetting('center_name'),
    center_tax_id: getSetting('center_tax_id'),
    center_phone: getSetting('center_phone')
  });
});

router.post('/rentals/settle', requireStaff('billing'), (req, res) => {
  const b = req.body || {};
  const month = String(b.month || today().slice(0, 7));
  const renterId = Number(b.renter_id) || 0;
  if (!renterId) return res.status(400).json({ error: '請指定租用人' });
  const info = db.prepare(`UPDATE room_bookings SET settled = 1, billed_month = ?
    WHERE renter_id = ? AND substr(date,1,7) = ? AND status <> 'cancelled' AND settled = 0`)
    .run(month, renterId, month);
  audit('staff', req.user.id, req.user.name, '場地租借月結', String(renterId), { month, rows: info.changes });
  res.json({ ok: true, settled: info.changes });
});

// 空間佔用檢視（M4-01／M4-05）：諮商與租借放在同一張表上看，但來源標示清楚
router.get('/rooms/occupancy', requireStaff('schedule'), (req, res) => {
  const date = String(req.query.date || today());
  const siteId = Number(req.query.site_id) || 0;
  const rooms = db.prepare(`SELECT * FROM rooms WHERE active = 1 ${siteId ? 'AND site_id = ?' : ''}
    ORDER BY is_virtual, id`).all(...(siteId ? [siteId] : []));
  const appts = db.prepare(`SELECT a.room_id, a.start_time, a.end_time, a.status, u.name AS counselor_name
    FROM appointments a LEFT JOIN users u ON u.id = a.counselor_id
    WHERE a.date = ? AND a.status IN ('booked','arrived','done')`).all(date);
  const rentals = db.prepare(`SELECT b.room_id, b.start_time, b.end_time, b.purpose, r.name AS renter_name
    FROM room_bookings b JOIN renters r ON r.id = b.renter_id
    WHERE b.date = ? AND b.status <> 'cancelled'`).all(date);
  res.json({
    date,
    // 預設只顯示營業時段，整天 24 小時的格子沒人看得下去
    office_hours: getSetting('office_hours', '08:00-21:00'),
    slot_minutes: 30,
    rooms: rooms.map(r => ({
      ...r,
      // 個案姓名不進這張表：場地檢視是給行政看空間的，不需要臨床資訊
      appointments: appts.filter(a => a.room_id === r.id)
        .map(a => ({ ...a, label: `諮商（${a.counselor_name || ''}）` })),
      rentals: rentals.filter(b => b.room_id === r.id)
        .map(b => ({ ...b, label: `租借（${b.renter_name}）${b.purpose ? '｜' + b.purpose : ''}` }))
    }))
  });
});

module.exports = router;
module.exports.roomConflict = roomConflict;
