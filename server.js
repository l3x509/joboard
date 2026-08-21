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

const app = express();
const PORT = process.env.PORT || 3000;
const APP_ID = process.env.ADZUNA_APP_ID;
const APP_KEY = process.env.ADZUNA_APP_KEY;
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
    what: 'NOC engineer OR network operations',
    where: 'Boston MA',
  },
  field: {
    label: 'Field Service Engineer',
    what: 'field service engineer medical device',
    where: 'Massachusetts',
  },
  cyber: {
    label: 'Cybersecurity / SOC Analyst',
    what: 'SOC analyst OR cybersecurity analyst',
    where: 'Boston MA',
  },
  e911: {
    label: 'E911 / NG911',
    what: 'E911 engineer OR NG911',
    where: 'Massachusetts',
  },
  desktop: {
    label: 'Desktop Support',
    what: 'desktop support OR end user support specialist',
    where: 'Boston MA',
  },
  mdcs: {
    label: 'Medical Device Cybersecurity / HTM',
    what: 'medical device cybersecurity OR BMET cybersecurity OR healthcare technology management security',
    where: 'Massachusetts',
  },
  bmet: {
    label: 'BMET / Clinical Engineering',
    what: 'biomedical equipment technician OR BMET OR clinical engineer',
    where: 'Massachusetts',
  },
  healthit: {
    label: 'Healthcare IT / Epic Systems Analyst',
    what: 'Epic analyst OR healthcare IT analyst OR clinical systems analyst',
    where: 'Massachusetts',
  },
  cloudsec: {
    label: 'Cloud Security Engineer',
    what: 'cloud security engineer OR Azure security engineer',
    where: 'Boston MA',
  },
  clinapp: {
    label: 'Clinical Applications / Medical Device Specialist',
    what: 'clinical applications specialist OR medical device clinical specialist',
    where: 'Massachusetts',
  },
  netqeng: {
    label: 'Network Engineer',
    what: 'network engineer',
    where: 'Massachusetts',
  },
  // Note: UN/NGO roles deliberately not included here — Adzuna's /us/ endpoint
  // won't surface the field-based international postings that dominate that
  // lane, so it stays link-only in the dashboard (see snapshot-note there).
};

const SALARY_MIN = 80000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — keeps Adzuna calls low on the free tier

// In-memory cache: { [lane]: { fetchedAt, jobs: [...] } }
const cache = {};

async function fetchLaneFromAdzuna(laneKey) {
  const lane = LANES[laneKey];
  if (!lane) throw new Error(`Unknown lane: ${laneKey}`);
  if (!APP_ID || !APP_KEY) {
    throw new Error('ADZUNA_APP_ID / ADZUNA_APP_KEY not set in environment variables');
  }

  const url = new URL(`https://api.adzuna.com/v1/api/jobs/us/search/1`);
  url.searchParams.set('app_id', APP_ID);
  url.searchParams.set('app_key', APP_KEY);
  url.searchParams.set('what', lane.what);
  url.searchParams.set('where', lane.where);
  url.searchParams.set('salary_min', String(SALARY_MIN));
  url.searchParams.set('results_per_page', '10');
  url.searchParams.set('sort_by', 'date');
  url.searchParams.set('content-type', 'application/json');

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Adzuna API error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();

  const jobs = (data.results || []).map(j => ({
    id: j.id,
    title: j.title,
    company: j.company && j.company.display_name,
    location: j.location && j.location.display_name,
    salaryMin: j.salary_min || null,
    salaryMax: j.salary_max || null,
    created: j.created,
    url: j.redirect_url,
    description: (j.description || '').slice(0, 280),
  }));

  return jobs;
}

async function getLane(laneKey, forceRefresh = false) {
  const now = Date.now();
  const cached = cache[laneKey];
  if (!forceRefresh && cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
    return { ...cached, fromCache: true };
  }
  const jobs = await fetchLaneFromAdzuna(laneKey);
  const entry = { fetchedAt: now, jobs };
  cache[laneKey] = entry;
  return { ...entry, fromCache: false };
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
    res.json(Object.fromEntries(results));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Job board API listening on port ${PORT}`);
});
