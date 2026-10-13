#!/usr/bin/env node
/*
 * Backtests the xP model against every finished gameweek.
 *
 *   node eval/backtest.cjs <dataRoot> [--out <dir>] [--tune] [--season 2026-27]
 *
 * <dataRoot> holds what eval/fetch.cjs writes: <season>/bootstrap.json,
 * fixtures.json, live/gw<N>.json and, where the scheduled workflow caught
 * them, snapshots/pre-gw<N>.json.
 *
 * For each finished gameweek T after the first, the model is run exactly as
 * the app would have run it before T's deadline — Code.js itself, loaded
 * through the test harness, with the clock set to just before the deadline —
 * and its projections are scored against what happened in T.
 *
 * What "as it stood before the deadline" means depends on the data:
 *   snapshot       the real pre-deadline player state, saved by the workflow:
 *                  FPL's own ep_next, injury status, chance of playing, form,
 *                  price. A faithful replay.
 *   reconstructed  rebuilt from the per-gameweek results of 1..T-1: points,
 *                  minutes, form, points-per-game, and ep_next set equal to
 *                  form (which is what the live API serves). The injury flags
 *                  as they were cannot be recovered after the fact, so the
 *                  replay runs without them — it tests the scoring model, not
 *                  the availability model. The report
 *                  says which gameweeks used which.
 *
 * Nothing here changes the model. --tune searches a few constants and
 * reports, with a leave-one-gameweek-out estimate, whether changing them
 * would actually help on gameweeks the search did not see.
 *
 * .cjs on purpose: clasp pushes any .js in the repo to Apps Script.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');

/* ---------------------------------------------------------------- data -- */

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function loadSeason(root, seasonArg) {
  let dir = root;
  if (!fs.existsSync(path.join(dir, 'bootstrap.json'))) {
    const seasons = fs.existsSync(root)
      ? fs.readdirSync(root).filter(d => /^\d{4}-\d{2}$/.test(d)).sort()
      : [];
    const season = seasonArg || seasons[seasons.length - 1];
    if (!season) throw new Error('No season data under ' + root + ' — run eval/fetch.cjs first.');
    dir = path.join(root, season);
  }
  const bootstrap = readJson(path.join(dir, 'bootstrap.json'));
  const fixtures = readJson(path.join(dir, 'fixtures.json'));
  const live = {};
  const liveDir = path.join(dir, 'live');
  if (fs.existsSync(liveDir)) {
    fs.readdirSync(liveDir).forEach(f => {
      const m = f.match(/^gw(\d+)\.json$/);
      if (m) live[Number(m[1])] = readJson(path.join(liveDir, f));
    });
  }
  const snapshots = {};
  const snapDir = path.join(dir, 'snapshots');
  if (fs.existsSync(snapDir)) {
    fs.readdirSync(snapDir).forEach(f => {
      const m = f.match(/^pre-gw(\d+)\.json$/);
      if (m) snapshots[Number(m[1])] = readJson(path.join(snapDir, f));
    });
  }
  return { dir, season: path.basename(dir), bootstrap, fixtures, live, snapshots };
}

/** Per-player, per-gameweek points and minutes from the live files. */
function indexLive(live) {
  const byGw = {};
  Object.keys(live).forEach(gw => {
    const m = {};
    (live[gw].elements || []).forEach(e => {
      const s = e.stats || {};
      m[e.id] = {
        points: s.total_points || 0, minutes: s.minutes || 0, starts: s.starts || 0,
        xgi: parseFloat(s.expected_goal_involvements) || 0,
        xg: parseFloat(s.expected_goals) || 0, xa: parseFloat(s.expected_assists) || 0,
        xgc: parseFloat(s.expected_goals_conceded) || 0,
        saves: s.saves || 0, bonus: s.bonus || 0, cs: s.clean_sheets || 0, gc: s.goals_conceded || 0,
        // Absent from files written before format 2 — kept as null, not 0, so
        // the model falls back to its prior instead of reading "no actions".
        dc: s.defensive_contribution != null ? s.defensive_contribution : null
      };
    });
    byGw[gw] = m;
  });
  return byGw;
}

/**
 * Every season-cumulative field as it stood before gameweek T, rebuilt from
 * the results of 1..T-1. Used for BOTH replay kinds: the latest bootstrap
 * carries today's season totals, and letting any of them through would hand
 * a replay of GW3 the results of GW4 and GW5.
 */
