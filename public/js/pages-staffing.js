// 排班與專業人員（M3）：可預約時段的提交與核定、產能、Ramp-up、請假異動
//
// 「可排時段」是利用率的分母，所以它需要一道核定手續——
// 分母被無聲改掉，所有績效數字都會失真。

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const SUB_STATUS = {
  draft: ['草稿', ''], submitted: ['待核定', 'warn'],
  approved: ['已核定', 'ok'], returned: ['已退回', 'danger']
};

function blocksText(blocks) {
  const byDay = {};
  for (const b of blocks) (byDay[b.weekday] = byDay[b.weekday] || []).push(`${b.start_time}-${b.end_time}`);
  return Object.entries(byDay).map(([wd, list]) => `週${WD[wd]} ${list.join('、')}`).join('　') || '（無）';
}

// 提交表單：以「星期 × 時段」的文字列輸入，比拖曳格子好複製與核對
function submitDialog(period, existing, done) {
  const rows = existing && existing.blocks.length ? existing.blocks : [{ weekday: 1, start_time: '09:00', end_time: '12:00' }];
  const line = (b, i) => `<div class="av-row" data-i="${i}">
      <select class="av-wd">${WD.map((w, n) => `<option value="${n}"${n === b.weekday ? ' selected' : ''}>週${w}</option>`).join('')}</select>
      <input type="time" class="av-st" value="${b.start_time}">
      <span>~</span>
      <input type="time" class="av-et" value="${b.end_time}">
      <button class="btn tiny danger av-del" type="button">移除</button>
    </div>`;
  UI.modal({
    title: `提交 ${period} 可預約時段`,
    wide: true,
    submitText: '送出核定',
    body: `<div class="form-grid">
        ${UI.select('site_id', '據點（不同據點分開提交）',
    [['', '不分據點']].concat((App.meta.sites || []).map(s => [s.id, s.name])),
    { value: existing ? (existing.site_id || '') : '', full: true })}
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin:8px 0">
        提交後由排班負責人核定；核定過的版本才會成為個案可預約的時段，也才會計入產能分母。</div>
      <div id="av-list">${rows.map(line).join('')}</div>
      <button class="btn small secondary" id="av-add" type="button" style="margin-top:8px">新增一列</button>
      <div class="form-grid" style="margin-top:10px">${UI.textarea('note', '說明（例如：這一季週三改到南京館）',
    { value: existing ? existing.note : '' })}</div>
      <div id="av-sum" style="font-size:13px;color:var(--muted);margin-top:8px"></div>`,
    onOpen: body => {
      const list = body.querySelector('#av-list');
      const sum = () => {
        const hours = [...list.querySelectorAll('.av-row')].reduce((n, r) => {
          const st = r.querySelector('.av-st').value, et = r.querySelector('.av-et').value;
          const toMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
          return n + Math.max(0, toMin(et) - toMin(st));
        }, 0) / 60;
        body.querySelector('#av-sum').textContent = `每週可排 ${Math.round(hours * 10) / 10} 小時（產能分母）`;
      };
      const bind = () => {
        list.querySelectorAll('.av-del').forEach(b => {
          b.onclick = () => { b.closest('.av-row').remove(); sum(); };
        });
        list.querySelectorAll('input,select').forEach(i => { i.onchange = sum; });
      };
      body.querySelector('#av-add').onclick = () => {
        const div = document.createElement('div');
        div.innerHTML = line({ weekday: 1, start_time: '14:00', end_time: '17:00' }, list.children.length);
        list.appendChild(div.firstElementChild);
        bind(); sum();
      };
      bind(); sum();
    },
    onSubmit: async body => {
      const blocks = [...body.querySelectorAll('.av-row')].map(r => ({
        weekday: Number(r.querySelector('.av-wd').value),
        start_time: r.querySelector('.av-st').value,
        end_time: r.querySelector('.av-et').value
      }));
      const d = UI.formData(body);
      await POST('/availability/submissions', {
        period, blocks, site_id: d.site_id, note: d.note,
        counselor_id: existing ? existing.counselor_id : undefined,
        resubmit: true
      });
      UI.toast('已送出核定');
      done();
    }
  });
}

