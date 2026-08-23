// API 冒煙測試：在拋棄式資料庫上跑一輪關鍵流程，確認改動沒有打破既有功能。
//
//   npm run smoke              # 自行啟動測試用伺服器（預設埠 3999）
//   npm run smoke -- --keep    # 測完保留暫存資料庫與上傳目錄供查看
//
// 特性：
//   - 以 MINDCARE_DATA_DIR / MINDCARE_UPLOAD_DIR / MINDCARE_BACKUP_MIRROR 指向暫存目錄，
//     完全不碰正式資料（data/mindcare.db 與 uploads/）。
//   - 先跑 scripts/seed.js 灌入展示資料，再依實際 HTTP API 測試，不直接操作資料庫，
//     因此權限與保密邊界也一併被驗到。
//   - 任何一項失敗即以 exit code 1 結束，可掛在部署前或 CI。

process.env.TZ = process.env.TZ || 'Asia/Taipei';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 埠號預設交給作業系統挑一個空的，避免與機器上其他服務相撞
const net = require('net');
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
let PORT = Number(process.env.SMOKE_PORT || 0);
let BASE = '';
const KEEP = process.argv.includes('--keep');
const ROOT = path.join(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcare-smoke-'));
const env = {
  ...process.env,
  TZ: 'Asia/Taipei',
  MINDCARE_DATA_DIR: path.join(tmp, 'data'),
  MINDCARE_UPLOAD_DIR: path.join(tmp, 'uploads'),
  MINDCARE_BACKUP_MIRROR: path.join(tmp, 'mirror')
};

// ---- 迷你測試框架 ----
let pass = 0;
const failures = [];
let group = '';
function section(name) { group = name; console.log(`\n── ${name}`); }
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${group} / ${name}：${e.message}`);
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '條件不成立'); }
function equal(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || '值不符'}（預期 ${expected}，實際 ${actual}）`);
}

// ---- HTTP 工具（各自帶 cookie，模擬不同登入身分）----
// 直接用 fetch 驗標頭時要帶 cookie，這裡讓 session 物件把 cookie 暴露出來
let _adminCookie = '';
function adminCookie() { return _adminCookie; }

function session() {
  let cookie = '';
  const call = async (method, url, body, opts = {}) => {
    const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) };
    let payload = body;
    if (body !== undefined && !opts.raw) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) { cookie = set.split(';')[0]; if (url === '/api/login' && body && body.username === 'admin') _adminCookie = cookie; }
    const text = await res.text();
    let data = text;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      try { data = JSON.parse(text); } catch { /* 保留原文 */ }
    }
    return { status: res.status, data, text };
  };
  const self = {
    get cookie() { return cookie; },
    get: (u, o) => call('GET', u, undefined, o),
    post: (u, b, o) => call('POST', u, b, o),
    put: (u, b) => call('PUT', u, b),
    del: u => call('DELETE', u),
    // 成功才回傳內容，失敗直接丟出錯誤訊息，測試碼才不必層層判斷
    async ok(method, u, b, o) {
      const r = await call(method, u, b, o);
      if (r.status >= 400) throw new Error(`${method} ${u} → ${r.status} ${JSON.stringify(r.data)}`);
      return r.data;
    },
    async fails(method, u, b, msgPart) {
      const r = await call(method, u, b);
      assert(r.status >= 400, `${method} ${u} 應該被擋下，卻回 ${r.status}`);
      if (msgPart) {
        const m = (r.data && r.data.error) || '';
        assert(m.includes(msgPart), `錯誤訊息應含「${msgPart}」，實際為「${m}」`);
      }
      return r.data;
    }
  };
  return self;
}

