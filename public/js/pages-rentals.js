// 場地租借（M4）：租用人主檔、租借預約、月結對帳單、空間佔用檢視
//
// 租借與諮商共用房間但不是諮商：這裡的資料不會進個案系統，也不算進服務量。
// 唯一的交集是「同一個時段不能被佔兩次」——衝突檢查兩邊都做。

function renterForm(r) {
  const d = r || { kind: 'person', rate_type: 'hourly', hourly_rate: 800 };
  return `<div class="form-grid">
      ${UI.select('kind', '類型', [['person', '個人'], ['company', '法人／機構']], { value: d.kind })}
      ${UI.input('name', '名稱', { value: d.name || '', required: true })}
      ${UI.input('tax_id', '統一編號／身分證號', { value: d.tax_id || '' })}
      ${UI.input('contact', '聯絡人', { value: d.contact || '' })}
      ${UI.input('phone', '電話', { value: d.phone || '' })}
      ${UI.input('email', 'Email', { value: d.email || '' })}
      ${UI.input('address', '地址', { value: d.address || '', full: true })}
      ${UI.input('contract_no', '合約編號', { value: d.contract_no || '' })}
      ${UI.input('contract_start', '合約起日', { type: 'date', value: d.contract_start || '' })}
      ${UI.input('contract_end', '合約迄日', { type: 'date', value: d.contract_end || '' })}
      ${UI.select('rate_type', '費率方式', [['hourly', '時租'], ['package', '方案']], { value: d.rate_type })}
      ${UI.input('hourly_rate', '時租費率（元／小時）', { type: 'number', value: d.hourly_rate || 0 })}
      ${UI.textarea('package_note', '方案內容（例如每月 20 小時 12,000 元）', { value: d.package_note || '' })}
      ${UI.textarea('note', '備註', { value: d.note || '' })}
      ${r ? UI.checkbox('active', '啟用中', !!d.active) : ''}
    </div>
    <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
      合約起訖日會在排租借時檢核：超出合約期間的時段不讓排，避免月結算到沒有合約的租借。</div>`;
}