function cumulativeAsOf(el, liveIdx, played, T) {
  const c = { total: 0, mins: 0, apps: 0, xgi: 0, starts: 0, xg: 0, xa: 0, xgc: 0, saves: 0, bonus: 0, cs: 0, gc: 0, dc: 0, dcKnown: true };
  const recent = [];
  for (let gw = 1; gw < T; gw++) {
    const r = liveIdx[gw] && liveIdx[gw][el.id];
    const teamPlayed = played[el.team] && played[el.team][gw];
    if (r) {
      c.total += r.points; c.mins += r.minutes; c.xgi += r.xgi; c.starts += r.starts;
      c.xg += r.xg; c.xa += r.xa; c.xgc += r.xgc; c.saves += r.saves; c.bonus += r.bonus; c.cs += r.cs; c.gc += r.gc;
      if (r.dc == null) c.dcKnown = false; else c.dc += r.dc;
      if (r.minutes > 0) c.apps++;
    }
    if (teamPlayed) recent.push(r ? r.points : 0);
  }
  const last = recent.slice(-4);
  const form = last.length ? last.reduce((s, p) => s + p, 0) / last.length : 0;
  return {
    total_points: c.total, minutes: c.mins, starts: c.starts,
    form: form.toFixed(1),
    points_per_game: (c.apps ? c.total / c.apps : 0).toFixed(1),
    expected_goal_involvements: c.xgi.toFixed(2),
    expected_goal_involvements_per_90: c.mins >= 90 ? (c.xgi / (c.mins / 90)).toFixed(2) : '0.00',
    expected_goals: c.xg.toFixed(2), expected_assists: c.xa.toFixed(2), expected_goals_conceded: c.xgc.toFixed(2),
    saves: c.saves, bonus: c.bonus, clean_sheets: c.cs, goals_conceded: c.gc,
    defensive_contribution: c.dcKnown ? c.dc : null
  };
}

// Season-to-date fields a snapshot may lack (older snapshots predate them);
// taken from the as-of rebuild, never from today's bootstrap.
const UNDERLYING = ['expected_goals', 'expected_assists', 'expected_goals_conceded', 'saves', 'bonus',
  'clean_sheets', 'goals_conceded', 'defensive_contribution', 'starts'];

/** Teams with a fixture in each gameweek — form averages over the team's matches. */
function teamGws(fixtures) {
  const out = {};
  fixtures.forEach(f => {
    if (!f.event) return;
    [f.team_h, f.team_a].forEach(t => { (out[t] = out[t] || {})[f.event] = true; });
  });
  return out;
}

/**
 * The bootstrap as it stood before gameweek T's deadline. Static facts
 * (club, position, name) come from the latest bootstrap; everything that
 * moves comes from the snapshot when there is one, and is rebuilt from
 * results 1..T-1 when there is not.
 */
function asOfBootstrap(data, liveIdx, played, T) {
  const latest = data.bootstrap;
  const events = latest.events.map(e => Object.assign({}, e, {
    finished: e.id < T, data_checked: e.id < T,
    is_current: e.id === T - 1, is_next: e.id === T, is_previous: e.id === T - 2,
    average_entry_score: e.id < T ? (e.average_entry_score || 50) : 0
  }));

  const snap = data.snapshots[T];
  if (snap) {
    const staticById = {};
    latest.elements.forEach(el => { staticById[el.id] = el; });
    return {
      source: 'snapshot',
      bootstrap: {
        teams: latest.teams, events,
        elements: snap.elements.map(el => {
          const base = staticById[el.id] || {};
          const merged = Object.assign({}, base, el);
          const asOf = cumulativeAsOf(merged, liveIdx, played, T);
          UNDERLYING.forEach(k => { merged[k] = asOf[k]; });
          return merged;
        })
      }
    };
  }

  const elements = latest.elements.map(el => Object.assign({}, el, cumulativeAsOf(el, liveIdx, played, T), {
    // FPL's ep_next IS form on the live API (354 of 355 fit players before
    // GW6 of 2026-27), so the replay sets it the same way the app sees it.
    ep_next: null, ep_this: null,
    // Not recoverable after the fact — see the header comment.
    status: 'a', chance_of_playing_next_round: null, news: ''
  })).map(el => Object.assign(el, { ep_next: el.form, ep_this: el.form }));
  return { source: 'reconstructed', bootstrap: { teams: latest.teams, events, elements } };
}

function asOfFixtures(fixtures, T) {
  return fixtures.map(f => Object.assign({}, f, { finished: f.event != null && f.event < T }));
}

