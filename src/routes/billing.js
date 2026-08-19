const express = require('express');
const { db, audit, today, nowStamp, getSetting, listSetting } = require('../db');
const { requireStaff } = require('../auth');
const { sendNotification } = require('../notify');

const router = express.Router();

function nextReceiptNo() {
  const prefix = getSetting('receipt_prefix', 'MC');
  const ym = today().slice(0, 7).replace('-', '');
  const row = db.prepare("SELECT receipt_no FROM invoices WHERE receipt_no LIKE ? ORDER BY receipt_no DESC LIMIT 1")
    .get(`${prefix}${ym}%`);
  const seq = row ? Number(row.receipt_no.slice(-4)) + 1 : 1;
  return `${prefix}${ym}${String(seq).padStart(4, '0')}`;
}

// ---- 收費單 ----

router.get('/invoices', requireStaff('billing'), (req, res) => {
  const { status = '', client_id = '', from = '', to = '', payer = '' } = req.query;
  const where = [], args = [];
  if (status) { where.push('i.status = ?'); args.push(status); }
  if (payer) { where.push('i.payer = ?'); args.push(payer); }
  if (client_id) { where.push('i.client_id = ?'); args.push(Number(client_id)); }
  if (from) { where.push('i.date >= ?'); args.push(from); }
  if (to) { where.push('i.date <= ?'); args.push(to); }
  const rows = db.prepare(`SELECT i.*, c.name AS client_name, c.code AS client_code, u.name AS counselor_name,
      (SELECT COALESCE(SUM(amount),0) FROM refunds rf WHERE rf.invoice_id = i.id) AS refunded
    FROM invoices i JOIN clients c ON c.id = i.client_id
    LEFT JOIN appointments a ON a.id = i.appointment_id
    LEFT JOIN users u ON u.id = a.counselor_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY i.status = 'paid', i.date DESC, i.id DESC LIMIT 500`).all(...args);
  const sum = k => rows.filter(r => r.status === k).reduce((a, b) => a + b.amount, 0);
  const totalRefunded = rows.reduce((a, b) => a + (b.refunded || 0), 0);
  res.json({
    rows, total_unpaid: sum('unpaid'), total_paid: sum('paid'),
    total_refunded: totalRefunded,
    // 實收：已收款金額扣掉已退還的部分
    total_net: sum('paid') + sum('refunded') - totalRefunded
  });
});

