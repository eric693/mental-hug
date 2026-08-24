// 合作單位與請款、請假與繼續教育、紀錄保存年限

// ---- 合作單位 ----
function partnerDialog(p, onDone) {
  const isNew = !p;
  const d = p || { type: '學校', rate: 1800 };
  UI.modal({
    title: isNew ? '新增合作單位' : '編輯合作單位',
    wide: true,
    body: `<div class="form-grid">
      ${UI.input('name', '單位名稱', { value: d.name || '', required: true, full: true })}
      ${UI.select('type', '類別', App.listOptions('partner_types', ['學校']), { value: d.type })}
      ${UI.input('contact', '聯絡人', { value: d.contact || '' })}
      ${UI.input('phone', '電話', { value: d.phone || '' })}
      ${UI.input('email', 'Email', { value: d.email || '' })}
      ${UI.input('tax_id', '統一編號', { value: d.tax_id || '' })}
      ${UI.input('contract_no', '契約編號', { value: d.contract_no || '' })}
      ${UI.input('contract_start', '契約起日', { type: 'date', value: d.contract_start || '' })}
      ${UI.input('contract_end', '契約迄日', { type: 'date', value: d.contract_end || '' })}
      ${UI.input('rate', '每次議定價', { type: 'number', value: d.rate || 0 })}
      ${UI.input('quota_sessions', '契約總次數（0 為不限）', { type: 'number', value: d.quota_sessions || 0 })}
      ${UI.input('address', '地址', { value: d.address || '', full: true })}
      ${UI.textarea('settle_note', '請款方式', { value: d.settle_note || '' })}
      ${UI.textarea('note', '備註', { value: d.note || '' })}
      ${p ? UI.checkbox('active', '合作中', d.active) : ''}
    </div>`,
    onSubmit: async el => {
      const data = UI.formData(el);
      if (isNew) await POST('/partners', data); else await PUT(`/partners/${d.id}`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

App.page('partners', {
  title: '合作單位與請款',
  sub: '學校認輔、企業 EAP、社政委託案的契約、用量與月結請款',
  module: 'partners',
  async render(el) {
    const [partners, settlements] = await Promise.all([GET('/partners'), GET('/settlements')]);
    el.innerHTML = `<div class="toolbar"><div class="spacer"></div>
        <button class="btn secondary" id="gen">產生月結請款單</button>
        <button class="btn" id="add">新增合作單位</button></div>
      <div class="card"><h3>合作單位</h3>
        ${UI.table(['單位', '類別', '聯絡人', '議定價', '契約期間', '個案數', '已用次數／額度', ''],
      partners.map(p => `<tr${p.active ? '' : ' style="color:var(--muted)"'}>
          <td><strong>${UI.esc(p.name)}</strong>${p.contract_no ? '<br><span style="font-size:12px;color:var(--muted)">' + UI.esc(p.contract_no) + '</span>' : ''}</td>
          <td>${UI.esc(p.type)}</td>
          <td>${UI.esc(p.contact)}<br><span style="font-size:12px;color:var(--muted)">${UI.esc(p.phone)}</span></td>
          <td>${UI.fmtMoney(p.rate)}</td>
          <td>${p.contract_start || '-'} ~ ${p.contract_end || '-'}
            ${p.expiring ? UI.tag('即將到期', 'warn') : ''}</td>
          <td>${p.client_count}</td>
          <td>${p.used_sessions}${p.quota_sessions ? ' / ' + p.quota_sessions : ''}
            ${p.remaining !== null && p.remaining <= 5 ? UI.tag('額度將用罄', 'danger') : ''}</td>
          <td style="white-space:nowrap"><button class="btn tiny secondary" data-e="${p.id}">編輯</button>
            <button class="btn tiny" data-v="${p.id}">明細</button>
            <button class="btn tiny danger" data-pd="${p.id}">刪除</button></td></tr>`), '尚無合作單位')}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          仍有個案或請款紀錄的單位不會真的刪除，會改為停用。</div></div>
      <div class="card"><h3>請款單</h3>
        ${UI.table(['月份', '單位', '次數', '金額', '狀態', '發票／收據號', ''], settlements.map(s => `<tr>
          <td>${s.month}</td><td>${UI.esc(s.partner_name)}</td><td>${s.sessions}</td>
          <td>${UI.fmtMoney(s.amount)}</td>
          <td>${UI.tag(TW.settle_status[s.status] || s.status, s.status === 'paid' ? 'ok' : s.status === 'sent' ? 'warn' : '')}</td>
          <td>${UI.esc(s.invoice_no || '-')}</td>
          <td><button class="btn tiny secondary" data-p="${s.id}">對帳單</button>
            <button class="btn tiny" data-st="${s.id}">狀態</button>
            ${s.status !== 'paid' ? `<button class="btn tiny danger" data-d="${s.id}">刪除</button>` : ''}</td></tr>`), '尚無請款單')}</div>`;

    el.querySelector('#add').onclick = () => partnerDialog(null, () => App.go('partners'));
    el.querySelectorAll('[data-e]').forEach(b => {
      b.onclick = () => partnerDialog(partners.find(p => p.id === Number(b.dataset.e)), () => App.go('partners'));
    });
    el.querySelectorAll('[data-pd]').forEach(b => {
      const p = partners.find(x => x.id === Number(b.dataset.pd));
      b.onclick = async () => {
        if (!await UI.confirm(`刪除合作單位「${p.name}」？仍有個案或請款紀錄時會改為停用。`)) return;
        try { const r = await DEL(`/partners/${p.id}`); UI.toast(r.message || '已刪除'); App.go('partners'); }
        catch (e) { UI.err(e); }
      };
    });
    el.querySelectorAll('[data-v]').forEach(b => {
      b.onclick = async () => {
        const p = await GET(`/partners/${b.dataset.v}`);
        UI.modal({
          title: p.name, wide: true, hideFooter: true,
          body: `<div class="detail-grid">
              <div><div class="dg-label">類別</div>${UI.esc(p.type)}</div>
              <div><div class="dg-label">統編</div>${UI.esc(p.tax_id || '-')}</div>
              <div><div class="dg-label">議定價</div>${UI.fmtMoney(p.rate)}</div>
              <div><div class="dg-label">契約</div>${p.contract_start || '-'} ~ ${p.contract_end || '-'}</div>
            </div>
            ${p.settle_note ? `<div style="margin-top:10px;font-size:13.5px;color:var(--muted)">請款方式：${UI.nl2br(p.settle_note)}</div>` : ''}
            <h3 style="margin-top:16px;font-size:15px">個案</h3>
            ${UI.table(['編號', '姓名', '主責', '狀態', '完成次數'], p.clients.map(c => `<tr>
              <td>${c.code}</td><td>${UI.esc(c.name)}</td><td>${UI.esc(c.counselor_name || '')}</td>
              <td>${TW.client_status[c.status]}</td><td>${c.sessions}</td></tr>`), '無個案')}
            ${p.groups.length ? `<h3 style="margin-top:16px;font-size:15px">委辦團體</h3>
              ${UI.table(['團體', '狀態', '開始'], p.groups.map(g => `<tr><td>${UI.esc(g.name)}</td>
                <td>${TW.group_status[g.status] || g.status}</td><td>${g.start_date || '-'}</td></tr>`))}` : ''}`
        });
      };
    });
    el.querySelector('#gen').onclick = () => UI.modal({
      title: '產生月結請款單',
      body: `<div class="form-grid">
        ${UI.select('partner_id', '合作單位', partners.filter(p => p.active).map(p => [p.id, p.name]), { full: true })}
        ${UI.input('month', '月份', { type: 'month', value: UI.thisMonth(), full: true })}</div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:10px">
          系統會彙整該單位個案當月「已完成」的晤談，依議定價計算金額。</div>`,
      onSubmit: async e => {
        const r = await POST('/settlements', UI.formData(e));
        UI.toast(`已產生：${r.sessions} 次 / ${UI.fmtMoney(r.amount)}`);
        App.go('partners');
      }
    });
    el.querySelectorAll('[data-p]').forEach(b => {
      b.onclick = async () => {
        const s = await GET(`/settlements/${b.dataset.p}`);
        UI.modal({
          title: '對帳單', wide: true, hideFooter: true,
          body: `<div id="printable" style="font-size:14px;line-height:1.9">
              <div style="text-align:center;font-size:17px;font-weight:700;margin-bottom:6px">
                ${UI.esc(s.center_name)}　服務費用對帳單</div>
              <div>受款單位：${UI.esc(s.partner_name)}${s.tax_id ? '（統編 ' + UI.esc(s.tax_id) + '）' : ''}</div>
              <div>結算月份：${s.month}　　議定單價：${UI.fmtMoney(s.rate)}</div>
              <div style="margin:10px 0">${UI.table(['日期', '時間', '個案編號', '心理師', '類型', '金額'],
            s.items.map(i => `<tr><td>${i.date}</td><td>${i.start_time}</td><td>${i.client_code}</td>
                  <td>${UI.esc(i.counselor_name || '')}</td><td>${UI.esc(TW.appt_type[i.type] || i.type)}</td>
                  <td>${UI.fmtMoney(s.rate || i.fee)}</td></tr>`))}</div>
              <div style="text-align:right;font-size:16px;font-weight:700">
                合計 ${s.sessions} 次　${UI.fmtMoney(s.amount)}</div>
              ${s.mismatch ? `<div class="notice warn" style="margin-top:10px">
                此請款單建立後晤談紀錄有異動：目前實際為 ${s.mismatch.sessions} 次、${UI.fmtMoney(s.mismatch.amount)}，
                與單上的 ${s.sessions} 次、${UI.fmtMoney(s.amount)} 不符。
                ${s.status === 'draft' ? '確認無誤可按下方「依現況重算」更新。' : '此單已送出／入帳，不會自動更新，請人工確認後處理。'}
              </div>` : ''}
              <div style="margin-top:10px;font-size:12.5px;color:var(--muted)">
                依保密原則，本對帳單以個案編號列示，不記載姓名。
                ${s.center_license_no ? '<br>開業執照字號：' + UI.esc(s.center_license_no) : ''}
                ${s.center_director ? '　負責心理師：' + UI.esc(s.center_director) : ''}</div>
              <div style="margin-top:24px">承辦人：＿＿＿＿＿　　主管：＿＿＿＿＿　　日期：＿＿＿＿＿</div>
            </div>
            <div style="margin-top:14px;display:flex;gap:8px">
              <button class="btn small secondary" onclick="window.print()">列印</button>
              ${s.mismatch && s.status === 'draft' ? '<button class="btn small" id="recalc">依現況重算</button>' : ''}
            </div>`
        });
        const rc = document.querySelector('#recalc');
        if (rc) rc.onclick = async () => {
          const r = await POST(`/settlements/${s.id}/recalculate`, {});
          UI.toast(`已重算：${r.sessions} 次、${UI.fmtMoney(r.amount)}`);
          App.go('partners');
        };
      };
    });
    el.querySelectorAll('[data-st]').forEach(b => {
      const s = settlements.find(x => x.id === Number(b.dataset.st));
      b.onclick = () => UI.modal({
        title: '請款單狀態',
        body: `<div class="form-grid">
          ${UI.select('status', '狀態', [['draft', '草稿'], ['sent', '已請款'], ['paid', '已入帳']], { value: s.status })}
          ${UI.input('invoice_no', '發票／收據號', { value: s.invoice_no || '' })}
          ${UI.textarea('note', '備註', { value: s.note || '' })}</div>`,
        onSubmit: async e => { await POST(`/settlements/${s.id}/status`, UI.formData(e)); App.go('partners'); }
      });
    });
    el.querySelectorAll('[data-d]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('刪除此請款單？')) return;
        try { await DEL(`/settlements/${b.dataset.d}`); App.go('partners'); } catch (e) { UI.err(e); }
      };
    });
  }
});

// ---- 請假與繼續教育 ----
App.page('hr', {
  get title() { return App.feature('ce') ? '請假與繼續教育' : '請假管理'; },
  get sub() {
    return App.feature('ce')
      ? '請假期間不會出現在可預約時段；繼續教育積分供執照更新佐證'
      : '請假期間不會出現在可預約時段';
  },
  module: 'hr',
  async render(el) {
    // 繼續教育關閉時只留請假，仍照常取 ce 資料會浪費一次查詢，故條件取用
    const withCe = App.feature('ce');
    const [offs, ce, list] = await Promise.all([
      GET('/time-off'),
      withCe ? GET('/ce-summary') : Promise.resolve({ rows: [], cycle: 0, required: 0, required_special: 0, required_ethics: 0 }),
      withCe ? GET('/ce-credits') : Promise.resolve([])
    ]);
    el.innerHTML = `<div class="toolbar"><div class="spacer"></div>
        <button class="btn secondary" id="addoff">登錄請假</button>
        ${withCe ? '<button class="btn" id="addce">登錄積分</button>' : ''}</div>
      ${withCe ? `<div class="card"><h3>執照與繼續教育（每 ${ce.cycle} 年需 ${ce.required} 點，其中品質／倫理／法規合計 ${ce.required_special} 點、專業倫理另需 ${ce.required_ethics} 點）</h3>
        ${UI.table(['心理師', '證照', '執照更新日', '剩餘天數', '本週期積分', '特定類別', '專業倫理', '狀態'], ce.rows.map(r => `<tr>
          <td>${UI.esc(r.name)}</td><td>${UI.esc(r.license_type || '-')}</td>
          <td>${r.license_expiry || '未填'}</td>
          <td>${r.days_left === null ? '-' : (r.alert ? `<span style="color:var(--danger);font-weight:700">${r.days_left} 天</span>` : r.days_left + ' 天')}</td>
          <td><strong>${r.total_credits}</strong> / ${ce.required}</td>
          <td>${r.special_credits} / ${ce.required_special}</td>
          <td${r.ethics_credits < ce.required_ethics ? ' style="color:var(--danger);font-weight:600"' : ''}>${r.ethics_credits} / ${ce.required_ethics}</td>
          <td>${r.ok ? UI.tag('已達標', 'ok') : UI.tag('尚未達標', 'warn')}</td></tr>`))}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          計算區間為執照更新日往前推 ${ce.cycle} 年；實際規定以主管機關公告為準。</div></div>` : ''}
      <div class="card"><h3>請假／不可預約時段</h3>
        ${UI.table(['心理師', '期間', '時段', '事由', ''], offs.map(o => `<tr>
          <td>${UI.esc(o.counselor_name)}</td>
          <td>${o.start_date}${o.end_date !== o.start_date ? ' ~ ' + o.end_date : ''}</td>
          <td>${o.all_day ? '全天' : `${o.start_time}-${o.end_time}`}</td>
          <td>${UI.esc(o.reason || '-')}</td>
          <td style="white-space:nowrap">
            <button class="btn tiny ${o.resolved ? 'secondary' : ''}" data-imp="${o.id}">
              ${o.resolved ? '已處理' : '受影響預約'}</button>
            <button class="btn tiny danger" data-do="${o.id}">刪除</button></td></tr>`), '目前沒有請假紀錄')}
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          請假期間若已有預約，要逐案改期、換人或取消——排班表上留下無人負責的時段，個案會白跑一趟。</div></div>
      ${withCe ? `<div class="card"><h3>繼續教育明細</h3>
        ${UI.table(['日期', '心理師', '課程', '主辦', '類別', '時數', '積分', ''], list.map(c => `<tr>
          <td>${c.date}</td><td>${UI.esc(c.user_name)}</td><td>${UI.esc(c.title)}</td>
          <td>${UI.esc(c.organizer || '-')}</td><td>${UI.esc(c.category)}</td>
          <td>${c.hours}</td><td>${c.credits}</td>
          <td><button class="btn tiny danger" data-dc="${c.id}">刪除</button></td></tr>`), '尚無積分紀錄')}</div>` : ''}`;

    el.querySelector('#addoff').onclick = () => UI.modal({
      title: '登錄請假／不可預約',
      body: `<div class="form-grid">
        ${UI.select('counselor_id', '心理師', App.counselorOptions(), { value: App.me.id })}
        ${UI.input('start_date', '起始日', { type: 'date', value: UI.today() })}
        ${UI.input('end_date', '結束日', { type: 'date', value: UI.today() })}
        ${UI.checkbox('all_day', '全天不可預約', true)}
        ${UI.input('start_time', '起（非全天時填）', { type: 'time' })}
        ${UI.input('end_time', '迄（非全天時填）', { type: 'time' })}
        ${UI.inputList('reason', '事由', App.meta.time_off_reasons || [], { full: true })}
        ${UI.checkbox('force', '期間已有預約時仍要登錄（我會另行改期）', false)}
      </div>`,
      onSubmit: async e => { await POST('/time-off', UI.formData(e)); UI.toast('已登錄'); App.go('hr'); }
    });
    if (withCe) el.querySelector('#addce').onclick = () => UI.modal({
      title: '登錄繼續教育積分',
      body: `<div class="form-grid">
        ${UI.select('user_id', '心理師', App.counselorOptions(), { value: App.me.id })}
        ${UI.input('date', '日期', { type: 'date', value: UI.today() })}
        ${UI.input('title', '課程名稱', { full: true })}
        ${UI.input('organizer', '主辦單位')}
        ${UI.select('category', '類別', App.listOptions('ce_categories', ['專業課程']))}
        ${UI.input('hours', '時數', { type: 'number', step: '0.5' })}
        ${UI.input('credits', '積分點數', { type: 'number', step: '0.5' })}
        ${UI.input('cert_no', '證書字號')}
        ${UI.textarea('note', '備註')}</div>`,
      onSubmit: async e => { await POST('/ce-credits', UI.formData(e)); UI.toast('已登錄'); App.go('hr'); }
    });
    el.querySelectorAll('[data-imp]').forEach(b => {
      b.onclick = () => timeOffImpact(Number(b.dataset.imp));
    });
    el.querySelectorAll('[data-do]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('刪除此請假紀錄？')) return;
        try { await DEL(`/time-off/${b.dataset.do}`); App.go('hr'); } catch (e) { UI.err(e); }
      };
    });
    el.querySelectorAll('[data-dc]').forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm('刪除此積分紀錄？')) return;
        try { await DEL(`/ce-credits/${b.dataset.dc}`); App.go('hr'); } catch (e) { UI.err(e); }
      };
    });
  }
});

