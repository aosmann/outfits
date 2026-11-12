// Outfits try-on service: a tiny Cloudflare Worker that keeps the Gemini API key
// server-side. The app sends the person photo + clothing photos; the worker builds
// the prompt itself (so the endpoint can't be used as a general image generator)
// and returns one generated image.
//
// Env:
//   GEMINI_API_KEY  (secret, required)
//   ACCESS_CODE     (secret, optional) — if set, requests must send X-Access-Code
//   ALLOWED_ORIGINS (var)  comma-separated, e.g. "https://aosmann.github.io"; "*" allows any
//   MODEL           (var, optional) default gemini-2.5-flash-image
//   LIMITER         (optional rate-limit binding, see wrangler.toml)

const CATS = {
  top:    { one: 'top',       prompt: 'the top (shirt, t-shirt, blouse or sweater)' },
  bottom: { one: 'bottom',    prompt: 'the bottoms (trousers, jeans, skirt or shorts)' },
  dress:  { one: 'dress',     prompt: 'the one-piece (dress or jumpsuit); it replaces both the top and the bottoms' },
  outer:  { one: 'outerwear', prompt: 'the outer layer (jacket or coat), worn over the rest of the outfit' },
  shoes:  { one: 'shoes',     prompt: 'the shoes' },
  bag:    { one: 'bag',       prompt: 'the bag, carried or worn naturally' },
  acc:    { one: 'accessory', prompt: 'an accessory (hat, jewelry, belt, scarf or sunglasses), worn naturally' },
};
const MAX_PIECES = 9;
const MAX_IMAGE_B64 = 2_000_000; // ~1.5 MB per image after base64
const B64 = /^[A-Za-z0-9+/=]+$/;

function buildPrompt(cats) {
  const lines = cats.map((c, i) => `- Image ${i + 2}: ${CATS[c].prompt}`).join('\n');
  return `Create a realistic full-body photograph of the SAME person shown in image 1, now wearing the clothing items shown in the other images.
Items:
${lines}
Rules:
- Keep the person's identity identical: same face, facial features, hair, skin tone, body shape and proportions. Do not beautify or change them.
- Reproduce each item's exact color, pattern, print, logos and details, with a natural, realistic fit.
- Replace the matching parts of their current outfit with these items. Keep any part of their current outfit that is not replaced. Do not add garments or accessories that are not listed.
- Full body visible from head to feet, standing in a relaxed natural pose, facing the camera.
- Plain light-grey studio background, soft even lighting, sharp photographic quality, portrait 3:4.`;
}

function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    ok,
    headers: {
      'Access-Control-Allow-Origin': ok ? (allowed.includes('*') ? '*' : origin) : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

async function callGemini(env, parts, withConfig) {
  const model = env.MODEL || 'gemini-2.5-flash-image';
  const generationConfig = withConfig
    ? { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4' } }
    : { responseModalities: ['TEXT', 'IMAGE'] };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
  });
  return { r, j: await r.json().catch(() => ({})) };
}

export default {
  async fetch(req, env) {
    const { ok, headers } = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers });
    const path = new URL(req.url).pathname;
    if (req.method !== 'POST' || path !== '/tryon') return json({ error: 'Not found' }, 404, headers);
    if (!ok) return json({ error: 'Origin not allowed' }, 403, headers);
    if (!env.GEMINI_API_KEY) return json({ error: 'Service is not configured' }, 500, headers);
    if (env.ACCESS_CODE && req.headers.get('X-Access-Code') !== env.ACCESS_CODE) return json({ error: 'Invalid access code' }, 401, headers);

    if (env.LIMITER) {
      const ip = req.headers.get('CF-Connecting-IP') || 'anon';
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Too many try-ons right now. Try again in a minute.' }, 429, headers);
    }

    if (Number(req.headers.get('Content-Length') || 0) > 16_000_000) return json({ error: 'Request too large' }, 413, headers);
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400, headers); }
    const { person, pieces } = body || {};
    const validImg = s => typeof s === 'string' && s.length > 100 && s.length <= MAX_IMAGE_B64 && B64.test(s);
    if (!validImg(person) || !Array.isArray(pieces) || !pieces.length || pieces.length > MAX_PIECES ||
        !pieces.every(p => p && CATS[p.cat] && validImg(p.image))) {
      return json({ error: 'Bad request' }, 400, headers);
    }

    const parts = [
      { text: buildPrompt(pieces.map(p => p.cat)) },
      { text: 'Image 1 — the person:' }, { inline_data: { mime_type: 'image/jpeg', data: person } },
    ];
    pieces.forEach((p, i) => parts.push(
      { text: `Image ${i + 2} — ${CATS[p.cat].one}:` }, { inline_data: { mime_type: 'image/jpeg', data: p.image } }));

    let { r, j } = await callGemini(env, parts, true);
    if (r.status === 400) ({ r, j } = await callGemini(env, parts, false));
    if (!r.ok) {
      const status = r.status === 429 ? 429 : 502;
      return json({ error: r.status === 429 ? 'The image service is busy. Try again in a minute.' : 'Image generation failed. Try again.' }, status, headers);
    }
    const cand = j.candidates?.[0];
    const p = cand?.content?.parts?.find(p => p.inlineData || p.inline_data);
    if (!p) {
      const why = j.promptFeedback?.blockReason || cand?.finishReason;
      return json({ error: 'No image came back' + (why ? ` (${why})` : '') + '. Try a different photo or outfit.' }, 502, headers);
    }
    const d = p.inlineData || p.inline_data;
    return json({ image: d.data, mime: d.mimeType || d.mime_type || 'image/png' }, 200, headers);
  },
};
