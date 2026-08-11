/* Aroma Armour Funnel Control — frontend */
"use strict";

/* ---------------- constants ---------------- */
const INK = "#23261f", EUCA = "#3e7c59", OXIDE = "#a63a2b", LINE = "#d8d4c8", MUTE = "#6b6a5f";
const JUNK = ["/apps/", "/password", "/cart", "/checkouts", "/orders", "/policies", "/account"];
const INFO_PAGES = new Set(["/pages/ingredients", "/pages/stockists", "/pages/contact", "/pages/our-mission"]);
const LEVER_CHIPS = ["Popup change", "Offer / pricing", "Page rebuild", "Ads budget", "Shipping / logistics"];

const S = { // app state
  start: null, end: null,     // ISO date strings for the selected range
  data: null,                 // normalized payload from /api/data
  markers: [],                // lever-pull markers (persisted server-side)
  bench: {},                  // manual benchmarks by page type (persisted server-side)
  sensPct: 0.05,              // slider value for the sensitivity overview
  expanded: {},               // rowKey -> {open, pp} for per-page point panels
  sortKey: "sessions", sortDir: -1, // Pages tab sorting
  charts: {},                 // live Chart.js instances by canvas id
};

/* ---------------- small utilities ---------------- */
const $ = (id) => document.getElementById(id);
const money0 = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n) => n == null || !isFinite(n) ? "–" : Math.round(n).toLocaleString();
const fmtPct = (n, dp = 1) => n == null || !isFinite(n) ? "–" : (n * 100).toFixed(dp) + "%";
const fmtM = (n, dp = 0) => n == null || !isFinite(n) ? "–" : (dp ? money2 : money0).format(n);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoStr, n) => { const d = new Date(isoStr + "T00:00:00"); d.setDate(d.getDate() + n); return iso(d); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const shortPath = (p) => p === "/" ? "/ (homepage)" : p.length > 52 ? p.slice(0, 50) + "…" : p;

function classify(path) {
  if (path === "/") return "Homepage";
  if (path.startsWith("/products/")) return "PDP";
  if (path.startsWith("/collections")) return "Collection";
  if (INFO_PAGES.has(path)) return "Info";
  return "Advertorial";
}

function colIdx(table) {
  const m = {}; table.columns.forEach((c, i) => (m[c] = i)); return m;
}


/* ---------------- Shopify transport (Direct API; replaces the local server) ----------------
   The app runs embedded in Shopify admin. App Bridge authenticates fetches to the
   shopify:admin protocol, so ShopifyQL queries and metafield persistence run entirely
   in the browser — no backend anywhere. API version pinned to 2025-10, the version
   the original server pulled with. */
const API_URL = "shopify:admin/api/2025-10/graphql.json";
const GQL_QL = "query($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name } rows } parseErrors } }";
const SHOW_COLS = "sessions, bounce_rate, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout";
const META_NS = "$app:funnel";
let _shopId = null;

async function gqlDirect(query, variables) {
  const res = await fetch(API_URL, { method: "POST", body: JSON.stringify({ query, variables }) });
  const j = await res.json();
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message || "GraphQL error");
  return j.data;
}

const canonCol = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

async function runShopifyQL(q, table, needed) {
  const data = await gqlDirect(GQL_QL, { q });
  const out = data && data.shopifyqlQuery;
  if (!out) throw new Error("shopifyqlQuery returned nothing — is the read_reports scope granted?");
  if (out.parseErrors && out.parseErrors.length) throw new Error("ShopifyQL: " + out.parseErrors.join("; "));
  if (!out.tableData || !out.tableData.columns) throw new Error(table + " query returned no tableData");
  const cols = out.tableData.columns.map((c) => canonCol(c.name));
  const missing = needed.filter((k) => !cols.includes(k));
  if (missing.length) throw new Error(`${table} query: missing column(s) ${missing.join(", ")} — API returned: ${cols.join(", ")}`);
  return { columns: cols, rows: out.tableData.rows || [] };
}

async function pullFunnelData(start, end) {
  const today = iso(new Date());
  if (end > today) end = today;
  const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  const priorStart = addDays(start, -days), priorEnd = addDays(start, -1);
  const FUNNEL = ["sessions", "bounce_rate", "sessions_with_cart_additions", "sessions_that_reached_checkout", "sessions_that_completed_checkout"];
  const [pages, referrers, daily, sales_daily] = await Promise.all([
    runShopifyQL(`FROM sessions SHOW ${SHOW_COLS} GROUP BY landing_page_path SINCE ${start} UNTIL ${end} ORDER BY sessions DESC LIMIT 25`,
      "pages", ["landing_page_path", ...FUNNEL]),
    runShopifyQL(`FROM sessions SHOW sessions GROUP BY landing_page_path, referrer_source SINCE ${start} UNTIL ${end} ORDER BY sessions DESC LIMIT 60`,
      "referrers", ["landing_page_path", "referrer_source", "sessions"]),
    runShopifyQL(`FROM sessions SHOW ${SHOW_COLS} TIMESERIES day SINCE ${priorStart} UNTIL ${end}`,
      "daily", ["day", ...FUNNEL]),
    runShopifyQL(`FROM sales SHOW orders, total_sales, net_sales TIMESERIES day SINCE ${priorStart} UNTIL ${end}`,
      "sales", ["day", "orders", "total_sales", "net_sales"]),
  ]);
  if (!daily.rows.length) throw new Error("Shopify returned zero daily rows for " + priorStart + " → " + end + " — check the date range and that the app's read_reports scope is granted on this store.");
  return {
    fetched_at: new Date().toISOString().slice(0, 16), mock: false,
    range: { start, end, days }, prior: { start: priorStart, end: priorEnd },
    pages, referrers, daily, sales_daily,
  };
}

async function shopId() {
  if (_shopId) return _shopId;
  const d = await gqlDirect("query { shop { id } }");
  _shopId = d.shop.id;
  return _shopId;
}

async function loadMeta() {
  const d = await gqlDirect(
    `query { shop { id
      markers: metafield(namespace: "${META_NS}", key: "markers") { value }
      bench: metafield(namespace: "${META_NS}", key: "benchmarks") { value } } }`);
  _shopId = d.shop.id;
  const parse = (m, fb) => { try { return m && m.value ? JSON.parse(m.value) : fb; } catch { return fb; } };
  return { markers: parse(d.shop.markers, []), bench: parse(d.shop.bench, {}) };
}

async function saveMeta(key, value) {
  const d = await gqlDirect(
    "mutation Save($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }",
    { m: [{ ownerId: await shopId(), namespace: META_NS, key, type: "json", value: JSON.stringify(value) }] });
  const errs = d.metafieldsSet.userErrors;
  if (errs && errs.length) throw new Error(errs.map((e) => e.message).join("; "));
}

/* ---------------- data fetch & normalisation ---------------- */
async function fetchData() {
  const btn = $("refresh");
  btn.disabled = true; btn.textContent = "Pulling from Shopify…";
  $("error").style.display = "none";
  try {
    const j = await pullFunnelData(S.start, S.end);
    S.data = normalize(j);
    renderAll();
  } catch (e) {
    $("error").textContent = "Data pull failed: " + e.message;
    $("error").style.display = "block";
  } finally {
    btn.disabled = false; btn.textContent = "Refresh data";
  }
}

