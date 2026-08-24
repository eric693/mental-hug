const express = require('express');
const { db, audit, today, addDays, getSetting, listSetting, listQuery, pageHeaders } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

// ---- 請假／不可預約時段 ----
// 優先於 availability：請假區間內的時段不會出現在可預約清單，也擋櫃檯下訂。

router.get('/time-off', requireStaff('hr'), (req, res) => {
  const { counselor_id = '', from = today(), to = '' } = req.query;
  const where = ['t.end_date >= ?'], args = [from];
  if (to) { where.push('t.start_date <= ?'); args.push(to); }
  if (counselor_id) { where.push('t.counselor_id = ?'); args.push(Number(counselor_id)); }
  const page = listQuery({
    select: 't.*, u.name AS counselor_name',
    from: 'time_off t JOIN users u ON u.id = t.counselor_id',
    where, args,
    search: String(req.query.q || ''),
    searchFields: ['u.name', 't.reason'],
    order: 't.start_date',
    page: req.query.page, size: Number(req.query.size) || 200, maxSize: 500
  });
  res.json(pageHeaders(res, page));
});

// 修改請假（日期或事由填錯時）
router.put('/time-off/:id', requireStaff('hr'), (req, res) => {
  const t = db.prepare('SELECT * FROM time_off WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此請假紀錄' });
  const b = { ...t, ...req.body };
  if (b.end_date < b.start_date) return res.status(400).json({ error: '結束日不可早於起始日' });
  db.prepare(`UPDATE time_off SET start_date = ?, end_date = ?, all_day = ?, start_time = ?,
      end_time = ?, reason = ?, resolved = ? WHERE id = ?`)
    .run(b.start_date, b.end_date, b.all_day ? 1 : 0, b.all_day ? '' : (b.start_time || ''),
      b.all_day ? '' : (b.end_time || ''), b.reason || '',
      req.body.resolved === undefined ? t.resolved : (req.body.resolved ? 1 : 0), t.id);
  audit('staff', req.user.id, req.user.name, '修改請假紀錄', String(t.id));
  res.json({ ok: true });
});

router.post('/time-off', requireStaff('hr'), (req, res) => {
  const b = req.body || {};
  const cid = Number(b.counselor_id) || req.user.id;
  if (req.user.role !== 'admin' && cid !== req.user.id) {
    return res.status(403).json({ error: '僅能登錄自己的請假' });
  }
  if (!b.start_date) return res.status(400).json({ error: '請填寫起始日期' });
  const end = b.end_date || b.start_date;
  if (end < b.start_date) return res.status(400).json({ error: '結束日期不可早於起始日期' });
  const allDay = b.all_day === undefined ? 1 : (b.all_day ? 1 : 0);
  // 請假期間若已有預約，先擋下來請人工改期，避免個案被放鴿子
  const clash = db.prepare(`SELECT a.date, a.start_time, c.name AS client_name FROM appointments a
    JOIN clients c ON c.id = a.client_id
    WHERE a.counselor_id = ? AND a.status IN ('booked','arrived') AND a.date BETWEEN ? AND ?
      ${allDay ? '' : 'AND a.start_time < ? AND a.end_time > ?'}
    ORDER BY a.date, a.start_time`).all(...(allDay ? [cid, b.start_date, end] : [cid, b.start_date, end, b.end_time || '23:59', b.start_time || '00:00']));
  if (clash.length && !b.force) {
    return res.status(400).json({
      error: `此期間尚有 ${clash.length} 筆預約（最近：${clash[0].date} ${clash[0].start_time} ${clash[0].client_name}），請先改期或勾選仍要登錄`,
      clashes: clash
    });
  }
  const info = db.prepare(`INSERT INTO time_off (counselor_id, start_date, end_date, all_day, start_time, end_time, reason)
    VALUES (?,?,?,?,?,?,?)`).run(cid, b.start_date, end, allDay,
    allDay ? '' : (b.start_time || ''), allDay ? '' : (b.end_time || ''), b.reason || '');
  audit('staff', req.user.id, req.user.name, '登錄請假', String(cid), { from: b.start_date, to: end });
  res.json({ id: info.lastInsertRowid });
});