router.post('/invoices', requireStaff('billing'), (req, res) => {
  const b = req.body || {};
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(b.client_id) || 0);
  if (!c) return res.status(400).json({ error: '請選擇個案' });
  if (!b.item) return res.status(400).json({ error: '請填寫項目' });
  const amount = Number(b.amount) || 0;
  // 補助方案：補助額不得超過總額，自付差額自動算出，核銷與收款金額才不會兜不攏
  const subsidy = Math.min(Number(b.subsidy_amount) || 0, amount);
  const info = db.prepare(`INSERT INTO invoices (client_id, appointment_id, package_id, date, item, amount, payer, note,
      buyer_tax_id, buyer_title, invoice_no, invoice_date, carrier, love_code,
      subsidy_program, subsidy_no, subsidy_amount, self_pay)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    c.id, Number(b.appointment_id) || null, Number(b.package_id) || null,
    b.date || today(), b.item, amount,
    b.payer || getSetting('payer_type_default', '自費'), b.note || '',
    (b.buyer_tax_id || '').trim(), b.buyer_title || '', (b.invoice_no || '').trim().toUpperCase(),
    b.invoice_date || '', (b.carrier || '').trim().toUpperCase(), (b.love_code || '').trim(),
    b.subsidy_program || '', b.subsidy_no || '', subsidy, amount - subsidy);
  audit('staff', req.user.id, req.user.name, '新增收費單', c.code, { amount, subsidy });
  res.json({ id: info.lastInsertRowid });
});

router.post('/invoices/:id/pay', requireStaff('billing'), (req, res) => {
  const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!i) return res.status(404).json({ error: '找不到此收費單' });
  if (i.status === 'paid') return res.status(400).json({ error: '此筆已收款' });
  const { method = '現金' } = req.body || {};
  db.prepare("UPDATE invoices SET status = 'paid', method = ?, paid_at = ?, receipt_no = ? WHERE id = ?")
    .run(method, nowStamp(), i.receipt_no || nextReceiptNo(), i.id);
  audit('staff', req.user.id, req.user.name, '收款', String(i.client_id), { id: i.id, amount: i.amount });
  res.json({ ok: true });
});

// 發票號碼、載具、補助核銷資料常在收款後才補登，故已收款者仍可編輯；已作廢者不可改
router.put('/invoices/:id', requireStaff('billing'), (req, res) => {
  const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!i) return res.status(404).json({ error: '找不到此收費單' });
  if (i.status === 'void') return res.status(400).json({ error: '已作廢的收費單不可修改' });
  const b = { ...i, ...req.body };
  const amount = i.status === 'paid' ? i.amount : (Number(b.amount) || 0);
  const subsidy = Math.min(Number(b.subsidy_amount) || 0, amount);
  db.prepare(`UPDATE invoices SET date = ?, item = ?, amount = ?, payer = ?, note = ?,
      buyer_tax_id = ?, buyer_title = ?, invoice_no = ?, invoice_date = ?, carrier = ?, love_code = ?,
      subsidy_program = ?, subsidy_no = ?, subsidy_amount = ?, self_pay = ? WHERE id = ?`).run(
    b.date, b.item, amount, b.payer, b.note || '',
    (b.buyer_tax_id || '').trim(), b.buyer_title || '', (b.invoice_no || '').trim().toUpperCase(),
    b.invoice_date || '', (b.carrier || '').trim().toUpperCase(), (b.love_code || '').trim(),
    b.subsidy_program || '', b.subsidy_no || '', subsidy, amount - subsidy, i.id);
  audit('staff', req.user.id, req.user.name, '修改收費單', String(i.client_id), { id: i.id });
  res.json({ ok: true });
});

router.post('/invoices/:id/void', requireStaff('billing'), (req, res) => {
  const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!i) return res.status(404).json({ error: '找不到此收費單' });
  const { reason = '' } = req.body || {};
  db.prepare("UPDATE invoices SET status = 'void', note = ? WHERE id = ?")
    .run((i.note ? i.note + '；' : '') + '作廢：' + reason, i.id);
  audit('staff', req.user.id, req.user.name, '作廢收費單', String(i.client_id), { id: i.id, reason });
  res.json({ ok: true });
});

router.get('/invoices/:id/receipt', requireStaff('billing'), (req, res) => {
  const i = db.prepare(`SELECT i.*, c.name AS client_name, c.code AS client_code FROM invoices i
    JOIN clients c ON c.id = i.client_id WHERE i.id = ?`).get(req.params.id);
  if (!i) return res.status(404).json({ error: '找不到此收費單' });
  res.json({
    ...i,
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address'),
    center_license_no: getSetting('center_license_no'),
    center_director: getSetting('center_director'),
    center_tax_id: getSetting('center_tax_id')
  });
});

// 期間彙總收據：個案報稅、保險理賠或公司補助核銷時要的是「這段期間總共繳了多少」，
// 一次列一張，逐筆列出已收款項目。未收款與作廢不列入。
router.get('/clients/:id/receipt-summary', requireStaff('billing'), (req, res) => {
  const c = db.prepare('SELECT id, name, code, id_no FROM clients WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到此個案' });
  const from = String(req.query.from || '').slice(0, 10);
  const to = String(req.query.to || '').slice(0, 10);
  if (!from || !to) return res.status(400).json({ error: '請指定起訖日期' });
  const rows = db.prepare(`SELECT id, date, item, amount, method, paid_at, receipt_no, payer,
      subsidy_amount, self_pay
    FROM invoices WHERE client_id = ? AND status = 'paid' AND date BETWEEN ? AND ?
    ORDER BY date, id`).all(c.id, from, to);
  const refunded = db.prepare(`SELECT COALESCE(SUM(rf.amount),0) n FROM refunds rf
    JOIN invoices i ON i.id = rf.invoice_id
    WHERE i.client_id = ? AND i.date BETWEEN ? AND ?`).get(c.id, from, to).n;
  const total = rows.reduce((s2, r) => s2 + r.amount, 0);
  audit('staff', req.user.id, req.user.name, '列印期間彙總收據', c.code, { from, to, total });
  res.json({
    client: c, from, to, rows,
    total, refunded, net: total - refunded,
    sessions: rows.length,
    issued_by: req.user.name,
    issued_at: nowStamp(),
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    center_address: getSetting('center_address'),
    center_license_no: getSetting('center_license_no'),
    center_director: getSetting('center_director'),
    center_tax_id: getSetting('center_tax_id')
  });
});

// ---- 逾期未收款與催繳 ----
// 逾期天數以費用日期起算（設定值 overdue_days）。催繳訊息與晤談提醒共用發送機制：
// 未設定 webhook 時只產生文字供人工發送，不把個資送到外部服務；每則都留發送紀錄。

function dunningMessage(row) {
  const days = row.days_overdue;
  return getSetting('dunning_template', '')
    .replace('{client}', row.client_name)
    .replace('{date}', row.date)
    .replace('{item}', row.item)
    .replace('{amount}', String(row.amount))
    .replace('{days}', String(days))
    .replace('{phone}', getSetting('center_phone'))
    .replace('{center}', getSetting('center_name'));
}

router.get('/invoices/overdue', requireStaff('billing'), (req, res) => {
  const days = Number(req.query.days || getSetting('overdue_days', '14')) || 14;
  const { payer = '', counselor_id = '' } = req.query;
  const where = ["i.status = 'unpaid'", "julianday('now','localtime') - julianday(i.date) >= ?"];
  const args = [days];
  if (payer) { where.push('i.payer = ?'); args.push(payer); }
  if (counselor_id) { where.push('c.counselor_id = ?'); args.push(Number(counselor_id)); }
  const rows = db.prepare(`SELECT i.*, c.name AS client_name, c.code AS client_code, c.phone AS client_phone,
      u.name AS counselor_name,
      CAST(julianday('now','localtime') - julianday(i.date) AS INTEGER) AS days_overdue,
      (SELECT MAX(n.created_at) FROM notifications n WHERE n.kind = 'dunning' AND n.client_id = i.client_id) AS last_dunned_at,
      (SELECT COUNT(*) FROM notifications n WHERE n.kind = 'dunning' AND n.client_id = i.client_id) AS dunned_times
    FROM invoices i JOIN clients c ON c.id = i.client_id
    LEFT JOIN users u ON u.id = c.counselor_id
    WHERE ${where.join(' AND ')}
    ORDER BY i.date`).all(...args);

  // 帳齡分析：催繳強度與後續處理（電話、暫停服務、轉呆帳）多依帳齡決定
  const buckets = [
    { key: '0_30', label: '30 天內', min: 0, max: 30 },
    { key: '31_60', label: '31-60 天', min: 31, max: 60 },
    { key: '61_90', label: '61-90 天', min: 61, max: 90 },
    { key: 'over_90', label: '超過 90 天', min: 91, max: 99999 }
  ].map(b => {
    const list = rows.filter(r => r.days_overdue >= b.min && r.days_overdue <= b.max);
    return { ...b, count: list.length, amount: list.reduce((a, x) => a + x.amount, 0) };
  });

  res.json({
    days,
    total_amount: rows.reduce((a, b) => a + b.amount, 0),
    // 全部未收款（含未達逾期門檻者），用於對照
    all_unpaid: db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) amt FROM invoices WHERE status = 'unpaid'").get(),
    aging: buckets,
    payers: listSetting('payer_types'),
    rows: rows.map(r => ({ ...r, message: dunningMessage(r) }))
  });
});

// 催繳發送紀錄（與晤談提醒共用 notifications 表，kind 為 dunning）
router.get('/dunning-log', requireStaff('billing'), (req, res) => {
  res.json(db.prepare(`SELECT n.*, c.name AS client_name, c.code AS client_code, u.name AS sent_by_name
    FROM notifications n LEFT JOIN clients c ON c.id = n.client_id LEFT JOIN users u ON u.id = n.sent_by
    WHERE n.kind = 'dunning' ORDER BY n.id DESC LIMIT 200`).all());
});

router.post('/invoices/:id/dun', requireStaff('billing'), async (req, res) => {
  const i = db.prepare(`SELECT i.*, c.name AS client_name, c.code AS client_code, c.phone AS client_phone,
      CAST(julianday('now','localtime') - julianday(i.date) AS INTEGER) AS days_overdue
    FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`).get(req.params.id);
  if (!i) return res.status(404).json({ error: '找不到此收費單' });
  if (i.status !== 'unpaid') return res.status(400).json({ error: '此筆已收款或已作廢，無需催繳' });
  const content = String((req.body && req.body.message) || '') || dunningMessage(i);
  const result = await sendNotification({
    kind: 'dunning', client_id: i.client_id, target: i.client_phone, content, user: req.user
  });
  audit('staff', req.user.id, req.user.name, '發送催繳', i.client_code, { invoice_id: i.id, amount: i.amount });
  res.json({ ok: true, ...result });
});

// ---- 方案（預付堂數）----

router.get('/packages', requireStaff('billing'), (req, res) => {
  const { client_id = '', status = '' } = req.query;
  const where = [], args = [];
  if (client_id) { where.push('p.client_id = ?'); args.push(Number(client_id)); }
  if (status) { where.push('p.status = ?'); args.push(status); }
  res.json(db.prepare(`SELECT p.*, c.name AS client_name, c.code AS client_code,
      (p.sessions_total - p.sessions_used) AS remaining
    FROM packages p JOIN clients c ON c.id = p.client_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.status != 'active', p.id DESC`).all(...args));
});

router.post('/packages', requireStaff('billing'), (req, res) => {
  const b = req.body || {};
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(b.client_id) || 0);
  if (!c) return res.status(400).json({ error: '請選擇個案' });
  if (!b.name) return res.status(400).json({ error: '請填寫方案名稱' });
  const total = Number(b.sessions_total) || 0;
  if (total < 1) return res.status(400).json({ error: '堂數需大於 0' });
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO packages (client_id, name, sessions_total, amount, start_date, expire_date, note)
      VALUES (?,?,?,?,?,?,?)`).run(c.id, b.name, total, Number(b.amount) || 0,
      b.start_date || today(), b.expire_date || '', b.note || '');
    // 方案售出即產生一筆收費單，於櫃檯收款
    db.prepare(`INSERT INTO invoices (client_id, package_id, date, item, amount, payer)
      VALUES (?,?,?,?,?,?)`).run(c.id, info.lastInsertRowid, b.start_date || today(),
      `方案：${b.name}（${total} 次）`, Number(b.amount) || 0, b.payer || getSetting('payer_type_default', '自費'));
    return info.lastInsertRowid;
  });
  const id = tx();
  audit('staff', req.user.id, req.user.name, '新增方案', c.code, { name: b.name, total });
  res.json({ id });
});

