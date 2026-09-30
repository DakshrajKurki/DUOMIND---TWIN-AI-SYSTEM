// DuoMind — secure Gemini proxy (Vercel serverless function)
// The Gemini API key lives ONLY here, as the environment variable GEMINI_API_KEY.
// Browsers call /api/gemini; they never receive the key.
//
// Open https://<your-site>/api/gemini in a browser to see a status check
// (whether the key is set, whether Google accepts it, and which model works).

const MODELS = (process.env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.5-flash-lite')
  .split(',').map(s => s.trim()).filter(Boolean);
// Tried in order if the requested model is not available to this key.
const FALLBACKS = (process.env.GEMINI_FALLBACKS || 'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-flash-latest,gemini-flash-lite-latest,gemini-2.0-flash')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const MAX_BODY = 60000;             // characters per request
const WINDOW_MS = 10 * 60 * 1000;   // rate-limit window: 10 minutes
const MAX_PER_WINDOW = Number(process.env.RATE_LIMIT || 40); // requests per visitor per window
const hits = new Map();             // best effort: per server instance
const working = new Map();          // requested model -> model that actually worked

function send(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
const fail = (res, status, message) => send(res, status, { error: { code: status, message } });
const hide = s => String(s || '').split(process.env.GEMINI_API_KEY || '\u0000').join('[hidden]');
const notAvailable = (status, msg) => status === 404 || (status === 400 && /not found|not supported|unknown model|is not available/i.test(msg));

function limited(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now(), rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > WINDOW_MS) { rec.n = 0; rec.t = now; }
  rec.n++; hits.set(ip, rec);
  return rec.n > MAX_PER_WINDOW;
}

function googleUrl(model, stream) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:` +
    (stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?') + 'key=' + encodeURIComponent(process.env.GEMINI_API_KEY);
}

// Calls Gemini, falling back to other models if the requested one isn't available.
async function callWithFallback(model, body, stream) {
  const order = [working.get(model) || model, model, ...FALLBACKS].filter((m, i, a) => a.indexOf(m) === i);
  let last = null;
  for (const m of order) {
    let r;
    try { r = await fetch(googleUrl(m, stream), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { return { network: true }; }
    if (r.ok) { working.set(model, m); return { r, used: m }; }
    const text = await r.text();
    let msg = text; try { msg = JSON.parse(text).error.message || text; } catch (e) {}
    last = { status: r.status, text, msg, model: m };
    if (!notAvailable(r.status, msg)) break;   // key/quota/other errors: stop trying
  }
  return { failed: last };
}

module.exports = async function handler(req, res) {
  // ---- Status check (open /api/gemini in a browser) ----
  if (req.method === 'GET') {
    if (limited(req)) return fail(res, 429, 'Too many requests. Please wait a few minutes.');
    if (!process.env.GEMINI_API_KEY) return send(res, 200, { ok: false, keySet: false, message: 'GEMINI_API_KEY is not set in Vercel. Add it under Settings → Environment Variables, then redeploy.' });
    const out = await callWithFallback(MODELS[MODELS.length - 1] || FALLBACKS[0], { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }] }, false);
    if (out.network) return send(res, 200, { ok: false, keySet: true, message: 'The server could not reach Google.' });
    if (out.failed) return send(res, 200, { ok: false, keySet: true, googleStatus: out.failed.status, message: 'Google rejected the request: ' + hide(out.failed.msg) });
    return send(res, 200, { ok: true, keySet: true, workingModel: out.used, message: 'Gemini is connected.' });
  }

  if (req.method !== 'POST') return fail(res, 405, 'Use POST.');
  if (!process.env.GEMINI_API_KEY) return fail(res, 500, 'GEMINI_API_KEY is not set on the server. Add it in Vercel → Settings → Environment Variables, then redeploy.');

  // Only accept calls from your own site (set ALLOWED_ORIGINS in Vercel to allow others).
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const sameSite = origin && host && origin.endsWith('//' + host);
  if (ALLOWED_ORIGINS.length ? !ALLOWED_ORIGINS.includes(origin) : !sameSite) return fail(res, 403, 'This site is not allowed to use the DuoMind AI server.');

  if (limited(req)) return fail(res, 429, 'Too many requests. Please wait a few minutes.');

  let input = req.body;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch (e) { return fail(res, 400, 'Invalid JSON.'); } }
  const { model, stream, body } = input || {};
  if (!MODELS.includes(model) && !FALLBACKS.includes(model)) return fail(res, 400, `Model not allowed: ${model}`);
  if (!body || typeof body !== 'object') return fail(res, 400, 'Missing request body.');
  if (JSON.stringify(body).length > MAX_BODY) return fail(res, 413, 'Request too large.');

  const out = await callWithFallback(model, body, !!stream);
  if (out.network) return fail(res, 502, 'Could not reach Gemini.');
  if (out.failed) {
    res.status(out.failed.status).setHeader('Content-Type', 'application/json');
    return res.end(hide(out.failed.text));
  }

  const upstream = out.r;
  res.status(200);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Gemini-Model', out.used);
  if (stream && upstream.body) {
    const reader = upstream.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
    return res.end();
  }
  res.end(hide(await upstream.text()));
};
