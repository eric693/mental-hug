const express = require('express');
const { db, audit, getSetting, nowStamp, listQuery } = require('../db');
const { requireStaff } = require('../auth');
const line = require('../line');
const ai = require('../ai');

const router = express.Router();

// 個案訊息的多層次人工審核（LINE 溝通儀表板）
//
// 個案在 LINE 講的話常常夾著情緒，不是自動回覆處理得了的。流程刻意設計成五段，
// 每一段都有人負責，訊息不在群組裡飛來飛去：
//
//   個案訊息 → ① AI 初篩（分類／情緒／急迫度，只標記不回覆）
//            → ② 行政初審（決定要不要轉給心理師、是否直接結案）
//            → ③ 心理師在平台上擬回覆（也可在 LINE 群組裡回，系統一樣收得到）
//            → ④ 行政複審（可修訂文字，確認語氣與內容才放行）
//            → ⑤ 系統送到個案的對話框
//
// AI 只出現在第 ① 段，而且不生成要送給個案的內容——回覆一律出自心理師的手。

const STATUS = {
  new: '待行政初審',
  relayed: '待心理師擬稿',
  drafted: '待行政複審',
  returned: '複審退回，待心理師修改',
  sent: '已回覆個案',
  closed: '已結案（不需回覆）'
};

function row(id) {
  return db.prepare(`SELECT q.*, c.name AS client_name, c.code AS client_code, c.line_user_id,
      u.name AS counselor_name, u.line_group_id,
      d.name AS drafted_name, a.name AS approved_name
    FROM case_inquiries q
    LEFT JOIN clients c ON c.id = q.client_id
    LEFT JOIN users u ON u.id = q.counselor_id
    LEFT JOIN users d ON d.id = q.drafted_by
    LEFT JOIN users a ON a.id = q.approved_by
    WHERE q.id = ?`).get(id);
}

// 由 webhook 呼叫：收到個案訊息就建一筆，並跑 AI 初篩
async function createFromLine(client, text) {
  const info = db.prepare(`INSERT INTO case_inquiries (client_id, counselor_id, source, raw_text)
    VALUES (?,?, 'line', ?)`).run(client.id, client.counselor_id || null, String(text).slice(0, 2000));
  const id = info.lastInsertRowid;
  // AI 初篩失敗不影響流程，退回關鍵字規則
  const t = await ai.triageMessage(text);
  db.prepare(`UPDATE case_inquiries SET ai_category = ?, ai_sentiment = ?, ai_urgency = ?,
      ai_summary = ?, ai_flags = ?, ai_at = ? WHERE id = ?`)
    .run(t.category, t.sentiment, t.urgency, t.summary, t.flags || '', nowStamp(), id);
  audit('system', null, 'LINE', '收到個案訊息', String(id),
    { client_id: client.id, category: t.category, urgency: t.urgency, by: t.by });
  return row(id);
}

router.get('/inquiries', requireStaff('line'), (req, res) => {
  const where = [], args = [];
  const status = String(req.query.status || 'open');
  if (status === 'open') where.push("q.status IN ('new','relayed','drafted','returned')");
  else if (status !== 'all') { where.push('q.status = ?'); args.push(status); }
  if (req.query.urgency) { where.push('q.ai_urgency = ?'); args.push(String(req.query.urgency)); }
  if (req.query.category) { where.push('q.ai_category = ?'); args.push(String(req.query.category)); }
  if (req.query.counselor_id) { where.push('q.counselor_id = ?'); args.push(Number(req.query.counselor_id)); }
  // 心理師視角：只看自己的個案（管理者與行政看全部）
  if (req.query.mine === '1') { where.push('q.counselor_id = ?'); args.push(req.user.id); }

  const page = listQuery({
    select: `q.*, c.name AS client_name, c.code AS client_code, u.name AS counselor_name,
      d.name AS drafted_name, a.name AS approved_name`,
    from: `case_inquiries q
      LEFT JOIN clients c ON c.id = q.client_id
      LEFT JOIN users u ON u.id = q.counselor_id
      LEFT JOIN users d ON d.id = q.drafted_by
      LEFT JOIN users a ON a.id = q.approved_by`,
    where, args,
    search: String(req.query.q || ''),
    searchFields: ['c.name', 'c.code', 'q.raw_text', 'q.draft', 'q.final_reply', 'q.ai_summary'],
    // 急件排前面，其次照時間
    order: "CASE q.ai_urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, q.id DESC",
    page: req.query.page, size: Number(req.query.size) || 50, maxSize: 200
  });

  const counts = {};
  for (const k of Object.keys(STATUS)) {
    counts[k] = db.prepare('SELECT COUNT(*) n FROM case_inquiries WHERE status = ?').get(k).n;
  }
  res.json({
    ...page, counts, labels: STATUS,
    ai_enabled: ai.enabled(),
    high: db.prepare("SELECT COUNT(*) n FROM case_inquiries WHERE ai_urgency = 'high' AND status IN ('new','relayed','drafted','returned')").get().n
  });
});