router.put('/packages/:id', requireStaff('billing'), (req, res) => {
  const p = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此方案' });
  const b = { ...p, ...req.body };
  const total = Number(b.sessions_total) || p.sessions_total;
  if (total < p.sessions_used) return res.status(400).json({ error: `已使用 ${p.sessions_used} 次，總堂數不可低於此數` });
  db.prepare('UPDATE packages SET name = ?, sessions_total = ?, amount = ?, start_date = ?, expire_date = ?, status = ?, note = ? WHERE id = ?')
    .run(b.name, total, Number(b.amount) || 0, b.start_date, b.expire_date || '', b.status, b.note || '', p.id);
  audit('staff', req.user.id, req.user.name, '修改方案', String(p.client_id));
  res.json({ ok: true });
});

// 刪除方案：已扣過次數或已產生收費單的方案不能刪（會對不上帳），改用狀態作廢
router.delete('/packages/:id', requireStaff('billing'), (req, res) => {
  const p = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此方案' });
  if (p.sessions_used > 0) {
    return res.status(400).json({ error: `此方案已使用 ${p.sessions_used} 次，不可刪除；請改將狀態設為已退費或到期` });
  }
  const inv = db.prepare('SELECT COUNT(*) n FROM invoices WHERE package_id = ?').get(p.id).n;
  if (inv) return res.status(400).json({ error: `此方案已有 ${inv} 筆收費紀錄，不可刪除` });
  const appt = db.prepare('SELECT COUNT(*) n FROM appointments WHERE package_id = ?').get(p.id).n;
  if (appt) return res.status(400).json({ error: `此方案已綁定 ${appt} 筆預約，不可刪除` });
  db.prepare('DELETE FROM packages WHERE id = ?').run(p.id);
  audit('staff', req.user.id, req.user.name, '刪除方案', String(p.client_id), { name: p.name });
  res.json({ ok: true });
});

