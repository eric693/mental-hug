const { db, today, nowStamp } = require('./db');

// 分帳引擎（M6）
//
// 諮商所的分帳規則不是一條公式，而是十幾條「什麼情況下用哪個比例」的約定：
// 指名與派案不同比、書表製作另計、場地費另算、某位資深心理師有自己的比例……
//
// 三個設計決定：
//   1. 條件是結構化欄位（人員／專案／據點／預約型態／指名與否／生效起訖），
//      不是寫在備註裡靠人記。比對得出來，才可能自動歸屬。
//   2. 規則可以改，但改的是「新版本」。每一筆拆帳鎖住當時的版本 id，
//      歷史帳不會因為今天調比例而變動。
//   3. 找不到規則就明確擋下，不預設 50:50——猜錯的帳比沒拆的帳更難處理。

// 條件命中判定：欄位留空＝不限；有值就必須相等
function matches(v, ctx) {
  const eq = (a, b) => !a || String(a) === String(b);
  if (v.counselor_id && Number(v.counselor_id) !== Number(ctx.counselor_id)) return false;
  if (v.project_id && Number(v.project_id) !== Number(ctx.project_id || 0)) return false;
  if (v.site_id && Number(v.site_id) !== Number(ctx.site_id || 0)) return false;
  if (!eq(v.appt_type, ctx.appt_type)) return false;
  if (!eq(v.item_type, ctx.item_type || 'session')) return false;
  if (v.designated === 'yes' && !ctx.designated) return false;
  if (v.designated === 'no' && ctx.designated) return false;
  const d = ctx.date || today();
  if (v.effective_from && d < v.effective_from) return false;
  if (v.effective_to && d > v.effective_to) return false;
  return true;
}

// 每條規則取「該日期下生效的最新版本」，再從命中的規則裡挑優先序最高的
function currentVersions(date) {
  const d = date || today();
  return db.prepare(`SELECT v.*, r.name AS rule_name, r.active
    FROM split_rule_versions v JOIN split_rules r ON r.id = v.rule_id
    WHERE r.active = 1
      AND (v.effective_from = '' OR v.effective_from <= ?)
      AND (v.effective_to = '' OR v.effective_to >= ?)
      AND v.version = (
        SELECT MAX(v2.version) FROM split_rule_versions v2
        WHERE v2.rule_id = v.rule_id
          AND (v2.effective_from = '' OR v2.effective_from <= ?))
    ORDER BY v.priority, v.id`).all(d, d, d);
}

function findRule(ctx) {
  const hits = currentVersions(ctx.date).filter(v => matches(v, ctx));
  return hits[0] || null;
}

// 拆分金額：先給固定額，剩下的照比例；四捨五入後把餘數留給機構端，
// 確保兩邊相加永遠等於原始金額（不會因為進位多出或少掉一元）。
function computeSplit(amount, v) {
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  const fixedC = Math.min(Number(v.fixed_counselor) || 0, amt);
  const fixedO = Math.min(Number(v.fixed_center) || 0, Math.max(0, amt - fixedC));
  const rest = Math.max(0, amt - fixedC - fixedO);
  const counselor = fixedC + Math.round(rest * (Number(v.counselor_pct) || 0) / 100);
  const center = amt - counselor;
  return { amount: amt, counselor_amount: counselor, center_amount: center };
}

// 模擬器（M6-03）：給條件，回傳會套用哪條規則、拆成多少
function simulate(ctx) {
  const v = findRule(ctx);
  if (!v) {
    return {
      matched: false,
      message: '找不到適用的分帳規則，請先建立規則或補上這個情境的條件',
      candidates: currentVersions(ctx.date).slice(0, 5)
        .map(x => ({ rule: x.rule_name, version: x.version, priority: x.priority }))
    };
  }
  return {
    matched: true,
    rule_id: v.rule_id,
    rule_version_id: v.id,
    rule_label: `${v.rule_name} v${v.version}`,
    priority: v.priority,
    counselor_pct: v.counselor_pct,
    fixed_counselor: v.fixed_counselor,
    fixed_center: v.fixed_center,
    ...computeSplit(ctx.amount, v)
  };
}

// 收費單的拆帳情境：從預約與個案身上把條件湊齊
function contextOfInvoice(inv) {
  const appt = inv.appointment_id
    ? db.prepare('SELECT * FROM appointments WHERE id = ?').get(inv.appointment_id) : null;
  const counselorId = appt ? appt.counselor_id
    : (db.prepare('SELECT counselor_id FROM clients WHERE id = ?').get(inv.client_id) || {}).counselor_id;
  return {
    date: inv.date,
    amount: inv.amount,
    counselor_id: counselorId || null,
    site_id: appt ? appt.site_id : null,
    appt_type: appt ? appt.type : '',
    designated: appt ? !!appt.designated : false,
    item_type: 'session',
    project_id: inv.project_id || null,
    minutes: appt ? minutesOf(appt) : 0
  };
}