/* --------------------------------------------------------------- model -- */

function loadModel() {
  // A fresh context per run, kept out of the module cache, so constants
  // changed by --tune can never leak into a later run or another caller.
  const key = require.resolve(path.join(REPO, 'test', 'harness.cjs'));
  const cached = require.cache[key];
  delete require.cache[key];
  const S = require(key);
  delete require.cache[key];
  if (cached) require.cache[key] = cached;
  return S;
}

const TUNABLE = ['XP_FIXTURE_SWING_ATT', 'XP_FIXTURE_SWING_DEF', 'XP_FIRST_GW_DAMP', 'XP_HOME_EDGE', 'XP_PRIOR_MATCHES'];

/** Runs the model for gameweek T; returns rows of { id, pos, price, pred, perGw }. */
function projectGw(S, data, liveIdx, played, T, overrides) {
  const deadline = Date.parse((data.bootstrap.events.filter(e => e.id === T)[0] || {}).deadline_time);
  vm.runInContext('Date.now = function () { return ' + (deadline - 3600 * 1000) + '; };', S);
  Object.keys(overrides || {}).forEach(k => { S[k] = overrides[k]; });

  const asOf = asOfBootstrap(data, liveIdx, played, T);
  const boot = asOf.bootstrap;
  S.SEASON_CONTEXT_ = S.loadSeasonContext_(boot);
  S.PRICE_NORM_ = S.loadPriceNorms_(boot);
  S.CALIBRATION_ = false;          // the raw model — calibration is what this measures
  S.COMMUNITY_SIGNAL_ = { mentions: {}, panel: {} };
  const fx = asOfFixtures(data.fixtures, T);
  const fe = S.buildFixtureEaseMap_(boot, fx, S.LOOKAHEAD_GWS);
  S.TEAM_RATES_ = S.loadTeamRates_(boot, fx);

  const rows = [];
  boot.elements.forEach(el => {
    if (el.status === 'u') return;
    const xp = S.projectPoints_(el, fe);
    if (!xp.perGw.length || xp.perGw[0].event !== T) return;
    rows.push({
      id: el.id, name: el.web_name, pos: el.element_type, team: el.team, price: el.now_cost / 10,
      pred: xp.perGw[0].xp, perGw: xp.perGw.map(g => ({ event: g.event, xp: g.xp })),
      form: parseFloat(el.form) || 0, ppg: parseFloat(el.points_per_game) || 0,
      epNext: parseFloat(el.ep_next) || 0, minutesBefore: el.minutes || 0
    });
  });
  return { source: asOf.source, rows };
}

/* ------------------------------------------------------------- metrics -- */

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }

function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(values.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function spearman(x, y) {
  if (x.length < 3) return NaN;
  const rx = ranks(x), ry = ranks(y);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}

function errorStats(pairs) {
  const n = pairs.length;
  const pred = pairs.map(p => p.pred), act = pairs.map(p => p.actual);
  const mp = mean(pred), ma = mean(act);
  return {
    n,
    mae: mean(pairs.map(p => Math.abs(p.actual - p.pred))),
    rmse: Math.sqrt(mean(pairs.map(p => (p.actual - p.pred) ** 2))),
    meanPred: mp, meanActual: ma,
    // What the projection should have been multiplied by to land on reality.
    ratio: mp ? ma / mp : NaN
  };
}

/** Within-position rank correlation, averaged over positions and gameweeks. */
function rankStats(byGw, key) {
  const rhos = [];
  Object.keys(byGw).forEach(gw => {
    [1, 2, 3, 4].forEach(pos => {
      const rows = byGw[gw].filter(r => r.pos === pos);
      const rho = spearman(rows.map(r => r[key]), rows.map(r => r.actual));
      if (isFinite(rho)) rhos.push(rho);
    });
  });
  return mean(rhos);
}

/**
 * The decision-shaped metric: if you took this predictor's top K at each
 * position, how many points did they actually score — and how much did the
 * predictor PROMISE for them? Promised far above delivered is the optimiser's
 * curse: picking the maximum of noisy estimates selects the ones that are
 * too high, which is exactly what a transfer engine does.
 */
function topK(byGw, key, k) {
  const delivered = [], promised = [], oracle = [];
  Object.keys(byGw).forEach(gw => {
    [1, 2, 3, 4].forEach(pos => {
      const rows = byGw[gw].filter(r => r.pos === pos);
      const top = rows.slice().sort((a, b) => b[key] - a[key]).slice(0, k);
      const best = rows.slice().sort((a, b) => b.actual - a.actual).slice(0, k);
      top.forEach(r => { delivered.push(r.actual); promised.push(r.pred); });
      best.forEach(r => oracle.push(r.actual));
    });
  });
  return { delivered: mean(delivered), promised: mean(promised), oracle: mean(oracle) };
}

function calibrationBuckets(rows) {
  const edges = [0, 1, 2, 3, 4, 5, 6, 8, 100];
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const b = rows.filter(r => r.pred >= edges[i] && r.pred < edges[i + 1]);
    if (!b.length) continue;
    out.push({ range: edges[i] + (edges[i + 1] >= 100 ? '+' : '–' + edges[i + 1]), n: b.length,
      meanPred: mean(b.map(r => r.pred)), meanActual: mean(b.map(r => r.actual)) });
  }
  return out;
}

