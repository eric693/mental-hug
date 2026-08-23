// UI 共用元件：跳出視窗、提示、表格、表單欄位
const UI = {
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  nl2br(s) { return UI.esc(s).replace(/\n/g, '<br>'); },

  toast(msg, isError) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show' + (isError ? ' error' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = ''; }, isError ? 3600 : 2200);
  },
  err(e) { UI.toast(e && e.message ? e.message : String(e), true); },

  // 開啟 Modal；onSubmit 回傳 false 可阻止關閉
  modal({ title, body, wide, submitText = '儲存', onSubmit, onOpen, hideFooter }) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal${wide ? ' wide' : ''}">
        <div class="modal-head"><h3>${UI.esc(title)}</h3><button class="close" type="button">&times;</button></div>
        <div class="modal-body"></div>
        ${hideFooter ? '' : `<div class="modal-foot">
          <button class="btn secondary" data-act="cancel" type="button">取消</button>
          <button class="btn" data-act="ok" type="button">${UI.esc(submitText)}</button>
        </div>`}
      </div>`;
    const bodyEl = mask.querySelector('.modal-body');
    if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
    const close = () => mask.remove();
    mask.querySelector('.close').onclick = close;
    mask.addEventListener('mousedown', e => { if (e.target === mask) close(); });
    if (!hideFooter) {
      mask.querySelector('[data-act="cancel"]').onclick = close;
      mask.querySelector('[data-act="ok"]').onclick = async () => {
        const btn = mask.querySelector('[data-act="ok"]');
        btn.disabled = true;
        try {
          const r = onSubmit ? await onSubmit(bodyEl, close) : true;
          if (r !== false) close();
        } catch (e) { UI.err(e); }
        btn.disabled = false;
      };
    }
    document.body.appendChild(mask);
    if (onOpen) onOpen(bodyEl, close);
    return { close, body: bodyEl };
  },

  confirm(msg) {
    return new Promise(resolve => {
      const m = UI.modal({
        title: '確認操作', hideFooter: true,
        body: `<p style="font-size:15px">${UI.esc(msg)}</p>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
            <button class="btn secondary" data-c="no" type="button">取消</button>
            <button class="btn" data-c="yes" type="button">確定</button>
          </div>`
      });
      m.body.querySelector('[data-c=no]').onclick = () => { m.close(); resolve(false); };
      m.body.querySelector('[data-c=yes]').onclick = () => { m.close(); resolve(true); };
    });
  },

  input(name, label, opts = {}) {
    const { type = 'text', value = '', placeholder = '', required = false, full = false, step, min, max } = opts;
    return `<div class="form-row${full ? ' full' : ''}">
      <label>${UI.esc(label)}${required ? ' *' : ''}</label>
      <input name="${name}" type="${type}" value="${UI.esc(value)}" placeholder="${UI.esc(placeholder)}"${step ? ` step="${step}"` : ''}${min !== undefined ? ` min="${min}"` : ''}${max !== undefined ? ` max="${max}"` : ''}>
    </div>`;
  },
  select(name, label, options, opts = {}) {
    const { value = '', full = false } = opts;
    const inner = options.map(o => {
      const [v, t] = Array.isArray(o) ? o : [o, o];
      return `<option value="${UI.esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${UI.esc(t)}</option>`;
    }).join('');
    return `<div class="form-row${full ? ' full' : ''}"><label>${UI.esc(label)}</label><select name="${name}">${inner}</select></div>`;
  },
  inputList(name, label, options, opts = {}) {
    const { value = '', placeholder = '', full = false } = opts;
    const listId = `dl-${name}-${Math.random().toString(36).slice(2, 7)}`;
    return `<div class="form-row${full ? ' full' : ''}"><label>${UI.esc(label)}</label>
      <input name="${name}" list="${listId}" value="${UI.esc(value)}" placeholder="${UI.esc(placeholder)}">
      <datalist id="${listId}">${options.map(o => `<option value="${UI.esc(o)}"></option>`).join('')}</datalist></div>`;
  },
  textarea(name, label, opts = {}) {
    const { value = '', full = true, placeholder = '', rows } = opts;
    return `<div class="form-row${full ? ' full' : ''}"><label>${UI.esc(label)}</label>
      <textarea name="${name}"${rows ? ` style="min-height:${rows * 22}px"` : ''} placeholder="${UI.esc(placeholder)}">${UI.esc(value)}</textarea></div>`;
  },
  checkbox(name, label, checked) {
    return `<div class="form-row full"><label style="display:flex;gap:8px;align-items:center;font-size:14px;color:var(--text)">
      <input name="${name}" type="checkbox"${checked ? ' checked' : ''} style="width:auto">${UI.esc(label)}</label></div>`;
  },
  formData(el) {
    const out = {};
    el.querySelectorAll('input[name], select[name], textarea[name]').forEach(i => {
      out[i.name] = i.type === 'checkbox' ? i.checked : i.value.trim();
    });
    return out;
  },

  // 分頁列：資料量大的清單共用。onGo(page) 由呼叫端重新查詢。
  // 只有一頁時不顯示，避免小清單上多出無意義的元件。
  pager(state, onGo) {
    const { page = 1, pages = 1, total = 0, size = 50 } = state || {};
    const id = 'pg-' + Math.random().toString(36).slice(2, 7);
    setTimeout(() => {
      const box = document.getElementById(id);
      if (!box) return;
      box.querySelectorAll('[data-p]').forEach(b => { b.onclick = () => onGo(Number(b.dataset.p)); });
      const jump = box.querySelector('.pg-jump');
      if (jump) jump.onchange = () => {
        const v = Math.min(Math.max(Number(jump.value) || 1, 1), pages);
        onGo(v);
      };
    }, 0);
    if (pages <= 1) {
      return `<div class="pager" id="${id}"><span class="pg-info">共 ${total} 筆</span></div>`;
    }
    const btn = (p, label, disabled) => `<button class="btn tiny secondary" data-p="${p}"${disabled ? ' disabled' : ''}>${label}</button>`;
    return `<div class="pager" id="${id}">
      <span class="pg-info">共 ${total} 筆，第 ${page}／${pages} 頁（每頁 ${size} 筆）</span>
      <div class="spacer"></div>
      ${btn(1, '第一頁', page <= 1)}
      ${btn(page - 1, '上一頁', page <= 1)}
      <input class="pg-jump" type="number" min="1" max="${pages}" value="${page}" style="width:64px">
      ${btn(page + 1, '下一頁', page >= pages)}
      ${btn(pages, '最後一頁', page >= pages)}
    </div>`;
  },

  // 搜尋框：輸入停 300ms 才查，避免每打一個字就打一次 API
  searchBox(id, placeholder, onSearch) {
    setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.oninput = () => { clearTimeout(el._t); el._t = setTimeout(() => onSearch(el.value.trim()), 300); };
    }, 0);
    return `<input id="${id}" class="search-box" placeholder="${UI.esc(placeholder)}">`;
  },

  table(headers, rowsHtml, emptyMsg = '目前沒有資料') {
    if (!rowsHtml.length) return `<div class="empty">${UI.esc(emptyMsg)}</div>`;
    return `<div class="table-wrap"><table class="list">
      <thead><tr>${headers.map(h => `<th>${UI.esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rowsHtml.join('')}</tbody></table></div>`;
  },

  tag(text, cls = '') { return `<span class="tag ${cls}">${UI.esc(text)}</span>`; },

  today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  thisMonth() { return UI.today().slice(0, 7); },
  ageYears(birthDate) {
    if (!birthDate) return null;
    const b = new Date(birthDate + 'T00:00:00'), t = new Date();
    if (isNaN(b)) return null;
    let y = t.getFullYear() - b.getFullYear();
    const m = t.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < b.getDate())) y -= 1;
    return y;
  },
  fmtMoney(n) { return 'NT$ ' + Number(n || 0).toLocaleString('zh-TW'); },
  fmtSize(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  },
  // PDF 與圖片可直接在瀏覽器開啟預覽，其餘一律下載
  isPreviewable(mime) { return /^image\//.test(mime || '') || mime === 'application/pdf'; },
  weekdayName(dateStr) { return ['日', '一', '二', '三', '四', '五', '六'][new Date(dateStr + 'T00:00:00').getDay()]; },

  // 量表分數趨勢折線圖（純 SVG，不引外部套件）。
  // cuts 為量表切分點 [[下限, 上限, 判讀]]，畫成水平參考線，讓分數變化直接對照嚴重度級距。
  trendChart(rows, cuts = [], opts = {}) {
    if (!rows || rows.length < 2) return '';
    const W = 640, H = 220, padL = 34, padR = 12, padT = 12, padB = 34;
    const max = Math.max(cuts.length ? cuts[cuts.length - 1][1] : 0, ...rows.map(r => r.total)) || 1;
    const x = i => padL + (rows.length === 1 ? 0 : i * (W - padL - padR) / (rows.length - 1));
    const y = v => padT + (H - padT - padB) * (1 - v / max);
    // 級距分隔線：取每個切分點的下限（0 除外）
    const lines = cuts.filter(c => c[0] > 0).map(c => `
      <line x1="${padL}" y1="${y(c[0]).toFixed(1)}" x2="${W - padR}" y2="${y(c[0]).toFixed(1)}"
        stroke="#d7dee4" stroke-width="1" stroke-dasharray="4 4"></line>
      <text x="${W - padR}" y="${(y(c[0]) - 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#8b97a2">${UI.esc(c[2])} ${c[0]}+</text>`).join('');
    const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.total).toFixed(1)}`).join(' ');
    const dots = rows.map((r, i) => `
      <circle cx="${x(i).toFixed(1)}" cy="${y(r.total).toFixed(1)}" r="${r.alert ? 5 : 4}"
        fill="${r.alert ? '#d9534f' : (opts.color || '#4e5556')}"></circle>
      <text x="${x(i).toFixed(1)}" y="${(y(r.total) - 9).toFixed(1)}" text-anchor="middle" font-size="11" fill="#3b4a55">${r.total}</text>
      <text x="${x(i).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="10" fill="#8b97a2">${UI.esc(r.date.slice(5))}</text>`).join('');
    return `<div class="table-wrap"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:420px;height:auto" role="img">
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#c9d2d9"></line>
      <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#c9d2d9"></line>
      <text x="${padL - 6}" y="${padT + 4}" text-anchor="end" font-size="10" fill="#8b97a2">${max}</text>
      <text x="${padL - 6}" y="${H - padB}" text-anchor="end" font-size="10" fill="#8b97a2">0</text>
      ${lines}
      <polyline points="${pts}" fill="none" stroke="${opts.color || '#4e5556'}" stroke-width="2"></polyline>
      ${dots}
    </svg></div>`;
  },

  // 長條圖（純 SVG，不引外部套件）。單一數列，故不需圖例；
  // 每根長條直接標數值，滑鼠移上去顯示完整說明（<title> 由瀏覽器代為浮動顯示）。
  // rows: [{ label, value, note }]；opts: { format, color, height, horizontal }
  barChart(rows, opts = {}) {
    const list = (rows || []).filter(r => r);
    if (!list.length) return `<div class="empty">${UI.esc(opts.empty || '目前沒有資料')}</div>`;
    const fmt = opts.format || (v => String(v));
    const color = opts.color || '#4e5556';
    const max = Math.max(1, ...list.map(r => Number(r.value) || 0));

    if (opts.horizontal) {
      // 橫式：類別名稱較長時用（例如心理師姓名）
      const rowH = 26, W = 640, labelW = opts.labelWidth || 96, padR = 64;
      const H = list.length * rowH + 8;
      const bars = list.map((r, i) => {
        const v = Number(r.value) || 0;
        const w = Math.max((W - labelW - padR) * (v / max), v > 0 ? 2 : 0);
        const y = i * rowH + 4;
        return `<g><title>${UI.esc(r.label)}：${UI.esc(fmt(v))}${r.note ? '（' + UI.esc(r.note) + '）' : ''}</title>
          <text x="${labelW - 8}" y="${y + 14}" text-anchor="end" font-size="12" fill="#3b4a55">${UI.esc(r.label)}</text>
          <rect x="${labelW}" y="${y + 3}" width="${w.toFixed(1)}" height="15" rx="4" fill="${color}"></rect>
          <text x="${labelW + w + 6}" y="${y + 15}" font-size="11.5" fill="#3b4a55">${UI.esc(fmt(v))}</text></g>`;
      }).join('');
      return `<div class="table-wrap"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:320px;height:auto"
        role="img" aria-label="${UI.esc(opts.title || '長條圖')}">${bars}</svg></div>`;
    }

    // 直式：時間序列用
    const W = 640, H = opts.height || 200, padL = 8, padR = 8, padT = 22, padB = 30;
    const slot = (W - padL - padR) / list.length;
    const barW = Math.min(slot - 10, 54);
    const bars = list.map((r, i) => {
      const v = Number(r.value) || 0;
      const h = (H - padT - padB) * (v / max);
      const x = padL + i * slot + (slot - barW) / 2;
      const y = H - padB - h;
      return `<g><title>${UI.esc(r.label)}：${UI.esc(fmt(v))}${r.note ? '（' + UI.esc(r.note) + '）' : ''}</title>
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, v > 0 ? 2 : 0).toFixed(1)}"
          rx="4" fill="${color}"></rect>
        <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="11.5" fill="#3b4a55">${UI.esc(fmt(v))}</text>
        <text x="${(x + barW / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#8b97a2">${UI.esc(r.label)}</text></g>`;
    }).join('');
    return `<div class="table-wrap"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:360px;height:auto"
      role="img" aria-label="${UI.esc(opts.title || '長條圖')}">
      <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#dfe6ec"></line>
      ${bars}</svg></div>`;
  },

  // 分頁切換列
  tabs(el, items, onSwitch) {
    el.innerHTML = `<div class="section-tabs">${items.map((t, i) =>
      `<button data-tab="${t.key}"${i === 0 ? ' class="active"' : ''}>${UI.esc(t.label)}</button>`).join('')}</div>
      <div id="tab-body"></div>`;
    const body = el.querySelector('#tab-body');
    const go = key => {
      el.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === key));
      body.innerHTML = '<div class="empty">載入中...</div>';
      Promise.resolve(onSwitch(key, body)).catch(e => { body.innerHTML = `<div class="empty">${UI.esc(e.message)}</div>`; });
    };
    el.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => go(b.dataset.tab); });
    go(items[0].key);
    return { go };
  },

  // 手寫簽名板：同意書簽署用
  signaturePad(canvas) {
    canvas.width = canvas.offsetWidth * 2;
    canvas.height = (canvas.offsetHeight || 160) * 2;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#123';
    let drawing = false, drawn = false;
    const pos = e => {
      const p = e.touches ? e.touches[0] : e;
      const r = canvas.getBoundingClientRect();
      return [(p.clientX - r.left) * (canvas.width / r.width), (p.clientY - r.top) * (canvas.height / r.height)];
    };
    const start = e => { drawing = true; drawn = true; ctx.beginPath(); ctx.moveTo(...pos(e)); e.preventDefault(); };
    const move = e => { if (drawing) { ctx.lineTo(...pos(e)); ctx.stroke(); e.preventDefault(); } };
    canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', () => { drawing = false; });
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', () => { drawing = false; });
    return {
      drawn: () => drawn,
      clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; },
      dataUrl: () => (drawn ? canvas.toDataURL('image/png') : '')
    };
  }
};

