// sources.js
//
// Extra job sources beyond Adzuna. Only documented, public, no-login APIs:
//   - The Muse public jobs API      https://www.themuse.com/developers/api/v2
//   - Greenhouse job board API      boards-api.greenhouse.io/v1/boards/{token}/jobs
//   - Lever postings API            api.lever.co/v0/postings/{site}
//   - Ashby job posting API         api.ashbyhq.com/posting-api/job-board/{name}
//   - SmartRecruiters postings API  api.smartrecruiters.com/v1/companies/{id}/postings
// LinkedIn and Indeed have no public job-search API, so they are not here.
//
// Every job is returned in the same shape server.js produces for Adzuna and
// assigned to one of the dashboard's lanes by its TITLE. Jobs that match no
// lane, or sit outside New England (remote-US is kept), are dropped.

const fetch = require('node-fetch');

const SOURCE_TTL_MS = 6 * 60 * 60 * 1000;      // same cadence as Adzuna
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;  // re-discover company boards daily
const MAX_AGE_DAYS = 60;                        // drop stale postings
const UA = { 'User-Agent': 'OpsBoard personal job dashboard (single user)' };

// ---------------------------------------------------------------------------
// Lane classification by title. Order matters: most specific lane first.
// ---------------------------------------------------------------------------
const LANE_RULES = [
  ['ophth', /\b(ophthalm\w*|optometr\w*|retina\w*|oct|eye ?care|optical coherence)\b/i],
  ['mdcs', /((medical device|biomed\w*|bmet|clinical engineer\w*|iomt|htm|healthcare technology)[\s\S]{0,40}(security|cyber\w*))|((security|cyber\w*)[\s\S]{0,40}(medical device|iomt|clinical|healthcare))/i],
  ['bmet', /\b(biomedical|bmet|clinical engineer\w*|htm technician|healthcare technology management|imaging (service|engineer|technician))\b/i],
  ['e911', /\b(911|ng911|e911|psap|emergency communications)\b/i],
  ['field', /\b(field (service|engineer|technician|support|application)|service engineer|installation (engineer|technician)|on-?site (technician|engineer|support))\b/i],
  ['cloudsec', /\b(cloud security|azure security|aws security|cloud (infrastructure|platform) security)\b/i],
  ['cyber', /\b(soc analyst|security (analyst|engineer|operations|specialist|administrator)|cyber ?security|vulnerability|incident response|threat (detection|analyst)|information security)\b/i],
  ['healthit', /\b(epic|ehr|emr|pacs|dicom|hl7|clinical (systems|informatics|application analyst)|healthcare it|health it|hospital it|informatics)\b/i],
  ['clinapp', /\b(clinical (application|applications) specialist|application(s)? specialist|clinical specialist|implementation (engineer|specialist)|deployment engineer|customer success engineer|solutions engineer)\b/i],
  ['netqeng', /\b(network (engineer|administrator|technician|specialist)|network infrastructure)\b/i],
  ['noc', /\b(noc|network operations|systems administrator|system administrator|sysadmin|it operations|infrastructure (engineer|technician|specialist))\b/i],
  ['desktop', /\b(desktop support|help ?desk|service desk|end.user (support|computing)|it support|technical support (specialist|engineer|technician|analyst)|it technician|deskside|field technician)\b/i],
];
function classifyLane(title) {
  const t = title || '';
  const hit = LANE_RULES.find(([, re]) => re.test(t));
  return hit ? hit[0] : null;
}

