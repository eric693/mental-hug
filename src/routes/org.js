const express = require('express');
const bcrypt = require('bcryptjs');
const { db, audit, today, addDays, getSetting, setSetting, listSetting, UI_TEXT_KEYS } = require('../db');
const { requireStaff, requireAdmin, MODULES, MODULE_KEYS, ROLE_DEFAULT_MODULES, parsePermissions } = require('../auth');
const { SCALE_KEYS } = require('../scales');
const { withReportState } = require('./risk');

const router = express.Router();

// ---- 總覽 ----
// 心理師個人儀表板：總覽是所方視角，這裡是「我的」視角——
// 我的服務量、待補紀錄、督導時數、繼續教育積分與執照倒數，資料一律限本人。
router.get('/my-dashboard', requireStaff(), (req, res) => {
  const uid = req.user.id;
  const t = today();
  const year = t.slice(0, 4);
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  const cycle = Number(getSetting('ce_cycle_years', '6'));
  const licenseExpiry = req.user.license_expiry || '';
  const ceEnd = licenseExpiry || t;
  const ceStart = addDays(ceEnd, -Math.round(cycle * 365.25));
  const special = ['專業品質', '專業倫理', '專業相關法規'];
  const ceList = db.prepare('SELECT category, credits FROM ce_credits WHERE user_id = ? AND date BETWEEN ? AND ?')
    .all(uid, ceStart, ceEnd > t ? t : ceEnd);
  const round1 = n => Math.round(n * 10) / 10;

  res.json({
    today: t,
    me: {
      name: req.user.name, title: req.user.title,
      license_type: req.user.license_type, license_no: req.user.license_no,
      license_expiry: licenseExpiry,
      license_days_left: licenseExpiry
        ? Math.round((new Date(licenseExpiry + 'T00:00:00') - new Date(t + 'T00:00:00')) / 86400000)
        : null
    },
    today_appointments: db.prepare(`SELECT a.*, c.name AS client_name, c.code AS client_code, c.risk_level,
        r.name AS room_name FROM appointments a JOIN clients c ON c.id = a.client_id
        LEFT JOIN rooms r ON r.id = a.room_id
        WHERE a.date = ? AND a.counselor_id = ? ORDER BY a.start_time`).all(t, uid),
    week_appointments: one(`SELECT COUNT(*) n FROM appointments WHERE counselor_id = ?
      AND date BETWEEN date('now','localtime') AND date('now','localtime','+6 days')
      AND status IN ('booked','arrived')`, uid).n,
    my_clients: one("SELECT COUNT(*) n FROM clients WHERE counselor_id = ? AND active = 1 AND status IN ('intake','active')", uid).n,
    my_high_risk: one("SELECT COUNT(*) n FROM clients WHERE counselor_id = ? AND active = 1 AND risk_level = 'high' AND status != 'closed'", uid).n,
    month_sessions: one(`SELECT COUNT(*) n FROM appointments WHERE counselor_id = ? AND status = 'done'
      AND substr(date,1,7) = substr(date('now','localtime'),1,7)`, uid).n,
    year_sessions: one(`SELECT COUNT(*) n FROM appointments WHERE counselor_id = ? AND status = 'done'
      AND substr(date,1,4) = ?`, uid, year).n,
    month_no_show: one(`SELECT COUNT(*) n FROM appointments WHERE counselor_id = ? AND status = 'no_show'
      AND substr(date,1,7) = substr(date('now','localtime'),1,7)`, uid).n,
    // 待補紀錄：逾所內規定天數者另計，這是最容易被稽核的項目
    pending_notes: db.prepare(`SELECT a.id, a.date, a.type, c.id AS client_id, c.name AS client_name, c.code AS client_code,
        CAST(julianday('now','localtime') - julianday(a.date) AS INTEGER) AS days_ago
      FROM appointments a JOIN clients c ON c.id = a.client_id
      WHERE a.counselor_id = ? AND a.status = 'done'
        AND NOT EXISTS (SELECT 1 FROM session_notes n WHERE n.appointment_id = a.id)
      ORDER BY a.date LIMIT 20`).all(uid),
    note_lock_days: Number(getSetting('note_lock_days', '7')),
    // 實習生：我被退回待補正的紀錄；督導：待我覆核的紀錄
    notes_returned: db.prepare(`SELECT n.id, n.date, n.review_comment, c.id AS client_id,
        c.name AS client_name, c.code AS client_code
      FROM session_notes n JOIN clients c ON c.id = n.client_id
      WHERE n.counselor_id = ? AND n.review_status = 'returned' ORDER BY n.reviewed_at DESC LIMIT 10`).all(uid),
    notes_to_review: db.prepare(`SELECT COUNT(*) n FROM session_notes sn JOIN users u ON u.id = sn.counselor_id
      WHERE sn.review_status = 'pending' AND (u.supervisor_id = ?
        OR ? IN (SELECT id FROM users WHERE role IN ('admin','supervisor') AND id = ?))`).get(uid, uid, uid).n,
    // 我的高風險個案缺安全計畫或已逾檢視日
    safety_alerts: db.prepare(`SELECT c.id AS client_id, c.name AS client_name, c.code AS client_code,
        c.risk_level, s.id AS plan_id, s.review_date,
        CASE WHEN s.id IS NULL THEN 'missing' ELSE 'due' END AS state
      FROM clients c LEFT JOIN safety_plans s ON s.client_id = c.id AND s.status = 'active'
      WHERE c.counselor_id = ? AND c.active = 1 AND c.status != 'closed'
        AND ((c.risk_level = 'high' AND s.id IS NULL)
          OR (s.id IS NOT NULL AND s.review_date != '' AND s.review_date <= date('now','localtime')))
      ORDER BY c.risk_level = 'high' DESC, c.code LIMIT 20`).all(uid),
    due_plans: db.prepare(`SELECT p.id, p.review_date, p.client_id, c.name AS client_name, c.code AS client_code
      FROM treatment_plans p JOIN clients c ON c.id = p.client_id
      WHERE p.counselor_id = ? AND p.status = 'active' AND p.review_date != ''
        AND p.review_date <= date('now','localtime') ORDER BY p.review_date LIMIT 10`).all(uid),
    supervision: {
      year,
      required: Number(getSetting('supervision_required_hours', '20')),
      hours: round1(one("SELECT COALESCE(SUM(hours),0) h FROM supervisions WHERE counselor_id = ? AND substr(date,1,4) = ?", uid, year).h),
      individual: round1(one("SELECT COALESCE(SUM(hours),0) h FROM supervisions WHERE counselor_id = ? AND type = 'individual' AND substr(date,1,4) = ?", uid, year).h)
    },
    ce: {
      cycle_start: ceStart, cycle_end: ceEnd,
      required: Number(getSetting('ce_required_credits', '120')),
      required_special: Number(getSetting('ce_required_special', '12')),
      required_ethics: Number(getSetting('ce_required_ethics', '2')),
      credits: round1(ceList.reduce((s, r) => s + r.credits, 0)),
      special_credits: round1(ceList.filter(r => special.includes(r.category)).reduce((s, r) => s + r.credits, 0)),
      ethics_credits: round1(ceList.filter(r => r.category === '專業倫理').reduce((s, r) => s + r.credits, 0))
    },
    // 本週排程一覽（含視訊連結），不必再切到週檢視
    week_schedule: db.prepare(`SELECT a.id, a.date, a.start_time, a.end_time, a.type, a.mode, a.status, a.meeting_url,
        c.id AS client_id, c.name AS client_name, c.risk_level, r.name AS room_name
      FROM appointments a JOIN clients c ON c.id = a.client_id LEFT JOIN rooms r ON r.id = a.room_id
      WHERE a.counselor_id = ? AND a.date BETWEEN date('now','localtime') AND date('now','localtime','+6 days')
        AND a.status IN ('booked','arrived') ORDER BY a.date, a.start_time LIMIT 40`).all(uid),
    // 我負責個案的未讀訊息與待填量表，行政聯繫不漏接
    unread_messages: one(`SELECT COUNT(*) n FROM messages m JOIN clients c ON c.id = m.client_id
      WHERE c.counselor_id = ? AND m.sender = 'client' AND m.read_at = ''`, uid).n,
    pending_tasks: db.prepare(`SELECT t.id, t.scale, t.due_date, c.id AS client_id, c.name AS client_name
      FROM assessment_tasks t JOIN clients c ON c.id = t.client_id
      WHERE t.done_id IS NULL AND (t.assigned_by = ? OR c.counselor_id = ?)
      ORDER BY t.due_date LIMIT 20`).all(uid, uid),
    // 我負責個案追蹤中的危機事件；通報狀態與剩餘時間沿用危機事件頁的算法
    // （後端以本地時間計算，前端不再自行比對時間字串）
    open_risk_events: db.prepare(`SELECT e.*, c.id AS client_id, c.name AS client_name, c.code AS client_code
      FROM risk_events e JOIN clients c ON c.id = e.client_id
      WHERE e.status = 'open' AND (c.counselor_id = ? OR e.handler_id = ?)
      ORDER BY e.date DESC LIMIT 20`).all(uid, uid).map(withReportState),
    // 服務量對應的收費（僅本人個案），供心理師掌握自己的產值
    month_revenue: one(`SELECT COALESCE(SUM(i.amount),0) n FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE c.counselor_id = ? AND i.status != 'void'
        AND substr(i.date,1,7) = substr(date('now','localtime'),1,7)`, uid).n,
    month_revenue_unpaid: one(`SELECT COALESCE(SUM(i.amount),0) n FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE c.counselor_id = ? AND i.status = 'unpaid'`, uid).n,
    // 待完成的衡鑑報告（未撰寫＋草稿）
    pending_reports: one(`SELECT
        (SELECT COUNT(*) FROM appointments a WHERE a.counselor_id = ? AND a.status = 'done' AND a.type = 'assessment'
          AND NOT EXISTS (SELECT 1 FROM assessment_reports r WHERE r.client_id = a.client_id AND r.test_date = a.date))
        + (SELECT COUNT(*) FROM assessment_reports r WHERE r.counselor_id = ? AND r.locked = 0) AS n`, uid, uid).n,
    upcoming_time_off: db.prepare(`SELECT start_date, end_date, all_day, start_time, end_time, reason
      FROM time_off WHERE counselor_id = ? AND end_date >= date('now','localtime')
      ORDER BY start_date LIMIT 5`).all(uid),
    // 報酬僅顯示本人的單據，且只在有 payouts 權限時查詢
    my_payouts: db.prepare(`SELECT month, item, sessions, gross, net, status FROM payouts
      WHERE user_id = ? ORDER BY month DESC, id DESC LIMIT 6`).all(uid)
  });
});

