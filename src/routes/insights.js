const express = require('express');
const { db, today, addDays, getSetting } = require('../db');
const { requireStaff } = require('../auth');

const router = express.Router();

// 客戶分級與財務儀表板。
//
// 兩者都只用「行政層」資料（預約、出席、收費），不碰晤談內容，
// 因此行政人員看得到，與晤談紀錄的保密邊界互不影響。

// ---- 客戶分級 ----
// 等級不是拿來評價個案，而是幫櫃檯決定「誰該優先聯繫、誰快流失、誰有欠款」。
// 三個面向各自給分，合計後分級；權重與門檻放在系統設定，各所標準不同。
function tierRules() {
  return {
    vip_sessions: Number(getSetting('tier_vip_sessions', '12')),      // 累計完成晤談達此數為長期個案
    regular_sessions: Number(getSetting('tier_regular_sessions', '4')),
    good_attendance: Number(getSetting('tier_good_attendance', '90')), // 出席率（%）
    poor_attendance: Number(getSetting('tier_poor_attendance', '70')),
    dormant_days: Number(getSetting('tier_dormant_days', '60')),       // 幾天沒來視為沉睡
    overdue_days: Number(getSetting('overdue_days', '14'))
  };
}

function computeTiers() {
  const r = tierRules();
  const rows = db.prepare(`SELECT c.id, c.code, c.name, c.status, c.risk_level, c.intake_date,
      u.name AS counselor_name,
      (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id AND a.status = 'done') AS done,
      (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id AND a.status = 'no_show') AS no_show,
      (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id AND a.status = 'cancelled') AS cancelled,
      (SELECT MAX(a.date) FROM appointments a WHERE a.client_id = c.id AND a.status = 'done') AS last_done,
      (SELECT MIN(a.date) FROM appointments a WHERE a.client_id = c.id AND a.status IN ('booked','arrived')
        AND a.date >= date('now','localtime')) AS next_appt,
      (SELECT COALESCE(SUM(i.amount),0) FROM invoices i WHERE i.client_id = c.id AND i.status IN ('paid','refunded')) AS paid_amount,
      (SELECT COALESCE(SUM(i.amount),0) FROM invoices i WHERE i.client_id = c.id AND i.status = 'unpaid') AS unpaid_amount,
      (SELECT COUNT(*) FROM invoices i WHERE i.client_id = c.id AND i.status = 'unpaid'
        AND i.date <= date('now','localtime','-' || ? || ' day')) AS overdue_count,
      (SELECT COALESCE(SUM(rf.amount),0) FROM refunds rf WHERE rf.client_id = c.id) AS refunded,
      (SELECT COUNT(*) FROM packages p WHERE p.client_id = c.id AND p.status = 'active'
        AND p.sessions_used < p.sessions_total) AS active_packages
    FROM clients c LEFT JOIN users u ON u.id = c.counselor_id
    WHERE c.active = 1
    ORDER BY c.id`).all(r.overdue_days);

  const t = today();
  return rows.map(c => {
    const scheduled = c.done + c.no_show;                 // 取消不算爽約，只有「該來沒來」才扣
    const attendance = scheduled ? Math.round(c.done / scheduled * 100) : null;
    const daysSince = c.last_done
      ? Math.round((new Date(t) - new Date(c.last_done)) / 86400000) : null;
    const netPaid = c.paid_amount - c.refunded;

    // 三個面向各自 0-2 分
    const useScore = c.done >= r.vip_sessions ? 2 : c.done >= r.regular_sessions ? 1 : 0;
    const payScore = c.overdue_count ? 0 : (netPaid > 0 || c.active_packages ? 2 : 1);
    const attScore = attendance === null ? 1
      : attendance >= r.good_attendance ? 2 : attendance >= r.poor_attendance ? 1 : 0;
    const score = useScore + payScore + attScore;

    // 分級：先看幾個「狀態型」判定，再看分數
    let tier, why;
    if (c.overdue_count) { tier = 'attention'; why = `有 ${c.overdue_count} 筆逾期未收款`; }
    else if (attendance !== null && attendance < r.poor_attendance) { tier = 'attention'; why = `出席率 ${attendance}%`; }
    else if (c.status === 'closed') { tier = 'closed'; why = '已結案'; }
    else if (!c.next_appt && daysSince !== null && daysSince > r.dormant_days) {
      tier = 'dormant'; why = `距上次晤談 ${daysSince} 天且無後續預約`;
    } else if (c.done === 0) { tier = 'new'; why = '尚未完成第一次晤談'; }
    else if (score >= 5 && c.done >= r.vip_sessions) { tier = 'vip'; why = `完成 ${c.done} 次、出席率 ${attendance}%`; }
    else if (score >= 4) { tier = 'regular'; why = `完成 ${c.done} 次、出席率 ${attendance}%`; }
    else { tier = 'watch'; why = `完成 ${c.done} 次、出席率 ${attendance === null ? '—' : attendance + '%'}`; }

    return {
      ...c, attendance, days_since: daysSince, net_paid: netPaid,
      score, tier, why
    };
  });
}

const TIER_LABEL = {
  vip: '長期穩定', regular: '固定', watch: '觀察', new: '新收',
  dormant: '沉睡', attention: '需關注', closed: '已結案'
};

router.get('/client-tiers', requireStaff('clients'), (req, res) => {
  const all = computeTiers();
  const tier = String(req.query.tier || '');
  const counts = {};
  for (const k of Object.keys(TIER_LABEL)) counts[k] = all.filter(c => c.tier === k).length;
  res.json({
    labels: TIER_LABEL,
    rules: tierRules(),
    counts,
    total: all.length,
    rows: (tier ? all.filter(c => c.tier === tier) : all)
      .sort((a, b) => b.score - a.score || (b.done - a.done))
  });
});

