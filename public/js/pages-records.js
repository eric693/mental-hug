// 非個案服務與列印批次軌跡
// 這兩頁都是為了「紀錄容器」而存在：把不是個案的服務移出個案統計，
// 以及把批次列印這件事變成查得到的行為。

const NONCLIENT_TYPES = { outreach_talk: '外派演講', lecture: '講座課程', other: '其他非個案服務' };

function nonclientDialog(r, done) {
  const isNew = !r;
  const d = r || { record_type: 'outreach_talk', date: UI.today(), user_id: App.me.id, fee_method: '單位付款' };
  UI.modal({
    title: isNew ? '新增非個案服務' : '編輯非個案服務',
    wide: true,
    body: `<div class="form-grid">
        ${UI.select('record_type', '服務類型', Object.entries(NONCLIENT_TYPES), { value: d.record_type })}
        ${UI.input('date', '日期', { type: 'date', value: d.date })}
        ${UI.input('start_time', '起', { type: 'time', value: d.start_time || '' })}
        ${UI.input('end_time', '迄', { type: 'time', value: d.end_time || '' })}
        ${UI.input('org_name', '對象單位', { value: d.org_name || '', full: true, required: true })}
        ${UI.input('topic', '主題', { value: d.topic || '', full: true })}
        ${UI.input('location', '地點', { value: d.location || '' })}
        ${UI.select('site_id', '歸屬據點', [['', '不歸屬據點']].concat((App.meta.sites || []).map(s => [s.id, s.name])), { value: d.site_id || '' })}
        ${UI.select('user_id', '執行人員', App.counselorOptions(), { value: d.user_id || App.me.id })}
        ${UI.input('attendees', '參與人數', { type: 'number', value: d.attendees || 0 })}
        ${UI.input('fee', '收費金額', { type: 'number', value: d.fee || 0 })}
        ${UI.inputList('fee_method', '收費方式', ['單位付款', '個人付款', '無償', '其他'], { value: d.fee_method || '' })}
        ${UI.textarea('note', '備註')}
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
        這張表刻意沒有個案欄位——非個案服務不會進入個案統計、初診轉銜率與個案清單。</div>`,
    onSubmit: async e => {
      const data = UI.formData(e);
      if (isNew) await POST('/nonclient-services', data);
      else await PUT(`/nonclient-services/${r.id}`, data);
      UI.toast('已儲存');
      done();
    }
  });
}

