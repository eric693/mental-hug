// LINE 溝通儀表板：個案訊息的多層次人工審核
//
// 五段流程都在這一頁完成，訊息不必在群組裡轉來轉去：
// AI 初篩 → 行政初審 → 心理師擬稿 → 行政複審 → 送出給個案。

const INQ_STATUS_TONE = {
  new: 'danger', relayed: 'warn', drafted: 'danger',
  returned: 'warn', sent: 'ok', closed: ''
};
const SENTIMENT = {
  calm: ['平穩', ''], anxious: ['焦慮', 'warn'],
  upset: ['不滿', 'danger'], distress: ['明顯痛苦', 'danger']
};
const URGENCY = { high: ['急', 'danger'], normal: ['一般', ''], low: ['低', ''] };
const CATEGORIES = ['預約異動', '費用', '情緒困擾', '行政詢問', '危機疑慮', '其他'];

function inqCard(r, actions) {
  const [sLabel, sTone] = SENTIMENT[r.ai_sentiment] || ['—', ''];
  const [uLabel, uTone] = URGENCY[r.ai_urgency] || ['一般', ''];
  return `<div class="inq ${r.ai_urgency === 'high' ? 'hot' : ''}">
    <div class="inq-head">
      <div>
        <strong>#${r.id}</strong>
        ${r.client_id ? `<a href="#client/${r.client_id}">${UI.esc(r.client_name || '')}</a>` : '（未綁定個案）'}
        ${r.client_code ? `<span class="inq-code">${UI.esc(r.client_code)}</span>` : ''}
        <span class="inq-code">${UI.esc(r.created_at.slice(5, 16))}</span>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        ${UI.tag(uLabel, uTone)}${UI.tag(r.ai_category || '未分類', '')}${UI.tag(sLabel, sTone)}
        ${r.ai_flags ? UI.tag('⚠ ' + r.ai_flags, 'danger') : ''}
      </div>
    </div>
    <div class="inq-body">
      <div class="inq-label">個案原話</div>
      <div class="inq-text">${UI.nl2br(r.raw_text)}</div>
      ${r.ai_summary ? `<div class="inq-ai">AI 摘要：${UI.esc(r.ai_summary)}</div>` : ''}
      ${r.admin_note ? `<div class="inq-note">行政備註：${UI.esc(r.admin_note)}</div>` : ''}
      ${r.draft ? `<div style="margin-top:8px">
        <div class="inq-label">心理師擬稿${r.drafted_name ? `（${UI.esc(r.drafted_name)}　${UI.esc((r.drafted_at || '').slice(5, 16))}）` : ''}</div>
        <div class="inq-text draft">${UI.nl2br(r.draft)}</div></div>` : ''}
      ${r.review_note ? `<div class="inq-note warn">複審退回：${UI.esc(r.review_note)}</div>` : ''}
      ${r.final_reply ? `<div style="margin-top:8px">
        <div class="inq-label">實際送出${r.approved_name ? `（${UI.esc(r.approved_name)} 複審　${UI.esc((r.sent_at || '').slice(5, 16))}）` : ''}</div>
        <div class="inq-text sent">${UI.nl2br(r.final_reply)}</div></div>` : ''}
    </div>
    <div class="inq-foot">
      <span class="inq-status">${UI.tag(r._label, INQ_STATUS_TONE[r.status] || '')}
        ${r.counselor_name ? '　心理師：' + UI.esc(r.counselor_name) : '　尚未指派心理師'}</span>
      <div class="spacer"></div>
      ${actions}
    </div>
  </div>`;
}

