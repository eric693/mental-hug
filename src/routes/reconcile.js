const express = require('express');
const crypto = require('crypto');
const { db, audit, today, getSetting, nowStamp, listQuery } = require('../db');
const { requireStaff } = require('../auth');
const split = require('../split');

const router = express.Router();

// 收費、金流與三方勾稽（M5）
//
// 這一段的核心是「不要讓人工一筆一筆確認」。實務上絕大多數交易長得一模一樣：
// 個案有到、金額就是預設價、當場付清。這些自動入帳；只有真的有疑問的才進人工佇列。
// 判斷條件寫死在 autoConfirmable()，看得到也改得動，而不是散在各處的 if。

// ---- 自動確認（M5-01）----
// 進人工佇列的理由要具體，行政人員才知道要處理什麼
function reviewReasons(inv, appt) {
  const reasons = [];
  if (!appt) reasons.push('沒有對應的預約');
  else {
    if (appt.status !== 'done') reasons.push(`預約狀態為「${appt.status}」，非已完成`);
    if (!appt.counselor_id) reasons.push('預約沒有指定心理師');
  }
  if (inv.amount <= 0) reasons.push('金額為零或負數');
  if (!inv.site_id) reasons.push('無法判斷入帳主體（預約未歸屬據點）');
  const expect = appt ? appt.fee : null;
  if (appt && expect && inv.amount !== expect && !inv.client_project_id) {
    reasons.push(`金額與預約費用不符（預約 ${expect}，收費 ${inv.amount}）`);
  }
  if (!split.findRule({
    date: inv.date, counselor_id: appt ? appt.counselor_id : null,
    site_id: inv.site_id, appt_type: appt ? appt.type : '',
    designated: appt ? !!appt.designated : false, item_type: 'session',
    project_id: inv.project_id || null
  })) reasons.push('找不到適用的分帳規則');
  return reasons;
}

function classify(invoiceId) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv) return null;
  const appt = inv.appointment_id
    ? db.prepare('SELECT * FROM appointments WHERE id = ?').get(inv.appointment_id) : null;
  // 據點沒帶到就從預約補上，之後的主體歸屬與收據抬頭都靠它
  if (!inv.site_id && appt && appt.site_id) {
    db.prepare('UPDATE invoices SET site_id = ? WHERE id = ?').run(appt.site_id, inv.id);
    inv.site_id = appt.site_id;
  }
  const reasons = reviewReasons(inv, appt);
  const state = reasons.length ? 'pending' : 'auto';
  db.prepare('UPDATE invoices SET review_state = ?, review_reason = ? WHERE id = ? AND review_state <> ?')
    .run(state, reasons.join('；'), inv.id, 'resolved');
  return { state, reasons };
}

// 人工佇列（M5-03）
router.get('/reconcile/queue', requireStaff('billing'), (req, res) => {
  const where = ["i.review_state = 'pending'"], args = [];
  if (req.query.from) { where.push('i.date >= ?'); args.push(String(req.query.from)); }
  if (req.query.to) { where.push('i.date <= ?'); args.push(String(req.query.to)); }
  if (req.query.site_id) { where.push('i.site_id = ?'); args.push(Number(req.query.site_id)); }
  const page = listQuery({
    select: `i.*, c.name AS client_name, c.code AS client_code, s.name AS site_name,
      u.name AS counselor_name, a.status AS appt_status, a.date AS appt_date, a.fee AS appt_fee`,
    from: `invoices i
      JOIN clients c ON c.id = i.client_id
      LEFT JOIN sites s ON s.id = i.site_id
      LEFT JOIN appointments a ON a.id = i.appointment_id
      LEFT JOIN users u ON u.id = a.counselor_id`,
    where, args,
    search: String(req.query.q || ''),
    searchFields: ['c.name', 'c.code', 'i.item', 'i.review_reason'],
    order: 'i.date, i.id',
    page: req.query.page, size: Number(req.query.size) || 50, maxSize: 500
  });
  res.json({
    ...page,
    // 反向選取要用：目前條件下的全部 id（跨頁）
    all_ids: db.prepare(`SELECT i.id FROM invoices i
      JOIN clients c ON c.id = i.client_id
      LEFT JOIN sites s ON s.id = i.site_id
      LEFT JOIN appointments a ON a.id = i.appointment_id
      WHERE ${where.join(' AND ')} ORDER BY i.date, i.id`).all(...args).map(r => r.id)
  });
});