App.page('nonclient', {
  title: '非個案服務',
  sub: '外派演講、講座課程等沒有個案的服務；不計入個案統計',
  module: 'notes',
  async render(el) {
    const draw = async () => {
      const q = new URLSearchParams({
        from: el.querySelector('#from').value,
        to: el.querySelector('#to').value,
        type: el.querySelector('#type').value,
        q: el.querySelector('#ncq').value.trim(),
        page, size: 50
      });
      const d = await GET('/nonclient-services?' + q.toString());
      el.querySelector('#body').innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="num">${d.summary.count}</div><div class="label">場次</div></div>
          <div class="stat"><div class="num">${d.summary.attendees}</div><div class="label">累計參與人數</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(d.summary.fee)}</div><div class="label">收費合計</div></div>
        </div>
        <div class="card">
          ${UI.table(['日期', '類型', '對象單位', '主題', '地點', '人員', '人數', '收費', '方式', ''],
    d.rows.map(r => `<tr>
            <td style="white-space:nowrap">${r.date}${r.start_time ? `<div style="font-size:12px;color:var(--muted)">${r.start_time}-${r.end_time}</div>` : ''}</td>
            <td>${UI.tag(NONCLIENT_TYPES[r.record_type] || r.record_type, '')}</td>
            <td class="wrap narrow">${UI.esc(r.org_name)}</td>
            <td class="wrap narrow">${UI.esc(r.topic || '-')}</td>
            <td>${UI.esc(r.location || r.site_name || '-')}</td>
            <td>${UI.esc(r.user_name || '-')}</td>
            <td>${r.attendees || '-'}</td>
            <td>${r.fee ? UI.fmtMoney(r.fee) : '-'}</td>
            <td>${UI.esc(r.fee_method || '-')}</td>
            <td style="white-space:nowrap">
              <button class="btn tiny secondary" data-e="${r.id}">編輯</button>
              <button class="btn tiny danger" data-d="${r.id}">刪除</button></td></tr>`), '此期間沒有非個案服務紀錄')}
          ${UI.pager(d, p => { page = p; draw(); })}
        </div>`;
      el.querySelectorAll('[data-e]').forEach(b => {
        b.onclick = () => nonclientDialog(d.rows.find(x => x.id === Number(b.dataset.e)), draw);
      });
      el.querySelectorAll('[data-d]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('刪除這筆非個案服務紀錄？')) return;
          await DEL(`/nonclient-services/${b.dataset.d}`);
          UI.toast('已刪除');
          draw();
        };
      });
    };
    let page = 1;
    el.innerHTML = `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
        <input id="ncq" class="search-box" placeholder="搜尋單位／主題／地點／人員">
        <input type="date" id="from" value="${UI.today().slice(0, 8)}01">
        <input type="date" id="to" value="${UI.today()}">
        <select id="type"><option value="">全部類型</option>
          ${Object.entries(NONCLIENT_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <div class="spacer"></div>
        ${App.me.role === 'admin' ? '<button class="btn secondary" id="migrate">歷史虛擬個案重新標記</button>' : ''}
        <button class="btn" id="add">新增紀錄</button></div>
      <div id="body"></div>`;
    const reset = () => { page = 1; draw(); };
    el.querySelector('#from').onchange = reset;
    el.querySelector('#to').onchange = reset;
    el.querySelector('#type').onchange = reset;
    const ncq = el.querySelector('#ncq');
    ncq.oninput = () => { clearTimeout(ncq._t); ncq._t = setTimeout(reset, 300); };
    el.querySelector('#add').onclick = () => nonclientDialog(null, draw);

    const mig = el.querySelector('#migrate');
    if (mig) mig.onclick = async () => {
      const cands = await GET('/nonclient-services/migration-candidates');
      UI.modal({
        title: '歷史虛擬個案重新標記', wide: true, submitText: '轉換',
        body: `<div style="font-size:13px;color:var(--muted);margin-bottom:10px">
            把記在虛擬個案底下的舊紀錄轉為非個案服務。轉換後原晤談紀錄會刪除，
            但每一筆都在稽核軌跡留下對照（原紀錄編號 → 新紀錄）。此動作僅管理者可執行。</div>
          <div class="form-grid">
            ${UI.select('client_id', '要轉換的虛擬個案', cands.length
    ? cands.map(c => [c.id, `${c.name}（${c.code}）— ${c.notes} 筆紀錄`])
    : [['', '找不到疑似虛擬個案']], { full: true })}
            ${UI.select('record_type', '轉為', Object.entries(NONCLIENT_TYPES))}
            ${UI.input('org_name', '對象單位', { full: true })}
            ${UI.input('topic', '主題')}
            ${UI.input('location', '地點')}
          </div>`,
        onSubmit: async e => {
          const d = UI.formData(e);
          if (!d.client_id) { UI.toast('請選擇個案', true); return false; }
          if (!await UI.confirm('確定轉換？原晤談紀錄會被刪除並轉為非個案服務。')) return false;
          const r = await POST('/nonclient-services/migrate', d);
          UI.toast(`已轉換 ${r.migrated} 筆`);
          draw();
        }
      });
    };
    await draw();
  }
});

// ---- 列印批次軌跡（M8-09／M8-10）----
App.page('print-batches', {
  title: '列印批次軌跡',
  sub: '批次列印屬特種個資大量匯出，每一批的用途、範圍與操作者都留存且不可修改',
  module: 'notes',
  async render(el) {
    let page = 1;
    const draw = async () => {
      const q = new URLSearchParams({
        q: (el.querySelector('#pbq') || {}).value || '',
        purpose: (el.querySelector('#pbp') || {}).value || '',
        page, size: 50
      });
      const d = await GET('/print-batches?' + q.toString());
      el.querySelector('#pb-body').innerHTML = `
      ${d.anomalies.length ? `<div class="notice warn" style="margin-bottom:12px">
        <strong>您目前的列印行為觸發了下列提醒</strong><br>${d.anomalies.map(UI.esc).join('<br>')}</div>` : ''}
      <div class="card">
        ${UI.table(['批次編號', '時間', '操作者', '用途', '筆數', '輸出', '狀態', '篩選條件', '來源 IP'],
    d.rows.map(r => `<tr>
          <td style="font-family:ui-monospace,monospace;font-size:12.5px">${UI.esc(r.batch_no)}</td>
          <td style="white-space:nowrap">${UI.esc(r.created_at.slice(0, 16))}</td>
          <td>${UI.esc(r.user_name)}</td>
          <td>${UI.tag(r.purpose, r.purpose === '司法調閱' ? 'danger' : '')}
            ${r.purpose_note ? `<div style="font-size:12px;color:var(--muted)">${UI.esc(r.purpose_note)}</div>` : ''}</td>
          <td><strong>${r.count}</strong>${r.skipped ? `<div style="font-size:12px;color:var(--muted)">略過 ${r.skipped}</div>` : ''}</td>
          <td>${r.mode === 'split' ? '分檔' : '合併'}</td>
          <td>${r.status === 'done' ? UI.tag('已產生', 'ok') : UI.tag('背景處理中', 'warn')}</td>
          <td class="wrap" style="font-size:12px">${UI.esc(JSON.stringify(r.filters))}</td>
          <td style="font-size:12px;color:var(--muted)">${UI.esc(r.ip)}</td></tr>`), '尚無批次列印紀錄')}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          異常判定門檻：單人單日超過 ${d.daily_limit} 筆、於所內上班時段以外列印、
          或一小時內執行三次以上批次（皆可於系統設定調整）。此頁只能查詢，沒有修改或刪除的功能。</div>
        ${UI.pager(d, p => { page = p; draw(); })}
      </div>`;
    };
    el.innerHTML = `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
        <input id="pbq" class="search-box" placeholder="搜尋批次編號／操作者／用途">
        <select id="pbp"><option value="">全部用途</option>
          ${['督考', '司法調閱', '個案申請', '內部歸檔', '其他'].map(p => `<option value="${p}">${p}</option>`).join('')}</select>
        <div class="spacer"></div></div>
      <div id="pb-body"></div>`;
    const reset = () => { page = 1; draw(); };
    el.querySelector('#pbp').onchange = reset;
    const pbq = el.querySelector('#pbq');
    pbq.oninput = () => { clearTimeout(pbq._t); pbq._t = setTimeout(reset, 300); };
    await draw();
  }
});