App.page('inbox', {
  title: '溝通儀表板',
  sub: '個案訊息：AI 初篩 → 行政初審 → 心理師擬稿 → 行政複審 → 送出',
  module: 'line',
  async render(el) {
    let page = 1;
    const draw = async () => {
      const q = new URLSearchParams({
        status: el.querySelector('#st').value,
        urgency: el.querySelector('#ug').value,
        category: el.querySelector('#cat').value,
        mine: el.querySelector('#mine').checked ? '1' : '',
        q: el.querySelector('#iq').value.trim(),
        page, size: 30
      });
      const d = await GET('/inquiries?' + q.toString());
      const rows = d.rows.map(r => ({ ...r, _label: d.labels[r.status] || r.status }));

      const actionsFor = r => {
        const btn = (act, label, cls = 'secondary') =>
          `<button class="btn tiny ${cls}" data-act="${act}" data-id="${r.id}">${label}</button>`;
        if (r.status === 'new') return btn('relay', '初審通過 → 轉心理師', '') + btn('close', '不需回覆');
        if (['relayed', 'returned'].includes(r.status)) return btn('draft', '撰寫／代錄擬稿', '') + btn('close', '不需回覆');
        if (r.status === 'drafted') return btn('approve', '複審通過 → 送出給個案', '') + btn('return', '退回心理師', 'danger');
        return btn('retriage', '重新分類');
      };

      el.querySelector('#body').innerHTML = `
        <div class="stat-grid">
          ${Object.entries(d.labels).map(([k, label]) => `
            <div class="stat clickable" data-s="${k}">
              <div class="num ${INQ_STATUS_TONE[k] === 'danger' ? 'danger' : INQ_STATUS_TONE[k] === 'warn' ? 'warn' : ''}">${d.counts[k]}</div>
              <div class="label">${UI.esc(label)}</div></div>`).join('')}
          <div class="stat"><div class="num ${d.high ? 'danger' : ''}">${d.high}</div><div class="label">待處理中的急件</div></div>
        </div>
        ${d.ai_enabled ? '' : `<div class="notice warn" style="margin-bottom:12px">
          AI 初篩未啟用（尚未設定金鑰），目前以關鍵字規則分類。流程照常運作，只是標籤較粗略。</div>`}
        <div id="list">${rows.length ? rows.map(r => inqCard(r, actionsFor(r))).join('')
    : '<div class="empty">沒有符合條件的訊息</div>'}</div>
        ${UI.pager(d, p => { page = p; draw(); })}`;

      el.querySelectorAll('[data-s]').forEach(b => {
        b.onclick = () => { el.querySelector('#st').value = b.dataset.s; page = 1; draw(); };
      });

      el.querySelectorAll('[data-act]').forEach(b => {
        const r = rows.find(x => x.id === Number(b.dataset.id));
        b.onclick = () => {
          if (b.dataset.act === 'relay') {
            return UI.modal({
              title: `初審 #${r.id}：轉給心理師`,
              body: `<div class="notice" style="margin-bottom:10px">${UI.nl2br(r.raw_text)}</div>
                <div class="form-grid">
                  ${UI.select('counselor_id', '轉給哪位心理師', App.counselorOptions(), { value: r.counselor_id || '' })}
                  ${UI.textarea('admin_note', '給心理師的備註（會附在群組通知裡）')}
                </div>
                <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
                  群組只會收到「有一則待回覆」的提示與摘要，完整內容請心理師到這裡看——
                  個案原話含情緒與個資，不適合整段留在群組裡。</div>`,
              onSubmit: async e => { await POST(`/inquiries/${r.id}/relay`, UI.formData(e)); UI.toast('已轉給心理師'); draw(); }
            });
          }
          if (b.dataset.act === 'draft') {
            return UI.modal({
              title: `擬定回覆 #${r.id}　${r.client_name || ''}`, wide: true,
              submitText: '送出擬稿給行政複審',
              body: `<div class="notice" style="margin-bottom:10px"><strong>個案原話</strong><br>${UI.nl2br(r.raw_text)}</div>
                ${r.review_note ? `<div class="notice warn" style="margin-bottom:10px">
                  <strong>上次複審退回</strong><br>${UI.esc(r.review_note)}</div>` : ''}
                <div class="form-grid">${UI.textarea('draft', '回覆內容（會經行政複審後才送給個案）',
    { value: r.draft || '', rows: 7 })}</div>
                <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
                  這段文字之後會原樣（或經行政微調）送到個案的 LINE 對話框，請以個案讀得懂的語氣書寫。</div>`,
              onSubmit: async e => { await POST(`/inquiries/${r.id}/draft`, UI.formData(e)); UI.toast('已送出擬稿'); draw(); }
            });
          }
          if (b.dataset.act === 'approve') {
            return UI.modal({
              title: `複審 #${r.id}：確認要送給個案的內容`, wide: true,
              submitText: '確認並送出',
              body: `<div class="notice" style="margin-bottom:10px"><strong>個案原話</strong><br>${UI.nl2br(r.raw_text)}</div>
                <div class="form-grid">${UI.textarea('final_reply', '送出內容（可微調語氣與錯字，原擬稿會保留供對照）',
    { value: r.draft || '', rows: 7 })}</div>
                <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
                  送出後會立刻出現在個案的官方帳號對話框，並同步存入個案訊息串。</div>`,
              onSubmit: async e => {
                const out = await POST(`/inquiries/${r.id}/approve`, UI.formData(e));
                UI.toast(out.client && out.client.status === 'sent' ? '已送出給個案'
                  : '已標記為已回覆，但 LINE 未送出（請檢查憑證或綁定）', !(out.client && out.client.status === 'sent'));
                draw();
              }
            });
          }
          if (b.dataset.act === 'return') {
            return UI.modal({
              title: `退回擬稿 #${r.id}`,
              body: `<div class="form-grid">${UI.textarea('review_note', '請說明要修改什麼（心理師會看到）')}</div>`,
              onSubmit: async e => { await POST(`/inquiries/${r.id}/return`, UI.formData(e)); UI.toast('已退回'); draw(); }
            });
          }
          if (b.dataset.act === 'close') {
            return UI.modal({
              title: `結案 #${r.id}：不需回覆`,
              body: `<div class="form-grid">${UI.textarea('admin_note', '原因（選填）')}</div>`,
              onSubmit: async e => { await POST(`/inquiries/${r.id}/close`, UI.formData(e)); UI.toast('已結案'); draw(); }
            });
          }
          if (b.dataset.act === 'retriage') {
            return POST(`/inquiries/${r.id}/retriage`, {}).then(() => { UI.toast('已重新分類'); draw(); }).catch(UI.err);
          }
          return null;
        };
      });
    };

    el.innerHTML = `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
        <input id="iq" class="search-box" placeholder="搜尋個案／訊息內容／擬稿">
        <select id="st">
          <option value="open">待處理</option>
          <option value="new">待行政初審</option>
          <option value="relayed">待心理師擬稿</option>
          <option value="drafted">待行政複審</option>
          <option value="returned">已退回</option>
          <option value="sent">已回覆</option>
          <option value="closed">已結案</option>
          <option value="all">全部</option>
        </select>
        <select id="ug"><option value="">全部急迫度</option>
          <option value="high">急件</option><option value="normal">一般</option><option value="low">低</option></select>
        <select id="cat"><option value="">全部分類</option>
          ${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
        <label style="font-size:13px;display:flex;gap:5px;align-items:center">
          <input type="checkbox" id="mine" style="width:auto">只看我的個案</label>
        <div class="spacer"></div>
        <button class="btn secondary" id="add">代錄個案訊息</button>
      </div>
      <div id="body"></div>
      <div class="card"><h3>這條流程怎麼跑</h3>
        <div class="flow">
          <div class="flow-step"><div class="n">1</div><div><b>AI 初篩</b>
            <p>個案一傳訊息，系統立刻分類（預約異動／費用／情緒困擾／危機疑慮…）、標記情緒與急迫度，
              並抓出自傷等關鍵字。AI <strong>只做標記，不寫任何要給個案的內容</strong>；沒開 AI 時退回關鍵字規則。</p></div></div>
          <div class="flow-step"><div class="n">2</div><div><b>行政初審</b>
            <p>行政人員決定要不要轉給心理師。事務性訊息可直接結案；轉出時群組只收到摘要通知，
              個案原話留在系統裡，不整段流入群組。</p></div></div>
          <div class="flow-step"><div class="n">3</div><div><b>心理師擬稿</b>
            <p>心理師在這一頁直接寫回覆（也可以在 LINE 群組回，系統會自動收成擬稿）。</p></div></div>
          <div class="flow-step"><div class="n">4</div><div><b>行政複審</b>
            <p>行政人員看過語氣與內容，可微調錯字後放行；不妥的退回並寫明要改什麼。原擬稿保留供對照。</p></div></div>
          <div class="flow-step"><div class="n">5</div><div><b>送出給個案</b>
            <p>系統送到個案的官方帳號對話框，同時存入個案訊息串。每一段都有時間與經手人，稽核軌跡查得到。</p></div></div>
        </div></div>`;

    const reset = () => { page = 1; draw(); };
    ['#st', '#ug', '#cat', '#mine'].forEach(x => { el.querySelector(x).onchange = reset; });
    const iq = el.querySelector('#iq');
    iq.oninput = () => { clearTimeout(iq._t); iq._t = setTimeout(reset, 300); };
    el.querySelector('#add').onclick = async () => {
      const clients = await App.clientOptions(true);
      UI.modal({
        title: '代錄個案訊息',
        body: `<div class="form-grid">
          ${UI.select('client_id', '個案', clients, { full: true })}
          ${UI.textarea('raw_text', '個案說了什麼（電話或臨櫃轉述）')}</div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            代錄的訊息一樣會經過 AI 初篩與後續審核流程。</div>`,
        onSubmit: async e => { await POST('/inquiries', UI.formData(e)); UI.toast('已建立'); reset(); }
      });
    };
    await draw();
  }
});
