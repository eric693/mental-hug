// 客戶分級與財務儀表板
// 兩頁都只用行政層資料（預約、出席、收費），不含晤談內容，行政人員即可檢視。

const TIER_TONE = {
  vip: 'ok', regular: 'ok', watch: 'warn', new: '',
  dormant: 'warn', attention: 'danger', closed: ''
};
const TIER_HINT = {
  vip: '完成次數多、出席穩定、無欠款',
  regular: '固定來談，狀況正常',
  watch: '次數尚少或出席普通，值得留意',
  new: '尚未完成第一次晤談，需確認是否到所',
  dormant: '久未晤談且沒有後續預約，可能已流失',
  attention: '有逾期未收款或出席率偏低，建議優先聯繫',
  closed: '已結案'
};

App.page('client-tiers', {
  title: '客戶分級',
  sub: '依諮詢次數、付費狀況與出席率自動分級，供聯繫與關懷排序',
  module: 'clients',
  async render(el) {
    const draw = async () => {
      const tier = el.querySelector('#tier').value;
      const d = await GET('/client-tiers' + (tier ? '?tier=' + tier : ''));
      el.querySelector('#body').innerHTML = `
        <div class="stat-grid">
          ${Object.entries(d.labels).map(([k, label]) => `
            <div class="stat clickable" data-t="${k}">
              <div class="num ${TIER_TONE[k] === 'danger' ? 'danger' : TIER_TONE[k] === 'warn' ? 'warn' : ''}">${d.counts[k]}</div>
              <div class="label">${UI.esc(label)}</div></div>`).join('')}
        </div>
        <div class="card">
          ${UI.table(['個案', '等級', '主責心理師', '完成', '未到', '取消', '出席率', '距上次', '下次預約', '已收', '未收', '判定依據'],
    d.rows.map(c => `<tr>
            <td><a href="#client/${c.id}">${UI.esc(c.name)}</a>
              <div style="font-size:12px;color:var(--muted)">${UI.esc(c.code)}</div></td>
            <td>${UI.tag(d.labels[c.tier] || c.tier, TIER_TONE[c.tier] || '')}</td>
            <td>${UI.esc(c.counselor_name || '未指定')}</td>
            <td><strong>${c.done}</strong></td>
            <td>${c.no_show ? `<span style="color:var(--danger)">${c.no_show}</span>` : 0}</td>
            <td>${c.cancelled}</td>
            <td>${c.attendance === null ? '—' : c.attendance + '%'}</td>
            <td>${c.days_since === null ? '—' : c.days_since + ' 天'}</td>
            <td>${c.next_appt || '<span style="color:var(--muted)">無</span>'}</td>
            <td>${UI.fmtMoney(c.net_paid)}</td>
            <td>${c.unpaid_amount ? `<span style="color:var(--danger)">${UI.fmtMoney(c.unpaid_amount)}</span>` : '-'}</td>
            <td class="wrap narrow" style="font-size:12.5px;color:var(--muted)">${UI.esc(c.why)}</td>
          </tr>`), '沒有符合條件的個案')}
        </div>
        <div class="card"><h3>分級是怎麼算的</h3>
          <div style="font-size:13.5px;line-height:1.9">
            三個面向各給 0–2 分後合計：<strong>使用程度</strong>（累計完成晤談，
            ≥ ${d.rules.vip_sessions} 次得 2 分、≥ ${d.rules.regular_sessions} 次得 1 分）、
            <strong>付費狀況</strong>（無逾期且有實收或有效方案得 2 分，有逾期得 0 分）、
            <strong>出席率</strong>（≥ ${d.rules.good_attendance}% 得 2 分、≥ ${d.rules.poor_attendance}% 得 1 分）。
            出席率＝完成 ÷（完成＋未到），<strong>取消不計入</strong>——提前取消是合理行為，不該與爽約同等看待。
          </div>
          <div style="font-size:13px;color:var(--muted);margin-top:10px">
            ${Object.entries(d.labels).map(([k, label]) =>
    `<div>${UI.tag(label, TIER_TONE[k] || '')}　${UI.esc(TIER_HINT[k] || '')}</div>`).join('')}
          </div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:10px">
            門檻可於系統設定調整（tier_ 開頭的設定）。分級只用於行政聯繫排序，
            <strong>不代表個案的臨床狀態，也不應影響服務內容或收費</strong>。</div>
        </div>`;
      el.querySelectorAll('[data-t]').forEach(b => {
        b.onclick = () => { el.querySelector('#tier').value = b.dataset.t; draw(); };
      });
    };
    el.innerHTML = `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
        ${UI.tableFilter('tierq', el, { placeholder: '搜尋個案／主責心理師' })}
        ${UI.select('tier', '等級', [['', '全部']].concat(Object.entries({
    vip: '長期穩定', regular: '固定', watch: '觀察', new: '新收',
    dormant: '沉睡', attention: '需關注', closed: '已結案'
  })))}
        <div class="spacer"></div></div>
      <div id="body"></div>`;
    el.querySelector('#tier').onchange = draw;
    await draw();
  }
});