App.page('availability-review', {
  title: '可預約時段核定',
  sub: '心理師按月／季提交，排班負責人核定；核定版本才是產能分母',
  module: 'schedule',
  async render(el) {
    const draw = async () => {
      const period = el.querySelector('#period').value;
      const d = await GET(`/availability/submissions?period=${encodeURIComponent(period)}`);
      const cap = await GET(`/staffing/capacity?month=${period.includes('Q') ? UI.today().slice(0, 7) : period}`);
      el.querySelector('#body').innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="num ${d.counts.submitted ? 'warn' : ''}">${d.counts.submitted}</div><div class="label">待核定</div></div>
          <div class="stat"><div class="num">${d.counts.approved}</div><div class="label">已核定</div></div>
          <div class="stat"><div class="num ${d.counts.returned ? 'danger' : ''}">${d.counts.returned}</div><div class="label">已退回</div></div>
          <div class="stat"><div class="num ${d.missing.length ? 'danger' : ''}">${d.missing.length}</div><div class="label">尚未提交</div></div>
        </div>
        ${d.missing.length ? `<div class="notice warn" style="margin-bottom:12px">
          <strong>${period} 尚未提交的心理師（${d.missing.length}）</strong><br>
          ${d.missing.map(m => UI.esc(m.name)).join('、')}</div>` : ''}
        <div class="card">
          ${UI.table(['心理師', '期間', '據點', '時段', '每週時數', '狀態', '核定', ''], d.rows.map(r => {
    const [label, tone] = SUB_STATUS[r.status] || [r.status, ''];
    return `<tr>
            <td>${UI.esc(r.counselor_name)}</td>
            <td>${UI.esc(r.period)}</td>
            <td>${UI.esc(r.site_name || '不分據點')}</td>
            <td class="wrap" style="font-size:13px">${UI.esc(blocksText(r.blocks))}</td>
            <td><strong>${r.weekly_hours}</strong> 小時</td>
            <td>${UI.tag(label, tone)}${r.review_note ? `<div style="font-size:12px;color:var(--muted)">${UI.esc(r.review_note)}</div>` : ''}</td>
            <td style="font-size:12.5px;color:var(--muted)">${r.approved_name ? UI.esc(r.approved_name) + '<br>' + UI.esc((r.approved_at || '').slice(5, 16)) : '-'}</td>
            <td style="white-space:nowrap">
              ${r.status === 'submitted' ? `<button class="btn tiny" data-ap="${r.id}">核定</button>
                <button class="btn tiny danger" data-rt="${r.id}">退回</button>` : ''}
              <button class="btn tiny secondary" data-ed="${r.id}">${r.status === 'approved' ? '重新送審' : '編輯'}</button>
              ${r.status === 'approved' ? '' : `<button class="btn tiny danger" data-dl="${r.id}">刪除</button>`}
            </td></tr>`;
  }), '此期間尚無提交')}
        </div>
        <div class="card"><h3>目前產能與利用率（${cap.month}）</h3>
          <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">
            利用率＝實際完成時數 ÷ 核定可排時數；<strong>未到不計入分子</strong>（時段被佔住但沒有產生服務）。
            全所目標 ${cap.target}%。</div>
          ${UI.table(['心理師', '合約', '核定可排時數', '完成時數', '完成次數', '利用率', '目標'],
    cap.rows.map(u => `<tr>
            <td>${UI.esc(u.name)}</td><td>${UI.esc(u.contract_type || '-')}</td>
            <td>${u.capacity_hours || '<span style="color:var(--danger)">未核定</span>'}</td>
            <td>${u.done_hours}</td><td>${u.sessions}</td>
            <td>${u.utilization === null ? '—'
    : `<strong style="color:${u.utilization >= u.target ? 'var(--ok)' : 'var(--warn)'}">${u.utilization}%</strong>`}</td>
            <td>${u.target}%</td></tr>`))}
        </div>`;

      el.querySelectorAll('[data-ap]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('核定這份時段？核定後會取代該心理師在此據點目前的可預約時段。')) return;
          const out = await POST(`/availability/submissions/${b.dataset.ap}/approve`, {});
          UI.toast(`已核定，每週 ${out.weekly_hours} 小時`);
          draw();
        };
      });
      el.querySelectorAll('[data-rt]').forEach(b => {
        b.onclick = () => UI.modal({
          title: '退回時段提交',
          body: `<div class="form-grid">${UI.textarea('review_note', '退回原因（心理師會看到）')}</div>`,
          onSubmit: async e => { await POST(`/availability/submissions/${b.dataset.rt}/return`, UI.formData(e)); UI.toast('已退回'); draw(); }
        });
      });
      el.querySelectorAll('[data-ed]').forEach(b => {
        const r = d.rows.find(x => x.id === Number(b.dataset.ed));
        b.onclick = () => submitDialog(r.period, r, draw);
      });
      el.querySelectorAll('[data-dl]').forEach(b => {
        b.onclick = async () => {
          if (!await UI.confirm('刪除這份提交？')) return;
          try { await DEL(`/availability/submissions/${b.dataset.dl}`); UI.toast('已刪除'); draw(); }
          catch (e) { UI.err(e); }
        };
      });
    };

    const thisMonth = UI.today().slice(0, 7);
    el.innerHTML = `<div class="toolbar" style="flex-wrap:wrap;gap:8px">
        <input id="period" value="${thisMonth}" style="width:120px" placeholder="2026-09 或 2026-Q4">
        <div class="spacer"></div>
        <button class="btn" id="mine">提交我的時段</button></div>
      <div id="body"></div>`;
    el.querySelector('#period').onchange = draw;
    el.querySelector('#mine').onclick = () => submitDialog(el.querySelector('#period').value, null, draw);
    await draw();
  }
});

App.page('rampup', {
  title: 'Ramp-up 追蹤',
  sub: '新進心理師到職後的利用率爬升；連續兩個月達標視為完成',
  module: 'hr',
  async render(el) {
    const d = await GET('/staffing/rampup');
    el.innerHTML = d.rows.length ? `
      <div class="card"><h3>總覽</h3>
        <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">
          目標利用率 ${d.target}%，觀察期 ${d.limit} 個月。連續兩個月達標即視為完成 Ramp-up；
          超過觀察期仍未達標者標紅，通常代表個案量分配或時段安排需要調整。</div>
        ${UI.table(['心理師', '到職日', '到職月數', 'Ramp-up', '狀態', '各月利用率'], d.rows.map(u => `<tr>
          <td>${UI.esc(u.name)}</td>
          <td>${UI.esc(u.hire_date)}</td>
          <td>${u.months_since_hire}</td>
          <td>${u.rampup_months ? `第 ${u.rampup_months} 個月` : '—'}</td>
          <td>${u.status === 'done' ? UI.tag('已完成', 'ok')
    : u.status === 'over' ? UI.tag('逾觀察期未達標', 'danger') : UI.tag('爬升中', 'warn')}</td>
          <td class="wrap">${u.months.map(m => `<span class="ramp-chip ${m.utilization === null ? '' : (m.utilization >= u.target ? 'ok' : 'low')}">
            ${m.month.slice(2)}　${m.utilization === null ? '未核定' : m.utilization + '%'}</span>`).join('')}</td>
        </tr>`))}
      </div>` : '<div class="empty">尚未有填寫到職日的心理師。請至「帳號權限」填入到職日後再回來看。</div>';
  }
});
