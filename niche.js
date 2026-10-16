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
const { ai } = require('./aibudget'); // Haiku 5.5 + monthly spend cap ($1 default)

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

async function discover(_unused, focus, force) {
  const key = 'discover:' + (focus || '').toLowerCase().trim();
  const hit = researchCache.get(key);
  if (!force && hit && Date.now() - hit.at < RESEARCH_TTL_MS) return { items: hit.items, fromCache: true, at: hit.at };
  const ask = `Find 6 online business niches for me${focus ? ` in or near this area: "${focus}"` : ' across any field (not only IT)'}. Use your few web searches wisely (search broad pages that cover several niches) to find real demand evidence for each (forums asking for it, marketplace listings with sales/reviews, competitor pricing, search-trend or YouTube data). Mix types (digital product, micro-SaaS, directory, content/YouTube, productized remote service). Rank by total. Return a JSON array of 6 niche objects.`;
  const raw = await ai({ system: NICHE_SYSTEM_PROMPT, ask, maxTokens: 5000, searches: 4, purpose: 'Find niches' }); // ~$0.05
  const parsed = extractJson(raw);
  const items = (Array.isArray(parsed) ? parsed : [parsed]).map(cleanNiche).filter(Boolean).sort((a, b) => b.total - a.total);
  if (!items.length) throw new Error('No niches came back from research');
  researchCache.set(key, { at: Date.now(), items });
  return { items, fromCache: false, at: Date.now() };
}

