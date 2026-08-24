const { db, today, getSetting } = require('./db');

// 財務與人員績效指標（6.3／6.4）
//
// 兩個會影響所有數字的決定，寫在這裡而不是散在各個查詢裡：
//
// 1. 認列基礎：療程包套「按次攤提」，不在購買當月一次認列。
//    購買 10 次 18,000 的方案，當月不是收入 18,000，而是每用一次認列 1,800。
//    不這樣做的話，賣方案的月份營收爆高、之後幾個月看起來像衰退，管理判斷會失真。
//
// 2. 未到（no-show）不算服務時數，但收到的錢仍是營收。
//    時段被佔住卻沒有產生服務，這是兩件事，分開計算才看得出問題在哪。

const round1 = n => Math.round(n * 10) / 10;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

// ---- 收入認列（權責基礎）----
// 一般收費：以收費單日期認列（實務上與服務同日）
// 方案：購買當期不認列，改以「該月實際使用次數 × 每次單價」攤提
function revenueOfMonth(month, siteId) {
  const like = month + '%';
  const siteCond = siteId ? 'AND i.site_id = ?' : '';
  const args = siteId ? [like, siteId] : [like];

  // 一般收費（排除方案購買單，那筆要攤提）
  const direct = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN i.status IN ('paid','refunded') THEN i.amount END),0) AS paid,
      COALESCE(SUM(CASE WHEN i.status = 'unpaid' THEN i.amount END),0) AS unpaid,
      COALESCE(SUM(CASE WHEN i.status IN ('paid','refunded') AND i.payer = '自費' THEN i.amount END),0) AS self_pay
    FROM invoices i WHERE i.date LIKE ? ${siteCond} AND i.status <> 'void' AND i.package_id IS NULL`)
    .get(...args);

  const refund = db.prepare(`SELECT COALESCE(SUM(rf.amount),0) n FROM refunds rf
    ${siteId ? 'JOIN invoices i ON i.id = rf.invoice_id' : ''}
    WHERE substr(rf.date,1,7) = ? ${siteId ? 'AND i.site_id = ?' : ''}`)
    .get(...(siteId ? [month, siteId] : [month])).n;

  // 方案攤提：該月完成且由方案扣次的晤談 × 每次單價
  const pkgRows = db.prepare(`SELECT a.id, p.amount, p.sessions_total, a.site_id
    FROM appointments a JOIN packages p ON p.id = a.package_id
    WHERE substr(a.date,1,7) = ? AND a.status = 'done' AND a.package_id IS NOT NULL
      ${siteId ? 'AND a.site_id = ?' : ''}`).all(...(siteId ? [month, siteId] : [month]));
  const packageRecognized = pkgRows.reduce((n, r) =>
    n + (r.sessions_total > 0 ? Math.round(r.amount / r.sessions_total) : 0), 0);

  const gross = direct.paid - refund + packageRecognized;
  return {
    invoiced: direct.paid,
    unpaid: direct.unpaid,
    refund,
    package_recognized: packageRecognized,
    package_sessions: pkgRows.length,
    revenue: gross,
    self_pay: direct.self_pay,
    self_pay_ratio: pct(direct.self_pay, gross)
  };
}

// ---- 據點損益（6.3）----
function overheadRule(month) {
  return db.prepare(`SELECT * FROM overhead_rules WHERE effective_from <= ?
    ORDER BY effective_from DESC, id DESC LIMIT 1`).get(month)
    || { method: 'revenue', note: '（未設定，預設依營收分攤）', effective_from: '' };
}

function siteProfit(month) {
  const sites = db.prepare('SELECT id, name FROM sites WHERE active = 1 ORDER BY sort, id').all();
  const rule = overheadRule(month);

  const rows = sites.map(s => {
    const rev = revenueOfMonth(month, s.id);
    const direct = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM cost_entries
      WHERE month = ? AND site_id = ? AND kind IN ('direct','staff')`).get(month, s.id).n;
    const sessions = db.prepare(`SELECT COUNT(*) n FROM appointments
      WHERE substr(date,1,7) = ? AND status = 'done' AND site_id = ?`).get(month, s.id).n;
    const heads = db.prepare('SELECT COUNT(*) n FROM user_sites WHERE site_id = ?').get(s.id).n;
    return {
      site_id: s.id, name: s.name, ...rev,
      direct_cost: direct,
      contribution: rev.revenue - direct,     // 貢獻毛利（不含總部分攤）
      sessions, heads
    };
  });

  const overhead = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM cost_entries
    WHERE month = ? AND kind = 'overhead'`).get(month).n;
  const totalRev = rows.reduce((n, r) => n + Math.max(0, r.revenue), 0);
  const totalSessions = rows.reduce((n, r) => n + r.sessions, 0);
  const totalHeads = rows.reduce((n, r) => n + r.heads, 0);

  for (const r of rows) {
    let share = 0;
    if (rule.method === 'revenue') share = totalRev ? Math.max(0, r.revenue) / totalRev : 0;
    else if (rule.method === 'sessions') share = totalSessions ? r.sessions / totalSessions : 0;
    else if (rule.method === 'headcount') share = totalHeads ? r.heads / totalHeads : 0;
    else share = rows.length ? 1 / rows.length : 0;
    r.overhead_share = Math.round(overhead * share);
    r.pretax = r.contribution - r.overhead_share;

    const extra = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN kind = 'interest' THEN amount END),0) AS interest,
        COALESCE(SUM(CASE WHEN kind = 'depreciation' THEN amount END),0) AS depreciation,
        COALESCE(SUM(CASE WHEN kind = 'amortization' THEN amount END),0) AS amortization
      FROM cost_entries WHERE month = ? AND site_id = ?`).get(month, r.site_id);
    r.interest = extra.interest;
    r.depreciation = extra.depreciation;
    r.amortization = extra.amortization;
    // EBITDA＝稅前損益 ＋ 利息 ＋ 折舊 ＋ 攤銷
    r.ebitda = r.pretax + extra.interest + extra.depreciation + extra.amortization;
  }

  return {
    month, rule, overhead, rows,
    total: {
      revenue: rows.reduce((n, r) => n + r.revenue, 0),
      direct_cost: rows.reduce((n, r) => n + r.direct_cost, 0),
      contribution: rows.reduce((n, r) => n + r.contribution, 0),
      pretax: rows.reduce((n, r) => n + r.pretax, 0),
      ebitda: rows.reduce((n, r) => n + r.ebitda, 0),
      self_pay: rows.reduce((n, r) => n + r.self_pay, 0)
    }
  };
}