router.get('/dashboard', requireStaff(), (req, res) => {
  const t = today();
  const mine = req.user.role === 'counselor';
  const my = mine ? req.user.id : null;
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  const todaySql = `SELECT a.*, c.name AS client_name, c.code AS client_code, c.risk_level,
      u.name AS counselor_name, r.name AS room_name
    FROM appointments a JOIN clients c ON c.id = a.client_id
    LEFT JOIN users u ON u.id = a.counselor_id LEFT JOIN rooms r ON r.id = a.room_id
    WHERE a.date = ? ${my ? 'AND a.counselor_id = ' + my : ''} ORDER BY a.start_time`;

  const pendingNotes = db.prepare(`SELECT COUNT(*) n FROM appointments a
    WHERE a.status = 'done' ${my ? 'AND a.counselor_id = ' + my : ''}
      AND NOT EXISTS (SELECT 1 FROM session_notes n WHERE n.appointment_id = a.id)`).get().n;

  res.json({
    today: t,
    scope: mine ? 'mine' : 'all',
    today_appointments: db.prepare(todaySql).all(t),
    active_clients: one(`SELECT COUNT(*) n FROM clients WHERE active = 1 AND status IN ('intake','active') ${my ? 'AND counselor_id = ' + my : ''}`).n,
    high_risk: one(`SELECT COUNT(*) n FROM clients WHERE active = 1 AND risk_level = 'high' AND status != 'closed' ${my ? 'AND counselor_id = ' + my : ''}`).n,
    open_risk_events: one('SELECT COUNT(*) n FROM risk_events WHERE status = \'open\'').n,
    pending_notes: pendingNotes,
    week_sessions: one(`SELECT COUNT(*) n FROM appointments WHERE status = 'done'
      AND date >= date('now','localtime','-6 days') ${my ? 'AND counselor_id = ' + my : ''}`).n,
    month_sessions: one(`SELECT COUNT(*) n FROM appointments WHERE status = 'done'
      AND substr(date,1,7) = substr(date('now','localtime'),1,7) ${my ? 'AND counselor_id = ' + my : ''}`).n,
    no_show_month: one(`SELECT COUNT(*) n FROM appointments WHERE status = 'no_show'
      AND substr(date,1,7) = substr(date('now','localtime'),1,7) ${my ? 'AND counselor_id = ' + my : ''}`).n,
    unpaid: one("SELECT COUNT(*) c, COALESCE(SUM(amount),0) amt FROM invoices WHERE status = 'unpaid'"),
    unread_messages: one("SELECT COUNT(*) n FROM messages WHERE sender = 'client' AND read_at = ''").n,
    pending_tasks: one('SELECT COUNT(*) n FROM assessment_tasks WHERE done_id IS NULL').n,
    pending_intakes: one("SELECT COUNT(*) n FROM intakes WHERE status IN ('new','waiting')").n,
    tomorrow_count: one(`SELECT COUNT(*) n FROM appointments WHERE date = date('now','localtime','+1 day')
      AND status = 'booked'`).n,
    tomorrow_unreminded: one(`SELECT COUNT(*) n FROM appointments WHERE date = date('now','localtime','+1 day')
      AND status = 'booked' AND reminded_at = ''`).n,
    license_alerts: db.prepare(`SELECT id, name, license_type, license_expiry,
        CAST(julianday(license_expiry) - julianday('now','localtime') AS INTEGER) AS days_left
      FROM users WHERE active = 1 AND license_expiry != ''
        AND julianday(license_expiry) - julianday('now','localtime') <= ?
      ORDER BY license_expiry`).all(Number(getSetting('license_alert_days', '180'))),
    partner_expiring: db.prepare(`SELECT id, name, contract_end FROM partners
      WHERE active = 1 AND contract_end != '' AND contract_end <= date('now','localtime','+60 days')
      ORDER BY contract_end`).all(),
    unsettled: one(`SELECT COUNT(*) n FROM settlements WHERE status != 'paid'`).n,
    running_groups: one("SELECT COUNT(*) n FROM groups WHERE status = 'running'").n,
    alert_assessments: db.prepare(`SELECT a.id, a.scale, a.date, a.total, a.severity, c.name AS client_name, c.code AS client_code
      FROM assessments a JOIN clients c ON c.id = a.client_id
      WHERE a.alert = 1 AND a.date >= date('now','localtime','-30 days') ORDER BY a.date DESC LIMIT 10`).all(),
    due_plans: db.prepare(`SELECT p.id, p.review_date, p.client_id, c.name AS client_name, c.code AS client_code
      FROM treatment_plans p JOIN clients c ON c.id = p.client_id
      WHERE p.status = 'active' AND p.review_date != '' AND p.review_date <= date('now','localtime')
      ${my ? 'AND p.counselor_id = ' + my : ''} ORDER BY p.review_date LIMIT 10`).all(),
    // 個案端逾期取消只能送出申請，由櫃檯決定是否計費，故列在總覽待處理
    cancel_requests: db.prepare(`SELECT a.id, a.date, a.start_time, a.cancel_requested_at, a.cancel_request_reason,
        c.name AS client_name, c.code AS client_code, u.name AS counselor_name
      FROM appointments a JOIN clients c ON c.id = a.client_id LEFT JOIN users u ON u.id = a.counselor_id
      WHERE a.status = 'booked' AND a.cancel_requested_at != '' ${my ? 'AND a.counselor_id = ' + my : ''}
      ORDER BY a.date LIMIT 20`).all(),
    // 取消釋出、未來仍空著的時段：可從候補名單遞補
    open_slots: one(`SELECT COUNT(*) n FROM appointments a WHERE a.status IN ('cancelled','no_show')
      AND a.date >= date('now','localtime') ${my ? 'AND a.counselor_id = ' + my : ''}
      AND NOT EXISTS (SELECT 1 FROM appointments b WHERE b.date = a.date AND b.counselor_id = a.counselor_id
        AND b.status IN ('booked','arrived') AND b.start_time < a.end_time AND b.end_time > a.start_time)`).n,
    waitlist_count: one("SELECT COUNT(*) n FROM intakes WHERE status IN ('new','waiting')").n,
    // 實習生紀錄待覆核（督導看自己督導的，管理者／督導看全部）
    notes_pending_review: one(`SELECT COUNT(*) n FROM session_notes sn JOIN users u ON u.id = sn.counselor_id
      WHERE sn.review_status = 'pending'
      ${req.user.role === 'admin' || req.user.role === 'supervisor' ? '' : 'AND u.supervisor_id = ' + req.user.id}`).n,
    // 高風險個案尚未建立安全計畫／安全計畫逾檢視日
    safety: one(`SELECT
        (SELECT COUNT(*) FROM clients c WHERE c.active = 1 AND c.status != 'closed' AND c.risk_level = 'high'
          ${my ? 'AND c.counselor_id = ' + my : ''}
          AND NOT EXISTS (SELECT 1 FROM safety_plans s WHERE s.client_id = c.id AND s.status = 'active')) AS missing,
        (SELECT COUNT(*) FROM safety_plans s JOIN clients c ON c.id = s.client_id
          WHERE s.status = 'active' AND s.review_date != '' AND s.review_date <= date('now','localtime')
          AND c.active = 1 AND c.status != 'closed' ${my ? 'AND c.counselor_id = ' + my : ''}) AS due`),
    // ---- 圖表資料（總覽長條圖）----
    // 近 6 個月：完成晤談數、實收金額（已收款 − 退費），以及本月各心理師服務量
    charts: {
      months: db.prepare(`WITH m(ym) AS (
          SELECT strftime('%Y-%m', date('now','localtime','start of month','-5 months'))
          UNION ALL SELECT strftime('%Y-%m', date(ym || '-01','+1 month')) FROM m
          WHERE ym < strftime('%Y-%m', date('now','localtime'))
        )
        SELECT m.ym,
          (SELECT COUNT(*) FROM appointments a WHERE substr(a.date,1,7) = m.ym AND a.status = 'done'
            ${my ? 'AND a.counselor_id = ' + my : ''}) AS sessions,
          (SELECT COUNT(*) FROM appointments a WHERE substr(a.date,1,7) = m.ym AND a.status = 'no_show'
            ${my ? 'AND a.counselor_id = ' + my : ''}) AS no_show,
          (SELECT COALESCE(SUM(amount),0) FROM invoices i WHERE substr(i.date,1,7) = m.ym AND i.status IN ('paid','refunded'))
            - (SELECT COALESCE(SUM(amount),0) FROM refunds r WHERE substr(r.date,1,7) = m.ym) AS income,
          (SELECT COUNT(*) FROM clients c WHERE substr(c.intake_date,1,7) = m.ym) AS new_clients
        FROM m`).all(),
      by_counselor: db.prepare(`SELECT u.name, COUNT(a.id) AS n FROM users u
        LEFT JOIN appointments a ON a.counselor_id = u.id AND a.status = 'done'
          AND substr(a.date,1,7) = substr(date('now','localtime'),1,7)
        WHERE u.active = 1 AND u.role IN ('counselor','supervisor','admin')
        GROUP BY u.id HAVING n > 0 ORDER BY n DESC LIMIT 8`).all()
    },
    security: req.user.role === 'admin' ? {
      default_admin_password: !!db.prepare("SELECT 1 FROM users WHERE username = 'admin'").get()
        && bcrypt.compareSync('mindcare123', db.prepare("SELECT password_hash h FROM users WHERE username = 'admin'").get().h),
      demo_hint_staff: !!getSetting('ui_demo_staff'),
      demo_hint_portal: !!getSetting('ui_demo_portal')
    } : null
  });
});

