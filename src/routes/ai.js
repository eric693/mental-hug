const express = require('express');
const { db, audit, getSetting, setSetting, nowStamp } = require('../db');
const { requireStaff } = require('../auth');
const ai = require('../ai');

const router = express.Router();

// AI 助理的系統端 API。
// 每一次提問都留稽核軌跡（誰問了什麼、用到哪些工具），
// 因為問句本身可能帶個案姓名，屬於要能被追查的存取行為。

router.get('/ai/status', requireStaff('ai'), (req, res) => {
  const key = getSetting('ai_api_key', '').trim();
  res.json({
    enabled: ai.enabled(),
    model: ai.MODEL,
    key_from_env: !key && !!(process.env.ANTHROPIC_API_KEY || '').trim(),
    key_masked: key ? `${key.slice(0, 7)}••••${key.slice(-4)}` : '',
    tools: Object.values(ai.TOOLS)
      .filter(t => !t.module || req.user.role === 'admin' || req.userModules.includes(t.module))
      .map(t => ({ name: t.def.name, description: t.def.description })),
    field_guide: ai.FIELD_GUIDE,
    recent: db.prepare(`SELECT created_at, actor_name, detail FROM audit_logs
      WHERE action = 'AI 助理提問' ORDER BY id DESC LIMIT 20`).all()
  });
});

router.put('/ai/key', requireStaff('settings'), (req, res) => {
  const b = req.body || {};
  if (b.clear) {
    setSetting('ai_api_key', '');
    audit('staff', req.user.id, req.user.name, '清除 AI 金鑰');
    return res.json({ ok: true });
  }
  const key = String(b.api_key || '').trim();
  if (!key) return res.status(400).json({ error: '請填入 API 金鑰' });
  if (!/^sk-ant-/.test(key)) return res.status(400).json({ error: '金鑰格式看起來不對（應以 sk-ant- 開頭）' });
  setSetting('ai_api_key', key);
  audit('staff', req.user.id, req.user.name, '設定 AI 金鑰');
  res.json({ ok: true });
});

router.post('/ai/ask', requireStaff('ai'), async (req, res) => {
  const question = String((req.body || {}).question || '').trim();
  if (!question) return res.status(400).json({ error: '請輸入問題' });
  if (!ai.enabled()) return res.status(400).json({ error: '尚未設定 AI 助理的 API 金鑰，請至「AI 助理」頁設定' });
  const history = Array.isArray((req.body || {}).history) ? req.body.history : [];
  try {
    const out = await ai.ask({
      question,
      history,
      user: { id: req.user.id, name: req.user.name, role: req.user.role, modules: req.userModules }
    });
    audit('staff', req.user.id, req.user.name, 'AI 助理提問', '',
      { q: question.slice(0, 200), tools: out.tools_used.join(',') });
    res.json({ ...out, asked_at: nowStamp() });
  } catch (e) {
    const msg = String(e.message || e);
    audit('staff', req.user.id, req.user.name, 'AI 助理提問失敗', '', msg.slice(0, 200));
    res.status(502).json({ error: `AI 回覆失敗：${msg.slice(0, 200)}` });
  }
});

module.exports = router;