// 該個案可用的方案（預約時扣次用）
router.get('/clients/:id/active-packages', requireStaff('schedule'), (req, res) => {
  res.json(db.prepare(`SELECT *, (sessions_total - sessions_used) AS remaining FROM packages
    WHERE client_id = ? AND status = 'active' AND sessions_used < sessions_total
      AND (expire_date = '' OR expire_date >= date('now','localtime'))
    ORDER BY id`).all(req.params.id));
});

// ---- 退費 ----
// 已收款的收費單若需退還（方案未用完即終止、重複收費、所方因素取消晤談），
// 不去改動原收費單金額——收款是已經發生的事實——而是另立退費單與原單勾稽：
// 原收費單狀態改為 refunded，方案退費時同步把方案標為 refunded 停止扣次。
// 報表與對帳一律以「收款 − 退費」計算。

// 可退金額 = 原收款金額 − 已退金額
function refundableOf(invoiceId) {
  const i = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!i) return null;
  const refunded = db.prepare('SELECT COALESCE(SUM(amount),0) n FROM refunds WHERE invoice_id = ?').get(i.id).n;
  return { invoice: i, refunded, refundable: Math.max(i.amount - refunded, 0) };
}

router.get('/refunds', requireStaff('billing'), (req, res) => {
  const { from = '', to = '', client_id = '' } = req.query;
  const where = [], args = [];
  if (from) { where.push('r.date >= ?'); args.push(from); }
  if (to) { where.push('r.date <= ?'); args.push(to); }
  if (client_id) { where.push('r.client_id = ?'); args.push(Number(client_id)); }
  const rows = db.prepare(`SELECT r.*, c.name AS client_name, c.code AS client_code,
      i.item AS invoice_item, i.receipt_no, i.date AS invoice_date, i.amount AS invoice_amount,
      p.name AS package_name, u.name AS created_by_name
    FROM refunds r JOIN clients c ON c.id = r.client_id
    LEFT JOIN invoices i ON i.id = r.invoice_id
    LEFT JOIN packages p ON p.id = r.package_id
    LEFT JOIN users u ON u.id = r.created_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.date DESC, r.id DESC LIMIT 300`).all(...args);
  res.json({ rows, total: rows.reduce((a, b) => a + b.amount, 0) });
});

