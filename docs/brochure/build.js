// 產生 擁抱心理 系統介紹 PDF：QR 內嵌成 data URI，再用 playwright 的 chromium --print-to-pdf 輸出
const fs = require('fs');
const { execFileSync } = require('child_process');
const QRCode = require('qrcode');

const DIR = __dirname;
const CHROME = '/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const OUT = DIR + '/mental-hug-intro.pdf';

(async () => {
  const opts = { margin: 1, width: 240, color: { dark: '#4e5556', light: '#ffffff' } };
  const qrStaff = await QRCode.toDataURL('https://mental-hug.crownai.ink/', opts);
  const qrClient = await QRCode.toDataURL('https://mental-hug.crownai.ink/portal.html', opts);

  let html = fs.readFileSync(DIR + '/brochure.html', 'utf8');
  html = html.replace('{{QR_STAFF}}', qrStaff).replace('{{QR_CLIENT}}', qrClient);
  fs.writeFileSync(DIR + '/build.html', html);

  execFileSync(CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu',
    '--no-pdf-header-footer',
    '--print-to-pdf=' + OUT,
    '--virtual-time-budget=8000',
    'file://' + DIR + '/build.html'
  ], { stdio: 'inherit' });

  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`PDF 產出：${OUT} (${kb} KB)`);
})();