function normalize(j) {
  const pi = colIdx(j.pages);
  const pages = j.pages.rows.map((r) => ({
    path: r[pi.landing_page_path],
    type: classify(r[pi.landing_page_path]),
    sessions: +r[pi.sessions], bounce: +r[pi.bounce_rate],
    carts: +r[pi.sessions_with_cart_additions],
    reached: +r[pi.sessions_that_reached_checkout],
    completed: +r[pi.sessions_that_completed_checkout],
  })).filter((p) => !JUNK.some((x) => p.path.startsWith(x)));

  const ri = colIdx(j.referrers);
  const refs = {};
  j.referrers.rows.forEach((r) => {
    const p = r[ri.landing_page_path], src = r[ri.referrer_source], v = +r[ri.sessions];
    (refs[p] = refs[p] || {})[src] = (refs[p][src] || 0) + v;
  });

  const di = colIdx(j.daily);
  const dailyAll = j.daily.rows.map((r) => ({
    day: r[di.day], sessions: +r[di.sessions], bounce: +r[di.bounce_rate],
    carts: +r[di.sessions_with_cart_additions],
    reached: +r[di.sessions_that_reached_checkout],
    completed: +r[di.sessions_that_completed_checkout],
  })).sort((a, b) => a.day.localeCompare(b.day));

  const si = colIdx(j.sales_daily);
  const salesAll = j.sales_daily.rows.map((r) => ({
    day: r[si.day], orders: +r[si.orders], total: +r[si.total_sales], net: +r[si.net_sales],
  })).sort((a, b) => a.day.localeCompare(b.day));

  const inCur = (d) => d.day >= j.range.start;
  return {
    fetchedAt: j.fetched_at, mock: !!j.mock, range: j.range, prior: j.prior,
    pages, refs,
    daily: dailyAll.filter(inCur), dailyPrior: dailyAll.filter((d) => !inCur(d)),
    sales: salesAll.filter(inCur), salesPrior: salesAll.filter((d) => !inCur(d)),
  };
}

/* ---------------- derived stats (memoised per data pull) ---------------- */
function aggregate(daily, sales) {
  const sum = (a, f) => a.reduce((x, r) => x + f(r), 0);
  const sessions = sum(daily, (r) => r.sessions);
  const bounced = sum(daily, (r) => r.sessions * r.bounce);
  const carts = sum(daily, (r) => r.carts), reached = sum(daily, (r) => r.reached), completed = sum(daily, (r) => r.completed);
  const orders = sum(sales, (r) => r.orders), total = sum(sales, (r) => r.total), net = sum(sales, (r) => r.net);
  return {
    sessions, carts, reached, completed, orders, total, net,
    bounce: sessions ? bounced / sessions : null,
    v2c: sessions ? carts / sessions : null,
    c2c: carts ? reached / carts : null,
    c2p: reached ? completed / reached : null,
    cr: sessions ? completed / sessions : null,
    aov: orders ? net / orders : null,
    days: daily.length,
  };
}

function pageMetrics(agg) {
  const aov = agg.aov || 0;
  return S.data.pages.map((p) => {
    const engaged = p.sessions * (1 - p.bounce);
    const r = S.data.refs[p.path] || {};
    const social = r.social || 0, direct = r.direct || 0, search = r.search || 0, email = r.email || 0;
    return {
      ...p, engaged,
      e2c: engaged > 0 ? p.carts / engaged : 0,
      cum: engaged > 0 ? p.completed / engaged : 0, // cumulative purchase rate = e2c × c2c × c2p
      p2c: p.sessions ? p.carts / p.sessions : 0,
      c2c: p.carts ? p.reached / p.carts : 0,
      c2p: p.reached ? p.completed / p.reached : 0,
      cr: p.sessions ? p.completed / p.sessions : 0,
      rev: p.completed * aov,
      social, direct, search, email,
      other: Math.max(0, p.sessions - social - direct - search - email),
    };
  });
}

// one computation of everything the render functions share, cached per data pull
const _statsCache = new WeakMap();
function stats() {
  if (!_statsCache.has(S.data)) {
    const cur = aggregate(S.data.daily, S.data.sales);
    const pri = aggregate(S.data.dailyPrior, S.data.salesPrior);
    const pm = pageMetrics(cur);
    _statsCache.set(S.data, { cur, pri, pm, eff: effectiveBench(pm), aov: cur.aov || 0 });
  }
  return _statsCache.get(S.data);
}
function invalidateStats() { if (S.data) _statsCache.delete(S.data); }

/* ---------------- benchmarks ---------------- */
function benchmarks(pm) { // pooled actuals per page type for the selected range
  const by = {};
  pm.forEach((p) => {
    const b = (by[p.type] = by[p.type] || { s: 0, e: 0, c: 0, r: 0, m: 0 });
    b.s += p.sessions; b.e += p.engaged; b.c += p.carts; b.r += p.reached; b.m += p.completed;
  });
  const out = {};
  Object.entries(by).forEach(([t, b]) => {
    out[t] = {
      bounce: b.s ? 1 - b.e / b.s : 0,
      p2c: b.s ? b.c / b.s : 0,
      c2c: b.c ? b.r / b.c : 0,
      c2p: b.r ? b.m / b.r : 0,
      cr: b.s ? b.m / b.s : 0,
    };
  });
  return out;
}

// External default benchmarks (researched Aug 2026; see Glossary for sources & evidence grades).
// Values adjusted for a ~90% mobile, paid-social-heavy DTC store. Collection: no research coverage -> pooled only.
const DEFAULT_BENCH = {
  PDP:         { bounce: 0.65, p2c: 0.07, c2c: 0.68, c2p: 0.55, cr: 0.025 },
  Advertorial: { bounce: 0.78, p2c: 0.05, c2c: 0.65, c2p: 0.50, cr: 0.025 },
  Homepage:    { bounce: 0.55, p2c: 0.05, c2c: 0.70, c2p: 0.55, cr: 0.020 },
  Info:        { bounce: 0.75, p2c: 0.02, c2c: 0.65, c2p: 0.50, cr: 0.008 },
};

function effectiveBench(pm) { // hierarchy: manual override > external default > pooled actual
  const comp = benchmarks(pm);
  const out = {};
  Object.keys(comp).forEach((t) => {
    out[t] = { ...comp[t], ...(DEFAULT_BENCH[t] || {}) };
    const man = S.bench[t] || {};
    ["bounce", "p2c", "c2c", "c2p", "cr"].forEach((k) => {
      if (man[k] != null && isFinite(man[k])) out[t][k] = man[k];
    });
  });
  return out;
}

// lever -> benchmark for a page type (li: 1 bounce, 2 e2c, 3 c2c, 4 c2p)
function leverBench(eff, type, li) {
  const b = eff[type];
  if (!b) return null;
  if (li === 1) return { v: b.bounce, higherBetter: false, f: (v) => fmtPct(v, 1) };
  if (li === 2) {
    if (b.bounce == null || b.bounce >= 1 || b.p2c == null) return null;
    return { v: b.p2c / (1 - b.bounce), higherBetter: true, f: (v) => fmtPct(v, 2) }; // e2c_b = p2c_b ÷ (1−bounce_b)
  }
  if (li === 3) return { v: b.c2c, higherBetter: true, f: (v) => fmtPct(v, 1) };
  return { v: b.c2p, higherBetter: true, f: (v) => fmtPct(v, 1) };
}

function cumBench(eff, type) { // cum_b = e2c_b × c2c_b × c2p_b
  const e = leverBench(eff, type, 2), c = leverBench(eff, type, 3), p = leverBench(eff, type, 4);
  if (!e || !c || !p || [e.v, c.v, p.v].some((v) => v == null || !isFinite(v))) return null;
  return e.v * c.v * p.v;
}

function uplifts(pm, agg) { // Page→Cart uplift to benchmark, $/month
  const bench = stats().eff, aov = agg.aov || 0, days = agg.days || 1;
  return pm.map((p) => {
    const b = bench[p.type] || { p2c: 0, c2c: 0, c2p: 0 };
    const gap = Math.max(0, b.p2c - p.p2c);
    return { ...p, uplift: gap * p.sessions * b.c2c * b.c2p * aov * (30 / days) };
  });
}

