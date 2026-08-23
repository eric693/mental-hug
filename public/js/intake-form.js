// 個案端自填初談問卷（免登入，以連結中的 token 開啟）。
// 此頁不顯示任何既有個案資料，只讓填寫者提供自己的資料；送出後即不可再修改。

const token = new URLSearchParams(location.search).get('t') || '';
const app = document.getElementById('app');

function row(name, label, value = '', opts = {}) {
  const { type = 'text', placeholder = '', required = false } = opts;
  return `<div class="form-row full"><label>${UI.esc(label)}${required ? ' *' : ''}</label>
    <input name="${name}" type="${type}" value="${UI.esc(value)}" placeholder="${UI.esc(placeholder)}"></div>`;
}
function area(name, label, value = '', placeholder = '') {
  return `<div class="form-row full"><label>${UI.esc(label)}</label>
    <textarea name="${name}" placeholder="${UI.esc(placeholder)}">${UI.esc(value)}</textarea></div>`;
}

function fatal(msg) {
  app.innerHTML = `<div class="fam-wrap"><div class="fam-head"><h1>初談問卷</h1></div>
    <div class="fam-body"><div class="card"><div class="notice danger">${UI.esc(msg)}</div></div></div></div>`;
}

async function boot() {
  if (!token) return fatal('連結不完整，請使用諮商所提供的完整網址開啟。');
  let d;
  try { d = await GET('/public/intake-form/' + encodeURIComponent(token)); }
  catch (e) { return fatal(e.message); }

  const s = d.scale;
  app.innerHTML = `<div class="fam-wrap">
      <div class="fam-head">
        <h1>${UI.esc(d.center_name || '心理諮商所')}　初談問卷</h1>
        <div class="sub">填寫後由櫃檯建檔，可省去到所後謄寫的時間</div>
      </div>
      <div class="fam-body">
        ${d.crisis_note ? `<div class="crisis">${UI.nl2br(d.crisis_note)}</div>` : ''}
        <div class="card" style="font-size:13px;line-height:1.8;color:var(--muted)">
          本問卷內容僅供本所安排初談與服務使用，依個人資料保護法妥善保存，不會提供給第三人。
          有不便填寫的欄位可以留空，初談時再與心理師討論。
          ${d.expires_at ? `<br>本連結有效期限至 ${UI.esc(d.expires_at)}。` : ''}
        </div>

        <div class="card"><h3>基本資料</h3><div class="form-grid">
          ${row('name', '姓名', d.name, { required: true })}
          ${row('phone', '手機', d.phone, { type: 'tel', placeholder: '09xxxxxxxx' })}
          <div class="form-row full"><label>性別</label><select name="gender">
            ${[['', '不方便透露'], ['male', '男'], ['female', '女'], ['other', '其他']]
    .map(o => `<option value="${o[0]}"${o[0] === d.gender ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></div>
          ${row('birth_date', '出生日期', d.birth_date, { type: 'date' })}
          ${row('id_no', '身分證字號（初談建檔用）', d.id_no)}
          ${row('email', 'Email', d.email, { type: 'email' })}
          ${row('address', '通訊地址', d.address)}
          ${row('occupation', '職業／就讀學校', d.occupation)}
          ${row('marital', '婚姻狀況', d.marital, { placeholder: '未婚／已婚／離異…' })}
        </div></div>

        <div class="card"><h3>聯絡人</h3>
          <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">
            緊急聯絡人僅於評估有安全疑慮時聯繫；未滿 18 歲請填法定代理人。</div>
          <div class="form-grid">
            ${row('emergency_name', '緊急聯絡人', d.emergency_name)}
            ${row('emergency_relationship', '與您的關係', d.emergency_relationship)}
            ${row('emergency_phone', '聯絡電話', d.emergency_phone, { type: 'tel' })}
            ${row('guardian_name', '法定代理人（未成年填寫）', d.guardian_name)}
            ${row('guardian_relationship', '法代關係', d.guardian_relationship)}
            ${row('guardian_phone', '法代電話', d.guardian_phone, { type: 'tel' })}
          </div></div>

        <div class="card"><h3>過往經驗</h3>
          <div style="font-size:12.5px;color:var(--muted);margin-bottom:8px">
            沒有經驗也沒關係，這只是幫助心理師了解您的起點。</div>
          <div class="form-grid">
            <div class="form-row full"><label>接受諮商經驗</label><select name="prior_counseling_kind">
              ${[['無', '無：過去沒有諮商經驗'], ['有', '有：過去曾經諮商過']]
    .map(o => `<option value="${o[0]}"${String(d.prior_counseling || '').startsWith(o[0]) ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></div>
            ${row('prior_counseling_detail', '若有：約多久前、持續多久',
    String(d.prior_counseling || '').replace(/^[無有]\s*/, ''), { placeholder: '例：兩年前，持續約半年' })}
            <div class="form-row full"><label>就醫經驗（精神科／身心科）</label><select name="prior_medical_kind">
              ${[['無', '無：從未就診'], ['曾經就診', '曾經就診過'], ['就醫中', '目前就醫中']]
    .map(o => `<option value="${o[0]}"${String(d.prior_medical || '').startsWith(o[0]) ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></div>
            ${row('prior_medical_detail', '若有：約多久前、持續多久、目前用藥',
    String(d.prior_medical || '').replace(/^(無|曾經就診|就醫中)\s*/, ''))}
          </div></div>

        <div class="card"><h3>希望的諮商方式</h3><div class="form-grid">
          <div class="form-row full"><label>諮商模式</label><select name="service_mode">
            ${['', '個別諮商', '家庭／伴侶諮商', '團體諮商']
    .map(o => `<option value="${o}"${o === d.service_mode ? ' selected' : ''}>${o || '尚未決定'}</option>`).join('')}</select></div>
          <div class="form-row full"><label>主訴議題（可複選）</label>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px">
              ${['自我成長', '親密關係與婚姻', '家庭議題', '人際關係', '生涯探索', '生活適應',
    '生理健康（疾患）', '心理疾患或傾向', '其他'].map(t => `<label style="font-size:13.5px;display:flex;gap:6px;align-items:center">
                <input type="checkbox" class="topic" value="${UI.esc(t)}"${String(d.topics || '').includes(t) ? ' checked' : ''}>${UI.esc(t)}</label>`).join('')}
            </div></div>
        </div></div>

        <div class="card"><h3>想談的事</h3><div class="form-grid">
          ${area('main_issue', '目前主要的困擾', d.main_issue, '例如：最近半年睡不好、工作壓力大、常感到焦慮…')}
          ${area('history', '過往就醫／諮商經驗與用藥（如有）', d.history, '曾看過的科別、診斷、目前服用的藥物')}
          ${area('expectation', '希望從諮商中得到什麼', d.expectation)}
          ${row('preferred_time', '方便前來的時段', d.preferred_time, { placeholder: '平日晚上、週六上午…' })}
          ${row('source', '如何得知本所', d.source)}
        </div></div>

        <div class="card"><h3>心情溫度計（選填）</h3>
          <div style="font-size:13px;color:var(--muted);line-height:1.8;margin-bottom:10px">
            ${UI.esc(s.name)}：${UI.esc(s.intro)}<br>
            此為篩檢工具，分數僅供心理師初步了解，不等同診斷。不想作答可整段略過。</div>
          <div id="scale">${s.items.map((q, i) => `<div style="margin-bottom:12px">
            <div style="font-size:14px;margin-bottom:5px">${i + 1}. ${UI.esc(q)}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">${s.options.map(o => `
              <label style="font-size:12.5px;display:flex;align-items:center;gap:3px">
                <input type="radio" name="q${i}" value="${o[0]}" style="width:auto">${UI.esc(o[1])}</label>`).join('')}</div>
          </div>`).join('')}</div>
        </div>

        <button class="btn" id="send" style="width:100%;margin-bottom:30px">送出問卷</button>
      </div>
    </div>`;

  document.getElementById('send').onclick = async () => {
    const btn = document.getElementById('send');
    const data = {};
    app.querySelectorAll('input[name], select[name], textarea[name]').forEach(i => {
      if (i.type !== 'radio') data[i.name] = i.value.trim();
    });
    if (!data.name) return UI.toast('請填寫姓名', true);
    // 兩段式欄位（有／無 + 說明）在送出時合併成一句，資料庫存的是完整敘述
    data.prior_counseling = [data.prior_counseling_kind, data.prior_counseling_detail].filter(Boolean).join(' ');
    data.prior_medical = [data.prior_medical_kind, data.prior_medical_detail].filter(Boolean).join(' ');
    delete data.prior_counseling_kind; delete data.prior_counseling_detail;
    delete data.prior_medical_kind; delete data.prior_medical_detail;
    data.topics = [...app.querySelectorAll('.topic:checked')].map(x => x.value).join('、');
    // 量表全部作答才送出，只填一半視同未填（避免產生無效分數）
    const answers = s.items.map((_, i) => {
      const el = app.querySelector(`input[name=q${i}]:checked`);
      return el ? Number(el.value) : null;
    });
    if (answers.some(v => v !== null)) {
      if (answers.some(v => v === null)) return UI.toast('心情溫度計請全部作答，或整段留白不填', true);
      data.bsrs_answers = answers;
    }
    btn.disabled = true;
    try {
      const r = await POST('/public/intake-form/' + encodeURIComponent(token), data);
      app.innerHTML = `<div class="fam-wrap"><div class="fam-head"><h1>已收到您的問卷</h1></div>
        <div class="fam-body"><div class="card">
          <div class="notice ok">感謝填寫，本所將與您聯繫安排初談時間。</div>
          ${r.alert ? `<div class="crisis" style="margin-top:12px">${UI.nl2br(r.crisis_note)}</div>` : ''}
          <div style="font-size:13px;color:var(--muted);margin-top:10px">
            如需修改內容或有緊急狀況，請直接來電 ${UI.esc(d.center_phone || '諮商所')}。</div>
        </div></div></div>`;
    } catch (e) {
      btn.disabled = false;
      UI.err(e);
    }
  };
}

boot();
