// Outfits service: one Cloudflare Worker that
//   1. generates try-on photos with Gemini (POST /tryon), keeping the API key server-side,
//   2. syncs the wardrobe between devices (/sync/*), stored in R2 under a private sync code,
//   3. exposes the wardrobe to Claude as a remote MCP connector (POST /mcp/<connector token>).
//
// Env:
//   GEMINI_API_KEY  (secret, required for try-on)
//   ACCESS_CODE     (secret, optional) required to call /tryon and to create a new sync space
//   ALLOWED_ORIGINS (var)  comma-separated app origins, e.g. "https://aosmann.github.io"; "*" allows any
//   MODEL           (var, optional) default gemini-2.5-flash-image
//   BUCKET          (R2 binding, required for sync and the Claude connector)
//   LIMITER         (optional rate-limit binding, see wrangler.toml)
//
// R2 layout (per sync space, id = sha256(sync code)):
//   s/<space>/state.json      items, looks, me, spend (no images)
//   s/<space>/b/<sha256>      image bytes, content-addressed
//   t/<sha256(token)>         connector token -> space id

/* ------------------------------------------------------------------ */
/* shared                                                              */
/* ------------------------------------------------------------------ */

const CATS = {
  top:    { one: 'top',       prompt: 'the top (shirt, t-shirt, blouse or sweater)' },
  bottom: { one: 'bottom',    prompt: 'the bottoms (trousers, jeans, skirt or shorts)' },
  dress:  { one: 'dress',     prompt: 'the one-piece (dress or jumpsuit); it replaces both the top and the bottoms' },
  outer:  { one: 'outerwear', prompt: 'the outer layer (jacket or coat), worn over the rest of the outfit' },
  shoes:  { one: 'shoes',     prompt: 'the shoes' },
  bag:    { one: 'bag',       prompt: 'the bag, carried or worn naturally' },
  acc:    { one: 'accessory', prompt: 'an accessory (hat, jewelry, belt, scarf or sunglasses), worn naturally' },
};
const NAME = { top: 'top', bottom: 'bottoms', dress: 'dress', outer: 'jacket or coat', shoes: 'shoes', bag: 'bag', acc: 'accessory' };
const MAX_PIECES = 9;
const MAX_IMAGE_B64 = 2_000_000;    // ~1.5 MB per image after base64 (/tryon)
const MAX_BLOB = 10_000_000;        // 10 MB per synced image
const PRICE = { 'gemini-2.5-flash-image': { in: 0.30, out: 30 } }; // USD per 1M tokens
const B64 = /^[A-Za-z0-9+/=]+$/;
const HEX64 = /^[0-9a-f]{64}$/;

const enc = new TextEncoder();
async function sha256hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomToken(bytes = 20) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function toB64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    ok,
    headers: {
      'Access-Control-Allow-Origin': ok ? (allowed.includes('*') ? '*' : origin) : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code, Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  };
}
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

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

function editPrompt(pieces, remove) {
  const lines = [
    ...pieces.map((p, i) => {
      const n = i + 3, what = NAME[p.cat], rep = p.replaces || [];
      return rep.length
        ? `- Replace their ${rep.map(c => NAME[c]).join(' and ')} with the ${what} shown in image ${n}.`
        : `- Add the ${what} shown in image ${n}${p.cat === 'outer' ? ', worn over the rest of the outfit' : ''}.`;
    }),
    ...remove.map(c => `- Remove their ${NAME[c]}.`),
  ].join('\n');
  return `Edit image 1, a photo of a person wearing an outfit. Make only these changes:
${lines}
Rules:
- Keep everything else in image 1 exactly as it is: the same person, face, hair, skin tone, body shape, pose, framing, background, lighting and every other piece of clothing.
- Image 2 is a reference photo of the same person. Use it only to keep their face and identity accurate.
- Reproduce each new item's exact color, pattern, print, logos and details, with a natural, realistic fit.
- Return the full edited photo, full body from head to feet, portrait 3:4.`;
}

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