// ---- 共用參數與選項 ----
router.get('/meta', requireStaff(), (req, res) => {
  const out = {
    modules: MODULES,
    scales: SCALE_KEYS,
    counselors: db.prepare("SELECT id, name, role, license_type FROM users WHERE active = 1 AND role IN ('counselor','supervisor','admin') ORDER BY id").all(),
    rooms: db.prepare(`SELECT r.id, r.name, r.site_id, s.name AS site_name FROM rooms r
      LEFT JOIN sites s ON s.id = r.site_id WHERE r.active = 1 ORDER BY s.sort, r.id`).all(),
    sites: db.prepare('SELECT id, name, short_name, address, phone FROM sites WHERE active = 1 ORDER BY sort, id').all(),
    session_minutes: Number(getSetting('session_minutes', '50')),
    default_fee: Number(getSetting('default_fee', '2000')),
    intake_fee: Number(getSetting('intake_fee', '2500')),
    cancel_hours: Number(getSetting('cancel_hours', '24')),
    center_name: getSetting('center_name'),
    adult_age: Number(getSetting('adult_age', '18')),
    report_deadline_hours: Number(getSetting('report_deadline_hours', '24')),
    notify_enabled: !!getSetting('notify_webhook_url').trim(),
    // 排班表可自訂起訖與間距；快填按鈕由設定字串解析（格式：名稱|星期|時段）
    shift: {
      start: getSetting('shift_start', '08:00'),
      end: getSetting('shift_end', '21:00'),
      step: Number(getSetting('shift_step', '30')) || 30,
      quick_fills: getSetting('shift_quick_fills', '').split('\n').map(line => {
        const [label, days, ranges] = String(line).split('|');
        if (!label || !days || !ranges) return null;
        return {
          label: label.trim(),
          weekdays: days.split(',').map(n => Number(n.trim())).filter(n => n >= 0 && n <= 6),
          ranges: ranges.split(',').map(r => r.split('-').map(t => t.trim())).filter(r => r.length === 2 && r[0] && r[1])
        };
      }).filter(Boolean)
    },
    partners: db.prepare('SELECT id, name, type, rate FROM partners WHERE active = 1 ORDER BY id').all()
  };
  for (const k of ['counseling_types', 'approach_options', 'source_options', 'close_reasons', 'risk_types',
    'report_channels', 'pay_methods', 'payer_types', 'partner_types', 'time_off_reasons',
    'ce_categories', 'group_topics', 'subsidy_programs', 'mandatory_report_types',
    'follow_up_channels', 'referral_targets']) out[k] = listSetting(k);
  res.json(out);
});