App.page('rentals', {
  title: '場地租借',
  sub: '租用人、租借時段與月結；不進個案系統、不計入諮商統計',
  module: 'billing',
  async render(el) {
    let page = 1;
    const draw = async () => {
      const [renters, bookings] = await Promise.all([
        GET('/renters?size=300'),
        GET(`/room-bookings?${new URLSearchParams({
          from: el.querySelector('#from').value, to: el.querySelector('#to').value,
          q: el.querySelector('#rq').value.trim(), page, size: 50
        })}`)
      ]);
      el.querySelector('#body').innerHTML = `
        <div class="card"><h3>租借時段</h3>
          ${UI.table(['日期', '時間', '空間', '租用人', '用途', '時數', '費率', '金額', '狀態', ''],
    bookings.rows.map(b => `<tr>
            <td style="white-space:nowrap">${b.date}</td>
            <td style="white-space:nowrap">${b.start_time}-${b.end_time}</td>
            <td>${UI.esc(b.room_name)}${b.site_name ? `<div style="font-size:12px;color:var(--muted)">${UI.esc(b.site_name)}</div>` : ''}</td>
            <td>${UI.esc(b.renter_name)}${b.renter_kind === 'company' ? UI.tag('法人', '') : ''}</td>
            <td class="wrap narrow">${UI.esc(b.purpose || '-')}</td>
            <td>${b.hours}</td>
            <td>${b.rate ? UI.fmtMoney(b.rate) : '方案'}</td>
            <td>${UI.fmtMoney(b.amount)}</td>
            <td>${b.settled ? UI.tag('已結算', 'ok')
    : b.status === 'cancelled' ? UI.tag('已取消', '') : UI.tag('待結算', 'warn')}</td>
            <td style="white-space:nowrap">
              ${b.settled ? '' : `<button class="btn tiny secondary" data-e="${b.id}">編輯</button>
                <button class="btn tiny danger" data-d="${b.id}">刪除</button>`}</td></tr>`),
    '此期間沒有租借紀錄')}
          ${UI.pager(bookings, p => { page = p; draw(); })}
        </div>
        <div class="card"><h3>租用人（${renters.total}）</h3>
          ${UI.table(['名稱', '類型', '統編', '聯絡', '合約', '費率', '租借次數', '未結金額', '狀態', ''],
    renters.rows.map(r => `<tr>
            <td><strong>${UI.esc(r.name)}</strong></td>
            <td>${r.kind === 'company' ? '法人' : '個人'}</td>
            <td>${UI.esc(r.tax_id || '-')}</td>
            <td>${UI.esc(r.contact || '')}${r.phone ? `<div style="font-size:12px;color:var(--muted)">${UI.esc(r.phone)}</div>` : ''}</td>
            <td style="font-size:12.5px">${r.contract_start || '不限'} ~ ${r.contract_end || '不限'}
              ${r.contract_no ? `<div style="color:var(--muted)">${UI.esc(r.contract_no)}</div>` : ''}</td>
            <td>${r.rate_type === 'package' ? '方案' : UI.fmtMoney(r.hourly_rate) + '／時'}</td>
            <td>${r.bookings}</td>
            <td>${r.unsettled ? `<span style="color:var(--warn)">${UI.fmtMoney(r.unsettled)}</span>` : '-'}</td>
            <td>${r.active ? UI.tag('啟用', 'ok') : UI.tag('停用')}</td>
            <td style="white-space:nowrap">
              <button class="btn tiny secondary" data-re="${r.id}">編輯</button>
              <button class="btn tiny" data-st="${r.id}">對帳單</button>
              <button class="btn tiny danger" data-rd="${r.id}">刪除</button></td></tr>`), '尚無租用人')}
        </div>`;

      el.querySelectorAll('[data-e]').forEach(b => {
        const row = bookings.rows.find(x => x.id === Number(b.dataset.e));
        b.onclick = () => bookingDialog(row, draw);
      });
      el.querySelectorAll('[data-d]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('刪除這筆租借？')) return;
          try { await DEL(`/room-bookings/${b.dataset.d}`); UI.toast('已刪除'); draw(); } catch (e) { UI.err(e); }
        };
      });
      el.querySelectorAll('[data-re]').forEach(b => {
        const r = renters.rows.find(x => x.id === Number(b.dataset.re));
        b.onclick = () => UI.modal({
          title: `編輯租用人：${r.name}`, wide: true, body: renterForm(r),
          onSubmit: async e => { await PUT(`/renters/${r.id}`, UI.formData(e)); UI.toast('已儲存'); draw(); }
        });
      });
      el.querySelectorAll('[data-rd]').forEach(b => {
        const r = renters.rows.find(x => x.id === Number(b.dataset.rd));
        b.onclick = async () => {
          if (!await UI.confirm(`刪除租用人「${r.name}」？有租借紀錄的會改為停用。`)) return;
          try { const out = await DEL(`/renters/${r.id}`); UI.toast(out.message || '已刪除'); draw(); }
          catch (e) { UI.err(e); }
        };
      });
      el.querySelectorAll('[data-st]').forEach(b => {
        b.onclick = () => rentalStatement(Number(b.dataset.st));
      });
    };

    const bookingDialog = async (row, done) => {
      const [renters, rooms] = await Promise.all([GET('/renters?active=1&size=300'), GET('/rooms')]);
      const d = row || { date: UI.today(), start_time: '09:00', end_time: '11:00' };
      UI.modal({
        title: row ? '編輯租借' : '新增場地租借', wide: true,
        body: `<div class="form-grid">
            ${UI.select('renter_id', '租用人', renters.rows.map(r => [r.id,
    `${r.name}（${r.rate_type === 'package' ? '方案' : UI.fmtMoney(r.hourly_rate) + '／時'}）`]),
  { value: d.renter_id || '', full: true })}
            ${UI.select('room_id', '空間', rooms.filter(r => r.active).map(r => [r.id,
    `${r.name}${r.is_virtual ? '（虛擬空間）' : ''}${r.site_name ? '｜' + r.site_name : ''}`]),
  { value: d.room_id || '', full: true })}
            ${UI.input('date', '日期', { type: 'date', value: d.date })}
            ${UI.input('start_time', '開始', { type: 'time', value: d.start_time })}
            ${UI.input('end_time', '結束', { type: 'time', value: d.end_time })}
            ${UI.input('rate', '本次費率（留空用租用人或空間牌價）', { type: 'number', value: d.rate || '' })}
            ${UI.input('purpose', '用途', { value: d.purpose || '', full: true })}
            ${UI.textarea('note', '備註', { value: d.note || '' })}
          </div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            系統會檢查該空間在此時段是否已被諮商預約、團體場次或其他租借佔用。
            虛擬空間（到府外出、視訊）不佔實體房間，可重複使用。</div>`,
        onSubmit: async e => {
          const f = UI.formData(e);
          const out = row ? await PUT(`/room-bookings/${row.id}`, f) : await POST('/room-bookings', f);
          UI.toast(`已儲存（${out.hours} 小時${out.amount ? '，' + UI.fmtMoney(out.amount) : ''}）`);
          done();
        }
      });
    };

    el.innerHTML = `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
        <input id="rq" class="search-box" placeholder="搜尋租用人／空間／用途">
        <input type="date" id="from" value="${UI.today().slice(0, 8)}01">
        <input type="date" id="to" value="${UI.addDays(UI.today(), 60)}">
        <div class="spacer"></div>
        <button class="btn secondary" id="occ">空間佔用檢視</button>
        <button class="btn secondary" id="addr">新增租用人</button>
        <button class="btn" id="addb">新增租借</button></div>
      <div id="body"></div>`;
    const rq = el.querySelector('#rq');
    rq.oninput = () => { clearTimeout(rq._t); rq._t = setTimeout(() => { page = 1; draw(); }, 300); };
    el.querySelector('#from').onchange = () => { page = 1; draw(); };
    el.querySelector('#to').onchange = () => { page = 1; draw(); };
    el.querySelector('#addr').onclick = () => UI.modal({
      title: '新增租用人', wide: true, body: renterForm(null),
      onSubmit: async e => { await POST('/renters', UI.formData(e)); UI.toast('已新增'); draw(); }
    });
    el.querySelector('#addb').onclick = () => bookingDialog(null, draw);
    el.querySelector('#occ').onclick = () => roomOccupancy();
    await draw();
  }
});