async function evaluate(_unused, idea) {
  const name = String(idea.name || '').slice(0, 120), desc = String(idea.description || '').slice(0, 1200);
  if (name.length < 2) throw new Error('idea name required');
  const ask = `Evaluate this business idea of mine honestly: "${name}"${desc ? ` — ${desc}` : ''}. Search the web for demand evidence and competitors. If it's weak, say so with low scores and suggest a sharper variant in "pitch". Return ONE niche JSON object.`;
  const raw = await ai({ system: NICHE_SYSTEM_PROMPT, ask, maxTokens: 2500, searches: 3, purpose: 'Score an idea' }); // ~$0.04
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


// ---------------------------------------------------------------------------
// Hot ideas to replicate locally — scanned automatically on a timer
// ---------------------------------------------------------------------------
// Scout looks for businesses/products that are taking off somewhere else
// (another city, online, a recent launch) and checks whether his area has one
// yet. Runs once a day on the server (HOT_SCAN_HOURS, default 24, 0 = off) and
// keeps every find so new ones stack up between visits.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_AREA = 'South Shore Massachusetts (Randolph, Brockton, Quincy, Weymouth, Braintree, Stoughton) and greater Boston';
const HOT_FILE = path.join(process.env.DATA_DIR || os.tmpdir(), 'opsboard-hot-ideas.json');
const HOT_MIN_FORCE_MS = 60 * 60 * 1000; // manual "scan now" at most once an hour (cost guard)

let hot = { at: 0, area: DEFAULT_AREA, items: [], showhn: [], feed: [], feedAt: 0, running: false, lastError: null, nextAt: 0, analysis: null, analyzing: false, analysisError: null, board: [] };

// Paid automatic jobs — ALL OFF by default. Everything that costs money runs only
// when Dulex clicks it, unless he switches one of these on in the Hot tab.
const SETTINGS_FILE = path.join(process.env.DATA_DIR || os.tmpdir(), 'opsboard-biz-settings.json');
const SETTINGS_DEFAULT = { autoWriteup: false, autoLocalTop: 0, autoAnalyzeDays: 0 };
let bizSettings = { ...SETTINGS_DEFAULT };
try { bizSettings = { ...bizSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (_) {}
function getSettings() { return { ...bizSettings }; }
function setSettings(s = {}) {
  const n = { ...bizSettings };
  if ('autoWriteup' in s) n.autoWriteup = s.autoWriteup === true;
  if ('autoLocalTop' in s) n.autoLocalTop = Math.max(0, Math.min(10, Math.round(Number(s.autoLocalTop) || 0)));
  if ('autoAnalyzeDays' in s) n.autoAnalyzeDays = Math.max(0, Math.min(30, Math.round(Number(s.autoAnalyzeDays) || 0)));
  bizSettings = n;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(n)); } catch (e) { console.error('settings save', e.message); }
  return getSettings();
}
try { const saved = JSON.parse(fs.readFileSync(HOT_FILE, 'utf8')); hot = { ...hot, ...saved, running: false, analyzing: false }; } catch (_) {}
function saveHot() { try { fs.writeFileSync(HOT_FILE, JSON.stringify({ ...hot, running: false, analyzing: false })); } catch (e) { console.error('hot save', e.message); } }

function cleanHot(n) {
  const base = cleanNiche(n); if (!base) return null;
  const str = (v, max) => String(v || '').slice(0, max);
  return { ...base, where: str(n.where, 160), why_hot: str(n.why_hot, 300), local_gap: str(n.local_gap, 300),
    local_competitors: (Array.isArray(n.local_competitors) ? n.local_competitors : []).map(c => str(c, 80)).filter(Boolean).slice(0, 4),
    launch_cost: str(n.launch_cost, 120), local_checked: n.local_checked === true, feed: str(n.feed, 40) };
}

// ---- Free discovery feeds (no AI, no key) ----
function decodeXml(t) { return String(t || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, ' ').trim(); }
const NEWS_QUERIES = ['fastest growing small business', 'side hustle making money online', 'startup launches app for small businesses', 'booming local service business', 'solo founder revenue micro saas'];
async function googleNews(q) {
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:30d')}&hl=en-US&gl=US&ceid=US:en`, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 (OpsBoard personal dashboard)' } });
  if (!r.ok) return [];
  const xml = await r.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map(m => {
    const it = m[1], g = tag => { const x = it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`)); return x ? decodeXml(x[1]) : ''; };
    return { feed: 'Google News', title: g('title'), url: g('link'), snippet: g('source'), date: g('pubDate') };
  }).filter(i => i.title && i.url);
}
async function productHunt() {
  const r = await fetch('https://www.producthunt.com/feed', { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 (OpsBoard personal dashboard)' } });
  if (!r.ok) return [];
  const xml = await r.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, 20).map(m => {
    const it = m[1]; const t = it.match(/<title[^>]*>([\s\S]*?)<\/title>/); const l = it.match(/<link[^>]*href="([^"]+)"/); const c = it.match(/<content[^>]*>([\s\S]*?)<\/content>/);
    return { feed: 'Product Hunt', title: t ? decodeXml(t[1]) : '', url: l ? l[1] : '', snippet: c ? decodeXml(c[1]).slice(0, 160) : '' };
  }).filter(i => i.title && i.url);
}
// Free: pull the feeds into hot.feed (raw items, no AI). Keeps the newest 300.
async function fetchFeeds() {
  const cands = await freeCandidates();
  const now = new Date().toISOString();
  const byUrl = new Map((hot.feed || []).map(f => [f.url, f]));
  let added = 0;
  cands.forEach(c => { if (!byUrl.has(c.url)) { byUrl.set(c.url, { ...c, id: 'f' + Buffer.from(c.url).toString('base64').replace(/[^a-z0-9]/gi, '').slice(-16), firstSeen: now, reviewed: false }); added++; } });
  hot.feed = [...byUrl.values()].sort((a, b) => (b.firstSeen || '').localeCompare(a.firstSeen || '')).slice(0, 300);
  hot.feedAt = Date.now();
  try { hot.showhn = await showHn(); } catch (_) {}
  saveHot();
  return added;
}
async function freeCandidates() {
  const settled = await Promise.allSettled([showHn(), productHunt(), ...NEWS_QUERIES.map(googleNews)]);
  const out = []; const seen = new Set();
  settled.forEach((s, i) => {
    if (s.status !== 'fulfilled') { console.error('feed', i, s.reason && s.reason.message); return; }
    (s.value || []).forEach(x => {
      const item = x.feed ? x : { feed: 'Show HN', title: x.title, url: x.url, snippet: `${x.points} points, ${x.comments} comments` };
      const k = item.title.toLowerCase().slice(0, 60); if (seen.has(k)) return; seen.add(k); out.push(item);
    });
  });
  return out.slice(0, 70);
}

async function showHn() {
  const since = Math.floor(Date.now() / 1000) - 10 * 86400;
  const r = await fetch(`https://hn.algolia.com/api/v1/search?tags=show_hn&numericFilters=created_at_i>${since},points>40&hitsPerPage=30`, { timeout: 12000 });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.hits || []).map(h => ({ id: 'shn-' + h.objectID, title: (h.title || '').replace(/^Show HN:\s*/i, ''), url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    discussion: `https://news.ycombinator.com/item?id=${h.objectID}`, points: h.points || 0, comments: h.num_comments || 0, created: h.created_at }))
    .sort((a, b) => b.points - a.points).slice(0, 15);
}

// mode 'free' (daily, automatic): candidates from free feeds, Haiku picks and writes them up, no web search (~$0.003).
// mode 'deep' (Scan now button): Haiku with 5 web searches, includes a local check (~$0.06).
async function scanHot(area, { mode = 'free', auto = false, ids = null } = {}) {
  if (hot.running) return hot;
  hot.running = true; hot.lastError = null; hot.lastTryAt = Date.now();
  const where = area || hot.area || DEFAULT_AREA;
  try {
    const known = hot.items.map(i => i.name).slice(0, 120).join('; '); // most recent first; keeps the prompt small as history grows
    const shape = `Return ONLY a JSON array of niche objects with these EXTRA fields: "where": "where it is working now (city, platform)", "why_hot": "1 sentence with the growth signal", "local_competitors": ["names found locally, empty if none or not checked"], "local_gap": "1 sentence about the opening in my area", "launch_cost": "rough $ to launch a test", "feed": "where you found it"`;
    let ask, searches = 0, cands = [];
    if (mode === 'deep') {
      searches = 5;
      ask = `Scan the web for 6 HOT business ideas I could replicate in ${where}: launched or clearly growing in the last ~6 months somewhere else (Product Hunt / Indie Hackers / Starter Story with revenue, fast-growing local service concepts in other US cities, viral Etsy/Gumroad/Chrome-store products, booming businesses in the news). You only have 5 searches: use broad roundup pages, then spend 1-2 on checking whether ${where} already has the best ones. Prefer online/async ideas that fit ~10 hrs/week and under $500.
${known ? `Skip these, already found: ${known}.` : ''}
${shape}. Set "local_checked": true only for ideas you actually searched locally. Evidence URLs must be pages you found.`;
    } else {
      if (!(hot.feed || []).length) await fetchFeeds();
      const pool = ids && ids.length ? hot.feed.filter(f => ids.includes(f.id)) : hot.feed.filter(f => !f.reviewed);
      cands = pool.slice(0, 40);
      if (!cands.length) throw new Error(ids ? 'Those feed items are gone' : 'No new feed items to write up');
      ask = `Below are this week's items from free feeds (Show HN, Product Hunt, Google News). Using ONLY these items (no outside facts), pick up to ${Math.min(8, cands.length)} that point to a business I could replicate in ${where} or online — the item itself, a local version, or the business opportunity the news reveals. Skip pure dev tools, crypto, and anything needing heavy capital.
${known ? `Skip these, already found: ${known}.\n` : ''}
ITEMS:
${cands.map((c, i) => `${i + 1}. [${c.feed}] ${c.title} — ${c.snippet || ''} — ${c.url}`).join('\n')}

${shape}. "evidence" must be [{"claim": "...", "url": "<the item's exact URL from the list>"}]. You have NOT checked my area: start "local_gap" with "Unverified:" and leave "local_competitors" empty. Be conservative with demand scores — one news item is weak evidence.`;
    }
    const raw = await ai({ system: NICHE_SYSTEM_PROMPT, ask, maxTokens: 5000, searches, auto, purpose: mode === 'deep' ? 'Deep hot scan' : (auto ? 'Auto write-up' : 'Write up feed items') });
    const parsed = extractJson(raw);
    const fresh = (Array.isArray(parsed) ? parsed : [parsed]).map(x => cleanHot({ ...x, local_checked: mode === 'deep' && x.local_checked === true })).filter(Boolean);
    if (!fresh.length) throw new Error('Scan returned no ideas');
    const now = new Date().toISOString();
    const byName = new Map(hot.items.map(i => [i.name.toLowerCase(), i]));
    fresh.forEach(i => { const old = byName.get(i.name.toLowerCase()); byName.set(i.name.toLowerCase(), { ...i, firstSeen: old ? old.firstSeen : now, lastSeen: now }); });
    hot.items = [...byName.values()].sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '') || b.total - a.total); // no cap: every find is kept
    hot.area = where; hot.at = Date.now(); if (hotHours()) hot.nextAt = hot.at + hotHours() * 3600 * 1000;
    hot.lastMode = mode;
    if (mode !== 'deep') { const used = new Set(cands.map(c => c.id)); hot.feed.forEach(f => { if (used.has(f.id)) { f.reviewed = true; f.reviewedAt = now; } }); }
  } catch (e) { hot.lastError = e.message; console.error('hot scan', e.message); }
  hot.running = false; saveHot();
  return hot;
}

