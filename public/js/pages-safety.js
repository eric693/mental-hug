// 安全計畫（Safety Plan）與實習生紀錄覆核
//
// 安全計畫是高風險個案的標準照護文件：與個案一起約定「狀況變差時怎麼做」，
// 印一份給個案帶走。保密層級同晤談紀錄，每次調閱寫入稽核。

const SAFETY_SECTIONS = [
  ['warning_signs', '1. 警訊', '什麼想法、情緒、行為或身體感受出現時，代表狀況正在變差？'],
  ['coping_strategies', '2. 我可以自己做的因應方式', '不需要找別人也能做的事：散步、聽音樂、呼吸練習、寫下來…'],
  ['distractions', '3. 可以轉移注意力的人事地', '可以去的地方、可以找的人（不必談困擾，只是有人在）'],
  ['support_contacts', '4. 可以求助的親友', '姓名與電話，建議 2 位以上'],
  ['professional_contacts', '5. 專業協助', '心理師、就診醫院與門診時間、聯絡方式'],
  ['crisis_resources', '6. 危機資源', '24 小時專線與急診'],
  ['environment_safety', '7. 環境安全', '如何降低致命工具的可及性；由誰保管、放在哪裡'],
  ['reasons_living', '8. 值得活下去的理由', '重要的人、還想完成的事、支撐自己的信念']
];

