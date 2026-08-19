// LINE 傳話與改期簽核
// 個案在官方帳號提出請假／改期 → 系統轉到心理師群組 → 心理師回覆 →
// 行政人員在這一頁簽核 → 系統才真正改期，並同步回覆個案與群組。

const RESCHED_STATUS = {
  new: ['待轉達', 'warn'],
  relayed: ['待心理師回覆', 'warn'],
  replied: ['待行政簽核', 'danger'],
  approved: ['已簽核改期', 'ok'],
  rejected: ['已退回', ''],
  closed: ['已結束', '']
};

function reschedApproveModal(r) {
  const minutes = App.meta.session_minutes || 50;
  UI.modal({
    title: `簽核改期 #${r.id}　${r.client_name || ''}`,
    wide: true,
    submitText: '簽核並同步通知',
    body: `
      <div style="font-size:13.5px;background:var(--primary-light);padding:10px;border-radius:8px;margin-bottom:12px">
        <div><strong>原訂</strong>：${UI.esc(r.date || '（無對應預約）')} ${UI.esc(r.date ? r.start_time + '-' + r.end_time : '')}
          　心理師 ${UI.esc(r.counselor_name || '未指定')}</div>
        <div style="margin-top:6px"><strong>個案訊息</strong>：${UI.nl2br(r.raw_text)}</div>
        <div style="margin-top:6px"><strong>心理師回覆</strong>：${r.counselor_reply ? UI.nl2br(r.counselor_reply) : '（尚未回覆）'}</div>
      </div>
      <div class="form-grid">
        ${UI.input('new_date', '新日期', { type: 'date', value: r.date || UI.today(), required: true })}
        ${UI.input('new_start_time', '新時間（起）', { type: 'time', value: r.start_time || '', required: true })}
        ${UI.input('new_end_time', `新時間（迄，留空自動 +${minutes} 分）`, { type: 'time', value: '' })}
        ${UI.select('counselor_id', '心理師', App.counselorOptions(), { value: r.counselor_id || '' })}
        ${UI.textarea('decision_note', '簽核備註（僅存於系統，不會傳給個案）')}
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
        簽核後系統會檢查心理師與諮商室時段衝突，通過才改期；接著把新時間送到個案的官方帳號對話框與心理師群組。</div>`,
    onSubmit: async e => {
      const out = await POST(`/reschedule-requests/${r.id}/approve`, UI.formData(e));
      const note = [out.client, out.group].some(x => x && x.status !== 'sent')
        ? '已改期；部分 LINE 通知未送出（請看下方傳話軌跡）' : '已改期並同步通知';
      UI.toast(note);
      App.go('reschedule');
    }
  });
}