// 空間佔用檢視（M4-01）：30 分鐘刻度，預設只顯示營業時段
async function roomOccupancy(date) {
  const d = await GET('/rooms/occupancy?date=' + (date || UI.today()));
  const [openH, closeH] = d.office_hours.split('-');
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const start = toMin(openH), end = toMin(closeH);
  const slots = [];
  for (let t = start; t < end; t += d.slot_minutes) {
    slots.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  const cellFor = (room, slot) => {
    const sm = toMin(slot);
    const a = room.appointments.find(x => toMin(x.start_time) <= sm && toMin(x.end_time) > sm);
    if (a) return `<td class="occ occ-appt" title="${UI.esc(a.label)}"></td>`;
    const r = room.rentals.find(x => toMin(x.start_time) <= sm && toMin(x.end_time) > sm);
    if (r) return `<td class="occ occ-rent" title="${UI.esc(r.label)}"></td>`;
    return '<td class="occ"></td>';
  };
  UI.modal({
    title: `空間佔用　${d.date}`, wide: true, hideFooter: true,
    body: `<div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">
        營業時段 ${UI.esc(d.office_hours)}，30 分鐘一格。
        <span class="occ-key occ-appt"></span> 諮商　<span class="occ-key occ-rent"></span> 場地租借。
        租借不會進個案系統，也不計入諮商統計。</div>
      <div class="table-wrap"><table class="list occ-table">
        <thead><tr><th>空間</th>${slots.map(s => `<th>${s.endsWith(':00') ? s.slice(0, 2) : ''}</th>`).join('')}</tr></thead>
        <tbody>${d.rooms.map(r => `<tr>
          <td style="white-space:nowrap">${UI.esc(r.name)}
            ${r.is_virtual ? UI.tag('虛擬', '') : ''}
            <div style="font-size:11.5px;color:var(--muted)">${UI.esc([r.capacity + ' 人', r.lighting, r.equipment].filter(Boolean).join('／'))}</div></td>
          ${slots.map(s => cellFor(r, s)).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <div style="display:flex;gap:8px;margin-top:12px" class="no-print">
        <input type="date" id="occd" value="${d.date}">
        <button class="btn small secondary" id="occgo">換日期</button></div>`,
    onOpen: body => {
      body.querySelector('#occgo').onclick = () => {
        document.querySelectorAll('.modal-mask').forEach(x => x.remove());
        roomOccupancy(body.querySelector('#occd').value);
      };
    }
  });
}

// 月結對帳單（M4-06）
async function rentalStatement(renterId, month) {
  const m = month || UI.today().slice(0, 7);
  const d = await GET(`/rentals/statement?month=${m}&renter_id=${renterId}`);
  const g = d.groups[0];
  UI.modal({
    title: `場地租借對帳單　${m}`, wide: true, hideFooter: true,
    body: `<div class="print-doc">
      <div class="doc-title">場地租借對帳單</div>
      <div class="doc-org">${UI.esc(d.center_name)}${d.center_tax_id ? '　統一編號：' + UI.esc(d.center_tax_id) : ''}</div>
      ${g ? `
        <div class="doc-field"><span>租用人</span><span>${UI.esc(g.renter_name)}
          （${g.kind === 'company' ? '法人' : '個人'}${g.tax_id ? '／' + UI.esc(g.tax_id) : ''}）</span></div>
        <div class="doc-field"><span>計費方式</span><span>${g.rate_type === 'package' ? '方案：' + UI.esc(g.package_note || '') : '時租'}</span></div>
        <div class="doc-field"><span>使用時數</span><span>${g.hours} 小時（${g.sessions} 場）</span></div>
        <div class="doc-field"><span>應收金額</span><span><strong>${UI.fmtMoney(g.amount)}</strong>
          ${g.settled ? `（已結算 ${UI.fmtMoney(g.settled)}）` : ''}</span></div>
        <table class="doc">
          <thead><tr><th>日期</th><th>時間</th><th>空間</th><th>用途</th><th>時數</th><th style="text-align:right">金額</th></tr></thead>
          <tbody>${g.rows.map(r => `<tr><td>${r.date}</td><td>${r.start_time}-${r.end_time}</td>
            <td>${UI.esc(r.room_name)}</td><td>${UI.esc(r.purpose || '-')}</td><td>${r.hours}</td>
            <td style="text-align:right">${UI.fmtMoney(r.amount)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><th colspan="5" style="text-align:right">合計</th>
            <th style="text-align:right">${UI.fmtMoney(g.amount)}</th></tr></tfoot>
        </table>` : '<div class="empty">此月份沒有租借紀錄</div>'}
      <div class="doc-foot">取消的租借不列入計費。${d.center_phone ? '如有疑問請來電 ' + UI.esc(d.center_phone) : ''}</div>
    </div>
    <div class="no-print" style="display:flex;gap:8px;margin-top:14px;align-items:center">
      <input type="month" id="rsm" value="${m}">
      <button class="btn small secondary" id="rsgo">換月份</button>
      <button class="btn small secondary" onclick="window.print()">列印</button>
      ${g && g.amount > g.settled ? '<button class="btn small" id="rssettle">標記為已結算</button>' : ''}
    </div>`,
    onOpen: body => {
      body.querySelector('#rsgo').onclick = () => {
        document.querySelectorAll('.modal-mask').forEach(x => x.remove());
        rentalStatement(renterId, body.querySelector('#rsm').value);
      };
      const st = body.querySelector('#rssettle');
      if (st) st.onclick = async () => {
        const out = await POST('/rentals/settle', { renter_id: renterId, month: m });
        UI.toast(`已結算 ${out.settled} 筆`);
        document.querySelectorAll('.modal-mask').forEach(x => x.remove());
        App.go('rentals');
      };
    }
  });
}