// ---- 帳號 ----
router.get('/users', requireStaff('users'), (req, res) => {
  res.json(db.prepare(`SELECT id, username, name, role, title, license_type, license_no, license_expiry,
      specialty, phone, email, meeting_room_url, is_intern, supervisor_id, permissions, active,
      (SELECT name FROM users s WHERE s.id = users.supervisor_id) AS supervisor_name
    FROM users ORDER BY active DESC, id`)
    .all().map(u => ({ ...u, permissions: parsePermissions(u.permissions) })));
});

const USER_FIELDS = ['name', 'role', 'title', 'license_type', 'license_no', 'license_expiry', 'specialty',
  'phone', 'email', 'meeting_room_url', 'is_intern', 'supervisor_id'];

router.post('/users', requireStaff('users'), (req, res) => {
  const b = req.body || {};
  if (!b.username || !b.password) return res.status(400).json({ error: '請填寫帳號與密碼' });
  if (String(b.password).length < 6) return res.status(400).json({ error: '密碼至少 6 碼' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(b.username)) {
    return res.status(400).json({ error: '帳號已存在' });
  }
  const role = ['admin', 'counselor', 'supervisor', 'staff'].includes(b.role) ? b.role : 'staff';
  const perms = Array.isArray(b.permissions) && b.permissions.length
    ? b.permissions.filter(k => MODULE_KEYS.includes(k))
    : (ROLE_DEFAULT_MODULES[role] || []);
  // 實習生旗標與指定督導：布林與外鍵在此正規化，避免前端傳來空字串寫壞欄位
  if (b.is_intern !== undefined) b.is_intern = b.is_intern ? 1 : 0;
  if (b.supervisor_id !== undefined) b.supervisor_id = Number(b.supervisor_id) || null;
  const cols = USER_FIELDS.filter(f => b[f] !== undefined);
  const info = db.prepare(`INSERT INTO users (username, password_hash, role, permissions${cols.length ? ',' + cols.join(',') : ''})
    VALUES (?,?,?,?${cols.map(() => ',?').join('')})`)
    .run(b.username, bcrypt.hashSync(String(b.password), 10), role, JSON.stringify(perms), ...cols.map(c => b[c]));
  audit('staff', req.user.id, req.user.name, '新增帳號', b.username);
  res.json({ id: info.lastInsertRowid });
});

router.put('/users/:id', requireStaff('users'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '找不到此帳號' });
  const b = req.body || {};
  if (b.is_intern !== undefined) b.is_intern = b.is_intern ? 1 : 0;
  if (b.supervisor_id !== undefined) b.supervisor_id = Number(b.supervisor_id) || null;
  const data = {};
  for (const f of USER_FIELDS) if (b[f] !== undefined) data[f] = b[f];
  if (b.role && ['admin', 'counselor', 'supervisor', 'staff'].includes(b.role)) data.role = b.role;
  if (b.active !== undefined) data.active = b.active ? 1 : 0;
  if (Array.isArray(b.permissions)) data.permissions = JSON.stringify(b.permissions.filter(k => MODULE_KEYS.includes(k)));
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ error: '密碼至少 6 碼' });
    data.password_hash = bcrypt.hashSync(String(b.password), 10);
  }
  // 不允許停用或降權最後一個管理者，避免系統失去管理入口
  if ((data.active === 0 || (data.role && data.role !== 'admin')) && u.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").get().n;
    if (admins <= 1) return res.status(400).json({ error: '系統需保留至少一位啟用中的管理者' });
  }
  if (!Object.keys(data).length) return res.json({ ok: true });
  db.prepare(`UPDATE users SET ${Object.keys(data).map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(data), u.id);
  audit('staff', req.user.id, req.user.name, '修改帳號', u.username);

  // 停用心理師時，其未來預約不會自動取消（個案仍需服務，應改派而非取消），
  // 但要明確提醒有幾筆待改派，否則排班表上會留下無人負責的時段。
  const warnings = [];
  if (data.active === 0) {
    const pending = db.prepare(`SELECT COUNT(*) n FROM appointments
      WHERE counselor_id = ? AND status IN ('booked','arrived') AND date >= ?`).get(u.id, today()).n;
    if (pending) warnings.push(`${u.name} 尚有 ${pending} 筆未來預約，請改派其他心理師或取消`);
    const clients = db.prepare("SELECT COUNT(*) n FROM clients WHERE counselor_id = ? AND active = 1 AND status != 'closed'").get(u.id).n;
    if (clients) warnings.push(`${u.name} 仍為 ${clients} 位個案的主責心理師，請重新指派`);
  }
  res.json({ ok: true, warnings });
});

// 刪除帳號：只有「完全沒用過」的帳號可以真的刪掉（例如建錯帳號）。
// 已排過班、寫過紀錄或收過款的帳號一律改為停用——歷史資料要指得回人。
router.delete('/users/:id', requireStaff('users'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: '找不到此帳號' });
  if (u.id === req.user.id) return res.status(400).json({ error: '不可刪除自己的帳號' });
  if (u.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").get().n;
    if (admins <= 1) return res.status(400).json({ error: '系統需保留至少一位啟用中的管理者' });
  }
  const used = {
    預約: db.prepare('SELECT COUNT(*) n FROM appointments WHERE counselor_id = ?').get(u.id).n,
    晤談紀錄: db.prepare('SELECT COUNT(*) n FROM session_notes WHERE counselor_id = ?').get(u.id).n,
    主責個案: db.prepare('SELECT COUNT(*) n FROM clients WHERE counselor_id = ?').get(u.id).n,
    報酬單: db.prepare('SELECT COUNT(*) n FROM payouts WHERE user_id = ?').get(u.id).n
  };
  const busy = Object.entries(used).filter(([, n]) => n > 0);
  if (busy.length) {
    if (!u.active) return res.status(400).json({ error: '此帳號已有服務紀錄，只能停用，已是停用狀態' });
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
    audit('staff', req.user.id, req.user.name, '停用帳號', u.username, used);
    return res.json({
      ok: true, disabled: true,
      message: `此帳號已有 ${busy.map(([k, n]) => k + ' ' + n + ' 筆').join('、')}，改為停用（保留歷史資料）`
    });
  }
  db.prepare('DELETE FROM user_sites WHERE user_id = ?').run(u.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  audit('staff', req.user.id, req.user.name, '刪除帳號', u.username);
  res.json({ ok: true, disabled: false });
});

router.put('/me/password', requireStaff(), (req, res) => {
  const { old_password = '', new_password = '' } = req.body || {};
  if (!bcrypt.compareSync(old_password, req.user.password_hash)) return res.status(400).json({ error: '舊密碼不正確' });
  if (new_password.length < 6) return res.status(400).json({ error: '新密碼至少 6 碼' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.user.id);
  audit('staff', req.user.id, req.user.name, '修改自己的密碼');
  res.json({ ok: true });
});

// ---- 系統設定 ----
router.get('/settings', requireStaff('settings'), (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});
router.put('/settings', requireStaff('settings'), (req, res) => {
  const body = req.body || {};
  for (const [k, v] of Object.entries(body)) {
    if (!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(k) && !UI_TEXT_KEYS.includes(k)) continue;
    setSetting(k, v);
  }
  audit('staff', req.user.id, req.user.name, '修改系統設定', '', Object.keys(body).join(','));
  res.json({ ok: true });
});

// ---- 公告 ----
router.get('/announcements', requireStaff(), (req, res) => {
  res.json(db.prepare(`SELECT a.*, u.name AS author FROM announcements a
    LEFT JOIN users u ON u.id = a.created_by ORDER BY a.pinned DESC, a.publish_date DESC, a.id DESC LIMIT 100`).all());
});
router.post('/announcements', requireStaff('announcements'), (req, res) => {
  const { title = '', content = '', audience = 'all', pinned = 0, publish_date = today() } = req.body || {};
  if (!title) return res.status(400).json({ error: '請填寫標題' });
  const info = db.prepare('INSERT INTO announcements (title, content, audience, pinned, publish_date, created_by) VALUES (?,?,?,?,?,?)')
    .run(title, content, audience, pinned ? 1 : 0, publish_date, req.user.id);
  res.json({ id: info.lastInsertRowid });
});
router.put('/announcements/:id', requireStaff('announcements'), (req, res) => {
  const a2 = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  if (!a2) return res.status(404).json({ error: '找不到此公告' });
  const b2 = req.body || {};
  const title = b2.title === undefined ? a2.title : String(b2.title).trim();
  if (!title) return res.status(400).json({ error: '請填寫標題' });
  db.prepare(`UPDATE announcements SET title = ?, content = ?, audience = ?, pinned = ?, publish_date = ?
    WHERE id = ?`).run(title,
    b2.content === undefined ? a2.content : b2.content,
    b2.audience === undefined ? a2.audience : b2.audience,
    (b2.pinned === undefined ? a2.pinned : (b2.pinned ? 1 : 0)),
    b2.publish_date === undefined ? a2.publish_date : b2.publish_date, a2.id);
  audit('staff', req.user.id, req.user.name, '修改公告', String(a2.id));
  res.json({ ok: true });
});
router.delete('/announcements/:id', requireStaff('announcements'), (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- 個案訊息（行政聯繫用，非晤談內容）----
router.get('/messages', requireStaff('messages'), (req, res) => {
  const { client_id = '' } = req.query;
  if (client_id) {
    const rows = db.prepare(`SELECT m.*, u.name AS staff_name FROM messages m
      LEFT JOIN users u ON u.id = m.user_id WHERE m.client_id = ? ORDER BY m.id`).all(Number(client_id));
    db.prepare("UPDATE messages SET read_at = datetime('now','localtime') WHERE client_id = ? AND sender = 'client' AND read_at = ''")
      .run(Number(client_id));
    return res.json(rows);
  }
  res.json(db.prepare(`SELECT c.id AS client_id, c.name AS client_name, c.code AS client_code,
      (SELECT content FROM messages m WHERE m.client_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_content,
      (SELECT created_at FROM messages m WHERE m.client_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages m WHERE m.client_id = c.id AND m.sender = 'client' AND m.read_at = '') AS unread
    FROM clients c WHERE EXISTS (SELECT 1 FROM messages m WHERE m.client_id = c.id)
    ORDER BY unread DESC, last_at DESC`).all());
});
router.post('/messages', requireStaff('messages'), (req, res) => {
  const { client_id, content = '' } = req.body || {};
  if (!content.trim()) return res.status(400).json({ error: '請輸入內容' });
  const info = db.prepare("INSERT INTO messages (client_id, sender, user_id, content) VALUES (?, 'staff', ?, ?)")
    .run(Number(client_id), req.user.id, content.trim());
  res.json({ id: info.lastInsertRowid });
});

// ---- 統計報表 ----
router.get('/reports', requireStaff('reports'), (req, res) => {
  const month = req.query.month || today().slice(0, 7);
  const like = month + '%';
  res.json({
    month,
    by_counselor: db.prepare(`SELECT u.name,
        SUM(CASE WHEN a.status = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) AS no_show,
        SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        COUNT(DISTINCT CASE WHEN a.status = 'done' THEN a.client_id END) AS clients
      FROM users u LEFT JOIN appointments a ON a.counselor_id = u.id AND a.date LIKE ?
      WHERE u.active = 1 AND u.role IN ('counselor','supervisor','admin') GROUP BY u.id ORDER BY done DESC`).all(like),
    by_type: db.prepare(`SELECT type, COUNT(*) n FROM appointments WHERE date LIKE ? AND status = 'done' GROUP BY type`).all(like),
    // 到所／視訊比例：遠距服務量是近年評鑑與方案報表常被問到的數字
    by_mode: db.prepare(`SELECT mode, COUNT(*) n FROM appointments WHERE date LIKE ? AND status = 'done' GROUP BY mode`).all(like),
    // 心理衡鑑：施測次數與報告完成狀況
    assessment_reports: db.prepare(`SELECT
        (SELECT COUNT(*) FROM appointments WHERE date LIKE ? AND status = 'done' AND type = 'assessment') AS tested,
        (SELECT COUNT(*) FROM assessment_reports WHERE test_date LIKE ?) AS reports,
        (SELECT COUNT(*) FROM assessment_reports WHERE test_date LIKE ? AND locked = 1) AS signed`).get(like, like, like),
    // 初談問卷使用情形：發出、填寫與建檔帶入
    intake_forms: db.prepare(`SELECT
        (SELECT COUNT(*) FROM intake_forms WHERE substr(created_at,1,7) = ?) AS sent,
        (SELECT COUNT(*) FROM intake_forms WHERE substr(submitted_at,1,7) = ?) AS submitted,
        (SELECT COUNT(*) FROM intake_forms WHERE substr(submitted_at,1,7) = ? AND bsrs_alert = 1) AS alerted`).get(month, month, month),
    by_source: db.prepare(`SELECT COALESCE(NULLIF(source,''),'未填') AS source, COUNT(*) n FROM clients
      WHERE substr(intake_date,1,7) = ? GROUP BY source ORDER BY n DESC`).all(month),
    // 實收＝已收款 − 當月退費；退費另列一欄，對帳時看得出差額從哪來
    income: (() => {
      const inv = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status IN ('paid','refunded') THEN amount END),0) AS paid,
          COALESCE(SUM(CASE WHEN status = 'unpaid' THEN amount END),0) AS unpaid
        FROM invoices WHERE date LIKE ?`).get(like);
      const refunded = db.prepare('SELECT COALESCE(SUM(amount),0) n FROM refunds WHERE date LIKE ?').get(like).n;
      return { ...inv, refunded, net: inv.paid - refunded };
    })(),
    income_by_payer: db.prepare(`SELECT payer, COALESCE(SUM(amount),0) amt, COUNT(*) n FROM invoices
      WHERE date LIKE ? AND status = 'paid' GROUP BY payer ORDER BY amt DESC`).all(like),
    clients: db.prepare(`SELECT
        (SELECT COUNT(*) FROM clients WHERE substr(intake_date,1,7) = ?) AS new_clients,
        (SELECT COUNT(*) FROM clients WHERE substr(close_date,1,7) = ?) AS closed_clients,
        (SELECT COUNT(*) FROM clients WHERE active = 1 AND status IN ('intake','active')) AS active_clients`).get(month, month),
    risk: db.prepare(`SELECT type, COUNT(*) n, SUM(reported) reported FROM risk_events WHERE date LIKE ? GROUP BY type`).all(like),
    scales: db.prepare(`SELECT scale, COUNT(*) n, ROUND(AVG(total),1) avg_total FROM assessments WHERE date LIKE ? GROUP BY scale`).all(like),
    by_partner: db.prepare(`SELECT p.name, COUNT(a.id) AS sessions,
        COUNT(DISTINCT c.id) AS clients, COALESCE(SUM(a.fee),0) AS amount
      FROM partners p JOIN clients c ON c.partner_id = p.id
      JOIN appointments a ON a.client_id = c.id AND a.status = 'done' AND a.date LIKE ?
      GROUP BY p.id ORDER BY sessions DESC`).all(like),
    groups: db.prepare(`SELECT g.name, COUNT(s.id) AS sessions,
        (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'active') AS members
      FROM groups g JOIN group_sessions s ON s.group_id = g.id AND s.status = 'done' AND s.date LIKE ?
      GROUP BY g.id`).all(like),
    settlements: db.prepare(`SELECT s.month, p.name AS partner_name, s.sessions, s.amount, s.status
      FROM settlements s JOIN partners p ON p.id = s.partner_id WHERE s.month = ?`).all(month),
    // ---- 經營品質指標 ----
    // 量之外評鑑與所務會議最常問的幾個比率。分母為 0 時一律回 null，
    // 由前端顯示「—」，避免出現 0% 或 NaN 讓人誤判。
    kpi: (() => {
      const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
      const st = db.prepare(`SELECT
          SUM(status = 'done') done, SUM(status = 'no_show') no_show,
          SUM(status = 'cancelled') cancelled, COUNT(*) total
        FROM appointments WHERE date LIKE ?`).get(like);
      // 初談轉銜：當月完成初談的個案，之後有沒有再完成第二次晤談
      const intakes = db.prepare(`SELECT a.client_id FROM appointments a
        WHERE a.date LIKE ? AND a.status = 'done' AND a.type = 'intake'`).all(like);
      const converted = intakes.filter(i => db.prepare(`SELECT 1 FROM appointments
        WHERE client_id = ? AND status = 'done' AND type != 'intake'`).get(i.client_id)).length;
      // 脫落：仍在案（未結案）但最後一次完成晤談距今超過 60 天，且沒有未來預約
      const dropout = db.prepare(`SELECT COUNT(*) n FROM clients c
        WHERE c.active = 1 AND c.status = 'active'
          AND EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = c.id AND a.status = 'done')
          AND (SELECT MAX(date) FROM appointments a WHERE a.client_id = c.id AND a.status = 'done')
              < date('now','localtime','-60 days')
          AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = c.id
              AND a.status IN ('booked','arrived') AND a.date >= date('now','localtime'))`).get().n;
      const activeClients = db.prepare(`SELECT COUNT(*) n FROM clients
        WHERE active = 1 AND status = 'active'`).get().n;
      // 平均晤談次數：當月有服務的個案，平均各完成幾次
      const avg = db.prepare(`SELECT COUNT(*) sessions, COUNT(DISTINCT client_id) clients
        FROM appointments WHERE date LIKE ? AND status = 'done'`).get(like);
      // 時段利用率：當月每位心理師的可預約時數 vs 實際完成晤談時數
      const [y, m] = month.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      const weekdayCount = [0, 0, 0, 0, 0, 0, 0];
      for (let d = 1; d <= daysInMonth; d++) weekdayCount[new Date(y, m - 1, d).getDay()]++;
      const toMin = t => { const [hh, mm] = String(t).split(':').map(Number); return hh * 60 + mm; };
      const util = db.prepare(`SELECT u.id, u.name FROM users u
        WHERE u.active = 1 AND u.role IN ('counselor','supervisor','admin')`).all().map(u => {
        const av = db.prepare('SELECT weekday, start_time, end_time FROM availability WHERE counselor_id = ?').all(u.id);
        const capacity = av.reduce((sum, a) =>
          sum + (toMin(a.end_time) - toMin(a.start_time)) * weekdayCount[a.weekday], 0);
        const used = db.prepare(`SELECT COALESCE(SUM(
            (CAST(substr(end_time,1,2) AS INTEGER) * 60 + CAST(substr(end_time,4,2) AS INTEGER))
            - (CAST(substr(start_time,1,2) AS INTEGER) * 60 + CAST(substr(start_time,4,2) AS INTEGER))), 0) m
          FROM appointments WHERE counselor_id = ? AND date LIKE ? AND status = 'done'`).get(u.id, like).m;
        return {
          name: u.name,
          capacity_hours: Math.round(capacity / 6) / 10,
          used_hours: Math.round(used / 6) / 10,
          rate: pct(used, capacity)
        };
      }).filter(r => r.capacity_hours > 0 || r.used_hours > 0);
      return {
        no_show_rate: pct(st.no_show, st.total),
        cancel_rate: pct(st.cancelled, st.total),
        intake_conversion: { intakes: intakes.length, converted, rate: pct(converted, intakes.length) },
        dropout: { count: dropout, active: activeClients, rate: pct(dropout, activeClients) },
        avg_sessions: avg.clients > 0 ? Math.round((avg.sessions / avg.clients) * 10) / 10 : null,
        utilization: util
      };
    })()
  });
});