function minutesOf(appt) {
  const toMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
  return Math.max(0, toMin(appt.end_time) - toMin(appt.start_time));
}

// 實際拆帳並寫入。已拆過的先移除再寫，維持一張單一筆。
// 找不到規則時回傳 null 並附原因，由呼叫端決定要不要擋下。
function applySplit(invoice, { force = false } = {}) {
  const inv = typeof invoice === 'object' ? invoice
    : db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice);
  if (!inv) return { ok: false, reason: '找不到收費單' };
  const exists = db.prepare('SELECT * FROM invoice_splits WHERE invoice_id = ?').get(inv.id);
  if (exists && !force) return { ok: true, split: exists, reused: true };

  const ctx = contextOfInvoice(inv);
  if (!ctx.counselor_id) return { ok: false, reason: '這筆收費沒有對應的心理師，無法歸屬' };
  const v = findRule(ctx);
  if (!v) return { ok: false, reason: '找不到適用的分帳規則', ctx };

  const s = computeSplit(inv.amount, v);
  if (exists) db.prepare('DELETE FROM invoice_splits WHERE invoice_id = ?').run(inv.id);
  const info = db.prepare(`INSERT INTO invoice_splits (invoice_id, appointment_id, counselor_id,
      rule_id, rule_version_id, rule_label, month, amount, counselor_amount, center_amount, minutes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    inv.id, inv.appointment_id || null, ctx.counselor_id, v.rule_id, v.id,
    `${v.rule_name} v${v.version}`, String(inv.date).slice(0, 7),
    s.amount, s.counselor_amount, s.center_amount, ctx.minutes);
  return { ok: true, split: db.prepare('SELECT * FROM invoice_splits WHERE id = ?').get(info.lastInsertRowid) };
}

// 人員月結表（M6-04）
function monthlySettlement(month, counselorId) {
  const where = ['s.month = ?'], args = [month];
  if (counselorId) { where.push('s.counselor_id = ?'); args.push(Number(counselorId)); }
  const rows = db.prepare(`SELECT s.*, u.name AS counselor_name, c.name AS client_name, c.code AS client_code,
      i.item, i.date, i.status AS invoice_status
    FROM invoice_splits s
    LEFT JOIN users u ON u.id = s.counselor_id
    LEFT JOIN invoices i ON i.id = s.invoice_id
    LEFT JOIN clients c ON c.id = i.client_id
    WHERE ${where.join(' AND ')} ORDER BY s.counselor_id, i.date, s.id`).all(...args);

  const byCounselor = new Map();
  for (const r of rows) {
    const k = r.counselor_id;
    if (!byCounselor.has(k)) {
      byCounselor.set(k, {
        counselor_id: k, counselor_name: r.counselor_name || '（未指定）',
        sessions: 0, minutes: 0, amount: 0, counselor_amount: 0, center_amount: 0, rows: []
      });
    }
    const g = byCounselor.get(k);
    g.sessions++;
    g.minutes += r.minutes;
    g.amount += r.amount;
    g.counselor_amount += r.counselor_amount;
    g.center_amount += r.center_amount;
    g.rows.push(r);
  }
  const groups = [...byCounselor.values()].sort((a, b) => b.counselor_amount - a.counselor_amount);
  return {
    month,
    groups,
    total: {
      sessions: rows.length,
      hours: Math.round(rows.reduce((n, r) => n + r.minutes, 0) / 6) / 10,
      amount: rows.reduce((n, r) => n + r.amount, 0),
      counselor_amount: rows.reduce((n, r) => n + r.counselor_amount, 0),
      center_amount: rows.reduce((n, r) => n + r.center_amount, 0)
    },
    // 這個月有收款但還沒拆帳的單子——月結前一定要清空這一區
    unsplit: db.prepare(`SELECT i.id, i.date, i.item, i.amount, c.name AS client_name, c.code AS client_code
      FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE substr(i.date,1,7) = ? AND i.status IN ('paid','refunded')
        AND NOT EXISTS (SELECT 1 FROM invoice_splits s WHERE s.invoice_id = i.id)
      ORDER BY i.date`).all(month)
  };
}

module.exports = {
  findRule, simulate, computeSplit, applySplit, monthlySettlement,
  currentVersions, contextOfInvoice, nowStamp
};