// 重新判定（規則補好之後）
router.post('/reconcile/reclassify', requireStaff('billing'), (req, res) => {
  const month = String((req.body || {}).month || today().slice(0, 7));
  const rows = db.prepare("SELECT id FROM invoices WHERE substr(date,1,7) = ? AND status <> 'void'").all(month);
  let auto = 0, pending = 0;
  for (const r of rows) {
    const out = classify(r.id);
    if (out && out.state === 'auto') auto++; else pending++;
  }
  audit('staff', req.user.id, req.user.name, '重新判定收費單', month, { auto, pending });
  res.json({ month, auto, pending });
});

// 批次處理（M5-03）：確認入帳或標記已處理
router.post('/reconcile/batch', requireStaff('billing'), (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean).slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ error: '請先選擇要處理的收費單' });
  const action = String(b.action || '');
  const done = [], failed = [];
  const tx = db.transaction(() => {
    for (const id of ids) {
      const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
      if (!inv) { failed.push({ id, reason: '找不到' }); continue; }
      if (action === 'confirm') {
        // 確認入帳：收款、產生收據號、記一筆金流、跑分帳
        if (inv.status === 'unpaid') {
          db.prepare(`UPDATE invoices SET status = 'paid', method = ?, paid_at = ?, receipt_no = ? WHERE id = ?`)
            .run(String(b.method || '現金'), nowStamp(), inv.receipt_no || nextReceiptNo(inv.site_id), inv.id);
          db.prepare(`INSERT INTO payments (invoice_id, client_id, site_id, amount, method, channel, paid_at, created_by)
            VALUES (?,?,?,?,?, 'manual', ?, ?)`).run(inv.id, inv.client_id, inv.site_id, inv.amount,
            String(b.method || '現金'), nowStamp(), req.user.id);
        }
        const sp = split.applySplit(db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id));
        if (!sp.ok) failed.push({ id, reason: sp.reason });
        db.prepare(`UPDATE invoices SET review_state = 'resolved', reviewed_by = ?, reviewed_at = ? WHERE id = ?`)
          .run(req.user.id, nowStamp(), inv.id);
        done.push(id);
      } else if (action === 'resolve') {
        db.prepare(`UPDATE invoices SET review_state = 'resolved', reviewed_by = ?, reviewed_at = ?,
          review_reason = ? WHERE id = ?`)
          .run(req.user.id, nowStamp(), String(b.note || inv.review_reason), inv.id);
        done.push(id);
      } else if (action === 'void') {
        if (inv.status === 'paid') { failed.push({ id, reason: '已收款者不可直接作廢，請走退費' }); continue; }
        db.prepare("UPDATE invoices SET status = 'void', review_state = 'resolved', reviewed_by = ?, reviewed_at = ? WHERE id = ?")
          .run(req.user.id, nowStamp(), inv.id);
        done.push(id);
      } else {
        failed.push({ id, reason: '未知的動作' });
      }
    }
  });
  tx();
  audit('staff', req.user.id, req.user.name, '批次處理收費佇列', '',
    { action, done: done.length, failed: failed.length });
  res.json({ done: done.length, failed });
});

// 收據號：各主體獨立流水（沒設前綴就用全所設定）
function nextReceiptNo(siteId) {
  const site = siteId ? db.prepare('SELECT receipt_prefix FROM sites WHERE id = ?').get(siteId) : null;
  const prefix = (site && site.receipt_prefix) || getSetting('receipt_prefix', 'MC');
  const ym = today().slice(0, 7).replace('-', '');
  const row = db.prepare('SELECT receipt_no FROM invoices WHERE receipt_no LIKE ? ORDER BY receipt_no DESC LIMIT 1')
    .get(`${prefix}${ym}%`);
  const seq = row ? Number(row.receipt_no.slice(-4)) + 1 : 1;
  return `${prefix}${ym}${String(seq).padStart(4, '0')}`;
}

