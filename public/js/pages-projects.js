// 機構專案（M7）：主檔、個案額度與對帳單
//
// 專案的重點不在「多一種收費」，而是一組會被違反的限制：
// 次數、期限、間隔天數。所以額度餘量在預約當下就要看得到。

function projectForm(p) {
  const d = p || { price: 2000, duration_min: 50, interval_days: 0, valid_months: 0, total_sessions: 0, charge_client: 0 };
  return `<div class="form-grid">
      ${UI.input('name', '專案名稱', { value: d.name || '', full: true, required: true })}
      ${UI.input('code', '專案代碼', { value: d.code || '' })}
      ${UI.input('contract_party', '合約方（委辦單位）', { value: d.contract_party || '' })}
      ${UI.input('contact', '聯絡窗口', { value: d.contact || '', full: true })}
      ${UI.input('price', '單次價格', { type: 'number', value: d.price })}
      ${UI.input('duration_min', '單次時長（分鐘）', { type: 'number', value: d.duration_min })}
      ${UI.input('total_sessions', '每位個案可用總次數（0＝不限）', { type: 'number', value: d.total_sessions })}
      ${UI.input('interval_days', '兩次至少間隔天數（0＝不限）', { type: 'number', value: d.interval_days })}
      ${UI.input('valid_months', '核給後可用月數（0＝不限）', { type: 'number', value: d.valid_months })}
      ${UI.checkbox('charge_client', '向個案收費（不勾＝由合約方支付，個案端不會看到欠款）', !!d.charge_client)}
      ${UI.textarea('note', '備註', { value: d.note || '' })}
      ${p ? UI.checkbox('active', '啟用中', !!d.active) : ''}
    </div>`;
}

App.page('projects', {
  title: '機構專案',
  sub: '委辦專案的價格、額度與期限；預約當下即檢核餘量',
  module: 'billing',
  async render(el) {
    let page = 1;
    const draw = async () => {
      const q = new URLSearchParams({ q: el.querySelector('#pq').value.trim(), page, size: 50 });
      const d = await GET('/projects?' + q.toString());
      el.querySelector('#body').innerHTML = `
        <div class="card">
          ${UI.table(['專案', '合約方', '單價', '時長', '總次數', '間隔', '期限', '收費對象', '使用中個案', '已用次數', '狀態', ''],
    d.rows.map(p => `<tr>
            <td><strong>${UI.esc(p.name)}</strong>${p.code ? `<div style="font-size:12px;color:var(--muted)">${UI.esc(p.code)}</div>` : ''}</td>
            <td class="wrap narrow">${UI.esc(p.contract_party || '-')}</td>
            <td>${UI.fmtMoney(p.price)}</td>
            <td>${p.duration_min} 分</td>
            <td>${p.total_sessions || '不限'}</td>
            <td>${p.interval_days ? p.interval_days + ' 天' : '不限'}</td>
            <td>${p.valid_months ? p.valid_months + ' 個月' : '不限'}</td>
            <td>${p.charge_client ? '個案自付' : UI.tag('合約方支付', 'ok')}</td>
            <td>${p.active_clients}</td>
            <td>${p.used_total}</td>
            <td>${p.active ? UI.tag('啟用', 'ok') : UI.tag('停用')}</td>
            <td style="white-space:nowrap">
              <button class="btn tiny secondary" data-e="${p.id}">編輯</button>
              <button class="btn tiny" data-st="${p.id}">對帳單</button>
              <button class="btn tiny danger" data-d="${p.id}">刪除</button></td></tr>`), '尚未建立專案')}
          ${UI.pager(d, x => { page = x; draw(); })}
        </div>`;

      el.querySelectorAll('[data-e]').forEach(b => {
        const p = d.rows.find(x => x.id === Number(b.dataset.e));
        b.onclick = () => UI.modal({
          title: `編輯專案：${p.name}`, wide: true, body: projectForm(p),
          onSubmit: async e => { await PUT(`/projects/${p.id}`, UI.formData(e)); UI.toast('已儲存'); draw(); }
        });
      });
      el.querySelectorAll('[data-d]').forEach(b => {
        const p = d.rows.find(x => x.id === Number(b.dataset.d));
        b.onclick = async () => {
          if (!await UI.confirm(`刪除專案「${p.name}」？已核給個案的專案會改為停用。`)) return;
          try { const out = await DEL(`/projects/${p.id}`); UI.toast(out.message || '已刪除'); draw(); }
          catch (e) { UI.err(e); }
        };
      });
      el.querySelectorAll('[data-st]').forEach(b => {
        b.onclick = () => projectStatement(Number(b.dataset.st));
      });
    };

    el.innerHTML = `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
        <input id="pq" class="search-box" placeholder="搜尋專案名稱／代碼／合約方">
        <div class="spacer"></div>
        <button class="btn" id="add">新增專案</button></div>
      <div id="body"></div>`;
    const pq = el.querySelector('#pq');
    pq.oninput = () => { clearTimeout(pq._t); pq._t = setTimeout(() => { page = 1; draw(); }, 300); };
    el.querySelector('#add').onclick = () => UI.modal({
      title: '新增機構專案', wide: true, body: projectForm(null),
      onSubmit: async e => { await POST('/projects', UI.formData(e)); UI.toast('已新增'); draw(); }
    });
    await draw();
  }
});

