// 建立展示資料：帳號、諮商室、個案、預約、晤談紀錄、量表、方案與收費
// 重複執行安全：已存在 admin 帳號時只補缺漏，不重複灌入個案
const bcrypt = require('bcryptjs');
const { db, today, addDays, nextClientCode, setSetting } = require('../src/db');
const { ROLE_DEFAULT_MODULES } = require('../src/auth');
const { score } = require('../src/scales');

const hash = p => bcrypt.hashSync(p, 10);
const has = (sql, ...a) => !!db.prepare(sql).get(...a);

function ensureUser(u) {
  if (has('SELECT 1 FROM users WHERE username = ?', u.username)) return db.prepare('SELECT id FROM users WHERE username = ?').get(u.username).id;
  const info = db.prepare(`INSERT INTO users (username, password_hash, name, role, title, license_type, license_no, specialty, phone, permissions)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(u.username, hash(u.password), u.name, u.role, u.title || '',
    u.license_type || '', u.license_no || '', u.specialty || '', u.phone || '',
    JSON.stringify(ROLE_DEFAULT_MODULES[u.role] || []));
  return info.lastInsertRowid;
}

const adminId = ensureUser({ username: 'admin', password: 'mindcare123', name: '所長', role: 'admin', title: '諮商所所長', license_type: '諮商心理師', license_no: '諮心字第001234號' });
const linId = ensureUser({ username: 'lin', password: '123456', name: '林筱雯', role: 'counselor', title: '諮商心理師', license_type: '諮商心理師', license_no: '諮心字第004567號', specialty: '情緒困擾、人際關係、CBT', phone: '0922111333' });
const chenId = ensureUser({ username: 'chen', password: '123456', name: '陳柏宇', role: 'counselor', title: '諮商心理師', license_type: '臨床心理師', license_no: '臨心字第002233號', specialty: '創傷、伴侶諮商、EMDR', phone: '0933222444' });
const supId = ensureUser({ username: 'wu', password: '123456', name: '吳明慧', role: 'supervisor', title: '督導', license_type: '諮商心理師', license_no: '諮心字第000321號', specialty: '督導、家族治療' });
ensureUser({ username: 'office', password: '123456', name: '張佳琳', role: 'staff', title: '行政櫃檯' });

if (!has('SELECT 1 FROM rooms')) {
  for (const r of [['諮商室 A', 1, '個別晤談'], ['諮商室 B', 1, '個別晤談'], ['團體室', 12, '團體諮商／家族會談'], ['遊戲治療室', 2, '兒童青少年']]) {
    db.prepare('INSERT INTO rooms (name, capacity, note) VALUES (?,?,?)').run(...r);
  }
}

if (!has('SELECT 1 FROM availability')) {
  const add = (uid, wd, s, e) => db.prepare('INSERT INTO availability (counselor_id, weekday, start_time, end_time) VALUES (?,?,?,?)').run(uid, wd, s, e);
  for (const wd of [1, 3, 5]) { add(linId, wd, '10:00', '12:00'); add(linId, wd, '14:00', '18:00'); }
  for (const wd of [2, 4, 6]) { add(chenId, wd, '13:00', '17:00'); add(chenId, wd, '19:00', '21:00'); }
  for (const wd of [2, 4]) add(supId, wd, '10:00', '12:00');
}

if (!has('SELECT 1 FROM clients')) {
  const mk = c => {
    const code = nextClientCode();
    const phone = c.phone;
    const info = db.prepare(`INSERT INTO clients (code, name, gender, birth_date, phone, email, occupation, source,
      counselor_id, status, risk_level, main_issue, history, is_minor, guardian_name, guardian_relationship, guardian_phone,
      emergency_name, emergency_relationship, emergency_phone, intake_date, password_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      code, c.name, c.gender, c.birth_date, phone, c.email || '', c.occupation || '', c.source,
      c.counselor_id, c.status, c.risk_level || 'low', c.main_issue, c.history || '',
      c.is_minor ? 1 : 0, c.guardian_name || '', c.guardian_relationship || '', c.guardian_phone || '',
      c.emergency_name || '', c.emergency_relationship || '', c.emergency_phone || '',
      c.intake_date, hash(phone.slice(-6)));
    return info.lastInsertRowid;
  };
  const c1 = mk({ name: '王小美', gender: 'female', birth_date: '1995-04-18', phone: '0912345678', email: 'mei@example.com', occupation: '軟體工程師', source: '自行求助', counselor_id: linId, status: 'active', risk_level: 'medium', main_issue: '工作壓力大、失眠、情緒低落三個月', history: '無精神科就醫史', emergency_name: '王大明', emergency_relationship: '父', emergency_phone: '0911222333', intake_date: addDays(today(), -60) });
  const c2 = mk({ name: '李承翰', gender: 'male', birth_date: '2010-09-02', phone: '0928123456', occupation: '國中生', source: '學校輔導室', counselor_id: chenId, status: 'active', main_issue: '同儕衝突、拒學傾向', is_minor: 1, guardian_name: '李美芳', guardian_relationship: '母', guardian_phone: '0928123456', emergency_name: '李美芳', emergency_relationship: '母', emergency_phone: '0928123456', intake_date: addDays(today(), -30) });
  const c3 = mk({ name: '陳雅琪', gender: 'female', birth_date: '1988-12-11', phone: '0955666777', occupation: '護理師', source: '醫療院所轉介', counselor_id: linId, status: 'intake', main_issue: '產後情緒低落，家人建議求助', intake_date: addDays(today(), -3) });
  const c4 = mk({ name: '張志豪', gender: 'male', birth_date: '1979-06-30', phone: '0977888999', occupation: '業務主管', source: '企業EAP', counselor_id: chenId, status: 'closed', main_issue: '婚姻關係緊張', intake_date: addDays(today(), -200) });
  db.prepare("UPDATE clients SET close_date = ?, close_reason = '目標達成' WHERE id = ?").run(addDays(today(), -20), c4);

  // 預約與晤談紀錄
  const appt = (client, counselor, date, start, type, status, room) => db.prepare(
    `INSERT INTO appointments (client_id, counselor_id, room_id, date, start_time, end_time, type, status, fee, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`).run(client, counselor, room, date, start,
    `${String(Number(start.slice(0, 2)) + (Number(start.slice(3)) + 50 >= 60 ? 1 : 0)).padStart(2, '0')}:${String((Number(start.slice(3)) + 50) % 60).padStart(2, '0')}`,
    type, status, type === 'intake' ? 2500 : 2000, adminId).lastInsertRowid;

  const note = (client, counselor, apptId, date, no, s, o, a, p, risk) => db.prepare(
    `INSERT INTO session_notes (client_id, appointment_id, counselor_id, date, session_no, subjective, objective, assessment, plan, intervention, risk_flag, locked, signed_at)
     VALUES (?,?,?,?,?,?,?,?,?, 'CBT 認知重建', ?, 1, ?)`).run(client, apptId, counselor, date, no, s, o, a, p, risk || 'none', date + ' 20:00');

  const a1 = appt(c1, linId, addDays(today(), -56), '14:00', 'intake', 'done', 1);
  note(c1, linId, a1, addDays(today(), -56), 1,
    '主訴近三個月因專案壓力常失眠，早醒後難再入睡，白天注意力不集中。',
    '外觀整潔，語速偏快，眼神接觸良好，談及工作時眉頭深鎖。',
    '症狀符合適應相關之焦慮與睡眠困擾，PHQ-9 12 分屬中度；無自傷意念。',
    '建立治療關係，安排 PHQ-9／GAD-7 追蹤，下次探討工作情境的自動化思考。');
  const a2 = appt(c1, linId, addDays(today(), -49), '14:00', 'individual', 'done', 1);
  note(c1, linId, a2, addDays(today(), -49), 2,
    '本週失眠改善一晚，仍對主管評價感到焦慮。',
    '情緒較上次穩定，能主動舉例說明。',
    '核心信念為「表現不好就會被否定」，屬完美主義傾向。',
    '練習思考紀錄表，下次檢視實際證據。');
  appt(c1, linId, addDays(today(), 1), '14:00', 'individual', 'booked', 1);
  const a4 = appt(c2, chenId, addDays(today(), -25), '16:00', 'intake', 'done', 4);
  note(c2, chenId, a4, addDays(today(), -25), 1,
    '個案表示班上同學嘲笑其口音，近兩週不想上學。',
    '沉默時間長，需以遊戲媒材引導，談及同學時握拳。',
    '同儕排擠導致之學校適應困難，情緒表達受限。',
    '以遊戲治療建立關係，與導師聯繫了解班級狀況，安排親職諮詢。', 'none');
  appt(c2, chenId, addDays(today(), 2), '16:00', 'individual', 'booked', 4);
  appt(c3, linId, today(), '10:00', 'intake', 'booked', 2);

  // 量表
  const assess = (client, scale, date, answers, by) => {
    const s = score(scale, answers);
    db.prepare(`INSERT INTO assessments (client_id, scale, date, answers, total, severity, alert, filled_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(client, scale, date, JSON.stringify(answers), s.total, s.severity, s.alert, by);
  };
  assess(c1, 'PHQ9', addDays(today(), -56), [2, 2, 3, 2, 1, 1, 1, 0, 0], 'staff');
  assess(c1, 'PHQ9', addDays(today(), -21), [1, 1, 2, 1, 1, 1, 1, 0, 0], 'client');
  assess(c1, 'GAD7', addDays(today(), -56), [2, 2, 2, 2, 1, 1, 1], 'staff');
  assess(c1, 'ISI', addDays(today(), -56), [3, 3, 2, 3, 2, 1, 3], 'staff');
  assess(c2, 'BSRS5', addDays(today(), -25), [2, 3, 2, 3, 2, 0], 'staff');
  db.prepare('INSERT INTO assessment_tasks (client_id, scale, assigned_by, due_date) VALUES (?,?,?,?)')
    .run(c1, 'GAD7', linId, addDays(today(), 5));

  // 處遇計畫
  const planId = db.prepare(`INSERT INTO treatment_plans (client_id, counselor_id, start_date, review_date, approach, planned_sessions, summary)
    VALUES (?,?,?,?,?,?,?)`).run(c1, linId, addDays(today(), -56), addDays(today(), -2), 'CBT 認知行為', 12,
    '個案於高壓工作環境下形成「表現不好即被否定」之核心信念，導致睡眠與情緒困擾。以認知行為取向處理自動化思考並建立睡眠衛生。').lastInsertRowid;
  for (const [i, g] of [['降低失眠困擾，ISI 分數降至 8 分以下', 'ISI 量表每四週追蹤', 40],
    ['辨識並修正工作情境之自動化思考', '每週思考紀錄表完成率 80%', 55],
    ['建立可持續的壓力因應策略', '能列舉並實行三項因應方式', 20]].entries()) {
    db.prepare('INSERT INTO plan_goals (plan_id, content, indicator, progress, sort) VALUES (?,?,?,?,?)').run(planId, g[0], g[1], g[2], i);
  }

  // 危機事件（示範已通報並結案）
  db.prepare(`INSERT INTO risk_events (client_id, date, type, severity, description, actions, reported, report_channel, report_at, handler_id, status, follow_up)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(c2, addDays(today(), -18), '兒少保護', 'medium',
    '個案提及家中管教時曾被責打，身上有瘀青。', '當日完成安全評估、聯繫學校輔導室，並依法通報。',
    1, '關懷e起來', addDays(today(), -18) + ' 17:30', chenId, 'closed', '社工已家訪，家長接受親職教育，個案情緒穩定。');

  // 督導紀錄
  db.prepare(`INSERT INTO supervisions (counselor_id, supervisor_id, date, hours, type, client_id, content, suggestion)
    VALUES (?,?,?,?,?,?,?,?)`).run(linId, supId, addDays(today(), -14), 1.5, 'individual', c1,
    '討論個案完美主義信念與治療關係中的移情反應。', '建議加入行為實驗，並留意個案對心理師評價的敏感度。');
  db.prepare(`INSERT INTO supervisions (counselor_id, supervisor_id, date, hours, type, content, suggestion)
    VALUES (?,?,?,?,?,?,?)`).run(chenId, supId, addDays(today(), -7), 2, 'group',
    '團體督導：兒少保護通報後的治療關係維護。', '通報前後皆須向個案說明保密例外，維持透明。');

  // 方案與收費
  const pkgId = db.prepare(`INSERT INTO packages (client_id, name, sessions_total, sessions_used, amount, start_date, expire_date)
    VALUES (?,?,?,?,?,?,?)`).run(c1, '個別諮商 10 次方案', 10, 2, 18000, addDays(today(), -56), addDays(today(), 120)).lastInsertRowid;
  db.prepare(`INSERT INTO invoices (client_id, package_id, date, item, amount, status, method, paid_at, receipt_no, payer)
    VALUES (?,?,?,?,?, 'paid', '信用卡', ?, 'MC2026010001', '自費')`).run(c1, pkgId, addDays(today(), -56), '方案：個別諮商 10 次方案（10 次）', 18000, addDays(today(), -56) + ' 15:10');
  db.prepare(`INSERT INTO invoices (client_id, date, item, amount, status, payer)
    VALUES (?,?,?,?, 'unpaid', '學校方案')`).run(c2, addDays(today(), -25), '初談費用', 2500);

  db.prepare(`INSERT INTO announcements (title, content, audience, pinned, created_by) VALUES (?,?,?,?,?)`)
    .run('春節休所公告', '本所於 2/9-2/14 休所，期間如有緊急狀況請撥打 1925 安心專線。', 'all', 1, adminId);
  db.prepare('INSERT INTO messages (client_id, sender, content) VALUES (?, ?, ?)').run(c1, 'client', '請問下週三可以改成下午四點嗎？');
}

setSetting('center_name', '擁抱心理諮商所');
// 展示／測試資料要涵蓋全部功能，故一律開齊模組（正式站在系統設定的「模組啟用」自行取捨）
setSetting('disabled_modules', '');
setSetting('feature_ce', '1');
console.log('展示資料已建立：admin / mindcare123，心理師 lin / 123456，個案端 0912345678 / 345678');

// ---- 第二階段展示資料：合作單位、來電登記、請假、繼續教育、團體 ----
if (!has('SELECT 1 FROM partners')) {
  const uid = n => db.prepare('SELECT id FROM users WHERE username = ?').get(n).id;
  const linId2 = uid('lin'), chenId2 = uid('chen'), adminId2 = uid('admin');
  const cid = code => { const r = db.prepare('SELECT id FROM clients WHERE code LIKE ?').get('%' + code); return r && r.id; };

  const school = db.prepare(`INSERT INTO partners (name, type, contact, phone, email, tax_id, contract_no,
    contract_start, contract_end, rate, quota_sessions, settle_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    '市立文昌國中', '學校', '輔導主任 黃老師', '02-27001234', 'counsel@wenchang.edu.tw', '',
    '114-輔導-018', addDays(today(), -200), addDays(today(), 45), 1800, 60,
    '每月 5 日前寄送對帳單，核章後 30 日內撥款').lastInsertRowid;
  const eap = db.prepare(`INSERT INTO partners (name, type, contact, phone, tax_id, contract_no,
    contract_start, contract_end, rate, quota_sessions, settle_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    '晶華科技股份有限公司', '企業EAP', '人資 陳經理', '03-5678123', '86543210',
    'EAP-2026-07', addDays(today(), -120), addDays(today(), 240), 2200, 0,
    '季結，需附匿名統計報告').lastInsertRowid;
  db.prepare('INSERT INTO partners (name, type, contact, phone, rate, settle_note) VALUES (?,?,?,?,?,?)')
    .run('臺北市家庭暴力暨性侵害防治中心', '政府社政', '社工督導 李小姐', '02-27208889', 1600, '依委託案結案報告核銷');

  // 李承翰為學校認輔個案
  if (cid('002')) db.prepare('UPDATE clients SET partner_id = ? WHERE id = ?').run(school, cid('002'));

  // 來電登記
  const ins = db.prepare(`INSERT INTO intakes (name, phone, gender, birth_date, is_minor, source, referrer,
    partner_id, issue, preferred_time, preferred_counselor_id, urgency, status, taken_by, note, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('黃思婷', '0918777555', 'female', '2001-03-15', 0, '自行求助', '', null,
    '分手後情緒低落、常哭泣，工作無法專心', '平日晚上或週六', linId2, 'normal', 'new', adminId2, '第一次尋求諮商，語氣猶豫', addDays(today(), -2) + ' 10:20');
  ins.run('鄭文彬', '0966333222', 'male', '1985-11-08', 0, '企業EAP', '晶華科技人資', eap,
    '主管衝突與職業倦怠，公司 EAP 方案轉介', '平日下午', null, 'normal', 'waiting', adminId2, 'EAP 每人補助 6 次', addDays(today(), -5) + ' 14:05');
  ins.run('林小婕', '0955111000', 'female', '2012-06-20', 1, '學校輔導室', '文昌國中 黃老師', school,
    '自我傷害行為，導師發現手臂有割痕', '週三下午（學校可排課）', chenId2, 'high', 'assigned', adminId2,
    '已通知家長，家長同意接受諮商', addDays(today(), -1) + ' 09:00');
  db.prepare("UPDATE intakes SET assigned_counselor_id = ? WHERE name = '林小婕'").run(chenId2);

  // 請假：林心理師下週三全天研習
  const nextWed = (() => { let d = addDays(today(), 1); while (new Date(d + 'T00:00:00').getDay() !== 3) d = addDays(d, 1); return d; })();
  db.prepare('INSERT INTO time_off (counselor_id, start_date, end_date, all_day, reason) VALUES (?,?,?,1,?)')
    .run(linId2, nextWed, nextWed, '參加 CBT 進階工作坊');

  // 繼續教育積分
  const ce = db.prepare(`INSERT INTO ce_credits (user_id, date, title, organizer, category, hours, credits, cert_no)
    VALUES (?,?,?,?,?,?,?,?)`);
  ce.run(linId2, addDays(today(), -300), '認知行為治療進階實務工作坊', '台灣輔導與諮商學會', '專業課程', 12, 12, 'TW-CBT-2025-118');
  ce.run(linId2, addDays(today(), -150), '心理師執業倫理與法律責任', '台北市諮商心理師公會', '專業倫理', 6, 6, 'TP-ETH-2026-042');
  ce.run(linId2, addDays(today(), -60), '自殺防治守門人訓練', '衛生福利部心理健康司', '專業品質', 3, 3, '');
  ce.run(chenId2, addDays(today(), -90), 'EMDR 第一階段訓練', 'EMDR 台灣學會', '專業課程', 21, 21, 'EMDR-1-2026-07');
  ce.run(chenId2, addDays(today(), -30), '兒少保護通報實務', '衛生福利部保護服務司', '專業相關法規', 3, 3, '');
  db.prepare("UPDATE users SET license_expiry = ? WHERE id = ?").run(addDays(today(), 120), linId2);
  db.prepare("UPDATE users SET license_expiry = ? WHERE id = ?").run(addDays(today(), 900), chenId2);

  // 團體諮商
  const gid = db.prepare(`INSERT INTO groups (name, counselor_id, co_counselor_id, capacity, sessions_total,
    fee_per_session, start_date, end_date, status, description)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    '情緒調適成長團體（春季班）', linId2, chenId2, 8, 8, 800,
    addDays(today(), -35), addDays(today(), 21), 'running',
    '以正念與情緒辨識為主軸的封閉式團體，適合有情緒困擾但無急性風險之成人。').lastInsertRowid;
  for (const code of ['001', '004']) {
    if (cid(code)) db.prepare('INSERT INTO group_members (group_id, client_id) VALUES (?,?)').run(gid, cid(code));
  }
  const gs = db.prepare(`INSERT INTO group_sessions (group_id, session_no, date, start_time, end_time, room_id, topic, process_note, status)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  gs.run(gid, 1, addDays(today(), -35), '19:00', '21:00', 3, '團體規範與自我介紹',
    '成員初次見面較拘謹，透過媒材活動逐漸開口；A 成員主動分享，B 成員多為傾聽。', 'done');
  gs.run(gid, 2, addDays(today(), -28), '19:00', '21:00', 3, '情緒辨識與命名',
    '成員能指認多種情緒詞彙，討論到家庭情境時氣氛轉為凝重，帶領者做了情緒承接。', 'done');
  gs.run(gid, 3, addDays(today(), 4), '19:00', '21:00', 3, '壓力因應策略', '', 'planned');

  // 請款單（上月）
  const lastMonth = today().slice(0, 7);
  db.prepare(`INSERT INTO settlements (partner_id, month, sessions, amount, status, note, created_by)
    VALUES (?,?,?,?,?,?,?)`).run(school, lastMonth, 1, 1800, 'draft', '', adminId2);
  console.log('第二階段展示資料已建立：合作單位、來電登記、請假、繼續教育、團體、請款單');
}

// ---- 第三階段展示資料：視訊晤談、衡鑑報告、初談問卷、逾期收費 ----
if (!has('SELECT 1 FROM assessment_reports')) {
  const uid = n => db.prepare('SELECT id FROM users WHERE username = ?').get(n).id;
  const linId3 = uid('lin'), chenId3 = uid('chen'), adminId3 = uid('admin');
  const cid = code => { const r = db.prepare('SELECT id FROM clients WHERE code LIKE ?').get('%' + code); return r && r.id; };

  // 心理師的固定視訊會議室（排視訊晤談時自動帶入）
  db.prepare('UPDATE users SET meeting_room_url = ? WHERE id = ?').run('https://meet.jit.si/mindcare-lin', linId3);
  db.prepare('UPDATE users SET meeting_room_url = ? WHERE id = ?').run('https://meet.jit.si/mindcare-chen', chenId3);

  // 一筆視訊晤談（明天），提醒訊息會自動附上連結
  if (cid('001')) {
    db.prepare(`INSERT INTO appointments (client_id, counselor_id, date, start_time, end_time, type, mode,
      status, fee, meeting_url, created_by) VALUES (?,?,?,?,?, 'individual', 'online', 'booked', ?, ?, ?)`).run(
      cid('001'), linId3, addDays(today(), 1), '20:00', '20:50', 2000, 'https://meet.jit.si/mindcare-lin', adminId3);
  }

  // 心理衡鑑：一筆已簽核定稿的報告 + 對應的施測晤談
  if (cid('002')) {
    const testDate = addDays(today(), -14);
    db.prepare(`INSERT INTO appointments (client_id, counselor_id, date, start_time, end_time, type, mode,
      status, fee, charged, created_by) VALUES (?,?,?,?,?, 'assessment', 'onsite', 'done', ?, 1, ?)`).run(
      cid('002'), chenId3, testDate, '09:00', '11:00', 4500, adminId3);
    db.prepare(`INSERT INTO assessment_reports (client_id, counselor_id, test_date, report_date, purpose,
      referral_source, instruments, background, observation, results, scores, impression, recommendation,
      validity, locked, signed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'valid', 1, ?)`).run(
      cid('002'), chenId3, testDate, addDays(today(), -10),
      '學校輔導室轉介，欲了解個案拒學與同儕衝突是否與認知功能或注意力有關，作為輔導策略之依據。',
      '市立文昌國中輔導室',
      'WISC-V 魏氏兒童智力量表\nSNAP-IV 注意力量表（家長版、教師版）\nCBCL 兒童行為檢核表\n臨床晤談與行為觀察',
      '國中二年級男生，與母親同住。導師反映近半年出現拒學，班上有同儕衝突。無重大疾病史，未曾接受心理衡鑑。',
      '個案準時到場，衣著整潔，初期回答簡短、眼神接觸少；建立關係後合作度提升。作答速度中等，遇困難題目出現放棄傾向，需鼓勵才繼續。整體施測配合度良好，結果應可代表其真實表現。',
      '整體智能落於中等範圍，各指數間無顯著離散。語文理解與知覺推理相當，工作記憶略低但仍在正常範圍。注意力量表家長與教師版皆未達臨床切分點。行為檢核表在「社交問題」與「退縮」向度分數偏高。',
      JSON.stringify([
        { instrument: 'WISC-V', index: '全量表智商 FSIQ', score: '98', norm: 'PR 45', interpretation: '中等' },
        { instrument: 'WISC-V', index: '語文理解 VCI', score: '102', norm: 'PR 55', interpretation: '中等' },
        { instrument: 'WISC-V', index: '知覺推理 VSI', score: '101', norm: 'PR 53', interpretation: '中等' },
        { instrument: 'WISC-V', index: '工作記憶 WMI', score: '89', norm: 'PR 23', interpretation: '中下，但未達顯著缺損' },
        { instrument: 'SNAP-IV', index: '注意力不足分量表', score: '0.9', norm: '未達切分點', interpretation: '未支持注意力缺損診斷' },
        { instrument: 'CBCL', index: '社交問題', score: 'T=68', norm: '臨界範圍', interpretation: '同儕互動困難明顯' }
      ]),
      '個案認知功能整體屬中等，拒學行為較可能與同儕人際挫折及退縮因應有關，未見注意力缺損或學習能力不足之證據。工作記憶略低可能影響長篇指令的理解，但非拒學之主因。',
      '一、建議持續個別諮商，聚焦人際因應技巧與情緒調適。\n二、與學校輔導室協調漸進式復學安排，初期可先入班部分節次。\n三、課堂指令建議分段給予並輔以書面提示，減少工作記憶負荷。\n四、三個月後視進展評估是否需再次衡鑑。',
      addDays(today(), -10) + ' 16:20');
  }

  // 初談問卷：一筆已填寫待處理（對應「黃思婷」來電登記）
  const intake = db.prepare("SELECT id, name, phone FROM intakes WHERE name = '黃思婷'").get();
  if (intake) {
    const ans = [3, 3, 2, 3, 2, 0];
    const s = score('BSRS5', ans);
    db.prepare(`INSERT INTO intake_forms (intake_id, token, name, phone, gender, birth_date, email, occupation,
      marital, emergency_name, emergency_relationship, emergency_phone, main_issue, history, expectation,
      preferred_time, source, bsrs_answers, bsrs_total, bsrs_alert, status, expires_at, submitted_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'done', ?, ?, ?)`).run(
      intake.id, require('crypto').randomBytes(18).toString('hex'),
      intake.name, intake.phone, 'female', '2001-03-15', 'huang@example.com', '行銷企劃', '未婚',
      '黃媽媽', '母', '0918777000',
      '分手後情緒低落三個月，常常哭泣，上班無法專心，晚上睡不著。',
      '未曾就醫或接受諮商，目前沒有服用任何藥物。',
      '希望能整理自己的情緒，重新找回生活步調。',
      '平日晚上或週六上午', '網路搜尋',
      JSON.stringify(ans), s.total, s.alert,
      addDays(today(), 12), addDays(today(), -1) + ' 21:40', adminId3);
  }

  // 逾期未收款：一筆 45 天前的自費晤談費用，供催繳頁展示帳齡分析
  if (cid('001')) {
    db.prepare(`INSERT INTO invoices (client_id, date, item, amount, status, payer, note)
      VALUES (?,?,?,?, 'unpaid', '自費', ?)`).run(
      cid('001'), addDays(today(), -45), addDays(today(), -45) + ' 晤談費用', 2000, '個案表示下次到所一併繳納');
  }

  console.log('第三階段展示資料已建立：視訊會議室與視訊預約、心理衡鑑報告、初談問卷、逾期收費單');
}