// Returns {data, mime, usage, model} or throws {status, message}.
async function generate(env, parts) {
  let { r, j } = await callGemini(env, parts, true);
  if (r.status === 400) ({ r, j } = await callGemini(env, parts, false));
  if (!r.ok) {
    throw { status: r.status === 429 ? 429 : 502,
      message: r.status === 429 ? 'The image service is busy. Try again in a minute.' : 'Image generation failed. Try again.' };
  }
  const cand = j.candidates?.[0];
  const p = cand?.content?.parts?.find(p => p.inlineData || p.inline_data);
  if (!p) {
    const why = j.promptFeedback?.blockReason || cand?.finishReason;
    throw { status: 502, message: 'No image came back' + (why ? ` (${why})` : '') + '. Try a different photo or outfit.' };
  }
  const d = p.inlineData || p.inline_data, u = j.usageMetadata || {};
  const model = env.MODEL || 'gemini-2.5-flash-image';
  return { data: d.data, mime: d.mimeType || d.mime_type || 'image/png', model,
    usage: { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0 } };
}
function costOf(model, usage) {
  const p = PRICE[model];
  return p ? (usage.in * p.in + usage.out * p.out) / 1e6 : 0.039;
}

async function rateLimited(env, key) {
  if (!env.LIMITER) return false;
  const { success } = await env.LIMITER.limit({ key });
  return !success;
}

/* ------------------------------------------------------------------ */
/* /tryon                                                              */
/* ------------------------------------------------------------------ */

async function handleTryon(req, env, headers) {
  if (!env.GEMINI_API_KEY) return json({ error: 'Service is not configured' }, 500, headers);
  if (env.ACCESS_CODE && req.headers.get('X-Access-Code') !== env.ACCESS_CODE) return json({ error: 'Invalid access code' }, 401, headers);
  if (await rateLimited(env, req.headers.get('CF-Connecting-IP') || 'anon'))
    return json({ error: 'Too many try-ons right now. Try again in a minute.' }, 429, headers);
  if (Number(req.headers.get('Content-Length') || 0) > 16_000_000) return json({ error: 'Request too large' }, 413, headers);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400, headers); }
  const { person, pieces, base } = body || {};
  const remove = Array.isArray(body?.remove) ? body.remove : [];
  const validImg = s => typeof s === 'string' && s.length > 100 && s.length <= MAX_IMAGE_B64 && B64.test(s);
  const catList = (a, max) => Array.isArray(a) && a.length <= max && a.every(c => CATS[c]);
  const isEdit = base !== undefined;
  if (!validImg(person) || !Array.isArray(pieces) || pieces.length > MAX_PIECES ||
      !pieces.every(p => p && CATS[p.cat] && validImg(p.image) && (p.replaces === undefined || catList(p.replaces, 2))) ||
      !catList(remove, 3) ||
      (isEdit ? (!validImg(base) || pieces.length > 3 || !(pieces.length + remove.length)) : (!pieces.length || remove.length))) {
    return json({ error: 'Bad request' }, 400, headers);
  }

  const img = (label, data) => [{ text: label }, { inline_data: { mime_type: 'image/jpeg', data } }];
  const parts = isEdit
    ? [{ text: editPrompt(pieces, remove) }, ...img('Image 1 — current photo:', base), ...img('Image 2 — the person (reference):', person),
       ...pieces.flatMap((p, i) => img(`Image ${i + 3} — new ${NAME[p.cat]}:`, p.image))]
    : [{ text: buildPrompt(pieces.map(p => p.cat)) }, ...img('Image 1 — the person:', person),
       ...pieces.flatMap((p, i) => img(`Image ${i + 2} — ${CATS[p.cat].one}:`, p.image))];
  try {
    const g = await generate(env, parts);
    return json({ image: g.data, mime: g.mime, model: g.model, usage: g.usage }, 200, headers);
  } catch (e) {
    return json({ error: e.message || 'Image generation failed. Try again.' }, e.status || 502, headers);
  }
}

/* ------------------------------------------------------------------ */
/* sync storage                                                        */
/* ------------------------------------------------------------------ */

const stateKey = sp => `s/${sp}/state.json`;
const blobKey = (sp, h) => `s/${sp}/b/${h}`;
const emptyState = () => ({ v: 1, items: {}, looks: {}, me: null, spend: [], created: Date.now() });

