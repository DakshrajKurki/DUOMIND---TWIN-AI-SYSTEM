// DuoMind — secure Gemini proxy (Vercel serverless function)
// The Gemini API key lives ONLY here, as the environment variable GEMINI_API_KEY.
// Browsers call /api/gemini; they never receive the key.

const MODELS = (process.env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.5-flash-lite')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const MAX_BODY = 60000;             // characters per request
const WINDOW_MS = 10 * 60 * 1000;   // rate-limit window: 10 minutes
const MAX_PER_WINDOW = Number(process.env.RATE_LIMIT || 40); // requests per visitor per window
const hits = new Map();             // best effort: per server instance

function fail(res, status, message) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: { code: status, message } }));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Use POST.');
  if (!process.env.GEMINI_API_KEY) return fail(res, 500, 'GEMINI_API_KEY is not set on the server.');

  // Only accept calls from your own site (set ALLOWED_ORIGINS in Vercel).
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const sameSite = origin && host && origin.endsWith('//' + host);
  if (ALLOWED_ORIGINS.length ? !ALLOWED_ORIGINS.includes(origin) : !sameSite) return fail(res, 403, 'This site is not allowed to use the DuoMind AI server.');

  // Simple per-visitor rate limit.
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now(), rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > WINDOW_MS) { rec.n = 0; rec.t = now; }
  rec.n++; hits.set(ip, rec);
  if (rec.n > MAX_PER_WINDOW) return fail(res, 429, 'Too many requests. Please wait a few minutes.');

  let input = req.body;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch (e) { return fail(res, 400, 'Invalid JSON.'); } }
  const { model, stream, body } = input || {};
  if (!MODELS.includes(model)) return fail(res, 400, `Model not allowed: ${model}`);
  if (!body || typeof body !== 'object') return fail(res, 400, 'Missing request body.');
  if (JSON.stringify(body).length > MAX_BODY) return fail(res, 413, 'Request too large.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:` +
    (stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?') + 'key=' + encodeURIComponent(process.env.GEMINI_API_KEY);

  let upstream;
  try {
    upstream = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    return fail(res, 502, 'Could not reach Gemini.');
  }

  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (stream && upstream.ok && upstream.body) {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  }
  const text = await upstream.text();
  // Never echo anything that could contain the key.
  res.end(text.split(process.env.GEMINI_API_KEY).join('[hidden]'));
};