// 開退費單前先問可退多少（前端用來預帶金額與擋住超額）
router.get('/invoices/:id/refundable', requireStaff('billing'), (req, res) => {
  const r = refundableOf(Number(req.params.id));
  if (!r) return res.status(404).json({ error: '找不到此收費單' });
  const pkg = r.invoice.package_id
    ? db.prepare('SELECT id, name, sessions_total, sessions_used, amount FROM packages WHERE id = ?').get(r.invoice.package_id)
    : null;
  // 方案退費常以「剩餘堂數 × 單堂均價」計算，這裡直接算好給櫃檯參考
  const suggest = pkg && pkg.sessions_total
    ? Math.min(Math.round((pkg.sessions_total - pkg.sessions_used) * (pkg.amount / pkg.sessions_total)), r.refundable)
    : r.refundable;
  res.json({ ...r, package: pkg, suggest });
});

router.post('/invoices/:id/refund', requireStaff('billing'), (req, res) => {
  const info = refundableOf(Number(req.params.id));
  if (!info) return res.status(404).json({ error: '找不到此收費單' });
  const { invoice: i, refundable } = info;
  if (i.status === 'void') return res.status(400).json({ error: '已作廢的收費單不需退費' });
  if (i.status !== 'paid' && i.status !== 'refunded') {
    return res.status(400).json({ error: '此筆尚未收款，請直接作廢收費單，不需辦理退費' });
  }
  const b = req.body || {};
  const amount = Number(b.amount) || 0;
  if (amount <= 0) return res.status(400).json({ error: '請填寫退費金額' });
  if (amount > refundable) return res.status(400).json({ error: `可退金額上限為 ${refundable} 元（原收款 ${i.amount}，已退 ${info.refunded}）` });
  if (!String(b.reason || '').trim()) return res.status(400).json({ error: '請填寫退費原因' });
  const closePackage = !!b.close_package && !!i.package_id;
  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO refunds (invoice_id, client_id, package_id, date, amount, method, reason, note, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      i.id, i.client_id, i.package_id || null, b.date || today(), amount,
      b.method || '現金', String(b.reason).trim(), b.note || '', req.user.id);
    // 全額退回才把收費單標為已退費；部分退費維持 paid，差額仍屬有效收款
    if (info.refunded + amount >= i.amount) {
      db.prepare("UPDATE invoices SET status = 'refunded' WHERE id = ?").run(i.id);
    }
    if (closePackage) {
      db.prepare("UPDATE packages SET status = 'refunded' WHERE id = ?").run(i.package_id);
    }
    return r.lastInsertRowid;
  });
  const id = tx();
  audit('staff', req.user.id, req.user.name, '辦理退費', String(i.client_id), { invoice_id: i.id, amount, reason: b.reason });
  res.json({ id });
});

router.delete('/refunds/:id', requireStaff('billing'), (req, res) => {
  const r = db.prepare('SELECT * FROM refunds WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此退費紀錄' });
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM refunds WHERE id = ?').run(r.id);
    // 收費單若因這筆而標為已退費，撤銷後回復為已收款
    if (r.invoice_id) {
      const left = db.prepare('SELECT COALESCE(SUM(amount),0) n FROM refunds WHERE invoice_id = ?').get(r.invoice_id).n;
      const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(r.invoice_id);
      if (inv && inv.status === 'refunded' && left < inv.amount) {
        db.prepare("UPDATE invoices SET status = 'paid' WHERE id = ?").run(inv.id);
      }
    }
    if (r.package_id) {
      db.prepare(`UPDATE packages SET status = 'active' WHERE id = ? AND status = 'refunded'
        AND sessions_used < sessions_total`).run(r.package_id);
    }
  });
  tx();
  audit('staff', req.user.id, req.user.name, '撤銷退費', String(r.client_id), { id: r.id, amount: r.amount });
  res.json({ ok: true });
});

module.exports = router;
