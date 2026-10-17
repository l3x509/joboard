// job-board-api/server.js
//
// Small backend for the personal job search dashboard.
// Fetches postings from the Adzuna Jobs API (legitimate, ToS-compliant
// job aggregator with a free tier) and caches results in memory so the
// dashboard gets instant responses without hammering Adzuna's rate limit.
//
// Env vars required (set these in Railway's dashboard, never commit them):
//   ADZUNA_APP_ID   - from https://developer.adzuna.com/
//   ADZUNA_APP_KEY  - from https://developer.adzuna.com/
//   PORT            - Railway sets this automatically, no action needed
//   ALLOWED_ORIGIN  - optional, restrict CORS to your dashboard's origin
//                      (leave unset to allow any origin, fine for personal use)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const sources = require('./sources');
const niche = require('./niche'); // Business Niche finder (Scout research + HN/Reddit/YouTube signals) // The Muse + company job boards (Greenhouse/Lever/Ashby/SmartRecruiters)

const app = express();
const PORT = process.env.PORT || 3000;
const APP_ID = process.env.ADZUNA_APP_ID;
const APP_KEY = process.env.ADZUNA_APP_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// Serve the dashboard directly from the repo root — matches this repo's
// flat file layout (index.html sits alongside server.js, no /public subfolder).
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---- Lane definitions: edit these anytime to tune your search terms ----
const LANES = {
  noc: {
    label: 'NOC / IT Support',
    what: ['NOC engineer', 'network operations'],
    where: 'Boston MA',
  },
  field: {
    label: 'Field Service Engineer',
    what: ['field service engineer medical device'],
    where: 'Massachusetts',
  },
  cyber: {
    label: 'Cybersecurity / SOC Analyst',
    what: ['SOC analyst', 'cybersecurity analyst'],
    where: 'Boston MA',
  },
  e911: {
    label: 'E911 / NG911',
    what: ['E911 engineer', 'NG911'],
    where: 'Massachusetts',
  },
  desktop: {
    label: 'Desktop Support',
    what: ['desktop support', 'end user support specialist'],
    where: 'Boston MA',
  },
  mdcs: {
    label: 'Medical Device Cybersecurity / HTM',
    what: ['medical device cybersecurity', 'BMET cybersecurity', 'healthcare technology management security'],
    where: 'Massachusetts',
  },
  bmet: {
    label: 'BMET / Clinical Engineering',
    what: ['biomedical equipment technician', 'BMET', 'clinical engineer'],
    where: 'Massachusetts',
  },
  healthit: {
    label: 'Healthcare IT / Epic Systems Analyst',
    what: ['Epic analyst', 'healthcare IT analyst', 'clinical systems analyst'],
    where: 'Massachusetts',
  },
  cloudsec: {
    label: 'Cloud Security Engineer',
    what: ['cloud security engineer', 'Azure security engineer'],
    where: 'Boston MA',
  },
  clinapp: {
    label: 'Clinical Applications / Medical Device Specialist',
    what: ['clinical applications specialist', 'medical device clinical specialist'],
    where: 'Massachusetts',
  },
  netqeng: {
    label: 'Network Engineer',
    what: ['network engineer'],
    where: 'Massachusetts',
  },
  ophth: {
    label: 'Ophthalmic / Eye-Care Device & IT',
    what: ['ophthalmic field service', 'ophthalmic service technician', 'eye care IT support'],
    where: 'Massachusetts',
  },
  // Note: UN/NGO roles deliberately not included here — Adzuna's /us/ endpoint
  // won't surface the field-based international postings that dominate that
  // lane, so it stays link-only in the dashboard (see snapshot-note there).
};

const LANE_CAP = 60; // was 20 — relevant postings past #20 were silently dropped
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — keeps Adzuna calls low on the free tier

// Lane cache, saved to DATA_DIR so redeploys don't burn Adzuna calls re-fetching everything.
const fsx = require('fs'), pathx = require('path'), osx = require('os');
const LANE_CACHE_FILE = pathx.join(process.env.DATA_DIR || osx.tmpdir(), 'opsboard-adzuna-cache.json');
const cache = (() => { try { return JSON.parse(fsx.readFileSync(LANE_CACHE_FILE, 'utf8')); } catch (_) { return {}; } })();
const laneFailures = {};
function saveLaneCache() { try { fsx.writeFileSync(LANE_CACHE_FILE, JSON.stringify(cache)); } catch (e) { console.error('lane cache save', e.message); } }