// ---- 紀錄保存年限 ----
App.page('retention', {
  title: '紀錄保存與歸檔',
  sub: '結案滿保存年限的個案，可依所內政策歸檔或銷毀',
  module: 'clients',
  async render(el) {
    const d = await GET('/retention');
    el.innerHTML = `<div class="card">
      <div style="font-size:13px;color:var(--muted);margin-bottom:10px">
        目前保存年限設定為 <strong>${d.years} 年</strong>（可於系統設定調整）。
        心理紀錄之保存與銷毀應依主管機關規定與所內作業辦法辦理，系統僅提供到期清單，不會自動刪除資料。</div>
      ${UI.table(['個案編號', '姓名', '結案日', '結案原因', '結案年數', '晤談紀錄數'], d.rows.map(r => `<tr>
        <td>${r.code}</td><td>${UI.esc(r.name)}</td><td>${r.close_date}</td>
        <td>${UI.esc(r.close_reason || '-')}</td><td>${r.years_closed} 年</td><td>${r.notes}</td></tr>`),
      '目前沒有屆滿保存年限的個案')}</div>`;
  }
});

// ---- 心理師報酬與扣繳 ----
// 外聘心理師與督導的鐘點多屬執行業務所得，所方為扣繳義務人：
// 須代扣所得稅，並於單次給付達門檻時扣繳二代健保補充保費。
// 系統依設定的費率自動試算，實際適用情形仍請與記帳單位確認。
const INCOME_TYPES = [['9B', '9B 執行業務所得（一般）'], ['9A', '9A 執行業務所得（律師會計師等）'], ['50', '50 薪資所得']];