// ---- 報表匯出（CSV，含 BOM 供 Excel 直接開啟）----
const EXPORTS = {
  clients: {
    name: '個案清單',
    headers: ['個案編號', '姓名', '性別', '生日', '電話', '狀態', '風險', '主責心理師', '合作單位', '轉介來源', '初談日', '結案日', '完成晤談數'],
    sql: `SELECT c.code, c.name, c.gender, c.birth_date, c.phone, c.status, c.risk_level,
        u.name AS counselor, p.name AS partner, c.source, c.intake_date, c.close_date,
        (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id AND a.status = 'done') AS done
      FROM clients c LEFT JOIN users u ON u.id = c.counselor_id LEFT JOIN partners p ON p.id = c.partner_id
      WHERE c.active = 1 ORDER BY c.code`
  },
  appointments: {
    name: '晤談明細',
    headers: ['日期', '時間', '個案編號', '心理師', '類型', '形式', '狀態', '費用', '諮商室'],
    sql: `SELECT a.date, a.start_time, c.code, u.name AS counselor, a.type, a.mode, a.status, a.fee, r.name AS room
      FROM appointments a JOIN clients c ON c.id = a.client_id
      LEFT JOIN users u ON u.id = a.counselor_id LEFT JOIN rooms r ON r.id = a.room_id
      WHERE a.date BETWEEN ? AND ? ORDER BY a.date, a.start_time`,
    range: true
  },
  invoices: {
    name: '收費明細',
    headers: ['日期', '個案編號', '項目', '金額', '付款人別', '狀態', '付款方式', '收據號'],
    sql: `SELECT i.date, c.code, i.item, i.amount, i.payer, i.status, i.method, i.receipt_no
      FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.date BETWEEN ? AND ? ORDER BY i.date`,
    range: true
  },
  sessions_by_counselor: {
    name: '心理師服務量',
    headers: ['心理師', '完成', '未到', '取消', '服務人數', '收費合計'],
    sql: `SELECT u.name,
        SUM(CASE WHEN a.status = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) AS no_show,
        SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        COUNT(DISTINCT CASE WHEN a.status = 'done' THEN a.client_id END) AS clients,
        COALESCE(SUM(CASE WHEN a.status = 'done' THEN a.fee END),0) AS amount
      FROM users u LEFT JOIN appointments a ON a.counselor_id = u.id AND a.date BETWEEN ? AND ?
      WHERE u.active = 1 AND u.role IN ('counselor','supervisor','admin') GROUP BY u.id`,
    range: true
  },
  risk_events: {
    name: '危機事件',
    headers: ['日期', '個案編號', '類型', '嚴重度', '是否通報', '通報管道', '通報時間', '狀態'],
    sql: `SELECT r.date, c.code, r.type, r.severity, r.reported, r.report_channel, r.report_at, r.status
      FROM risk_events r JOIN clients c ON c.id = r.client_id
      WHERE r.date BETWEEN ? AND ? ORDER BY r.date`,
    range: true
  }
};