// ---------------------------------------------------------------------------
// Location: keep New England, plus US-remote. Drop everything else.
// ---------------------------------------------------------------------------
const NE_RE = /(,\s*(MA|NH|RI|CT|ME|VT)\b)|\b(massachusetts|new hampshire|rhode island|connecticut|maine|vermont|boston|cambridge|worcester|providence|hartford|new haven|manchester,? nh|portland,? me|burlington,? vt|new england|us northeast|north ?east)\b/i;
const REMOTE_RE = /\b(remote|flexible|anywhere|work from home|wfh)\b/i;
const NON_US_RE = /\b(india|israel|ireland|united kingdom|uk|london|canada|toronto|germany|france|netherlands|spain|poland|brazil|mexico|philippines|australia|singapore|japan|china|ecuador|argentina|colombia|bengaluru|bangalore|tel aviv|dublin|emea|apac|latam)\b/i;
function locationOk(loc) {
  const l = loc || '';
  if (NE_RE.test(l)) return true;
  if (REMOTE_RE.test(l) && !NON_US_RE.test(l)) return true;
  if (/\b(united states|usa|us|north america)\b/i.test(l) && !NON_US_RE.test(l) && !/,\s*[A-Z]{2}\b/.test(l)) return true; // "United States" nationwide
  return false;
}