/** Deterministic bootstrap CI for a mean of paired differences. */
function bootstrapCi(diffs, reps) {
  if (diffs.length < 10) return null;
  let s = 12345;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const means = [];
  for (let r = 0; r < (reps || 1000); r++) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(rand() * diffs.length)];
    means.push(sum / diffs.length);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(means.length * 0.025)], hi: means[Math.floor(means.length * 0.975)] };
}

/* ----------------------------------------------------------------- run -- */

/**
 * The evaluation population: players who had played before T (so every
 * predictor has something to go on) or whom the model projects at 1+.
 * Selection is on information available before the deadline, never on the
 * outcome — selecting on "played in T" would flatter every predictor.
 */
function population(rows) {
  return rows.filter(r => r.minutesBefore > 0 || r.pred >= 1);
}

function evaluate(data, overrides) {
  const S = loadModel();
  const liveIdx = indexLive(data.live);
  const played = teamGws(data.fixtures);
  const finished = Object.keys(liveIdx).map(Number).sort((a, b) => a - b);
  const targets = finished.filter(gw => gw >= 2);
  const byGw = {}, sources = {}, horizon = {};

  targets.forEach(T => {
    const run = projectGw(S, data, liveIdx, played, T, overrides);
    sources[T] = run.source;
    const pop = population(run.rows);
    pop.forEach(r => {
      const a = liveIdx[T][r.id];
      r.actual = a ? a.points : 0;
      // Baselines, each a number a manager could have read before the deadline.
      let last3 = [], seen = 0;
      for (let gw = T - 1; gw >= 1 && seen < 3; gw--) {
        if (played[r.team] && played[r.team][gw]) { last3.push(liveIdx[gw] && liveIdx[gw][r.id] ? liveIdx[gw][r.id].points : 0); seen++; }
      }
      r.last3 = last3.length ? mean(last3) : 0;
      // Horizon: the projection for T+k against what T+k delivered, where known.
      r.perGw.forEach((g, k) => {
        if (!liveIdx[g.event]) return;
        const act = liveIdx[g.event][r.id] ? liveIdx[g.event][r.id].points : 0;
        const h = horizon[k] || (horizon[k] = { pred: 0, actual: 0, n: 0 });
        h.pred += g.xp; h.actual += act; h.n++;
      });
    });
    byGw[T] = pop;
  });
  const provisional = targets.filter(T => data.live[T] && data.live[T].provisional);
  return { byGw, sources, horizon, targets, provisional };
}

const PREDICTORS = [
  { key: 'pred', label: 'This model (raw xP)' },
  { key: 'epNext', label: 'FPL ep_next', needsSnapshot: true },
  { key: 'form', label: 'Form (last ~4 GWs)' },
  { key: 'ppg', label: 'Points per appearance' },
  { key: 'last3', label: 'Mean of last 3 gameweeks' }
];