// Search area: a radius around Boston instead of one state, so southern NH, RI and
// central MA postings come in with the SAME number of calls. ADZUNA_AREA_MODE=state
// switches back to each lane's own state search.
const ADZUNA_AREA = process.env.ADZUNA_AREA || 'Boston, MA';
const ADZUNA_RADIUS_KM = Number(process.env.ADZUNA_RADIUS_KM || 120); // ~75 miles: Londonderry NH, Providence RI, Worcester
const AREA_MODE = process.env.ADZUNA_AREA_MODE === 'state' ? 'state' : 'radius';

// Adzuna's free tier: 25/min, 250/day, 1,000/week, 2,500/month. Count every call and stop
// before the limits; the board then serves the last saved results instead of erroring.
const ADZUNA_USAGE_FILE = pathx.join(process.env.DATA_DIR || osx.tmpdir(), 'opsboard-adzuna-usage.json');
const ADZUNA_LIMITS = { day: Number(process.env.ADZUNA_DAILY_LIMIT || 230), week: Number(process.env.ADZUNA_WEEKLY_LIMIT || 950), month: Number(process.env.ADZUNA_MONTHLY_LIMIT || 2400) };
let adzunaUsage = (() => { try { return JSON.parse(fsx.readFileSync(ADZUNA_USAGE_FILE, 'utf8')); } catch (_) { return { calls: [] }; } })();
function adzunaCounts() {
  const now = Date.now();
  adzunaUsage.calls = (adzunaUsage.calls || []).filter(t => now - t < 31 * 86400000);
  const month = new Date().toISOString().slice(0, 7);
  return { day: adzunaUsage.calls.filter(t => now - t < 86400000).length, week: adzunaUsage.calls.filter(t => now - t < 7 * 86400000).length,
    month: adzunaUsage.calls.filter(t => new Date(t).toISOString().slice(0, 7) === month).length };
}
function adzunaBudgetLeft(n) { const c = adzunaCounts(); return c.day + n <= ADZUNA_LIMITS.day && c.week + n <= ADZUNA_LIMITS.week && c.month + n <= ADZUNA_LIMITS.month; }
function recordAdzunaCall() { adzunaUsage.calls.push(Date.now()); try { fsx.writeFileSync(ADZUNA_USAGE_FILE, JSON.stringify(adzunaUsage)); } catch (_) {} }

// All Adzuna calls across the whole app funnel through this single queue,
// one request at a time with a short gap between them. Without this, firing
// 11 lanes at once (via /api/jobs/all) — each now making 1-3 requests since
// the OR-phrase split — bursts 20+ simultaneous requests and trips Adzuna's
// rate limit (429). This trades a little speed for actually working.
let adzunaQueueTail = Promise.resolve();
const ADZUNA_REQUEST_GAP_MS = 300;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function queueAdzunaCall(fn) {
  const runNow = adzunaQueueTail.then(() => fn());
  adzunaQueueTail = runNow.then(() => sleep(ADZUNA_REQUEST_GAP_MS), () => sleep(ADZUNA_REQUEST_GAP_MS));
  return runNow;
}

