// AI 助理：用自然語言問後台資料。
// 畫面刻意做成對話框而不是報表——所方問的多半是「這個月收多少」「誰快流失」這種
// 一次性的問題，開一張報表反而慢。

App.page('ai', {
  title: 'AI 助理',
  sub: '用自然語言查後台資料；晤談內容不會送進 AI',
  module: 'ai',
  async render(el) {
    const st = await GET('/ai/status');
    const history = [];

    const SAMPLES = [
      '這個月收了多少？跟上個月比呢',
      '有哪些個案快流失了',
      '誰有逾期未繳的費用',
      '這週三的排程是什麼樣子',
      '這個月各心理師做了幾次晤談、紀錄補齊了嗎',
      '晤談紀錄的 A 欄位要寫什麼'
    ];

    el.innerHTML = `
      ${st.enabled ? '' : `<div class="notice warn" style="margin-bottom:12px">
        尚未設定 API 金鑰，助理無法使用。${App.can('settings') ? '請在下方「設定」卡片填入。' : '請聯繫管理者設定。'}</div>`}

      <div class="card">
        <div class="ai-chat" id="chat">
          <div class="ai-empty" id="empty">
            <div style="font-size:15px;margin-bottom:8px">想問什麼？</div>
            <div class="ai-samples">${SAMPLES.map(s => `<button class="ai-sample" data-q="${UI.esc(s)}">${UI.esc(s)}</button>`).join('')}</div>
          </div>
        </div>
        <div class="chat-bar">
          <textarea id="q" placeholder="例如：這個月實收多少、誰快流失了、林心理師下週的排程" ${st.enabled ? '' : 'disabled'}></textarea>
          <button class="btn" id="send" ${st.enabled ? '' : 'disabled'}>送出</button>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:8px">
          Enter 送出、Shift+Enter 換行。助理只能查詢，不能修改任何資料；每次提問都會記入稽核軌跡。
        </div>
      </div>

      <div class="card"><h3>它查得到什麼</h3>
        <div style="font-size:13.5px;line-height:1.9">
          ${st.tools.map(t => `<div style="margin-bottom:6px">
            <strong>${UI.esc(t.name)}</strong>　<span style="color:var(--muted)">${UI.esc(t.description)}</span></div>`).join('')}
        </div>
        <div class="notice warn" style="margin-top:12px">
          <strong>查不到的（刻意的）</strong>：晤談紀錄的 S／O／A／P 內容、風險描述、安全計畫內容、團體歷程紀錄。
          這些是《心理師法》保護的心理紀錄，不會送進 AI，也不會出現在它的回答裡；
          要看內容請到個案頁的「晤談紀錄」分頁（該處會留下調閱軌跡）。
          助理另外只會查詢<strong>您本人有權限的模組</strong>。
        </div>
      </div>

      <div class="card"><h3>後台欄位說明</h3>
        <div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">
          新進同仁常問的欄位定義，助理回答時也是引用這一份。</div>
        ${UI.table(['欄位', '說明'], Object.entries(st.field_guide).map(([k, v]) => `<tr>
          <td style="white-space:nowrap">${UI.esc(k)}</td><td class="wrap">${UI.esc(v)}</td></tr>`))}
      </div>

      ${App.can('settings') ? `<div class="card"><h3>設定</h3>
        <div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">
          使用 Anthropic 的 ${UI.esc(st.model)}。金鑰請至 console.anthropic.com 申請；
          ${st.key_from_env ? '目前使用環境變數 ANTHROPIC_API_KEY。' : st.key_masked ? '目前金鑰：' + UI.esc(st.key_masked) : '尚未設定。'}
          <br>提醒：使用這項功能等於把查詢到的<strong>行政層資料</strong>（個案姓名、代號、金額、排程）送到 Anthropic 處理，
          請確認已在個資告知事項中涵蓋委外處理。
        </div>
        <div class="form-grid">
          ${UI.input('api_key', 'API 金鑰（sk-ant- 開頭；留空不變更）', { full: true, type: 'password' })}
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn" id="savekey">儲存金鑰</button>
          ${st.key_masked ? '<button class="btn secondary danger" id="clearkey">清除金鑰</button>' : ''}
        </div>
      </div>` : ''}

      ${st.recent.length ? `<div class="card"><h3>最近的提問（稽核軌跡）</h3>
        ${UI.table(['時間', '提問者', '內容'], st.recent.map(r => `<tr>
          <td style="white-space:nowrap">${UI.esc(r.created_at.slice(5, 16))}</td>
          <td>${UI.esc(r.actor_name)}</td>
          <td class="wrap">${UI.esc(r.detail)}</td></tr>`))}</div>` : ''}`;

    const chat = el.querySelector('#chat');
    const box = el.querySelector('#q');

    const bubble = (who, html) => {
      const empty = el.querySelector('#empty');
      if (empty) empty.remove();
      const div = document.createElement('div');
      div.className = `chat-msg ${who === 'me' ? 'me' : 'them'}`;
      div.innerHTML = html;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
      return div;
    };

    // 回覆是純文字，做最小程度的排版：**粗體**、清單與換行
    const render = text => UI.esc(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^[-·•]\s?/gm, '・')
      .replace(/\n/g, '<br>');

    const send = async () => {
      const q = box.value.trim();
      if (!q) return;
      box.value = '';
      bubble('me', UI.esc(q));
      const thinking = bubble('them', '<span style="color:var(--muted)">查詢中…</span>');
      try {
        const out = await POST('/ai/ask', { question: q, history });
        thinking.innerHTML = render(out.answer)
          + (out.tools_used.length ? `<div class="chat-meta them" style="margin-top:6px">
              查了：${UI.esc([...new Set(out.tools_used)].join('、'))}</div>` : '');
        history.push({ role: 'user', content: q }, { role: 'assistant', content: out.answer });
      } catch (e) {
        thinking.innerHTML = `<span style="color:var(--danger)">${UI.esc(e.message)}</span>`;
      }
      chat.scrollTop = chat.scrollHeight;
    };

    el.querySelector('#send').onclick = send;
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    el.querySelectorAll('.ai-sample').forEach(b => {
      b.onclick = () => { box.value = b.dataset.q; send(); };
    });

    const save = el.querySelector('#savekey');
    if (save) save.onclick = async () => {
      const v = el.querySelector('[name=api_key]').value.trim();
      if (!v) return UI.toast('請輸入金鑰', true);
      try { await PUT('/ai/key', { api_key: v }); UI.toast('已儲存'); App.go('ai'); } catch (e) { UI.err(e); }
    };
    const clear = el.querySelector('#clearkey');
    if (clear) clear.onclick = async () => {
      if (!await UI.confirm('清除金鑰後 AI 助理將停用。確定嗎？')) return;
      await PUT('/ai/key', { clear: true });
      UI.toast('已清除');
      App.go('ai');
    };
  }
});
