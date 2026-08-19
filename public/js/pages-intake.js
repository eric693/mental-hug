// 來電登記與派案：來電 → 評估 → 派案 → 初談建檔／候補

function intakeDialog(row, onDone) {
  const isNew = !row;
  const d = row || { urgency: 'normal', gender: 'female' };
  UI.modal({
    title: isNew ? '新增來電登記' : '編輯來電登記',
    wide: true,
    body: `<div class="form-grid">
      ${UI.input('name', '姓名', { value: d.name || '', required: true })}
      ${UI.input('phone', '聯絡電話', { value: d.phone || '' })}
      ${UI.select('gender', '性別', App.enumOptions('gender'), { value: d.gender })}
      ${UI.input('birth_date', '出生日期', { type: 'date', value: d.birth_date || '' })}
      ${UI.input('id_no', '身分證統一編號／居留證號', { value: d.id_no || '', placeholder: '可留待建檔時補填' })}
      ${UI.inputList('source', '來源', App.meta.source_options || [], { value: d.source || '' })}
      ${UI.input('referrer', '轉介單位／人', { value: d.referrer || '' })}
      ${UI.select('partner_id', '合作單位（如為委託案）', [['', '無']].concat((App.meta.partners || []).map(p => [p.id, p.name])), { value: d.partner_id || '' })}
      ${UI.select('preferred_counselor_id', '指定心理師', [['', '不指定']].concat(App.counselorOptions()), { value: d.preferred_counselor_id || '' })}
      ${UI.input('preferred_time', '希望時段', { value: d.preferred_time || '', placeholder: '例：平日晚上、週六上午' })}
      ${UI.select('urgency', '緊急程度', [['low', '低'], ['normal', '一般'], ['high', '高（危機或自傷風險）']], { value: d.urgency })}
      ${UI.checkbox('is_minor', '未成年（需法定代理人同意）', d.is_minor)}
      ${UI.textarea('issue', '來電主訴', { value: d.issue || '' })}
      ${UI.textarea('note', '接聽備註', { value: d.note || '' })}
    </div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      if (isNew) await POST('/intakes', data); else await PUT(`/intakes/${d.id}`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

App.page('intake', {
  title: '來電登記與派案',
  sub: '來電 → 評估派案 → 初談建檔；滿檔時列入候補',
  module: 'intake',
  async render(el) {
    const draw = async () => {
      const status = el.querySelector('#st').value;
      const q = el.querySelector('#q').value.trim();
      const rows = await GET(`/intakes?status=${status}&q=${encodeURIComponent(q)}`);
      el.querySelector('#list').innerHTML = UI.table(
        ['登記時間', '等候', '姓名', '電話', '來源', '主訴', '希望時段', '指定／派案', '緊急', '問卷', '狀態', ''],
        rows.map(r => `<tr${r.urgency === 'high' ? ' style="background:var(--danger-bg)"' : ''}>
          <td>${UI.esc((r.created_at || '').slice(0, 16))}</td>
          <td>${r.wait_days > 14 ? `<span style="color:var(--danger);font-weight:700">${r.wait_days} 天</span>` : r.wait_days + ' 天'}</td>
          <td><strong>${UI.esc(r.name)}</strong>${r.is_minor ? UI.tag('未成年') : ''}</td>
          <td>${UI.esc(r.phone)}</td>
          <td>${UI.esc(r.source)}${r.partner_name ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(r.partner_name) + '</span>' : ''}</td>
          <td class="wrap narrow">${UI.esc((r.issue || '').slice(0, 40))}</td>
          <td>${UI.esc(r.preferred_time || '-')}</td>
          <td>${UI.esc(r.assigned_name || r.preferred_name || '-')}</td>
          <td>${UI.tag(({ low: '低', normal: '一般', high: '高' })[r.urgency], r.urgency === 'high' ? 'danger' : r.urgency === 'normal' ? '' : 'ok')}</td>
          <td style="white-space:nowrap">${r.form_status === 'done' || r.form_status === 'used'
    ? `<button class="btn tiny secondary" data-fv="${r.id}">已填${r.form_bsrs_total >= 0 ? `（BSRS ${r.form_bsrs_total}${r.form_bsrs_alert ? '⚠' : ''}）` : ''}</button>`
    : r.form_status === 'sent' ? `<button class="btn tiny secondary" data-fl="${r.id}">連結</button>`
      : `<button class="btn tiny secondary" data-fs="${r.id}">產生問卷</button>`}</td>
          <td>${UI.tag(TW.intake_status[r.status] || r.status, r.status === 'new' ? 'warn' : r.status === 'assigned' ? 'primary' : '')}</td>
          <td style="white-space:nowrap">
            <button class="btn tiny secondary" data-e="${r.id}">編輯</button>
            ${r.status !== 'converted' ? `<button class="btn tiny" data-a="${r.id}">派案</button>
              <button class="btn tiny warn" data-cv="${r.id}">建檔</button>
              <button class="btn tiny danger" data-cl="${r.id}">結束</button>
              <button class="btn tiny danger" data-dl="${r.id}">刪除</button>` : `<a class="btn tiny secondary" href="#client/${r.client_id}">個案</a>`}
          </td></tr>`),
        '沒有待處理的來電登記');

      el.querySelectorAll('[data-e]').forEach(b => {
        b.onclick = () => intakeDialog(rows.find(r => r.id === Number(b.dataset.e)), draw);
      });
      // 誤登的來電才用刪除；已建檔的走「結束」保留軌跡
      el.querySelectorAll('[data-dl]').forEach(b => {
        const r = rows.find(x => x.id === Number(b.dataset.dl));
        b.onclick = async () => {
          if (!await UI.confirm(`刪除「${r.name}」的來電登記？此動作不可復原（若只是不成案，請改用「結束」）。`)) return;
          try { await DEL(`/intakes/${r.id}`); UI.toast('已刪除'); draw(); } catch (e) { UI.err(e); }
        };
      });
      el.querySelectorAll('[data-a]').forEach(b => {
        b.onclick = () => UI.modal({
          title: '派案',
          body: `<div class="form-grid">${UI.select('counselor_id', '指派心理師', App.counselorOptions(), { full: true })}</div>
            <div style="font-size:12.5px;color:var(--muted);margin-top:10px">
              派案後仍未建檔，等初談確認到所再建立個案資料。</div>`,
          onSubmit: async e => { await POST(`/intakes/${b.dataset.a}/assign`, UI.formData(e)); UI.toast('已派案'); draw(); }
        });
      });
      el.querySelectorAll('[data-cv]').forEach(b => {
        const r = rows.find(x => x.id === Number(b.dataset.cv));
        b.onclick = () => UI.modal({
          title: `建檔：${r.name}`,
          wide: true,
          submitText: '建立個案',
          body: `<div class="form-grid">
            ${UI.select('counselor_id', '主責心理師', App.counselorOptions(), { value: r.assigned_counselor_id || r.preferred_counselor_id || '' })}
            <div class="form-row full"><label style="font-weight:600;color:var(--text)">一併安排初談（選填）</label></div>
            ${UI.input('date', '初談日期', { type: 'date' })}
            ${UI.input('start_time', '時間', { type: 'time', value: '14:00' })}
            ${UI.select('room_id', '諮商室', App.roomOptions())}
          </div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:10px">
            建檔後會自動產生個案編號，個案端預設密碼為手機末 6 碼。
            ${r.form_status === 'done' ? '<br><strong>此登記已有個案自填的初談問卷，聯絡資料、主訴與量表結果會一併帶入。</strong>' : ''}</div>`,
          onSubmit: async e => {
            const r2 = await POST(`/intakes/${b.dataset.cv}/convert`, UI.formData(e));
            UI.toast(`已建檔：${r2.code}`);
            location.hash = 'client/' + r2.client_id;
          }
        });
      });
      // 初談問卷：產生免登入連結給來電者填寫，填完可直接檢視內容
      const showFormLink = (token, expires) => UI.modal({
        title: '初談問卷連結', hideFooter: true,
        body: `<div style="font-size:14px;line-height:1.9">
            把下列連結用簡訊或 LINE 傳給來電者，填寫後建檔時會自動帶入。
            ${expires ? `<br>有效期限至 <strong>${UI.esc(expires)}</strong>。` : ''}
            <div style="font-size:12.5px;color:var(--muted);margin-top:6px">
              連結本身即是憑證，請只傳給本人；逾期後可再產生新的連結。</div>
          </div>
          <div style="background:#f7f9fa;border-radius:8px;padding:10px;margin-top:10px;word-break:break-all;font-size:13px" id="lk">${UI.esc(location.origin)}/intake-form.html?t=${UI.esc(token)}</div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn small" id="cp">複製連結</button>
            <a class="btn small secondary" href="/intake-form.html?t=${UI.esc(token)}" target="_blank" rel="noopener">預覽</a>
          </div>`,
        onOpen: body => {
          body.querySelector('#cp').onclick = () => navigator.clipboard.writeText(body.querySelector('#lk').textContent)
            .then(() => UI.toast('已複製')).catch(() => UI.toast('請手動選取複製', true));
        }
      });
      el.querySelectorAll('[data-fs]').forEach(b => {
        b.onclick = async () => {
          try {
            const r = await POST(`/intakes/${b.dataset.fs}/form`, {});
            showFormLink(r.token, r.expires_at);
            draw();
          } catch (e) { UI.err(e); }
        };
      });
      el.querySelectorAll('[data-fl]').forEach(b => {
        b.onclick = async () => {
          try { const f = await GET(`/intakes/${b.dataset.fl}/form`); showFormLink(f.token, f.expires_at); }
          catch (e) { UI.err(e); }
        };
      });
      el.querySelectorAll('[data-fv]').forEach(b => {
        b.onclick = async () => {
          const f = await GET(`/intakes/${b.dataset.fv}/form`);
          const g = (l, v) => `<div><div class="dg-label">${l}</div>${UI.esc(v || '-')}</div>`;
          UI.modal({
            title: `初談問卷：${f.name}`, wide: true, hideFooter: true,
            body: `<div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">
                填寫時間 ${UI.esc(f.submitted_at || '-')}　${f.status === 'used' ? '（已於建檔時帶入）' : ''}</div>
              <div class="detail-grid">
                ${g('姓名', f.name)}${g('手機', f.phone)}${g('性別', TW.gender[f.gender])}${g('出生日期', f.birth_date)}
                ${g('Email', f.email)}${g('地址', f.address)}${g('職業／就學', f.occupation)}${g('婚姻', f.marital)}
                ${g('緊急聯絡人', `${f.emergency_name} ${f.emergency_relationship} ${f.emergency_phone}`)}
                ${g('法定代理人', `${f.guardian_name} ${f.guardian_relationship} ${f.guardian_phone}`)}
                ${g('方便時段', f.preferred_time)}${g('得知來源', f.source)}
              </div>
              <div class="card" style="margin-top:12px;font-size:14px;line-height:1.8">
                <strong>主要困擾：</strong>${UI.nl2br(f.main_issue) || '—'}<br>
                <strong>就醫／諮商史：</strong>${UI.nl2br(f.history) || '—'}<br>
                <strong>對諮商的期待：</strong>${UI.nl2br(f.expectation) || '—'}</div>
              ${f.bsrs_total >= 0 ? `<div class="notice ${f.bsrs_alert ? 'danger' : ''}" style="margin-top:10px">
                BSRS-5 心情溫度計：<strong>${f.bsrs_total}</strong> 分
                ${f.bsrs_alert ? '；附加題（自殺意念）達 2 分以上，請優先安排並於初談前完成風險評估。' : ''}
                <br><span style="font-size:12.5px">建檔時會一併轉為量表紀錄，作為療效追蹤的基線。</span></div>` : ''}`
          });
        };
      });
      el.querySelectorAll('[data-cl]').forEach(b => {
        b.onclick = () => UI.modal({
          title: '結束此登記',
          body: `<div class="form-grid">${UI.inputList('close_reason', '原因',
            ['未再回電', '轉介他處', '自行取消', '不符服務範圍', '費用考量'], { full: true })}</div>`,
          onSubmit: async e => { await POST(`/intakes/${b.dataset.cl}/close`, UI.formData(e)); draw(); }
        });
      });
    };
    el.innerHTML = `<div class="toolbar">
        <select id="st"><option value="">待處理＋候補＋已派案</option>
          <option value="new">待處理</option><option value="waiting">候補中</option>
          <option value="assigned">已派案</option><option value="converted">已建檔</option>
          <option value="closed">未成案</option></select>
        <input id="q" placeholder="搜尋姓名／電話">
        <div class="spacer"></div><button class="btn" id="add">新增來電登記</button>
      </div><div id="list"></div>`;
    el.querySelector('#st').onchange = draw;
    el.querySelector('#q').oninput = () => { clearTimeout(el._t); el._t = setTimeout(draw, 300); };
    el.querySelector('#add').onclick = () => intakeDialog(null, draw);
    await draw();
  }
});

// ---- 明日晤談提醒 ----
App.page('reminders', {
  title: '晤談提醒',
  sub: '設定發送通道後可由系統送出；未設定時產生可複製的訊息供人工發送',
  module: 'schedule',
  async render(el) {
    const date = (el.querySelector('#d') && el.querySelector('#d').value) || UI.addDays(UI.today(), 1);
    const d = await GET('/reminders?date=' + date);
    const auto = App.meta.notify_enabled;
    el.innerHTML = `<div class="toolbar"><label>日期</label><input id="d" type="date" value="${d.date}">
        <div class="spacer"></div>
        <button class="btn secondary small" id="log">發送紀錄</button>
        ${auto ? '<button class="btn small" id="sendall">全部發送</button>' : ''}
        <button class="btn secondary small" id="copyall">複製全部</button></div>
      <div class="notice ${auto ? 'ok' : ''}" style="margin-bottom:14px">
        ${auto ? '已設定發送通道，按「發送」由系統送出簡訊／LINE，結果會記入發送紀錄。'
          : '尚未設定發送通道（系統設定 → 提醒發送通道），目前僅產生訊息供人工發送。'}</div>
      <div class="card">
        ${d.rows.length ? d.rows.map(r => `<div style="border-bottom:1px dashed var(--border);padding:10px 0">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <strong>${r.start_time}</strong> ${UI.esc(r.client_name)}
            <span style="color:var(--muted);font-size:13px">${UI.esc(r.counselor_name || '')}　${UI.esc(r.client_phone || '')}</span>
            ${r.reminded_at ? UI.tag('已通知 ' + UI.esc(r.reminded_at.slice(5, 16)), 'ok') : UI.tag('未通知', 'warn')}
            <span class="spacer" style="flex:1"></span>
            <button class="btn tiny secondary" data-copy="${r.id}">複製訊息</button>
            <button class="btn tiny" data-done="${r.id}">${auto ? '發送' : '標記已通知'}</button>
          </div>
          <div style="font-size:13px;background:#f7f9fa;border-radius:8px;padding:8px;margin-top:6px" id="m-${r.id}">${UI.esc(r.message)}</div>
        </div>`).join('') : '<div class="empty">當日沒有需要提醒的預約</div>'}
      </div>
      <div style="font-size:12.5px;color:var(--muted)">訊息內容可於系統設定的「提醒訊息範本」調整。</div>`;
    el.querySelector('#d').onchange = () => App.pages.reminders.render(el);
    const copy = txt => navigator.clipboard.writeText(txt).then(() => UI.toast('已複製')).catch(() => UI.toast('請手動選取複製', true));
    el.querySelectorAll('[data-copy]').forEach(b => {
      b.onclick = () => copy(el.querySelector('#m-' + b.dataset.copy).textContent);
    });
    el.querySelector('#copyall').onclick = () => copy(d.rows.map(r => r.message).join('\n\n'));
    const send = async id => {
      const msg = el.querySelector('#m-' + id).textContent;
      const r = await POST(`/appointments/${id}/remind`, { message: msg });
      return r;
    };
    el.querySelectorAll('[data-done]').forEach(b => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          const r = await send(b.dataset.done);
          UI.toast(r.message || '已標記', r.status === 'failed');
        } catch (e) { UI.err(e); }
        App.pages.reminders.render(el);
      };
    });
    if (el.querySelector('#sendall')) {
      el.querySelector('#sendall').onclick = async () => {
        const pending = d.rows.filter(r => !r.reminded_at);
        if (!pending.length) return UI.toast('沒有待發送的提醒');
        if (!await UI.confirm(`將發送 ${pending.length} 則提醒，確定？`)) return;
        let ok = 0, fail = 0;
        for (const r of pending) {
          try { (await send(r.id)).status === 'failed' ? fail++ : ok++; } catch (e) { fail++; }
        }
        UI.toast(`發送完成：成功 ${ok} 則、失敗 ${fail} 則`, fail > 0);
        App.pages.reminders.render(el);
      };
    }
    el.querySelector('#log').onclick = async () => {
      const rows = await GET('/notifications');
      UI.modal({
        title: '提醒發送紀錄', wide: true, hideFooter: true,
        body: UI.table(['時間', '個案', '通道', '對象', '狀態', '說明'], rows.map(n => `<tr>
          <td>${UI.esc(n.created_at.slice(5, 16))}</td>
          <td>${UI.esc(n.client_name || '-')}</td>
          <td>${n.channel === 'webhook' ? '系統發送' : '人工'}</td>
          <td>${UI.esc(n.target || '-')}</td>
          <td>${n.status === 'sent' ? UI.tag('已送出', 'ok')
            : n.status === 'failed' ? UI.tag('失敗', 'danger') : UI.tag('人工發送')}</td>
          <td style="font-size:12px;color:var(--muted)">${UI.esc(n.error || '')}</td></tr>`), '尚無發送紀錄')
      });
    };
  }
});

// ---- 初談問卷管理 ----
// 來電登記頁可針對單筆產生問卷；這頁管理全部問卷（含尚未登記來電就先發出的），
// 並可把已填寫的問卷轉為來電登記接回派案流程。
App.page('intake-forms', {
  title: '初談問卷',
  sub: '發出、追蹤與檢視個案自填的初談問卷',
  module: 'intake',
  async render(el) {
    const draw = async () => {
      const status = el.querySelector('#fst').value;
      const rows = await GET('/intake-forms' + (status ? '?status=' + status : ''));
      const link = t => `${location.origin}/intake-form.html?t=${t}`;
      el.querySelector('#flist').innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="num">${rows.filter(r => r.status === 'sent' && !r.expired).length}</div><div class="label">等待填寫</div></div>
          <div class="stat"><div class="num ${rows.filter(r => r.status === 'done').length ? 'warn' : ''}">${rows.filter(r => r.status === 'done').length}</div><div class="label">已填待處理</div></div>
          <div class="stat"><div class="num">${rows.filter(r => r.status === 'used').length}</div><div class="label">已建檔帶入</div></div>
          <div class="stat"><div class="num ${rows.filter(r => r.expired).length ? 'warn' : ''}">${rows.filter(r => r.expired).length}</div><div class="label">連結逾期未填</div></div>
        </div>
        ${UI.table(['產生時間', '對象', '電話', '主訴', '心情溫度計', '狀態', '有效期限', ''], rows.map(r => `<tr>
          <td>${UI.esc((r.created_at || '').slice(0, 16))}</td>
          <td><strong>${UI.esc(r.name || '（未指定）')}</strong>
            ${r.intake_id ? '<br><span style="font-size:12px;color:var(--muted)">已對應來電登記</span>' : ''}</td>
          <td>${UI.esc(r.phone || '-')}</td>
          <td class="wrap narrow">${UI.esc((r.main_issue || '').slice(0, 40) || '-')}</td>
          <td>${r.bsrs_total >= 0 ? `${r.bsrs_total} 分 ${r.bsrs_alert ? UI.tag('自殺意念', 'danger') : ''}` : '-'}</td>
          <td>${r.status === 'done' ? UI.tag('已填寫', 'warn')
    : r.status === 'used' ? UI.tag('已建檔', 'ok')
      : r.expired ? UI.tag('已逾期', 'danger') : UI.tag('等待填寫', 'primary')}</td>
          <td>${UI.esc(r.expires_at || '-')}</td>
          <td style="white-space:nowrap">
            ${r.status === 'sent' ? `<button class="btn tiny secondary" data-lk="${r.token}">連結</button>
              <button class="btn tiny secondary" data-sd="${r.id}">傳送</button>` : ''}
            ${r.status !== 'sent' ? `<button class="btn tiny secondary" data-vw="${r.id}">檢視</button>` : ''}
            ${r.status === 'done' && !r.intake_id ? `<button class="btn tiny" data-ti="${r.id}">轉來電登記</button>` : ''}
            ${r.status !== 'used' ? `<button class="btn tiny danger" data-fd="${r.id}">刪除</button>` : ''}
          </td></tr>`), '尚無問卷')}`;

      const showLink = token => UI.modal({
        title: '問卷連結', hideFooter: true,
        body: `<div style="font-size:14px;line-height:1.9">請以簡訊或 LINE 傳給填寫者本人。</div>
          <div style="background:#f7f9fa;border-radius:8px;padding:10px;margin-top:10px;word-break:break-all;font-size:13px" id="lk2">${UI.esc(link(token))}</div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn small" id="cp2">複製連結</button>
            <a class="btn small secondary" href="/intake-form.html?t=${UI.esc(token)}" target="_blank" rel="noopener">預覽</a></div>`,
        onOpen: body => {
          body.querySelector('#cp2').onclick = () => navigator.clipboard.writeText(body.querySelector('#lk2').textContent)
            .then(() => UI.toast('已複製')).catch(() => UI.toast('請手動選取複製', true));
        }
      });
      el.querySelectorAll('[data-lk]').forEach(b => { b.onclick = () => showLink(b.dataset.lk); });
      el.querySelectorAll('[data-fd]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('刪除此問卷連結？已發出的連結會立刻失效。')) return;
          try { await DEL(`/intake-forms/${b.dataset.fd}`); UI.toast('已刪除'); draw(); } catch (e) { UI.err(e); }
        };
      });
      el.querySelectorAll('[data-sd]').forEach(b => {
        const r = rows.find(x => x.id === Number(b.dataset.sd));
        b.onclick = () => UI.modal({
          title: '傳送問卷連結',
          submitText: App.meta.notify_enabled ? '發送' : '記錄為人工發送',
          body: `<div class="form-grid">
              ${UI.input('phone', '收訊號碼', { value: r.phone || '', full: true })}
              ${UI.textarea('message', '訊息內容', {
    value: `${r.name ? r.name + ' 您好，' : ''}這是 ${App.me.center_name} 的初談問卷，請於 ${r.expires_at} 前撥空填寫：${link(r.token)}`,
    rows: 4
  })}</div>
            <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
              ${App.meta.notify_enabled ? '將由系統發送，結果記入發送紀錄。' : '尚未設定發送通道，僅會記錄為人工發送，請自行以簡訊或 LINE 傳出。'}</div>`,
          onSubmit: async e => {
            const res = await POST(`/intake-forms/${r.id}/send`, { ...UI.formData(e), url: link(r.token) });
            UI.toast(res.message || '已記錄', res.status === 'failed');
          }
        });
      });
      el.querySelectorAll('[data-vw]').forEach(b => {
        b.onclick = async () => {
          const f = await GET(`/intake-forms/${b.dataset.vw}`);
          const g = (l, v) => `<div><div class="dg-label">${l}</div>${UI.esc(v || '-')}</div>`;
          UI.modal({
            title: `初談問卷：${f.name}`, wide: true, hideFooter: true,
            body: `<div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">填寫時間 ${UI.esc(f.submitted_at || '-')}</div>
              <div class="detail-grid">
                ${g('姓名', f.name)}${g('手機', f.phone)}${g('性別', TW.gender[f.gender])}${g('出生日期', f.birth_date)}
                ${g('Email', f.email)}${g('地址', f.address)}${g('職業／就學', f.occupation)}${g('婚姻', f.marital)}
                ${g('緊急聯絡人', `${f.emergency_name} ${f.emergency_relationship} ${f.emergency_phone}`)}
                ${g('法定代理人', `${f.guardian_name} ${f.guardian_relationship} ${f.guardian_phone}`)}
                ${g('方便時段', f.preferred_time)}${g('得知來源', f.source)}
              </div>
              <div class="card" style="margin-top:12px;font-size:14px;line-height:1.8">
                <strong>主要困擾：</strong>${UI.nl2br(f.main_issue) || '—'}<br>
                <strong>就醫／諮商史：</strong>${UI.nl2br(f.history) || '—'}<br>
                <strong>對諮商的期待：</strong>${UI.nl2br(f.expectation) || '—'}</div>
              ${f.bsrs_total >= 0 ? `<div class="notice ${f.bsrs_alert ? 'danger' : ''}" style="margin-top:10px">
                BSRS-5 心情溫度計：<strong>${f.bsrs_total}</strong> 分
                ${f.bsrs_alert ? '；附加題（自殺意念）達 2 分以上，請優先安排並於初談前完成風險評估。' : ''}</div>` : ''}`
          });
        };
      });
      el.querySelectorAll('[data-ti]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('依此問卷建立一筆來電登記？建立後可照常派案與建檔。')) return;
          try { await POST(`/intake-forms/${b.dataset.ti}/to-intake`, {}); UI.toast('已建立來電登記'); draw(); }
          catch (e) { UI.err(e); }
        };
      });
    };
    el.innerHTML = `<div class="toolbar">
        <select id="fst"><option value="">全部</option><option value="sent">等待填寫</option>
          <option value="done">已填待處理</option><option value="used">已建檔帶入</option></select>
        <div class="spacer"></div><button class="btn" id="newf">產生新問卷</button>
      </div><div id="flist"><div class="empty">載入中...</div></div>`;
    el.querySelector('#fst').onchange = draw;
    el.querySelector('#newf').onclick = () => UI.modal({
      title: '產生初談問卷連結',
      submitText: '產生',
      body: `<div class="form-grid">
          ${UI.input('name', '對象姓名（選填）', { full: true })}
          ${UI.input('phone', '手機（選填，可直接用於傳送）', { full: true })}
        </div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          尚未登記來電也可先發問卷；填寫完成後可一鍵轉為來電登記。</div>`,
      onSubmit: async e => {
        const r = await POST('/intake-forms', UI.formData(e));
        UI.toast('已產生');
        draw();
        UI.modal({
          title: '問卷連結', hideFooter: true,
          body: `<div style="background:#f7f9fa;border-radius:8px;padding:10px;word-break:break-all;font-size:13px">
            ${UI.esc(location.origin)}/intake-form.html?t=${UI.esc(r.token)}</div>
            <div style="font-size:12.5px;color:var(--muted);margin-top:8px">有效期限至 ${UI.esc(r.expires_at)}。</div>`
        });
      }
    });
    await draw();
  }
});