App.page('reschedule', {
  title: '改期簽核',
  sub: '個案由 LINE 提出的請假／改期，經心理師回覆後在此簽核並同步通知',
  module: 'line',
  async render(el) {
    const draw = async () => {
      const status = el.querySelector('#st').value;
      const rows = await GET('/reschedule-requests?status=' + encodeURIComponent(status));
      el.querySelector('#list').innerHTML = UI.table(
        ['#', '收到時間', '個案', '心理師', '原訂時段', '個案訊息', '心理師回覆', '狀態', ''],
        rows.map(r => {
          const [label, tone] = RESCHED_STATUS[r.status] || [r.status, ''];
          return `<tr>
            <td>${r.id}</td>
            <td style="white-space:nowrap">${UI.esc(r.created_at.slice(5, 16))}</td>
            <td>${r.client_id ? `<a href="#client/${r.client_id}">${UI.esc(r.client_name || '')}</a>` : '-'}
              ${r.client_code ? `<div style="font-size:12px;color:var(--muted)">${UI.esc(r.client_code)}</div>` : ''}</td>
            <td>${UI.esc(r.counselor_name || '未指定')}</td>
            <td style="white-space:nowrap">${r.date ? `${r.date}<br>${r.start_time}-${r.end_time}` : '-'}</td>
            <td style="font-size:13px;max-width:220px">${UI.nl2br(r.raw_text)}</td>
            <td style="font-size:13px;max-width:220px">${r.counselor_reply ? UI.nl2br(r.counselor_reply) : '-'}</td>
            <td>${UI.tag(label, tone)}${r.kind === 'cancel' ? UI.tag('請假取消', '') : ''}</td>
            <td style="white-space:nowrap">
              ${['approved', 'rejected'].includes(r.status) ? ''
    : `<button class="btn tiny" data-ap="${r.id}">簽核改期</button>
                 <button class="btn tiny secondary" data-rp="${r.id}">代錄回覆</button>
                 <button class="btn tiny secondary" data-rl="${r.id}">重送群組</button>
                 <button class="btn tiny danger" data-rj="${r.id}">退回</button>`}
            </td></tr>`;
        }), '目前沒有改期申請');

      el.querySelectorAll('[data-ap]').forEach(b => {
        b.onclick = () => reschedApproveModal(rows.find(x => x.id === Number(b.dataset.ap)));
      });
      el.querySelectorAll('[data-rp]').forEach(b => {
        b.onclick = () => UI.modal({
          title: '代錄心理師回覆',
          body: `<div class="form-grid">${UI.textarea('counselor_reply', '心理師回覆內容（電話或口頭告知時使用）')}</div>`,
          onSubmit: async e => {
            await POST(`/reschedule-requests/${b.dataset.rp}/reply`, UI.formData(e));
            UI.toast('已記錄');
            draw();
          }
        });
      });
      el.querySelectorAll('[data-rl]').forEach(b => {
        b.onclick = async () => {
          try {
            const out = await POST(`/reschedule-requests/${b.dataset.rl}/relay`, {});
            UI.toast(out.status === 'sent' ? '已重新送到心理師群組'
              : out.status === 'skipped' ? '尚未設定 LINE 群組或憑證，僅留紀錄' : '送出失敗：' + (out.message || ''),
            out.status === 'failed');
            draw();
          } catch (e) { UI.err(e); }
        };
      });
      el.querySelectorAll('[data-rj]').forEach(b => {
        b.onclick = () => UI.modal({
          title: '退回改期申請',
          body: `<div class="form-grid">${UI.textarea('decision_note', '退回原因（僅存於系統）')}
            ${UI.checkbox('notify', '同時以 LINE 請個案來電確認', true)}</div>`,
          onSubmit: async e => {
            const d = UI.formData(e);
            await POST(`/reschedule-requests/${b.dataset.rj}/reject`, d);
            UI.toast('已退回');
            draw();
          }
        });
      });
    };

    el.innerHTML = `<div class="toolbar">
        ${UI.select('st', '狀態', [['open', '待處理'], ['replied', '待行政簽核'], ['approved', '已簽核'], ['rejected', '已退回'], ['all', '全部']], { value: 'open' })}
        <div class="spacer"></div>
        <button class="btn secondary" id="add">櫃檯代錄申請</button></div>
      <div class="card" id="list"></div>
      <div class="card"><h3>怎麼運作</h3>
        <ol style="font-size:13.5px;line-height:1.9;padding-left:20px;color:var(--muted)">
          <li>個案在官方帳號傳「改期／請假」等關鍵字的訊息（關鍵字可於系統設定調整）。</li>
          <li>系統自動抓出他最近一筆有效預約，把原話轉到該心理師的 LINE 群組，並回覆個案已收到。</li>
          <li>心理師直接在群組回覆；多筆同時進行時在訊息裡寫 <code>#編號</code> 指定。</li>
          <li>行政人員在這一頁按「簽核改期」填入新時段，系統檢查衝突後才真正改期。</li>
          <li>改期完成同時送到個案的對話框與心理師群組。</li>
        </ol></div>`;
    el.querySelector('#st').onchange = draw;
    el.querySelector('#add').onclick = async () => {
      const appts = await GET('/appointments?from=' + UI.today() + '&status=booked');
      UI.modal({
        title: '櫃檯代錄改期申請',
        body: `<div class="form-grid">
          ${UI.select('appointment_id', '要改期的預約',
    appts.map(a => [a.id, `${a.date} ${a.start_time} ${a.client_name}（${a.counselor_name || '未指定'}）`]), { full: true })}
          ${UI.select('kind', '類型', [['reschedule', '改期'], ['cancel', '請假取消']])}
          ${UI.textarea('raw_text', '個案表達的需求（會原文轉給心理師群組）')}</div>`,
        onSubmit: async e => {
          await POST('/reschedule-requests', UI.formData(e));
          UI.toast('已登記並轉達');
          App.go('reschedule');
        }
      });
    };
    await draw();
  }
});