async function spaceFromAuth(req, env) {
  const m = /^Bearer\s+(\S{20,200})$/.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  const sp = await sha256hex('space:' + m[1]);
  return (await env.BUCKET.head(stateKey(sp))) ? sp : null;
}
async function readState(env, sp) {
  const o = await env.BUCKET.get(stateKey(sp));
  return o ? { state: await o.json(), etag: o.etag } : { state: emptyState(), etag: null };
}
// Read-modify-write with an etag check so two devices syncing at once don't overwrite each other.
async function updateState(env, sp, fn) {
  for (let i = 0; i < 6; i++) {
    const { state, etag } = await readState(env, sp);
    const next = (await fn(state)) || state;
    const res = await env.BUCKET.put(stateKey(sp), JSON.stringify(next), {
      httpMetadata: { contentType: 'application/json' },
      ...(etag ? { onlyIf: { etagMatches: etag } } : {}),
    });
    if (res) return next;
    await new Promise(r => setTimeout(r, 50 + Math.random() * 150));
  }
  throw { status: 409, message: 'Busy, try again' };
}

const tsOf = r => (r && r.updated) || 0;
function mergeVersions(a = [], b = [], vdel = []) {
  const gone = new Set(vdel), seen = new Map();
  for (const v of [...a, ...b]) if (v && v.created && v.h && !gone.has(v.created) && !seen.has(v.created)) seen.set(v.created, v);
  return [...seen.values()].sort((x, y) => x.created - y.created);
}
function mergeLook(cur, inc) {
  if (!cur) return inc;
  if (inc.deleted || cur.deleted) return tsOf(inc) > tsOf(cur) ? inc : cur;
  const newer = tsOf(inc) > tsOf(cur) ? inc : cur;
  const vdel = [...new Set([...(cur.vdel || []), ...(inc.vdel || [])])].slice(-500);
  const versions = mergeVersions(cur.versions, inc.versions, vdel);
  const grew = versions.length !== (newer.versions || []).filter(v => !vdel.includes(v.created)).length;
  return { ...newer, versions, vdel, updated: Math.max(tsOf(cur), tsOf(inc)) + (grew ? 1 : 0) };
}
function mergeState(state, ch) {
  const removed = new Set();
  for (const [id, r] of Object.entries(ch.items || {})) {
    if (!r || typeof r !== 'object' || r.id !== id) continue;
    if (tsOf(r) > tsOf(state.items[id])) { state.items[id] = r; if (r.deleted) removed.add(id); }
  }
  for (const [k, r] of Object.entries(ch.looks || {})) {
    if (!r || typeof r !== 'object' || r.key !== k) continue;
    state.looks[k] = mergeLook(state.looks[k], r);
  }
  // Like the app: deleting an item also removes the looks that use it.
  if (removed.size) for (const [k, l] of Object.entries(state.looks)) {
    if (l && !l.deleted && (l.items || []).some(id => removed.has(id))) state.looks[k] = { key: k, deleted: true, updated: Math.max(Date.now(), tsOf(l) + 1) };
  }
  if (ch.me && tsOf(ch.me) > tsOf(state.me)) state.me = ch.me;
  if (Array.isArray(ch.spend) && ch.spend.length) {
    const seen = new Set((state.spend || []).map(x => x.t));
    state.spend = [...(state.spend || []), ...ch.spend.filter(x => x && x.t && !seen.has(x.t))].sort((a, b) => a.t - b.t).slice(-5000);
  }
  return state;
}