function payoutDialog(p, month, onDone) {
  const isNew = !p;
  const d = p || { month, item: '晤談鐘點', income_type: '9B' };
  UI.modal({
    title: isNew ? '新增報酬單' : '編輯報酬單',
    body: `<div class="form-grid">
        ${UI.select('user_id', '心理師', App.counselorOptions(), { value: d.user_id || App.me.id })}
        ${UI.input('month', '給付月份', { type: 'month', value: d.month })}
        ${UI.input('item', '項目', { value: d.item || '' })}
        ${UI.input('sessions', '節數／場次', { type: 'number', value: d.sessions || '' })}
        ${UI.input('gross', '給付總額', { type: 'number', value: d.gross || '' })}
        ${UI.select('income_type', '所得類別', INCOME_TYPES, { value: d.income_type })}
        ${UI.input('withholding', '代扣所得稅', { type: 'number', value: isNew ? '' : d.withholding })}
        ${UI.input('nhi_supplement', '二代健保補充保費', { type: 'number', value: isNew ? '' : d.nhi_supplement })}
        ${UI.textarea('note', '備註', { value: d.note || '' })}
      </div>
      <div class="notice" id="calc" style="margin-top:10px"></div>`,
    onOpen: el => {
      const gross = el.querySelector('[name=gross]');
      const type = el.querySelector('[name=income_type]');
      const wh = el.querySelector('[name=withholding]');
      const nhi = el.querySelector('[name=nhi_supplement]');
      const box = el.querySelector('#calc');
      let touched = !isNew;
      [wh, nhi].forEach(i => { i.oninput = () => { touched = true; show(); }; });
      const show = () => {
        const g = Number(gross.value) || 0;
        const w = Number(wh.value) || 0, n = Number(nhi.value) || 0;
        box.innerHTML = `給付總額 ${UI.fmtMoney(g)}　－代扣所得稅 ${UI.fmtMoney(w)}　－補充保費 ${UI.fmtMoney(n)}
          　＝ <strong>實付 ${UI.fmtMoney(g - w - n)}</strong>`;
      };
      // 未手動改過扣繳金額時，跟著給付總額即時重算
      const recalc = async () => {
        const g = Number(gross.value) || 0;
        if (!touched) {
          const r = await GET(`/payouts/preview?gross=${g}&income_type=${type.value}`);
          wh.value = r.withholding;
          nhi.value = r.nhi_supplement;
        }
        show();
      };
      gross.oninput = () => { clearTimeout(el._t); el._t = setTimeout(recalc, 250); };
      type.onchange = recalc;
      show();
    },
    onSubmit: async el => {
      const data = UI.formData(el);
      if (!Number(data.gross)) throw new Error('請填寫給付總額');
      if (isNew) await POST('/payouts', data); else await PUT(`/payouts/${d.id}`, data);
      UI.toast('已儲存');
      onDone && onDone();
    }
  });
}