// ---- LINE 綁定與傳話軌跡 ----
App.page('line', {
  title: 'LINE 傳話設定',
  sub: '官方帳號綁定狀態、心理師群組與訊息軌跡',
  module: 'line',
  async render(el) {
    const [st, events] = await Promise.all([GET('/line/status'), GET('/line/events')]);
    el.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="num ${st.enabled ? '' : 'warn'}">${st.enabled ? '已啟用' : '未啟用'}</div>
          <div class="label">Messaging API 憑證</div></div>
        <div class="stat"><div class="num">${st.bound_clients}/${st.active_clients}</div><div class="label">個案已綁定官方帳號</div></div>
        <div class="stat"><div class="num ${st.counselors.filter(c => c.line_group_id).length ? '' : 'warn'}">${st.counselors.filter(c => c.line_group_id).length}/${st.counselors.length}</div>
          <div class="label">心理師已設定群組</div></div>
      </div>
      <div class="card"><h3>接上官方帳號</h3>
        <ol style="font-size:13.5px;line-height:1.9;padding-left:20px">
          <li>在 LINE Developers 建立 Messaging API channel，取得 <strong>Channel secret</strong> 與 <strong>Channel access token</strong>，填到「系統設定 → LINE 傳話機器人」。</li>
          <li>Webhook URL 設為 <code>${UI.esc(location.origin)}/line/webhook</code> 並開啟 Use webhook。</li>
          <li>把官方帳號加進每位心理師的工作群組，於下方填入該群組的 groupId（可從 webhook 軌跡讀到）。</li>
          <li>請個案加官方帳號好友，傳「綁定 手機號碼」完成身分對應。</li>
        </ol>
        <div style="font-size:12.5px;color:var(--muted)">憑證未填之前，流程仍可在系統內完整跑（申請、代錄回覆、簽核改期），只是不會對外送訊息。</div>
      </div>
      <div class="card"><h3>心理師群組</h3>
        ${UI.table(['心理師', 'LINE groupId', ''], st.counselors.map(c => `<tr>
          <td>${UI.esc(c.name)}</td>
          <td style="font-family:monospace;font-size:12.5px">${UI.esc(c.line_group_id || '（未設定，改用預設群組）')}</td>
          <td><button class="btn tiny secondary" data-g="${c.id}" data-n="${UI.esc(c.name)}" data-v="${UI.esc(c.line_group_id)}">設定</button></td>
        </tr>`))}</div>
      <div class="card"><h3>傳話軌跡（最近 200 筆）</h3>
        ${UI.table(['時間', '方向', '對象', '個案／心理師', '內容', '狀態'], events.map(e => `<tr>
          <td style="white-space:nowrap">${UI.esc(e.created_at.slice(5, 16))}</td>
          <td>${e.direction === 'in' ? '收到' : '送出'}</td>
          <td>${e.source_type === 'group' ? '心理師群組' : e.source_type === 'user' ? '個案' : '-'}</td>
          <td>${UI.esc(e.client_name || e.counselor_name || '-')}</td>
          <td style="font-size:13px;max-width:360px">${UI.nl2br(e.text)}</td>
          <td>${e.status === 'ok' ? UI.tag('正常', 'ok')
    : e.status === 'skipped' ? UI.tag('未送出（' + e.error + '）', 'warn')
      : UI.tag('失敗：' + e.error, 'danger')}</td></tr>`), '尚無傳話紀錄')}
      </div>`;
    el.querySelectorAll('[data-g]').forEach(b => {
      b.onclick = () => UI.modal({
        title: `設定 ${b.dataset.n} 的 LINE 群組`,
        body: `<div class="form-grid">${UI.input('line_group_id', 'groupId（留空表示改用預設群組）', { value: b.dataset.v, full: true })}</div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            把官方帳號拉進群組後，群組裡隨便傳一則訊息，就能在上方「傳話軌跡」看到該群組的 groupId。</div>`,
        onSubmit: async e => {
          await PUT(`/line/counselors/${b.dataset.g}/group`, UI.formData(e));
          UI.toast('已設定');
          App.go('line');
        }
      });
    });
  }
});