async function handleSync(req, env, headers, path) {
  if (!env.BUCKET) return json({ error: 'Sync is not set up on this service (no R2 bucket).' }, 501, headers);

  if (path === '/sync/new' && req.method === 'POST') {
    if (env.ACCESS_CODE && req.headers.get('X-Access-Code') !== env.ACCESS_CODE) return json({ error: 'Invalid access code' }, 401, headers);
    const code = randomToken(24), sp = await sha256hex('space:' + code);
    await env.BUCKET.put(stateKey(sp), JSON.stringify(emptyState()), { httpMetadata: { contentType: 'application/json' } });
    return json({ code }, 200, headers);
  }

  const sp = await spaceFromAuth(req, env);
  if (!sp) return json({ error: 'Unknown sync code' }, 401, headers);

  if (path === '/sync/state' && req.method === 'GET') {
    const { state } = await readState(env, sp);
    return json(state, 200, headers);
  }
  if (path === '/sync/missing' && req.method === 'POST') {
    const { hashes } = await req.json().catch(() => ({}));
    if (!Array.isArray(hashes) || hashes.length > 2000 || !hashes.every(h => HEX64.test(h))) return json({ error: 'Bad request' }, 400, headers);
    const missing = [];
    await Promise.all(hashes.map(async h => { if (!(await env.BUCKET.head(blobKey(sp, h)))) missing.push(h); }));
    return json({ missing }, 200, headers);
  }
  const bm = /^\/sync\/blob\/([0-9a-f]{64})$/.exec(path);
  if (bm && req.method === 'PUT') {
    const type = (req.headers.get('Content-Type') || '').split(';')[0].trim();
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: 'Images only' }, 415, headers);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BLOB) return json({ error: 'Image too large' }, 413, headers);
    if (await sha256hex(buf) !== bm[1]) return json({ error: 'Hash mismatch' }, 400, headers);
    await env.BUCKET.put(blobKey(sp, bm[1]), buf, { httpMetadata: { contentType: type } });
    return json({ ok: true }, 200, headers);
  }
  if (bm && req.method === 'GET') {
    const o = await env.BUCKET.get(blobKey(sp, bm[1]));
    if (!o) return json({ error: 'Not found' }, 404, headers);
    return new Response(o.body, { headers: { ...headers, 'Content-Type': o.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' } });
  }
  if (path === '/sync/push' && req.method === 'POST') {
    if (Number(req.headers.get('Content-Length') || 0) > 5_000_000) return json({ error: 'Too large' }, 413, headers);
    const ch = await req.json().catch(() => null);
    if (!ch || typeof ch !== 'object') return json({ error: 'Bad request' }, 400, headers);
    return json(await updateState(env, sp, s => mergeState(s, ch)), 200, headers);
  }
  if (path === '/sync/connector' && (req.method === 'POST' || req.method === 'DELETE')) {
    // One connector link per space. Creating a new one revokes the old one.
    let url = null;
    await updateState(env, sp, async s => {
      if (s.connector) await env.BUCKET.delete(`t/${s.connector}`);
      s.connector = null;
      if (req.method === 'POST') {
        const token = randomToken(24), th = await sha256hex('mcp:' + token);
        await env.BUCKET.put(`t/${th}`, sp);
        s.connector = th;
        url = `${new URL(req.url).origin}/mcp/${token}`;
      }
      return s;
    });
    return json({ url }, 200, headers);
  }
  return json({ error: 'Not found' }, 404, headers);
}

/* ------------------------------------------------------------------ */
/* MCP (remote connector for Claude)                                   */
/* ------------------------------------------------------------------ */

const MCP_INSTRUCTIONS = `This connector is the user's personal wardrobe from the Outfits app.
- Call list_wardrobe first to see their clothes. Each item has an id, a category and a photo, and may have a short description.
- If items have no description, you can add one with describe_item after looking at the photo (e.g. "navy wool crew-neck sweater"). This makes later requests faster.
- An outfit is either one top + one bottom, or one dress (a dress replaces both). Optionally add one outerwear, one pair of shoes, one bag and up to 3 accessories.
- save_look saves an outfit to the user's Looks in the app. Suggest outfits in your reply and save the ones the user wants (or all, if they asked you to create looks).
- try_on generates a realistic photo of the user wearing an outfit. It costs about 4 US cents per photo, so only call it when the user asks to see an outfit on them.`;

const TOOLS = [
  { name: 'list_wardrobe',
    description: 'List the clothes in the user\'s wardrobe with ids, categories, descriptions and small photos.',
    inputSchema: { type: 'object', properties: {
      category: { type: 'string', enum: Object.keys(CATS), description: 'Only this category' },
      include_photos: { type: 'boolean', description: 'Include a small photo of each item (default true)' } } },
    annotations: { readOnlyHint: true } },
  { name: 'describe_item',
    description: 'Set a short description for a wardrobe item (color, material, type, style). Shown in the app.',
    inputSchema: { type: 'object', required: ['item_id', 'description'], properties: {
      item_id: { type: 'string' }, description: { type: 'string', maxLength: 200 } } } },
  { name: 'list_looks',
    description: 'List saved looks (outfits), newest first, with their items and how many try-on photos each has.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    annotations: { readOnlyHint: true } },
  { name: 'get_look',
    description: 'Get one saved look, including its current try-on photo if it has one.',
    inputSchema: { type: 'object', required: ['look_id'], properties: { look_id: { type: 'string' } } },
    annotations: { readOnlyHint: true } },
  { name: 'save_look',
    description: 'Save an outfit to the user\'s Looks. Rules: one top + one bottom, or one dress; optional outerwear, shoes, bag; up to 3 accessories.',
    inputSchema: { type: 'object', required: ['item_ids'], properties: {
      item_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 9 },
      note: { type: 'string', maxLength: 200, description: 'Optional short note, e.g. the occasion' } } } },
  { name: 'remove_look',
    description: 'Remove a saved look (and its try-on photos) from the user\'s Looks.',
    inputSchema: { type: 'object', required: ['look_id'], properties: { look_id: { type: 'string' } } },
    annotations: { destructiveHint: true } },
  { name: 'try_on',
    description: 'Generate a realistic photo of the user wearing an outfit (about 4 US cents each). The photo is saved to the look in the app. Only use when the user asks to see an outfit on them.',
    inputSchema: { type: 'object', required: ['item_ids'], properties: {
      item_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 9 } } } },
];

const lookKey = ids => [...ids].sort().join('|');
const liveItems = s => Object.values(s.items).filter(i => i && !i.deleted);
const itemLine = it => `- ${it.id} · ${CATS[it.cat]?.one || it.cat}${it.desc ? ` · ${it.desc}` : ''}`;

function checkOutfit(state, ids) {
  if (!Array.isArray(ids) || !ids.length) return 'item_ids is empty.';
  if (new Set(ids).size !== ids.length) return 'item_ids has duplicates.';
  const its = ids.map(id => state.items[id]);
  const bad = ids.filter((id, i) => !its[i] || its[i].deleted);
  if (bad.length) return `Unknown item ids: ${bad.join(', ')}. Call list_wardrobe for valid ids.`;
  const count = c => its.filter(i => i.cat === c).length;
  for (const c of ['top', 'bottom', 'dress', 'outer', 'shoes', 'bag']) if (count(c) > 1) return `Only one ${CATS[c].one} per outfit.`;
  if (count('acc') > 3) return 'At most 3 accessories per outfit.';
  if (count('dress') && (count('top') || count('bottom'))) return 'A dress replaces the top and bottom; don\'t combine them.';
  return null;
}
const pickedVersion = l => {
  const v = l.versions || [];
  return v.find(x => x.created === l.pickCreated) || v[v.length - 1] || null;
};
const text = t => ({ type: 'text', text: t });

async function blobPart(env, sp, h) {
  const o = h && await env.BUCKET.get(blobKey(sp, h));
  if (!o) return null;
  return { type: 'image', data: toB64(await o.arrayBuffer()), mimeType: o.httpMetadata?.contentType || 'image/jpeg' };
}

async function callTool(env, sp, name, args = {}) {
  const { state } = await readState(env, sp);

  if (name === 'list_wardrobe') {
    let its = liveItems(state);
    if (args.category) its = its.filter(i => i.cat === args.category);
    its.sort((a, b) => Object.keys(CATS).indexOf(a.cat) - Object.keys(CATS).indexOf(b.cat) || a.created - b.created);
    if (!its.length) return { content: [text(args.category ? `No ${CATS[args.category]?.one || args.category} items.` : 'The wardrobe is empty. The user adds clothes in the Outfits app.')] };
    const content = [text(`${its.length} items:\n${its.map(itemLine).join('\n')}`)];
    if (args.include_photos !== false) {
      const max = 40, shown = its.slice(0, max);
      const parts = await Promise.all(shown.map(it => blobPart(env, sp, it.ht)));
      shown.forEach((it, i) => { if (parts[i]) content.push(text(`${it.id} (${CATS[it.cat]?.one || it.cat})`), parts[i]); });
      if (its.length > max) content.push(text(`Photos shown for the first ${max}. Use the category filter to see the rest.`));
    }
    return { content };
  }

  if (name === 'describe_item') {
    const desc = String(args.description || '').trim().slice(0, 200);
    if (!desc) return { isError: true, content: [text('description is empty.')] };
    let ok = false;
    await updateState(env, sp, s => {
      const it = s.items[args.item_id];
      if (it && !it.deleted) { s.items[it.id] = { ...it, desc, updated: Math.max(Date.now(), tsOf(it) + 1) }; ok = true; }
      return s;
    });
    return ok ? { content: [text(`Saved description for ${args.item_id}.`)] }
      : { isError: true, content: [text(`Unknown item id ${args.item_id}.`)] };
  }

  if (name === 'list_looks') {
    const looks = Object.values(state.looks).filter(l => l && !l.deleted).sort((a, b) => b.created - a.created).slice(0, args.limit || 30);
    if (!looks.length) return { content: [text('No saved looks yet.')] };
    const lines = looks.map(l => {
      const its = l.items.map(id => state.items[id]).filter(i => i && !i.deleted);
      const n = (l.versions || []).length;
      return `- look ${l.key}${l.note ? ` · "${l.note}"` : ''} · ${n ? `${n} try-on photo${n > 1 ? 's' : ''}` : 'no try-on photo'} · saved ${new Date(l.created).toISOString().slice(0, 10)}\n` +
        its.map(i => `    ${itemLine(i).slice(2)}`).join('\n');
    });
    return { content: [text(`${looks.length} looks:\n${lines.join('\n')}`)] };
  }

  if (name === 'get_look') {
    const l = state.looks[args.look_id];
    if (!l || l.deleted) return { isError: true, content: [text(`Unknown look id ${args.look_id}. Call list_looks.`)] };
    const its = l.items.map(id => state.items[id]).filter(i => i && !i.deleted);
    const content = [text(`Look ${l.key}${l.note ? ` · "${l.note}"` : ''}\n${its.map(itemLine).join('\n')}`)];
    const v = pickedVersion(l), img = v && await blobPart(env, sp, v.h);
    if (img) content.push(text('Current try-on photo:'), img);
    else content.push(text('No try-on photo yet.'));
    return { content };
  }

  if (name === 'save_look') {
    const ids = args.item_ids, err = checkOutfit(state, ids);
    if (err) return { isError: true, content: [text(err)] };
    const k = lookKey(ids), note = args.note ? String(args.note).slice(0, 200) : undefined;
    await updateState(env, sp, s => {
      const cur = s.looks[k], now = Math.max(Date.now(), tsOf(cur) + 1);
      s.looks[k] = cur && !cur.deleted
        ? { ...cur, saved: true, ...(note ? { note } : {}), updated: now }
        : { key: k, items: [...ids], saved: true, created: now, updated: now, versions: [], vdel: cur?.vdel || [], by: 'claude', ...(note ? { note } : {}) };
      return s;
    });
    return { content: [text(`Saved to Looks as look ${k}. It shows up in the Outfits app's Looks tab after the app syncs.`)] };
  }

  if (name === 'remove_look') {
    const l = state.looks[args.look_id];
    if (!l || l.deleted) return { isError: true, content: [text(`Unknown look id ${args.look_id}.`)] };
    await updateState(env, sp, s => { s.looks[args.look_id] = { key: args.look_id, deleted: true, updated: Math.max(Date.now(), tsOf(s.looks[args.look_id]) + 1) }; return s; });
    return { content: [text(`Removed look ${args.look_id}.`)] };
  }

  if (name === 'try_on') {
    const ids = args.item_ids, err = checkOutfit(state, ids);
    if (err) return { isError: true, content: [text(err)] };
    if (!env.GEMINI_API_KEY) return { isError: true, content: [text('Try-on is not configured on this service.')] };
    if (!state.me || state.me.deleted || !state.me.h) return { isError: true, content: [text('The user has no photo of themselves yet. They can add one in the app (Me tab).')] };
    if (await rateLimited(env, 'mcp:' + sp)) return { isError: true, content: [text('Too many try-ons right now. Try again in a minute.')] };
    const its = ids.map(id => state.items[id]);
    const load = async h => { const o = h && await env.BUCKET.get(blobKey(sp, h)); return o && { data: toB64(await o.arrayBuffer()), mime: o.httpMetadata?.contentType || 'image/jpeg' }; };
    const person = await load(state.me.h);
    const pieces = await Promise.all(its.map(it => load(it.useOriginal ? it.ho : (it.hp || it.ho))));
    if (!person || pieces.some(p => !p)) return { isError: true, content: [text('Some photos are still uploading from the app. Try again in a minute.')] };
    const img = (label, p) => [{ text: label }, { inline_data: { mime_type: p.mime, data: p.data } }];
    const parts = [{ text: buildPrompt(its.map(i => i.cat)) }, ...img('Image 1 — the person:', person),
      ...pieces.flatMap((p, i) => img(`Image ${i + 2} — ${CATS[its[i].cat].one}:`, p))];
    let g;
    try { g = await generate(env, parts); } catch (e) { return { isError: true, content: [text(e.message || 'Image generation failed.')] }; }
    const bytes = fromB64(g.data), h = await sha256hex(bytes), cost = costOf(g.model, g.usage), now = Date.now();
    await env.BUCKET.put(blobKey(sp, h), bytes, { httpMetadata: { contentType: g.mime } });
    const k = lookKey(ids);
    await updateState(env, sp, s => {
      const cur = s.looks[k] && !s.looks[k].deleted ? s.looks[k] : null, t = Math.max(now, tsOf(s.looks[k]) + 1);
      const v = { created: t, h, meId: state.me.meId || null, cost, by: 'claude' };
      s.looks[k] = { ...(cur || { key: k, items: [...ids], created: t, vdel: [], by: 'claude' }),
        saved: true, versions: [...(cur?.versions || []), v], pickCreated: t, updated: t };
      s.spend = [...(s.spend || []), { t, usd: +cost.toFixed(5), edit: false, by: 'claude' }].slice(-5000);
      return s;
    });
    return { content: [text(`Try-on saved to look ${k} (cost about ${(cost * 100).toFixed(1)}¢).`), { type: 'image', data: g.data, mimeType: g.mime }] };
  }

  return { isError: true, content: [text(`Unknown tool ${name}`)] };
}

async function handleMcp(req, env, token) {
  if (!env.BUCKET) return new Response('Not configured', { status: 501 });
  const sp = await env.BUCKET.get(`t/${await sha256hex('mcp:' + token)}`).then(o => o && o.text());
  if (!sp) return new Response('Unknown connector link', { status: 404 });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });

  let msg;
  try { msg = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  const batch = Array.isArray(msg), msgs = batch ? msg : [msg], out = [];
  for (const m of msgs) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      if (m && m.id !== undefined && m.method === undefined) continue; // a response from the client; ignore
      out.push({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); continue;
    }
    if (m.id === undefined) continue; // notification
    const reply = r => out.push({ jsonrpc: '2.0', id: m.id, result: r });
    const fail = (code, message) => out.push({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    try {
      switch (m.method) {
        case 'initialize': {
          const v = m.params?.protocolVersion;
          reply({ protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'outfits', title: 'Outfits wardrobe', version: '1.0.0' },
            instructions: MCP_INSTRUCTIONS });
          break;
        }
        case 'ping': reply({}); break;
        case 'tools/list': reply({ tools: TOOLS }); break;
        case 'tools/call': {
          const name = m.params?.name;
          if (!TOOLS.some(t => t.name === name)) { fail(-32602, `Unknown tool: ${name}`); break; }
          try { reply(await callTool(env, sp, name, m.params?.arguments || {})); }
          catch (e) { reply({ isError: true, content: [text(e?.message || 'Something went wrong. Try again.')] }); }
          break;
        }
        case 'resources/list': reply({ resources: [] }); break;
        case 'prompts/list': reply({ prompts: [] }); break;
        default: fail(-32601, `Method not found: ${m.method}`);
      }
    } catch (e) { fail(-32603, 'Internal error'); }
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(batch ? out : out[0]);
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;

    const mm = /^\/mcp\/([A-Za-z0-9_-]{20,64})$/.exec(path);
    if (mm) return handleMcp(req, env, mm[1]);

    const { ok, headers } = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers });
    if (!ok && (path === '/tryon' || path.startsWith('/sync/'))) return json({ error: 'Origin not allowed' }, 403, headers);

    if (path === '/tryon' && req.method === 'POST') return handleTryon(req, env, headers);
    if (path.startsWith('/sync/')) {
      try { return await handleSync(req, env, headers, path); }
      catch (e) { return json({ error: e?.message || 'Sync failed' }, e?.status || 500, headers); }
    }
    return json({ error: 'Not found' }, 404, headers);
  },
};