// 值內含逗號、引號或換行時加引號跳脫；開頭 BOM 讓 Excel 正確辨識 UTF-8
function toCsv(headers, rows) {
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + [headers.join(',')].concat(rows.map(r => Object.values(r).map(esc).join(','))).join('\r\n');
}

router.get('/exports', requireStaff('reports'), (req, res) => {
  res.json(Object.entries(EXPORTS).map(([k, v]) => ({ key: k, name: v.name, range: !!v.range })));
});

// Excel 2003 XML（.xls）：Excel／LibreOffice 可直接開啟，中文不需另外設定編碼，
// 且相較 CSV 能保留欄寬與標題列樣式。
function toExcelXml(title, headers, rows, subtitle) {
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cell = v => typeof v === 'number'
    ? `<Cell ss:StyleID="b"><Data ss:Type="Number">${v}</Data></Cell>`
    : `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
 <Style ss:ID="t"><Font ss:Size="14" ss:Bold="1"/></Style>
 <Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#E6EFEF" ss:Pattern="Solid"/></Style>
 <Style ss:ID="b"><NumberFormat ss:Format="#,##0"/></Style>
</Styles>
<Worksheet ss:Name="${esc(title).slice(0, 28)}"><Table>
${headers.map(() => '<Column ss:AutoFitWidth="1" ss:Width="90"/>').join('')}
<Row><Cell ss:StyleID="t"><Data ss:Type="String">${esc(title)}</Data></Cell></Row>
<Row><Cell><Data ss:Type="String">${esc(subtitle)}</Data></Cell></Row>
<Row></Row>
<Row>${headers.map(h => `<Cell ss:StyleID="h"><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('')}</Row>
${rows.map(r => `<Row>${Object.values(r).map(cell).join('')}</Row>`).join('\n')}
</Table></Worksheet></Workbook>`;
}

// 列印版 HTML：於瀏覽器以「列印 → 另存為 PDF」產生 PDF，
// 中文字型直接沿用系統字型，不需額外內嵌字型檔。
function toPrintHtml(title, headers, rows, subtitle, orgName) {
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: A4 landscape; margin: 14mm; }
  body { font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; color: #1c2b2b; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { font-size: 12px; color: #667; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #c9d6d6; padding: 5px 7px; text-align: left; }
  th { background: #e6efef; }
  tbody tr:nth-child(even) { background: #fafcfc; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .foot { margin-top: 14px; font-size: 11px; color: #778; }
  .bar { margin-bottom: 12px; }
  @media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">列印／另存為 PDF</button></div>
<h1>${esc(orgName)}　${esc(title)}</h1>
<div class="sub">${esc(subtitle)}　共 ${rows.length} 筆</div>
<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
<tbody>${rows.map(r => `<tr>${Object.values(r).map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>
<div class="foot">本報表含個案相關資料，請依個人資料保護法與所內作業辦法妥善保管。</div>
<script>if (location.hash !== '#noprint') setTimeout(() => window.print(), 300);<\/script>
</body></html>`;
}

router.get('/exports/:kind', requireStaff('reports'), (req, res) => {
  const def = EXPORTS[req.params.kind];
  if (!def) return res.status(404).json({ error: '找不到此報表' });
  const from = req.query.from || today().slice(0, 8) + '01';
  const to = req.query.to || today();
  const format = ['csv', 'xls', 'pdf'].includes(req.query.format) ? req.query.format : 'csv';
  const rows = def.range ? db.prepare(def.sql).all(from, to) : db.prepare(def.sql).all();
  const subtitle = def.range ? `期間：${from} ～ ${to}` : `製表日：${today()}`;
  audit('staff', req.user.id, req.user.name, '匯出報表', `${def.name}（${format.toUpperCase()}）`,
    { from, to, count: rows.length, format });

  const file = `mindcare_${req.params.kind}_${from}_${to}`;
  if (format === 'pdf') {
    // 交由瀏覽器列印為 PDF：inline 開啟，頁面載入後自動帶出列印對話框
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(toPrintHtml(def.name, def.headers, rows, subtitle, getSetting('org_name') || 'MindCare 心理諮商所'));
  }
  if (format === 'xls') {
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.xls"`);
    return res.send(toExcelXml(def.name, def.headers, rows, subtitle));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file}.csv"`);
  res.send(toCsv(def.headers, rows));
});