function summarise(ev) {
  const all = [].concat(...Object.values(ev.byGw));
  const snapGws = Object.keys(ev.sources).filter(g => ev.sources[g] === 'snapshot');
  const out = { targets: ev.targets, sources: ev.sources, provisional: ev.provisional || [], n: all.length, predictors: {} };

  PREDICTORS.forEach(p => {
    let rows = all, byGw = ev.byGw;
    if (p.needsSnapshot) {
      if (!snapGws.length) return;
      rows = [].concat(...snapGws.map(g => ev.byGw[g]));
      byGw = {}; snapGws.forEach(g => { byGw[g] = ev.byGw[g]; });
    }
    const pairs = rows.map(r => ({ pred: r[p.key], actual: r.actual }));
    out.predictors[p.key] = Object.assign({ label: p.label, gws: Object.keys(byGw).length },
      errorStats(pairs), { spearman: rankStats(byGw, p.key), top10: topK(byGw, p.key, 10) });
    // topK's "promised" is always the MODEL's figure for those players; only
    // meaningful for the model itself.
    if (p.key !== 'pred') delete out.predictors[p.key].top10.promised;
  });

  const byPos = {};
  [1, 2, 3, 4].forEach(pos => {
    byPos[pos] = errorStats(all.filter(r => r.pos === pos).map(r => ({ pred: r.pred, actual: r.actual })));
  });
  out.byPosition = byPos;

  const bands = [[0, 5.5, '< £5.5m'], [5.5, 7.5, '£5.5–7.5m'], [7.5, 10, '£7.5–10m'], [10, 99, '£10m+']];
  out.byPrice = bands.map(b => Object.assign({ band: b[2] },
    errorStats(all.filter(r => r.price >= b[0] && r.price < b[1]).map(r => ({ pred: r.pred, actual: r.actual })))));

  out.buckets = calibrationBuckets(all);

  // Is the model better than the best simple baseline, beyond noise?
  const baselines = ['form', 'ppg', 'last3'].map(k => out.predictors[k]).filter(Boolean);
  const best = baselines.sort((a, b) => a.mae - b.mae)[0];
  if (best) {
    const key = Object.keys(out.predictors).filter(k => out.predictors[k] === best)[0];
    const diffs = all.map(r => Math.abs(r.actual - r.pred) - Math.abs(r.actual - r[key]));
    out.vsBestBaseline = { baseline: best.label, maeDiff: mean(diffs), ci: bootstrapCi(diffs) };
  }

  out.horizon = Object.keys(ev.horizon).map(Number).sort((a, b) => a - b).map(k => ({
    offset: k, n: ev.horizon[k].n,
    ratio: ev.horizon[k].pred ? ev.horizon[k].actual / ev.horizon[k].pred : NaN
  }));
  return out;
}

/* ---------------------------------------------------------------- tune -- */

const GRID = {
  XP_FIXTURE_SWING_ATT: [0.10, 0.15, 0.20],
  XP_FIXTURE_SWING_DEF: [0.10, 0.20, 0.30],
  XP_FIRST_GW_DAMP: [0.5, 1],
  XP_HOME_EDGE: [0.02, 0.06],
  XP_PRIOR_MATCHES: [3, 5, 8]
};

function gridConfigs() {
  let configs = [{}];
  Object.keys(GRID).forEach(k => {
    const next = [];
    configs.forEach(c => GRID[k].forEach(v => next.push(Object.assign({}, c, { [k]: v }))));
    configs = next;
  });
  return configs;
}

/** Per-gameweek MAE for a config, so it can be held out a week at a time. */
function maeByGw(data, overrides) {
  const ev = evaluate(data, overrides);
  const out = {};
  Object.keys(ev.byGw).forEach(g => {
    const rows = ev.byGw[g];
    out[g] = { sum: rows.reduce((s, r) => s + Math.abs(r.actual - r.pred), 0), n: rows.length };
  });
  return out;
}

function tune(data) {
  const S = loadModel();
  const current = {};
  TUNABLE.forEach(k => { current[k] = S[k]; });
  const configs = gridConfigs();
  const results = configs.map(c => ({ config: c, byGw: maeByGw(data, c) }));
  const gws = Object.keys(results[0].byGw);
  const pooled = (r, only) => {
    let sum = 0, n = 0;
    (only || gws).forEach(g => { sum += r.byGw[g].sum; n += r.byGw[g].n; });
    return n ? sum / n : NaN;
  };
  const currentRes = results.filter(r => TUNABLE.every(k => r.config[k] === current[k]))[0] ||
    { config: current, byGw: maeByGw(data, current) };

  const inSample = results.slice().sort((a, b) => pooled(a) - pooled(b))[0];

  // Leave one gameweek out: choose on the others, score on the one held out.
  // This is the honest estimate of what tuning buys; the in-sample winner
  // always looks better than it is.
  let tunedSum = 0, curSum = 0, n = 0;
  const picks = [];
  if (gws.length >= 2) {
    gws.forEach(held => {
      const train = gws.filter(g => g !== held);
      const choice = results.slice().sort((a, b) => pooled(a, train) - pooled(b, train))[0];
      picks.push({ heldOut: held, config: choice.config });
      tunedSum += choice.byGw[held].sum; curSum += currentRes.byGw[held].sum; n += choice.byGw[held].n;
    });
  }
  return {
    current, currentMae: pooled(currentRes),
    inSample: { config: inSample.config, mae: pooled(inSample) },
    logo: n ? { tunedMae: tunedSum / n, currentMae: curSum / n, picks } : null,
    gws: gws.length, configs: configs.length
  };
}