App.page('payouts', {
  title: '報酬與扣繳',
  sub: '心理師鐘點給付、代扣所得稅與二代健保補充保費；年度彙總供申報扣繳憑單',
  module: 'payouts',
  async render(el) {
    const draw = async () => {
      const month = el.querySelector('#m').value;
      const st = el.querySelector('#st').value;
      const d = await GET(`/payouts?month=${month}&status=${st}`);
      el.querySelector('#list').innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="num">${UI.fmtMoney(d.total_gross)}</div><div class="label">給付總額</div></div>
          <div class="stat"><div class="num warn">${UI.fmtMoney(d.total_withholding)}</div><div class="label">代扣所得稅</div></div>
          <div class="stat"><div class="num warn">${UI.fmtMoney(d.total_nhi)}</div><div class="label">補充保費</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(d.total_net)}</div><div class="label">實付合計</div></div>
        </div>
        <div class="card">${UI.table(['月份', '心理師', '項目', '節數', '給付總額', '所得類別', '代扣稅額', '補充保費', '實付', '狀態', ''],
          d.rows.map(p => `<tr>
            <td>${p.month}</td><td>${UI.esc(p.user_name)}</td><td>${UI.esc(p.item)}</td>
            <td>${p.sessions || '-'}</td><td>${UI.fmtMoney(p.gross)}</td><td>${p.income_type}</td>
            <td>${UI.fmtMoney(p.withholding)}</td><td>${UI.fmtMoney(p.nhi_supplement)}</td>
            <td><strong>${UI.fmtMoney(p.net)}</strong></td>
            <td>${p.status === 'paid' ? UI.tag('已付 ' + p.paid_at, 'ok') : UI.tag('待付款', 'warn')}</td>
            <td style="white-space:nowrap">
              ${p.status === 'paid' ? `<button class="btn tiny secondary" data-unpay="${p.id}">取消付款</button>`
    : `<button class="btn tiny secondary" data-e="${p.id}">編輯</button>
                 <button class="btn tiny" data-pay="${p.id}">付款</button>
                 <button class="btn tiny danger" data-d="${p.id}">刪除</button>`}</td></tr>`),
          '此月份尚無報酬單')}</div>`;
      el.querySelectorAll('[data-e]').forEach(b => {
        b.onclick = () => payoutDialog(d.rows.find(x => x.id === Number(b.dataset.e)), month, draw);
      });
      el.querySelectorAll('[data-pay]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('確認此筆已付款？付款後金額不可修改。')) return;
          await POST(`/payouts/${b.dataset.pay}/pay`, {});
          UI.toast('已標記付款'); draw();
        };
      });
      el.querySelectorAll('[data-unpay]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('取消付款狀態？')) return;
          await POST(`/payouts/${b.dataset.unpay}/pay`, {});
          draw();
        };
      });
      el.querySelectorAll('[data-d]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('刪除此報酬單？')) return;
          try { await DEL(`/payouts/${b.dataset.d}`); draw(); } catch (e) { UI.err(e); }
        };
      });
    };

    el.innerHTML = `<div class="toolbar">
        <label>月份</label><input id="m" type="month" value="${UI.thisMonth()}">
        <select id="st"><option value="">全部</option><option value="pending">待付款</option><option value="paid">已付款</option></select>
        <div class="spacer"></div>
        <button class="btn secondary" id="sum">年度扣繳彙總</button>
        <button class="btn secondary" id="gen">依當月晤談帶入</button>
        <button class="btn" id="add">新增報酬單</button>
      </div><div id="list"></div>`;
    el.querySelector('#m').onchange = draw;
    el.querySelector('#st').onchange = draw;
    el.querySelector('#add').onclick = () => payoutDialog(null, el.querySelector('#m').value, draw);

    // 依當月已完成晤談自動帶出鐘點，省去人工加總；金額與扣繳仍可逐筆調整
    el.querySelector('#gen').onclick = async () => {
      const month = el.querySelector('#m').value;
      const rows = await GET('/payouts/suggest?month=' + month);
      if (!rows.length) return UI.toast('當月沒有已完成的晤談');
      UI.modal({
        title: `${month} 依晤談量帶入報酬單`,
        wide: true,
        submitText: '建立勾選項目',
        body: `${UI.table(['', '心理師', '完成節數', '晤談收費合計', '給付總額'], rows.map((r, i) => `<tr>
            <td><input type="checkbox" class="pk" data-i="${i}" checked></td>
            <td>${UI.esc(r.user_name)}</td><td>${r.sessions}</td><td>${UI.fmtMoney(r.fee_total)}</td>
            <td><input class="gross" data-i="${i}" type="number" value="${r.fee_total}" style="width:120px"></td></tr>`))}
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            預設帶入當月晤談收費合計，請依實際拆帳比例調整給付總額；扣繳金額於建立時自動試算。</div>`,
        onSubmit: async e2 => {
          const picks = [...e2.querySelectorAll('.pk')].filter(c => c.checked).map(c => Number(c.dataset.i));
          if (!picks.length) throw new Error('請至少勾選一位');
          for (const i of picks) {
            const g = Number(e2.querySelector(`.gross[data-i="${i}"]`).value) || 0;
            await POST('/payouts', {
              user_id: rows[i].user_id, month, item: '晤談鐘點',
              sessions: rows[i].sessions, gross: g, income_type: '9B'
            });
          }
          UI.toast(`已建立 ${picks.length} 筆`);
          draw();
        }
      });
    };

    el.querySelector('#sum').onclick = async () => {
      const year = el.querySelector('#m').value.slice(0, 4);
      const rows = await GET('/payouts/withholding-summary?year=' + year);
      UI.modal({
        title: `${year} 年度扣繳彙總（已付款）`, hideFooter: true, wide: true,
        body: `<div id="printable">${UI.table(['所得人', '證照', '所得類別', '筆數', '給付總額', '代扣稅額', '補充保費', '實付'],
          rows.map(r => `<tr><td>${UI.esc(r.user_name)}</td><td>${UI.esc(r.license_type || '-')}</td>
            <td>${r.income_type}</td><td>${r.items}</td><td>${UI.fmtMoney(r.gross)}</td>
            <td>${UI.fmtMoney(r.withholding)}</td><td>${UI.fmtMoney(r.nhi_supplement)}</td>
            <td><strong>${UI.fmtMoney(r.net)}</strong></td></tr>`), '本年度尚無已付款紀錄')}
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            本表供填報各類所得扣繳暨免扣繳憑單參考，正式申報金額請與記帳單位核對。</div></div>
          <button class="btn small secondary" style="margin-top:14px" onclick="window.print()">列印</button>`
      });
    };
    await draw();
  }
});

// ---- 請假造成的預約異動（M3-03）----
// 整段下架不是把時段關掉就好，已排的預約要逐案有結論。
async function timeOffImpact(id) {
  const d = await GET(`/time-off/${id}/impact`);
  const t = d.time_off;
  const render = () => `
    <div class="notice ${d.rows.length ? 'warn' : 'ok'}" style="margin-bottom:10px">
      ${UI.esc(t.counselor_name)}　${t.start_date}${t.end_date !== t.start_date ? ' ~ ' + t.end_date : ''}
      ${t.all_day ? '（全天）' : `（${t.start_time}-${t.end_time}）`}
      ${d.rows.length ? `：期間內有 <strong>${d.rows.length}</strong> 筆預約待處理`
    : '：期間內沒有待處理的預約'}</div>
    ${d.rows.length ? UI.table(['日期', '時間', '個案', '電話', '諮商室', ''], d.rows.map(a => `<tr>
      <td>${a.date}</td><td>${a.start_time}-${a.end_time}</td>
      <td><a href="#client/${a.client_id}">${UI.esc(a.client_name)}</a>
        <div style="font-size:12px;color:var(--muted)">${UI.esc(a.client_code)}</div></td>
      <td>${UI.esc(a.phone || '-')}</td>
      <td>${UI.esc(a.room_name || '-')}</td>
      <td style="white-space:nowrap">
        <button class="btn tiny" data-re="${a.id}">改期</button>
        <button class="btn tiny secondary" data-rs="${a.id}">換人</button>
        <button class="btn tiny danger" data-cx="${a.id}">取消</button></td></tr>`)) : ''}`;

  const m = UI.modal({
    title: '請假期間的預約處理', wide: true, hideFooter: true,
    body: render() + `<div class="no-print" style="margin-top:12px">
      <button class="btn small secondary" id="finish">標記為已處理完畢</button></div>`
  });

  const refresh = async () => {
    document.querySelectorAll('.modal-mask').forEach(x => x.remove());
    timeOffImpact(id);
  };
  m.body.querySelectorAll('[data-re]').forEach(b => {
    b.onclick = async () => {
      const a = d.rows.find(x => x.id === Number(b.dataset.re));
      apptDialog(a, refresh);
    };
  });
  m.body.querySelectorAll('[data-rs]').forEach(b => {
    b.onclick = () => UI.modal({
      title: '改派給其他心理師',
      body: `<div class="form-grid">${UI.select('counselor_id', '接手的心理師',
    App.counselorOptions().filter(o => o[0] !== t.counselor_id))}</div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
          系統會檢查對方在該時段是否已有預約或請假。</div>`,
      onSubmit: async e => {
        await POST(`/appointments/${b.dataset.rs}/reassign`, UI.formData(e));
        UI.toast('已改派');
        refresh();
      }
    });
  });
  m.body.querySelectorAll('[data-cx]').forEach(b => {
    b.onclick = async () => {
      if (!await UI.confirm('取消這筆預約？建議先與個案聯繫。')) return;
      await POST(`/appointments/${b.dataset.cx}/status`, { status: 'cancelled', cancel_reason: '心理師請假' });
      UI.toast('已取消');
      refresh();
    };
  });
  m.body.querySelector('#finish').onclick = async () => {
    try {
      await POST(`/time-off/${id}/resolve`, {});
      UI.toast('已標記處理完畢');
      m.close();
      App.go('hr');
    } catch (e) { UI.err(e); }
  };
}
