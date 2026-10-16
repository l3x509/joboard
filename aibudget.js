// aibudget.js
//
// Every Business-board AI call goes through here so it can't overspend.
//   - Model: Claude Haiku 5.5 by default (BIZ_MODEL to override).
//   - Web searches are the real cost ($0.01 each), so callers pass a small,
//     explicit number of searches — 0 for most automatic work.
//   - Spend is measured from the API's usage numbers and kept per calendar month.
//   - Hard cap: BIZ_MONTHLY_BUDGET (default $5.00). Paid automatic jobs are OFF by
//     default; if you switch any on, they may use only part of the cap
//     (BIZ_AUTO_SHARE, default 60%) so your own clicks always have room.
//   - The spend file lives in DATA_DIR (a Railway volume) so redeploys don't reset it.

const fs = require('fs');
const path = require('path');
const os = require('os');
const fetch = require('node-fetch');

const FILE = path.join(process.env.DATA_DIR || os.tmpdir(), 'opsboard-ai-spend.json');
const MODEL = process.env.BIZ_MODEL || 'claude-haiku-5-5';
const BUDGET = Math.max(0, Number(process.env.BIZ_MONTHLY_BUDGET ?? 5) || 0);
const AUTO_SHARE = Math.min(1, Math.max(0, Number(process.env.BIZ_AUTO_SHARE ?? 0.6)));
const SEARCH_COST = 0.01; // $10 per 1,000 web searches

// USD per million tokens. Haiku 5.5 is priced by prompt size (≤100k / >100k tokens).
const PRICES = {
  'claude-haiku-5-5': { in: [0.10, 0.50], out: [0.50, 2.50], tier: 100000 },
  'claude-haiku-4-5': { in: [1], out: [5] },
  'claude-sonnet-5': { in: [2], out: [10] },
  'claude-sonnet-5-5': { in: [2], out: [10] },
};

const monthKey = () => new Date().toISOString().slice(0, 7);
let state = { month: monthKey(), spent: 0, searches: 0, calls: [] };
try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (_) {}
function rollover() { if (state.month !== monthKey()) state = { month: monthKey(), spent: 0, searches: 0, calls: [] }; }
function save() { try { fs.writeFileSync(FILE, JSON.stringify(state)); } catch (e) { console.error('ai spend save', e.message); } }

function costOf(model, usage = {}) {
  const p = PRICES[model] || PRICES['claude-sonnet-5'];
  const inTok = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const t = p.tier && inTok > p.tier ? 1 : 0;
  const inP = p.in[t] ?? p.in[0], outP = p.out[t] ?? p.out[0];
  const tokens = ((usage.input_tokens || 0) * inP + (usage.cache_read_input_tokens || 0) * inP * 0.1 + (usage.cache_creation_input_tokens || 0) * inP * 1.25 + (usage.output_tokens || 0) * outP) / 1e6;
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  return { cost: tokens + searches * SEARCH_COST, searches };
}

class BudgetError extends Error { constructor(msg) { super(msg); this.budget = true; } }

// ask: user message text. searches: max web searches (0 = no web tool at all).
async function ai({ system, ask, maxTokens = 3000, searches = 0, auto = false, purpose = 'business' }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set on the server — add it in Railway → Variables.');
  rollover();
  const cap = auto ? BUDGET * AUTO_SHARE : BUDGET;
  const worst = searches * SEARCH_COST + 0.01; // searches + a generous token allowance
  if (state.spent + worst > cap) {
    throw new BudgetError(auto
      ? `Automatic ${purpose} skipped: automatic jobs have used $${state.spent.toFixed(2)} of their $${cap.toFixed(2)} monthly share.`
      : `Monthly AI budget reached ($${state.spent.toFixed(2)} of $${BUDGET.toFixed(2)}). Raise BIZ_MONTHLY_BUDGET in Railway or wait until ${nextMonthLabel()}.`);
  }
  // Prompt caching: the instructions are identical on every call, so mark them cacheable.
  // Back-to-back clicks within 5 minutes read them at 10% of the input price.
  const body = { model: MODEL, max_tokens: maxTokens, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: ask }] };
  if (searches > 0) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: searches }];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', timeout: 180000,
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Anthropic API error ${r.status}: ${t.slice(0, 300)}`); }
  const data = await r.json();
  const { cost, searches: used } = costOf(data.model || MODEL, data.usage);
  state.spent += cost; state.searches += used;
  state.calls.unshift({ at: new Date().toISOString(), purpose, auto, cost: Math.round(cost * 10000) / 10000, searches: used, in: (data.usage || {}).input_tokens || 0, out: (data.usage || {}).output_tokens || 0 });
  state.calls = state.calls.slice(0, 40);
  save();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n').trim();
}

function nextMonthLabel() { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1, 1); return d.toLocaleString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }); }

function budgetStatus() {
  rollover();
  return { month: state.month, spent: Math.round(state.spent * 10000) / 10000, budget: BUDGET, autoCap: Math.round(BUDGET * AUTO_SHARE * 100) / 100,
    searches: state.searches, model: MODEL, persistent: !!process.env.DATA_DIR, calls: state.calls.slice(0, 15) };
}

module.exports = { ai, budgetStatus, BudgetError, costOf, SEARCH_COST, MODEL };