function stripHtml(html) {
  return (html || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function tooOld(iso) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && (Date.now() - t) > MAX_AGE_DAYS * 86400000;
}
function shape({ id, title, company, location, created, url, text, source, contractType }) {
  const plain = stripHtml(text);
  return {
    id, title, company, location,
    salaryMin: null, salaryMax: null,
    created: created || null, url,
    description: plain.slice(0, 280),
    text: plain.slice(0, 1500),
    contractType: contractType || null,
    salaryPredicted: false,
    category: null,
    source,
  };
}

// One request at a time with a short gap — polite to every API.
let queueTail = Promise.resolve();
function queued(fn, gapMs = 150) {
  const run = queueTail.then(fn);
  queueTail = run.then(() => new Promise(r => setTimeout(r, gapMs)), () => new Promise(r => setTimeout(r, gapMs)));
  return run;
}
async function getJson(url) {
  return queued(async () => {
    const res = await fetch(url, { headers: UA, timeout: 15000 });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  });
}

// ---------------------------------------------------------------------------
// The Muse
// ---------------------------------------------------------------------------
const MUSE_LOCATIONS = ['Boston, MA', 'Cambridge, MA', 'Worcester, MA', 'Providence, RI', 'Hartford, CT', 'Manchester, NH', 'Portland, ME', 'Burlington, VT', 'Flexible / Remote'];
const MUSE_CATEGORIES = ['Computer and IT', 'Healthcare', 'Installation, Maintenance, and Repairs', 'Science and Engineering', 'Data and Analytics', 'IT'];
const MUSE_PAGES = 10; // 20 per page, newest first

async function fetchMuse() {
  const out = [];
  for (let page = 0; page < MUSE_PAGES; page++) {
    const u = new URL('https://www.themuse.com/api/public/jobs');
    u.searchParams.set('page', String(page));
    u.searchParams.set('descending', 'true');
    MUSE_LOCATIONS.forEach(l => u.searchParams.append('location', l));
    MUSE_CATEGORIES.forEach(c => u.searchParams.append('category', c));
    if (process.env.MUSE_API_KEY) u.searchParams.set('api_key', process.env.MUSE_API_KEY);
    const data = await getJson(u.toString());
    const results = data.results || [];
    results.forEach(j => {
      const loc = (j.locations || []).map(x => x.name).join('; ');
      if (tooOld(j.publication_date) || !locationOk(loc)) return;
      out.push(shape({
        id: `muse-${j.id}`, title: j.name, company: j.company && j.company.name, location: loc,
        created: j.publication_date, url: j.refs && j.refs.landing_page, text: j.contents, source: 'The Muse',
      }));
    });
    if (page + 1 >= (data.page_count || 0)) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Company boards (ATS)
// ---------------------------------------------------------------------------
const ATS = {
  greenhouse: {
    label: 'Greenhouse',
    url: slug => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
    parse: (data, company) => (data.jobs || []).map(j => shape({
      id: `gh-${j.id}`, title: j.title, company, location: j.location && j.location.name,
      created: j.updated_at, url: j.absolute_url, text: j.content, source: `${company} (Greenhouse)`,
    })),
    count: data => (data.jobs || []).length,
  },
  lever: {
    label: 'Lever',
    url: slug => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    parse: (data, company) => (Array.isArray(data) ? data : []).map(j => shape({
      id: `lv-${j.id}`, title: j.text, company, location: [j.categories && j.categories.location, j.workplaceType].filter(Boolean).join('; '),
      created: j.createdAt ? new Date(j.createdAt).toISOString() : null, url: j.hostedUrl, text: j.descriptionPlain || j.description,
      source: `${company} (Lever)`, contractType: j.categories && /contract/i.test(j.categories.commitment || '') ? 'contract' : null,
    })),
    count: data => (Array.isArray(data) ? data.length : 0),
  },
  ashby: {
    label: 'Ashby',
    url: slug => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
    parse: (data, company) => (data.jobs || []).map(j => shape({
      id: `ab-${j.id}`, title: j.title, company, location: [j.location, j.isRemote && !/remote/i.test(j.location || '') ? 'Remote' : ''].filter(Boolean).join('; '),
      created: j.publishedAt, url: j.jobUrl, text: j.descriptionPlain || j.descriptionHtml, source: `${company} (Ashby)`,
      contractType: /contract/i.test(j.employmentType || '') ? 'contract' : null,
    })),
    count: data => (data.jobs || []).length,
  },
  smartrecruiters: {
    label: 'SmartRecruiters',
    url: slug => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`,
    parse: (data, company, slug) => (data.content || []).map(j => shape({
      id: `sr-${j.id}`, title: j.name, company,
      location: j.location ? [j.location.city, j.location.region, j.location.remote ? 'Remote' : '', j.location.country && j.location.country.toUpperCase() !== 'US' ? j.location.country : ''].filter(Boolean).join(', ') : '',
      created: j.releasedDate, url: `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${j.id}`, text: '', source: `${company} (SmartRecruiters)`,
    })),
    count: data => data.totalFound || 0,
  },
};

// Boards confirmed by hand (Oct 15, 2026). Discovery adds more automatically.
const VERIFIED_BOARDS = [
  { company: 'Armis', ats: 'greenhouse', slug: 'armissecurity' },
  { company: 'Outset Medical', ats: 'greenhouse', slug: 'outsetmedical' },
];

// Companies to auto-discover: his target list plus New England employers in
// his niches. A company only appears once a real, non-empty board is found.
const DISCOVER_COMPANIES = [
  'Heidelberg Engineering', 'Optos', 'Topcon Healthcare', 'CodexIT', 'ERC Networks', 'DAS Health', 'CloudWave',
  'Claroty', 'Asimily', 'Ordr', 'Cynerio', 'Medcrypt', 'Field Nation', 'Global Network Systems', 'SymQuest',
  'Open Approach', 'InterMed Group', 'Agiliti', 'TRIMEDX', 'Imprivata', 'Rapid7', 'Butterfly Network', 'Insulet',
  'Ophthalmic Instrument Company', 'Lombart Instrument', 'IT Support RI', 'Greenway Health', 'Nuvolo', 'Censinet',
];
function slugCandidates(name) {
  const base = name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, '').trim();
  const words = base.split(/\s+/);
  const set = new Set([words.join(''), words.join('-'), words[0], words.join('') + 'inc', words.join('') + 'careers']);
  return [...set].filter(s => s.length >= 3);
}

async function probeBoard(ats, slug) {
  try {
    const data = await getJson(ATS[ats].url(slug));
    const n = ATS[ats].count(data);
    return { ok: true, n, sample: ATS[ats].parse(data, '?', slug).slice(0, 3).map(j => j.title) };
  } catch (e) {
    return { ok: false, status: e.status || null };
  }
}

// Try every candidate slug on every ATS; return boards that exist and have jobs.
async function discoverCompany(name) {
  const hits = [];
  for (const slug of slugCandidates(name)) {
    for (const ats of Object.keys(ATS)) {
      const r = await probeBoard(ats, slug);
      if (r.ok && r.n > 0) hits.push({ company: name, ats, slug, n: r.n, sample: r.sample });
    }
    if (hits.length) break; // first slug that works is the company's board
  }
  return hits;
}

const state = {
  muse: { fetchedAt: 0, jobs: [], error: null },
  boards: { fetchedAt: 0, jobs: [], perBoard: [], error: null },
  discovery: { ranAt: 0, running: false, found: [] },
};

async function runDiscovery() {
  if (state.discovery.running) return;
  state.discovery.running = true;
  const found = [];
  for (const name of DISCOVER_COMPANIES) {
    if (VERIFIED_BOARDS.some(b => b.company.toLowerCase() === name.toLowerCase())) continue;
    try { found.push(...await discoverCompany(name)); } catch (e) { /* keep going */ }
  }
  state.discovery = { ranAt: Date.now(), running: false, found };
  state.boards.fetchedAt = 0; // pick up new boards on next request
}

function activeBoards() {
  const seen = new Set();
  return [...VERIFIED_BOARDS, ...state.discovery.found].filter(b => {
    const k = `${b.ats}:${b.slug}`; if (seen.has(k)) return false; seen.add(k); return true;
  });
}

async function fetchBoards(boards) {
  const jobs = [], perBoard = [];
  for (const b of boards) {
    if (!ATS[b.ats]) continue;
    try {
      const data = await getJson(ATS[b.ats].url(b.slug));
      const all = ATS[b.ats].parse(data, b.company, b.slug);
      const kept = all.filter(j => !tooOld(j.created) && locationOk(j.location));
      jobs.push(...kept);
      perBoard.push({ ...b, total: all.length, kept: kept.length });
    } catch (e) {
      perBoard.push({ ...b, error: e.message });
    }
  }
  return { jobs, perBoard };
}

// Group jobs into the dashboard's lanes by title.
function byLane(jobs) {
  const lanes = {};
  let unmatched = 0;
  jobs.forEach(j => {
    const lane = classifyLane(j.title);
    if (!lane) { unmatched++; return; }
    (lanes[lane] = lanes[lane] || []).push(j);
  });
  return { lanes, unmatched };
}

async function getExtraSources(forceRefresh = false) {
  const now = Date.now();
  if (!state.discovery.ranAt || now - state.discovery.ranAt > DISCOVERY_TTL_MS) runDiscovery(); // background
  if (forceRefresh || now - state.muse.fetchedAt > SOURCE_TTL_MS) {
    try { state.muse = { fetchedAt: now, jobs: await fetchMuse(), error: null }; }
    catch (e) { state.muse = { ...state.muse, fetchedAt: now, error: e.message }; }
  }
  if (forceRefresh || now - state.boards.fetchedAt > SOURCE_TTL_MS) {
    try { const r = await fetchBoards(activeBoards()); state.boards = { fetchedAt: now, ...r, error: null }; }
    catch (e) { state.boards = { ...state.boards, fetchedAt: now, error: e.message }; }
  }
  return byLane([...state.muse.jobs, ...state.boards.jobs]);
}

function sourcesStatus() {
  const muse = byLane(state.muse.jobs);
  return {
    muse: { fetchedAt: state.muse.fetchedAt || null, error: state.muse.error, total: state.muse.jobs.length, unmatched: muse.unmatched },
    boards: state.boards.perBoard,
    discovery: { ranAt: state.discovery.ranAt || null, running: state.discovery.running, checked: DISCOVER_COMPANIES.length, found: state.discovery.found },
    verified: VERIFIED_BOARDS,
  };
}

module.exports = { getExtraSources, sourcesStatus, discoverCompany, fetchBoards, byLane, ATS, classifyLane, locationOk };