function safetyPlanDialog(clientId, plan, defaults, onDone) {
  // plan 有值＝編輯現行版本；無值＝新建（或以舊版內容另存新版本）
  const p = plan || {};
  const isNew = !plan || !plan.id;
  const val = k => (p[k] !== undefined && p[k] !== '' ? p[k] : (isNew ? (defaults || {})[k] || '' : ''));
  UI.modal({
    title: isNew ? `建立安全計畫${p.version ? '（以第 ' + p.version + ' 版內容帶入）' : ''}` : `編輯安全計畫（第 ${p.version} 版）`,
    wide: true,
    submitText: isNew ? '建立' : '儲存',
    body: `<div class="notice" style="margin-bottom:12px;font-size:13px">
        安全計畫應與個案一起討論後填寫，並印一份交給個案隨身保存。
        內容更動較大時請用「另存新版本」，舊版本會保留供日後查閱。</div>
      <div class="form-grid">
        ${UI.input('date', '訂定日期', { type: 'date', value: val('date') || UI.today() })}
        ${UI.input('review_date', '預定重新檢視日', { type: 'date', value: val('review_date') })}
        ${SAFETY_SECTIONS.map(([k, label, ph]) =>
    UI.textarea(k, label, { value: val(k), placeholder: ph, rows: 3 })).join('')}
        ${UI.textarea('note', '其他備註（僅所內留存，不印在給個案的版本）', { value: val('note'), rows: 2 })}
        ${UI.checkbox('agreed_with_client', '已與個案共同討論並取得同意', isNew ? true : !!p.agreed_with_client)}
      </div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      if (!data.warning_signs.trim() || !data.coping_strategies.trim()) {
        throw new Error('「警訊」與「自己可以做的因應方式」為必填');
      }
      if (isNew) await POST(`/clients/${clientId}/safety-plans`, data);
      else await PUT(`/safety-plans/${p.id}`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

// 列印版：只印給個案看的內容（不含所內備註）
async function safetyPlanPrint(id) {
  const p = await GET(`/safety-plans/${id}/print`);
  const sec = (label, text) => `<div style="margin-bottom:10px">
    <div style="font-weight:700;font-size:14px">${UI.esc(label)}</div>
    <div style="white-space:pre-wrap;font-size:14px;line-height:1.8;border-bottom:1px dashed #bbb;padding:4px 0 8px">${UI.esc(text || '（未填）')}</div></div>`;
  UI.modal({
    title: '安全計畫（列印版）',
    wide: true,
    hideFooter: true,
    body: `<div id="sp-print" style="font-size:14px">
        <div style="text-align:center;font-size:18px;font-weight:700;margin-bottom:4px">我的安全計畫</div>
        <div style="text-align:center;font-size:12.5px;color:#666;margin-bottom:12px">
          ${UI.esc(p.center_name)}　${UI.esc(p.center_phone || '')}</div>
        <div style="font-size:13px;margin-bottom:10px">
          姓名：${UI.esc(p.client_name)}　　訂定日期：${UI.esc(p.date)}（第 ${p.version} 版）<br>
          心理師：${UI.esc(p.counselor_name || '')}${p.license_no ? '（' + UI.esc(p.license_type || '') + ' ' + UI.esc(p.license_no) + '）' : ''}
          ${p.review_date ? '　　預定檢視日：' + UI.esc(p.review_date) : ''}</div>
        ${SAFETY_SECTIONS.map(([k, label]) => sec(label, p[k])).join('')}
        ${p.emergency_name ? `<div style="font-size:13px;margin-top:10px">
          緊急聯絡人：${UI.esc(p.emergency_name)}${p.emergency_relationship ? '（' + UI.esc(p.emergency_relationship) + '）' : ''}
          ${UI.esc(p.emergency_phone || '')}</div>` : ''}
        <div style="margin-top:14px;font-size:12.5px;color:#666;line-height:1.8">
          請把這張計畫放在容易拿到的地方。當警訊出現時，從第 2 項開始依序往下做。<br>
          如果有立即危險，請直接撥打 119 或前往最近的急診。</div>
        <div style="margin-top:20px;font-size:13px">個案簽名：＿＿＿＿＿＿＿　　心理師簽名：＿＿＿＿＿＿＿</div>
      </div>
      <button class="btn small secondary" style="margin-top:14px" onclick="window.print()">列印</button>`
  });
}

// 個案頁的「安全計畫」分頁內容
async function safetyPlanTab(client, body, refresh) {
  const d = await GET(`/clients/${client.id}/safety-plans`);
  const active = d.rows.find(r => r.status === 'active');
  const history = d.rows.filter(r => r.status !== 'active');
  const overdue = active && active.review_date && active.review_date <= UI.today();
  body.innerHTML = `
    <div class="toolbar">
      ${active ? '<button class="btn small secondary" id="edit">編輯現行版本</button>' : ''}
      <button class="btn small" id="new">${active ? '另存新版本' : '建立安全計畫'}</button>
      ${active ? '<button class="btn small secondary" id="print">列印給個案</button>' : ''}
      ${active ? '<div class="spacer"></div><button class="btn small danger" id="delp">刪除現行版本</button>' : ''}
    </div>
    ${!active && client.risk_level === 'high' ? `<div class="notice warn" style="margin-bottom:12px">
      此個案為高風險且尚未建立安全計畫，建議於下次晤談與個案一起訂定。</div>` : ''}
    ${overdue ? `<div class="notice warn" style="margin-bottom:12px">
      安全計畫已逾預定檢視日（${UI.esc(active.review_date)}），請與個案確認是否需要更新。</div>` : ''}
    ${active ? `<div class="card">
      <h3>現行版本（第 ${active.version} 版）</h3>
      <div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">
        訂定 ${UI.esc(active.date)}　心理師 ${UI.esc(active.counselor_name || '')}
        ${active.review_date ? '　預定檢視 ' + UI.esc(active.review_date) : ''}
        ${active.agreed_with_client ? '　' + UI.tag('已與個案共同討論', 'ok') : '　' + UI.tag('未註記與個案討論', 'warn')}</div>
      <div class="detail-grid">
        ${SAFETY_SECTIONS.map(([k, label]) => `<div style="grid-column:1/-1">
          <div class="dg-label">${UI.esc(label)}</div>
          <div style="white-space:pre-wrap">${UI.esc(active[k] || '—')}</div></div>`).join('')}
        ${active.note ? `<div style="grid-column:1/-1"><div class="dg-label">所內備註（不印給個案）</div>
          <div style="white-space:pre-wrap">${UI.esc(active.note)}</div></div>` : ''}
      </div></div>` : '<div class="empty">尚未建立安全計畫</div>'}
    ${history.length ? `<div class="card"><h3>歷次版本</h3>
      ${UI.table(['版本', '訂定日期', '心理師', ''], history.map(h => `<tr>
        <td>第 ${h.version} 版</td><td>${h.date}</td><td>${UI.esc(h.counselor_name || '')}</td>
        <td><button class="btn tiny secondary" data-view="${h.id}">檢視</button>
          <button class="btn tiny secondary" data-print="${h.id}">列印</button></td></tr>`))}
      <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
        舊版本保留當時的約定內容，僅供查閱不可修改。</div></div>` : ''}`;

  const el = body;
  if (el.querySelector('#new')) {
    el.querySelector('#new').onclick = () =>
      safetyPlanDialog(client.id, active ? { ...active, id: null } : null, d.defaults, refresh);
  }
  if (el.querySelector('#edit')) el.querySelector('#edit').onclick = () => safetyPlanDialog(client.id, active, d.defaults, refresh);
  if (el.querySelector('#print')) el.querySelector('#print').onclick = () => safetyPlanPrint(active.id);
  // 刪掉現行版本後，上一版會自動回復為現行，避免個案變成「完全沒有安全計畫」
  if (el.querySelector('#delp')) el.querySelector('#delp').onclick = async () => {
    if (!await UI.confirm(`刪除第 ${active.version} 版安全計畫？若有舊版本，上一版會自動回復為現行版本。`)) return;
    try {
      const r = await DEL(`/safety-plans/${active.id}`);
      UI.toast(r.restored_version ? `已刪除，第 ${r.restored_version} 版回復為現行` : '已刪除');
      refresh();
    } catch (e) { UI.err(e); }
  };
  el.querySelectorAll('[data-print]').forEach(b => { b.onclick = () => safetyPlanPrint(Number(b.dataset.print)); });
  el.querySelectorAll('[data-view]').forEach(b => {
    b.onclick = () => {
      const h = history.find(x => x.id === Number(b.dataset.view));
      UI.modal({
        title: `安全計畫 第 ${h.version} 版（${h.date}）`,
        wide: true, hideFooter: true,
        body: `<div class="detail-grid">${SAFETY_SECTIONS.map(([k, label]) => `<div style="grid-column:1/-1">
          <div class="dg-label">${UI.esc(label)}</div>
          <div style="white-space:pre-wrap">${UI.esc(h[k] || '—')}</div></div>`).join('')}</div>`
      });
    };
  });
}

// ---- 安全計畫列管 ----
App.page('safety', {
  title: '安全計畫列管',
  sub: '高風險個案是否都有現行安全計畫、是否逾期未檢視',
  module: 'risk',
  async render(el) {
    const d = await GET('/safety-plans/overview');
    const stateTagOf = r => r.state === 'missing'
      ? UI.tag(r.risk_level === 'high' ? '高風險未建立' : '未建立', r.risk_level === 'high' ? 'danger' : 'warn')
      : r.state === 'due' ? UI.tag('逾檢視日', 'warn') : UI.tag('現行有效', 'ok');
    el.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="num ${d.missing_high ? 'danger' : ''}">${d.missing_high}</div>
          <div class="label">高風險個案未建立安全計畫</div></div>
        <div class="stat"><div class="num ${d.due ? 'warn' : ''}">${d.due}</div><div class="label">逾預定檢視日</div></div>
        <div class="stat"><div class="num">${d.rows.filter(r => r.state === 'ok').length}</div><div class="label">現行有效</div></div>
      </div>
      <div class="card">
        ${UI.table(['個案', '風險', '主責心理師', '狀態', '現行版本', '預定檢視日', ''], d.rows.map(r => `<tr>
          <td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}（${r.client_code}）</a></td>
          <td>${stateTag('risk_level', r.risk_level)}</td>
          <td>${UI.esc(r.counselor_name || '')}</td>
          <td>${stateTagOf(r)}</td>
          <td>${r.plan_id ? `第 ${r.version} 版（${r.plan_date}）` : '-'}</td>
          <td>${r.review_date ? (r.state === 'due'
    ? `<span style="color:var(--danger);font-weight:600">${r.review_date}</span>` : r.review_date) : '-'}</td>
          <td><a class="btn tiny secondary" href="#client/${r.client_id}">開啟個案</a>
            ${r.plan_id ? `<button class="btn tiny secondary" data-p="${r.plan_id}">列印</button>` : ''}</td></tr>`),
    '目前沒有需要列管的個案')}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          列出風險等級為中／高的服務中個案，以及任何已建立安全計畫的個案。
          安全計畫內容請於個案頁的「安全計畫」分頁編輯（僅主責心理師、督導與管理者可讀）。</div>
      </div>`;
    el.querySelectorAll('[data-p]').forEach(b => { b.onclick = () => safetyPlanPrint(Number(b.dataset.p)); });
  }
});