router.delete('/time-off/:id', requireStaff('hr'), (req, res) => {
  const t = db.prepare('SELECT * FROM time_off WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到此紀錄' });
  if (req.user.role !== 'admin' && t.counselor_id !== req.user.id) {
    return res.status(403).json({ error: '僅能刪除自己的請假' });
  }
  db.prepare('DELETE FROM time_off WHERE id = ?').run(t.id);
  res.json({ ok: true });
});

// ---- 繼續教育積分 ----
// 心理師執業執照每 6 年更新，期間須完成規定積分；其中專業品質、專業倫理、
// 專業相關法規三類合計另有下限。此處以設定值計算，實際規定以主管機關公告為準。

router.get('/ce-credits', requireStaff('hr'), (req, res) => {
  const userId = req.user.role === 'admin' || req.user.role === 'supervisor'
    ? (Number(req.query.user_id) || null) : req.user.id;
  const where = [], args = [];
  if (userId) { where.push('c.user_id = ?'); args.push(userId); }
  res.json(db.prepare(`SELECT c.*, u.name AS user_name FROM ce_credits c JOIN users u ON u.id = c.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.date DESC`).all(...args));
});

router.post('/ce-credits', requireStaff('hr'), (req, res) => {
  const b = req.body || {};
  const uid = Number(b.user_id) || req.user.id;
  if (req.user.role !== 'admin' && uid !== req.user.id) {
    return res.status(403).json({ error: '僅能登錄自己的積分' });
  }
  if (!b.title) return res.status(400).json({ error: '請填寫課程名稱' });
  const info = db.prepare(`INSERT INTO ce_credits (user_id, date, title, organizer, category, hours, credits, cert_no, note)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(uid, b.date || today(), b.title, b.organizer || '',
    b.category || '專業課程', Number(b.hours) || 0, Number(b.credits) || 0, b.cert_no || '', b.note || '');
  res.json({ id: info.lastInsertRowid });
});

router.delete('/ce-credits/:id', requireStaff('hr'), (req, res) => {
  const c = db.prepare('SELECT * FROM ce_credits WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此紀錄' });
  if (req.user.role !== 'admin' && c.user_id !== req.user.id) {
    return res.status(403).json({ error: '僅能刪除自己的積分' });
  }
  db.prepare('DELETE FROM ce_credits WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

// 積分彙總：以「執照更新日往前推一個週期」為計算區間
router.get('/ce-summary', requireStaff('hr'), (req, res) => {
  const cycle = Number(getSetting('ce_cycle_years', '6'));
  const required = Number(getSetting('ce_required_credits', '120'));
  const requiredSpecial = Number(getSetting('ce_required_special', '12'));
  // 特定類別合計下限之外，「專業倫理」另有個別下限，需分開檢核
  const requiredEthics = Number(getSetting('ce_required_ethics', '2'));
  const special = ['專業品質', '專業倫理', '專業相關法規'];
  const users = db.prepare(`SELECT id, name, license_type, license_no, license_expiry FROM users
    WHERE active = 1 AND role IN ('counselor','supervisor','admin') ORDER BY id`).all();
  const scope = req.user.role === 'staff' ? users.filter(u => u.id === req.user.id) : users;
  const rows = scope.map(u => {
    // 未填執照更新日時，以今日往前推一個週期作為概算區間
    const end = u.license_expiry || today();
    const start = addDays(end, -Math.round(cycle * 365.25));
    const list = db.prepare('SELECT category, credits, hours FROM ce_credits WHERE user_id = ? AND date BETWEEN ? AND ?')
      .all(u.id, start, end > today() ? today() : end);
    const total = list.reduce((s, r) => s + r.credits, 0);
    const specialTotal = list.filter(r => special.includes(r.category)).reduce((s, r) => s + r.credits, 0);
    const ethicsTotal = list.filter(r => r.category === '專業倫理').reduce((s, r) => s + r.credits, 0);
    const daysLeft = u.license_expiry
      ? Math.round((new Date(u.license_expiry + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000)
      : null;
    return {
      ...u, cycle_start: start, cycle_end: end,
      total_credits: Math.round(total * 10) / 10,
      special_credits: Math.round(specialTotal * 10) / 10,
      ethics_credits: Math.round(ethicsTotal * 10) / 10,
      total_hours: Math.round(list.reduce((s, r) => s + r.hours, 0) * 10) / 10,
      ok: total >= required && specialTotal >= requiredSpecial && ethicsTotal >= requiredEthics,
      days_left: daysLeft,
      alert: daysLeft !== null && daysLeft <= Number(getSetting('license_alert_days', '180'))
    };
  });
  res.json({ required, required_special: requiredSpecial, required_ethics: requiredEthics,
    cycle, categories: listSetting('ce_categories'), rows });
});

// ---- 心理師報酬與扣繳 ----
// 外聘心理師、督導的鐘點多屬執行業務所得（9A／9B），所方為扣繳義務人，
// 須代扣所得稅並於達門檻時扣繳二代健保補充保費。所得稅率、起扣點皆可於系統設定調整。

// 依給付總額與所得類別算出應扣金額。薪資所得（50）走薪資扣繳表，
// 非本系統試算範圍，故僅計補充保費，所得稅留給人工填。
function calcDeduction(gross, incomeType) {
  const rate = Number(getSetting('withholding_rate', '0.1'));
  const taxMin = Number(getSetting('withholding_min', '20010'));
  const nhiRate = Number(getSetting('nhi_supplement_rate', '0.0211'));
  const nhiMin = Number(getSetting('nhi_supplement_min', '20000'));
  const withholding = incomeType === '50' || gross < taxMin ? 0 : Math.round(gross * rate);
  const nhi = gross >= nhiMin ? Math.round(gross * nhiRate) : 0;
  return { withholding, nhi_supplement: nhi, net: gross - withholding - nhi };
}

// 試算：前端輸入金額時即時顯示，不寫入資料
router.get('/payouts/preview', requireStaff('payouts'), (req, res) => {
  const gross = Number(req.query.gross) || 0;
  res.json({ gross, ...calcDeduction(gross, req.query.income_type || '9B') });
});

router.get('/payouts', requireStaff('payouts'), (req, res) => {
  const { month = '', user_id = '', status = '' } = req.query;
  const where = [], args = [];
  if (month) { where.push('p.month = ?'); args.push(month); }
  if (user_id) { where.push('p.user_id = ?'); args.push(Number(user_id)); }
  if (status) { where.push('p.status = ?'); args.push(status); }
  // 行政人員只看得到自己的報酬明細
  if (req.user.role === 'staff') { where.push('p.user_id = ?'); args.push(req.user.id); }
  if (req.query.q) {
    where.push('(u.name LIKE ? OR p.item LIKE ?)');
    args.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }
  const rows = db.prepare(`SELECT p.*, u.name AS user_name, u.license_type
    FROM payouts p JOIN users u ON u.id = p.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.month DESC, u.name, p.id DESC LIMIT 500`).all(...args);
  const sum = k => rows.reduce((a, b) => a + b[k], 0);
  res.json({
    rows,
    total_gross: sum('gross'),
    total_withholding: sum('withholding'),
    total_nhi: sum('nhi_supplement'),
    total_net: sum('net')
  });
});

// 依當月已完成晤談自動帶出鐘點：省去人工逐筆加總，金額仍可手改
router.get('/payouts/suggest', requireStaff('payouts'), (req, res) => {
  const month = req.query.month || today().slice(0, 7);
  const from = month + '-01', to = month + '-31';
  res.json(db.prepare(`SELECT u.id AS user_id, u.name AS user_name, u.license_type,
      COUNT(*) AS sessions, COALESCE(SUM(a.fee), 0) AS fee_total
    FROM appointments a JOIN users u ON u.id = a.counselor_id
    WHERE a.status = 'done' AND a.date BETWEEN ? AND ?
    GROUP BY u.id ORDER BY u.name`).all(from, to));
});

router.post('/payouts', requireStaff('payouts'), (req, res) => {
  const b = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(b.user_id) || 0);
  if (!u) return res.status(400).json({ error: '請選擇心理師' });
  if (!b.month) return res.status(400).json({ error: '請選擇給付月份' });
  const gross = Number(b.gross) || 0;
  const auto = calcDeduction(gross, b.income_type || '9B');
  // 允許人工覆寫試算結果（例如已另行申報或適用免扣繳）
  const withholding = b.withholding === undefined || b.withholding === '' ? auto.withholding : Number(b.withholding) || 0;
  const nhi = b.nhi_supplement === undefined || b.nhi_supplement === '' ? auto.nhi_supplement : Number(b.nhi_supplement) || 0;
  const info = db.prepare(`INSERT INTO payouts
    (user_id, month, item, sessions, gross, income_type, withholding, nhi_supplement, net, note)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    u.id, b.month, b.item || '晤談鐘點', Number(b.sessions) || 0, gross, b.income_type || '9B',
    withholding, nhi, gross - withholding - nhi, b.note || '');
  audit('staff', req.user.id, req.user.name, '新增報酬單', u.name, { month: b.month, gross });
  res.json({ id: info.lastInsertRowid });
});