/* ---------------- revenue unlocks ---------------- */
// One row per page x lever with an unfavourable gap to benchmark.
// unlock delta = revenue if the stat moves fully to benchmark, everything else held constant.
// ease = relative distance off benchmark (0 at benchmark, 1 at the theoretical floor/ceiling).
// score = unlock delta x ease  (deliberately double-weights distance: bigger gaps are both worth more and easier to move).
function unlockRows() {
  const { pm, eff, aov } = stats();
  const rows = [];
  pm.forEach((p) => {
    const base = p.completed * aov;
    if (base <= 0) return;
    for (let li = 1; li <= 4; li++) {
      const bench = leverBench(eff, p.type, li);
      if (!bench || bench.v == null || !isFinite(bench.v)) continue;
      const cur = li === 1 ? p.bounce : li === 2 ? p.e2c : li === 3 ? p.c2c : p.c2p;
      let delta, ease;
      if (li === 1) {
        if (cur == null || cur >= 1 || cur <= bench.v) continue;
        delta = base * ((1 - bench.v) / (1 - cur) - 1);
        ease = (cur - bench.v) / (1 - bench.v);
      } else {
        if (!cur || !isFinite(cur) || cur >= bench.v) continue;
        delta = base * (bench.v / cur - 1);
        ease = (bench.v - cur) / bench.v;
      }
      ease = Math.min(1, Math.max(0, ease));
      rows.push({
        p, li, label: PP_LEVERS[li - 1][1], f: PP_LEVERS[li - 1][2],
        cur, bench: bench.v, gap: li === 1 ? cur - bench.v : bench.v - cur,
        ease, delta, score: delta * ease,
      });
    }
  });
  return rows.sort((a, b) => b.score - a.score);
}

function renderUnlocks() {
  const rows = unlockRows();
  $("unlocks-table").innerHTML =
    `<tr><th>#</th><th style="text-align:left">Page</th><th style="text-align:left">Lever</th>` +
    `<th>Current</th><th>Benchmark</th><th>Gap (pp)</th><th>Off benchmark</th><th>Unlock Δ (to benchmark)</th><th>Weighted score</th></tr>` +
    (rows.length ? rows.map((r, i) =>
      `<tr><td>${i + 1}</td><td class="path" title="${esc(r.p.path)}">${esc(shortPath(r.p.path))}</td>` +
      `<td style="text-align:left;font-family:var(--disp)">${r.label}</td>` +
      `<td style="color:var(--oxide);font-weight:600">${r.f(r.cur)}</td>` +
      `<td style="color:var(--mute)">${r.f(r.bench)}</td>` +
      `<td>${(r.gap * 100).toFixed(1)}</td><td>${fmtPct(r.ease, 0)}</td>` +
      `<td>${fmtM(r.delta)}</td><td style="font-weight:600">${fmtM(r.score)}</td></tr>`).join("")
    : `<tr><td colspan="9" style="text-align:left;color:var(--mute)">Every page beats its benchmarks on every lever — raise your targets on the Benchmarks tab.</td></tr>`);
}

const EPSB = 1e-6;
function benchColour(cur, bench, higherBetter) {
  if (bench == null || !isFinite(bench)) return "";
  const d = cur - bench;
  return Math.abs(d) < EPSB ? "var(--mute)" : ((higherBetter ? d > 0 : d < 0) ? "var(--euca)" : "var(--oxide)");
}

/* ---------------- lever maths ---------------- */
// relative move on a rate, saturating at 100% (Buy-Now artifact rates >100% stay linear)
function rateRelDelta(base, r, x) {
  if (base <= 0 || !r || !isFinite(r)) return 0;
  let rNew = Math.max(0, r * (1 + x));
  if (r <= 1) rNew = Math.min(1, rNew);
  return base * (rNew / r - 1);
}

// absolute percentage-POINT move on one lever (bounce moves DOWN by pp for positive pp)
function leverDeltaAbs(p, li, pp, aov) {
  const base = p.completed * aov;
  if (base <= 0) return 0;
  if (li === 1) {
    if (p.bounce >= 1 || p.bounce == null) return 0;
    const bNew = Math.min(1, Math.max(0, p.bounce - pp));
    return base * ((1 - bNew) / (1 - p.bounce) - 1);
  }
  const r = li === 2 ? p.e2c : li === 3 ? p.c2c : p.c2p;
  if (!r || !isFinite(r)) return 0;
  let rNew = Math.max(0, r + pp);
  if (r <= 1) rNew = Math.min(1, rNew);
  return base * (rNew / r - 1);
}

// bounce as a relative move (used for the sitewide levers row and glossary example)
function bounceRelDelta(base, b, x) {
  if (base <= 0 || b == null || b >= 1) return 0;
  const bNew = Math.min(1, Math.max(0, b * (1 - x)));
  return base * ((1 - bNew) / (1 - b) - 1);
}

/* ---------------- sensitivity page (two tabs) ---------------- */
const SENS_NOTE = "Cumulative purchase rate = purchases ÷ engaged sessions (ATC × checkout-in-cart × conversion-in-checkout). Click a row for that page's point-move breakdown — bounce and the three steps, each with its own slider. Colours compare against the page-type benchmark (manual > external default > pooled).";

const PP_LEVERS = [
  [1, "Bounce rate", (v) => fmtPct(v, 1)],
  [2, "ATC rate of click-through traffic", (v) => fmtPct(v, 2)],
  [3, "Checkout rate in cart", (v) => fmtPct(v, 1)],
  [4, "Conversion rate in checkout", (v) => fmtPct(v, 1)],
];