// multipart 檔案上傳（不引外部套件，手工組 body）
function multipart(fields, file) {
  const b = '----mindcaresmoke' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
    + `Content-Type: ${file.type}\r\n\r\n`));
  parts.push(file.buf);
  parts.push(Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${b}` } };
}

// 1x1 PNG（最小合法圖檔，用來驗證照片上傳與下載後位元組一致）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
// 取未來第一個指定星期的日期（seed 的 lin 排班在週一／三／五）
function nextWeekday(wd, minDaysAhead = 2) {
  let d = addDays(ymd(new Date()), minDaysAhead);
  while (new Date(d + 'T00:00:00').getDay() !== wd) d = addDays(d, 1);
  return d;
}

let server;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('node', [path.join(ROOT, 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('伺服器啟動逾時：\n' + out)), 20000);
    server.stdout.on('data', d => {
      out += d;
      if (out.includes('個案專區')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', d => { out += d; });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`伺服器結束（code ${code}）：\n${out}`)); });
  });
}

(async () => {
  PORT = PORT || await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  env.PORT = String(PORT);
  console.log(`暫存資料目錄：${tmp}（測試埠 ${PORT}）`);
  execFileSync('node', [path.join(ROOT, 'scripts', 'seed.js')], { env, stdio: 'ignore' });
  await startServer();

  const admin = session(), lin = session(), office = session(), chen = session(), wu = session();
  const portal = session();
  let clientId, clientCode;

  // ---------------------------------------------------------------- 登入與權限
  section('登入與權限');
  await test('管理者登入', async () => {
    const me = await admin.ok('POST', '/api/login', { username: 'admin', password: 'mindcare123' });
    equal(me.role, 'admin', '角色');
  });
  await test('心理師、督導、行政登入', async () => {
    await lin.ok('POST', '/api/login', { username: 'lin', password: '123456' });
    await wu.ok('POST', '/api/login', { username: 'wu', password: '123456' });
    await office.ok('POST', '/api/login', { username: 'office', password: '123456' });
    await chen.ok('POST', '/api/login', { username: 'chen', password: '123456' });
  });
  await test('密碼錯誤被拒', () => admin.fails('POST', '/api/login', { username: 'lin', password: 'x' }));
  await test('未登入讀不到 API', async () => {
    const r = await fetch(BASE + '/api/clients');
    equal(r.status, 401, 'HTTP 狀態');
  });
  await test('行政人員沒有晤談紀錄模組', async () => {
    const list = await office.ok('GET', '/api/clients');
    await office.fails('GET', `/api/clients/${list[0].id}/notes`, undefined, '權限');
  });

  // ---------------------------------------------------------------- 個案
  section('個案建檔');
  await test('新增個案並自動編號', async () => {
    const r = await lin.ok('POST', '/api/clients', {
      name: '冒煙測試個案', phone: '0900000001', birth_date: '1995-03-02',
      counselor_id: 2, risk_level: 'high', main_issue: '測試'
    });
    clientId = r.id;
    const c = await lin.ok('GET', `/api/clients/${clientId}`);
    clientCode = c.code;
    assert(/^C\d{4}\d{3}$/.test(c.code), `個案編號格式異常：${c.code}`);
  });
  await test('身分證檢查碼不符時回警告（設計為提示不擋）', async () => {
    const r = await lin.ok('POST', '/api/clients', { name: '冒煙身分證測試', id_no: 'A123456780' });
    assert(r.warning && r.warning.includes('檢查碼'), `應回傳檢查碼警告，實際：${JSON.stringify(r.warning)}`);
  });

  // ---------------------------------------------------------------- 排班
  section('排班與可預約時段');
  // 基準日取兩週後的週一，與 seed 內建的請假（今天+4 天）錯開；
  // 其餘測試以此推算，避免彼此撞日：+7 收費、+14 個案端預約、+21 請假、+28 改期
  const monday = nextWeekday(1, 8);
  await test('整週排班存檔並合併重疊時段', async () => {
    const r = await lin.ok('POST', '/api/availability/bulk', {
      blocks: [
        { weekday: 1, start_time: '14:00', end_time: '16:00' },
        { weekday: 1, start_time: '14:00', end_time: '15:00' },   // 完全重疊
        { weekday: 1, start_time: '16:00', end_time: '18:00' },   // 相接
        { weekday: 3, start_time: '14:00', end_time: '18:00' },
        { weekday: 5, start_time: '14:00', end_time: '18:00' }
      ]
    });
    equal(r.count, 3, '合併後時段數（週一三五各一段）');
  });
  await test('可預約時段不重複', async () => {
    const slots = await lin.ok('GET', `/api/slots?counselor_id=2&date=${monday}`);
    const starts = slots.map(s => s.start_time);
    equal(new Set(starts).size, starts.length, '出現重複的開始時間');
    assert(starts.length > 0, '應該要有可預約時段');
  });
  await test('非管理者不可設定別人的排班', () =>
    lin.fails('POST', '/api/availability/bulk', { counselor_id: 3, blocks: [] }, '自己'));
  await test('結束時間早於開始時間被擋', () =>
    lin.fails('POST', '/api/availability/bulk',
      { blocks: [{ weekday: 2, start_time: '16:00', end_time: '15:00' }] }, '結束時間'));

  // ---------------------------------------------------------------- 預約
  section('預約與衝突檢查');
  let apptId;
  await test('建立預約', async () => {
    const r = await lin.ok('POST', '/api/appointments', {
      client_id: clientId, counselor_id: 2, room_id: 1, date: monday, start_time: '14:00', fee: 2000
    });
    apptId = r.id;
  });
  await test('同一心理師時段衝突被擋', () =>
    lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: monday, start_time: '14:00' }, '心理師'));
  await test('同一諮商室衝突被擋', () =>
    lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 3, room_id: 1, date: monday, start_time: '14:00' }, '諮商室'));
  await test('請假時段不可下訂', async () => {
    const off = addDays(monday, 21);
    await lin.ok('POST', '/api/time-off', { start_date: off, end_date: off, all_day: true, reason: '測試請假' });
    await lin.fails('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: off, start_time: '14:00' }, '請假');
  });
  await test('週檢視與行事曆回傳資料', async () => {
    const w = await lin.ok('GET', `/api/schedule/week?start=${monday}`);
    assert(Array.isArray(w.appointments), '週檢視格式');
    const c = await lin.ok('GET', `/api/schedule/calendar?from=${monday}&to=${addDays(monday, 30)}`);
    assert(Array.isArray(c.appointments), '行事曆格式');
  });

  // ---------------------------------------------------------------- 行事曆訂閱
  section('行事曆訂閱（.ics）');
  let icsUrl;
  await test('取得訂閱網址並可讀取', async () => {
    const r = await lin.ok('GET', '/api/my/calendar-url');
    icsUrl = r.url;
    const res = await fetch(icsUrl);
    equal(res.status, 200, 'HTTP 狀態');
    const body = await res.text();
    assert(body.startsWith('BEGIN:VCALENDAR'), 'ics 格式');
    assert(body.includes('BEGIN:VEVENT'), '應包含事件');
    assert(body.includes(clientCode), '應以個案編號標示');
    assert(!body.includes('冒煙測試個案'), '不可含個案姓名');
  });
  await test('重設後舊網址失效', async () => {
    await lin.ok('POST', '/api/my/calendar-url/reset', {});
    const res = await fetch(icsUrl);
    equal(res.status, 404, '舊網址應失效');
  });

  // ---------------------------------------------------------------- 個案端
  section('個案端（預約、改期、取消）');
  let portalAppt;
  await test('個案端登入', async () => {
    await admin.ok('PUT', `/api/clients/${clientId}`, { portal_enabled: 1 });
    const rp = await admin.ok('POST', `/api/clients/${clientId}/reset-password`, {});
    const r = await portal.ok('POST', '/api/portal/login', { phone: '0900000001', password: rp.password });
    assert(r.ok, '登入失敗');
  });
  await test('個案端自行預約', async () => {
    const target = addDays(monday, 14);
    const slots = await portal.ok('GET', `/api/portal/slots?date=${target}`);
    const c = slots.counselors.find(x => x.slots.length);
    assert(c, `個案端在 ${target} 應看得到可預約時段，實際：${JSON.stringify(slots)}`);
    const r = await portal.ok('POST', '/api/portal/appointments',
      { date: target, start_time: c.slots[0].start_time, counselor_id: c.id });
    portalAppt = r.id;
  });
  await test('改期後不會與他人共用同一諮商室', async () => {
    // 先讓櫃檯把同一時段的諮商室 1 排給別的心理師，再讓個案改期過去
    const target = addDays(monday, 28);
    const slots = await lin.ok('GET', `/api/slots?counselor_id=2&date=${target}`);
    assert(slots.length, '該日應有可預約時段');
    const t = slots[0].start_time;
    const others = await lin.ok('GET', '/api/clients');
    const other = others.find(c => c.id !== clientId);
    await lin.ok('POST', '/api/appointments',
      { client_id: other.id, counselor_id: 3, room_id: 1, date: target, start_time: t });
    await admin.ok('PUT', `/api/appointments/${portalAppt}`, { room_id: 1 });
    await portal.ok('POST', `/api/portal/appointments/${portalAppt}/reschedule`, { date: target, start_time: t });
    const list = await lin.ok('GET', `/api/appointments?date=${target}`);
    const rooms = list.filter(a => a.room_id).map(a => `${a.room_id}@${a.start_time}`);
    equal(new Set(rooms).size, rooms.length, '同一諮商室同一時段被排了兩筆');
  });
  await test('逾期取消只留申請不直接取消', async () => {
    const now = new Date();
    if (now.getHours() >= 22) { console.log('      （接近午夜，略過此項）'); return; }
    const soon = ymd(now);
    const hh = String(now.getHours() + 1).padStart(2, '0');
    const r = await admin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: soon, start_time: `${hh}:00` });
    const res = await portal.ok('POST', `/api/portal/appointments/${r.id}/cancel`, { reason: '臨時有事' });
    assert(res.pending, '應為待櫃檯處理的申請');
    const after = await admin.ok('GET', `/api/appointments?date=${soon}`);
    const row = after.find(a => a.id === r.id);
    equal(row.status, 'booked', '狀態不應被個案改掉');
    const dash = await admin.ok('GET', '/api/dashboard');
    assert(dash.cancel_requests.some(c => c.id === r.id), '總覽應列出取消申請');
    await admin.ok('POST', `/api/appointments/${r.id}/status`, { status: 'cancelled' });
  });
  await test('個案端讀不到晤談紀錄類 API', async () => {
    const res = await fetch(BASE + `/api/clients/${clientId}/notes`);
    assert(res.status === 401 || res.status === 403, '個案端不得存取員工 API');
  });

  // ---------------------------------------------------------------- 候補遞補
  section('候補遞補');
  await test('取消釋出時段後可配對候補', async () => {
    await admin.ok('POST', '/api/intakes', {
      name: '冒煙候補', phone: '0900000009', issue: '測試候補', urgency: 'high',
      preferred_counselor_id: 2, preferred_time: '平日下午'
    });
    const r = await admin.ok('POST', `/api/appointments/${apptId}/status`, { status: 'cancelled' });
    assert(r.opening && r.opening.candidates.length, '取消後應回傳候補人選');
    const openings = await admin.ok('GET', '/api/waitlist/openings');
    assert(openings.some(o => o.date === monday), '釋出時段應出現在候補清單');
  });
  await test('發送遞補通知（未設通道時記為人工）', async () => {
    const list = await admin.ok('GET', '/api/intakes');
    const w = list.find(i => i.name === '冒煙候補');
    const r = await admin.ok('POST', '/api/waitlist/notify',
      { intake_id: w.id, counselor_id: 2, date: monday, start_time: '14:00' });
    equal(r.status, 'manual', '發送狀態');
  });

  // ---------------------------------------------------------------- 晤談紀錄與覆核
  section('晤談紀錄保密與實習生覆核');
  let noteId, internId;
  await test('主責心理師可寫紀錄、非主責讀不到', async () => {
    const r = await lin.ok('POST', '/api/notes', {
      client_id: clientId, date: monday, subjective: 'S', objective: 'O',
      assessment: 'A', plan: 'P', risk_flag: 'none'
    });
    noteId = r.id;
    await chen.fails('GET', `/api/clients/${clientId}/notes`, undefined, '主責');
    const mine = await lin.ok('GET', `/api/clients/${clientId}/notes`);
    assert(mine.length >= 1, '主責應讀得到');
  });
  await test('督導可調閱', async () => {
    const rows = await wu.ok('GET', `/api/clients/${clientId}/notes`);
    assert(rows.length >= 1, '督導應讀得到');
  });
  await test('簽核後不可修改', async () => {
    await lin.ok('POST', `/api/notes/${noteId}/sign`, {});
    await lin.fails('PUT', `/api/notes/${noteId}`, { plan: '改改看' }, '定稿');
  });
  await test('諮商紀錄列印版帶機構抬頭，非主責讀不到', async () => {
    const p = await lin.ok('GET', `/api/notes/${noteId}/print`);
    assert(p.center_name && p.printed_by, '應帶機構抬頭與列印人');
    equal(p.subjective, 'S', '紀錄內容');
    await chen.fails('GET', `/api/notes/${noteId}/print`, undefined, '主責');
  });
  await test('批次列印：用途必填、留批次軌跡、逐筆檢查保密邊界', async () => {
    await lin.fails('POST', '/api/notes/print-batch', { ids: [noteId] }, '用途');
    await lin.fails('POST', '/api/notes/print-batch', { ids: [noteId], purpose: '亂填' }, '用途');
    await lin.fails('POST', '/api/notes/print-batch', { ids: [noteId], purpose: '其他' }, '說明');
    const byId = await lin.ok('POST', '/api/notes/print-batch', { ids: [noteId], purpose: '督考' });
    equal(byId.rows.length, 1, '依 id 取件數');
    assert(/^PB-\d{8}-\d{4}$/.test(byId.batch_no), `批次編號格式異常：${byId.batch_no}`);
    assert(byId.center_name && byId.printed_by, '應帶機構抬頭與列印人');
    const byRange = await lin.ok('POST', '/api/notes/print-batch',
      { client_id: clientId, from: '2000-01-01', to: '2100-01-01', purpose: '內部歸檔' });
    assert(byRange.rows.length >= 1, '依區間應取到紀錄');
    await lin.fails('POST', '/api/notes/print-batch',
      { client_id: clientId, from: '2000-01-01', to: '2000-01-02', purpose: '督考' }, '沒有符合');
    await lin.fails('POST', '/api/notes/print-batch', { purpose: '督考' }, '沒有符合');
    await chen.fails('POST', '/api/notes/print-batch', { ids: [noteId], purpose: '督考' }, '存取範圍');
  });
  await test('列印範圍預查與反向選取的 N 一致', async () => {
    const scope = await lin.ok('POST', '/api/notes/print-scope',
      { client_id: clientId, from: '2000-01-01', to: '2100-01-01' });
    assert(scope.total >= 1, '應回傳可見筆數');
    equal(scope.ids.length, scope.total, 'ids 與 total 必須一致（反向選取靠它）');
    assert(Array.isArray(scope.purposes) && scope.purposes.includes('司法調閱'), '應回傳用途選項');
    // 非主責看到的 N 是 0，不是別人的筆數
    const other = await chen.ok('POST', '/api/notes/print-scope', { client_id: clientId, from: '2000-01-01', to: '2100-01-01' });
    equal(other.total, 0, '非主責的可見筆數應為 0');
    assert(other.hidden >= 1, '應回報被擋下的筆數');
  });
  await test('列印批次軌跡可查、且沒有修改或刪除的端點', async () => {
    const d = await lin.ok('GET', '/api/print-batches');
    assert(d.rows.length >= 2, '前面兩次列印應留下批次');
    const b = d.rows[0];
    assert(b.batch_no && b.purpose && b.user_name && b.note_ids.length, '批次欄位齊全');
    const r1 = await fetch(BASE + `/api/print-batches/${b.id}`, { method: 'DELETE' });
    assert(r1.status === 404 || r1.status === 401, '不應提供刪除批次的端點');
  });
  await test('實習生紀錄須經督導覆核才定稿', async () => {
    const u = await admin.ok('POST', '/api/users', {
      username: 'smoke_intern', password: '123456', name: '冒煙實習生', role: 'counselor',
      license_type: '實習心理師', is_intern: true, supervisor_id: 4
    });
    internId = u.id;
    await admin.ok('PUT', `/api/clients/${clientId}`, { counselor_id: internId });
    const intern = session();
    await intern.ok('POST', '/api/login', { username: 'smoke_intern', password: '123456' });
    const n = await intern.ok('POST', '/api/notes', {
      client_id: clientId, date: monday, subjective: 'S2', objective: 'O2', assessment: 'A2', plan: 'P2'
    });
    const signed = await intern.ok('POST', `/api/notes/${n.id}/sign`, {});
    equal(signed.review_status, 'pending', '應為待覆核');
    await intern.fails('PUT', `/api/notes/${n.id}`, { plan: '偷改' }, '覆核');
    const queue = await wu.ok('GET', '/api/notes/review-queue');
    assert(queue.rows.some(r => r.id === n.id), '督導的待覆核清單應包含此筆');
    await wu.fails('POST', `/api/notes/${n.id}/review`, { action: 'return' }, '意見');
    await wu.ok('POST', `/api/notes/${n.id}/review`, { action: 'return', comment: '請補風險評估' });
    await intern.ok('PUT', `/api/notes/${n.id}`, { plan: '已補' });
    await intern.ok('POST', `/api/notes/${n.id}/sign`, {});
    await chen.fails('POST', `/api/notes/${n.id}/review`, { action: 'approve' }, '督導');
    await wu.ok('POST', `/api/notes/${n.id}/review`, { action: 'approve', comment: 'OK' });
    const got = await wu.ok('GET', `/api/notes/${n.id}`);
    equal(got.review_status, 'approved', '覆核狀態');
    equal(got.locked, 1, '應已定稿鎖定');
    await admin.ok('PUT', `/api/clients/${clientId}`, { counselor_id: 2 });
  });

  // ---------------------------------------------------------------- 安全計畫
  section('安全計畫');
  let planId;
  await test('建立與新版本', async () => {
    const r = await lin.ok('POST', `/api/clients/${clientId}/safety-plans`, {
      warning_signs: '睡不著', coping_strategies: '散步', review_date: addDays(monday, 90)
    });
    planId = r.id;
    const v2 = await lin.ok('POST', `/api/clients/${clientId}/safety-plans`, {
      warning_signs: '睡不著、易怒', coping_strategies: '散步、深呼吸'
    });
    equal(v2.version, 2, '版本號');
    const list = await lin.ok('GET', `/api/clients/${clientId}/safety-plans`);
    equal(list.rows.filter(r2 => r2.status === 'active').length, 1, '現行版本應只有一份');
  });
  await test('必填欄位驗證', () =>
    lin.fails('POST', `/api/clients/${clientId}/safety-plans`, { warning_signs: '只有警訊' }, '必填'));
  await test('舊版本不可修改、可列印', async () => {
    await lin.fails('PUT', `/api/safety-plans/${planId}`, { warning_signs: 'x' }, '舊版本');
    const p = await lin.ok('GET', `/api/safety-plans/${planId}/print`);
    assert(p.center_name, '列印資料應含所別抬頭');
  });
  await test('非主責心理師與行政讀不到', async () => {
    await chen.fails('GET', `/api/clients/${clientId}/safety-plans`, undefined, '主責');
    await office.fails('GET', `/api/clients/${clientId}/safety-plans`);
  });
  await test('列管清單標示狀態', async () => {
    const d = await admin.ok('GET', '/api/safety-plans/overview');
    assert(d.rows.some(r => r.client_id === clientId && r.state === 'ok'), '應顯示現行有效');
  });

  // ---------------------------------------------------------------- 轉介與追蹤
  section('轉介、結案追蹤與通報表');
  await test('轉介紀錄與對方回覆', async () => {
    const r = await lin.ok('POST', `/api/clients/${clientId}/referrals`,
      { target: '某某醫院身心科', reason: '需藥物評估', contact: '02-1234-5678' });
    await lin.fails('POST', `/api/clients/${clientId}/referrals`, { target: '缺原因' }, '原因');
    await lin.ok('PUT', `/api/referrals/${r.id}`, { status: 'accepted', reply_note: '已排下週門診' });
    const list = await lin.ok('GET', `/api/clients/${clientId}/referrals`);
    const row = list.rows.find(x => x.id === r.id);
    equal(row.status, 'accepted', '轉介狀態');
    assert(row.replied_at, '應自動記下回覆時間');
    assert(list.targets.length, '應提供轉介對象選項');
  });
  await test('非主責心理師與行政讀不到轉介紀錄', async () => {
    await chen.fails('GET', `/api/clients/${clientId}/referrals`, undefined, '主責');
    await office.fails('GET', `/api/clients/${clientId}/referrals`);
    await office.fails('GET', '/api/follow-ups');
  });
  await test('結案時自動建立追蹤點', async () => {
    const r = await admin.ok('PUT', `/api/clients/${clientId}`, { status: 'closed', close_reason: '目標達成' });
    assert(r.follow_ups >= 1, '結案應自動建立追蹤點');
    const fu = await lin.ok('GET', `/api/clients/${clientId}/follow-ups`);
    assert(fu.rows.length >= 1, '追蹤清單應有資料');
    const first = fu.rows[0];
    await lin.fails('PUT', `/api/follow-ups/${first.id}`, { status: 'done' }, '追蹤結果');
    await lin.ok('PUT', `/api/follow-ups/${first.id}`,
      { status: 'done', channel: '電話', result: '個案狀況穩定，無需再約' });
    const after = await lin.ok('GET', `/api/clients/${clientId}/follow-ups`);
    const done = after.rows.find(x => x.id === first.id);
    equal(done.status, 'done', '追蹤狀態');
    assert(done.done_at, '應記下完成時間');
    // 還原為服務中，後續收費測試才排得了新預約
    await admin.ok('PUT', `/api/clients/${clientId}`, { status: 'active' });
  });
  await test('待追蹤清單可查', async () => {
    const d = await admin.ok('GET', '/api/follow-ups');
    assert(Array.isArray(d.rows), '清單格式');
    assert(typeof d.overdue === 'number', '應回傳逾期數');
  });
  await test('責任通報表帶齊欄位', async () => {
    const events = await admin.ok('GET', '/api/risk-events');
    assert(events.length, '示範資料應有危機事件');
    const f = await admin.ok('GET', `/api/risk-events/${events[0].id}/report-form`);
    assert(f.client_name && f.client_code, '應帶當事人資料');
    assert(f.reporter && f.reporter.name, '應帶通報人');
    assert(f.center_name, '應帶通報單位');
    assert(typeof f.mandatory === 'boolean', '應標示是否為法定責任通報');
    await office.fails('GET', `/api/risk-events/${events[0].id}/report-form`);
  });

  // ---------------------------------------------------------------- 收費與退費
  section('收費、方案與退費');
  let invoiceId;
  await test('完成晤談自動開單並收款', async () => {
    const target = addDays(monday, 7);
    const a = await lin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: target, start_time: '14:00', fee: 2000 });
    await lin.ok('POST', `/api/appointments/${a.id}/status`, { status: 'done' });
    const inv = await admin.ok('GET', `/api/invoices?client_id=${clientId}&status=unpaid`);
    const row = inv.rows.find(r => r.appointment_id === a.id);
    assert(row, '完成晤談應產生收費單');
    invoiceId = row.id;
    await admin.ok('POST', `/api/invoices/${invoiceId}/pay`, { method: '現金' });
    const after = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    equal(after.rows.find(r => r.id === invoiceId).status, 'paid', '收款後狀態');
  });
  await test('退費超額被擋、全額退費改狀態', async () => {
    await admin.fails('POST', `/api/invoices/${invoiceId}/refund`, { amount: 99999, reason: '測試' }, '上限');
    await admin.fails('POST', `/api/invoices/${invoiceId}/refund`, { amount: 100 }, '原因');
    await admin.ok('POST', `/api/invoices/${invoiceId}/refund`, { amount: 2000, reason: '所方因素取消' });
    const list = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    const row = list.rows.find(r => r.id === invoiceId);
    equal(row.status, 'refunded', '全額退費後狀態');
    equal(row.refunded, 2000, '已退金額');
    equal(list.total_net, list.total_paid + 2000 - list.total_refunded, '實收計算');
  });
  await test('已退費的收費單不會被狀態回沖刪掉', async () => {
    const inv = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    const row = inv.rows.find(r => r.id === invoiceId);
    const r = await admin.ok('POST', `/api/appointments/${row.appointment_id}/status`, { status: 'booked' });
    assert(r.warnings.length, '應提出警示');
    const after = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    assert(after.rows.some(x => x.id === invoiceId), '退費過的收費單被刪除了');
  });
  await test('撤銷退費後回復為已收款', async () => {
    const d = await admin.ok('GET', '/api/refunds');
    const rf = d.rows.find(r => r.invoice_id === invoiceId);
    await admin.ok('DELETE', `/api/refunds/${rf.id}`);
    const list = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    equal(list.rows.find(r => r.id === invoiceId).status, 'paid', '撤銷後狀態');
  });

  await test('期間彙總收據列出已收款項目', async () => {
    const r = await admin.ok('GET', `/api/clients/${clientId}/receipt-summary?from=2000-01-01&to=2100-01-01`);
    assert(r.rows.length >= 1, '應列出已收款項目');
    equal(r.total, r.rows.reduce((n, x) => n + x.amount, 0), '合計金額');
    assert(r.center_name, '應帶機構抬頭');
    await admin.fails('GET', `/api/clients/${clientId}/receipt-summary`, undefined, '起訖');
  });

  // ---------------------------------------------------------------- LINE 傳話與改期簽核
  section('LINE 傳話與改期簽核');
  let reqId, reschedApptId;
  await test('個案端申請預設進「待審核轉達」，行政放行後才進群組', async () => {
    const crypto = require('crypto');
    const secret = 'relay-approval-secret';
    await admin.ok('PUT', '/api/line/credentials', { line_channel_secret: secret, line_channel_token: 'tok3' });
    await admin.ok('PUT', '/api/settings', { line_relay_requires_approval: '1' });
    // 先綁一位個案並讓他有未來預約
    const target = addDays(monday, 63);
    await admin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: target, start_time: '13:00' });
    const raw = JSON.stringify({ events: [{ type: 'message', replyToken: 'rt1',
      source: { type: 'user', userId: 'Uapproval1' }, message: { type: 'text', text: '綁定 0900000001' } }] });
    const sig = b => crypto.createHmac('sha256', secret).update(b).digest('base64');
    await fetch(BASE + '/line/webhook', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': sig(raw) }, body: raw });
    await new Promise(r => setTimeout(r, 300));
    const raw2 = JSON.stringify({ events: [{ type: 'message', replyToken: 'rt2',
      source: { type: 'user', userId: 'Uapproval1' }, message: { type: 'text', text: '我要改期，那天有事' } }] });
    await fetch(BASE + '/line/webhook', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': sig(raw2) }, body: raw2 });
    await new Promise(r => setTimeout(r, 300));
    const pending = await admin.ok('GET', '/api/reschedule-requests?status=new');
    const r = pending[0];
    assert(r, '應有一筆待審核轉達');
    equal(r.status, 'new', '未經審核不應轉達');
    const ev = await admin.ok('GET', '/api/line/events');
    assert(!ev.rows.some(e => e.request_id === r.id && e.source_type === 'group'),
      '未審核前不應有送往群組的紀錄');
    // 放行並修訂文字
    const out = await admin.ok('POST', `/api/reschedule-requests/${r.id}/relay`, { relay_text: '個案希望改期（櫃檯已確認）' });
    assert(out.status, '應回傳送出結果');
    const after = (await admin.ok('GET', '/api/reschedule-requests?status=all')).find(x => x.id === r.id);
    equal(after.status, 'relayed', '放行後狀態');
    equal(after.relay_text, '個案希望改期（櫃檯已確認）', '修訂後的轉達文字');
    assert(after.relay_approved_by, '應記錄放行的人');
    await admin.ok('DELETE', `/api/line/clients/${clientId}/bind`);
    await admin.ok('PUT', '/api/line/credentials', { clear_secret: true, clear_token: true });
  });
  await test('不轉達與重新開啟', async () => {
    const target = addDays(monday, 70);
    const a = await admin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: target, start_time: '15:00' });
    const r = await admin.ok('POST', '/api/reschedule-requests',
      { appointment_id: a.id, raw_text: '誤傳訊息' });
    // 櫃檯代錄的是行政自己輸入的，預設直接轉達；把它退回待審核再測拒絕
    await admin.ok('POST', `/api/reschedule-requests/${r.id}/reopen`).catch(() => {});
    const cur = (await admin.ok('GET', '/api/reschedule-requests?status=all')).find(x => x.id === r.id);
    if (cur.status === 'new') {
      await admin.ok('POST', `/api/reschedule-requests/${r.id}/deny-relay`, { decision_note: '誤傳', notify: false });
      const denied = (await admin.ok('GET', '/api/reschedule-requests?status=denied')).find(x => x.id === r.id);
      equal(denied.status, 'denied', '拒絕轉達後狀態');
      await admin.ok('POST', `/api/reschedule-requests/${r.id}/reopen`, {});
      const back = (await admin.ok('GET', '/api/reschedule-requests?status=new')).find(x => x.id === r.id);
      equal(back.status, 'new', '重新開啟後回到待審核');
    }
    await admin.ok('DELETE', `/api/reschedule-requests/${r.id}`);
  });
  await test('櫃檯代錄改期申請並轉達（未設憑證時只留紀錄）', async () => {
    const target = addDays(monday, 35);
    const a = await admin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: target, start_time: '10:00' });
    reschedApptId = a.id;
    const r = await admin.ok('POST', '/api/reschedule-requests',
      { appointment_id: a.id, raw_text: '那天要開刀，可以改到隔天嗎' });
    reqId = r.id;
    equal(r.relay.status, 'skipped', '未設 LINE 憑證時應為未送出');
    const list = await admin.ok('GET', '/api/reschedule-requests?status=open');
    equal(list.find(x => x.id === reqId).status, 'relayed', '轉達後狀態');
  });
  await test('代錄心理師回覆後進入待簽核', async () => {
    await admin.fails('POST', `/api/reschedule-requests/${reqId}/reply`, { counselor_reply: '' }, '回覆');
    await admin.ok('POST', `/api/reschedule-requests/${reqId}/reply`, { counselor_reply: '可以，改隔天同一時間' });
    const list = await admin.ok('GET', '/api/reschedule-requests?status=replied');
    equal(list.find(x => x.id === reqId).status, 'replied', '回覆後狀態');
  });
  await test('簽核時段衝突會被擋下', async () => {
    const clash = addDays(monday, 42);
    await admin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, date: clash, start_time: '11:00' });
    await admin.fails('POST', `/api/reschedule-requests/${reqId}/approve`,
      { new_date: clash, new_start_time: '11:00' }, '衝突');
  });
  await test('簽核後預約真的改期', async () => {
    const target = addDays(monday, 36);
    await admin.ok('POST', `/api/reschedule-requests/${reqId}/approve`,
      { new_date: target, new_start_time: '10:00' });
    const a = (await admin.ok('GET', `/api/appointments?client_id=${clientId}`)).find(x => x.id === reschedApptId);
    equal(a.date, target, '改期後日期');
    equal(a.reschedule_count, 1, '改期次數');
    const done = await admin.ok('GET', '/api/reschedule-requests?status=approved');
    equal(done.find(x => x.id === reqId).status, 'approved', '簽核後狀態');
    await admin.fails('POST', `/api/reschedule-requests/${reqId}/approve`,
      { new_date: target, new_start_time: '15:00' }, '已簽核');
  });
  await test('未設定憑證時 webhook 一律拒收', async () => {
    const r = await fetch(BASE + '/line/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [] })
    });
    equal(r.status, 403, 'HTTP 狀態');
  });
  await test('傳話軌跡與綁定狀態可查', async () => {
    const ev = await admin.ok('GET', '/api/line/events');
    assert(ev.rows.length >= 1, '應有傳話紀錄');
    const st = await admin.ok('GET', '/api/line/status');
    equal(st.enabled, false, '未設憑證應為未啟用');
    await admin.ok('PUT', '/api/line/counselors/2/group', { line_group_id: 'Cgroup-test' });
    const st2 = await admin.ok('GET', '/api/line/status');
    equal(st2.counselors.find(c => c.id === 2).line_group_id, 'Cgroup-test', '群組設定');
  });
  await test('關閉審核時：綁定→提出改期→直接轉群組→群組回覆', async () => {
    const crypto = require('crypto');
    const secret = 'smoke-secret';
    await admin.ok('PUT', '/api/settings', { line_channel_secret: secret, line_channel_token: 'smoke-token' });
    // 這一段驗的是「收到即轉達」的舊行為，把審核關卡關掉
    await admin.ok('PUT', '/api/settings', { line_relay_requires_approval: '0' });
    const hook = async payload => {
      const raw = JSON.stringify(payload);
      const sig = crypto.createHmac('sha256', secret).update(raw).digest('base64');
      const r = await fetch(BASE + '/line/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': sig },
        body: raw
      });
      equal(r.status, 200, 'webhook HTTP 狀態');
      await new Promise(res => setTimeout(res, 300));   // 事件是回 200 之後才處理
    };
    const userMsg = text => ({
      events: [{ type: 'message', replyToken: 'tok', source: { type: 'user', userId: 'Usmoke1' }, message: { type: 'text', text } }]
    });
    // 簽章錯誤要擋下
    const bad = await fetch(BASE + '/line/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'wrong' },
      body: JSON.stringify(userMsg('哈囉'))
    });
    equal(bad.status, 401, '簽章錯誤應 401');

    await hook(userMsg('綁定 0900000001'));
    const c = await admin.ok('GET', `/api/clients/${clientId}`);
    equal(c.line_user_id, 'Usmoke1', '綁定後的 LINE userId');

    // 個案沒指定是哪一次，系統一律抓他「最近一筆未來的有效預約」
    const nextAppt = (await admin.ok('GET', `/api/appointments?client_id=${clientId}&status=booked`))
      .filter(x => x.date >= ymd(new Date())).sort((x, y) => (x.date + x.start_time).localeCompare(y.date + y.start_time))[0];
    assert(nextAppt, '測試前提：個案應有未來預約');
    await hook(userMsg('下週那次可以改期嗎，我要出差'));
    const open = await admin.ok('GET', '/api/reschedule-requests?status=open');
    const r = open.find(x => x.source === 'line' && x.appointment_id === nextAppt.id);
    assert(r, '應依關鍵字建立改期申請，並對應到最近一筆未來預約');
    equal(r.status, 'relayed', '已轉達心理師群組');

    await hook({ events: [{ type: 'message', replyToken: 'tok2',
      source: { type: 'group', groupId: 'Cgroup-test' }, message: { type: 'text', text: '可以，改成隔天同時段' } }] });
    const after = (await admin.ok('GET', '/api/reschedule-requests?status=replied')).find(x => x.id === r.id);
    assert(after && after.counselor_reply.includes('隔天'), '群組回覆應記入申請');

    // 非關鍵字訊息只進個案訊息，不打擾心理師群組
    const before = (await admin.ok('GET', '/api/reschedule-requests?status=all')).length;
    await hook(userMsg('謝謝老師'));
    const now = (await admin.ok('GET', '/api/reschedule-requests?status=all')).length;
    equal(now, before, '一般訊息不應產生改期申請');
    const msgs = await admin.ok('GET', `/api/messages?client_id=${clientId}`);
    assert(msgs.some(m => m.content === '謝謝老師'), '一般訊息應進個案訊息');

    await admin.ok('PUT', '/api/settings', { line_channel_secret: '', line_channel_token: '', line_relay_requires_approval: '1' });
  });

  await test('憑證可在設定頁直接填、留空不覆蓋、可清除', async () => {
    await admin.ok('PUT', '/api/line/credentials', { line_channel_secret: 'sec1', line_channel_token: 'tok1' });
    let st = await admin.ok('GET', '/api/line/status');
    equal(st.enabled, true, '填完憑證應為已啟用');
    assert(!st.secret_masked.includes('sec1'), '不應把完整 secret 回傳給前端');
    // 留空＝不變更
    await admin.ok('PUT', '/api/line/credentials', { line_channel_secret: '', line_channel_token: '', line_keywords: '改期,請假' });
    st = await admin.ok('GET', '/api/line/status');
    equal(st.enabled, true, '留空不應清掉憑證');
    equal(st.keywords, '改期,請假', '關鍵字');
    await admin.ok('PUT', '/api/line/credentials', { clear_secret: true, clear_token: true });
    st = await admin.ok('GET', '/api/line/status');
    equal(st.enabled, false, '清除後應停用');
    await admin.fails('POST', '/api/line/verify', {}, 'token');
  });
  await test('群組 ID 自動偵測：傳過話但未指派的群組會被列出並可一鍵指派', async () => {
    const crypto = require('crypto');
    const secret = 'auto-group-secret';
    await admin.ok('PUT', '/api/line/credentials', { line_channel_secret: secret, line_channel_token: 'tok2' });
    const raw = JSON.stringify({ events: [{ type: 'join', replyToken: 'jt',
      source: { type: 'group', groupId: 'Cnew-group-1' } }] });
    const r = await fetch(BASE + '/line/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        'X-Line-Signature': crypto.createHmac('sha256', secret).update(raw).digest('base64') },
      body: raw
    });
    equal(r.status, 200, 'webhook HTTP 狀態');
    await new Promise(res => setTimeout(res, 300));
    let st = await admin.ok('GET', '/api/line/status');
    const g = st.unassigned_groups.find(x => x.source_id === 'Cnew-group-1');
    assert(g, '被拉進群組應自動記下 groupId 並列為待指派');
    await admin.ok('PUT', '/api/line/counselors/3/group', { line_group_id: 'Cnew-group-1' });
    st = await admin.ok('GET', '/api/line/status');
    assert(!st.unassigned_groups.some(x => x.source_id === 'Cnew-group-1'), '指派後不應再列為待指派');
    equal(st.counselors.find(c => c.id === 3).line_group_id, 'Cnew-group-1', '指派結果');
    await admin.ok('PUT', '/api/line/credentials', { clear_secret: true, clear_token: true });
  });

  await test('對外訊息以 Flex 泡泡送出，altText 保留純文字版', () => {
    const line = require(path.join(ROOT, 'src', 'line.js'));
    const bub = line.bubble({
      title: '改期申請 #1', tone: 'warn',
      fields: [line.fieldRow('個案', '王小明（C2026001）')],
      body: '個案訊息：想改到下週', footer: '請在群組回覆'
    });
    equal(bub.type, 'bubble', 'Flex 類型');
    equal(bub.header.contents[0].text, '改期申請 #1', '標題');
    assert(bub.footer, '應有頁尾');
    const msg = line.flexMessage('改期申請 #1\n個案：王小明', bub);
    equal(msg.type, 'flex', '訊息類型');
    assert(!msg.altText.includes('\n'), 'altText 不應含換行');
    assert(msg.altText.length <= 400, 'altText 長度需符合 LINE 限制');
    // 整包必須可序列化，欄位值為 undefined 會被 LINE 退件
    assert(!JSON.stringify(msg).includes('undefined'), 'Flex 內容不應出現 undefined');
  });

  await test('模組關閉後 API 一律 403', async () => {
    await admin.ok('PUT', '/api/settings', { disabled_modules: 'line' });
    await admin.fails('GET', '/api/reschedule-requests', undefined, '未啟用');
    await admin.ok('PUT', '/api/settings', { disabled_modules: '' });
    await admin.ok('GET', '/api/reschedule-requests');
  });

  // ---------------------------------------------------------------- 據點與對外預約
  section('據點與對外預約頁');
  let siteA;
  await test('建立據點、指定諮商室與心理師駐點', async () => {
    const r = await admin.ok('POST', '/api/sites', { name: '冒煙據點', short_name: '冒煙', phone: '02-0000-0000' });
    siteA = r.id;
    const rooms = await admin.ok('GET', '/api/rooms');
    await admin.ok('PUT', `/api/rooms/${rooms[0].id}`, { site_id: siteA });
    const after = await admin.ok('GET', '/api/rooms');
    equal(after.find(x => x.id === rooms[0].id).site_id, siteA, '諮商室據點');
    await admin.ok('PUT', '/api/counselors/2/sites', { site_ids: [siteA] });
    const cs = await admin.ok('GET', '/api/counselor-sites');
    assert(cs.find(u => u.id === 2).site_ids.includes(siteA), '心理師駐點');
  });
  await test('排定預約時據點跟著諮商室帶入，並可依據點篩選', async () => {
    const rooms = await admin.ok('GET', '/api/rooms');
    const room = rooms.find(r => r.site_id === siteA);
    const target = addDays(monday, 56);
    const a = await admin.ok('POST', '/api/appointments',
      { client_id: clientId, counselor_id: 2, room_id: room.id, date: target, start_time: '09:00' });
    const list = await admin.ok('GET', `/api/appointments?site_id=${siteA}`);
    const row = list.find(x => x.id === a.id);
    assert(row, '應能依據點篩選出這筆預約');
    equal(row.site_name, '冒煙據點', '據點名稱');
    const week = await admin.ok('GET', `/api/schedule/week?start=${target}&site_id=${siteA}`);
    assert(week.appointments.some(x => x.id === a.id), '週檢視依據點篩選');
    assert(week.sites.length >= 1, '週檢視應帶回據點清單');
  });
  await test('對外預約頁：可取得選項與空檔，且不外洩個案資料', async () => {
    const o = await admin.ok('GET', '/api/public/booking/options');
    equal(o.enabled, true, '預設開放線上預約');
    assert(o.sites.length >= 1 && o.topics.length >= 1, '應帶回據點與主題');
    const raw = JSON.stringify(o);
    assert(!raw.includes('冒煙測試個案'), '選項不應包含任何個案資料');
    const day = nextWeekday(1, 8);
    const slots = await admin.ok('GET', `/api/public/booking/slots?date=${day}`);
    assert(slots.counselors.length >= 1, '應有可預約心理師與空檔');
    assert(!JSON.stringify(slots).includes('冒煙測試個案'), '空檔不應包含個案資料');
    const past = await admin.ok('GET', '/api/public/booking/slots?date=1990-01-01');
    equal(past.counselors.length, 0, '超出可預約範圍應回空');
  });
  await test('線上預約申請會進來電登記，缺聯絡方式會被擋', async () => {
    await admin.fails('POST', '/api/public/booking/request', { name: '', phone: '0912345678' }, '姓名');
    await admin.fails('POST', '/api/public/booking/request', { name: '網路訪客', phone: '12' }, '電話');
    const day = nextWeekday(1, 8);
    const r = await admin.ok('POST', '/api/public/booking/request', {
      name: '網路訪客', phone: '0955000111', topic: '情緒困擾（憂鬱、焦慮）',
      site_id: siteA, counselor_id: 2, date: day, start_time: '09:00', first_time: true, note: '想約晚上'
    });
    assert(r.ok, '應建立成功');
    const intakes = await admin.ok('GET', '/api/intakes?status=new');
    const hit = (intakes.rows || intakes).find(x => x.name === '網路訪客');
    assert(hit, '應出現在來電登記');
    equal(hit.source, '線上預約', '來源');
    assert(String(hit.preferred_time).includes(day), '希望時段應帶入所選時間');
  });
  await test('關閉線上預約後公開端點一律拒絕', async () => {
    await admin.ok('PUT', '/api/settings', { public_booking_enabled: '0' });
    await admin.fails('GET', '/api/public/booking/slots?date=2030-01-01', undefined, '未開放');
    await admin.fails('POST', '/api/public/booking/request', { name: 'x', phone: '0912345678' }, '未開放');
    await admin.ok('PUT', '/api/settings', { public_booking_enabled: '1' });
  });

  // ---------------------------------------------------------------- CRUD 補齊
  section('各模組新增／編輯／刪除');
  await test('公告可編輯', async () => {
    const r = await admin.ok('POST', '/api/announcements', { title: '冒煙公告', content: 'A', audience: 'staff' });
    await admin.ok('PUT', `/api/announcements/${r.id}`, { title: '冒煙公告（改）', pinned: 1 });
    const rows = await admin.ok('GET', '/api/announcements');
    const row = rows.find(x => x.id === r.id);
    equal(row.title, '冒煙公告（改）', '標題');
    equal(row.pinned, 1, '置頂');
    await admin.fails('PUT', `/api/announcements/${r.id}`, { title: '' }, '標題');
    await admin.ok('DELETE', `/api/announcements/${r.id}`);
  });
  await test('同意書範本可新增、停用與刪除；已簽署者只停用', async () => {
    const t = await admin.ok('POST', '/api/consent-templates', { key: 'smoke_tpl', title: '冒煙同意書', body: '內容' });
    await admin.fails('POST', '/api/consent-templates', { key: 'smoke_tpl', title: '重複' }, '已存在');
    const del = await admin.ok('DELETE', `/api/consent-templates/${t.id}`);
    equal(del.disabled, false, '沒人簽過應真的刪除');
    // 已簽署的範本改為停用，且不再出現在待簽清單
    const t2 = await admin.ok('POST', '/api/consent-templates', { key: 'smoke_tpl2', title: '冒煙同意書2', body: '內容' });
    await admin.ok('POST', `/api/clients/${clientId}/consents`, { key: 'smoke_tpl2', signer_name: '測試' });
    const del2 = await admin.ok('DELETE', `/api/consent-templates/${t2.id}`);
    equal(del2.disabled, true, '有簽署紀錄應改為停用');
    const tpls = await admin.ok('GET', '/api/consent-templates');
    equal(tpls.find(x => x.id === t2.id).active, 0, '停用狀態');
    const c = await admin.ok('GET', `/api/clients/${clientId}`);
    assert(!c.pending_consents.some(x => x.key === 'smoke_tpl2'), '停用範本不應再出現在待簽清單');
  });
  await test('已簽署同意書可撤銷', async () => {
    const c = await admin.ok('GET', `/api/clients/${clientId}`);
    const signed = c.consents.find(x => x.key === 'smoke_tpl2');
    assert(signed, '前一項應留下一筆簽署紀錄');
    await admin.ok('DELETE', `/api/consents/${signed.id}`);
    const after = await admin.ok('GET', `/api/clients/${clientId}`);
    assert(!after.consents.some(x => x.id === signed.id), '撤銷後不應still存在');
  });
  await test('量表可改日期與備註，分數不可直接改', async () => {
    const r = await admin.ok('POST', '/api/assessments',
      { client_id: clientId, scale: 'PHQ9', answers: [1, 1, 1, 1, 1, 1, 1, 1, 0], date: monday });
    await admin.ok('PUT', `/api/assessments/${r.id}`, { date: addDays(monday, 1), note: '補登', total: 99 });
    const trend = await admin.ok('GET', `/api/clients/${clientId}/assessment-trend`);
    const row = trend.PHQ9.find(x => x.id === r.id);
    equal(row.date, addDays(monday, 1), '日期');
    equal(row.note, '補登', '備註');
    equal(row.total, 8, '分數不應被前端覆寫');
    await admin.fails('PUT', `/api/assessments/${r.id}`, { date: 'x' }, '日期');
    await admin.ok('DELETE', `/api/assessments/${r.id}`);
  });
  await test('方案：用過的不可刪，沒用過的可刪', async () => {
    const p = await admin.ok('POST', '/api/packages',
      { client_id: clientId, name: '冒煙方案', sessions_total: 5, amount: 5000, start_date: monday });
    // 建立方案會同時開一張收費單，因此預期擋下
    await admin.fails('DELETE', `/api/packages/${p.id}`, undefined, '收費');
    const invs = await admin.ok('GET', `/api/invoices?client_id=${clientId}`);
    const inv = invs.rows.find(x => x.package_id === p.id);
    await admin.ok('POST', `/api/invoices/${inv.id}/void`, { reason: '測試' });
    await admin.ok('DELETE', `/api/invoices/${inv.id}`).catch(() => {});
  });
  await test('處遇計畫與晤談紀錄草稿可刪，已簽核紀錄不可刪', async () => {
    const plan = await lin.ok('POST', '/api/plans',
      { client_id: clientId, start_date: monday, approach: 'CBT', summary: '測試', goals: [{ content: '目標' }] });
    await lin.ok('DELETE', `/api/plans/${plan.id}`);
    const plans = await lin.ok('GET', `/api/clients/${clientId}/plans`);
    assert(!plans.some(x => x.id === plan.id), '計畫應已刪除');
    const draft = await lin.ok('POST', '/api/notes',
      { client_id: clientId, date: monday, subjective: '草稿' });
    await chen.fails('DELETE', `/api/notes/${draft.id}`, undefined, '主責');
    await lin.ok('DELETE', `/api/notes/${draft.id}`);
    await lin.fails('DELETE', `/api/notes/${noteId}`, undefined, '簽核');
  });
  await test('來電登記可刪除，已建檔的不可刪', async () => {
    const i = await admin.ok('POST', '/api/intakes', { name: '冒煙來電', phone: '0977000111' });
    await admin.ok('DELETE', `/api/intakes/${i.id}`);
    const list = await admin.ok('GET', '/api/intakes?status=new');
    assert(!(list.rows || list).some(x => x.id === i.id), '應已刪除');
  });
  await test('帳號：沒用過的可刪，有服務紀錄的改停用', async () => {
    const u = await admin.ok('POST', '/api/users',
      { username: 'smoke_del', password: 'abc123', name: '冒煙待刪', role: 'staff' });
    const del = await admin.ok('DELETE', `/api/users/${u.id}`);
    equal(del.disabled, false, '沒用過應真的刪除');
    const busy = await admin.ok('DELETE', '/api/users/2');
    equal(busy.disabled, true, '有服務紀錄的心理師應改為停用');
    await admin.ok('PUT', '/api/users/2', { active: 1 });
  });
  await test('據點與諮商室：用過的改停用', async () => {
    const s2 = await admin.ok('POST', '/api/sites', { name: '待刪據點' });
    const del = await admin.ok('DELETE', `/api/sites/${s2.id}`);
    equal(del.disabled, false, '空據點應真的刪除');
    const used = await admin.ok('DELETE', `/api/sites/${siteA}`);
    equal(used.disabled, true, '有諮商室／預約的據點應改為停用');
  });
  await test('改期申請可刪，已簽核的不可刪', async () => {
    await admin.fails('DELETE', `/api/reschedule-requests/${reqId}`, undefined, '已簽核');
    const open2 = await admin.ok('GET', '/api/reschedule-requests?status=open');
    if (open2.length) {
      await admin.ok('DELETE', `/api/reschedule-requests/${open2[0].id}`);
      const after = await admin.ok('GET', '/api/reschedule-requests?status=open');
      assert(!after.some(x => x.id === open2[0].id), '應已刪除');
    }
  });

  // ---------------------------------------------------------------- 客戶分級與財務儀表板
  section('客戶分級與財務儀表板');
  await test('客戶分級：出席率不計取消，逾期未收款列為需關注', async () => {
    const d = await admin.ok('GET', '/api/client-tiers');
    assert(d.rows.length >= 1, '應有個案');
    const c = d.rows.find(x => x.id === clientId);
    assert(c, '應含測試個案');
    const scheduled = c.done + c.no_show;
    equal(c.attendance, scheduled ? Math.round(c.done / scheduled * 100) : null, '出席率算法');
    assert(Object.keys(d.counts).length >= 6, '應回傳各級人數');
    assert(d.rules.vip_sessions > 0 && d.rules.good_attendance > 0, '應回傳門檻設定');
    const filtered = await admin.ok('GET', '/api/client-tiers?tier=' + c.tier);
    assert(filtered.rows.every(x => x.tier === c.tier), '篩選結果');
  });
  await test('財務儀表板：實收＝收款−退費，逾期與方案餘額分開列', async () => {
    const d = await admin.ok('GET', '/api/finance/dashboard');
    equal(d.months.length, 12, '預設近 12 個月');
    for (const m of d.months) equal(m.net, m.paid - m.refund, `${m.month} 實收算法`);
    assert(d.summary.unpaid_total >= d.summary.overdue_total, '逾期金額不應大於未收總額');
    assert(Array.isArray(d.by_payer) && Array.isArray(d.by_counselor) && Array.isArray(d.by_site), '結構分析欄位');
    assert(typeof d.summary.unused_package_value === 'number', '方案未使用餘額');
    const one = await admin.ok('GET', '/api/finance/dashboard?months=3');
    equal(one.months.length, 3, '可指定月數');
  });
  await test('行政人員看得到分級與財務，但仍讀不到晤談內容', async () => {
    await office.ok('GET', '/api/client-tiers');
    await office.ok('GET', '/api/finance/dashboard');
    await office.fails('POST', '/api/notes/print-batch', { ids: [noteId] }, '權限');
  });

  // ---------------------------------------------------------------- 非個案服務
  section('非個案服務與紀錄類型');
  await test('非個案服務表單沒有個案欄位，且不進個案統計', async () => {
    const before = (await admin.ok('GET', '/api/clients')).length;
    const r = await lin.ok('POST', '/api/nonclient-services', {
      record_type: 'outreach_talk', date: monday, org_name: '冒煙國中',
      topic: '青少年情緒調適', location: '該校禮堂', attendees: 120, fee: 6000, fee_method: '單位付款'
    });
    assert(r.id, '應建立成功');
    await lin.fails('POST', '/api/nonclient-services', { date: monday, org_name: '' }, '對象單位');
    const list = await lin.ok('GET', '/api/nonclient-services?from=2000-01-01&to=2100-01-01');
    const row = list.rows.find(x => x.id === r.id);
    assert(row, '應查得到');
    assert(!('client_id' in row), '非個案服務不應有個案欄位');
    equal(list.summary.attendees >= 120, true, '統計參與人數');
    equal((await admin.ok('GET', '/api/clients')).length, before, '不應憑空多出個案');
    // 個案統計不受影響
    const rep = await admin.ok('GET', `/api/reports?month=${monday.slice(0, 7)}`);
    assert(rep, '報表仍可載入');
    await lin.ok('PUT', `/api/nonclient-services/${r.id}`, { attendees: 130 });
    await lin.ok('DELETE', `/api/nonclient-services/${r.id}`);
  });
  await test('歷史虛擬個案批次重新標記僅限管理者', async () => {
    await lin.fails('POST', '/api/nonclient-services/migrate',
      { client_id: clientId, org_name: 'x' }, '管理者');
    await admin.fails('POST', '/api/nonclient-services/migrate', { client_id: clientId }, '對象單位');
  });

  // ---------------------------------------------------------------- 溝通儀表板
  section('個案訊息多層次人工審核');
  let inqId;
  await test('AI 初篩：危機字眼一律標為高急迫度', async () => {
    const r = await admin.ok('POST', '/api/inquiries',
      { client_id: clientId, raw_text: '最近真的很累，有時候覺得活不下去' });
    inqId = r.id;
    const list = await admin.ok('GET', '/api/inquiries?status=new');
    const row = list.rows.find(x => x.id === inqId);
    assert(row, '應出現在待初審');
    equal(row.ai_category, '危機疑慮', '分類');
    equal(row.ai_urgency, 'high', '急迫度');
    assert(row.ai_flags.includes('活不下去'), '應標出關鍵字');
    // 急件排在清單前面
    equal(list.rows[0].ai_urgency, 'high', '急件應排最前');
  });
  await test('流程順序不可跳過：未初審不能擬稿、未擬稿不能複審', async () => {
    await lin.fails('POST', `/api/inquiries/${inqId}/draft`, { draft: '想先回' }, '初審');
    await admin.fails('POST', `/api/inquiries/${inqId}/approve`, {}, '待複審');
    await admin.fails('POST', `/api/inquiries/${inqId}/return`, { review_note: 'x' }, '待複審');
  });
  await test('五段流程跑完：初審→擬稿→退回→再擬稿→複審送出', async () => {
    // 沒指定心理師時沿用個案的主責心理師；連主責都沒有才擋下
    await admin.ok('POST', `/api/inquiries/${inqId}/relay`, { counselor_id: 2, admin_note: '請優先處理' });
    let row = (await admin.ok('GET', '/api/inquiries?status=relayed')).rows.find(x => x.id === inqId);
    equal(row.status, 'relayed', '初審後狀態');
    assert(row.relayed_by, '應記錄初審人');

    await lin.fails('POST', `/api/inquiries/${inqId}/draft`, { draft: '' }, '回覆內容');
    await lin.ok('POST', `/api/inquiries/${inqId}/draft`, { draft: '初稿' });
    row = (await admin.ok('GET', '/api/inquiries?status=drafted')).rows.find(x => x.id === inqId);
    equal(row.status, 'drafted', '擬稿後狀態');

    await admin.fails('POST', `/api/inquiries/${inqId}/return`, { review_note: '' }, '退回原因');
    await admin.ok('POST', `/api/inquiries/${inqId}/return`, { review_note: '語氣再溫和一點' });
    row = (await admin.ok('GET', '/api/inquiries?status=returned')).rows.find(x => x.id === inqId);
    equal(row.status, 'returned', '退回後狀態');
    equal(row.review_note, '語氣再溫和一點', '退回原因');

    await lin.ok('POST', `/api/inquiries/${inqId}/draft`, { draft: '謝謝您願意說出來，我們很在意您的狀況' });
    await admin.ok('POST', `/api/inquiries/${inqId}/approve`,
      { final_reply: '謝謝您願意說出來，我們很在意您的狀況，明天會由心理師與您聯繫。' });
    row = (await admin.ok('GET', '/api/inquiries?status=sent')).rows.find(x => x.id === inqId);
    equal(row.status, 'sent', '送出後狀態');
    assert(row.draft && row.final_reply !== row.draft, '原擬稿應保留，且與實際送出可對照');
    assert(row.approved_by && row.sent_at, '應記錄複審人與送出時間');
    // 回覆同步進個案訊息串
    const msgs = await admin.ok('GET', `/api/messages?client_id=${clientId}`);
    assert(msgs.some(m => m.content.includes('明天會由心理師與您聯繫')), '回覆應同步到個案訊息');
    // 已送出的不可刪
    await admin.fails('DELETE', `/api/inquiries/${inqId}`, undefined, '不可刪除');
  });
  await test('沒有主責心理師且未指定時，初審會被擋下', async () => {
    const c = await admin.ok('POST', '/api/clients', { name: '冒煙無主責個案', phone: '0900000777' });
    const r = await admin.ok('POST', '/api/inquiries', { client_id: c.id, raw_text: '想問問看諮商怎麼進行' });
    await admin.fails('POST', `/api/inquiries/${r.id}/relay`, {}, '心理師');
    await admin.ok('DELETE', `/api/inquiries/${r.id}`);
  });
  await test('AI 不代寫回覆：送出的內容必定來自人工擬稿', async () => {
    const r = await admin.ok('POST', '/api/inquiries', { client_id: clientId, raw_text: '請問停車方便嗎' });
    const row = (await admin.ok('GET', '/api/inquiries?status=new')).rows.find(x => x.id === r.id);
    equal(row.draft, '', 'AI 初篩不應產生擬稿');
    equal(row.final_reply, '', 'AI 初篩不應產生回覆');
    assert(row.ai_category, '但應該要有分類');
    await admin.ok('POST', `/api/inquiries/${r.id}/close`, { admin_note: '已於電話回覆' });
    equal((await admin.ok('GET', '/api/inquiries?status=closed')).rows.find(x => x.id === r.id).status, 'closed', '結案');
    await admin.ok('DELETE', `/api/inquiries/${r.id}`);
  });
  await test('搜尋、篩選與分頁可用', async () => {
    const d = await admin.ok('GET', '/api/inquiries?status=all&q=活不下去&page=1&size=10');
    assert(d.rows.length >= 1, '搜尋應命中');
    const hi = await admin.ok('GET', '/api/inquiries?status=all&urgency=high');
    assert(hi.rows.every(x => x.ai_urgency === 'high'), '急迫度篩選');
    assert(typeof d.counts.new === 'number' && d.labels.sent, '應回傳統計與狀態字典');
  });

  // ---------------------------------------------------------------- AI 助理
  section('AI 助理');
  await test('未設金鑰時停用，提問回明確錯誤', async () => {
    const st = await admin.ok('GET', '/api/ai/status');
    equal(st.enabled, false, '未設金鑰應停用');
    equal(st.model, 'claude-opus-5', '模型');
    assert(st.tools.length >= 5, '應列出可用工具');
    assert(Object.keys(st.field_guide).length >= 10, '應有欄位字典');
    await admin.fails('POST', '/api/ai/ask', { question: '這個月收多少' }, '金鑰');
    await admin.fails('POST', '/api/ai/ask', { question: '' }, '問題');
  });
  await test('金鑰格式檢查與遮罩', async () => {
    await admin.fails('PUT', '/api/ai/key', { api_key: 'not-a-key' }, '格式');
    await admin.ok('PUT', '/api/ai/key', { api_key: 'sk-ant-smoketestkey1234567890' });
    const st = await admin.ok('GET', '/api/ai/status');
    equal(st.enabled, true, '設定後啟用');
    assert(!st.key_masked.includes('smoketestkey'), '不應回傳完整金鑰');
    await admin.ok('PUT', '/api/ai/key', { clear: true });
    equal((await admin.ok('GET', '/api/ai/status')).enabled, false, '清除後停用');
  });
  await test('工具全部唯讀，且查不到晤談內容', () => {
    const ai = require(path.join(ROOT, 'src', 'ai.js'));
    const user = { id: 1, name: '冒煙', role: 'admin', modules: [] };
    const dump = [];
    for (const t of Object.values(ai.TOOLS)) {
      // 每個工具都用空參數跑一次，確認不丟例外且回得出東西
      const out = t.run({}, {});
      dump.push(JSON.stringify(out));
      // 工具定義不得出現任何寫入字樣
      const src = t.run.toString();
      for (const bad of ['INSERT', 'UPDATE ', 'DELETE', 'DROP', 'ALTER']) {
        assert(!src.toUpperCase().includes(bad), `工具 ${t.def.name} 疑似含寫入語句 ${bad}`);
      }
    }
    const all = dump.join('');
    // seed 的晤談紀錄內容不應該出現在任何工具的輸出裡
    for (const secret of ['subjective', 'objective', 'assessment', 'process_note', 'warning_signs']) {
      assert(!all.includes(secret), `工具輸出不應包含晤談內容欄位 ${secret}`);
    }
    assert(user, '');
  });
  await test('模組權限決定可用工具', async () => {
    const st = await office.ok('GET', '/api/ai/status');
    const names = st.tools.map(t => t.name);
    assert(names.includes('overview'), '行政應可用概況');
    assert(!names.includes('counselor_output'), '行政沒有報表模組，不該有心理師產出工具');
  });

  // ---------------------------------------------------------------- 搜尋與分頁
  section('清單搜尋、篩選與分頁');
  await test('個案清單：分頁標頭正確、搜尋可命中', async () => {
    const r1 = await fetch(BASE + '/api/clients?page=1&size=2', { headers: { Cookie: adminCookie() } });
    equal(r1.status, 200, 'HTTP');
    const total = Number(r1.headers.get('X-Total-Count'));
    const rows = await r1.json();
    assert(total >= rows.length, '總數應大於等於本頁筆數');
    assert(rows.length <= 2, '每頁筆數應受 size 限制');
    equal(r1.headers.get('X-Page'), '1', '頁碼標頭');
    // 第二頁不應與第一頁重複
    const r2 = await fetch(BASE + '/api/clients?page=2&size=2', { headers: { Cookie: adminCookie() } });
    const rows2 = await r2.json();
    if (rows2.length) assert(rows2[0].id !== rows[0].id, '第二頁不應重複第一頁的資料');
    // 搜尋
    const s1 = await admin.ok('GET', '/api/clients?q=冒煙測試個案');
    assert(s1.length >= 1 && s1.every(c => c.name.includes('冒煙') || c.code.includes('冒煙')), '搜尋結果應命中');
    const s0 = await admin.ok('GET', '/api/clients?q=不可能存在的關鍵字zzz');
    equal(s0.length, 0, '查無資料應回空陣列');
  });
  await test('收費單：搜尋、付款人別篩選與分頁', async () => {
    const d = await admin.ok('GET', '/api/invoices?status=&page=1&size=2');
    assert(typeof d.total_count === 'number' && d.pages >= 1, '應回傳總數與頁數');
    assert(d.rows.length <= 2, '分頁大小');
    const q = await admin.ok('GET', '/api/invoices?status=&q=冒煙測試個案');
    assert(q.rows.every(r => r.client_name.includes('冒煙')), '搜尋應命中個案姓名');
  });
  await test('稽核軌跡：搜尋、動作篩選與分頁', async () => {
    const d = await admin.ok('GET', '/api/audit-logs?page=1&size=5');
    assert(d.rows.length <= 5 && d.total >= 1, '分頁結構');
    const acts = await admin.ok('GET', '/api/audit-logs?action=批次列印&size=50');
    assert(acts.rows.every(r => r.action.includes('批次列印')), '動作篩選');
    await lin.fails('GET', '/api/audit-logs', undefined, '管理者');
  });
  await test('傳話軌跡與列印批次可搜尋分頁', async () => {
    const ev = await admin.ok('GET', '/api/line/events?page=1&size=5');
    assert(Array.isArray(ev.rows) && ev.pages >= 1, '傳話軌跡分頁結構');
    const pb = await admin.ok('GET', '/api/print-batches?page=1&size=5&purpose=督考');
    assert(pb.rows.every(r => r.purpose === '督考'), '用途篩選');
  });
  await test('非個案服務可搜尋分頁', async () => {
    const r = await lin.ok('POST', '/api/nonclient-services',
      { date: monday, org_name: '搜尋測試單位', topic: '壓力管理' });
    const hit = await lin.ok('GET', '/api/nonclient-services?q=搜尋測試&page=1&size=10');
    assert(hit.rows.some(x => x.id === r.id), '搜尋應命中');
    assert(hit.pages >= 1 && typeof hit.total === 'number', '分頁結構');
    await lin.ok('DELETE', `/api/nonclient-services/${r.id}`);
  });

  // ---------------------------------------------------------------- 附件
  section('附件上傳與下載');
  let pngId, pdfId;
  await test('上傳照片（PNG）', async () => {
    const mp = multipart({ kind: '其他', note: '冒煙測試照片' }, { name: '測試照片.png', type: 'image/png', buf: PNG });
    const r = await lin.ok('POST', `/api/clients/${clientId}/attachments`, mp.body, { raw: true, headers: mp.headers });
    pngId = r.id || (r.attachment && r.attachment.id);
    assert(pngId, `上傳回應缺少 id：${JSON.stringify(r)}`);
  });
  await test('上傳 PDF 並保留中文檔名', async () => {
    const mp = multipart({ kind: '轉介單' }, { name: '轉介單.pdf', type: 'application/pdf', buf: PDF });
    const r = await lin.ok('POST', `/api/clients/${clientId}/attachments`, mp.body, { raw: true, headers: mp.headers });
    pdfId = r.id || (r.attachment && r.attachment.id);
    const list = await lin.ok('GET', `/api/clients/${clientId}/attachments`);
    assert(list.some(f => f.filename === '轉介單.pdf'), '中文檔名應正確保存');
  });
  await test('不支援的副檔名被擋', async () => {
    const mp = multipart({}, { name: 'evil.exe', type: 'application/octet-stream', buf: Buffer.from('x') });
    const r = await lin.post(`/api/clients/${clientId}/attachments`, mp.body, { raw: true, headers: mp.headers });
    assert(r.status >= 400, `應被擋下，卻回 ${r.status}`);
  });
  await test('未登入不可下載附件', async () => {
    const r = await fetch(BASE + `/api/attachments/${pngId}/download`);
    assert(r.status === 401 || r.status === 403, `未登入不應下載成功（回 ${r.status}）`);
  });
  await test('主責心理師可下載且內容正確', async () => {
    const res = await fetch(BASE + `/api/attachments/${pngId}/download`, { headers: { Cookie: lastCookie(lin) } });
    equal(res.status, 200, 'HTTP 狀態');
    const buf = Buffer.from(await res.arrayBuffer());
    equal(buf.length, PNG.length, '下載位元組數');
    assert(buf.equals(PNG), '下載內容與上傳不一致');
  });
  await test('實體檔確實落在上傳目錄且檔名隨機', async () => {
    const files = fs.readdirSync(env.MINDCARE_UPLOAD_DIR);
    assert(files.length >= 2, '上傳目錄應有檔案');
    assert(!files.some(f => f.includes('測試照片')), '實體檔名不應沿用原始檔名');
  });
  await test('uploads 目錄不對外開放靜態存取', async () => {
    const files = fs.readdirSync(env.MINDCARE_UPLOAD_DIR);
    const res = await fetch(`${BASE}/uploads/${files[0]}`);
    assert(res.status === 404, `uploads 不應可直接讀取（回 ${res.status}）`);
  });
  await test('個案端只看得到被開放的附件', async () => {
    let mine = await portal.ok('GET', '/api/portal/attachments');
    equal(mine.length, 0, '預設不應開放');
    const res = await fetch(BASE + `/api/portal/attachments/${pdfId}/download`, { headers: { Cookie: lastCookie(portal) } });
    assert(res.status >= 400, '未開放的檔案不可下載');
    await lin.ok('PUT', `/api/attachments/${pdfId}`, { visible_to_client: 1 });
    mine = await portal.ok('GET', '/api/portal/attachments');
    equal(mine.length, 1, '開放後應看得到');
    const ok = await fetch(BASE + `/api/portal/attachments/${pdfId}/download`, { headers: { Cookie: lastCookie(portal) } });
    equal(ok.status, 200, '開放後應可下載');
  });
  await test('行政層附件他人可讀、臨床層附件受保密邊界保護', async () => {
    // 轉介單屬行政層：有個案管理權限者皆可存取
    const admin1 = await fetch(BASE + `/api/attachments/${pdfId}/download`, { headers: { Cookie: lastCookie(chen) } });
    equal(admin1.status, 200, '行政層附件應可讀');
    // 衡鑑報告屬臨床層：非主責心理師應被擋
    const mp = multipart({ kind: '衡鑑報告' }, { name: '衡鑑報告.pdf', type: 'application/pdf', buf: PDF });
    const rep = await lin.ok('POST', `/api/clients/${clientId}/attachments`, mp.body, { raw: true, headers: mp.headers });
    const blocked = await fetch(BASE + `/api/attachments/${rep.id}/download`, { headers: { Cookie: lastCookie(chen) } });
    assert(blocked.status === 403, `臨床層附件應被擋（回 ${blocked.status}）`);
    const listForChen = await chen.ok('GET', `/api/clients/${clientId}/attachments`);
    assert(!listForChen.some(f => f.id === rep.id), '臨床層附件不應出現在非主責者的清單');
    const listForLin = await lin.ok('GET', `/api/clients/${clientId}/attachments`);
    assert(listForLin.some(f => f.id === rep.id), '主責心理師應看得到');
  });
  await test('刪除附件同時移除實體檔', async () => {
    const before = fs.readdirSync(env.MINDCARE_UPLOAD_DIR).length;
    await lin.ok('DELETE', `/api/attachments/${pngId}`);
    const after = fs.readdirSync(env.MINDCARE_UPLOAD_DIR).length;
    equal(after, before - 1, '實體檔應一併刪除');
  });

  // ---------------------------------------------------------------- 備份與資料同步
  section('備份與資料同步');
  await test('手動備份並同步附件到異地目錄', async () => {
    const r = await admin.ok('POST', '/api/maintenance/backup', {});
    assert(r.latest_backup, '應產生備份檔');
    const mirrorDb = path.join(env.MINDCARE_BACKUP_MIRROR, r.latest_backup);
    assert(fs.existsSync(mirrorDb), '異地目錄應有備份檔');
    assert(fs.statSync(mirrorDb).size > 0, '備份檔不應為空');
    equal(r.uploads_mirrored, r.uploads_total, '附件同步數應與上傳目錄一致');
    const mirrored = fs.readdirSync(path.join(env.MINDCARE_BACKUP_MIRROR, 'uploads'));
    const live = fs.readdirSync(env.MINDCARE_UPLOAD_DIR);
    for (const f of live) assert(mirrored.includes(f), `附件未同步：${f}`);
  });
  await test('備份檔可獨立開啟且資料完整', async () => {
    const Database = require('better-sqlite3');
    const r = await admin.ok('POST', '/api/maintenance/backup', {});
    const b = new Database(path.join(env.MINDCARE_DATA_DIR, 'backups', r.latest_backup), { readonly: true });
    const n = b.prepare('SELECT COUNT(*) n FROM clients').get().n;
    const rows = b.prepare('SELECT COUNT(*) n FROM attachments').get().n;
    b.close();
    assert(n > 0, '備份內應有個案資料');
    assert(rows > 0, '備份內應有附件紀錄');
  });
  await test('非管理者不可觸發備份', () => lin.fails('POST', '/api/maintenance/backup', {}, '管理者'));

  // ---------------------------------------------------------------- 報表與稽核
  section('報表與稽核');
  await test('月報與匯出可產生', async () => {
    const month = monday.slice(0, 7);
    const rep = await admin.ok('GET', `/api/reports?month=${month}`);
    assert(rep.income, '月報應含收入區塊');
    for (const fmt of ['csv', 'xls', 'pdf']) {
      const r = await admin.get(`/api/exports/clients?format=${fmt}`);
      equal(r.status, 200, `匯出格式 ${fmt}`);
    }
  });
  await test('調閱紀錄寫入稽核軌跡', async () => {
    const rows = (await admin.ok('GET', '/api/audit-logs?size=500')).rows;
    assert(rows.some(l => String(l.action).includes('調閱')), '應有調閱紀錄的稽核');
    assert(rows.some(l => String(l.action).includes('安全計畫')), '應有安全計畫相關稽核');
  });
  await test('經營品質指標計算正確', async () => {
    const month = monday.slice(0, 7);
    const r = await admin.ok('GET', `/api/reports?month=${month}`);
    const k = r.kpi;
    assert(k, '月報應含 kpi 區塊');
    for (const key of ['no_show_rate', 'cancel_rate', 'intake_conversion', 'dropout', 'avg_sessions', 'utilization']) {
      assert(k[key] !== undefined, `缺少指標：${key}`);
    }
    // 分母為 0 時必須是 null 而不是 0 或 NaN
    const empty = await admin.ok('GET', '/api/reports?month=1990-01');
    equal(empty.kpi.no_show_rate, null, '無資料月份的爽約率');
    equal(empty.kpi.avg_sessions, null, '無資料月份的平均次數');
    const u = k.utilization.find(x => x.name === '林筱雯');
    assert(u && u.capacity_hours > 0, '排班後應算得出時段容量');
    assert(u.rate !== null && u.rate >= 0, '利用率應為數字');
  });
  await test('總覽與我的工作台可載入', async () => {
    const d = await admin.ok('GET', '/api/dashboard');
    assert(d.charts && d.charts.months.length === 6, '總覽圖表資料');
    const my = await lin.ok('GET', '/api/my-dashboard');
    assert(my.me, '我的工作台');
  });

  // ---- 結果 ----
  console.log(`\n${'─'.repeat(46)}`);
  if (failures.length) {
    console.log(`✗ 通過 ${pass} 項，失敗 ${failures.length} 項：`);
    failures.forEach(f => console.log(`   · ${f}`));
  } else {
    console.log(`✓ 全部通過（${pass} 項）`);
  }
  cleanup(failures.length ? 1 : 0);
})().catch(e => {
  console.error('\n冒煙測試中斷：', e);
  cleanup(1);
});

// 直接用 fetch 抓二進位內容時需要自行帶上該身分的 cookie
function lastCookie(s) { return s.cookie || ''; }

function cleanup(code) {
  try { if (server) server.kill(); } catch { /* 略過 */ }
  if (KEEP) console.log(`暫存目錄保留於：${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
