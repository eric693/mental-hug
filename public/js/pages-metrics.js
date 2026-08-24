// 財務指標（6.3）與心理師績效儀表板（6.4）
//
// 這兩頁的數字是前面所有模組的產物：分帳給營收拆分、排班核定給利用率的分母、
// 專案與租借各自歸位。所以這裡不再自己算一套，只負責把它們呈現清楚。

const OVERHEAD_METHODS = {
  revenue: '依營收比例', sessions: '依服務量', headcount: '依駐點人數', equal: '平均分攤'
};
const COST_KINDS = {
  direct: '據點直接成本', staff: '人員直接成本', overhead: '總部費用',
  interest: '利息', depreciation: '折舊', amortization: '攤銷'
};

App.page('finance-metrics', {
  title: '財務指標',
  sub: '據點損益、自費佔比、EBITDA 與應收帳齡；療程包套按次攤提',
  module: 'reports',
  async render(el) {
    const draw = async () => {
      const month = el.querySelector('#m').value;
      const d = await GET('/metrics/finance?month=' + month);
      const t = d.total;
      el.querySelector('#body').innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="num">${UI.fmtMoney(t.revenue)}</div><div class="label">總營收（權責認列）</div></div>
          <div class="stat"><div class="num">${d.all.self_pay_ratio === null ? '—' : d.all.self_pay_ratio + '%'}</div>
            <div class="label">自費佔比</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(t.contribution)}</div><div class="label">貢獻毛利合計</div></div>
          <div class="stat"><div class="num ${t.pretax < 0 ? 'danger' : ''}">${UI.fmtMoney(t.pretax)}</div>
            <div class="label">稅前損益</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(t.ebitda)}</div><div class="label">EBITDA</div></div>
          <div class="stat clickable" onclick="location.hash='overdue'"><div class="num ${d.ar.total ? 'warn' : ''}">${UI.fmtMoney(d.ar.total)}</div>
            <div class="label">應收帳款（${d.ar.count} 筆）</div></div>
        </div>

        <div class="grid-2">
          <div class="card"><h3>各據點營收占比</h3>
            ${UI.pieChart(d.rows.map(r => ({ label: r.name, value: r.revenue })),
    { format: v => UI.fmtMoney(v), empty: '本月尚無營收' })}</div>
          <div class="card"><h3>自費 vs 其他來源</h3>
            ${UI.pieChart([
    { label: '自費', value: d.all.self_pay },
    { label: '專案／補助／機構', value: Math.max(0, d.all.revenue - d.all.self_pay) }
  ], { format: v => UI.fmtMoney(v), empty: '本月尚無營收' })}</div>
          <div class="card"><h3>近 12 個月營收</h3>
            ${UI.barChart(d.trend.map(x => ({ label: x.month.slice(2), value: x.revenue })),
    { title: '近 12 個月營收', format: v => UI.fmtMoney(v).replace('NT$ ', '') })}
            <div style="font-size:12.5px;color:var(--muted);margin-top:6px">
              療程包套<strong>按次攤提</strong>：購買當月不整筆認列，改以每次使用時認列單價，
              避免賣方案的月份爆高、之後看起來像衰退。</div></div>
          <div class="card"><h3>應收帳齡（依來源別）</h3>
            ${UI.barChart(d.ar.rows.map(r => ({ label: r.payer, value: r.total })),
    { horizontal: true, format: v => UI.fmtMoney(v), empty: '目前沒有應收帳款' })}</div>
        </div>

        <div class="card"><h3>據點損益表</h3>
          <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">
            貢獻毛利＝營收 − 據點直接成本（不含總部分攤）；稅前損益再扣總部分攤。
            目前分攤規則：<strong>${UI.esc(OVERHEAD_METHODS[d.rule.method] || d.rule.method)}</strong>
            ${d.rule.effective_from ? `（${UI.esc(d.rule.effective_from)} 起）` : ''}${UI.esc(d.rule.note || '')}，
            本月總部費用 ${UI.fmtMoney(d.overhead)}。</div>
          ${UI.table(['據點', '營收', '其中方案攤提', '自費佔比', '直接成本', '貢獻毛利', '總部分攤', '稅前損益', 'EBITDA'],
    d.rows.map(r => `<tr>
            <td>${UI.esc(r.name)}</td>
            <td><strong>${UI.fmtMoney(r.revenue)}</strong></td>
            <td>${r.package_recognized ? `${UI.fmtMoney(r.package_recognized)}<div style="font-size:12px;color:var(--muted)">${r.package_sessions} 次</div>` : '-'}</td>
            <td>${r.self_pay_ratio === null ? '—' : r.self_pay_ratio + '%'}</td>
            <td>${UI.fmtMoney(r.direct_cost)}</td>
            <td>${UI.fmtMoney(r.contribution)}</td>
            <td>${UI.fmtMoney(r.overhead_share)}</td>
            <td><strong style="color:${r.pretax < 0 ? 'var(--danger)' : 'var(--ok)'}">${UI.fmtMoney(r.pretax)}</strong></td>
            <td>${UI.fmtMoney(r.ebitda)}</td></tr>`), '尚未建立據點')}
        </div>

        <div class="card"><h3>應收帳齡明細</h3>
          ${UI.table(['來源別', '30 天內', '31-60 天', '61-90 天', '90 天以上', '合計'],
    d.ar.rows.map(r => `<tr><td>${UI.esc(r.payer)}</td>
            <td>${UI.fmtMoney(r['30'])}</td><td>${UI.fmtMoney(r['60'])}</td>
            <td>${UI.fmtMoney(r['90'])}</td>
            <td>${r['90+'] ? `<span style="color:var(--danger)">${UI.fmtMoney(r['90+'])}</span>` : '-'}</td>
            <td><strong>${UI.fmtMoney(r.total)}</strong></td></tr>`), '目前沒有應收帳款')}
        </div>`;
    };

    el.innerHTML = `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
        <input type="month" id="m" value="${UI.today().slice(0, 7)}">
        <div class="spacer"></div>
        <button class="btn secondary" id="costs">成本登錄</button>
        <button class="btn secondary" id="rule">總部分攤規則</button>
        <button class="btn secondary" onclick="window.print()">列印</button></div>
      <div id="body"></div>`;
    el.querySelector('#m').onchange = draw;
    el.querySelector('#costs').onclick = () => costDialog(el.querySelector('#m').value, draw);
    el.querySelector('#rule').onclick = () => overheadDialog(draw);
    await draw();
  }
});

async function costDialog(month, done) {
  const d = await GET('/cost-entries?month=' + month + '&size=200');
  const sites = App.meta.sites || [];
  const m = UI.modal({
    title: `成本登錄　${month}`, wide: true, hideFooter: true,
    body: `<div class="form-grid">
        ${UI.select('kind', '類別', Object.entries(COST_KINDS))}
        ${UI.select('site_id', '據點（總部費用免填）', [['', '（總部）']].concat(sites.map(s => [s.id, s.name])))}
        ${UI.select('user_id', '人員（人員成本才填）', [['', '不指定']].concat(App.counselorOptions()))}
        ${UI.inputList('category', '科目', ['租金', '人事', '水電', '耗材', '行銷', '系統', '其他'])}
        ${UI.input('amount', '金額', { type: 'number' })}
        ${UI.input('note', '備註', { full: true })}
      </div>
      <button class="btn small" id="addcost" style="margin-top:10px">新增</button>
      <div id="costlist" style="margin-top:14px">${UI.table(['類別', '歸屬', '科目', '金額', '備註', ''],
    d.rows.map(r => `<tr>
        <td>${UI.esc(COST_KINDS[r.kind] || r.kind)}</td>
        <td>${UI.esc(r.site_name || r.user_name || '總部')}</td>
        <td>${UI.esc(r.category || '-')}</td>
        <td>${UI.fmtMoney(r.amount)}</td>
        <td class="wrap narrow">${UI.esc(r.note || '')}</td>
        <td><button class="btn tiny danger" data-cd="${r.id}">刪除</button></td></tr>`), '本月尚無成本紀錄')}</div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
        人員直接成本請填「含雇主負擔」的金額；沒有逐月登錄時，績效頁會以拆分報酬 × (1＋雇主負擔率) 概估並標示。</div>`
  });
  m.body.querySelector('#addcost').onclick = async () => {
    try {
      await POST('/cost-entries', { ...UI.formData(m.body), month });
      UI.toast('已新增');
      m.close();
      costDialog(month, done);
      done();
    } catch (e) { UI.err(e); }
  };
  m.body.querySelectorAll('[data-cd]').forEach(b => {
    b.onclick = async () => {
      if (!await UI.confirm('刪除這筆成本？')) return;
      await DEL(`/cost-entries/${b.dataset.cd}`);
      m.close();
      costDialog(month, done);
      done();
    };
  });
}

async function overheadDialog(done) {
  const d = await GET('/overhead-rules');
  UI.modal({
    title: '總部分攤規則', wide: true, submitText: '新增規則',
    body: `<div class="notice" style="margin-bottom:10px">
        目前適用：<strong>${UI.esc(OVERHEAD_METHODS[d.current.method] || d.current.method)}</strong>
        ${d.current.effective_from ? `（${UI.esc(d.current.effective_from)} 起）` : '（尚未設定，預設依營收）'}</div>
      <div class="form-grid">
        ${UI.input('effective_from', '自哪個月起適用', { value: UI.today().slice(0, 7), placeholder: '2026-09' })}
        ${UI.select('method', '分攤方式', Object.entries(OVERHEAD_METHODS))}
        ${UI.textarea('note', '說明（為什麼改）')}
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
        規則變更不會覆蓋舊規則：歷史月份仍套用當時生效的版本，變更本身也會寫入稽核軌跡。</div>
      <div style="margin-top:14px">${UI.table(['生效月份', '方式', '說明', '設定人', '設定時間'],
    d.rows.map(r => `<tr><td>${UI.esc(r.effective_from)}</td>
      <td>${UI.esc(OVERHEAD_METHODS[r.method] || r.method)}</td>
      <td class="wrap">${UI.esc(r.note || '')}</td>
      <td>${UI.esc(r.by_name || '')}</td>
      <td style="white-space:nowrap">${UI.esc(r.created_at.slice(0, 16))}</td></tr>`), '尚未設定過規則')}</div>`,
    onSubmit: async e => { await POST('/overhead-rules', UI.formData(e)); UI.toast('已新增規則'); done(); }
  });
}

// ---- 心理師績效儀表板（6.4）----
App.page('staff-metrics', {
  title: '心理師績效',
  sub: '利用率、每小時實收、貢獻毛利、營收集中度、指名比例與爽約率',
  module: 'reports',
  async render(el) {
    const draw = async () => {
      const month = el.querySelector('#m').value;
      const d = await GET('/metrics/staff?month=' + month);
      const top3 = d.rows.slice(0, 3).reduce((n, r) => n + r.revenue, 0);
      el.querySelector('#body').innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="num">${UI.fmtMoney(d.total_revenue)}</div><div class="label">當月總營收</div></div>
          <div class="stat"><div class="num ${d.total_revenue && top3 / d.total_revenue > 0.6 ? 'warn' : ''}">
            ${d.total_revenue ? Math.round(top3 / d.total_revenue * 100) : 0}%</div>
            <div class="label">前三位營收集中度</div></div>
          <div class="stat"><div class="num">${d.brand_acquisition.ratio === null ? '—' : d.brand_acquisition.ratio + '%'}</div>
            <div class="label">品牌獲客比例</div></div>
          <div class="stat"><div class="num">${d.retention.rate === null ? '—' : d.retention.rate + '%'}</div>
            <div class="label">${d.retention.year} 年留任率</div></div>
        </div>

        <div class="grid-2">
          <div class="card"><h3>營收貢獻占比</h3>
            ${UI.pieChart(d.rows.map(r => ({ label: r.name, value: r.revenue })),
    { format: v => UI.fmtMoney(v), empty: '本月尚無營收' })}
            <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
              集中度過高（前三位超過六成）代表營運倚賴少數人，離職風險會直接反映在營收上。</div></div>
          <div class="card"><h3>時段利用率</h3>
            ${UI.barChart(d.rows.filter(r => r.utilization !== null)
    .map(r => ({ label: r.name, value: r.utilization, note: `${r.hours} / ${r.capacity_hours} 小時` })),
  { horizontal: true, format: v => v + '%', empty: '尚無核定的可排時段，無法計算利用率' })}
            <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
              分母為<strong>核定後</strong>的可排時數；未到不計入分子。</div></div>
        </div>

        <div class="card"><h3>人員指標明細</h3>
          ${UI.table(['心理師', '合約', '完成', '時數', '利用率', '個人營收', '每小時實收',
    '直接成本', '貢獻毛利', '營收佔比', '累計', '指名比例', '爽約率', '臨時取消率'],
  d.rows.map(r => `<tr>
            <td>${UI.esc(r.name)}</td>
            <td style="font-size:12.5px">${UI.esc(r.contract_type || '-')}</td>
            <td>${r.sessions}</td>
            <td>${r.hours}</td>
            <td>${r.utilization === null ? '<span style="color:var(--muted)">未核定</span>'
    : `<strong style="color:${r.utilization >= (r.target_utilization || 70) ? 'var(--ok)' : 'var(--warn)'}">${r.utilization}%</strong>`}</td>
            <td>${UI.fmtMoney(r.revenue)}</td>
            <td>${r.hourly_rate === null ? '—' : UI.fmtMoney(r.hourly_rate)}</td>
            <td>${UI.fmtMoney(r.direct_cost)}${r.cost_estimated ? '<div style="font-size:11.5px;color:var(--muted)">概估</div>' : ''}</td>
            <td><strong style="color:${r.contribution < 0 ? 'var(--danger)' : ''}">${UI.fmtMoney(r.contribution)}</strong></td>
            <td>${r.revenue_share === null ? '—' : r.revenue_share + '%'}</td>
            <td style="color:var(--muted)">${r.cumulative_share === null ? '—' : r.cumulative_share + '%'}</td>
            <td>${r.designated_ratio === null ? '—' : r.designated_ratio + '%'}</td>
            <td>${r.no_show_rate ? `<span style="color:var(--danger)">${r.no_show_rate}%</span>` : '0%'}</td>
            <td>${r.cancel_rate ? r.cancel_rate + '%' : '0%'}</td></tr>`), '本月尚無資料')}
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            每小時實收＝個人營收 ÷ 實際成案時數（折扣後實收）。
            直接成本優先取逐月登錄的人事成本；未登錄時以拆分報酬 × (1＋雇主負擔 ${Math.round(d.burden_rate * 100)}%) 概估並標示。
            <strong>爽約率與臨時取消率分開統計</strong>——提前取消是合理行為，不該與爽約混為一談。</div>
        </div>

        <div class="card"><h3>品牌獲客</h3>
          <div style="font-size:13.5px;line-height:1.9">
            本月完成初談 <strong>${d.brand_acquisition.intake_total}</strong> 人次，
            其中未指定心理師 <strong>${d.brand_acquisition.no_designated}</strong> 人次
            （${d.brand_acquisition.ratio === null ? '—' : d.brand_acquisition.ratio + '%'}）。
            <div style="color:var(--muted);font-size:12.5px;margin-top:6px">
              這個比例反映的是「客人是被機構帶來的，還是被特定心理師帶來的」。
              比例低代表獲客高度依賴個人品牌，該員離開時個案容易一起流失。</div>
          </div></div>`;
    };
    el.innerHTML = `<div class="toolbar">
        <input type="month" id="m" value="${UI.today().slice(0, 7)}">
        <div class="spacer"></div>
        <button class="btn secondary" onclick="window.print()">列印</button></div>
      <div id="body"></div>`;
    el.querySelector('#m').onchange = draw;
    await draw();
  }
});
