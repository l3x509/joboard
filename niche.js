// niche.js
//
// Business Niche finder for the Ops Board. Same philosophy as the job side:
// real evidence, honest scoring against Dulex's actual assets and capacity,
// and a hard focus limit so ideas get tested or killed instead of piling up.
//
// Sources:
//   - Scout research (Claude + web search) — discover niches / score one idea
//   - Hacker News (Algolia public API, no key) — "I'd pay for…" pain points
//   - Reddit (official OAuth, only if REDDIT_CLIENT_ID/SECRET are set)
//   - YouTube Data API v3 (only if YOUTUBE_API_KEY is set) — channel stats
//
// Env (all optional except ANTHROPIC_API_KEY for research):
//   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET  — free "script" app at reddit.com/prefs/apps
//   YOUTUBE_API_KEY                        — free key in Google Cloud console (YouTube Data API v3)

const fetch = require('node-fetch');

const RESEARCH_TTL_MS = 12 * 60 * 60 * 1000;
const SIGNAL_TTL_MS = 60 * 60 * 1000;

// Who the niches are for. Deliberately no diaspora/Kreyòl marketing angles
// (his stated preference) and no outbound/in-person sales models.
const NICHE_SYSTEM_PROMPT = `You are "Scout," a business-niche analyst for Dulex Cherenfant (Randolph, MA), embedded in his personal Ops Board.

HIS ASSETS (score "reuse" against these, concretely):
- 15+ years IT: 8 yrs NOC (NG911/VoIP, SolarWinds), security analyst (Sentinel, CrowdStrike, Qualys), VMware TechOps, desktop support/AD/imaging, Azure/AWS/GCP hands-on, PowerShell, Linux daily.
- Current Field Service Engineer on FDA-regulated Zeiss ophthalmic devices (CIRRUS OCT, HFA): Windows upgrades, DICOM/PACS, change control, photo audit trails; built his own upgrade tracker and photo-packet tools.
- Solo builder who ships: Node.js/Express, Supabase/PostgreSQL, Railway, WhatsApp Cloud API, PWAs/Android, LLM integration, GA4 dashboards, scraping pipelines with official APIs. Live products: a business directory with WhatsApp bot, a car-auction data tool (VinBidIQ), a family movie finder (WatchWithKids), a co-parenting app, a consumer-rights blog, a trivia PWA, an immigration-help info site, this job dashboard.
- Side work: tax prep and form help; an LLC (Lexcellent Solutions) for IT consulting to medical practices (has BAA template, SLA one-pager).
- Languages: English, French (fluent), Haitian Creole, basic Spanish.

HIS CONSTRAINTS (score "capacity" against these):
- ~10 hours/week, under $500 total to launch, first revenue within ~90 days.
- Online only. Async/inbound models (SEO, marketplaces, app stores, content, directories, self-serve SaaS, digital products, YouTube). NO outbound cold sales, NO in-person sales, NO door-to-door, NO cold calling.
- Introverted; prefers systems over people-heavy service.
- Do NOT propose niches whose main angle is marketing to the Haitian/Kreyòl diaspora.
- Avoid regulated advice businesses he isn't licensed for (legal, medical, financial advice).

HONESTY RULES:
- Every demand claim needs a real URL you found by search (forum thread, marketplace listing with sales/reviews, keyword/trend data, competitor pricing page, YouTube channel). Never invent numbers or URLs. If evidence is thin, say so and score low.
- Prefer niches that REUSE what he already built or knows over brand-new domains. He has many products already; the bottleneck is execution, so favor ideas with a fast, cheap 2-week validation test and a clear kill rule.
- Any type of online business is fine (not just IT): digital products, templates, niche SaaS, directories, content sites, YouTube channels, marketplaces, productized services delivered remotely.

SCORING (integers): demand 0-25, reuse 0-25, inbound 0-15, capacity 0-15, competition 0-10 (10 = weak competition / clear gap), validation 0-10 (10 = testable in 2 weeks for under $50). total = sum.

OUTPUT: respond with ONLY raw JSON, no markdown fences. Each niche object:
{"name": "short name", "type": "digital product | micro-SaaS | directory | content site | YouTube channel | marketplace shop | productized remote service | other", "pitch": "1 sentence: who pays, for what", "why_you": "1-2 sentences tying to his specific assets", "evidence": [{"claim": "...", "url": "https://..."}], "competition": "1 sentence incl. a named competitor and price if found", "first_dollar": "1 sentence: exact channel + price point for first sale", "test_2wk": "concrete 2-week validation test under $50", "kill_rule": "measurable rule to abandon, e.g. <20 email signups from 500 visitors", "scores": {"demand": n, "reuse": n, "inbound": n, "capacity": n, "competition": n, "validation": n}, "total": n}`;

