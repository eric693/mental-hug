// 預約排程：週檢視、今日看板、預約表單、待補紀錄

// defaults：新增預約時的預帶值（例如行事曆點某一天）
async function apptDialog(appt, onDone, defaults) {
  const clients = await App.clientOptions(true);
  const isNew = !appt;
  const a = appt || {
    date: UI.today(), start_time: '14:00', type: 'individual', mode: 'onsite', counselor_id: App.me.id,
    ...(defaults || {})
  };
  let packages = [];
  if (a.client_id) packages = await GET(`/clients/${a.client_id}/active-packages`).catch(() => []);
  UI.modal({
    title: isNew ? '新增預約' : '修改預約',
    wide: true,
    body: `<div class="form-grid">
      ${UI.select('client_id', '個案', clients, { value: a.client_id || '' })}
      ${UI.select('counselor_id', '心理師', App.counselorOptions(), { value: a.counselor_id })}
      ${UI.input('date', '日期', { type: 'date', value: a.date })}
      ${UI.input('start_time', '開始時間', { type: 'time', value: a.start_time })}
      ${UI.select('type', '晤談類型', App.enumOptions('appt_type'), { value: a.type })}
      ${UI.select('mode', '形式', App.enumOptions('appt_mode'), { value: a.mode })}
      ${UI.select('room_id', '諮商室', App.roomOptions(), { value: a.room_id || '' })}
      ${UI.input('fee', '費用', { type: 'number', value: a.fee !== undefined ? a.fee : (App.meta.default_fee || 2000) })}
      ${UI.select('package_id', '扣抵方案', [['', '不扣抵（單次收費）']].concat(packages.map(p => [p.id, `${p.name}（剩 ${p.remaining} 次）`])), { value: a.package_id || '' })}
      ${UI.checkbox('designated', '個案指名這位心理師（影響分帳規則與指名預約比例）', !!a.designated)}
      <div class="form-row full" id="mu-row" style="${a.mode === 'online' ? '' : 'display:none'}">
        <label>視訊連結</label>
        <input name="meeting_url" value="${UI.esc(a.meeting_url || '')}" placeholder="https://meet.google.com/xxx-xxxx-xxx">
        <div style="font-size:12.5px;color:var(--muted);margin-top:4px">
          貼上會議室連結即可；晤談提醒會自動附上，個案於專區也看得到。</div>
      </div>
      ${UI.textarea('note', '備註', { value: a.note || '' })}
      <div class="form-row full"><label>可預約時段參考</label><div id="slot-hint" style="font-size:13px;color:var(--muted)">選擇心理師與日期後顯示</div></div>
    </div>`,
    onOpen: el => {
      const refresh = async () => {
        const cid = el.querySelector('[name=counselor_id]').value;
        const date = el.querySelector('[name=date]').value;
        const hint = el.querySelector('#slot-hint');
        if (!cid || !date) return;
        hint.textContent = '查詢中...';
        try {
          const slots = await GET(`/slots?counselor_id=${cid}&date=${date}`);
          hint.innerHTML = slots.length
            ? slots.map(s => `<button class="btn tiny secondary" type="button" data-slot="${s.start_time}" style="margin:2px">${s.start_time}</button>`).join('')
            : '該日無開放時段（仍可直接指定時間）';
          hint.querySelectorAll('[data-slot]').forEach(b => {
            b.onclick = () => { el.querySelector('[name=start_time]').value = b.dataset.slot; };
          });
        } catch { hint.textContent = ''; }
      };
      el.querySelector('[name=counselor_id]').onchange = refresh;
      el.querySelector('[name=date]').onchange = refresh;
      el.querySelector('[name=client_id]').onchange = async e => {
        const sel = el.querySelector('[name=package_id]');
        const list = e.target.value ? await GET(`/clients/${e.target.value}/active-packages`).catch(() => []) : [];
        sel.innerHTML = ['<option value="">不扣抵（單次收費）</option>']
          .concat(list.map(p => `<option value="${p.id}">${UI.esc(p.name)}（剩 ${p.remaining} 次）</option>`)).join('');
      };
      el.querySelector('[name=mode]').onchange = e => {
        el.querySelector('#mu-row').style.display = e.target.value === 'online' ? '' : 'none';
      };
      el.querySelector('[name=type]').onchange = e => {
        el.querySelector('[name=fee]').value = e.target.value === 'intake' ? (App.meta.intake_fee || 2500) : (App.meta.default_fee || 2000);
      };
      refresh();
    },
    onSubmit: async el => {
      const data = UI.formData(el);
      if (isNew) await POST('/appointments', data);
      else await PUT(`/appointments/${a.id}`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

async function apptStatusDialog(a, onDone) {
  const acts = [
    ['arrived', '報到', 'secondary'],
    ['done', '完成晤談', ''],
    ['no_show', '未到', 'warn'],
    ['cancelled', '取消', 'danger']
  ].filter(x => x[0] !== a.status);
  const m = UI.modal({
    title: `${a.client_name}　${a.date} ${a.start_time}`,
    hideFooter: true,
    body: `<div style="font-size:14px;margin-bottom:12px">
        目前狀態：${stateTag('appt_status', a.status)}　${UI.esc(TW.appt_type[a.type] || '')}　${UI.esc(a.counselor_name || '')}
      </div>
      ${a.cancel_requested_at ? `<div class="notice warn" style="margin-bottom:12px">
        個案於 ${UI.esc(a.cancel_requested_at)} 提出取消申請（距晤談已不足免收費時數）<br>
        事由：${UI.esc(a.cancel_request_reason || '未填寫')}<br>
        <span style="font-size:12.5px">按「取消」不收費；若依所內規定收取費用，請改按「未到」，
        系統會依未到比例開立收費單。</span></div>` : ''}
      <div class="form-row full"><label>取消／未到原因（選填）</label><input id="rsn"${a.cancel_requested_at
    ? ` value="${UI.esc(a.cancel_request_reason || '個案申請取消')}"` : ''}></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
        ${acts.map(x => `<button class="btn ${x[2]}" data-st="${x[0]}" type="button">${x[1]}</button>`).join('')}
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:12px">
        標記「完成晤談」會依方案扣次或產生收費單；「未到」依系統設定比例計費。
        若把已完成的晤談改回其他狀態，系統會自動退回方案次數並移除尚未收款的收費單。</div>`
  });
  m.body.querySelectorAll('[data-st]').forEach(b => {
    b.onclick = async () => {
      try {
        const r = await POST(`/appointments/${a.id}/status`, { status: b.dataset.st, cancel_reason: m.body.querySelector('#rsn').value.trim() });
        m.close();
        // 已收款的收費單不會自動刪除，需提醒人工處理退費
        if (r.warnings && r.warnings.length) {
          UI.modal({
            title: '狀態已更新，但有需要處理的項目', hideFooter: true,
            body: `<div class="notice warn">${r.warnings.map(w => UI.esc(w)).join('<br>')}</div>
              <div style="font-size:13px;color:var(--muted);margin-top:10px">
                需退還已收款項時，請至「收費與方案」找到該筆收費單按「退費」開立退費單。</div>`
          });
        } else {
          UI.toast('已更新');
        }
        // 取消／未到會空出時段：若候補名單有適合人選，當下就問要不要通知遞補
        if (r.opening && r.opening.candidates && r.opening.candidates.length) {
          const slot = { ...r.opening, counselor_name: a.counselor_name };
          UI.confirm(`此時段釋出後，候補名單有 ${r.opening.candidates.length} 位適合人選，要現在通知遞補嗎？`)
            .then(yes => { if (yes) waitlistCandidateModal(slot); });
        }
        onDone && onDone();
      } catch (e) { UI.err(e); }
    };
  });
}

App.page('schedule', {
  title: '預約排程',
  sub: '週檢視：同一心理師或諮商室時段衝突會即時擋下',
  module: 'schedule',
  async render(el, arg) {
    let start = arg || localStorage.getItem('mc-week') || UI.today();
    // 對齊到週一
    const d = new Date(start + 'T00:00:00');
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    localStorage.setItem('mc-week', start);
    const data = await GET(`/schedule/week?start=${start}`);
    const days = Array.from({ length: 7 }, (_, i) => UI.addDays(start, i));
    const filterC = localStorage.getItem('mc-week-counselor') || '';

    const cell = date => {
      const match = cid => !filterC || String(cid) === filterC;
      const offs = (data.time_off || []).filter(o => date >= o.start_date && date <= o.end_date && match(o.counselor_id));
      const groups = (data.group_sessions || []).filter(g => g.date === date && match(g.counselor_id));
      const list = data.appointments
        .filter(a => a.date === date && match(a.counselor_id))
        .sort((x, y) => x.start_time.localeCompare(y.start_time));
      const offHtml = offs.map(o => `<div class="appt-chip off">請假：${UI.esc(o.counselor_name)}
        <span style="font-size:11.5px">${o.all_day ? '全天' : o.start_time + '-' + o.end_time}
        ${o.reason ? '／' + UI.esc(o.reason) : ''}</span></div>`).join('');
      const groupHtml = groups.map(g => `<div class="appt-chip group" data-gs="${g.group_id}">
        <strong>${g.start_time}</strong> ${UI.esc(g.group_name)}<br>
        <span style="font-size:11.5px">團體 ${g.member_count} 人／${UI.esc(g.counselor_name || '')}
        ${g.room_name ? '／' + UI.esc(g.room_name) : ''}</span></div>`).join('');
      const apptHtml = list.map(a => `<div class="appt-chip ${a.status}" data-appt="${a.id}">
        <strong>${a.start_time}</strong> ${UI.esc(a.client_name)}<br>
        <span style="font-size:11.5px">${UI.esc(a.counselor_name)}${a.mode === 'online' ? '／視訊' : a.room_name ? '／' + UI.esc(a.room_name) : ''}
        ${a.risk_level === 'high' ? '⚠' : ''}${a.cancel_requested_at ? '　🕓申請取消' : ''}</span></div>`).join('');
      const all = offHtml + groupHtml + apptHtml;
      return all || '<div style="color:var(--muted);font-size:12.5px">—</div>';
    };

    el.innerHTML = `
      <div class="toolbar">
        <button class="btn secondary small" id="prev">上一週</button>
        <button class="btn secondary small" id="this">本週</button>
        <button class="btn secondary small" id="next">下一週</button>
        <strong style="margin-left:6px">${start} ~ ${UI.addDays(start, 6)}</strong>
        <select id="fc">${App.counselorOptions(true).map(o =>
      `<option value="${o[0]}"${String(o[0]) === filterC ? ' selected' : ''}>${UI.esc(o[1])}</option>`).join('')}</select>
        <div class="spacer"></div>
        <button class="btn" id="add">新增預約</button>
      </div>
      <div class="table-wrap"><table class="list week-table"><thead><tr>
        ${days.map(dt => `<th>${dt.slice(5)}（${UI.weekdayName(dt)}）${dt === UI.today() ? ' ●' : ''}</th>`).join('')}
      </tr></thead><tbody><tr>${days.map(dt => `<td style="vertical-align:top;min-width:150px">${cell(dt)}</td>`).join('')}</tr></tbody></table></div>
      <div class="card"><h3>可預約時段設定</h3><div id="avail"></div></div>`;

    el.querySelector('#prev').onclick = () => App.go('schedule/' + UI.addDays(start, -7));
    el.querySelector('#next').onclick = () => App.go('schedule/' + UI.addDays(start, 7));
    el.querySelector('#this').onclick = () => App.go('schedule/' + UI.today());
    el.querySelector('#fc').onchange = e => { localStorage.setItem('mc-week-counselor', e.target.value); App.go('schedule/' + start); };
    el.querySelector('#add').onclick = () => apptDialog(null, () => App.go('schedule/' + start));
    el.querySelectorAll('[data-gs]').forEach(c => { c.onclick = () => { location.hash = 'group/' + c.dataset.gs; }; });
    el.querySelectorAll('[data-appt]').forEach(c => {
      c.onclick = () => {
        const a = data.appointments.find(x => x.id === Number(c.dataset.appt));
        UI.modal({
          title: '預約明細', hideFooter: true,
          body: `<div class="detail-grid">
            <div><div class="dg-label">個案</div><a href="#client/${a.client_id}">${UI.esc(a.client_name)}（${a.client_code}）</a></div>
            <div><div class="dg-label">時間</div>${a.date} ${a.start_time}-${a.end_time}</div>
            <div><div class="dg-label">心理師</div>${UI.esc(a.counselor_name || '')}</div>
            <div><div class="dg-label">類型</div>${UI.esc(TW.appt_type[a.type] || a.type)}／${UI.esc(TW.appt_mode[a.mode])}</div>
            <div><div class="dg-label">諮商室</div>${UI.esc(a.room_name || '-')}</div>
            <div><div class="dg-label">狀態</div>${stateTag('appt_status', a.status)}</div>
            <div><div class="dg-label">費用</div>${UI.fmtMoney(a.fee)}</div>
            <div><div class="dg-label">來源</div>${UI.esc(TW.source_kind[a.source] || a.source)}</div>
          </div>
          ${a.mode === 'online' && a.meeting_url ? `<div style="margin-top:10px;font-size:14px">
            視訊連結：<a href="${UI.esc(a.meeting_url)}" target="_blank" rel="noopener noreferrer">${UI.esc(a.meeting_url)}</a></div>` : ''}
          ${a.note ? `<div style="margin-top:10px;font-size:14px">備註：${UI.nl2br(a.note)}</div>` : ''}
          <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
            ${a.mode === 'online' && a.meeting_url
    ? `<a class="btn" href="${UI.esc(a.meeting_url)}" target="_blank" rel="noopener noreferrer">進入視訊</a>` : ''}
            <button class="btn" id="st">狀態異動</button>
            <button class="btn secondary" id="ed">修改</button>
            <button class="btn danger" id="del">刪除</button>
          </div>`,
          onOpen: (body, close) => {
            body.querySelector('#st').onclick = () => { close(); apptStatusDialog(a, () => App.go('schedule/' + start)); };
            body.querySelector('#ed').onclick = () => { close(); apptDialog(a, () => App.go('schedule/' + start)); };
            body.querySelector('#del').onclick = async () => {
              if (!await UI.confirm('確定刪除此預約？')) return;
              try {
                const r = await DEL(`/appointments/${a.id}`);
                close();
                App.go('schedule/' + start);
                if (r && r.opening && r.opening.candidates && r.opening.candidates.length) {
                  const slot = { ...r.opening, counselor_name: a.counselor_name };
                  if (await UI.confirm(`此時段釋出後，候補名單有 ${r.opening.candidates.length} 位適合人選，要現在通知遞補嗎？`)) {
                    waitlistCandidateModal(slot);
                  }
                }
              } catch (e) { UI.err(e); }
            };
          }
        });
      };
    });

    // 可預約時段
    const av = el.querySelector('#avail');
    const drawAvail = () => {
      const rows = data.availability.map(v => {
        const u = data.counselors.find(c => c.id === v.counselor_id);
        return `<tr><td>${UI.esc(u ? u.name : v.counselor_id)}</td>
          <td>週${['日', '一', '二', '三', '四', '五', '六'][v.weekday]}</td>
          <td>${v.start_time} - ${v.end_time}</td>
          <td><button class="btn tiny danger" data-av="${v.id}">刪除</button></td></tr>`;
      });
      av.innerHTML = `${UI.table(['心理師', '星期', '時段', ''], rows, '尚未設定可預約時段')}
        <button class="btn small" id="add-av" style="margin-top:10px">新增時段</button>`;
      av.querySelector('#add-av').onclick = () => UI.modal({
        title: '新增可預約時段',
        body: `<div class="form-grid">
          ${UI.select('counselor_id', '心理師', App.counselorOptions(), { value: App.me.id })}
          ${UI.select('weekday', '星期', [[1, '週一'], [2, '週二'], [3, '週三'], [4, '週四'], [5, '週五'], [6, '週六'], [0, '週日']])}
          ${UI.input('start_time', '開始', { type: 'time', value: '14:00' })}
          ${UI.input('end_time', '結束', { type: 'time', value: '18:00' })}
        </div>`,
        onSubmit: async e => { await POST('/availability', UI.formData(e)); App.go('schedule/' + start); }
      });
      av.querySelectorAll('[data-av]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('刪除此時段？')) return;
          await DEL(`/availability/${b.dataset.av}`);
          App.go('schedule/' + start);
        };
      });
    };
    drawAvail();
  }
});

App.page('today', {
  title: '今日看板',
  sub: '報到、完成與未到一鍵處理',
  module: 'schedule',
  async render(el) {
    const date = UI.today();
    const list = await GET(`/appointments?date=${date}`);
    el.innerHTML = `<div class="toolbar"><strong>${date}（${UI.weekdayName(date)}）</strong>
        <div class="spacer"></div><button class="btn" id="add">新增預約</button></div>
      <div class="kid-grid">${list.length ? list.map(a => `
        <div class="kid-card ${a.status === 'done' ? 'in' : a.status === 'no_show' ? 'leave' : 'out'}">
          <div class="kid-head">
            <div class="kid-avatar">${UI.esc(a.client_name.slice(0, 1))}</div>
            <div><div class="kid-name">${UI.esc(a.client_name)}
              ${a.risk_level === 'high' ? UI.tag('高風險', 'danger') : ''}</div>
              <div class="kid-meta">${a.start_time}-${a.end_time}　${UI.esc(TW.appt_type[a.type] || '')}</div></div>
          </div>
          <div class="kid-status">${UI.esc(a.counselor_name || '')}${a.room_name ? '／' + UI.esc(a.room_name) : ''}<br>
            ${stateTag('appt_status', a.status)} ${a.has_note ? UI.tag('已寫紀錄', 'ok') : ''}
            ${a.cancel_requested_at ? UI.tag('個案申請取消', 'warn') : ''}</div>
          <div class="kid-actions">
            <button class="btn tiny" data-st="${a.id}">狀態</button>
            <a class="btn tiny secondary" href="#client/${a.client_id}">個案</a>
            ${a.mode === 'online' && a.meeting_url
    ? `<a class="btn tiny" href="${UI.esc(a.meeting_url)}" target="_blank" rel="noopener noreferrer">視訊</a>` : ''}
          </div>
        </div>`).join('') : '<div class="empty">今日沒有排定的晤談</div>'}</div>`;
    el.querySelector('#add').onclick = () => apptDialog(null, () => App.go('today'));
    el.querySelectorAll('[data-st]').forEach(b => {
      b.onclick = () => apptStatusDialog(list.find(x => x.id === Number(b.dataset.st)), () => App.go('today'));
    });
  }
});

App.page('notes-pending', {
  title: '待補紀錄與報告',
  sub: '已完成但尚未撰寫的晤談紀錄，以及未完成的衡鑑報告',
  module: 'notes',
  async render(el) {
    const [d, rp] = await Promise.all([GET('/notes/pending'), GET('/reports/pending').catch(() => null)]);
    el.innerHTML = `<div class="card">
      <div style="font-size:13px;color:var(--muted);margin-bottom:10px">
        所內規定應於晤談後 ${d.lock_days} 日內完成紀錄，逾期以紅色標示。</div>
      ${UI.table(['晤談日期', '距今', '個案', '心理師', '類型', ''], d.rows.map(r => `<tr>
        <td>${r.date}</td>
        <td>${r.days_ago > d.lock_days ? `<span style="color:var(--danger);font-weight:700">${r.days_ago} 天</span>` : r.days_ago + ' 天'}</td>
        <td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}（${r.client_code}）</a></td>
        <td>${UI.esc(r.counselor_name || '')}</td>
        <td>${UI.esc(TW.appt_type[r.type] || r.type)}</td>
        <td><button class="btn tiny" data-note="${r.id}" data-client="${r.client_id}" data-date="${r.date}">撰寫紀錄</button></td>
      </tr>`), '沒有待補的晤談紀錄')}</div>
      ${rp && (rp.missing.length || rp.drafts.length) ? `<div class="card"><h3>待完成的心理衡鑑報告</h3>
        <div style="font-size:13px;color:var(--muted);margin-bottom:10px">
          已完成心理衡鑑但尚未產出報告，或報告仍為草稿未簽核。衡鑑報告常是轉介單位在等的文件，請儘速完成。</div>
        ${UI.table(['施測日期', '距今', '個案', '心理師', '狀態', ''], [
    ...rp.missing.map(r => `<tr>
            <td>${r.date}</td>
            <td>${r.days_ago > rp.lock_days ? `<span style="color:var(--danger);font-weight:700">${r.days_ago} 天</span>` : r.days_ago + ' 天'}</td>
            <td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}（${r.client_code}）</a></td>
            <td>${UI.esc(r.counselor_name || '')}</td>
            <td>${UI.tag('尚未撰寫', 'warn')}</td>
            <td><button class="btn tiny" data-nr="${r.client_id}" data-date="${r.date}">撰寫報告</button></td></tr>`),
    ...rp.drafts.map(r => `<tr>
            <td>${r.test_date}</td>
            <td>${r.days_ago > rp.lock_days ? `<span style="color:var(--danger);font-weight:700">${r.days_ago} 天</span>` : r.days_ago + ' 天'}</td>
            <td><a href="#client/${r.client_id}">${UI.esc(r.client_name)}（${r.client_code}）</a></td>
            <td>${UI.esc(r.counselor_name || '')}</td>
            <td>${UI.tag('草稿未簽核', 'warn')}</td>
            <td><button class="btn tiny secondary" data-er="${r.id}" data-client="${r.client_id}">繼續編輯</button></td></tr>`)
  ])}</div>` : ''}`;
    el.querySelectorAll('[data-note]').forEach(b => {
      b.onclick = () => noteDialog({
        client_id: Number(b.dataset.client), appointment_id: Number(b.dataset.note), date: b.dataset.date
      }, () => App.go('notes-pending'));
    });
    el.querySelectorAll('[data-nr]').forEach(b => {
      b.onclick = () => reportDialog({ client_id: Number(b.dataset.nr), test_date: b.dataset.date }, () => App.go('notes-pending'));
    });
    el.querySelectorAll('[data-er]').forEach(b => {
      b.onclick = () => reportDialog({ id: Number(b.dataset.er), client_id: Number(b.dataset.client) }, () => App.go('notes-pending'));
    });
  }
});
