// API 呼叫共用：自動處理 JSON、錯誤訊息、401 導回登入
async function api(path, options = {}) {
  const opts = { headers: {}, credentials: 'same-origin', ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch('/api' + path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && window.App && App.onUnauthorized) App.onUnauthorized();
    throw new Error((data && data.error) || '操作失敗，請稍後再試');
  }
  return data;
}
const GET = p => api(p);
// 需要分頁資訊時用這支：回傳 { rows, total, page, size, pages }。
// 伺服器把總數放在 X-Total-Count 等標頭，回應本體維持原本的陣列，
// 因此既有呼叫端（下拉選單之類）不受影響。
async function GETP(path) {
  const res = await fetch('/api' + path, { credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && window.App && App.onUnauthorized) App.onUnauthorized();
    throw new Error((data && data.error) || '操作失敗，請稍後再試');
  }
  const n = k => Number(res.headers.get(k) || 0);
  return {
    rows: Array.isArray(data) ? data : (data.rows || []),
    total: n('X-Total-Count') || (Array.isArray(data) ? data.length : (data.total_count || 0)),
    page: n('X-Page') || 1,
    size: n('X-Page-Size') || (Array.isArray(data) ? data.length : 50),
    pages: n('X-Page-Count') || 1,
    raw: data
  };
}
const POST = (p, body) => api(p, { method: 'POST', body });
const PUT = (p, body) => api(p, { method: 'PUT', body });
const DEL = p => api(p, { method: 'DELETE' });