function extractJson(raw) {
  const t = (raw || '').replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('['), o = t.indexOf('{');
  const start = a === -1 ? o : (o === -1 ? a : Math.min(a, o));
  const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (start === -1 || end === -1) throw new Error('Research did not return JSON');
  return JSON.parse(t.slice(start, end + 1));
}

const CAPS = { demand: 25, reuse: 25, inbound: 15, capacity: 15, competition: 10, validation: 10 };
function cleanNiche(n) {
  if (!n || !n.name) return null;
  const scores = {};
  Object.entries(CAPS).forEach(([k, cap]) => { scores[k] = Math.max(0, Math.min(cap, Math.round(Number((n.scores || {})[k]) || 0))); });
  const evidence = (Array.isArray(n.evidence) ? n.evidence : []).filter(e => e && /^https?:\/\//.test(e.url || '')).slice(0, 6);
  // No evidence links → demand can't be high, whatever the model said.
  if (!evidence.length) scores.demand = Math.min(scores.demand, 8);
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  return {
    name: String(n.name).slice(0, 80), type: String(n.type || 'other').slice(0, 40),
    pitch: String(n.pitch || '').slice(0, 300), why_you: String(n.why_you || '').slice(0, 400),
    evidence, competition: String(n.competition || '').slice(0, 300),
    first_dollar: String(n.first_dollar || '').slice(0, 300), test_2wk: String(n.test_2wk || '').slice(0, 400),
    kill_rule: String(n.kill_rule || '').slice(0, 300), scores, total,
  };
}

const researchCache = new Map(); // key -> { at, items }

async function discover(callScout, focus, force) {
  const key = 'discover:' + (focus || '').toLowerCase().trim();
  const hit = researchCache.get(key);
  if (!force && hit && Date.now() - hit.at < RESEARCH_TTL_MS) return { items: hit.items, fromCache: true, at: hit.at };
  const ask = `Find 6 online business niches for me${focus ? ` in or near this area: "${focus}"` : ' across any field (not only IT)'}. Search the web for real demand evidence for each (forums asking for it, marketplace listings with sales/reviews, competitor pricing, search-trend or YouTube data). Mix types (digital product, micro-SaaS, directory, content/YouTube, productized remote service). Rank by total. Return a JSON array of 6 niche objects.`;
  const raw = await callScout([{ role: 'user', content: ask }], 6000, 14, NICHE_SYSTEM_PROMPT);
  const parsed = extractJson(raw);
  const items = (Array.isArray(parsed) ? parsed : [parsed]).map(cleanNiche).filter(Boolean).sort((a, b) => b.total - a.total);
  if (!items.length) throw new Error('No niches came back from research');
  researchCache.set(key, { at: Date.now(), items });
  return { items, fromCache: false, at: Date.now() };
}

async function evaluate(callScout, idea) {
  const name = String(idea.name || '').slice(0, 120), desc = String(idea.description || '').slice(0, 1200);
  if (name.length < 2) throw new Error('idea name required');
  const ask = `Evaluate this business idea of mine honestly: "${name}"${desc ? ` — ${desc}` : ''}. Search the web for demand evidence and competitors. If it's weak, say so with low scores and suggest a sharper variant in "pitch". Return ONE niche JSON object.`;
  const raw = await callScout([{ role: 'user', content: ask }], 3000, 8, NICHE_SYSTEM_PROMPT);
  const parsed = extractJson(raw);
  const item = cleanNiche(Array.isArray(parsed) ? parsed[0] : parsed);
  if (!item) throw new Error('Evaluation did not return a niche');
  return item;
}

// ---------------------------------------------------------------------------
// Live signals
// ---------------------------------------------------------------------------
const PAIN_PHRASES = ['"I would pay for"', '"is there a tool"', '"wish there was an app"', '"looking for a service"', '"anyone know a tool"', '"I\'d pay"'];
const signalCache = new Map();

function stripHtml(h) { return (h || '').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }

async function hnSignals(q) {
  const since = Math.floor(Date.now() / 1000) - 60 * 86400;
  const queries = q ? [q, ...PAIN_PHRASES.slice(0, 2).map(p => `${p} ${q}`)] : PAIN_PHRASES;
  const out = [];
  for (const query of queries) {
    const u = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=(story,comment)&numericFilters=created_at_i>${since}&hitsPerPage=15`;
    const r = await fetch(u, { timeout: 12000 });
    if (!r.ok) continue;
    const d = await r.json();
    (d.hits || []).forEach(h => {
      const text = stripHtml(h.comment_text || h.story_text || '');
      out.push({
        source: 'Hacker News', id: 'hn-' + h.objectID,
        title: h.title || h.story_title || text.slice(0, 90),
        snippet: text.slice(0, 260),
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        points: h.points || 0, comments: h.num_comments || 0, created: h.created_at,
      });
    });
  }
  return out;
}

let redditToken = null;
async function redditSignals(q) {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return { items: [], note: 'Reddit is off — add REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in Railway (free script app at reddit.com/prefs/apps).' };
  const UA = 'web:opsboard-niche:1.0 (personal dashboard)';
  if (!redditToken || redditToken.exp < Date.now()) {
    const r = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST', timeout: 12000,
      headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'User-Agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!r.ok) return { items: [], note: `Reddit auth failed (HTTP ${r.status}) — check the credentials.` };
    const t = await r.json();
    redditToken = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
  }
  const queries = q ? [`${q} "would pay"`, `${q} "is there a tool"`, q] : ['"would pay for" tool', '"is there an app that"', '"looking for a tool"'];
  const items = [];
  for (const query of queries) {
    const r = await fetch(`https://oauth.reddit.com/search?q=${encodeURIComponent(query)}&sort=new&t=month&limit=20&type=link`, { timeout: 12000, headers: { Authorization: `Bearer ${redditToken.token}`, 'User-Agent': UA } });
    if (!r.ok) continue;
    const d = await r.json();
    ((d.data || {}).children || []).forEach(({ data: p }) => {
      if (p.over_18) return;
      items.push({
        source: `Reddit r/${p.subreddit}`, id: 'rd-' + p.id, title: p.title,
        snippet: (p.selftext || '').replace(/\s+/g, ' ').slice(0, 260),
        url: `https://www.reddit.com${p.permalink}`, points: p.score || 0, comments: p.num_comments || 0,
        created: new Date(p.created_utc * 1000).toISOString(),
      });
    });
  }
  return { items, note: null };
}

async function youtubeCheck(q) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return { channels: [], note: 'YouTube is off — add a free YOUTUBE_API_KEY (YouTube Data API v3) in Railway to see channel sizes for a niche.' };
  if (!q) return { channels: [], note: 'Type a niche to check YouTube.' };
  const s = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=10&q=${encodeURIComponent(q)}&key=${key}`, { timeout: 12000 });
  if (!s.ok) return { channels: [], note: `YouTube search failed (HTTP ${s.status}).` };
  const sd = await s.json();
  const ids = (sd.items || []).map(i => i.id && i.id.channelId).filter(Boolean);
  if (!ids.length) return { channels: [], note: null };
  const c = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${ids.join(',')}&key=${key}`, { timeout: 12000 });
  if (!c.ok) return { channels: [], note: `YouTube channel lookup failed (HTTP ${c.status}).` };
  const cd = await c.json();
  const channels = (cd.items || []).map(ch => {
    const st = ch.statistics || {};
    const subs = st.hiddenSubscriberCount ? null : Number(st.subscriberCount || 0);
    const views = Number(st.viewCount || 0), vids = Number(st.videoCount || 0);
    return { id: ch.id, title: ch.snippet.title, url: `https://www.youtube.com/channel/${ch.id}`, created: ch.snippet.publishedAt,
      subs, views, videos: vids, viewsPerVideo: vids ? Math.round(views / vids) : 0 };
  }).sort((a, b) => (b.subs || 0) - (a.subs || 0));
  return { channels, note: null };
}

async function signals(q, force) {
  const key = (q || '').toLowerCase().trim();
  const hit = signalCache.get(key);
  if (!force && hit && Date.now() - hit.at < SIGNAL_TTL_MS) return { ...hit.data, fromCache: true };
  const [hn, rd, yt] = await Promise.all([
    hnSignals(q).catch(e => { console.error('HN', e.message); return []; }),
    redditSignals(q).catch(e => ({ items: [], note: `Reddit error: ${e.message}` })),
    youtubeCheck(q).catch(e => ({ channels: [], note: `YouTube error: ${e.message}` })),
  ]);
  const seen = new Set();
  const items = [...hn, ...rd.items].filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; })
    .sort((a, b) => new Date(b.created) - new Date(a.created)).slice(0, 60);
  const data = { items, youtube: yt.channels, notes: [rd.note, yt.note].filter(Boolean), at: Date.now() };
  signalCache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = { discover, evaluate, signals, cleanNiche, extractJson, NICHE_SYSTEM_PROMPT };
