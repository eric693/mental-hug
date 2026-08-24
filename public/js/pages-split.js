// 分帳引擎（M6）：規則與版本、模擬器、人員月結表
//
// 規則改版不覆蓋舊版：畫面上每條規則都看得到歷史版本，
// 已拆過的帳鎖在當時的版本，不會因為今天調比例而變。

const ITEM_TYPES = [['session', '晤談'], ['report', '書表製作'], ['room', '場地費'], ['other', '其他']];
const DESIGNATED = [['', '不限'], ['yes', '指名'], ['no', '派案']];

function ruleConditionText(v) {
  const parts = [];
  if (v.counselor_name) parts.push(`心理師：${v.counselor_name}`);
  if (v.site_name) parts.push(`據點：${v.site_name}`);
  if (v.appt_type) parts.push(`型態：${TW.appt_type[v.appt_type] || v.appt_type}`);
  if (v.item_type && v.item_type !== 'session') {
    parts.push(`項目：${(ITEM_TYPES.find(t => t[0] === v.item_type) || [])[1] || v.item_type}`);
  }
  if (v.designated) parts.push(v.designated === 'yes' ? '限指名' : '限派案');
  if (v.effective_from || v.effective_to) parts.push(`生效 ${v.effective_from || '不限'} ~ ${v.effective_to || '不限'}`);
  return parts.length ? parts.join('　') : '不限條件（作為預設規則）';
}

function splitText(v) {
  const bits = [];
  if (v.fixed_counselor) bits.push(`心理師先取 ${UI.fmtMoney(v.fixed_counselor)}`);
  if (v.fixed_center) bits.push(`機構先取 ${UI.fmtMoney(v.fixed_center)}`);
  bits.push(`其餘 心理師 ${v.counselor_pct}%／機構 ${100 - v.counselor_pct}%`);
  return bits.join('，');
}

function ruleVersionForm(v, isNew) {
  const d = v || { counselor_pct: 50, priority: 100, item_type: 'session', designated: '' };
  return `<div class="form-grid">
      ${isNew ? UI.input('name', '規則名稱', { value: '', full: true, required: true }) : ''}
      ${UI.select('counselor_id', '限定心理師', [['', '不限']].concat(App.counselorOptions()), { value: d.counselor_id || '' })}
      ${UI.select('site_id', '限定據點', [['', '不限']].concat((App.meta.sites || []).map(s => [s.id, s.name])), { value: d.site_id || '' })}
      ${UI.select('appt_type', '限定預約型態', [['', '不限']].concat(App.enumOptions('appt_type')), { value: d.appt_type || '' })}
      ${UI.select('item_type', '項目類別', ITEM_TYPES, { value: d.item_type || 'session' })}
      ${UI.select('designated', '指名／派案', DESIGNATED, { value: d.designated || '' })}
      ${UI.input('priority', '優先序（數字小者先套用）', { type: 'number', value: d.priority || 100 })}
      ${UI.input('effective_from', '生效起日', { type: 'date', value: d.effective_from || '' })}
      ${UI.input('effective_to', '生效迄日（留空＝持續有效）', { type: 'date', value: d.effective_to || '' })}
      ${UI.input('counselor_pct', '心理師比例（%）', { type: 'number', value: d.counselor_pct, min: 0, max: 100 })}
      ${UI.input('fixed_counselor', '心理師固定先取（元）', { type: 'number', value: d.fixed_counselor || 0 })}
      ${UI.input('fixed_center', '機構固定先取（元）', { type: 'number', value: d.fixed_center || 0 })}
      ${isNew ? UI.textarea('note', '備註（這條規則是什麼情況下用的）') : ''}
    </div>
    <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
      條件留空＝不限。多條規則命中時取<strong>優先序數字最小</strong>的那條；
      比例以心理師端為準，機構端自動為 100 − 心理師，四捨五入的餘數歸機構，兩邊相加必定等於原金額。</div>`;
}