// ---- 財務儀表板 ----
// 收入認列以「收費單日期」為準（實務上與晤談同日），退費以退費日扣抵。
function monthsBack(n) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function financeHandler(req, res) {
  const months = monthsBack(Number(req.query.months) || 12);
  const from = months[0] + '-01';
  const month = req.query.month || today().slice(0, 7);
  const like = month + '%';

  const byMonth = months.map(m => {
    const inv = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN status IN ('paid','refunded') THEN amount END),0) AS paid,
        COALESCE(SUM(CASE WHEN status = 'unpaid' THEN amount END),0) AS unpaid,
        COALESCE(SUM(CASE WHEN status = 'void' THEN amount END),0) AS void,
        COUNT(*) AS n
      FROM invoices WHERE substr(date,1,7) = ?`).get(m);
    const refund = db.prepare("SELECT COALESCE(SUM(amount),0) n FROM refunds WHERE substr(date,1,7) = ?").get(m).n;
    const sessions = db.prepare("SELECT COUNT(*) n FROM appointments WHERE substr(date,1,7) = ? AND status = 'done'").get(m).n;
    const payout = db.prepare("SELECT COALESCE(SUM(net),0) n FROM payouts WHERE month = ?").get(m).n;
    return {
      month: m, ...inv, refund, sessions, payout,
      net: inv.paid - refund,
      gross_margin: inv.paid - refund - payout,
      avg_fee: sessions ? Math.round((inv.paid - refund) / sessions) : 0
    };
  });

  const cur = byMonth[byMonth.length - 1] || {};
  const prev = byMonth[byMonth.length - 2] || {};
  const overdueDays = Number(getSetting('overdue_days', '14'));

  res.json({
    months: byMonth,
    month,
    // 當月重點數字
    summary: {
      net: cur.net || 0,
      prev_net: prev.net || 0,
      growth: prev.net ? Math.round(((cur.net - prev.net) / prev.net) * 1000) / 10 : null,
      sessions: cur.sessions || 0,
      avg_fee: cur.avg_fee || 0,
      payout: cur.payout || 0,
      gross_margin: cur.gross_margin || 0,
      unpaid_total: db.prepare("SELECT COALESCE(SUM(amount),0) n FROM invoices WHERE status = 'unpaid'").get().n,
      overdue_total: db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM invoices WHERE status = 'unpaid'
        AND date <= date('now','localtime','-' || ? || ' day')`).get(overdueDays).n,
      overdue_count: db.prepare(`SELECT COUNT(*) n FROM invoices WHERE status = 'unpaid'
        AND date <= date('now','localtime','-' || ? || ' day')`).get(overdueDays).n,
      unused_package_value: db.prepare(`SELECT COALESCE(SUM(
          CASE WHEN sessions_total > 0 THEN amount * (sessions_total - sessions_used) / sessions_total ELSE 0 END),0) n
        FROM packages WHERE status = 'active' AND sessions_used < sessions_total`).get().n
    },
    // 收入結構
    by_payer: db.prepare(`SELECT COALESCE(NULLIF(payer,''),'未填') AS payer,
        COALESCE(SUM(amount),0) AS amount, COUNT(*) AS n
      FROM invoices WHERE date LIKE ? AND status IN ('paid','refunded')
      GROUP BY payer ORDER BY amount DESC`).all(like),
    by_method: db.prepare(`SELECT COALESCE(NULLIF(method,''),'未填') AS method,
        COALESCE(SUM(amount),0) AS amount, COUNT(*) AS n
      FROM invoices WHERE date LIKE ? AND status = 'paid' GROUP BY method ORDER BY amount DESC`).all(like),
    by_counselor: db.prepare(`SELECT u.name,
        COALESCE(SUM(i.amount),0) AS amount,
        COUNT(DISTINCT a.id) AS sessions
      FROM appointments a
      JOIN users u ON u.id = a.counselor_id
      LEFT JOIN invoices i ON i.appointment_id = a.id AND i.status IN ('paid','refunded')
      WHERE a.date LIKE ? AND a.status = 'done'
      GROUP BY u.id ORDER BY amount DESC`).all(like),
    by_site: db.prepare(`SELECT COALESCE(s.name,'未指定據點') AS site,
        COUNT(*) AS sessions,
        COALESCE(SUM(i.amount),0) AS amount
      FROM appointments a
      LEFT JOIN sites s ON s.id = a.site_id
      LEFT JOIN invoices i ON i.appointment_id = a.id AND i.status IN ('paid','refunded')
      WHERE a.date LIKE ? AND a.status = 'done'
      GROUP BY a.site_id ORDER BY amount DESC`).all(like),
    // 逾期帳款前幾名，直接可以打電話
    top_overdue: db.prepare(`SELECT i.id, i.date, i.item, i.amount, c.id AS client_id, c.name AS client_name,
        c.code AS client_code, c.phone,
        CAST(julianday('now','localtime') - julianday(i.date) AS INTEGER) AS days
      FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.status = 'unpaid' AND i.date <= date('now','localtime','-' || ? || ' day')
      ORDER BY i.date LIMIT 20`).all(overdueDays),
    from
  });
}
router.get('/finance/dashboard', requireStaff('billing'), financeHandler);

// 財務數字抽成函式，AI 助理與這個路由共用同一套算法
function financeSummary(month, months) {
  const req = { query: { month, months } };
  let payload = null;
  financeHandler(req, { json: d => { payload = d; } });
  return payload;
}

module.exports = router;
module.exports.computeTiers = computeTiers;
module.exports.TIER_LABEL = TIER_LABEL;
module.exports.financeSummary = financeSummary;