/* ------------------------------------------------------ v1 vs v2 -- */

/* The component model (projectPointsV2_) against the points-trend model
 * (projectPointsV1_), and blends of the two. The blend weight is chosen
 * leave-one-gameweek-out like every other constant here, so the reported
 * gain is on gameweeks the choice never saw. */
const V2_WEIGHTS = [0, 0.25, 0.5, 0.75, 1];

function modelOverrides(w) {
  return w === 0 ? { XP_MODEL: 'v1' } : (w === 1 ? { XP_MODEL: 'v2' } : { XP_MODEL: 'blend', XP_V2_WEIGHT: w });
}

function compareModels(data) {
  const rows = V2_WEIGHTS.map(w => {
    const ev = evaluate(data, modelOverrides(w));
    const s = summarise(ev);
    const m = s.predictors.pred;
    const byGw = {};
    Object.keys(ev.byGw).forEach(g => {
      byGw[g] = { sum: ev.byGw[g].reduce((a, r) => a + Math.abs(r.actual - r.pred), 0), n: ev.byGw[g].length };
    });
    return { weight: w, mae: m.mae, spearman: m.spearman, ratio: m.ratio, top10: m.top10,
      byPrice: s.byPrice.map(b => b.ratio), byPos: [1, 2, 3, 4].map(p => s.byPosition[p].ratio), byGw };
  });
  const gws = Object.keys(rows[0].byGw);
  const pooled = (r, only) => { let a = 0, n = 0; (only || gws).forEach(g => { a += r.byGw[g].sum; n += r.byGw[g].n; }); return a / n; };
  let logo = null;
  if (gws.length >= 2) {
    let chosenSum = 0, v1Sum = 0, n = 0;
    const picks = [];
    gws.forEach(held => {
      const train = gws.filter(g => g !== held);
      const best = rows.slice().sort((a, b) => pooled(a, train) - pooled(b, train))[0];
      picks.push({ heldOut: held, weight: best.weight });
      chosenSum += best.byGw[held].sum; v1Sum += rows[0].byGw[held].sum; n += best.byGw[held].n;
    });
    logo = { chosenMae: chosenSum / n, v1Mae: v1Sum / n, picks };
  }
  const S = loadModel();
  const live = S.XP_MODEL === 'blend' ? 'a ' + Math.round(S.XP_V2_WEIGHT * 100) + '% v2 blend' : S.XP_MODEL;
  return { rows, logo, live };
}

/* -------------------------------------------------------------- report -- */

function f(x, d) { return x == null || !isFinite(x) ? '—' : Number(x).toFixed(d == null ? 2 : d); }
const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