// 中文對照
const TW = {
  role: { admin: '管理者', counselor: '諮商師', supervisor: '督導', staff: '行政' },
  client_status: { intake: '初談', active: '進行中', paused: '暫停', closed: '已結案' },
  risk_level: { low: '低', medium: '中', high: '高' },
  appt_type: { intake: '初談', individual: '個別諮商', couple: '伴侶諮商', family: '家族諮商', group: '團體諮商', assessment: '心理衡鑑' },
  appt_mode: { onsite: '到所', online: '視訊' },
  appt_status: { booked: '已預約', arrived: '已報到', done: '已完成', cancelled: '已取消', no_show: '未到' },
  risk_flag: { none: '無', ideation: '有意念', plan: '有計畫', attempt: '有行為' },
  record_type: {
    individual: '個案晤談', group: '團體', assessment: '心理衡鑑',
    outreach_talk: '外派演講', lecture: '講座課程', other: '其他非個案服務'
  },
  severity: { low: '低', medium: '中', high: '高' },
  event_status: { open: '追蹤中', closed: '已結案' },
  plan_status: { active: '執行中', achieved: '目標達成', revised: '已修訂', closed: '已結束' },
  sup_type: { individual: '個別督導', group: '團體督導', peer: '同儕督導' },
  inv_status: { unpaid: '未收款', paid: '已收款', void: '已作廢', refunded: '已退費' },
  pkg_status: { active: '使用中', used_up: '已用畢', expired: '已過期', refunded: '已退費' },
  gender: { male: '男', female: '女', other: '其他' },
  signer_role: { client: '本人', guardian: '法定代理人' },
  source_kind: { staff: '櫃檯', portal: '個案端' },
  intake_status: { new: '待處理', waiting: '候補中', assigned: '已派案', converted: '已建檔', closed: '未成案' },
  group_status: { open: '招募中', running: '進行中', done: '已結束' },
  gs_status: { planned: '待進行', done: '已完成', cancelled: '已取消' },
  settle_status: { draft: '草稿', sent: '已請款', paid: '已入帳' }
};

// 狀態對應的標籤色
const TAGCLS = {
  appt_status: { booked: 'primary', arrived: 'warn', done: 'ok', cancelled: '', no_show: 'danger' },
  risk_level: { low: 'ok', medium: 'warn', high: 'danger' },
  client_status: { intake: 'warn', active: 'primary', paused: '', closed: '' },
  inv_status: { unpaid: 'warn', paid: 'ok', void: '', refunded: 'danger' },
  risk_flag: { none: 'ok', ideation: 'warn', plan: 'danger', attempt: 'danger' }
};
function stateTag(kind, value) {
  return UI.tag((TW[kind] && TW[kind][value]) || value || '-', (TAGCLS[kind] && TAGCLS[kind][value]) || '');
}