async function fetchOnePhrase(phrase, where) {
  if (!adzunaBudgetLeft(1)) throw new Error('Adzuna free-tier limit reached for now — showing your last saved results');
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/us/search/1`);
  url.searchParams.set('app_id', APP_ID);
  url.searchParams.set('app_key', APP_KEY);
  url.searchParams.set('what', phrase);
  if (AREA_MODE === 'radius') { url.searchParams.set('where', ADZUNA_AREA); url.searchParams.set('distance', String(ADZUNA_RADIUS_KM)); }
  else url.searchParams.set('where', where);
  url.searchParams.set('results_per_page', '50'); // Adzuna max per request — same API cost as 20
  url.searchParams.set('sort_by', 'date');
  url.searchParams.set('content-type', 'application/json');

  return queueAdzunaCall(async () => {
    recordAdzunaCall();
    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Adzuna API error ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    return (data.results || []).map(j => ({
      id: j.id,
      title: j.title,
      company: j.company && j.company.display_name,
      location: j.location && j.location.display_name,
      salaryMin: j.salary_min || null,
      salaryMax: j.salary_max || null,
      created: j.created,
      url: j.redirect_url,
      description: (j.description || '').slice(0, 280),
      // Fuller text for skill-cluster tagging and credential/barrier stats on
      // the Niche Intel view (the card still shows the short description).
      text: (j.description || '').slice(0, 1500),
      contractType: j.contract_type || null,   // 'permanent' | 'contract' | null
      contractTime: j.contract_time || null,   // 'full_time' | 'part_time' | null
      salaryPredicted: String(j.salary_is_predicted) === '1', // Adzuna estimate, not employer-posted
      category: (j.category && j.category.label) || null,
      source: 'Adzuna',
    }));
  });
}

// Adzuna's `what` param does a plain keyword/phrase match — it has no
// boolean OR support, so a lane with multiple alternative search phrases
// (e.g. "NOC engineer" vs "network operations") needs one real request per
// phrase. Results are merged and deduped by posting id, then capped at LANE_CAP.
async function fetchLaneFromAdzuna(laneKey) {
  const lane = LANES[laneKey];
  if (!lane) throw new Error(`Unknown lane: ${laneKey}`);
  if (!APP_ID || !APP_KEY) {
    throw new Error('ADZUNA_APP_ID / ADZUNA_APP_KEY not set in environment variables');
  }

  const phrases = Array.isArray(lane.what) ? lane.what : [lane.what];
  const results = await Promise.all(phrases.map(p => fetchOnePhrase(p, lane.where)));

  const seen = new Set();
  const merged = [];
  for (const jobs of results) {
    for (const job of jobs) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      merged.push(job);
    }
  }
  merged.sort((a, b) => new Date(b.created) - new Date(a.created));
  return merged.slice(0, LANE_CAP);
}

async function getLane(laneKey, forceRefresh = false) {
  const now = Date.now();
  const cached = cache[laneKey];
  if (!forceRefresh && cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
    return { ...cached, fromCache: true };
  }
  const phrases = Array.isArray(LANES[laneKey].what) ? LANES[laneKey].what.length : 1;
  const fail = laneFailures[laneKey];
  if (!forceRefresh && fail && now - fail.at < 30 * 60 * 1000) { // failed recently: don't spend calls retrying on every page load
    if (cached) return { ...cached, fromCache: true, note: fail.msg };
    throw new Error(fail.msg);
  }
  if (cached && !adzunaBudgetLeft(phrases)) return { ...cached, fromCache: true, note: 'Adzuna free-tier limit near — showing saved results' };
  try {
    const jobs = await fetchLaneFromAdzuna(laneKey);
    const entry = { fetchedAt: now, jobs, area: AREA_MODE === 'radius' ? `${ADZUNA_AREA} + ${ADZUNA_RADIUS_KM} km` : LANES[laneKey].where };
    cache[laneKey] = entry; saveLaneCache(); delete laneFailures[laneKey];
    return { ...entry, fromCache: false };
  } catch (e) {
    laneFailures[laneKey] = { at: now, msg: e.message };
    if (cached) return { ...cached, fromCache: true, note: e.message }; // keep showing the last good results
    throw e;
  }
}

// ---- Routes ----

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', lanes: Object.keys(LANES), message: 'Job board API is running.' });
});

// Single lane: /api/jobs?lane=noc
app.get('/api/jobs', async (req, res) => {
  const laneKey = req.query.lane;
  if (!laneKey || !LANES[laneKey]) {
    return res.status(400).json({ error: `Missing or invalid lane. Valid lanes: ${Object.keys(LANES).join(', ')}` });
  }
  try {
    const forceRefresh = req.query.refresh === 'true';
    const result = await getLane(laneKey, forceRefresh);
    res.json({ lane: laneKey, label: LANES[laneKey].label, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// All lanes at once: /api/jobs/all
app.get('/api/jobs/all', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const laneKeys = Object.keys(LANES);
    const results = await Promise.all(
      laneKeys.map(async (key) => {
        try {
          const result = await getLane(key, forceRefresh);
          return [key, { label: LANES[key].label, ...result }];
        } catch (err) {
          return [key, { label: LANES[key].label, error: err.message, jobs: [] }];
        }
      })
    );
    const out = Object.fromEntries(results);
    // Merge The Muse + company boards into the same lanes. A failure here
    // never breaks the Adzuna results.
    try {
      const extra = await sources.getExtraSources(forceRefresh);
      Object.entries(extra.lanes).forEach(([lane, jobs]) => {
        if (!out[lane]) return; // client-only lanes (e.g. UN/NGO) have no server key
        const ids = new Set((out[lane].jobs || []).map(j => j.id));
        const add = jobs.filter(j => !ids.has(j.id));
        out[lane] = { ...out[lane], jobs: [...(out[lane].jobs || []), ...add], extraCount: add.length };
      });
    } catch (e) {
      console.error('Extra sources failed:', e.message);
    }
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// What each extra source returned, which company boards were found, errors.
app.get('/api/sources/status', (req, res) => res.json({ ...sources.sourcesStatus(), adzuna: { usage: adzunaCounts(), limits: ADZUNA_LIMITS, area: AREA_MODE === 'radius' ? `${ADZUNA_AREA} + ${ADZUNA_RADIUS_KM} km` : 'each lane\'s state', cacheHours: CACHE_TTL_MS / 3600000 } }));
// Target Companies: all postings from company boards + The Muse, for matching to his 25 targets (free)
app.get('/api/targets/jobs', async (req, res) => {
  try { res.json(await sources.targetJobs()); } catch (e) { res.status(502).json({ error: e.message }); }
});

// Find a company's public job board: /api/ats/discover?name=Outset Medical
app.get('/api/ats/discover', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'name required' });
  try { res.json({ name, hits: await sources.discoverCompany(name) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Fetch boards the user added in the dashboard: { boards: [{company, ats, slug}] }
app.post('/api/ats/jobs', async (req, res) => {
  const boards = (Array.isArray(req.body.boards) ? req.body.boards : [])
    .filter(b => b && sources.ATS[b.ats] && /^[\w.-]{2,80}$/.test(b.slug || '')).slice(0, 25);
  try {
    const { jobs, perBoard } = await sources.fetchBoards(boards);
    const { lanes, unmatched } = sources.byLane(jobs);
    res.json({ lanes, perBoard, unmatched });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Scout — a single endpoint that handles both freeform career-advice chat
// AND structured postings search, sharing one background prompt so there's
// no duplicate system prompt (and no duplicate API surface) to maintain.
// Costs a small amount per call (web search + generation) — the real, paid
// Anthropic API, unlike Adzuna's free tier. Postings search results are
// cached for 12 hours so repeat clicks (or accidental double-clicks) don't
// re-trigger a paid search each time.
const LANE_ID_LIST = 'noc, field, cyber, e911, desktop, ngo, mdcs, bmet, healthit, cloudsec, clinapp, netqeng, ophth';

const SCOUT_SYSTEM_PROMPT = `You are "Scout," a career-niche advisor for Dulex Cherenfant, a Boston-area IT/field-service professional, embedded in his personal job search dashboard.

BACKGROUND (ground every answer in this — never generic advice):
- 15+ years IT: NOC Engineer at Comtech (8 yrs, NG911/VoIP mission-critical infrastructure for Massachusetts, SolarWinds, 99%+ SLA), Security Analyst at BCS 365 (Microsoft Sentinel, CrowdStrike Falcon, Qualys — vulnerability analysis, incident investigation), TechOps Engineer at VMware (datacenter/R&D infra), currently Field Service Engineer (contract via Resourceful Inc.) servicing Zeiss CIRRUS OCT/HFA diagnostic instruments under FDA-regulated change-control procedures across New England.
- Zeiss specifics: Windows 10→11 upgrades on FDA-regulated CIRRUS OCT and HFA instruments across MA, CT, VT, NH, RI, ME; pre-upgrade backup to network storage or external disk, post-upgrade restore and verification; pre/post checks including DICOM/PACS connectivity and network segmentation; work scheduled around clinic hours; photo-verified audit trail per device. This contract is ending soon — replacing that income is the priority.
- Other skills: Active Directory lifecycle and MFA, AD domain migration, Windows Server/M365, Windows 95-11, macOS, PowerShell (desktop support roles), WDS/MDT/CloneZilla/Ghost imaging, XP→Win7 migration planning, GroupWise→Outlook migration, Cisco CUCM phone provisioning, Linux daily (RHEL/CentOS/Ubuntu/Kali), VMware ESXi/vSphere, Azure VM right-sizing, AWS and Google Cloud (hands-on, personal lab), Node.js apps on Railway/Supabase, Cisco IOS/OSPF/BGP, Extreme OS, Fortinet firewalls, Trend Micro, Barracuda, Nessus, Symantec Endpoint Encryption, ticketing in ServiceNow/Remedy/BMC Footprints/Track-IT/Autotask, OMON and Motorola CallWorks for 911 call data, datacenter racking/cabling, vendor selection, mentoring junior staff, security incident documentation for audits. Earlier roles: Bed Bath & Beyond, Rue La La, Harvard School of Public Health, US DOT (desktop/help desk).
- Confirmed gaps (never claim these): Python scripting, wireless/WLAN deployment, formal team management, bachelor's degree. Spanish is basic understanding only.
- Target companies already on his list (don't re-suggest as new): Ophthalmic Instrument Co. (Avon MA), Heidelberg Engineering (Franklin MA), Optos (Marlborough MA), Topcon Healthcare, CodexIT, ERC Networks (warm contact), Sodexo HTM, DAS Health, IT Support RI, Lombart Instrument, CloudWave, Mass General Brigham, Boston Medical Center, Claroty/Asimily/Armis/Ordr, IQVIA MedTech, Field Nation.
- Certifications (previously held/lapsed): CompTIA Security+, Network+, A+, Cisco CCNA, Microsoft Azure Fundamentals, AZ-500/Azure Security Engineer Associate (Entra ID, RBAC, PIM, Conditional Access, Key Vault, Defender for Cloud, Sentinel/KQL). Currently studying CySA+.
- No bachelor's degree — two years of general college coursework plus an in-person IT program, no degree conferred.
- Languages: English and French fluent, Haitian Creole; basic Spanish. Based in Randolph, MA.
- Also a solo software founder running several live products for the Haitian diaspora, with a large Facebook audience across Boston/Miami/NYC/Montreal/Haiti. Prefers async/inbound work over outbound or in-person sales.
- Target: $80K+ where the lane supports it, Massachusetts/New England, on-site or hybrid.

THE DASHBOARD'S 13 LANES (use these exact laneId values when returning postings, nothing else — don't re-suggest these as "new" niches, build on them or go genuinely further): ${LANE_ID_LIST}

You operate in two modes depending on what's asked:
1. CONVERSATIONAL — answer questions about fit, demand, strategy, or new niche combinations. Use web search for anything checkable (demand, employers, current postings) rather than guessing. Keep answers tight: 2-4 short paragraphs or a short list, ending with one concrete next action. No filler, no "as an AI" disclaimers, no restating his bio back to him.
2. POSTINGS SEARCH — when explicitly asked to find/return current postings as JSON, search the web for 10 to 15 REAL, CURRENTLY OPEN postings spread across as many of the 13 lanes above as you can find real openings for — aim for breadth across lanes, not just depth in one or two. Only include a posting if you found a real URL via search — never invent one. Respond with ONLY a raw JSON array in that case, no markdown fences, no other text. Schema per item: {"laneId": "...", "laneTitle": "2-4 word label", "title": "...", "company": "...", "meta": "salary/work-arrangement, a few words", "url": "...", "desc": "1-2 sentences, second person, specific to his background", "postedDate": "Mon DD, YYYY — today"}`;

let cachedPostings = null; // { items, refreshedAt } — in-memory, cleared on server restart
const POSTINGS_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

async function callScout(messages, maxTokens, maxSearches, system = SCOUT_SYSTEM_PROMPT) {
  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens,
      // Prompt caching: the long Scout instructions + the conversation so far are reused
      // across back-to-back chat messages at 10% of the input price.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: messages.map((m, i) => i === messages.length - 1 && typeof m.content === 'string'
        ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] } : m),
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
    }),
  });
  if (!apiRes.ok) {
    const text = await apiRes.text().catch(() => '');
    throw new Error(`Anthropic API error ${apiRes.status}: ${text.slice(0, 300)}`);
  }
  const data = await apiRes.json();
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  return textBlocks.join('\n\n').trim();
}

// mode: 'chat' (default) — { messages: [...] } -> { reply }
// mode: 'postings' — no body needed -> { items, refreshedAt, fromCache }
app.post('/api/scout', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on the server — add it in Railway → Variables.' });
  }
  const mode = req.body.mode === 'postings' ? 'postings' : 'chat';

  try {
    if (mode === 'postings') {
      const forceRefresh = req.body.forceRefresh === true;
      const now = Date.now();
      if (!forceRefresh && cachedPostings && (now - cachedPostings.fetchedAt) < POSTINGS_CACHE_TTL_MS) {
        return res.json({ items: cachedPostings.items, refreshedAt: cachedPostings.refreshedAt, fromCache: true });
      }

      const raw = await callScout([{ role: 'user', content: 'Find current real postings now (POSTINGS SEARCH mode) and return the JSON array.' }], 3000, 12);
      const cleanedRaw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
      const jsonStart = cleanedRaw.indexOf('[');
      const jsonEnd = cleanedRaw.lastIndexOf(']');
      if (jsonStart === -1 || jsonEnd === -1) throw new Error('Model did not return a JSON array');
      const parsed = JSON.parse(cleanedRaw.slice(jsonStart, jsonEnd + 1));

      const validLanes = LANE_ID_LIST.split(', ');
      const cleaned = parsed.filter(p => p && p.url && p.title && validLanes.includes(p.laneId));
      if (!cleaned.length) throw new Error('No valid postings came back from the search');

      const refreshedAt = new Date().toISOString();
      cachedPostings = { items: cleaned, refreshedAt, fetchedAt: now };
      return res.json({ items: cleaned, refreshedAt, fromCache: false });
    }

    // chat mode
    const messages = Array.isArray(req.body.messages) ? req.body.messages : null;
    if (!messages || !messages.length) {
      return res.status(400).json({ error: 'messages array required' });
    }
    const reply = await callScout(messages.map(m => ({ role: m.role, content: m.content })), 800, 6)
      || "Couldn't generate a response — try rephrasing.";
    res.json({ reply });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ===== Business Niches =====
// Scout research costs a few cents per run (web search + generation); cached 12h per focus.
// All business AI calls run on Haiku 5.5 through aibudget.js (monthly cap, default $1).
const aibudget = require('./aibudget');
const bizErr = (res, e) => res.status(e.budget ? 402 : 502).json({ error: e.message, budget: aibudget.budgetStatus() });
app.get('/api/niche/budget', (req, res) => res.json(aibudget.budgetStatus()));
app.post('/api/niche/discover', async (req, res) => {
  try { res.json(await niche.discover(null, String(req.body.focus || '').slice(0, 120), req.body.forceRefresh === true)); }
  catch (e) { bizErr(res, e); }
});
app.post('/api/niche/evaluate', async (req, res) => {
  try { const item = await niche.evaluate(null, req.body.idea || {}, { force: req.body.force === true }); res.json({ item, fromCache: !!item.fromCache }); }
  catch (e) { bizErr(res, e); }
});
// Free live signals: Hacker News always; Reddit / YouTube only when their keys are set.
app.get('/api/niche/signals', async (req, res) => {
  try { res.json(await niche.signals(String(req.query.q || '').slice(0, 80), req.query.refresh === 'true')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Hot ideas to replicate locally: auto-scanned daily (HOT_SCAN_HOURS, 0 = off), plus Show HN launches.
app.get('/api/niche/hot', async (req, res) => {
  try { res.json(await niche.hotRequest({ area: String(req.query.area || '').slice(0, 160), force: req.query.refresh === 'true', feeds: req.query.feeds === 'true' })); }
  catch (e) { bizErr(res, e); }
});
// Pattern analysis over all hot finds (clusters, blind angles, gaps). Body: { board: [{name,pitch,status}], force }
app.post('/api/niche/hot/analyze', async (req, res) => {
  try { res.json({ ...(await niche.analyzeHot({ force: req.body.force === true, board: req.body.board })), budget: aibudget.budgetStatus() }); }
  catch (e) { bizErr(res, e); }
});
// Write up feed items as hot finds (Haiku, no web search). Body: { ids?: [...] } — none = all new items
app.post('/api/niche/hot/writeup', async (req, res) => {
  try { res.json(await niche.writeUp(req.body.ids)); } catch (e) { bizErr(res, e); }
});
// Paid automatic jobs (all off by default)
app.get('/api/niche/settings', (req, res) => res.json(niche.getSettings()));
app.post('/api/niche/settings', (req, res) => res.json(niche.setSettings(req.body || {})));
// "Check my area" for one hot find (2 web searches)
app.post('/api/niche/hot/check', async (req, res) => {
  try { res.json({ item: await niche.checkLocal(String(req.body.name || '').slice(0, 120)), budget: aibudget.budgetStatus() }); }
  catch (e) { bizErr(res, e); }
});
niche.startHotScanner(!!ANTHROPIC_API_KEY);

app.listen(PORT, () => {
  console.log(`Job board API listening on port ${PORT}`);
});
