const express = require('express');
const { db, audit, today, addDays, getSetting } = require('../db');
const { rateLimit } = require('../auth');
const { freeSlots } = require('./schedule');

const router = express.Router();

// 對外預約頁（免登入）：民眾選據點與心理師、看空檔、送出預約申請。
//
// 刻意不直接建立預約：全預約制的諮商所要由櫃檯確認初談需求與收費後才排定，
// 因此這裡只產生一筆「來電登記」，狀態 new，讓行政人員在系統內派案或直接排約。
// 對外只吐得出「哪些時段是空的」，不會洩漏任何個案資訊。

const bookingLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, prefix: 'booking:' });
const submitLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, prefix: 'booking-submit:' });

function enabled() { return getSetting('public_booking_enabled', '1') === '1'; }
function requireEnabled(req, res, next) {
  if (!enabled()) return res.status(403).json({ error: '目前未開放線上預約，請來電諮商所' });
  next();
}

function counselorsOf(siteId) {
  const rows = db.prepare(`SELECT u.id, u.name, u.title, u.license_type, u.specialty,
      (SELECT GROUP_CONCAT(us.site_id) FROM user_sites us WHERE us.user_id = u.id) AS site_ids
    FROM users u
    WHERE u.active = 1 AND u.role IN ('counselor','supervisor')
      AND EXISTS (SELECT 1 FROM availability av WHERE av.counselor_id = u.id)
      ${siteId ? 'AND EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id = ?)' : ''}
    ORDER BY u.name`).all(...(siteId ? [siteId] : []));
  return rows.map(u => ({
    id: u.id, name: u.name, title: u.title, license_type: u.license_type, specialty: u.specialty,
    site_ids: (u.site_ids || '').split(',').filter(Boolean).map(Number)
  }));
}

// 頁面初始資料：據點、主題、可預約心理師與可約日期範圍
router.get('/api/public/booking/options', bookingLimit, (req, res) => {
  res.json({
    enabled: enabled(),
    center_name: getSetting('center_name'),
    center_phone: getSetting('center_phone'),
    tagline: getSetting('ui_staff_login_sub'),
    notice: getSetting('public_booking_notice'),
    crisis_note: getSetting('ui_crisis_note'),
    session_minutes: Number(getSetting('session_minutes', '50')),
    intake_fee: Number(getSetting('intake_fee', '2500')),
    default_fee: Number(getSetting('default_fee', '2000')),
    min_date: addDays(today(), Number(getSetting('portal_book_lead_days', '1'))),
    max_date: addDays(today(), Number(getSetting('portal_book_max_days', '60'))),
    topics: getSetting('topic_options', '').split(',').map(s => s.trim()).filter(Boolean),
    sites: db.prepare(`SELECT id, name, short_name, address, phone, transport
      FROM sites WHERE active = 1 ORDER BY sort, id`).all(),
    counselors: counselorsOf(0)
  });
});

// 某天的空檔：不指定心理師時列出該據點所有心理師的空檔
router.get('/api/public/booking/slots', bookingLimit, requireEnabled, (req, res) => {
  const date = String(req.query.date || '').slice(0, 10);
  const minDate = addDays(today(), Number(getSetting('portal_book_lead_days', '1')));
  const maxDate = addDays(today(), Number(getSetting('portal_book_max_days', '60')));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < minDate || date > maxDate) {
    return res.json({ date, min_date: minDate, max_date: maxDate, counselors: [] });
  }
  const siteId = Number(req.query.site_id) || 0;
  const only = Number(req.query.counselor_id) || 0;
  const list = counselorsOf(siteId).filter(u => !only || u.id === only);
  res.json({
    date, min_date: minDate, max_date: maxDate,
    counselors: list.map(u => ({ id: u.id, name: u.name, title: u.title, license_type: u.license_type, slots: freeSlots(u.id, date) }))
      .filter(u => u.slots.length)
  });
});

// 送出預約申請 → 建立來電登記（status=new）供櫃檯處理
router.post('/api/public/booking/request', submitLimit, requireEnabled, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 30);
  const phone = String(b.phone || '').replace(/[^0-9+\-() ]/g, '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: '請填寫姓名' });
  if (phone.replace(/\D/g, '').length < 8) return res.status(400).json({ error: '請填寫可聯絡的電話' });

  const site = Number(b.site_id)
    ? db.prepare('SELECT * FROM sites WHERE id = ? AND active = 1').get(Number(b.site_id)) : null;
  const counselor = Number(b.counselor_id)
    ? db.prepare("SELECT id, name FROM users WHERE id = ? AND active = 1 AND role IN ('counselor','supervisor')")
      .get(Number(b.counselor_id)) : null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? b.date : '';
  const start = /^\d{2}:\d{2}$/.test(String(b.start_time || '')) ? b.start_time : '';

  // 希望時段：有選格子就寫明確時間，沒選就收自由文字
  const preferred = date && start
    ? `${date} ${start}${site ? '（' + site.name + '）' : ''}`
    : String(b.preferred_time || '').trim().slice(0, 100);

  const noteLines = [
    '【線上預約申請】',
    site ? `希望據點：${site.name}` : '',
    counselor ? `指定心理師：${counselor.name}` : '未指定心理師',
    b.first_time ? '初次晤談（需安排初談）' : '曾在本所晤談',
    b.email ? `Email：${String(b.email).trim().slice(0, 60)}` : '',
    String(b.note || '').trim() ? `補充：${String(b.note).trim().slice(0, 500)}` : ''
  ].filter(Boolean);

  const info = db.prepare(`INSERT INTO intakes (name, phone, source, issue, preferred_time,
      preferred_counselor_id, urgency, status, note)
    VALUES (?,?,?,?,?,?,?, 'new', ?)`)
    .run(name, phone, '線上預約', String(b.topic || '').trim().slice(0, 100), preferred,
      counselor ? counselor.id : null, 'normal', noteLines.join('\n'));
  audit('public', null, name, '線上預約申請', String(info.lastInsertRowid),
    { site: site ? site.name : '', counselor: counselor ? counselor.name : '', preferred });
  res.json({
    ok: true,
    message: '已收到您的預約申請，我們會於服務時間內與您聯繫確認時段。',
    phone: getSetting('center_phone')
  });
});

module.exports = router;