router.put('/payouts/:id', requireStaff('payouts'), (req, res) => {
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此報酬單' });
  if (p.status === 'paid') return res.status(400).json({ error: '已付款的報酬單不可修改，請先取消付款' });
  const b = { ...p, ...req.body };
  const gross = Number(b.gross) || 0;
  const withholding = Number(b.withholding) || 0;
  const nhi = Number(b.nhi_supplement) || 0;
  db.prepare(`UPDATE payouts SET month = ?, item = ?, sessions = ?, gross = ?, income_type = ?,
      withholding = ?, nhi_supplement = ?, net = ?, note = ? WHERE id = ?`).run(
    b.month, b.item || '', Number(b.sessions) || 0, gross, b.income_type,
    withholding, nhi, gross - withholding - nhi, b.note || '', p.id);
  audit('staff', req.user.id, req.user.name, '修改報酬單', String(p.user_id), { id: p.id });
  res.json({ ok: true });
});

router.post('/payouts/:id/pay', requireStaff('payouts'), (req, res) => {
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此報酬單' });
  const paid = p.status !== 'paid';
  db.prepare('UPDATE payouts SET status = ?, paid_at = ? WHERE id = ?')
    .run(paid ? 'paid' : 'pending', paid ? today() : '', p.id);
  audit('staff', req.user.id, req.user.name, paid ? '報酬付款' : '取消報酬付款', String(p.user_id), { id: p.id });
  res.json({ ok: true });
});

router.delete('/payouts/:id', requireStaff('payouts'), (req, res) => {
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此報酬單' });
  if (p.status === 'paid') return res.status(400).json({ error: '已付款的報酬單不可刪除' });
  db.prepare('DELETE FROM payouts WHERE id = ?').run(p.id);
  audit('staff', req.user.id, req.user.name, '刪除報酬單', String(p.user_id), { id: p.id });
  res.json({ ok: true });
});

// 各類所得扣繳暨免扣繳憑單所需的年度彙總（依所得人、所得類別）
router.get('/payouts/withholding-summary', requireStaff('payouts'), (req, res) => {
  const year = req.query.year || today().slice(0, 4);
  res.json(db.prepare(`SELECT u.name AS user_name, u.license_type, p.income_type,
      SUM(p.gross) AS gross, SUM(p.withholding) AS withholding,
      SUM(p.nhi_supplement) AS nhi_supplement, SUM(p.net) AS net, COUNT(*) AS items
    FROM payouts p JOIN users u ON u.id = p.user_id
    WHERE substr(p.month, 1, 4) = ? AND p.status = 'paid'
    GROUP BY u.id, p.income_type ORDER BY u.name`).all(year));
});

module.exports = router;