// ---- 金流入帳 ----
router.get('/payments', requireStaff('billing'), (req, res) => {
  const where = [], args = [];
  if (req.query.from) { where.push('p.paid_at >= ?'); args.push(String(req.query.from)); }
  if (req.query.to) { where.push('p.paid_at <= ?'); args.push(String(req.query.to) + ' 23:59:59'); }
  if (req.query.site_id) { where.push('p.site_id = ?'); args.push(Number(req.query.site_id)); }
  if (req.query.method) { where.push('p.method = ?'); args.push(String(req.query.method)); }
  res.json(listQuery({
    select: `p.*, c.name AS client_name, c.code AS client_code, s.name AS site_name, s.legal_entity`,
    from: `payments p LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN sites s ON s.id = p.site_id`,
    where, args,
    search: String(req.query.q || ''),
    searchFields: ['c.name', 'c.code', 'p.external_no', 'p.note'],
    order: 'p.id DESC',
    page: req.query.page, size: Number(req.query.size) || 50, maxSize: 300
  }));
});

router.post('/payments', requireStaff('billing'), (req, res) => {
  const b = req.body || {};
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(b.invoice_id) || 0);
  if (!inv) return res.status(400).json({ error: '請指定收費單' });
  const amount = Number(b.amount) || inv.amount;
  const info = db.prepare(`INSERT INTO payments (invoice_id, client_id, site_id, amount, method, channel,
      external_no, paid_at, status, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(inv.id, inv.client_id, inv.site_id || null, amount,
    String(b.method || '現金'), String(b.channel || 'manual'), String(b.external_no || ''),
    String(b.paid_at || nowStamp()), String(b.status || 'settled'), String(b.note || ''), req.user.id);
  audit('staff', req.user.id, req.user.name, '登錄金流入帳', String(inv.id), { amount, method: b.method });
  res.json({ id: info.lastInsertRowid });
});

router.delete('/payments/:id', requireStaff('billing'), (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '找不到此入帳紀錄' });
  db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
  audit('staff', req.user.id, req.user.name, '刪除入帳紀錄', String(p.id), { amount: p.amount });
  res.json({ ok: true });
});

// ---- 收款連結（M5-07）----
// 各據點是不同法律主體，收款連結要指向該主體自己的收款頁；
// 填入 LINE Pay 憑證前，這裡產生的是可貼給個案的付款說明頁，入帳仍走人工確認。
router.post('/payment-links', requireStaff('billing'), (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number((req.body || {}).invoice_id) || 0);
  if (!inv) return res.status(400).json({ error: '請指定收費單' });
  if (inv.status === 'paid') return res.status(400).json({ error: '此收費單已收款' });
  const site = inv.site_id ? db.prepare('SELECT * FROM sites WHERE id = ?').get(inv.site_id) : null;
  if (!site) return res.status(400).json({ error: '此收費單尚未歸屬據點，無法判斷收款主體' });
  const token = crypto.randomBytes(16).toString('hex');
  const info = db.prepare(`INSERT INTO payment_links (token, invoice_id, site_id, amount, expires_at, created_by)
    VALUES (?,?,?,?,?,?)`).run(token, inv.id, site.id, inv.amount,
    String((req.body || {}).expires_at || ''), req.user.id);
  audit('staff', req.user.id, req.user.name, '產生收款連結', String(inv.id), { site: site.name });
  res.json({
    id: info.lastInsertRowid,
    token,
    url: `/pay.html?t=${token}`,
    site: { name: site.name, legal_entity: site.legal_entity, pay_channel: site.pay_channel, pay_account: site.pay_account },
    ready: !!(site.pay_account || site.pay_link_base),
    hint: (site.pay_account || site.pay_link_base)
      ? '' : '此據點尚未設定收款帳號，連結只會顯示金額與匯款說明；請先於系統設定填入該主體的收款資訊'
  });
});

// 公開收款頁資料（免登入，只吐金額與主體，不含個案姓名）
router.get('/public/pay/:token', (req, res) => {
  const link = db.prepare('SELECT * FROM payment_links WHERE token = ?').get(String(req.params.token));
  if (!link) return res.status(404).json({ error: '連結不存在或已失效' });
  if (link.expires_at && link.expires_at < today()) return res.status(410).json({ error: '此收款連結已過期' });
  const site = db.prepare('SELECT name, legal_entity, tax_id, phone, address, pay_channel, pay_account, pay_link_base FROM sites WHERE id = ?')
    .get(link.site_id) || {};
  const inv = db.prepare('SELECT item, date FROM invoices WHERE id = ?').get(link.invoice_id) || {};
  res.json({
    amount: link.amount, status: link.status, item: inv.item || '', date: inv.date || '',
    site, center_name: getSetting('center_name')
  });
});

// ---- 三方勾稽（M5-05）----
// 預約（服務發生）↔ 交易（收費單）↔ 金流（實際入帳），三邊對不起來的列成差異報表
router.get('/reconcile/report', requireStaff('billing'), (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  const like = month + '%';

  const doneNoInvoice = db.prepare(`SELECT a.id, a.date, a.start_time, a.fee, c.name AS client_name,
      c.code AS client_code, u.name AS counselor_name
    FROM appointments a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN users u ON u.id = a.counselor_id
    WHERE a.date LIKE ? AND a.status = 'done'
      AND a.package_id IS NULL AND a.client_project_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.appointment_id = a.id AND i.status <> 'void')
    ORDER BY a.date`).all(like);

  const invoiceNoAppt = db.prepare(`SELECT i.id, i.date, i.item, i.amount, i.status,
      c.name AS client_name, c.code AS client_code
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.date LIKE ? AND i.status <> 'void' AND i.appointment_id IS NULL
    ORDER BY i.date`).all(like);

  const paidNoPayment = db.prepare(`SELECT i.id, i.date, i.item, i.amount, i.method, i.receipt_no,
      c.name AS client_name, c.code AS client_code
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.date LIKE ? AND i.status = 'paid'
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status = 'settled')
    ORDER BY i.date`).all(like);

  const amountMismatch = db.prepare(`SELECT i.id, i.date, i.item, i.amount AS invoice_amount,
      (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'settled') AS paid_amount,
      c.name AS client_name, c.code AS client_code
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.date LIKE ? AND i.status = 'paid'
      AND (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'settled') > 0
      AND (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'settled') <> i.amount
    ORDER BY i.date`).all(like);

  const paymentNoInvoice = db.prepare(`SELECT p.* FROM payments p
    WHERE substr(p.paid_at,1,7) = ? AND (p.invoice_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = p.invoice_id))`).all(month);

  const bySite = db.prepare(`SELECT COALESCE(s.name,'未歸屬') AS site, s.legal_entity,
      COUNT(DISTINCT i.id) AS invoices,
      COALESCE(SUM(CASE WHEN i.status = 'paid' THEN i.amount END),0) AS invoiced,
      (SELECT COALESCE(SUM(p.amount),0) FROM payments p
        WHERE substr(p.paid_at,1,7) = ? AND p.status = 'settled'
          AND (p.site_id = s.id OR (p.site_id IS NULL AND s.id IS NULL))) AS received
    FROM invoices i LEFT JOIN sites s ON s.id = i.site_id
    WHERE i.date LIKE ? AND i.status <> 'void'
    GROUP BY i.site_id`).all(month, like);

  res.json({
    month,
    done_no_invoice: doneNoInvoice,
    invoice_no_appt: invoiceNoAppt,
    paid_no_payment: paidNoPayment,
    amount_mismatch: amountMismatch,
    payment_no_invoice: paymentNoInvoice,
    by_site: bySite,
    clean: !doneNoInvoice.length && !paidNoPayment.length && !amountMismatch.length && !paymentNoInvoice.length
  });
});

// ---- 月度明細匯出（M5-08）----
router.get('/reconcile/export', requireStaff('billing'), (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  const rows = db.prepare(`SELECT i.date, a.start_time, a.end_time, i.receipt_no, i.method,
      c.name AS client_name, c.code AS client_code,
      u.name AS counselor_name, s.name AS site_name, s.legal_entity,
      i.amount, i.payer, i.item, i.status,
      sp.center_amount, sp.counselor_amount, sp.rule_label,
      pr.name AS project_name, cl.source AS client_source
    FROM invoices i
    JOIN clients c ON c.id = i.client_id
    LEFT JOIN appointments a ON a.id = i.appointment_id
    LEFT JOIN users u ON u.id = a.counselor_id
    LEFT JOIN sites s ON s.id = i.site_id
    LEFT JOIN invoice_splits sp ON sp.invoice_id = i.id
    LEFT JOIN projects pr ON pr.id = i.project_id
    LEFT JOIN clients cl ON cl.id = i.client_id
    WHERE i.date LIKE ? AND i.status <> 'void'
    ORDER BY i.date, i.id`).all(month + '%');

  const head = ['日期', '起訖時間', '收據號碼', '支付方式', '個案', '個案編號', '專業人員',
    '單位營收', '專業人員營收', '總金額', '據點', '法律主體', '分帳規則', '專案', '付款人別',
    '來源通路', '項目', '狀態'];
  const csv = [head.join(',')].concat(rows.map(r => [
    r.date,
    r.start_time ? `${r.start_time}-${r.end_time}` : '',
    r.receipt_no || '', r.method || '',
    r.client_name, r.client_code, r.counselor_name || '',
    r.center_amount === null ? '' : r.center_amount,
    r.counselor_amount === null ? '' : r.counselor_amount,
    r.amount, r.site_name || '', r.legal_entity || '', r.rule_label || '',
    r.project_name || '', r.payer || '', r.client_source || '', r.item, r.status
  ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))).join('\n');

  audit('staff', req.user.id, req.user.name, '匯出月度收費明細', month, { rows: rows.length });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="billing-${month}.csv"`);
  res.send('﻿' + csv);
});

