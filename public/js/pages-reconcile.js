// 收費對帳（M5）：人工佇列、三方勾稽、金流入帳、收據雙版本
//
// 設計前提：大多數交易長得一模一樣（有到、金額就是預設價、當場付清），
// 這些自動入帳；人只需要看真的有疑問的那幾筆。佇列愈短，這頁愈成功。

App.page('reconcile', {
  title: '收費對帳',
  sub: '自動確認其餘進人工佇列；預約 ↔ 交易 ↔ 金流三方勾稽',
  module: 'billing',
  async render(el) {
    let page = 1;
    let selected = new Set();
    let allIds = [];

    const drawQueue = async () => {
      const q = new URLSearchParams({
        q: el.querySelector('#rq').value.trim(),
        site_id: el.querySelector('#rsite').value,
        page, size: 50
      });
      const d = await GET('/reconcile/queue?' + q.toString());
      allIds = d.all_ids;
      el.querySelector('#queue').innerHTML = `
        <div class="toolbar" style="flex-wrap:wrap;gap:8px;padding:0 0 10px">
          <button class="btn tiny secondary" id="selpage">全選本頁（${d.rows.length}）</button>
          <button class="btn tiny secondary" id="selall">全選全部結果（${d.total}）</button>
          <button class="btn tiny secondary" id="selinv">反向選取</button>
          <button class="btn tiny secondary" id="selnone">取消選取</button>
          <span id="selcount" style="font-size:12.5px;color:var(--muted)"></span>
          <div class="spacer"></div>
          <button class="btn tiny" id="bconfirm">確認入帳</button>
          <button class="btn tiny secondary" id="bresolve">標記已處理</button>
          <button class="btn tiny danger" id="bvoid">作廢</button>
        </div>
        ${UI.table(['', '日期', '個案', '項目', '金額', '據點', '心理師', '狀態', '需人工處理的原因'],
    d.rows.map(r => `<tr>
          <td><input type="checkbox" class="rsel" value="${r.id}"${selected.has(r.id) ? ' checked' : ''}></td>
          <td style="white-space:nowrap">${r.date}</td>
          <td>${UI.esc(r.client_name)}<div style="font-size:12px;color:var(--muted)">${UI.esc(r.client_code)}</div></td>
          <td class="wrap narrow">${UI.esc(r.item)}</td>
          <td>${UI.fmtMoney(r.amount)}</td>
          <td>${UI.esc(r.site_name || '未歸屬')}</td>
          <td>${UI.esc(r.counselor_name || '-')}</td>
          <td>${stateTag('inv_status', r.status)}</td>
          <td class="wrap" style="font-size:12.5px;color:var(--danger)">${UI.esc(r.review_reason)}</td>
        </tr>`), '佇列是空的——所有交易都自動確認了')}
        ${UI.pager(d, p => { page = p; drawQueue(); })}`;

      const boxes = () => [...el.querySelectorAll('.rsel')];
      const sync = () => {
        boxes().forEach(b => { b.checked = selected.has(Number(b.value)); });
        el.querySelector('#selcount').textContent = `已選 ${selected.size} 筆`;
      };
      boxes().forEach(b => {
        b.onchange = () => {
          const id = Number(b.value);
          if (b.checked) selected.add(id); else selected.delete(id);
          sync();
        };
      });
      el.querySelector('#selpage').onclick = () => { boxes().forEach(b => selected.add(Number(b.value))); sync(); };
      el.querySelector('#selall').onclick = () => { allIds.forEach(id => selected.add(id)); sync(); };
      el.querySelector('#selnone').onclick = () => { selected.clear(); sync(); };
      // 反向選取以「目前篩選的全部結果」為準，與分頁無關
      el.querySelector('#selinv').onclick = () => {
        const next = new Set(allIds.filter(id => !selected.has(id)));
        selected = next;
        sync();
      };
      sync();

      const batch = (action, extra = {}) => async () => {
        if (!selected.size) return UI.toast('請先選擇要處理的收費單', true);
        if (!await UI.confirm(`對 ${selected.size} 筆執行「${extra.label}」？`)) return;
        const out = await POST('/reconcile/batch', { ids: [...selected], action, ...extra });
        UI.toast(`已處理 ${out.done} 筆${out.failed.length ? `，${out.failed.length} 筆未成功` : ''}`,
          out.failed.length > 0);
        if (out.failed.length) {
          UI.modal({
            title: '未成功的項目', hideFooter: true,
            body: UI.table(['收費單', '原因'], out.failed.map(f => `<tr><td>#${f.id}</td><td>${UI.esc(f.reason)}</td></tr>`))
          });
        }
        selected.clear();
        drawQueue();
      };
      el.querySelector('#bconfirm').onclick = batch('confirm', { label: '確認入帳', method: '現金' });
      el.querySelector('#bresolve').onclick = batch('resolve', { label: '標記已處理' });
      el.querySelector('#bvoid').onclick = batch('void', { label: '作廢' });
    };

    const drawReport = async () => {
      const month = el.querySelector('#rm').value;
      const d = await GET('/reconcile/report?month=' + month);
      const block = (title, rows, cols, render, hint) => rows.length ? `<div class="card">
          <h3>${UI.esc(title)}（${rows.length}）</h3>
          ${hint ? `<div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">${UI.esc(hint)}</div>` : ''}
          ${UI.table(cols, rows.map(render))}</div>` : '';
      el.querySelector('#report').innerHTML = `
        <div class="card"><h3>各主體收付對照</h3>
          ${UI.table(['據點', '法律主體', '收費單數', '已收款金額', '金流入帳', '差額'], d.by_site.map(s => `<tr>
            <td>${UI.esc(s.site)}</td><td>${UI.esc(s.legal_entity || '未設定')}</td>
            <td>${s.invoices}</td><td>${UI.fmtMoney(s.invoiced)}</td><td>${UI.fmtMoney(s.received)}</td>
            <td>${s.invoiced === s.received ? UI.tag('相符', 'ok')
    : UI.tag(UI.fmtMoney(s.invoiced - s.received), 'danger')}</td></tr>`), '本月沒有收費資料')}</div>
        ${d.clean ? '<div class="notice ok">三方勾稽沒有差異。</div>' : ''}
        ${block('已完成但沒有收費單', d.done_no_invoice, ['日期', '個案', '心理師', '預約費用'],
    r => `<tr><td>${r.date} ${r.start_time}</td><td>${UI.esc(r.client_name)}（${UI.esc(r.client_code)}）</td>
      <td>${UI.esc(r.counselor_name || '')}</td><td>${UI.fmtMoney(r.fee)}</td></tr>`,
    '晤談完成卻沒有對應收費單；扣方案或走專案的不列入。')}
        ${block('已收款但沒有金流紀錄', d.paid_no_payment, ['日期', '個案', '項目', '金額', '收據號'],
    r => `<tr><td>${r.date}</td><td>${UI.esc(r.client_name)}（${UI.esc(r.client_code)}）</td>
      <td class="wrap narrow">${UI.esc(r.item)}</td><td>${UI.fmtMoney(r.amount)}</td>
      <td>${UI.esc(r.receipt_no || '-')}</td></tr>`,
    '收費單標為已收款，但沒有對應的入帳紀錄，無法與金流對帳。')}
        ${block('入帳金額與收費單不符', d.amount_mismatch, ['日期', '個案', '收費單金額', '實際入帳', '差額'],
    r => `<tr><td>${r.date}</td><td>${UI.esc(r.client_name)}</td>
      <td>${UI.fmtMoney(r.invoice_amount)}</td><td>${UI.fmtMoney(r.paid_amount)}</td>
      <td style="color:var(--danger)">${UI.fmtMoney(r.paid_amount - r.invoice_amount)}</td></tr>`)}
        ${block('沒有對應收費單的入帳', d.payment_no_invoice, ['入帳時間', '金額', '方式', '交易序號'],
    r => `<tr><td>${UI.esc(r.paid_at)}</td><td>${UI.fmtMoney(r.amount)}</td>
      <td>${UI.esc(r.method)}</td><td>${UI.esc(r.external_no || '-')}</td></tr>`)}
        ${block('收費單沒有對應預約', d.invoice_no_appt, ['日期', '個案', '項目', '金額', '狀態'],
    r => `<tr><td>${r.date}</td><td>${UI.esc(r.client_name)}</td><td class="wrap narrow">${UI.esc(r.item)}</td>
      <td>${UI.fmtMoney(r.amount)}</td><td>${UI.esc(r.status)}</td></tr>`,
    '手動開立的收費單會列在這裡，屬正常情形，僅供核對。')}`;
    };

    el.innerHTML = `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
        <input id="rq" class="search-box" placeholder="搜尋個案／項目／原因">
        <select id="rsite"><option value="">全部據點</option>
          ${(App.meta.sites || []).map(s => `<option value="${s.id}">${UI.esc(s.name)}</option>`).join('')}</select>
        <input type="month" id="rm" value="${UI.today().slice(0, 7)}">
        <div class="spacer"></div>
        <button class="btn secondary" id="reclass">重新判定本月</button>
        <button class="btn secondary" id="export">匯出月度明細</button>
      </div>
      <div class="card"><h3>人工佇列</h3>
        <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">
          到診、金額相符、有分帳規則可循的交易會自動確認；只有下列有疑問的需要人看。
          反向選取的範圍是「目前篩選的全部結果」，與分頁無關。</div>
        <div id="queue"></div></div>
      <div id="report"></div>`;

    const rq = el.querySelector('#rq');
    rq.oninput = () => { clearTimeout(rq._t); rq._t = setTimeout(() => { page = 1; drawQueue(); }, 300); };
    el.querySelector('#rsite').onchange = () => { page = 1; drawQueue(); };
    el.querySelector('#rm').onchange = drawReport;
    el.querySelector('#reclass').onclick = async () => {
      const out = await POST('/reconcile/reclassify', { month: el.querySelector('#rm').value });
      UI.toast(`自動確認 ${out.auto} 筆，待人工 ${out.pending} 筆`);
      drawQueue();
    };
    el.querySelector('#export').onclick = () => {
      window.open(`/api/reconcile/export?month=${el.querySelector('#rm').value}`, '_blank');
    };
    await drawQueue();
    await drawReport();
  }
});

// ---- 收據（雙版本 + 補印軌跡）----
async function receiptDoc(invoiceId, variant, reason) {
  let d;
  try {
    d = await GET(`/invoices/${invoiceId}/receipt-doc?variant=${variant || 'plain'}`
      + (reason ? `&reason=${encodeURIComponent(reason)}` : ''));
  } catch (e) {
    // 已印過就要填補印原因，避免收據被無痕重印
    if (String(e.message).includes('補印')) {
      return UI.modal({
        title: '補印收據', submitText: '補印',
        body: `<div class="notice warn" style="margin-bottom:10px">
            此收據已列印過。補印會記入軌跡（誰、何時、原因）。</div>
          <div class="form-grid">
            ${UI.inputList('reason', '補印原因', ['個案遺失', '收據汙損', '報稅補件', '單位核銷', '其他'], { full: true })}
            ${UI.select('variant', '版本', [['plain', '無章版'], ['stamped', '含發票章與印花稅總繳章']])}</div>`,
        onSubmit: async e2 => {
          const f = UI.formData(e2);
          if (!f.reason) { UI.toast('請填寫補印原因', true); return false; }
          receiptDoc(invoiceId, f.variant, f.reason);
        }
      });
    }
    return UI.err(e);
  }

  UI.modal({
    title: `收據（${d.variant === 'stamped' ? '含章版' : '無章版'}）`, wide: true, hideFooter: true,
    body: `<div class="print-doc">
      <div class="doc-title">收　據</div>
      <div class="doc-org">${UI.esc(d.entity)}
        ${d.tax_id ? '　統一編號：' + UI.esc(d.tax_id) : ''}
        ${d.license_no ? '　開業執照字號：' + UI.esc(d.license_no) : ''}</div>
      <div class="doc-field"><span>收據號碼</span><span>${UI.esc(d.receipt_no || '（尚未收款）')}</span></div>
      <div class="doc-field"><span>個案</span><span>${UI.esc(d.client_name)}（${UI.esc(d.client_code)}）</span></div>
      <div class="doc-field"><span>服務項目</span><span>${UI.esc(d.item)}</span></div>
      <div class="doc-field"><span>金額</span><span><strong>${UI.fmtMoney(d.amount)}</strong>
        （付款方式：${UI.esc(d.method || '-')}）</span></div>
      <div class="doc-field"><span>付款人別</span><span>${UI.esc(d.payer || '-')}</span></div>
      <div class="doc-field"><span>收款日期</span><span>${UI.esc(d.paid_at || d.date)}</span></div>
      ${d.site_name ? `<div class="doc-field"><span>服務據點</span><span>${UI.esc(d.site_name)}</span></div>` : ''}
      ${d.variant === 'stamped' ? `<div class="stamp-box">
        <div class="stamp">發票章<br><span>${UI.esc(d.entity)}</span></div>
        <div class="stamp">印花稅<br>總繳章</div>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-top:6px">${UI.esc(d.stamp_note)}</div>` : ''}
      <div class="doc-foot">
        ${UI.esc(d.address || '')}　${UI.esc(d.phone || '')}
        ${d.director ? '<br>負責心理師：' + UI.esc(d.director) : ''}
        ${d.prints ? `<br>本收據為第 ${d.prints + 1} 次列印` : ''}
      </div>
      <div style="margin-top:24px">收款人：＿＿＿＿＿＿＿＿</div>
    </div>
    <div class="no-print" style="display:flex;gap:8px;margin-top:14px">
      <button class="btn small secondary" onclick="window.print()">列印</button>
      ${d.variant === 'plain'
    ? `<button class="btn small secondary" onclick="receiptDoc(${invoiceId},'stamped','切換為含章版')">改用含章版</button>`
    : `<button class="btn small secondary" onclick="receiptDoc(${invoiceId},'plain','切換為無章版')">改用無章版</button>`}
      <button class="btn small secondary" onclick="receiptPrintLog(${invoiceId})">列印軌跡</button>
    </div>`
  });
}

async function receiptPrintLog(invoiceId) {
  const rows = await GET(`/invoices/${invoiceId}/receipt-prints`);
  UI.modal({
    title: '收據列印軌跡', hideFooter: true,
    body: UI.table(['時間', '版本', '原因', '列印者'], rows.map(r => `<tr>
      <td style="white-space:nowrap">${UI.esc(r.created_at.slice(0, 16))}</td>
      <td>${r.variant === 'stamped' ? '含章版' : '無章版'}</td>
      <td class="wrap">${UI.esc(r.reason)}</td>
      <td>${UI.esc(r.by_name || r.user_name)}</td></tr>`), '尚無列印紀錄')
  });
}