App.page('split-rules', {
  title: '分帳規則',
  sub: '結構化條件 + 版本化：改規則不會動到已經拆過的歷史帳',
  module: 'payouts',
  async render(el) {
    const draw = async () => {
      const d = await GET('/split-rules');
      el.querySelector('#body').innerHTML = d.rules.length ? d.rules.map(r => {
        const cur = r.version_list[0];
        return `<div class="card">
          <div style="display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">
            <div style="flex:1;min-width:240px">
              <h3 style="margin-bottom:2px">${UI.esc(r.name)}
                ${r.active ? '' : UI.tag('已停用', '')}
                ${UI.tag('v' + (cur ? cur.version : 1), '')}</h3>
              <div style="font-size:12.5px;color:var(--muted)">${UI.esc(r.note || '')}</div>
            </div>
            <div style="white-space:nowrap">
              <button class="btn tiny" data-nv="${r.id}">改版</button>
              <button class="btn tiny secondary" data-ed="${r.id}">編輯名稱</button>
              <button class="btn tiny danger" data-del="${r.id}">刪除</button>
            </div>
          </div>
          ${cur ? `<div class="rule-cur">
            <div><strong>目前適用</strong>：${UI.esc(ruleConditionText(cur))}</div>
            <div style="margin-top:4px">${UI.esc(splitText(cur))}
              <span style="color:var(--muted)">優先序 ${cur.priority}</span></div>
          </div>` : '<div class="empty">尚未設定版本</div>'}
          ${r.version_list.length > 1 ? `<details style="margin-top:8px">
            <summary style="font-size:13px;color:var(--muted);cursor:pointer">歷史版本（${r.version_list.length - 1}）</summary>
            ${UI.table(['版本', '條件', '拆分', '建立時間'], r.version_list.slice(1).map(v => `<tr>
              <td>v${v.version}</td><td class="wrap">${UI.esc(ruleConditionText(v))}</td>
              <td class="wrap narrow">${UI.esc(splitText(v))}</td>
              <td style="white-space:nowrap">${UI.esc(v.created_at.slice(0, 16))}</td></tr>`))}
          </details>` : ''}
          <div style="font-size:12px;color:var(--muted);margin-top:6px">已套用於 ${r.used} 筆拆帳</div>
        </div>`;
      }).join('') : '<div class="empty">尚未建立任何分帳規則。收款時找不到規則就無法自動拆帳，建議至少先建一條「不限條件」的預設規則。</div>';

      el.querySelectorAll('[data-nv]').forEach(b => {
        const r = d.rules.find(x => x.id === Number(b.dataset.nv));
        b.onclick = () => UI.modal({
          title: `${r.name}：建立新版本`, wide: true, submitText: '建立新版本',
          body: `<div class="notice" style="margin-bottom:10px">
              目前是 v${r.version_list[0] ? r.version_list[0].version : 1}。
              建立新版本後，<strong>之後的拆帳</strong>套用新版；已經拆過的帳仍鎖在原版本。</div>
            ${ruleVersionForm(r.version_list[0], false)}`,
          onSubmit: async e => {
            await POST(`/split-rules/${r.id}/versions`, UI.formData(e));
            UI.toast('已建立新版本');
            draw();
          }
        });
      });
      el.querySelectorAll('[data-ed]').forEach(b => {
        const r = d.rules.find(x => x.id === Number(b.dataset.ed));
        b.onclick = () => UI.modal({
          title: '編輯規則',
          body: `<div class="form-grid">
            ${UI.input('name', '規則名稱', { value: r.name, full: true })}
            ${UI.textarea('note', '備註', { value: r.note })}
            ${UI.checkbox('active', '啟用中', r.active)}</div>`,
          onSubmit: async e => { await PUT(`/split-rules/${r.id}`, UI.formData(e)); UI.toast('已儲存'); draw(); }
        });
      });
      el.querySelectorAll('[data-del]').forEach(b => {
        const r = d.rules.find(x => x.id === Number(b.dataset.del));
        b.onclick = async () => {
          if (!await UI.confirm(`刪除規則「${r.name}」？已用於拆帳的規則會改為停用。`)) return;
          try { const out = await DEL(`/split-rules/${r.id}`); UI.toast(out.message || '已刪除'); draw(); }
          catch (e) { UI.err(e); }
        };
      });
    };

    el.innerHTML = `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
        ${UI.tableFilter('srq', el, { placeholder: '搜尋規則名稱／條件' })}
        <div class="spacer"></div>
        <button class="btn secondary" id="sim">試算模擬器</button>
        <button class="btn" id="add">新增規則</button></div>
      <div id="body"></div>`;

    el.querySelector('#add').onclick = () => UI.modal({
      title: '新增分帳規則', wide: true,
      body: ruleVersionForm(null, true),
      onSubmit: async e => { await POST('/split-rules', UI.formData(e)); UI.toast('已新增'); draw(); }
    });

    el.querySelector('#sim').onclick = () => UI.modal({
      title: '分帳試算', wide: true, submitText: '試算', hideFooter: false,
      body: `<div class="form-grid">
          ${UI.input('amount', '金額', { type: 'number', value: App.meta.default_fee || 2000 })}
          ${UI.input('date', '日期', { type: 'date', value: UI.today() })}
          ${UI.select('counselor_id', '心理師', App.counselorOptions())}
          ${UI.select('site_id', '據點', [['', '不限']].concat((App.meta.sites || []).map(s => [s.id, s.name])))}
          ${UI.select('appt_type', '預約型態', App.enumOptions('appt_type'))}
          ${UI.select('item_type', '項目類別', ITEM_TYPES)}
          ${UI.checkbox('designated', '個案指名這位心理師', false)}
        </div>
        <div id="sim-out" style="margin-top:12px"></div>`,
      onSubmit: async e => {
        const out = await POST('/split-rules/simulate', UI.formData(e));
        const box = e.querySelector('#sim-out');
        box.innerHTML = out.matched ? `
          <div class="notice ok"><strong>套用：${UI.esc(out.rule_label)}</strong>（優先序 ${out.priority}）</div>
          <div class="stat-grid" style="margin-top:10px">
            <div class="stat"><div class="num">${UI.fmtMoney(out.amount)}</div><div class="label">收費金額</div></div>
            <div class="stat"><div class="num">${UI.fmtMoney(out.counselor_amount)}</div><div class="label">心理師</div></div>
            <div class="stat"><div class="num">${UI.fmtMoney(out.center_amount)}</div><div class="label">機構</div></div>
          </div>`
          : `<div class="notice warn"><strong>${UI.esc(out.message)}</strong>
            ${out.candidates.length ? '<br>目前生效中的規則：' + out.candidates.map(c => UI.esc(`${c.rule} v${c.version}`)).join('、') : ''}</div>`;
        return false;   // 停留在視窗上，方便連續試不同條件
      }
    });

    await draw();
  }
});