// "Check my area" for one hot find: 2 web searches (~$0.025)
async function checkLocal(name, { auto = false } = {}) {
  const it = hot.items.find(i => i.name.toLowerCase() === String(name || '').toLowerCase());
  if (!it) throw new Error('That hot find is no longer in the list');
  const where = hot.area || DEFAULT_AREA;
  const ask = `Check whether ${where} already has this business: "${it.name}" — ${it.pitch}. Use at most 2 searches (e.g. "<service> near Brockton MA", "<service> South Shore MA"). Return ONLY JSON: {"local_competitors": ["names actually found, max 4"], "local_gap": "1 sentence: is there an opening here and why", "evidence": [{"claim": "...", "url": "https://..."}]}`;
  const raw = await ai({ system: NICHE_SYSTEM_PROMPT, ask, maxTokens: 800, searches: 2, auto, purpose: 'Check my area' });
  const d = extractJson(raw);
  const str = (v, m) => String(v || '').slice(0, m);
  it.local_competitors = (Array.isArray(d.local_competitors) ? d.local_competitors : []).map(c => str(c, 80)).filter(Boolean).slice(0, 4);
  it.local_gap = str(d.local_gap, 300) || it.local_gap;
  it.local_checked = true; it.localCheckedAt = new Date().toISOString();
  const ev = (Array.isArray(d.evidence) ? d.evidence : []).filter(e => e && /^https?:\/\//.test(e.url || '')).slice(0, 3);
  it.evidence = [...(it.evidence || []), ...ev].slice(0, 8);
  saveHot();
  return it;
}

// ---------------------------------------------------------------------------
// Pattern analysis over ALL hot finds: overlap clusters, blind angles, gaps
// ---------------------------------------------------------------------------
// Runs after every successful scan (and on demand). Uses the latest snapshot of
// his board that the dashboard sent, so angles avoid what he already has.
const ANALYZE_MIN_FORCE_MS = 60 * 60 * 1000;
const ANGLE_TYPES = ['picks and shovels', 'B2B version', 'combination', 'local version', 'underserved segment', 'missing feature', 'other'];

function cleanAnalysis(raw, hotNames) {
  const str = (v, m) => String(v || '').slice(0, m);
  const names = new Set(hotNames.map(n => n.toLowerCase()));
  const keepNames = arr => (Array.isArray(arr) ? arr : []).map(x => str(x, 100)).filter(x => names.has(x.toLowerCase())).slice(0, 12);
  const clusters = (Array.isArray(raw.clusters) ? raw.clusters : []).map(c => ({ name: str(c.name, 80), pattern: str(c.pattern, 300), why_now: str(c.why_now, 300), members: keepNames(c.members) }))
    .filter(c => c.name && c.members.length >= 2).slice(0, 8);
  const angles = (Array.isArray(raw.blind_angles) ? raw.blind_angles : []).map(a => {
    const base = cleanNiche(a); if (!base) return null;
    const t = str(a.angle_type, 40).toLowerCase();
    return { ...base, angle_type: ANGLE_TYPES.includes(t) ? t : 'other', built_from: (Array.isArray(a.built_from) ? a.built_from : []).map(x => str(x, 100)).slice(0, 4), why_unserved: str(a.why_unserved, 300) };
  }).filter(Boolean).sort((a, b) => b.total - a.total).slice(0, 8);
  const gaps = (Array.isArray(raw.gaps) ? raw.gaps : []).map(g => ({ gap: str(g.gap, 200), seen_in: (Array.isArray(g.seen_in) ? g.seen_in : []).map(x => str(x, 100)).slice(0, 4), how_to_use: str(g.how_to_use, 300) }))
    .filter(g => g.gap).slice(0, 10);
  return { clusters, angles, gaps };
}

async function analyzeHot({ force = false, board, auto = false } = {}) {
  if (Array.isArray(board)) hot.board = board.slice(0, 80).map(b => ({ name: String(b.name || '').slice(0, 80), pitch: String(b.pitch || '').slice(0, 160), status: String(b.status || '').slice(0, 20) }));
  const a = hot.analysis;
  if (hot.analyzing) return { analysis: a, running: true };
  if (!hot.items.length) return { analysis: a, note: 'No hot finds to analyze yet — run a scan first.' };
  if (a && !force && a.basedOn === hot.items.length) return { analysis: a };
  if (a && force && Date.now() - a.at < ANALYZE_MIN_FORCE_MS && a.basedOn === hot.items.length) return { analysis: a, note: 'Analyzed less than an hour ago with the same finds — showing that.' };
  hot.analyzing = true;
  try {
    const finds = hot.items.slice(0, 150).map(i => `- ${i.name} [${i.type}] — ${i.pitch} | where: ${i.where || '?'} | hot: ${i.why_hot || '?'} | local: ${i.local_gap || '?'} | local competitors: ${(i.local_competitors || []).join(', ') || 'none found'}`).join('\n');
    const mine = (hot.board || []).filter(b => b.status !== 'Killed').map(b => `- ${b.name}: ${b.pitch}`).join('\n') || '(none sent)';
    const ask = `Here are ALL the hot business finds my scanner has collected (${hot.items.length}):
${finds}

My own idea board (don't repeat these as new angles; build on them where it helps):
${mine}

Analyze the finds as a set, not one by one:
1. "clusters": groups of 2+ finds that are really the same underlying pattern (same buyer pain, same mechanism or same trend). Use the exact find names in "members". Say what the pattern is and why it is happening now.
2. "blind_angles": up to 5 businesses that NONE of the finds or my ideas already are, but that the patterns point to. Look for: picks-and-shovels (sell to the operators riding a trend), the B2B version of a consumer find (or vice versa), a combination of two finds, a local version for ${hot.area || DEFAULT_AREA}, an ignored customer segment, a feature every player is missing. You have only 2 web searches: use them on the 2 most promising angles to check they are unserved, and cite them. For the others, say in \"why_unserved\" that it is not yet verified. Score each with the normal niche fields and scoring, plus "angle_type" (one of: ${ANGLE_TYPES.join(', ')}), "built_from" (find names it comes from), "why_unserved" (1 sentence).
3. "gaps": specific holes inside the hot finds — complaints about the leaders, missing features, price points nobody offers, regions or segments not covered. Each: "gap", "seen_in" (find names), "how_to_use" (1 sentence on how I could exploit it with my constraints).
Return ONLY raw JSON: {"clusters":[{"name","pattern","why_now","members":[...]}],"blind_angles":[niche objects with the extra fields],"gaps":[{"gap","seen_in":[...],"how_to_use"}]}`;
    const raw = await ai({ system: NICHE_SYSTEM_PROMPT, ask, maxTokens: 6000, searches: 2, auto, purpose: 'Pattern analysis' }); // ~$0.03
    const parsed = extractJson(raw);
    const clean = cleanAnalysis(Array.isArray(parsed) ? {} : parsed, hot.items.map(i => i.name));
    if (!clean.clusters.length && !clean.angles.length && !clean.gaps.length) throw new Error('Analysis came back empty');
    hot.analysis = { ...clean, at: Date.now(), basedOn: hot.items.length };
    hot.analysisError = null;
  } catch (e) { hot.analysisError = e.message; console.error('hot analyze', e.message); }
  hot.analyzing = false; saveHot();
  return { analysis: hot.analysis, error: hot.analysisError };
}

function hotStatus() { return { ...hot, board: undefined, scanEveryHours: hotHours(), aiOn: !!process.env.ANTHROPIC_API_KEY, budget: require('./aibudget').budgetStatus(), settings: getSettings() }; }
function hotHours() { const h = Number(process.env.HOT_SCAN_HOURS ?? 24); return isFinite(h) && h >= 0 ? h : 24; }

async function hotRequest({ area, force, feeds }) {
  const areaChanged = area && area !== hot.area;
  if ((force || areaChanged) && !hot.running) {
    if (!areaChanged && hot.lastMode === 'deep' && Date.now() - hot.at < HOT_MIN_FORCE_MS) return { ...hotStatus(), note: 'Deep-scanned less than an hour ago — showing that scan.' };
    await scanHot(area, { mode: 'deep' });
  } else if (feeds && Date.now() - (hot.feedAt || 0) > 30 * 60 * 1000) {
    await fetchFeeds().catch(e => console.error('feeds', e.message)); // free
  } else if (!hot.showhn.length) {
    try { hot.showhn = await showHn(); } catch (_) {}
  }
  return hotStatus();
}

async function writeUp(ids) { await scanHot(null, { mode: 'free', ids: Array.isArray(ids) ? ids.map(String).slice(0, 40) : null }); return hotStatus(); }

// Daily job. The feed pull is free and always runs; the paid steps run only if switched on.
function startHotScanner(hasKey) {
  const hours = hotHours();
  if (!hours) { console.log('Daily feed pull off (HOT_SCAN_HOURS=0)'); return; }
  const every = hours * 3600 * 1000;
  const setNext = () => { hot.nextAt = (hot.feedAt || Date.now()) + every; };
  const check = async () => {
    if (Date.now() - (hot.feedAt || 0) < every) return setNext();
    try { await fetchFeeds(); } catch (e) { console.error('feeds', e.message); }
    if (hasKey) {
      const st = getSettings();
      try {
        if (st.autoWriteup && hot.feed.some(f => !f.reviewed)) await scanHot(null, { mode: 'free', auto: true });
        if (st.autoLocalTop > 0) for (const it of hot.items.filter(i => i.local_checked === false).sort((a, b) => b.total - a.total).slice(0, st.autoLocalTop)) await checkLocal(it.name, { auto: true });
        if (st.autoAnalyzeDays > 0 && hot.items.length && (!hot.analysis || Date.now() - hot.analysis.at >= st.autoAnalyzeDays * 86400000)) await analyzeHot({ auto: true });
      } catch (e) { console.error('auto paid job stopped:', e.message); }
    }
    setNext();
  };
  setNext();
  setTimeout(check, 30000).unref();
  setInterval(check, 15 * 60 * 1000).unref();
}

module.exports = { discover, evaluate, signals, cleanNiche, extractJson, NICHE_SYSTEM_PROMPT, hotRequest, startHotScanner, scanHot, analyzeHot, checkLocal, writeUp, getSettings, setSettings, DEFAULT_AREA };