// ---- 應收帳齡（依來源別，30／60／90／90+）----
function arAging() {
  const rows = db.prepare(`SELECT i.id, i.date, i.amount, COALESCE(NULLIF(i.payer,''),'未填') AS payer,
      CAST(julianday('now','localtime') - julianday(i.date) AS INTEGER) AS days,
      c.name AS client_name, c.code AS client_code
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.status = 'unpaid' ORDER BY i.date`).all();
  const buckets = ['30', '60', '90', '90+'];
  const bucketOf = d => (d <= 30 ? '30' : d <= 60 ? '60' : d <= 90 ? '90' : '90+');
  const bySource = {};
  for (const r of rows) {
    if (!bySource[r.payer]) bySource[r.payer] = { payer: r.payer, total: 0, 30: 0, 60: 0, 90: 0, '90+': 0 };
    bySource[r.payer][bucketOf(r.days)] += r.amount;
    bySource[r.payer].total += r.amount;
  }
  return {
    buckets,
    rows: Object.values(bySource).sort((a, b) => b.total - a.total),
    total: rows.reduce((n, r) => n + r.amount, 0),
    count: rows.length,
    oldest: rows.length ? rows[0] : null
  };
}

// ---- 人員績效（6.4）----
function staffMetrics(month) {
  const users = db.prepare(`SELECT id, name, hire_date, target_utilization, contract_type, license_type
    FROM users WHERE active = 1 AND role IN ('counselor','supervisor') ORDER BY id`).all();
  const { capacityOf } = require('./routes/staffing');
  const burden = Number(getSetting('employer_burden_rate', '0.18'));
  const like = month + '%';

  // 初診（品牌獲客比例的分母）：該月的初談預約
  const intakeTotal = db.prepare(`SELECT COUNT(*) n FROM appointments
    WHERE date LIKE ? AND type = 'intake' AND status = 'done'`).get(like).n;
  const intakeNoPick = db.prepare(`SELECT COUNT(*) n FROM appointments
    WHERE date LIKE ? AND type = 'intake' AND status = 'done' AND designated = 0`).get(like).n;

  const rows = users.map(u => {
    const appt = db.prepare(`SELECT
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS no_show,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN designated = 1 THEN 1 ELSE 0 END) AS designated,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'done' THEN
          (strftime('%s', date || ' ' || end_time) - strftime('%s', date || ' ' || start_time)) / 3600.0 END), 0) AS hours
      FROM appointments WHERE counselor_id = ? AND date LIKE ?`).get(u.id, like);

    // 個人營收＝分帳結果裡屬於機構＋心理師的總額（即該員帶進來的收入）
    const split = db.prepare(`SELECT COALESCE(SUM(amount),0) AS revenue,
        COALESCE(SUM(counselor_amount),0) AS payout
      FROM invoice_splits WHERE counselor_id = ? AND month = ?`).get(u.id, month);

    // 直接成本：優先用登錄的人事成本；沒有就以拆分給心理師的報酬 × (1＋雇主負擔率) 概估
    const logged = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM cost_entries
      WHERE month = ? AND user_id = ? AND kind = 'staff'`).get(month, u.id).n;
    const cost = logged || Math.round(split.payout * (1 + burden));

    const capacity = capacityOf(u.id, month);
    const hours = round1(appt.hours);
    return {
      ...u,
      sessions: appt.done, no_show: appt.no_show, cancelled: appt.cancelled,
      booked_total: appt.total, designated_count: appt.designated,
      hours,
      capacity_hours: capacity,
      utilization: pct(hours, capacity),
      revenue: split.revenue,
      payout: split.payout,
      direct_cost: cost,
      cost_estimated: !logged,
      contribution: split.revenue - cost,
      hourly_rate: hours ? Math.round(split.revenue / hours) : null,
      designated_ratio: pct(appt.designated, appt.total),
      no_show_rate: pct(appt.no_show, appt.total),
      cancel_rate: pct(appt.cancelled, appt.total)
    };
  });

  const totalRev = rows.reduce((n, r) => n + r.revenue, 0);
  rows.sort((a, b) => b.revenue - a.revenue);
  let cum = 0;
  for (const r of rows) {
    r.revenue_share = pct(r.revenue, totalRev);
    cum += r.revenue;
    r.cumulative_share = pct(cum, totalRev);   // 集中度：前幾位佔了多少
  }

  return {
    month, rows,
    total_revenue: totalRev,
    brand_acquisition: {
      intake_total: intakeTotal,
      no_designated: intakeNoPick,
      ratio: pct(intakeNoPick, intakeTotal)
    },
    // 留任率：年初在職且年末仍在職 ÷ 年初在職
    retention: (() => {
      const year = month.slice(0, 4);
      const startOfYear = `${year}-01-01`;
      const atStart = db.prepare(`SELECT COUNT(*) n FROM users
        WHERE role IN ('counselor','supervisor') AND hire_date <> '' AND hire_date <= ?`).get(startOfYear).n;
      const stillHere = db.prepare(`SELECT COUNT(*) n FROM users
        WHERE role IN ('counselor','supervisor') AND hire_date <> '' AND hire_date <= ? AND active = 1`)
        .get(startOfYear).n;
      return { year, at_start: atStart, still_here: stillHere, rate: pct(stillHere, atStart) };
    })(),
    burden_rate: burden
  };
}

module.exports = { revenueOfMonth, siteProfit, arAging, staffMetrics, overheadRule, pct, round1 };