// 櫃檯代錄（個案打電話或臨櫃講的，也走同一條審核流程）
router.post('/inquiries', requireStaff('line'), async (req, res) => {
  const b = req.body || {};
  const client = db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(Number(b.client_id) || 0);
  if (!client) return res.status(400).json({ error: '請選擇個案' });
  if (!String(b.raw_text || '').trim()) return res.status(400).json({ error: '請填寫個案訊息內容' });
  const r = await createFromLine(client, String(b.raw_text).trim());
  db.prepare("UPDATE case_inquiries SET source = 'staff' WHERE id = ?").run(r.id);
  audit('staff', req.user.id, req.user.name, '代錄個案訊息', String(r.id));
  res.json({ id: r.id });
});

// 重新跑一次 AI 初篩（改了金鑰或想重判時）
router.post('/inquiries/:id/retriage', requireStaff('line'), async (req, res) => {
  const r = row(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此訊息' });
  const t = await ai.triageMessage(r.raw_text);
  db.prepare(`UPDATE case_inquiries SET ai_category = ?, ai_sentiment = ?, ai_urgency = ?,
      ai_summary = ?, ai_flags = ?, ai_at = ? WHERE id = ?`)
    .run(t.category, t.sentiment, t.urgency, t.summary, t.flags || '', nowStamp(), r.id);
  res.json({ ok: true, triage: t });
});

// ② 行政初審：轉給心理師
router.post('/inquiries/:id/relay', requireStaff('line'), async (req, res) => {
  const r = row(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此訊息' });
  if (!['new', 'closed'].includes(r.status)) return res.status(400).json({ error: '此訊息已在後續流程中' });
  const b = req.body || {};
  const counselorId = Number(b.counselor_id) || r.counselor_id;
  if (!counselorId) return res.status(400).json({ error: '請指定要轉給哪位心理師' });
  db.prepare(`UPDATE case_inquiries SET status = 'relayed', counselor_id = ?, relayed_by = ?,
      relayed_at = ?, admin_note = ? WHERE id = ?`)
    .run(counselorId, req.user.id, nowStamp(), String(b.admin_note || ''), r.id);
  audit('staff', req.user.id, req.user.name, '初審通過並轉心理師', String(r.id), { counselor_id: counselorId });

  // 群組通知只提示「有一則待處理」，內容請心理師到平台看：
  // 個案原話含情緒與個資，不適合整段丟進群組留存
  const fresh = row(r.id);
  const out = await line.send({
    to: line.groupIdFor(counselorId),
    text: `有一則個案訊息待您回覆（#${fresh.id}，${fresh.client_name || ''}）。請至系統的「溝通儀表板」查看並擬定回覆。`,
    flex: line.bubble({
      title: `待回覆訊息 #${fresh.id}`,
      tone: fresh.ai_urgency === 'high' ? 'danger' : 'warn',
      fields: [
        line.fieldRow('個案', `${fresh.client_name || ''}${fresh.client_code ? '（' + fresh.client_code + '）' : ''}`),
        line.fieldRow('分類', fresh.ai_category || '未分類'),
        line.fieldRow('急迫度', fresh.ai_urgency === 'high' ? '高' : fresh.ai_urgency === 'low' ? '低' : '一般'),
        line.fieldRow('摘要', fresh.ai_summary || '')
      ],
      body: '完整內容與回覆擬稿請至系統的「溝通儀表板」處理；擬好之後會由行政人員複審再送出。',
      footer: b.admin_note ? `行政備註：${b.admin_note}` : ''
    }),
    meta: { source_type: 'group', client_id: fresh.client_id, counselor_id: counselorId }
  });
  res.json({ ok: true, group: out });
});

// ② 行政初審：不需回覆，直接結案
router.post('/inquiries/:id/close', requireStaff('line'), (req, res) => {
  const r = row(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此訊息' });
  db.prepare("UPDATE case_inquiries SET status = 'closed', admin_note = ?, approved_by = ?, approved_at = ? WHERE id = ?")
    .run(String((req.body || {}).admin_note || ''), req.user.id, nowStamp(), r.id);
  audit('staff', req.user.id, req.user.name, '訊息結案（不需回覆）', String(r.id));
  res.json({ ok: true });
});

// ③ 心理師擬稿（在平台上寫，或由行政代錄心理師口述）
router.post('/inquiries/:id/draft', requireStaff('line'), (req, res) => {
  const r = row(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此訊息' });
  if (!['relayed', 'returned', 'drafted'].includes(r.status)) {
    return res.status(400).json({ error: '此訊息尚未經行政初審轉入，或已完成回覆' });
  }
  const draft = String((req.body || {}).draft || '').trim();
  if (!draft) return res.status(400).json({ error: '請填寫回覆內容' });
  db.prepare(`UPDATE case_inquiries SET draft = ?, drafted_by = ?, drafted_at = ?, status = 'drafted' WHERE id = ?`)
    .run(draft.slice(0, 2000), req.user.id, nowStamp(), r.id);
  audit('staff', req.user.id, req.user.name, '提交回覆擬稿', String(r.id));
  res.json({ ok: true });
});

// ④ 行政複審：退回心理師
router.post('/inquiries/:id/return', requireStaff('line'), (req, res) => {
  const r = row(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此訊息' });
  if (r.status !== 'drafted') return res.status(400).json({ error: '只有待複審的擬稿可以退回' });
  const note = String((req.body || {}).review_note || '').trim();
  if (!note) return res.status(400).json({ error: '請說明退回原因，心理師才知道要改什麼' });
  db.prepare("UPDATE case_inquiries SET status = 'returned', review_note = ? WHERE id = ?").run(note, r.id);
  audit('staff', req.user.id, req.user.name, '複審退回擬稿', String(r.id), { note });
  res.json({ ok: true });
});

// ④⑤ 行政複審通過 → 送出給個案
router.post('/inquiries/:id/approve', requireStaff('line'), async (req, res) => {
  const r = row(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此訊息' });
  if (r.status !== 'drafted') return res.status(400).json({ error: '只有待複審的擬稿可以放行' });
  // 行政可微調文字（語氣、錯字），送出的是最終版；心理師的原擬稿保留供對照
  const finalReply = String((req.body || {}).final_reply || r.draft).trim();
  if (!finalReply) return res.status(400).json({ error: '回覆內容不可為空' });

  const out = await line.send({
    to: r.line_user_id,
    text: finalReply,
    flex: line.bubble({
      title: `${getSetting('center_name')} 回覆`,
      tone: 'info',
      body: finalReply,
      footer: getSetting('center_phone') ? `如需進一步討論，請來電 ${getSetting('center_phone')}` : ''
    }),
    meta: { source_type: 'user', client_id: r.client_id, counselor_id: r.counselor_id }
  });
  db.prepare(`UPDATE case_inquiries SET status = 'sent', final_reply = ?, approved_by = ?,
      approved_at = ?, sent_at = ? WHERE id = ?`)
    .run(finalReply.slice(0, 2000), req.user.id, nowStamp(), nowStamp(), r.id);
  // 回覆內容同時存進個案訊息串，櫃檯在別的地方也看得到往來
  db.prepare("INSERT INTO messages (client_id, sender, user_id, content) VALUES (?, 'staff', ?, ?)")
    .run(r.client_id, req.user.id, finalReply);
  audit('staff', req.user.id, req.user.name, '複審通過並回覆個案', String(r.id),
    { edited: finalReply !== r.draft });
  res.json({ ok: true, client: out, edited: finalReply !== r.draft });
});

router.delete('/inquiries/:id', requireStaff('line'), (req, res) => {
  const r = row(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到此訊息' });
  if (r.status === 'sent') return res.status(400).json({ error: '已回覆的訊息不可刪除，保留往來紀錄' });
  db.prepare('DELETE FROM case_inquiries WHERE id = ?').run(r.id);
  audit('staff', req.user.id, req.user.name, '刪除個案訊息', String(r.id));
  res.json({ ok: true });
});

module.exports = router;
module.exports.createFromLine = createFromLine;
module.exports.STATUS = STATUS;