App.page('finance', {
  title: '財務儀表板',
  sub: '實收、未收、退費、報酬與各心理師／據點的營收結構',
  module: 'billing',
  async render(el) {
    const draw = async () => {
      const month = el.querySelector('#m').value;
      const d = await GET(`/finance/dashboard?month=${month}`);
      const s = d.summary;
      const growth = s.growth === null ? '—'
        : `${s.growth > 0 ? '+' : ''}${s.growth}%`;
      el.querySelector('#body').innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="num">${UI.fmtMoney(s.net)}</div>
            <div class="label">當月實收（收款−退費）</div></div>
          <div class="stat"><div class="num ${s.growth !== null && s.growth < 0 ? 'warn' : ''}">${growth}</div>
            <div class="label">與上月比較（上月 ${UI.fmtMoney(s.prev_net)}）</div></div>
          <div class="stat"><div class="num">${s.sessions}</div><div class="label">當月完成晤談</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(s.avg_fee)}</div><div class="label">平均單次收入</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(s.payout)}</div><div class="label">當月心理師報酬（實付）</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(s.gross_margin)}</div><div class="label">實收扣除報酬後</div></div>
          <div class="stat clickable" onclick="location.hash='billing'"><div class="num ${s.unpaid_total ? 'warn' : ''}">${UI.fmtMoney(s.unpaid_total)}</div>
            <div class="label">未收款總額</div></div>
          <div class="stat clickable" onclick="location.hash='overdue'"><div class="num ${s.overdue_total ? 'danger' : ''}">${UI.fmtMoney(s.overdue_total)}</div>
            <div class="label">逾期未收（${s.overdue_count} 筆）</div></div>
          <div class="stat"><div class="num">${UI.fmtMoney(s.unused_package_value)}</div>
            <div class="label">方案未使用餘額（預收未實現）</div></div>
        </div>

        <div class="grid-2">
          <div class="card"><h3>近 12 個月實收</h3>
            ${UI.barChart(d.months.map(m => ({ label: m.month.slice(2), value: m.net })),
    { title: '近 12 個月實收', format: v => UI.fmtMoney(v).replace('NT$ ', '') })}
            <div style="font-size:12.5px;color:var(--muted);margin-top:6px">實收＝當月已收款金額扣除當月退費。</div></div>
          <div class="card"><h3>近 12 個月完成晤談</h3>
            ${UI.barChart(d.months.map(m => ({ label: m.month.slice(2), value: m.sessions })), { title: '近 12 個月完成晤談' })}</div>
          <div class="card"><h3>當月收入結構（付款人別）</h3>
            ${UI.barChart(d.by_payer.map(x => ({ label: x.payer, value: x.amount, note: `${x.n} 筆` })),
    { horizontal: true, title: '付款人別', format: v => UI.fmtMoney(v).replace('NT$ ', ''), empty: '本月尚無收款' })}</div>
          <div class="card"><h3>當月付款方式</h3>
            ${UI.barChart(d.by_method.map(x => ({ label: x.method, value: x.amount, note: `${x.n} 筆` })),
    { horizontal: true, title: '付款方式', format: v => UI.fmtMoney(v).replace('NT$ ', ''), empty: '本月尚無收款' })}</div>
        </div>

        <div class="card"><h3>當月各心理師營收</h3>
          ${UI.table(['心理師', '完成晤談', '對應收入', '平均單次'], d.by_counselor.map(x => `<tr>
            <td>${UI.esc(x.name)}</td><td>${x.sessions}</td><td>${UI.fmtMoney(x.amount)}</td>
            <td>${x.sessions ? UI.fmtMoney(Math.round(x.amount / x.sessions)) : '-'}</td></tr>`), '本月尚無完成的晤談')}
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            收入以該次晤談對應的收費單計算；方案扣次的晤談其金額已於購買方案時認列，故此處為 0。</div></div>

        <div class="card"><h3>當月各據點</h3>
          ${UI.table(['據點', '完成晤談', '對應收入'], d.by_site.map(x => `<tr>
            <td>${UI.esc(x.site)}</td><td>${x.sessions}</td><td>${UI.fmtMoney(x.amount)}</td></tr>`), '本月尚無完成的晤談')}</div>

        <div class="card"><h3>逾期未收款（前 20 筆）</h3>
          ${UI.table(['費用日期', '逾期', '個案', '電話', '項目', '金額', ''], d.top_overdue.map(x => `<tr>
            <td>${x.date}</td>
            <td><span style="color:var(--danger);font-weight:600">${x.days} 天</span></td>
            <td><a href="#client/${x.client_id}">${UI.esc(x.client_name)}</a>
              <div style="font-size:12px;color:var(--muted)">${UI.esc(x.client_code)}</div></td>
            <td>${UI.esc(x.phone || '-')}</td>
            <td class="wrap narrow">${UI.esc(x.item)}</td>
            <td>${UI.fmtMoney(x.amount)}</td>
            <td><a class="btn tiny secondary" href="#overdue">前往催繳</a></td></tr>`), '目前沒有逾期未收款')}</div>

        <div class="card"><h3>月度明細</h3>
          ${UI.table(['月份', '開立', '已收', '退費', '實收', '未收', '完成晤談', '平均單次', '心理師報酬', '實收扣報酬'],
    d.months.slice().reverse().map(m => `<tr>
            <td>${m.month}</td><td>${m.n}</td><td>${UI.fmtMoney(m.paid)}</td>
            <td>${m.refund ? `<span style="color:var(--danger)">${UI.fmtMoney(m.refund)}</span>` : '-'}</td>
            <td><strong>${UI.fmtMoney(m.net)}</strong></td>
            <td>${m.unpaid ? `<span style="color:var(--warn,#b7791f)">${UI.fmtMoney(m.unpaid)}</span>` : '-'}</td>
            <td>${m.sessions}</td><td>${UI.fmtMoney(m.avg_fee)}</td>
            <td>${UI.fmtMoney(m.payout)}</td><td>${UI.fmtMoney(m.gross_margin)}</td></tr>`))}
          <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
            收入以收費單日期認列，退費以退費日扣抵；心理師報酬取該月報酬單的實付金額。
            此表為經營管理用，非會計師簽證之財務報表。</div></div>`;
    };
    el.innerHTML = `<div class="toolbar">
        <input type="month" id="m" value="${UI.today().slice(0, 7)}">
        <div class="spacer"></div>
        <button class="btn secondary small" onclick="window.print()">列印</button></div>
      <div id="body"></div>`;
    el.querySelector('#m').onchange = draw;
    await draw();
  }
});