// ---- 收據雙版本與補印軌跡（M5-04）----
router.get('/invoices/:id/receipt-doc', requireStaff('billing'), (req, res) => {
  const i = db.prepare(`SELECT i.*, c.name AS client_name, c.code AS client_code, c.id_no,
      s.name AS site_name, s.legal_entity, s.tax_id AS site_tax_id, s.license_no AS site_license,
      s.director AS site_director, s.address AS site_address, s.phone AS site_phone
    FROM invoices i JOIN clients c ON c.id = i.client_id
    LEFT JOIN sites s ON s.id = i.site_id WHERE i.id = ?`).get(req.params.id);
  if (!i) return res.status(404).json({ error: '找不到此收費單' });
  const variant = req.query.variant === 'stamped' ? 'stamped' : 'plain';
  const prints = db.prepare(`SELECT rp.*, u.name AS by_name FROM receipt_prints rp
    LEFT JOIN users u ON u.id = rp.user_id WHERE rp.invoice_id = ? ORDER BY rp.id DESC`).all(i.id);
  // 第二次以後就是補印，要留原因
  if (prints.length && !String(req.query.reason || '').trim()) {
    return res.status(400).json({ error: '此收據已列印過，補印請填寫原因', reprint: true, prints });
  }
  db.prepare(`INSERT INTO receipt_prints (invoice_id, receipt_no, variant, reason, user_id, user_name)
    VALUES (?,?,?,?,?,?)`).run(i.id, i.receipt_no || '', variant,
    String(req.query.reason || '首次列印'), req.user.id, req.user.name);
  audit('staff', req.user.id, req.user.name, prints.length ? '補印收據' : '列印收據',
    i.client_code, { invoice_id: i.id, variant, reason: req.query.reason || '' });
  res.json({
    ...i, variant,
    // 沒有據點資料就退回全所設定，小型單館所方不必重複填
    entity: i.legal_entity || getSetting('center_name'),
    tax_id: i.site_tax_id || getSetting('center_tax_id'),
    license_no: i.site_license || getSetting('center_license_no'),
    director: i.site_director || getSetting('center_director'),
    address: i.site_address || getSetting('center_address'),
    phone: i.site_phone || getSetting('center_phone'),
    stamp_note: variant === 'stamped'
      ? '本收據已加蓋發票章與印花稅總繳章（依印花稅法採總繳方式繳納）' : '',
    prints: prints.length,
    print_log: prints
  });
});

router.get('/invoices/:id/receipt-prints', requireStaff('billing'), (req, res) => {
  res.json(db.prepare(`SELECT rp.*, u.name AS by_name FROM receipt_prints rp
    LEFT JOIN users u ON u.id = rp.user_id WHERE rp.invoice_id = ? ORDER BY rp.id DESC`).all(req.params.id));
});

module.exports = router;
module.exports.classify = classify;
module.exports.nextReceiptNo = nextReceiptNo;