App.page('settlement', {
  title: '人員月結',
  sub: '每筆拆分明細與合計，含次數與時數，供發薪對帳',
  module: 'payouts',
  async render(el) {
    const draw = async () => {
      const month = el.querySelector('#m').value;
      const d = await GET('/splits/settlement?month=' + month);
      el.querySelector('#body').innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="num">${d.total.sessions}</div><div class="label">拆帳筆數</div></div>
          <div class="stat"><div class="num">${d.total.hours}</div><div class="label">服務時數</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(d.total.amount)}</div><div class="label">收費總額</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(d.total.counselor_amount)}</div><div class="label">心理師合計</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(d.total.center_amount)}</div><div class="label">機構合計</div></div>
          <div class="stat"><div class="num ${d.unsplit.length ? 'danger' : ''}">${d.unsplit.length}</div><div class="label">未拆帳的收款單</div></div>
        </div>
        ${d.unsplit.length ? `<div class="card"><h3>未拆帳（月結前要先清掉）</h3>
          <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">
            這些單子已收款但找不到適用規則，或沒有對應的心理師。補好規則後按上方「重算本月」。</div>
          ${UI.table(['日期', '個案', '項目', '金額', ''], d.unsplit.map(i => `<tr>
            <td>${i.date}</td><td>${UI.esc(i.client_name)}（${UI.esc(i.client_code)}）</td>
            <td class="wrap narrow">${UI.esc(i.item)}</td><td>${UI.fmtMoney(i.amount)}</td>
            <td><button class="btn tiny secondary" data-fix="${i.id}">單筆重算</button></td></tr>`))}
        </div>` : ''}
        ${d.groups.map(g => `<div class="card">
          <h3>${UI.esc(g.counselor_name)}
            <span style="font-size:13px;font-weight:400;color:var(--muted)">
              　${g.sessions} 筆／${Math.round(g.minutes / 6) / 10} 小時
              心理師 ${UI.fmtMoney(g.counselor_amount)}　機構 ${UI.fmtMoney(g.center_amount)}</span></h3>
          ${UI.table(['日期', '個案', '項目', '套用規則', '金額', '心理師', '機構', '分鐘'],
    g.rows.map(r => `<tr>
            <td style="white-space:nowrap">${r.date || ''}</td>
            <td>${UI.esc(r.client_name || '')}${r.client_code ? `<div style="font-size:12px;color:var(--muted)">${UI.esc(r.client_code)}</div>` : ''}</td>
            <td class="wrap narrow">${UI.esc(r.item || '')}</td>
            <td class="wrap narrow" style="font-size:12.5px">${UI.esc(r.rule_label)}</td>
            <td>${UI.fmtMoney(r.amount)}</td>
            <td><strong>${UI.fmtMoney(r.counselor_amount)}</strong></td>
            <td>${UI.fmtMoney(r.center_amount)}</td>
            <td>${r.minutes || '-'}</td></tr>`))}
        </div>`).join('') || '<div class="empty">本月尚無拆帳資料</div>'}`;

      el.querySelectorAll('[data-fix]').forEach(b => {
        b.onclick = async () => {
          try { await POST(`/invoices/${b.dataset.fix}/split`, {}); UI.toast('已拆帳'); draw(); }
          catch (e) { UI.err(e); }
        };
      });
    };
    el.innerHTML = `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
        ${UI.tableFilter('stq', el, { placeholder: '搜尋心理師／個案／規則' })}
        <input type="month" id="m" value="${UI.today().slice(0, 7)}">
        <div class="spacer"></div>
        <button class="btn secondary" id="recalc">重算本月</button>
        <button class="btn secondary" onclick="window.print()">列印</button></div>
      <div id="body"></div>`;
    el.querySelector('#m').onchange = draw;
    el.querySelector('#recalc').onclick = async () => {
      if (!await UI.confirm('重算本月分帳？已拆過的維持原規則版本，只補算還沒拆的。')) return;
      const out = await POST('/splits/recalculate', { month: el.querySelector('#m').value });
      UI.toast(`已補算 ${out.done} 筆${out.failed.length ? `，${out.failed.length} 筆仍無法拆帳` : ''}`,
        out.failed.length > 0);
      draw();
    };
    await draw();
  }
});
