// 對外預約頁（免登入）：選據點 → 選心理師 → 選時段 → 留資料送出。
// 送出的是「預約申請」，會進到系統的來電登記由櫃檯確認，不是直接成立的預約——
// 全預約制的諮商所要先確認初談需求與收費，這點在畫面上也寫清楚，避免民眾誤會。

const Booking = {
  opt: null,
  state: { site_id: '', counselor_id: '', date: '', start_time: '', topic: '', first_time: true },

  async boot() {
    try {
      Booking.opt = await GET('/public/booking/options');
    } catch {
      document.getElementById('app').innerHTML
        = '<div class="bk-wrap"><div class="bk-body"><div class="step">目前無法載入預約資訊，請稍後再試或直接來電。</div></div></div>';
      return;
    }
    Booking.state.date = Booking.opt.min_date;
    Booking.render();
  },

  siteById(id) { return (Booking.opt.sites || []).find(s => s.id === Number(id)); },

  render() {
    const o = Booking.opt, st = Booking.state;
    const head = `<div class="bk-head">
        <h1>${UI.esc(o.center_name)}　線上預約</h1>
        <div class="sub">${UI.esc(o.tagline || '')}</div>
        <div class="tel">${o.center_phone ? '預約專線 ' + UI.esc(o.center_phone) : ''}　全預約制</div>
      </div>`;

    if (!o.enabled) {
      document.getElementById('app').innerHTML = `<div class="bk-wrap">${head}<div class="bk-body">
        <div class="step"><h2>目前未開放線上預約</h2>
          <div class="hint">請直接來電 ${UI.esc(o.center_phone || '諮商所')} 由專人為您安排。</div></div></div></div>`;
      return;
    }

    const site = Booking.siteById(st.site_id);
    const counselors = (o.counselors || []).filter(c => !st.site_id || c.site_ids.includes(Number(st.site_id)));

    document.getElementById('app').innerHTML = `<div class="bk-wrap">${head}
      <div class="bk-body">
        ${o.crisis_note ? `<div class="crisis">${UI.nl2br(o.crisis_note)}</div>` : ''}
        ${o.notice ? `<div class="notice">${UI.nl2br(o.notice)}</div>` : ''}

        <div class="step"><h2>1. 選擇據點</h2>
          <div class="hint">視訊晤談請選「不限據點」，我們會在確認電話中安排。</div>
          <div class="pick" id="sites">
            <button data-site="" class="${st.site_id ? '' : 'on'}">不限據點</button>
            ${(o.sites || []).map(s => `<button data-site="${s.id}" class="${String(st.site_id) === String(s.id) ? 'on' : ''}">${UI.esc(s.name)}</button>`).join('')}
          </div>
          ${site ? `<div class="site-info">${UI.esc(site.address || '')}${site.phone ? '　' + UI.esc(site.phone) : ''}
            ${site.transport ? '<br>' + UI.nl2br(site.transport) : ''}</div>` : ''}
        </div>

        <div class="step"><h2>2. 想談的主題</h2>
          <div class="hint">只是方便我們安排合適的心理師，不需要寫得很詳細。</div>
          <div class="pick" id="topics">
            ${(o.topics || []).map(t => `<button data-topic="${UI.esc(t)}" class="${st.topic === t ? 'on' : ''}">${UI.esc(t)}</button>`).join('')}
          </div>
        </div>

        <div class="step"><h2>3. 選擇心理師與時段</h2>
          <div class="hint">${(o.sites || []).length ? '各據點駐點心理師不同；' : ''}此處顯示的是目前還空著的時段，
            單次晤談約 ${o.session_minutes} 分鐘。初次晤談（初談）費用 ${UI.fmtMoney(o.intake_fee)}，後續每次 ${UI.fmtMoney(o.default_fee)}。</div>
          <div class="pick" id="cslrs" style="margin-bottom:10px">
            <button data-c="" class="${st.counselor_id ? '' : 'on'}">不指定</button>
            ${counselors.map(c => `<button data-c="${c.id}" class="${String(st.counselor_id) === String(c.id) ? 'on' : ''}">${UI.esc(c.name)}</button>`).join('')}
          </div>
          <div class="form-row full"><label>日期</label>
            <input type="date" id="date" value="${st.date}" min="${o.min_date}" max="${o.max_date}"></div>
          <div id="slots" style="margin-top:10px">載入中...</div>
        </div>

        <div class="step"><h2>4. 聯絡方式</h2>
          <div class="hint">我們會以電話與您確認時段；資料僅用於安排本次預約。</div>
          <div class="form-grid">
            ${UI.input('name', '姓名', { required: true })}
            ${UI.input('phone', '手機', { required: true, placeholder: '09xxxxxxxx' })}
            ${UI.input('email', 'Email（選填）', { type: 'email' })}
            ${UI.select('first_time', '是否第一次來本所', [['1', '是，第一次'], ['', '否，曾經晤談過']])}
            ${UI.textarea('note', '想先讓我們知道的事（選填）')}
            ${UI.input('preferred_time', '若上方沒有合適時段，方便的時間', { placeholder: '例：平日晚上、週六上午', full: true })}
          </div>
          <div id="picked" style="font-size:13px;color:var(--muted);margin-top:8px"></div>
          <button class="btn" id="send" style="margin-top:12px">送出預約申請</button>
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            送出後尚未完成預約，待我們電話確認後才算成立。</div>
        </div>

        <div style="text-align:center;font-size:12.5px;color:var(--muted);padding:6px 0 20px">
          已經是本所個案？<a href="/portal.html">前往個案專區</a>
        </div>
      </div></div>`;

    document.getElementById('sites').onclick = e => {
      const b = e.target.closest('[data-site]');
      if (!b) return;
      Booking.state.site_id = b.dataset.site;
      Booking.state.counselor_id = '';
      Booking.state.start_time = '';
      Booking.render();
    };
    document.getElementById('topics').onclick = e => {
      const b = e.target.closest('[data-topic]');
      if (!b) return;
      Booking.state.topic = Booking.state.topic === b.dataset.topic ? '' : b.dataset.topic;
      Booking.render();
    };
    document.getElementById('cslrs').onclick = e => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      Booking.state.counselor_id = b.dataset.c;
      Booking.state.start_time = '';
      Booking.render();
    };
    document.getElementById('date').onchange = e => {
      Booking.state.date = e.target.value;
      Booking.state.start_time = '';
      Booking.loadSlots();
    };
    document.getElementById('send').onclick = Booking.submit;
    Booking.loadSlots();
  },

  async loadSlots() {
    const st = Booking.state;
    const box = document.getElementById('slots');
    if (!box) return;
    box.innerHTML = '載入中...';
    const q = new URLSearchParams({ date: st.date, site_id: st.site_id || '', counselor_id: st.counselor_id || '' });
    let d;
    try { d = await GET('/public/booking/slots?' + q.toString()); } catch (e) { box.textContent = e.message; return; }
    if (!d.counselors.length) {
      box.innerHTML = `<div style="font-size:13.5px;color:var(--muted)">這一天沒有可預約的時段，請換一天，
        或在下方「方便的時間」寫下您的期望，我們再與您聯繫。</div>`;
      return;
    }
    box.innerHTML = d.counselors.map(c => `<div class="cslr">
      <div class="nm">${UI.esc(c.name)}<span style="font-size:12.5px;font-weight:400;color:var(--muted)">
        　${UI.esc(c.license_type || '')}${c.title ? '／' + UI.esc(c.title) : ''}</span></div>
      <div class="slots">${c.slots.map(s => `<button data-slot="${s}" data-cid="${c.id}"
        class="${st.start_time === s && String(st.counselor_id) === String(c.id) ? 'on' : ''}">${s}</button>`).join('')}</div>
    </div>`).join('');
    box.onclick = e => {
      const b = e.target.closest('[data-slot]');
      if (!b) return;
      Booking.state.start_time = b.dataset.slot;
      Booking.state.counselor_id = b.dataset.cid;
      Booking.render();
    };
    Booking.showPicked();
  },

  showPicked() {
    const el = document.getElementById('picked');
    if (!el) return;
    const st = Booking.state;
    const c = (Booking.opt.counselors || []).find(x => String(x.id) === String(st.counselor_id));
    el.innerHTML = st.start_time
      ? `已選擇：<strong>${st.date} ${st.start_time}</strong>${c ? '　' + UI.esc(c.name) + ' 心理師' : ''}`
      : '尚未選擇時段（也可以不選，直接填下方「方便的時間」）。';
  },

  async submit() {
    const v = id => (document.querySelector(`[name=${id}]`) || {}).value || '';
    const st = Booking.state;
    const btn = document.getElementById('send');
    btn.disabled = true;
    try {
      const r = await POST('/public/booking/request', {
        name: v('name'), phone: v('phone'), email: v('email'),
        note: v('note'), preferred_time: v('preferred_time'),
        first_time: v('first_time') === '1',
        topic: st.topic, site_id: st.site_id || '', counselor_id: st.counselor_id || '',
        date: st.start_time ? st.date : '', start_time: st.start_time
      });
      document.getElementById('app').innerHTML = `<div class="bk-wrap">
        <div class="bk-head"><h1>${UI.esc(Booking.opt.center_name)}</h1></div>
        <div class="bk-body"><div class="step done">
          <div class="big">已收到您的預約申請</div>
          <div style="font-size:14px;line-height:1.9;color:var(--muted)">
            ${UI.esc(r.message)}<br>
            ${st.start_time ? `您希望的時段：${st.date} ${st.start_time}<br>` : ''}
            ${r.phone ? '如需立即聯繫，請撥 ' + UI.esc(r.phone) : ''}
          </div>
          <a class="btn secondary" href="/booking.html" style="margin-top:16px;display:inline-block">再預約一次</a>
        </div></div></div>`;
    } catch (e) {
      UI.err(e);
      btn.disabled = false;
    }
  }
};