// ---- 紀錄保存年限：結案滿保存年限者提示可歸檔／銷毀 ----
router.get('/retention', requireStaff('clients'), (req, res) => {
  const years = Number(getSetting('record_retention_years', '7'));
  res.json({
    years,
    rows: db.prepare(`SELECT c.id, c.code, c.name, c.close_date, c.close_reason,
        CAST((julianday('now','localtime') - julianday(c.close_date)) / 365.25 AS INTEGER) AS years_closed,
        (SELECT COUNT(*) FROM session_notes n WHERE n.client_id = c.id) AS notes
      FROM clients c WHERE c.status = 'closed' AND c.close_date != ''
        AND julianday('now','localtime') - julianday(c.close_date) >= ? * 365.25
      ORDER BY c.close_date`).all(years)
  });
});

// 稽核軌跡：誰在何時調閱了哪位個案的紀錄
router.get('/audit-logs', requireAdmin, (req, res) => {
  const { q = '', from = '', to = '' } = req.query;
  const where = [], args = [];
  if (q) { where.push('(action LIKE ? OR actor_name LIKE ? OR target LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (from) { where.push('created_at >= ?'); args.push(from); }
  if (to) { where.push('created_at <= ?'); args.push(to + ' 23:59'); }
  res.json(db.prepare(`SELECT * FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT 300`).all(...args));
});

module.exports = router;