function markdown(season, s, t, cmp) {
  const L = [];
  const m = s.predictors.pred;
  L.push('# Model backtest — ' + season);
  L.push('');
  const prov = s.provisional || [];
  L.push('Gameweeks scored: ' + s.targets.map(g => 'GW' + g + ' (' + s.sources[g] +
    (prov.indexOf(g) >= 0 ? ', provisional' : '') + ')').join(', ') + '. ' + s.n + ' player-gameweeks.');
  if (prov.length) {
    L.push('');
    L.push('> **Provisional**: every match has a score but FPL has not yet marked the gameweek finished, so bonus and ' +
      'late corrections can still move a point. The workflow re-scores it on every run until FPL confirms it.');
  }
  if (Object.values(s.sources).some(x => x === 'reconstructed')) {
    L.push('');
    L.push('> **Reconstructed** gameweeks are replayed from results only, with `ep_next` set to form (which is what FPL serves). ' +
      'The injury flags as they stood before the deadline cannot be recovered afterwards, so those weeks test the scoring model, ' +
      'not the availability model. Gameweeks marked **snapshot** use the real pre-deadline state saved by the workflow.');
  }
  L.push('');
  L.push('## Headline');
  L.push('');
  if (s.vsBestBaseline) {
    const v = s.vsBestBaseline;
    const better = v.ci && v.ci.hi < 0, worse = v.ci && v.ci.lo > 0;
    L.push('- Against the best simple baseline (' + v.baseline + '): mean absolute error ' +
      (v.maeDiff < 0 ? 'lower' : 'higher') + ' by ' + f(Math.abs(v.maeDiff)) + ' pts per player-gameweek' +
      (v.ci ? ' (95% CI ' + f(v.ci.lo) + ' to ' + f(v.ci.hi) + ')' : '') + ' — ' +
      (better ? '**the model is genuinely better**.' : worse ? '**the model is genuinely worse; a simple baseline beats it**.' :
        'not distinguishable from noise yet.'));
  }
  L.push('- Overall the model projects ' + f(m.meanPred) + ' per player-gameweek against ' + f(m.meanActual) +
    ' actual — real points were ' + f(m.ratio, 2) + '× the projection' +
    (Math.abs(m.ratio - 1) < 0.05 ? ' (well calibrated).' : (m.ratio < 1 ? ' (**runs hot**).' : ' (**runs cold**).')));
  if (m.top10) {
    L.push('- Its top 10 per position were promised ' + f(m.top10.promised) + ' each and delivered ' + f(m.top10.delivered) +
      ' (the best 10 in hindsight scored ' + f(m.top10.oracle) + '). Promised ÷ delivered = ' +
      f(m.top10.promised / m.top10.delivered) + ' — above 1 is the optimiser’s curse that inflates transfer and Wildcard gains.');
  }
  L.push('');
  L.push('## Against baselines');
  L.push('');
  L.push('| Predictor | GWs | MAE | RMSE | Rank corr. (within position) | Top-10 delivered |');
  L.push('|---|---:|---:|---:|---:|---:|');
  Object.keys(s.predictors).forEach(k => {
    const p = s.predictors[k];
    L.push('| ' + p.label + ' | ' + p.gws + ' | ' + f(p.mae) + ' | ' + f(p.rmse) + ' | ' + f(p.spearman, 3) + ' | ' + f(p.top10.delivered) + ' |');
  });
  L.push('');
  L.push('Ranking matters more than the raw error: every decision the app makes is a choice between players.');
  L.push('');
  L.push('## Bias by position — the calibration the app should apply');
  L.push('');
  L.push('| Position | n | Projected | Actual | Actual ÷ projected | MAE |');
  L.push('|---|---:|---:|---:|---:|---:|');
  [1, 2, 3, 4].forEach(p => {
    const r = s.byPosition[p];
    L.push('| ' + POS[p] + ' | ' + r.n + ' | ' + f(r.meanPred) + ' | ' + f(r.meanActual) + ' | ' + f(r.ratio) + ' | ' + f(r.mae) + ' |');
  });
  L.push('');
  L.push('## Bias by price');
  L.push('');
  L.push('| Price | n | Projected | Actual | Actual ÷ projected |');
  L.push('|---|---:|---:|---:|---:|');
  s.byPrice.forEach(r => L.push('| ' + r.band + ' | ' + r.n + ' | ' + f(r.meanPred) + ' | ' + f(r.meanActual) + ' | ' + f(r.ratio) + ' |'));
  L.push('');
  L.push('## Calibration buckets');
  L.push('');
  L.push('When the model says *x*, what happens on average?');
  L.push('');
  L.push('| Projected | n | Mean projected | Mean actual |');
  L.push('|---|---:|---:|---:|');
  s.buckets.forEach(b => L.push('| ' + b.range + ' | ' + b.n + ' | ' + f(b.meanPred) + ' | ' + f(b.meanActual) + ' |'));
  if (s.horizon.length > 1) {
    L.push('');
    L.push('## Further out');
    L.push('');
    L.push('| Gameweeks ahead | n | Actual ÷ projected |');
    L.push('|---:|---:|---:|');
    s.horizon.forEach(h => L.push('| ' + (h.offset + 1) + ' | ' + h.n + ' | ' + f(h.ratio) + ' |'));
    L.push('');
    L.push('A ratio that falls with distance means the form edge is decaying too slowly (`XP_FORM_HALF_LIFE_GWS`).');
  }
  if (cmp) {
    L.push('');
    L.push('## v1 (points trend) against v2 (component model)');
    L.push('');
    L.push('| v2 weight | MAE | Rank corr. | Top 10 promised → delivered | Actual ÷ projected | GKP / DEF / MID / FWD | £10m+ |');
    L.push('|---:|---:|---:|---|---:|---|---:|');
    cmp.rows.forEach(r => {
      L.push('| ' + (r.weight === 0 ? '0 (v1)' : r.weight === 1 ? '1 (v2)' : r.weight) + ' | ' + f(r.mae, 3) + ' | ' + f(r.spearman, 3) + ' | ' +
        f(r.top10.promised) + ' → ' + f(r.top10.delivered) + ' | ' + f(r.ratio) + ' | ' + r.byPos.map(x => f(x)).join(' / ') + ' | ' + f(r.byPrice[3]) + ' |');
    });
    if (cmp.logo) {
      const gain = cmp.logo.v1Mae - cmp.logo.chosenMae;
      L.push('');
      L.push('Leave-one-gameweek-out (weight chosen on the other weeks, scored on the held-out one): ' + f(cmp.logo.chosenMae, 3) +
        ' against v1\u2019s ' + f(cmp.logo.v1Mae, 3) + ', weights picked ' + cmp.logo.picks.map(p => 'GW' + p.heldOut + ':' + p.weight).join(', ') + '. ' +
        (gain > 0.02 ? '**v2 helps out of sample** at the most-picked weight.' : 'No weight is a clear out-of-sample win over v1 yet.') +
        (cmp.live ? ' The app currently runs ' + cmp.live + '.' : ''));
    }
  }
  if (t) {
    L.push('');
    L.push('## Tuning (' + t.configs + ' configurations of ' + TUNABLE.join(', ') + ')');
    L.push('');
    L.push('- Current constants ' + JSON.stringify(t.current) + ': MAE ' + f(t.currentMae, 3) + '.');
    L.push('- Best in sample ' + JSON.stringify(t.inSample.config) + ': MAE ' + f(t.inSample.mae, 3) + ' — optimistic by construction.');
    if (t.logo) {
      const gain = t.logo.currentMae - t.logo.tunedMae;
      L.push('- Leave-one-gameweek-out (choose on the others, score on the one held out): tuned ' + f(t.logo.tunedMae, 3) +
        ' against current ' + f(t.logo.currentMae, 3) + '. ' +
        (gain > 0.02 ? '**Tuning helps out of sample** — consider the in-sample constants.' :
          'Tuning does not beat the current constants out of sample; **leave them**.'));
    }
  }
  L.push('');
  L.push('_Generated ' + new Date().toISOString() + ' by eval/backtest.cjs._');
  return L.join('\n') + '\n';
}

