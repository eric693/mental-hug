const crypto = require('crypto');
const { db, getSetting, nowStamp } = require('./db');

// LINE 官方帳號傳話：個案在官方帳號傳「請假／改期」→ 系統轉到該心理師的 LINE 群組
// → 心理師在群組回覆 → 行政人員在系統簽核 → 真正改期並同步回覆個案與群組。
//
// 憑證未填時整個通道視為關閉：webhook 一律拒收，也不會對外送出任何訊息，
// 個案資料不會流到未設定的外部端點。

const LINE_API = 'https://api.line.me/v2/bot';

function enabled() {
  return !!getSetting('line_channel_secret', '').trim() && !!getSetting('line_channel_token', '').trim();
}

// LINE 的簽章是「channel secret 對 raw body 做 HMAC-SHA256 後 base64」，
// 必須用未經 JSON.parse 的原始 bytes 比對，故 server.js 於 express.json 保留 rawBody。
function verifySignature(rawBody, signature) {
  const secret = getSetting('line_channel_secret', '').trim();
  if (!secret || !rawBody || !signature) return false;
  const expect = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expect), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function logEvent(row) {
  db.prepare(`INSERT INTO line_events (direction, source_type, source_id, client_id, counselor_id,
      request_id, text, status, error)
    VALUES (@direction, @source_type, @source_id, @client_id, @counselor_id, @request_id, @text, @status, @error)`)
    .run({
      direction: 'in', source_type: '', source_id: '', client_id: null, counselor_id: null,
      request_id: null, text: '', status: 'ok', error: '', ...row
    });
}

async function callLine(pathname, body) {
  const token = getSetting('line_channel_token', '').trim();
  if (!token) throw new Error('尚未設定 LINE Channel access token');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const resp = await fetch(LINE_API + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    if (!resp.ok) {
      const text = (await resp.text().catch(() => '')).slice(0, 200);
      throw new Error(`LINE API ${resp.status} ${text}`);
    }
    return true;
  } finally { clearTimeout(timer); }
}

// 送訊息並留軌跡；通道未開或沒有收件對象時記為 skipped，不視為錯誤
// （所方還沒接上官方帳號時，流程照樣能在系統內跑完）。
async function send({ to, text, kind = 'push', replyToken = '', meta = {} }) {
  const base = { direction: 'out', text, source_id: to || '', ...meta };
  if (!enabled()) {
    logEvent({ ...base, status: 'skipped', error: '尚未設定 LINE 憑證' });
    return { ok: false, status: 'skipped', message: '尚未設定 LINE 憑證，訊息未送出' };
  }
  if (kind === 'reply' ? !replyToken : !to) {
    logEvent({ ...base, status: 'skipped', error: '沒有收件對象' });
    return { ok: false, status: 'skipped', message: '沒有收件對象，訊息未送出' };
  }
  try {
    if (kind === 'reply') await callLine('/message/reply', { replyToken, messages: [{ type: 'text', text }] });
    else await callLine('/message/push', { to, messages: [{ type: 'text', text }] });
    logEvent({ ...base, status: 'ok' });
    return { ok: true, status: 'sent' };
  } catch (e) {
    const msg = e.name === 'AbortError' ? '連線逾時' : String(e.message || e).slice(0, 200);
    logEvent({ ...base, status: 'failed', error: msg });
    return { ok: false, status: 'failed', message: msg };
  }
}

// 範本代入：{key} 換成值，找不到的 key 原樣留著方便所方發現打錯字
function fill(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
function weekdayName(date) {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getDay()];
}

function keywords() {
  return getSetting('line_keywords', '').split(',').map(s => s.trim()).filter(Boolean);
}
function looksLikeReschedule(text) {
  const t = String(text || '');
  return keywords().some(k => t.includes(k));
}

// 心理師群組：優先用該心理師自己的群組，沒有就用預設群組
function groupIdFor(counselorId) {
  const u = counselorId ? db.prepare('SELECT line_group_id FROM users WHERE id = ?').get(counselorId) : null;
  return (u && u.line_group_id.trim()) || getSetting('line_default_group_id', '').trim();
}

module.exports = {
  enabled, verifySignature, send, fill, weekdayName, logEvent,
  looksLikeReschedule, groupIdFor, nowStamp
};
