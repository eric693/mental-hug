// 心理師名冊匯入：從 CSV／JSON 批次建立心理師帳號並設定駐點。
//
//   node scripts/import-therapists.js therapists.csv            # 預覽，不寫入
//   node scripts/import-therapists.js therapists.csv --commit   # 實際建立
//
// CSV 欄位（第一列為標題，順序不拘）：
//   name        姓名（必填）
//   username    登入帳號（留空則以姓名的拼音／英數欄位產生，重複時自動加序號）
//   license     證照類別：諮商心理師／臨床心理師（預設諮商心理師）
//   sites       駐點，以 / 或 、分隔，比對據點的名稱或簡稱（例：內湖/博愛）
//   title       職稱（如 督導、所長）
//   specialty   專長／諮商主題，以 、分隔
//   role        角色：counselor（預設）／supervisor
//
// 已存在同名或同帳號者一律略過不覆蓋，並在報表列出，避免重跑時把既有帳號改壞。
// 密碼由系統隨機產生並印在畫面上（只印這一次），請所方轉交後要求本人自行更改。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../src/db');
const { ROLE_DEFAULT_MODULES } = require('../src/auth');

const file = process.argv[2];
const COMMIT = process.argv.includes('--commit');
if (!file) {
  console.error('用法：node scripts/import-therapists.js <名冊.csv|.json> [--commit]');
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  return rows.filter(r => r.some(c => c.trim()))
    .map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

const raw = fs.readFileSync(path.resolve(file), 'utf8').replace(/^﻿/, '');
const records = file.endsWith('.json') ? JSON.parse(raw) : parseCsv(raw);

const sites = db.prepare('SELECT id, name, short_name FROM sites WHERE active = 1').all();
function siteIdsOf(text) {
  const parts = String(text || '').split(/[/、,，]/).map(s => s.trim()).filter(Boolean);
  const ids = [];
  for (const p of parts) {
    const hit = sites.find(s => s.name === p || s.short_name === p
      || s.name.startsWith(p) || (s.short_name && p.startsWith(s.short_name)));
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return { ids, unknown: parts.filter(p => !sites.some(s => s.name === p || s.short_name === p || s.name.startsWith(p))) };
}

// 帳號：優先用指定值，其次用姓名的英數部分，都沒有就用 psy + 流水號
function usernameFor(rec, used, seq) {
  let base = String(rec.username || '').trim().toLowerCase();
  if (!base) base = String(rec.slug || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!base) base = 'psy' + String(seq).padStart(3, '0');
  base = base.replace(/[^a-z0-9_.-]/g, '');
  let name = base, n = 1;
  while (used.has(name) || db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) name = `${base}${++n}`;
  used.add(name);
  return name;
}

const used = new Set();
const plan = [], skipped = [];
records.forEach((rec, idx) => {
  const name = String(rec.name || '').trim();
  if (!name) { skipped.push({ name: '(空白)', why: '缺姓名' }); return; }
  const existing = db.prepare('SELECT id, username FROM users WHERE name = ?').get(name);
  if (existing) { skipped.push({ name, why: `已有同名帳號 ${existing.username}` }); return; }
  const { ids, unknown } = siteIdsOf(rec.sites);
  const license = String(rec.license || '').includes('臨床') ? '臨床心理師' : '諮商心理師';
  plan.push({
    name,
    username: usernameFor(rec, used, idx + 1),
    password: crypto.randomBytes(6).toString('base64url'),
    role: rec.role === 'supervisor' ? 'supervisor' : 'counselor',
    license_type: license,
    title: String(rec.title || '').trim(),
    specialty: String(rec.specialty || '').trim(),
    site_ids: ids,
    unknown_sites: unknown
  });
});

const w = (s, n) => String(s).padEnd(n - [...String(s)].filter(c => c.charCodeAt(0) > 255).length);
console.log(`\n讀入 ${records.length} 筆，可建立 ${plan.length} 筆，略過 ${skipped.length} 筆\n`);
console.log(w('姓名', 14) + w('帳號', 18) + w('證照', 12) + w('職稱', 10) + '駐點');
for (const p of plan) {
  const names = p.site_ids.map(id => (sites.find(s => s.id === id) || {}).short_name
    || (sites.find(s => s.id === id) || {}).name).join('/');
  console.log(w(p.name, 14) + w(p.username, 18) + w(p.license_type, 12) + w(p.title || '-', 10)
    + (names || '（未指定）') + (p.unknown_sites.length ? `　⚠ 無法對應：${p.unknown_sites.join('/')}` : ''));
}
if (skipped.length) {
  console.log('\n略過：');
  for (const s of skipped) console.log(`  · ${s.name}：${s.why}`);
}

if (!COMMIT) {
  console.log('\n（預覽模式，未寫入任何資料。確認無誤後加上 --commit 實際建立）');
  process.exit(0);
}

const insUser = db.prepare(`INSERT INTO users (username, password_hash, role, permissions, name, title, license_type, specialty)
  VALUES (?,?,?,?,?,?,?,?)`);
const insSite = db.prepare('INSERT OR IGNORE INTO user_sites (user_id, site_id) VALUES (?,?)');
const tx = db.transaction(() => {
  for (const p of plan) {
    const perms = JSON.stringify(ROLE_DEFAULT_MODULES[p.role] || []);
    const info = insUser.run(p.username, bcrypt.hashSync(p.password, 10), p.role, perms,
      p.name, p.title, p.license_type, p.specialty);
    for (const sid of p.site_ids) insSite.run(info.lastInsertRowid, sid);
  }
});
tx();
db.prepare("INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, target, detail) VALUES ('system', NULL, '名冊匯入', '批次建立心理師帳號', '', ?)")
  .run(String(plan.length));

console.log('\n已建立。以下密碼只顯示這一次，請轉交本人後要求自行更改：\n');
console.log(w('姓名', 14) + w('帳號', 18) + '初始密碼');
for (const p of plan) console.log(w(p.name, 14) + w(p.username, 18) + p.password);