/* ---------------------------------------------------------------- main -- */

function run(argv) {
  const args = argv.slice(2);
  const root = args[0] && !args[0].startsWith('--') ? args[0] : path.join(__dirname, 'data');
  const flag = name => args.indexOf(name) !== -1;
  const opt = name => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };

  const data = loadSeason(root, opt('--season'));
  const finished = Object.keys(data.live).length;
  if (finished < 2) {
    const msg = '# Model backtest — ' + data.season + '\n\nOnly ' + finished +
      ' finished gameweek(s) on disk; the backtest needs at least two (one to learn from, one to score).\n';
    return { markdown: msg, summary: null };
  }
  const ev = evaluate(data, {});
  const summary = summarise(ev);
  const tuning = flag('--tune') ? tune(data) : null;
  const comparison = flag('--no-compare') ? null : compareModels(data);
  const md = markdown(data.season, summary, tuning, comparison);

  const out = opt('--out');
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'latest.md'), md);
    const record = { at: new Date().toISOString(), season: data.season, summary, tuning, comparison };
    fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(record, null, 1));
    // One line per run, so the trend is visible as the season goes on.
    fs.appendFileSync(path.join(out, 'history.jsonl'), JSON.stringify({
      at: record.at, season: data.season, gws: summary.targets, provisional: summary.provisional,
      mae: summary.predictors.pred.mae, ratio: summary.predictors.pred.ratio,
      spearman: summary.predictors.pred.spearman,
      vsBaseline: summary.vsBestBaseline ? summary.vsBestBaseline.maeDiff : null
    }) + '\n');
  }
  return { markdown: md, summary, tuning, comparison };
}

if (require.main === module) {
  try {
    const res = run(process.argv);
    process.stdout.write(res.markdown);
  } catch (err) {
    console.error(String(err && err.stack || err));
    process.exit(1);
  }
}

module.exports = { run, evaluate, summarise, tune, compareModels, asOfBootstrap, indexLive, teamGws, spearman, loadSeason };