// 對帳單與請款明細（M7-03）
async function projectStatement(id, month) {
  const m = month || UI.today().slice(0, 7);
  const d = await GET(`/projects/${id}/statement?month=${m}`);
  UI.modal({
    title: `${d.project.name}　${m} 對帳單`, wide: true, hideFooter: true,
    body: `<div class="print-doc">
      <div class="doc-title">${UI.esc(d.project.name)}　服務對帳單</div>
      <div class="doc-org">${UI.esc(d.project.contract_party || '')}　${UI.esc(m)}
        單價 ${UI.fmtMoney(d.summary.unit_price)}／次
        ${d.summary.charge_client ? '（個案自付）' : '（由合約方支付）'}</div>
      <div class="doc-field"><span>服務人次</span><span>${d.summary.sessions} 次</span></div>
      <div class="doc-field"><span>服務人數</span><span>${d.summary.clients} 人</span></div>
      <div class="doc-field"><span>請款金額</span><span><strong>${UI.fmtMoney(d.summary.amount)}</strong></span></div>
      <table class="doc">
        <thead><tr><th>日期</th><th>時間</th><th>個案</th><th>案號</th><th>心理師</th><th>據點</th><th style="text-align:right">金額</th></tr></thead>
        <tbody>${d.rows.map(r => `<tr>
          <td>${r.date}</td><td>${r.start_time}-${r.end_time}</td>
          <td>${UI.esc(r.client_name)}（${UI.esc(r.client_code)}）</td>
          <td>${UI.esc(r.case_no || '-')}</td>
          <td>${UI.esc(r.counselor_name || '')}</td>
          <td>${UI.esc(r.site_name || '-')}</td>
          <td style="text-align:right">${UI.fmtMoney(r.amount || d.summary.unit_price)}</td></tr>`).join('')
    || '<tr><td colspan="7">本月無服務紀錄</td></tr>'}</tbody>
        <tfoot><tr><th colspan="6" style="text-align:right">合計</th>
          <th style="text-align:right">${UI.fmtMoney(d.summary.amount)}</th></tr></tfoot>
      </table>
      <div class="doc-foot">本對帳單僅列已完成之服務；取消與未到不列入請款。</div>
    </div>
    <div class="no-print" style="display:flex;gap:8px;margin-top:14px;align-items:center">
      <input type="month" id="stm" value="${m}">
      <button class="btn small secondary" id="stgo">換月份</button>
      <button class="btn small secondary" onclick="window.print()">列印</button></div>`,
    onOpen: body => {
      body.querySelector('#stgo').onclick = () => {
        document.querySelectorAll('.modal-mask').forEach(x => x.remove());
        projectStatement(id, body.querySelector('#stm').value);
      };
    }
  });
}
