// 團體諮商：團體、成員名單、聚會場次與出席、團體歷程紀錄

function groupDialog(g, onDone) {
  const isNew = !g;
  const d = g || { capacity: 8, sessions_total: 8, fee_per_session: 800, status: 'open', counselor_id: App.me.id };
  UI.modal({
    title: isNew ? '新增團體' : '編輯團體',
    wide: true,
    body: `<div class="form-grid">
      ${UI.input('name', '團體名稱', { value: d.name || '', required: true, full: true })}
      ${UI.select('counselor_id', '帶領者', App.counselorOptions(), { value: d.counselor_id })}
      ${UI.select('co_counselor_id', '協同帶領者', [['', '無']].concat(App.counselorOptions()), { value: d.co_counselor_id || '' })}
      ${UI.select('partner_id', '委辦單位', [['', '無（自辦）']].concat((App.meta.partners || []).map(p => [p.id, p.name])), { value: d.partner_id || '' })}
      ${UI.input('capacity', '人數上限', { type: 'number', value: d.capacity })}
      ${UI.input('sessions_total', '總場次', { type: 'number', value: d.sessions_total })}
      ${UI.input('fee_per_session', '每次費用', { type: 'number', value: d.fee_per_session })}
      ${UI.input('start_date', '開始日期', { type: 'date', value: d.start_date || '' })}
      ${UI.input('end_date', '結束日期', { type: 'date', value: d.end_date || '' })}
      ${g ? UI.select('status', '狀態', [['open', '招募中'], ['running', '進行中'], ['done', '已結束']], { value: d.status }) : ''}
      ${UI.textarea('description', '團體簡介與收案條件', { value: d.description || '' })}
    </div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      if (isNew) await POST('/groups', data); else await PUT(`/groups/${d.id}`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

App.page('groups', {
  title: '團體諮商',
  sub: '團體名單、場次排程與出席；歷程紀錄僅帶領者、督導與管理者可讀',
  module: 'groups',
  async render(el) {
    const draw = async () => {
      const st = el.querySelector('#st').value;
      const q = el.querySelector('#gq').value.trim();
      let rows = await GET('/groups' + (st ? '?status=' + st : ''));
      if (q) rows = rows.filter(g => (g.name + (g.counselor_name || '') + (g.co_counselor_name || '') + (g.partner_name || '')).includes(q));
      el.querySelector('#list').innerHTML = `<div class="card">${
        UI.table(['團體', '帶領者', '委辦單位', '成員', '場次', '每次費用', '期間', '狀態', ''],
          rows.map(g => `<tr>
            <td><strong>${UI.esc(g.name)}</strong></td>
            <td>${UI.esc(g.counselor_name || '')}${g.co_counselor_name ? '／' + UI.esc(g.co_counselor_name) : ''}</td>
            <td>${UI.esc(g.partner_name || '自辦')}</td>
            <td>${g.member_count}/${g.capacity}</td>
            <td>${g.done_sessions}/${g.sessions_total}</td>
            <td>${UI.fmtMoney(g.fee_per_session)}</td>
            <td>${g.start_date || '-'} ~ ${g.end_date || '-'}</td>
            <td>${UI.tag(TW.group_status[g.status] || g.status, g.status === 'running' ? 'primary' : g.status === 'open' ? 'warn' : '')}</td>
            <td><button class="btn tiny" data-g="${g.id}">管理</button></td></tr>`), '沒有符合條件的團體')}</div>`;
      el.querySelectorAll('[data-g]').forEach(b => { b.onclick = () => App.go('group/' + b.dataset.g); });
    };
    el.innerHTML = `<div class="toolbar">
        <input id="gq" placeholder="搜尋團體／帶領者／委辦單位">
        <select id="st"><option value="">全部狀態</option>${
          Object.entries(TW.group_status).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <div class="spacer"></div><button class="btn" id="add">新增團體</button>
      </div><div id="list"></div>`;
    el.querySelector('#add').onclick = () => groupDialog(null, () => App.go('groups'));
    el.querySelector('#gq').oninput = () => { clearTimeout(el._t); el._t = setTimeout(draw, 300); };
    el.querySelector('#st').onchange = draw;
    await draw();
  }
});

App.page('group', {
  title: '團體管理',
  module: 'groups',
  async render(el, id) {
    if (!id) return App.go('groups');
    const g = await GET(`/groups/${id}`);
    document.querySelector('.page-title').textContent = g.name;
    document.querySelector('.page-sub').textContent =
      `${g.counselor_name || ''}${g.co_counselor_name ? '／' + g.co_counselor_name : ''}　` +
      `${TW.group_status[g.status] || g.status}　成員 ${g.members.filter(m => m.status === 'active').length}/${g.capacity}` +
      (g.can_view_note ? '' : '　（您無此團體的歷程紀錄存取權）');

    el.innerHTML = `<div class="toolbar">
        <button class="btn small secondary" id="edit">編輯團體</button>
        <button class="btn small" id="addm">加入成員</button>
        <button class="btn small secondary" id="adds">新增場次</button>
        <div class="spacer"></div>
        <button class="btn small danger" id="delg">刪除團體</button>
        <a class="btn small secondary" href="#groups">回列表</a>
      </div>
      ${g.description ? `<div class="card"><h3>團體簡介</h3><div style="font-size:14px">${UI.nl2br(g.description)}</div></div>` : ''}
      <div class="card"><h3>成員名單</h3>
        ${UI.table(['個案', '風險', '加入日', '狀態', ''], g.members.map(m => `<tr>
          <td><a href="#client/${m.client_id}">${UI.esc(m.client_name)}（${m.client_code}）</a></td>
          <td>${stateTag('risk_level', m.risk_level)}</td>
          <td>${m.joined_at}</td>
          <td>${m.status === 'active' ? UI.tag('參與中', 'ok') : UI.tag('已退出')}</td>
          <td style="white-space:nowrap">${m.status === 'active' ? `<button class="btn tiny secondary" data-drop="${m.id}">標記退出</button>` : ''}
            <button class="btn tiny danger" data-mdel="${m.id}">移除</button></td></tr>`), '尚無成員')}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          已有出席紀錄的成員移除時會自動改為「退出」，出席與計費紀錄保留。</div></div>
      <div class="card"><h3>場次</h3>
        ${UI.table(['場次', '日期', '時間', '諮商室', '主題', '出席', '狀態', ''], g.sessions.map(s => `<tr>
          <td>第 ${s.session_no} 次</td><td>${s.date}</td><td>${s.start_time}-${s.end_time}</td>
          <td>${UI.esc(s.room_name || '-')}</td><td>${UI.esc(s.topic || '-')}</td>
          <td>${s.status === 'done' ? s.present + ' 人' : '-'}</td>
          <td>${UI.tag(TW.gs_status[s.status] || s.status, s.status === 'done' ? 'ok' : 'warn')}</td>
          <td><button class="btn tiny ${s.status === 'done' ? 'secondary' : ''}" data-s="${s.id}">
            ${s.status === 'done' ? '檢視紀錄' : '點名／紀錄'}</button>
            ${s.status !== 'done' ? `<button class="btn tiny danger" data-ds="${s.id}">刪除</button>` : ''}</td></tr>`), '尚未排定場次')}</div>`;

    el.querySelector('#edit').onclick = () => groupDialog(g, () => App.go('group/' + id));
    el.querySelector('#addm').onclick = async () => {
      const clients = await App.clientOptions(true);
      UI.modal({
        title: '加入成員',
        body: `<div class="form-grid">${UI.select('client_id', '個案', clients, { full: true })}</div>`,
        onSubmit: async e => { await POST(`/groups/${id}/members`, UI.formData(e)); UI.toast('已加入'); App.go('group/' + id); }
      });
    };
    el.querySelector('#adds').onclick = () => UI.modal({
      title: '新增場次',
      body: `<div class="form-grid">
        ${UI.input('date', '日期', { type: 'date', value: UI.today() })}
        ${UI.input('start_time', '開始', { type: 'time', value: '19:00' })}
        ${UI.input('end_time', '結束', { type: 'time', value: '21:00' })}
        ${UI.select('room_id', '諮商室', App.roomOptions())}
        ${UI.inputList('topic', '主題', App.meta.group_topics || [], { full: true })}</div>`,
      onSubmit: async e => { await POST(`/groups/${id}/sessions`, UI.formData(e)); UI.toast('已新增'); App.go('group/' + id); }
    });
    el.querySelector('#delg').onclick = async () => {
      if (!await UI.confirm(`確定刪除團體「${g.name}」？成員名單與未進行的場次會一併移除。`)) return;
      try { await DEL(`/groups/${id}`); UI.toast('已刪除'); App.go('groups'); } catch (e) { UI.err(e); }
    };
    el.querySelectorAll('[data-drop]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('將此成員標記為已退出？')) return;
        await PUT(`/group-members/${b.dataset.drop}`, { status: 'dropped' });
        App.go('group/' + id);
      };
    });
    el.querySelectorAll('[data-mdel]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('把此成員從名單移除？已有出席紀錄的話會改標為退出。')) return;
        try {
          const r = await DEL(`/group-members/${b.dataset.mdel}`);
          UI.toast(r.message || '已移除');
          App.go('group/' + id);
        } catch (e) { UI.err(e); }
      };
    });
    el.querySelectorAll('[data-ds]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('刪除此場次？')) return;
        try { await DEL(`/group-sessions/${b.dataset.ds}`); App.go('group/' + id); } catch (e) { UI.err(e); }
      };
    });
    el.querySelectorAll('[data-s]').forEach(b => {
      b.onclick = async () => {
        const s = await GET(`/group-sessions/${b.dataset.s}`);
        const done = s.status === 'done';
        UI.modal({
          title: `第 ${s.session_no} 次　${s.date}`,
          wide: true,
          hideFooter: done,
          submitText: '完成場次並存檔',
          body: `<div class="form-grid">
              ${UI.inputList('topic', '主題', App.meta.group_topics || [], { value: s.topic, full: true })}
            </div>
            <div class="form-row full" style="margin-top:10px"><label>出席點名</label>
              <div>${s.attendance.map(a => `<label class="check-item" style="cursor:pointer">
                <input type="checkbox" class="att" data-c="${a.client_id}"${a.attended ? ' checked' : ''}${done ? ' disabled' : ''}>
                <span class="ci-text">${UI.esc(a.client_name)}（${a.client_code}）</span></label>`).join('') || '<div class="empty">此團體尚無成員</div>'}</div></div>
            ${s.can_view_note
    ? (done
      ? `<div class="form-row full"><label>團體歷程紀錄</label>
                  <div style="white-space:pre-wrap;font-size:14px;padding:10px;background:#f7f9fa;border-radius:8px">${UI.esc(s.process_note || '—')}</div></div>`
      : UI.textarea('process_note', '團體歷程紀錄（成員互動、主題進展、需追蹤事項）', { value: s.process_note, rows: 6 }))
    : '<div style="font-size:13px;color:var(--muted);margin-top:10px">您無此團體的歷程紀錄存取權。</div>'}
            ${!done ? `<div style="font-size:12.5px;color:var(--muted);margin-top:10px">
              完成後將依團體收費為出席者產生收費單（合作單位付費之個案不另開單）。</div>` : ''}`,
          onSubmit: async el2 => {
            const attendance = [...el2.querySelectorAll('.att')].map(c => ({ client_id: Number(c.dataset.c), attended: c.checked }));
            const d = UI.formData(el2);
            await POST(`/group-sessions/${s.id}/complete`, { ...d, attendance });
            UI.toast('已完成');
            App.go('group/' + id);
          }
        });
      };
    });
  }
});