// ---- 實習生紀錄覆核 ----
App.page('notes-review', {
  title: '紀錄覆核',
  sub: '實習心理師的晤談紀錄需經指定督導覆核後才定稿',
  module: 'notes',
  visible: () => App.me && (App.me.is_supervisor || App.me.is_intern),
  async render(el) {
    const d = await GET('/notes/review-queue');
    el.innerHTML = `
      ${d.can_review ? `<div class="card"><h3>待我覆核（${d.rows.length}）</h3>
        ${UI.table(['送出時間', '等候', '實習心理師', '個案', '晤談日期', '風險', ''], d.rows.map(r => `<tr>
          <td>${UI.esc((r.submitted_at || '').slice(0, 16))}</td>
          <td>${r.days_waiting > d.alert_days
    ? `<span style="color:var(--danger);font-weight:700">${r.days_waiting} 天</span>` : r.days_waiting + ' 天'}</td>
          <td>${UI.esc(r.counselor_name)}</td>
          <td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}（${r.client_code}）</a></td>
          <td>${r.date}（第 ${r.session_no} 次）</td>
          <td>${stateTag('risk_flag', r.risk_flag)}</td>
          <td><button class="btn tiny" data-r="${r.id}" data-c="${r.client_id}">覆核</button></td></tr>`),
    '目前沒有待覆核的紀錄')}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          逾 ${d.alert_days} 天未覆核以紅字標示。覆核通過後紀錄即定稿，雙方都不可再修改；
          需補正者請填寫意見退回。</div></div>` : ''}
      ${d.returned.length ? `<div class="card"><h3>我被退回待補正（${d.returned.length}）</h3>
        ${UI.table(['晤談日期', '個案', '督導', '退回時間', '督導意見', ''], d.returned.map(r => `<tr>
          <td>${r.date}（第 ${r.session_no} 次）</td>
          <td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}（${r.client_code}）</a></td>
          <td>${UI.esc(r.reviewer_name || '')}</td>
          <td>${UI.esc((r.reviewed_at || '').slice(0, 16))}</td>
          <td style="white-space:pre-wrap;font-size:13px">${UI.esc(r.review_comment)}</td>
          <td><button class="btn tiny" data-e="${r.id}" data-c="${r.client_id}">修改</button></td></tr>`))}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          修改儲存後請再按一次「送督導覆核」。</div></div>` : ''}
      ${!d.can_review && !d.returned.length ? '<div class="empty">目前沒有需要處理的紀錄</div>' : ''}`;
    el.querySelectorAll('[data-r]').forEach(b => {
      b.onclick = () => noteDialog({ id: Number(b.dataset.r), client_id: Number(b.dataset.c) }, () => App.go('notes-review'));
    });
    el.querySelectorAll('[data-e]').forEach(b => {
      b.onclick = () => noteDialog({ id: Number(b.dataset.e), client_id: Number(b.dataset.c) }, () => App.go('notes-review'));
    });
  }
});