function ppLeverRows(p, eff, pp, aov) {
  return PP_LEVERS.map(([li, label, f]) => {
    const cur = li === 1 ? p.bounce : li === 2 ? p.e2c : li === 3 ? p.c2c : p.c2p;
    return { li, label, f, cur, bench: leverBench(eff, p.type, li), delta: leverDeltaAbs(p, li, pp, aov) };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

function ppPanelBody(p, eff, pp, aov) {
  return ppLeverRows(p, eff, pp, aov).map((r) => {
    const col = benchColour(r.cur, r.bench ? r.bench.v : null, r.bench ? r.bench.higherBetter : true);
    return `<tr><td style="text-align:left;font-family:var(--disp)">${r.label}</td>` +
      `<td${col ? ` style="color:${col};font-weight:600"` : ""}>${r.f(r.cur)}</td>` +
      `<td style="color:var(--mute)">${r.bench && r.bench.v != null ? r.bench.f(r.bench.v) : "–"}</td>` +
      `<td style="color:${r.delta < 0 ? "var(--oxide)" : "var(--ink)"}">${fmtM(r.delta)}</td></tr>`;
  }).join("");
}

function toggleSensRow(key) {
  const e = (S.expanded[key] = S.expanded[key] || { open: false, pp: 0.05 });
  e.open = !e.open;
  renderSensitivity();
}

function renderSensitivity() {
  const { cur, pm, eff, aov } = stats();
  const x = S.sensPct;
  const sl = $("sens-slider");
  sl.value = Math.max(-100, Math.min(100, x * 100));
  $("sens-pct").textContent = (x >= 0 ? "+" : "") + +(x * 100).toFixed(2) + "%";
  $("sens-note").textContent = SENS_NOTE;

  const siteBase = cur.completed * aov;

  // one row per page: cumulative purchase rate; the four levers live in the dropdown
  const engagedS = cur.sessions * (1 - (cur.bounce || 0));
  const siteCum = engagedS > 0 ? cur.completed / engagedS : 0;
  $("sens-site").innerHTML =
    `<tr><th style="text-align:left">Sitewide (all pages)</th><th>Base value</th><th>Base revenue (${cur.days}d)</th><th>Δ revenue</th></tr>` +
    `<tr><td style="text-align:left;font-family:var(--disp)">Cumulative purchase rate ${x >= 0 ? "+" : ""}${+(x * 100).toFixed(1)}%</td>` +
    `<td>${fmtPct(siteCum, 2)}</td><td>${fmtM(siteBase)}</td>` +
    `<td style="color:${x < 0 ? "var(--oxide)" : "var(--ink)"}">${fmtM(rateRelDelta(siteBase, siteCum, x))}</td></tr>`;

  const rows = pm.map((p) => ({
    p, key: p.path + "|cum", cur: p.cum, bench: cumBench(eff, p.type),
    delta: rateRelDelta(p.rev, p.cum, x),
  })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.p.sessions - a.p.sessions);

  const panels = [];
  let seq = 0;
  $("sens-table").innerHTML =
    `<tr><th>#</th><th style="text-align:left">Page</th><th>Cumulative purchase rate</th><th>Benchmark</th><th>Gap (pp)</th><th>Base revenue</th><th>Δ revenue</th></tr>` +
    rows.map((r, i) => {
      const st = S.expanded[r.key];
      const open = st && st.open;
      const col = benchColour(r.cur, r.bench, true);
      const gap = r.bench == null || !isFinite(r.bench) ? "–" :
        (() => { const h = r.bench - r.cur; return (h >= 0 ? "+" : "−") + Math.abs(h * 100).toFixed(1) + "pp"; })();
      let html =
        `<tr class="sens-click" data-key="${esc(r.key)}"><td>${i + 1}</td>` +
        `<td class="path" title="${esc(r.p.path)}"><span style="color:var(--mute)">${open ? "▾" : "▸"}</span> ${esc(shortPath(r.p.path))}</td>` +
        `<td${col ? ` style="color:${col};font-weight:600"` : ""}>${fmtPct(r.cur, 2)}</td>` +
        `<td style="color:var(--mute)">${r.bench != null && isFinite(r.bench) ? fmtPct(r.bench, 2) : "–"}</td>` +
        `<td style="color:var(--mute)">${gap}</td><td>${fmtM(r.p.rev)}</td>` +
        `<td style="color:${r.delta < 0 ? "var(--oxide)" : "var(--ink)"}">${fmtM(r.delta)}</td></tr>`;
      if (open) {
        const id = seq++;
        const pp = st.pp;
        panels.push({ sliderId: `pp-sl-${id}`, lblId: `pp-lbl-${id}`, bodyId: `pp-body-${id}`, key: r.key, page: r.p });
        html +=
          `<tr class="pp-panel"><td colspan="7"><div style="padding:8px 6px 10px 22px">` +
          `<div class="slider-row" style="margin:0 0 8px">Point move for this page: ` +
          `<input type="range" id="pp-sl-${id}" min="-100" max="100" value="${Math.max(-100, Math.min(100, pp * 100))}">` +
          `<span class="pct" id="pp-lbl-${id}">${(pp >= 0 ? "+" : "") + +(pp * 100).toFixed(1)}pp</span>` +
          `<span style="color:var(--mute);font-size:11.5px">Δ = base × points ÷ rate; bounce moves down for positive points</span></div>` +
          `<table style="max-width:640px"><tr><th style="text-align:left">Lever</th><th>Current</th><th>Benchmark</th><th>Δ revenue</th></tr>` +
          `<tbody id="pp-body-${id}">${ppPanelBody(r.p, eff, pp, aov)}</tbody></table></div></td></tr>`;
      }
      return html;
    }).join("");

  $("sens-table").querySelectorAll("tr.sens-click").forEach((tr) => {
    tr.onclick = () => toggleSensRow(tr.dataset.key);
  });
  panels.forEach(({ sliderId, lblId, bodyId, key, page }) => {
    const el = $(sliderId);
    if (!el) return;
    el.onclick = (ev) => ev.stopPropagation();
    el.oninput = (ev) => {
      ev.stopPropagation();
      const pp = +el.value / 100;
      S.expanded[key].pp = pp;
      $(lblId).textContent = (pp >= 0 ? "+" : "") + +(pp * 100).toFixed(1) + "pp";
      $(bodyId).innerHTML = ppPanelBody(page, eff, pp, aov);
    };
  });
}

/* ---------------- render: shell ---------------- */
function renderAll() {
  const d = S.data;
  invalidateStats();
  $("stamp").textContent =
    `${d.range.start} → ${d.range.end} (${d.range.days}d) · pulled ${d.fetchedAt.replace("T", " ")}` +
    (d.mock ? " · DEMO DATA" : "");
  $("dash-loading").style.display = "none";
  $("dash-body").style.display = "block";
  renderDashboard(); renderPages(); renderSensitivity(); renderUnlocks(); renderBenchmarks();
  renderDaily(); renderMarkers(); renderGlossary();
}

function deltaBadge(cur, prior, goodUp = true) {
  if (cur == null || prior == null || !isFinite(prior) || prior === 0) return "";
  const ch = (cur - prior) / Math.abs(prior);
  const good = goodUp ? ch >= 0 : ch <= 0;
  const arrow = ch >= 0 ? "\u25B2" : "\u25BC";
  return `<div class="delta ${good ? "up" : "down"}">${arrow} ${(Math.abs(ch) * 100).toFixed(1)}% vs prior</div>`;
}

/* ---------------- render: dashboard ---------------- */
function renderDashboard() {
  const d = S.data;
  const { cur, pri, pm, eff, aov } = stats();
  const kpis = [
    ["Sessions", fmtInt(cur.sessions), deltaBadge(cur.sessions, pri.sessions)],
    ["Bounce", fmtPct(cur.bounce), deltaBadge(cur.bounce, pri.bounce, false)],
    ["Conversion", fmtPct(cur.cr, 2), deltaBadge(cur.cr, pri.cr)],
    ["Orders", fmtInt(cur.orders), deltaBadge(cur.orders, pri.orders)],
    ["Total sales", fmtM(cur.total), deltaBadge(cur.total, pri.total)],
    ["AOV (net)", fmtM(cur.aov, 2), deltaBadge(cur.aov, pri.aov)],
  ];
  $("kpi-strip").innerHTML = kpis.map(([l, v, del]) =>
    `<div class="kpi"><div class="lbl">${l}</div><div class="val">${v}</div>${del}</div>`).join("");

  // trend chart with lever-pull markers
  const inRange = S.markers.filter((m) => m.date >= d.range.start && m.date <= d.range.end);
  drawChart("trend-chart", {
    type: "bar",
    data: {
      labels: d.daily.map((r) => r.day),
      datasets: [
        { label: "Sessions", data: d.daily.map((r) => r.sessions), backgroundColor: "rgba(35,38,31,0.72)", yAxisID: "y", order: 2, borderRadius: 2 },
        { label: "Conversion %", data: d.daily.map((r) => r.sessions ? +(100 * r.completed / r.sessions).toFixed(2) : 0), type: "line", borderColor: EUCA, borderWidth: 2.25, pointRadius: 0, yAxisID: "y1", order: 1 },
      ],
    },
    options: {
      responsive: true, interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { font: { size: 10, family: "monospace" }, maxTicksLimit: 14 }, grid: { display: false } },
        y: { ticks: { font: { size: 10, family: "monospace" } }, grid: { color: LINE } },
        y1: { position: "right", ticks: { font: { size: 10, family: "monospace" }, callback: (v) => v + "%" }, grid: { display: false } },
      },
      plugins: { legend: { labels: { font: { size: 12 } } } },
    },
    plugins: [markerPlugin(inRange)],
  });

  // top 10 revenue unlocks: prize x distance off benchmark
  const top = unlockRows().slice(0, 10);
  $("top10-unlocks").innerHTML =
    `<colgroup><col style="width:5%"><col style="width:33%"><col style="width:24%"><col style="width:12%"><col style="width:13%"><col style="width:13%"></colgroup>` +
    `<tr><th>#</th><th style="text-align:left">Page</th><th style="text-align:left">Lever</th><th>Off benchmark</th><th>Unlock Δ</th><th>Weighted score</th></tr>` +
    top.map((r, i) =>
      `<tr><td>${i + 1}</td><td class="path" title="${esc(r.p.path)}">${esc(shortPath(r.p.path))}</td>` +
      `<td style="text-align:left;font-family:var(--disp)">${r.label}</td>` +
      `<td>${fmtPct(r.ease, 0)}</td><td>${fmtM(r.delta)}</td><td style="font-weight:600">${fmtM(r.score)}</td></tr>`).join("");

  // funnel: selected range vs prior
  const rows = [
    ["Sessions", fmtInt(cur.sessions), fmtInt(pri.sessions)],
    ["Sessions / day", (cur.sessions / (cur.days || 1)).toFixed(1), pri.days ? (pri.sessions / pri.days).toFixed(1) : "–"],
    ["Bounce rate", fmtPct(cur.bounce), fmtPct(pri.bounce)],
    ["Added to cart", fmtInt(cur.carts), fmtInt(pri.carts)],
    ["Reached checkout", fmtInt(cur.reached), fmtInt(pri.reached)],
    ["Completed checkout", fmtInt(cur.completed), fmtInt(pri.completed)],
    ["Visit → Cart", fmtPct(cur.v2c, 2), fmtPct(pri.v2c, 2)],
    ["Cart → Checkout", fmtPct(cur.c2c), fmtPct(pri.c2c)],
    ["Checkout → Purchase", fmtPct(cur.c2p), fmtPct(pri.c2p)],
    ["Conversion rate", fmtPct(cur.cr, 2), fmtPct(pri.cr, 2)],
    ["Orders", fmtInt(cur.orders), fmtInt(pri.orders)],
    ["Total sales", fmtM(cur.total), fmtM(pri.total)],
    ["Net sales", fmtM(cur.net), fmtM(pri.net)],
    ["AOV (net ÷ orders)", fmtM(cur.aov, 2), fmtM(pri.aov, 2)],
    ["Total sales / day", fmtM(cur.total / (cur.days || 1)), pri.days ? fmtM(pri.total / pri.days) : "–"],
  ];
  $("glance").innerHTML =
    `<tr><th style="text-align:left">Metric</th><th>${d.range.start} → ${d.range.end}</th><th>Prior (${d.prior.start} → ${d.prior.end})</th></tr>` +
    rows.map(([m, a, b]) => `<tr><td style="text-align:left;font-family:var(--disp)">${m}</td><td>${a}</td><td style="color:var(--mute)">${b}</td></tr>`).join("");
}

/* ---------------- render: pages ---------------- */
const PAGE_COLS = [
  ["path", "Page", "l"], ["type", "Type", "l"], ["sessions", "Sessions", "int"],
  ["bounce", "Bounce", "pct"], ["engaged", "Engaged", "int"],
  ["social", "Social", "int"], ["direct", "Direct", "int"], ["search", "Search", "int"],
  ["e2c", "Eng→Cart", "pct2"], ["p2c", "Page→Cart", "pct2"], ["c2c", "Cart→Chk", "pct"],
  ["c2p", "Chk→Buy", "pct"], ["cr", "CR", "pct2"], ["rev", "Est. rev", "money"], ["uplift", "Uplift $/mo", "money"],
];
function renderPages() {
  const { cur, pm } = stats();
  const rows = uplifts(pm, cur);
  rows.sort((a, b) => {
    const va = a[S.sortKey], vb = b[S.sortKey];
    if (typeof va === "string") return S.sortDir * va.localeCompare(vb);
    return S.sortDir * ((va || 0) - (vb || 0));
  });
  const fmt = { l: esc, int: fmtInt, pct: fmtPct, pct2: (v) => fmtPct(v, 2), money: (v) => fmtM(v) };
  const head = PAGE_COLS.map(([k, label]) =>
    `<th class="${S.sortKey === k ? "sorted" : ""}" data-key="${k}">${label}${S.sortKey === k ? (S.sortDir < 0 ? " ▾" : " ▴") : ""}</th>`).join("");
  const body = rows.map((p) => "<tr>" + PAGE_COLS.map(([k, , t]) => {
    if (k === "path") return `<td class="path" title="${esc(p.path)}">${esc(shortPath(p.path))}</td>`;
    if (k === "bounce") return `<td class="${p.bounce > 0.85 ? "bad" : ""}">${fmtPct(p.bounce)}</td>`;
    return `<td>${fmt[t](p[k])}</td>`;
  }).join("") + "</tr>").join("");
  const totalRow = `<tr class="total"><td>SITEWIDE (all pages, from daily data)</td><td>—</td>` +
    `<td>${fmtInt(cur.sessions)}</td><td>${fmtPct(cur.bounce)}</td><td>${fmtInt(cur.sessions * (1 - cur.bounce))}</td>` +
    `<td colspan="3">—</td><td>—</td><td>${fmtPct(cur.v2c, 2)}</td><td>${fmtPct(cur.c2c)}</td><td>${fmtPct(cur.c2p)}</td>` +
    `<td>${fmtPct(cur.cr, 2)}</td><td>${fmtM(cur.completed * (cur.aov || 0))}</td><td>—</td></tr>`;
  $("pages-table").innerHTML = `<tr>${head}</tr>` + body + totalRow;
  $("pages-table").querySelectorAll("th").forEach((th) => th.onclick = () => {
    const k = th.dataset.key;
    if (S.sortKey === k) S.sortDir *= -1; else { S.sortKey = k; S.sortDir = -1; }
    renderPages();
  });
}

/* ---------------- render: benchmarks ---------------- */
const BENCH_STATS = [["bounce", "Bounce rate", false], ["p2c", "Page→Cart", true], ["c2c", "Cart→Checkout", true], ["c2p", "Checkout→Purchase", true], ["cr", "Conversion rate", true]];
const ALL_TYPES = ["PDP", "Advertorial", "Homepage", "Info", "Collection"];

async function loadBench() {
  try { S.bench = (await loadMeta()).bench; } catch { S.bench = {}; }
}

async function saveBench() {
  const next = {};
  document.querySelectorAll("#bench-editor input[data-type]").forEach((inp) => {
    const t = inp.dataset.type, k = inp.dataset.stat, v = inp.value.trim();
    next[t] = next[t] || {};
    next[t][k] = v === "" ? null : (parseFloat(v) / 100);
  });
  try {
    await saveMeta("benchmarks", next);
    S.bench = next;
    $("bench-status").textContent = "Saved ✓";
    setTimeout(() => ($("bench-status").textContent = ""), 2500);
    invalidateStats(); // benchmarks feed uplift and sensitivity maths everywhere
    renderDashboard(); renderPages(); renderSensitivity(); renderUnlocks(); renderBenchmarks();
  } catch (e) {
    $("bench-status").textContent = "Save failed: " + e.message;
  }
}

function renderBenchmarks() {
  const { cur, pm, eff } = stats();
  const comp = benchmarks(pm);
  const types = [...new Set([...ALL_TYPES, ...Object.keys(comp)])].filter((t) => comp[t] || (S.bench[t] && Object.values(S.bench[t]).some((v) => v != null)));

  $("bench-editor").innerHTML =
    `<tr><th style="text-align:left">Page type</th>` +
    BENCH_STATS.map(([, label]) => `<th colspan="3">${label}</th>`).join("") + `</tr>` +
    `<tr><th style="text-align:left;font-weight:400;color:var(--mute)">per stat:</th>` +
    BENCH_STATS.map(() => `<th style="font-weight:400;color:var(--mute)">range actual</th><th style="font-weight:400;color:var(--mute)">default</th><th style="font-weight:400;color:var(--mute)">yours %</th>`).join("") + `</tr>` +
    types.map((t) => {
      const c = comp[t] || {};
      const dft = DEFAULT_BENCH[t] || {};
      const man = S.bench[t] || {};
      return `<tr><td style="text-align:left;font-family:var(--disp);font-weight:600">${t}</td>` +
        BENCH_STATS.map(([k]) => {
          const actual = c[k] != null ? fmtPct(c[k], 2) : "–";
          const dval = dft[k] != null ? fmtPct(dft[k], 1) : "–";
          const val = man[k] != null ? +(man[k] * 100).toFixed(3) : "";
          return `<td style="color:var(--mute)">${actual}</td><td style="color:var(--mute)">${dval}</td>` +
            `<td><input type="number" step="any" min="0" data-type="${t}" data-stat="${k}" value="${val}" placeholder="${dft[k] != null ? "default" : "pooled"}" ` +
            `style="width:70px;border:1px solid var(--line);border-radius:6px;padding:3px 6px;font-family:var(--mono);font-size:12px;text-align:right"></td>`;
        }).join("") + `</tr>`;
    }).join("");

  const ups = uplifts(pm, cur);
  const cell = (val, bench, higherBetter, dp) => {
    const col = benchColour(val, bench, higherBetter);
    return `<td${col ? ` style="color:${col}"` : ""}>${fmtPct(val, dp)}</td>`;
  };
  $("bench-pages").innerHTML =
    `<tr><th style="text-align:left">Page</th><th>Type</th><th>Sessions</th>` +
    `<th>Bounce</th><th>bench</th><th>Page→Cart</th><th>bench</th><th>Cart→Chk</th><th>bench</th>` +
    `<th>Chk→Buy</th><th>bench</th><th>CR</th><th>bench</th><th>Uplift $/mo</th></tr>` +
    ups.sort((a, b) => b.sessions - a.sessions).map((p) => {
      const b = eff[p.type] || {};
      return `<tr><td class="path" title="${esc(p.path)}">${esc(shortPath(p.path))}</td><td>${p.type}</td><td>${fmtInt(p.sessions)}</td>` +
        cell(p.bounce, b.bounce, false, 1) + `<td style="color:var(--mute)">${fmtPct(b.bounce, 1)}</td>` +
        cell(p.p2c, b.p2c, true, 2) + `<td style="color:var(--mute)">${fmtPct(b.p2c, 2)}</td>` +
        cell(p.c2c, b.c2c, true, 1) + `<td style="color:var(--mute)">${fmtPct(b.c2c, 1)}</td>` +
        cell(p.c2p, b.c2p, true, 1) + `<td style="color:var(--mute)">${fmtPct(b.c2p, 1)}</td>` +
        cell(p.cr, b.cr, true, 2) + `<td style="color:var(--mute)">${fmtPct(b.cr, 2)}</td>` +
        `<td>${fmtM(p.uplift)}</td></tr>`;
    }).join("");
}

/* ---------------- render: daily ---------------- */
function renderDaily() {
  const d = S.data;
  drawChart("rev-chart", {
    type: "bar",
    data: {
      labels: d.sales.map((r) => r.day),
      datasets: [
        { label: "Total sales", data: d.sales.map((r) => r.total), backgroundColor: "rgba(62,124,89,0.75)", borderRadius: 2 },
        { label: "Net sales", data: d.sales.map((r) => r.net), type: "line", borderColor: INK, borderWidth: 1.5, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: { ticks: { font: { size: 10, family: "monospace" }, maxTicksLimit: 14 }, grid: { display: false } },
        y: { ticks: { font: { size: 10, family: "monospace" }, callback: (v) => "$" + (v / 1000) + "k" }, grid: { color: LINE } },
      },
      plugins: { legend: { labels: { font: { size: 12 } } } },
    },
  });
  const salesBy = {}; d.sales.forEach((r) => (salesBy[r.day] = r));
  $("daily-table").innerHTML =
    `<tr><th style="text-align:left">Day</th><th>Sessions</th><th>Bounce</th><th>Carts</th><th>Reached chk</th><th>Completed</th><th>CR</th><th>Orders</th><th>Total sales</th><th>Net sales</th></tr>` +
    d.daily.map((r) => {
      const s = salesBy[r.day] || {};
      return `<tr><td style="text-align:left">${r.day}</td><td>${fmtInt(r.sessions)}</td><td>${fmtPct(r.bounce)}</td>` +
        `<td>${fmtInt(r.carts)}</td><td>${fmtInt(r.reached)}</td><td>${fmtInt(r.completed)}</td>` +
        `<td>${fmtPct(r.sessions ? r.completed / r.sessions : null, 2)}</td>` +
        `<td>${fmtInt(s.orders)}</td><td>${fmtM(s.total)}</td><td>${fmtM(s.net)}</td></tr>`;
    }).join("");
}

/* ---------------- markers ---------------- */
async function loadMarkers() {
  try { S.markers = (await loadMeta()).markers; } catch { S.markers = []; }
}
async function addMarker() {
  const date = $("m-date").value, label = $("m-label").value.trim(), note = $("m-note").value.trim();
  if (!date || !label) { alert("A marker needs a date and a lever name."); return; }
  S.markers = [...S.markers, { id: Date.now(), date, label, note }];
  try { await saveMeta("markers", S.markers); } catch (e) { alert("Save failed: " + e.message); }
  $("m-date").value = ""; $("m-label").value = ""; $("m-note").value = "";
  renderMarkers(); if (S.data) renderDashboard();
}
async function delMarker(id) {
  S.markers = S.markers.filter((m) => m.id !== id);
  try { await saveMeta("markers", S.markers); } catch (e) { alert("Save failed: " + e.message); }
  renderMarkers(); if (S.data) renderDashboard();
}
function renderMarkers() {
  $("m-chips").innerHTML = LEVER_CHIPS.map((c) => `<button type="button" data-c="${esc(c)}">${esc(c)}</button>`).join("");
  $("m-chips").querySelectorAll("button").forEach((b) => (b.onclick = () => ($("m-label").value = b.dataset.c)));
  $("m-list").innerHTML = S.markers.length
    ? S.markers.map((m) =>
        `<div class="marker-item"><div class="d">${esc(m.date)}</div>` +
        `<div><div class="l">${esc(m.label)}</div>${m.note ? `<div class="n">${esc(m.note)}</div>` : ""}</div>` +
        `<button title="Delete" data-id="${m.id}">✕</button></div>`).join("")
    : `<div class="sub">Nothing logged yet — record every lever pull so the trend chart shows before/after.</div>`;
  $("m-list").querySelectorAll("button").forEach((b) => (b.onclick = () => delMarker(+b.dataset.id)));
}

function markerPlugin(markers) {
  return {
    id: "levermarkers",
    afterDatasetsDraw(chart) {
      const { ctx, scales: { x }, chartArea } = chart;
      markers.forEach((m) => {
        const idx = chart.data.labels.indexOf(m.date);
        if (idx === -1) return;
        const px = x.getPixelForValue(idx);
        if (px == null || isNaN(px) || px < chartArea.left || px > chartArea.right) return;
        ctx.save();
        ctx.strokeStyle = OXIDE; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px, chartArea.top); ctx.lineTo(px, chartArea.bottom); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = OXIDE; ctx.font = "10px monospace"; ctx.textAlign = "left";
        ctx.fillText("⚑ " + m.label.slice(0, 22), px + 3, chartArea.top + 10);
        ctx.restore();
      });
    },
  };
}

function drawChart(id, cfg) {
  if (S.charts[id]) S.charts[id].destroy();
  S.charts[id] = new Chart($(id).getContext("2d"), cfg);
}

/* ---------------- render: model limits ---------------- */
function renderLimits() {
  const lever = (name, assumes, reality, read) =>
    `<dt>${name}</dt><dd><b style="color:var(--euca)">The model assumes:</b> ${assumes}<br>` +
    `<b style="color:var(--oxide)">What reality does:</b> ${reality}<br>` +
    `<b>How to read the number:</b> ${read}</dd>`;
  $("limits-body").innerHTML =
    `<h2>Model limits — what every lever number assumes</h2>
    <div class="rank-note">Every figure on the Sensitivity, Unlocks and Dashboard rankings comes from one multiplicative model: Revenue = Sessions × (1−Bounce) × Cumulative purchase rate × AOV, where the cumulative rate is the product of ATC × checkout-in-cart × conversion-in-checkout. The workflow: the Unlocks ranking picks the page × lever with the best prize-times-ease, the Sensitivity overview prices standard relative moves per page, and each row's point-move dropdown compares the four levers on a page. Use the model to RANK effort; use the Lever Log and before/after date ranges to measure what actually happened.</div><dl>` +
    lever("Cumulative purchase rate — Sensitivity overview",
      "the bundle of three step rates moves together by the chosen relative %, with sessions, bounce and AOV flat. Because the bundle is a product, +x% on it is worth exactly +x% on any single step below the caps.",
      "HOW you move it decides whether the assumption holds. The overview can't see which step you'd actually change or what side-effects that change carries — that's what the dropdown is for.",
      "a fair way to compare pages (same-sized relative ask everywhere). Once a page is chosen, open its dropdown and pick the step using the caveats below.") +
    lever("Bounce rate — point-move dropdown",
      "recovered bouncers click through and then buy at the SAME rate as visitors who already chose to engage (the ATC-of-click-through-traffic constant is held flat).",
      "bounce fixes recover the least-interested cohort first, and their downstream rates sit below the current engaged average — sometimes far below. The bounce/(1−bounce) amplifier makes this lever look dominant partly BECAUSE of that assumption. Separately, Shopify counts a bounce as one page with no interaction, so adding any interactive element can 'cut bounce' in the data without changing behaviour or revenue.",
      "an upper bound. Haircut 30–50% for planning, more if the fix is cosmetic. Pair every bounce lever with a Lever Log marker and judge it on revenue, not on the bounce number itself.") +
    lever("ATC rate of click-through traffic — dropdown",
      "checkout-in-cart and conversion-in-checkout hold flat while a larger share of engaged visitors adds to cart.",
      "how you raise ATC decides whether that holds. Discount-led popups, urgency timers, and one-click ATC pull lower-intent carts into the funnel, which deflates checkout-in-cart downstream. Genuine improvements — clearer offer, stronger proof, better PDP — hold up much better.",
      "reliable for quality improvements, optimistic for pressure tactics. After any ATC lever pull, watch checkout-in-cart in the next window: if it fell, the model over-credited the change.") +
    lever("Checkout rate in cart — dropdown",
      "conversion-in-checkout holds flat while more carts proceed to checkout.",
      "the same composition effect one step later — marginal carts complete below average. There's also a measurement quirk: Buy Now skips the cart entirely, so this rate can exceed 100%, and moving Buy Now placement shifts WHERE drop-off is measured more than how much of it exists.",
      "directionally sound for real friction fixes (shipping transparency in cart, trust signals, cart UX). Don't chase the rate on pages dominated by Buy Now — the denominator is distorted.") +
    lever("Conversion rate in checkout — dropdown",
      "AOV, refund rate, and payment mix are unchanged by whatever lifts completion.",
      "this is the safest lever — the audience already has high intent — but the common fixes move the numbers the model holds fixed: free-shipping thresholds change AOV, heavy urgency raises refunds and chargebacks, new payment methods shift the AOV mix.",
      "the most trustworthy number in the model. Still check AOV and the refund rate in the window after the pull.") +
    `</dl><h2 style="margin-top:26px">Cross-cutting limits (apply everywhere)</h2><dl>` +
    `<dt>One lever at a time</dt><dd>Every Δ holds all other stats fixed, but real levers interact: a price change moves conversion AND AOV together; a popup moves ATC and email revenue. Deltas from different rows do not add — improving two levers on one page compounds multiplicatively rather than summing.</dd>
    <dt>AOV is uniform across pages</dt><dd>Shopify doesn't attribute revenue to landing pages, so every page's base revenue = its completed checkouts × the sitewide range AOV. Pages that feed bundle buyers vs single-unit buyers are relatively mis-stated.</dd>
    <dt>Landing-page attribution</dt><dd>The full journey is credited to the entry page. A mid-journey improvement (e.g. a PDP rebuild) shows up smeared across every page that feeds the PDP — never as its own row.</dd>
    <dt>Sessions ≠ orders</dt><dd>Completed-checkout sessions run ~2–3% under actual orders (multi-order sessions, draft orders), so modelled revenue slightly understates actuals. Fine for ranking levers; wrong for accounting.</dd>
    <dt>Statistical noise</dt><dd>Under ~300 sessions in the range, one extra order moves a page's rates by whole percentage points. Widen the range before acting on small pages.</dd>
    <dt>Time and seasonality</dt><dd>The prior period is different calendar weeks; promos and peak months distort both the deltas and the pooled benchmarks. Compare like-for-like windows where you can.</dd>
    <dt>'Further off benchmark = easier' is a heuristic</dt><dd>The unlock score assumes distance below benchmark equals cheap recovery. Sometimes true (a broken page), sometimes not: a stat can be low because the traffic is cold or mismatched, which no amount of page CRO fixes. When a low-traffic-quality page tops the Unlocks list, the real lever may be the ads, not the page. The benchmarks themselves are also external averages with mixed evidence strength — see the Glossary's default-benchmarks entry.</dd>
    <dt>Extreme inputs saturate</dt><dd>Rate levers cap at 100% (a rate can't convert past certainty), so large moves flatten out; visits are uncapped upward and floor at −100%. Rates already above 100% via Buy Now stay linear because the cap would be fighting a measurement artifact.</dd>
    <dt>It's a prioritisation tool, not a forecast</dt><dd>Use these numbers to rank where effort goes and size the prize. Then pull the lever, drop a marker in the Lever Log, and let the before/after windows — real sessions, real revenue — be the verdict.</dd></dl>`;
}

/* ---------------- render: glossary (formula-first) ---------------- */
function renderGlossary() {
  const g = [ // [term, formula (own line, null if definitional), explanation]
    ["Landing-page attribution", null,
      "Every per-page stat is credited to the session's LANDING page: 'page 1 → PDP → cart → checkout' counts entirely against page 1. A page's row covers only sessions that entered there; mid-journey per-page funnels need GA4."],
    ["Bounce rate", "bounce = bounced sessions ÷ sessions      range bounce = Σ(daily sessions × daily bounce) ÷ Σ(daily sessions)",
      "Share of sessions that left from the landing page without viewing another page or interacting (Shopify's definition). Range bounce is session-weighted — never an average of daily rates."],
    ["Engaged sessions (click-through traffic)", "engaged = sessions × (1 − bounce)",
      "The pool that clicked through and can realistically convert. For an advertorial this is the traffic that reached the PDP."],
    ["ATC rate of click-through traffic", "e2c = carts ÷ engaged",
      "How well a page converts the people who actually stay. Identity: Page→Cart = (1 − bounce) × e2c, so bounce and this rate never double-count."],
    ["Checkout rate in cart", "c2c = reached checkout ÷ carts",
      "Can exceed 100%: dynamic Buy Now buttons skip the cart, so a session can reach checkout with no recorded cart addition. Measurement quirk, not an error."],
    ["Conversion rate in checkout", "c2p = completed ÷ reached checkout",
      "The last step; the safest lever because its audience already has high intent."],
    ["Cumulative purchase rate", "cum = completed ÷ engaged  =  e2c × c2c × c2p",
      "The whole funnel after the click-through, as one number — used on the Page levers overview and the Dashboard top-5. Because it's a product, a relative move on it equals the same relative move on any single step, so grouping loses nothing."],
    ["Conversion rate (sale)", "cr = completed ÷ sessions",
      "Purchases per session including bouncers. cr = (1 − bounce) × cum."],
    ["AOV", "aov = net sales ÷ orders   (over the selected range)",
      "Net-sales basis because the B3G2 ladder books a large share of gross as discounts. Assumed uniform across pages — Shopify has no revenue by landing page."],
    ["Base (est.) revenue", "base = completed checkouts × aov",
      "A page's modelled revenue for the range. Runs ~2–3% under actual net sales (see Sessions vs orders)."],
    ["Revenue model (the chain)", "revenue = sessions × (1 − bounce) × cum × aov",
      "Every delta in the app comes from changing exactly one term of this chain and holding the rest."],
    ["Cumulative rate Δ (Sensitivity overview)", "r′ = min(100%, r × (1 + x))      Δ = base × (r′ ÷ r − 1)   [= base × x below the cap]",
      "The Sensitivity overview slider. Saturates at 100% because a rate can't convert past certainty."],
    ["Point-move Δ (dropdown, rate levers)", "r′ = min(100%, r + pp)      Δ = base × (r′ ÷ r − 1)   [= base × pp ÷ r below the cap]",
      "Equal points are NOT equal relative moves: dividing by the current rate means the smallest rates gain the most from a given point move — which is why the dropdown breaks the overview's ties and identifies the specific lever."],
    ["Bounce Δ (dropdown)", "b′ = max(0, b − pp)      Δ = base × ((1 − b′) ÷ (1 − b) − 1)",
      "Bounce enters the chain as (1 − bounce), so its effect is amplified by roughly b ÷ (1 − b) — about 3.5× at 78% bounce. UPPER BOUND: assumes recovered bouncers convert like current engaged visitors; they usually convert worse. Haircut 30–50%."],
    ["Benchmark hierarchy", "effective benchmark = manual override  >  external default  >  pooled range actual",
      "Manual values from the Benchmarks tab always win. Where you haven't set one, the researched external defaults below apply. Collection pages have no external default (the research didn't cover them) and fall back to pooled actuals — all pages of that type in the current range, combined. Types are inferred from the URL: / = Homepage, /products/ = PDP, /collections = Collection, known info pages = Info, other /pages/ = Advertorial."],
    ["Default benchmarks (external, Aug 2026)", "PDP: bounce 65 · p2c 7 · c2c 68 · c2p 55 · CR 2.5      Advertorial: 78 · 5 · 65 · 50 · 2.5      Homepage: 55 · 5 · 70 · 55 · 2.0      Info: 75 · 2 · 65 · 50 · 0.8   (all %)",
      "Why these are the defaults: peer-reviewed journals don't publish funnel benchmarks — even the Journal of Consumer Research (2026) cites the Baymard Institute's 50-study aggregation for the ~70% cart-abandonment figure — so these come from the strongest available industry datasets, adjusted for this store's ~90% mobile, paid-social-heavy traffic. Sources: Littledata's Shopify panel (12,000+ stores) for add-to-cart (median 4.6%, average 7–8.5%) and checkout completion (45% average, 55% top quartile, 65% elite → c2p defaults sit at the quartile/elite band); Baymard's 70.2% cart abandonment combined with checkout completion to derive cart→checkout ≈ 65–70%; Landra/Build Grow Scale multi-store data for cold-traffic conversion (PDP 1.5–3.5%, advertorial 2–5%, paid social 1.2–2%); Contentsquare for the mobile (+12pp) and paid-social (+41% likelihood) bounce penalties baked into the bounce defaults. Evidence strength: cart/checkout stats Strong, ATC Strong-to-Moderate, conversion Moderate, bounce and everything Advertorial- or Info-specific Weak (practitioner consensus). Where this store already beats a default (checkout→purchase, CR), the default is a floor, not a target — set stretch benchmarks manually from your best pages."],
    ["Derived benchmarks", "e2c_b = p2c_b ÷ (1 − bounce_b)      cum_b = e2c_b × c2c_b × c2p_b",
      "Built from the stored benchmarks via the same identities the page stats obey, so manual overrides flow through automatically."],
    ["Revenue unlock score", "unlock Δ = base × (bench ÷ current − 1)   [rates]      unlock Δ = base × ((1−bench) ÷ (1−current) − 1)   [bounce]\nease = (bench − current) ÷ bench   [rates]      ease = (current − bench) ÷ (1 − bench)   [bounce]\nscore = unlock Δ × ease",
      "One candidate per page × lever with an unfavourable gap. Unlock Δ is the prize for closing the stat fully to benchmark, everything else held constant. Ease (0–1) is how far off benchmark the stat sits — the weighting encodes the assumption that the further a stat is below benchmark, the cheaper each point of recovery is. Score deliberately double-weights distance (it's in both Δ and ease): ranked on the Dashboard (top 10) and in full on the Unlocks tab. Caveat in Model Limits: some stats are low because the page is broken (fixable), others because the traffic is cold (not fixable by CRO) — the score can't tell which."],
    ["Page→Cart uplift ($/mo)", "uplift = max(0, p2c_b − p2c) × sessions × c2c_b × c2p_b × aov × 30 ÷ days",
      "Pages & Benchmarks tabs: what the page would add per month if its Page→Cart rate rose to benchmark, with benchmark downstream rates. Unlike the lever deltas, this one moves downstream rates to benchmark too — which is why it can price pages that have zero purchases."],
    ["Prior period", "prior = the window of equal length immediately before [start, end]",
      "Daily series for both windows are pulled in one query and split locally; the Dashboard KPI badges and funnel table compare against it."],
    ["Sessions vs orders", null,
      "Completed-checkout SESSIONS run below ORDERS because one session can place several orders and draft/manual orders have no session. Modelled revenue therefore understates actual net sales by ~2–3% — fine for ranking levers, wrong for accounting."],
    ["Statistical noise", null,
      "Pages under ~300 sessions in the range: one extra order moves their rates by whole percentage points. Widen the range before acting on them."],
    ["Lever markers", null,
      "Stored in a shop metafield ($app:funnel/markers), so they sync across devices and survive everything; drawn as flags on the Dashboard trend so before/after effects of every pull are visible. The markers are the ground truth the model's predictions get judged against."],
  ];
  $("glossary-body").innerHTML = "<h2>Glossary — every calculation, formula first</h2><dl>" +
    g.map(([t, f, b]) =>
      `<dt>${t}</dt><dd>${f ? `<div class="formula">${esc(f).replace(/\n/g, "<br>")}</div>` : ""}<div class="expl">${b}</div></dd>`).join("") + "</dl>";
}

/* ---------------- controls & init ---------------- */
function setRange(start, end, activeChip) {
  S.start = start; S.end = end;
  document.querySelectorAll(".controls .chip[data-days]").forEach((c) => c.classList.toggle("active", c === activeChip));
  $("custom-start").value = start; $("custom-end").value = end;
  fetchData();
}

function init() {
  $("nav").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    $("nav").querySelectorAll("button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll("section.page").forEach((s) => s.classList.remove("active"));
    $("page-" + b.dataset.page).classList.add("active");
  }));
  document.querySelectorAll(".controls .chip[data-days]").forEach((c) => (c.onclick = () => {
    const n = +c.dataset.days;
    setRange(addDays(iso(new Date()), -n), iso(new Date()), c);
  }));
  $("apply-custom").onclick = () => {
    const s = $("custom-start").value, e = $("custom-end").value;
    if (!s || !e) { alert("Set both custom dates."); return; }
    if (s > e) { alert("Start date is after end date."); return; }
    setRange(s, e, null);
  };
  $("refresh").onclick = fetchData;
  $("m-add").onclick = addMarker;
  $("bench-save").onclick = saveBench;

  $("sens-slider").oninput = (e) => {
    S.sensPct = +e.target.value / 100;
    $("sens-custom").value = "";
    if (S.data) renderSensitivity();
  };
  $("sens-custom").oninput = (e) => {
    const v = parseFloat(e.target.value);
    if (!isFinite(v)) return;
    S.sensPct = v / 100;
    if (S.data) renderSensitivity();
  };

  renderLimits(); // static content, available before the first data pull

  const defChip = document.querySelector('.controls .chip[data-days="30"]');
  Promise.all([loadMarkers(), loadBench()]).then(() => {
    renderMarkers();
    setRange(addDays(iso(new Date()), -30), iso(new Date()), defChip);
  });
}

document.addEventListener("DOMContentLoaded", init);
