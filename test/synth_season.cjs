// A deterministic synthetic FPL season: twenty clubs, a full fixture list,
// ~360 players with a hidden "true" scoring rate, and real-shaped API
// responses for the first N finished gameweeks.
//
// Used by test_backtest.cjs (written out in the shape eval/fetch.cjs saves)
// and test_dashboard_e2e.cjs (served through a stubbed UrlFetchApp), so the
// whole pipeline can be exercised with no network. Not a test itself — the
// runner only picks up files starting with test_.

function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(lambda, rand) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

const CLUBS = ['ARS', 'AVL', 'BOU', 'BRE', 'BHA', 'CHE', 'CRY', 'EVE', 'FUL', 'HUL',
  'LIV', 'MCI', 'MUN', 'NEW', 'NFO', 'SUN', 'TOT', 'WHU', 'WOL', 'LEE'];

/**
 * opts: { seed, finishedGws, nowMs?, teamId }
 * Returns { now, season, raw: {bootstrap, fixtures, live:{gw:..}, summaries:{id:..}, entry, history, picks:{gw:..}},
 *           truth: { rateById } }
 */
function makeSeason(opts) {
  const o = Object.assign({ seed: 7, finishedGws: 5, teamId: 1234567 }, opts || {});
  const rand = rng(o.seed);
  const start = Date.parse('2026-08-14T17:30:00Z');
  const WEEK = 7 * 24 * 3600 * 1000;

  // --- clubs: a latent strength drives both attack and defence ---------------
  const teams = CLUBS.map((short, i) => {
    const q = rand();
    const att = Math.round(1000 + q * 350 + rand() * 60);
    const def = Math.round(1000 + q * 350 + rand() * 60);
    return {
      id: i + 1, name: 'Club ' + short, short_name: short, strength: 2 + Math.round(q * 3), q,
      strength_attack_home: att + 40, strength_attack_away: att - 20,
      strength_defence_home: def + 40, strength_defence_away: def - 20
    };
  });

  // --- fixtures: double round robin by the circle method --------------------
  const ids = teams.map(t => t.id);
  const rounds = [];
  const arr = ids.slice();
  for (let r = 0; r < 19; r++) {
    const pairs = [];
    for (let i = 0; i < 10; i++) {
      const a = arr[i], b = arr[19 - i];
      pairs.push(r % 2 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop());
  }
  rounds.slice().forEach(p => rounds.push(p.map(([h, a]) => [a, h])));
  const teamById = {}; teams.forEach(t => { teamById[t.id] = t; });
  const fdr = (oppId) => Math.max(2, Math.min(5, 1 + teamById[oppId].strength));
  let fid = 1;
  const fixtures = [];
  rounds.forEach((pairs, r) => {
    pairs.forEach(([h, a]) => {
      fixtures.push({
        id: fid++, event: r + 1, team_h: h, team_a: a,
        team_h_difficulty: fdr(a), team_a_difficulty: fdr(h),
        finished: r + 1 <= o.finishedGws,
        kickoff_time: new Date(start + r * WEEK + 20 * 3600 * 1000).toISOString(),
        team_h_score: null, team_a_score: null
      });
    });
  });

  const events = [];
  for (let gw = 1; gw <= 38; gw++) {
    events.push({
      id: gw, name: 'Gameweek ' + gw,
      deadline_time: new Date(start + (gw - 1) * WEEK).toISOString(),
      finished: gw <= o.finishedGws, data_checked: gw <= o.finishedGws,
      is_current: gw === o.finishedGws, is_next: gw === o.finishedGws + 1,
      is_previous: gw === o.finishedGws - 1,
      average_entry_score: gw <= o.finishedGws ? 50 : 0, highest_score: gw <= o.finishedGws ? 110 : null
    });
  }
  const now = o.nowMs != null ? o.nowMs : start + o.finishedGws * WEEK - 2 * 24 * 3600 * 1000;

  // --- players ---------------------------------------------------------------
  const SHAPE = { 1: 2, 2: 6, 3: 6, 4: 4 };
  const players = [];
  let pid = 1;
  teams.forEach(t => {
    [1, 2, 3, 4].forEach(pos => {
      for (let k = 0; k < SHAPE[pos]; k++) {
        const nailed = k < (pos === 1 ? 1 : pos === 2 ? 4 : pos === 3 ? 4 : 2);
        const talent = rand();
        // Returns per match beyond the 2 appearance points, by position.
        const rate = (pos === 1 ? 1.0 : pos === 2 ? 1.3 : pos === 3 ? 1.6 : 1.9) *
          (0.4 + talent * 1.2) * (0.7 + t.q * 0.6);
        const pStart = nailed ? 0.93 : (k === SHAPE[pos] - 1 ? 0.08 : 0.4);
        players.push({
          id: pid, web_name: t.short_name + '_' + POS[pos] + (k + 1), first_name: 'P', second_name: String(pid),
          team: t.id, element_type: pos, rate, pStart,
          now_cost: Math.max(40, Math.min(150, Math.round(40 + rate * 18 + (nailed ? 5 : 0)) )),
          injured: rand() < 0.04, doubt: rand() < 0.05
        });
        pid++;
      }
    });
  });

  // --- simulated outcomes for finished gameweeks -----------------------------
  const live = {};
  const cum = {};
  const historyById = {};
  players.forEach(p => { historyById[p.id] = []; });
  for (let gw = 1; gw <= o.finishedGws; gw++) {
    const elements = [];
    const gwFixtures = fixtures.filter(f => f.event === gw);
    const goals = {};
    players.forEach(p => {
      const f = gwFixtures.filter(x => x.team_h === p.team || x.team_a === p.team)[0];
      const home = f && f.team_h === p.team;
      const opp = f ? (home ? f.team_a : f.team_h) : null;
      const diff = f ? (home ? f.team_h_difficulty : f.team_a_difficulty) : 3;
      const plays = f && rand() < p.pStart;
      let mins = 0, pts = 0;
      if (plays) {
        mins = rand() < 0.85 ? 90 : 60 + Math.floor(rand() * 25);
        const lam = p.rate * (1 + (3 - diff) * 0.12) * (home ? 1.06 : 0.94);
        pts = 2 + poisson(Math.max(0.05, lam), rand) * (p.element_type >= 3 ? 2 : 1) - (rand() < 0.08 ? 1 : 0);
        if (pts >= 6) goals[p.team] = (goals[p.team] || 0) + 1;
      } else if (f && rand() < 0.2) {
        mins = 15; pts = 1;
      }
      const xg = plays ? Math.round(p.rate * 0.18 * 100) / 100 : 0;
      // Underlying stats for the component model: defensive actions by
      // position, saves for keepers, xG conceded by the opponent's quality.
      const dcMean = { 1: 0, 2: 8, 3: 6, 4: 3 }[p.element_type];
      const dc = plays ? poisson(dcMean * (mins / 90), rand) : 0;
      const oppQ = opp ? teamById[opp].q : 0.5;
      const xgc = mins ? Math.round((0.8 + oppQ) * (mins / 90) * 100) / 100 : 0;
      const saves = plays && p.element_type === 1 ? poisson(2.8, rand) : 0;
      elements.push({ id: p.id, stats: {
        minutes: mins, total_points: pts, starts: plays ? 1 : 0, goals_scored: 0, assists: 0,
        clean_sheets: 0, goals_conceded: 0, bonus: 0, expected_goals: String(xg),
        expected_assists: String(Math.round(xg * 0.6 * 100) / 100),
        expected_goal_involvements: String(xg), expected_goals_conceded: String(xgc), saves: saves,
        yellow_cards: 0, red_cards: 0, defensive_contribution: dc, bps: 0
      } });
      const cu = cum[p.id] || (cum[p.id] = { xg: 0, xa: 0, xgc: 0, saves: 0, dc: 0 });
      cu.xg += xg; cu.xa += Math.round(xg * 0.6 * 100) / 100; cu.xgc += xgc; cu.saves += saves; cu.dc += dc;
      if (f) {
        historyById[p.id].push({ round: gw, opponent_team: opp, was_home: home, minutes: mins, total_points: pts,
          goals_scored: 0, assists: 0, clean_sheets: 0, bonus: 0, yellow_cards: 0, red_cards: 0,
          team_h_score: 1, team_a_score: 1, value: p.now_cost });
      }
    });
    gwFixtures.forEach(f => { f.team_h_score = goals[f.team_h] || 0; f.team_a_score = goals[f.team_a] || 0; });
    live[gw] = { elements };
  }

  // --- the "now" bootstrap ------------------------------------------------
  const nextGw = o.finishedGws + 1;
  const elements = players.map(p => {
    const hist = historyById[p.id];
    const total = hist.reduce((s, h) => s + h.total_points, 0);
    const apps = hist.filter(h => h.minutes > 0).length;
    const lastN = hist.slice(-4);
    const form = lastN.length ? lastN.reduce((s, h) => s + h.total_points, 0) / lastN.length : 0;
    const mins = hist.reduce((s, h) => s + h.minutes, 0);
    const f = fixtures.filter(x => x.event === nextGw && (x.team_h === p.team || x.team_a === p.team))[0];
    const diff = f ? (f.team_h === p.team ? f.team_h_difficulty : f.team_a_difficulty) : 3;
    const status = p.injured ? 'i' : (p.doubt ? 'd' : 'a');
    const chance = p.injured ? 0 : (p.doubt ? 75 : null);
    const ep = (status === 'i' ? 0 : 1) * (chance != null ? chance / 100 : 1) *
      p.pStart * (2 + p.rate * (1 + (3 - diff) * 0.12) * (p.element_type >= 3 ? 2 : 1)) * (0.85 + rand() * 0.3);
    const xgi = hist.length ? Math.round(p.rate * 0.18 * apps * 100) / 100 : 0;
    return {
      id: p.id, web_name: p.web_name, first_name: p.first_name, second_name: p.second_name,
      team: p.team, element_type: p.element_type, now_cost: p.now_cost, cost_change_event: 0, cost_change_start: 0,
      status, news: p.injured ? 'Hamstring injury - unknown return date' : (p.doubt ? '75% chance of playing' : ''),
      chance_of_playing_next_round: chance,
      form: form.toFixed(1), points_per_game: (apps ? total / apps : 0).toFixed(1),
      total_points: total, minutes: mins, ep_next: ep.toFixed(1), ep_this: ep.toFixed(1),
      ict_index: String((p.rate * 10).toFixed(1)), event_points: hist.length ? hist[hist.length - 1].total_points : 0,
      bonus: 0, expected_goal_involvements: String(xgi),
      expected_goal_involvements_per_90: mins >= 90 ? (xgi / (mins / 90)).toFixed(2) : '0.00',
      expected_goals_per_90: '0.10', expected_assists_per_90: '0.10', expected_goals_conceded_per_90: '1.20',
      clean_sheets_per_90: '0.20', saves_per_90: '0.00', starts: hist.filter(h => h.minutes >= 60).length,
      starts_per_90: '1.00', selected_by_percent: String(Math.min(60, (p.rate * p.pStart * 12)).toFixed(1)),
      penalties_order: null, transfers_in_event: 1000, transfers_out_event: 1000,
      // Season totals for the component model.
      expected_goals: (cum[p.id] ? cum[p.id].xg : 0).toFixed(2),
      expected_assists: (cum[p.id] ? cum[p.id].xa : 0).toFixed(2),
      expected_goals_conceded: (cum[p.id] ? cum[p.id].xgc : 0).toFixed(2),
      saves: cum[p.id] ? cum[p.id].saves : 0,
      defensive_contribution: cum[p.id] ? cum[p.id].dc : 0,
      clean_sheets: 0, goals_conceded: 0
    };
  });

  const bootstrap = {
    elements,
    teams: teams.map(t => { const c = Object.assign({}, t); delete c.q; return c; }),
    events,
    element_types: [1, 2, 3, 4].map(id => ({ id, singular_name_short: POS[id] })),
    total_players: 9000000
  };

  // --- the manager: a legal fifteen, one injured starter, one doubt ---------
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  players.forEach(p => byPos[p.element_type].push(p));
  const club = {};
  const squad = [];
  const want = { 1: 2, 2: 5, 3: 5, 4: 3 };
  const injuredMid = players.filter(p => p.element_type === 3 && p.injured)[0];
  const doubtDef = players.filter(p => p.element_type === 2 && p.doubt && !p.injured)[0];
  [injuredMid, doubtDef].forEach(p => { if (p) { squad.push(p); club[p.team] = (club[p.team] || 0) + 1; want[p.element_type]--; } });
  [1, 2, 3, 4].forEach(pos => {
    const pool = byPos[pos].filter(p => !squad.includes(p) && !p.injured && p.now_cost <= 75)
      .sort((a, b) => (a.id * 7919) % 97 - (b.id * 7919) % 97);
    for (const p of pool) {
      if (want[pos] <= 0) break;
      if ((club[p.team] || 0) >= 3) continue;
      squad.push(p); club[p.team] = (club[p.team] || 0) + 1; want[pos]--;
    }
  });
  // Starting 1-4-4-2 including the injured midfielder and the doubtful defender.
  const gks = squad.filter(p => p.element_type === 1);
  const defs = squad.filter(p => p.element_type === 2);
  const mids = squad.filter(p => p.element_type === 3);
  const fwds = squad.filter(p => p.element_type === 4);
  const xi = [gks[0]].concat(defs.slice(0, 4), mids.slice(0, 4), fwds.slice(0, 2));
  const bench = [gks[1], defs[4], mids[4], fwds[2]];
  const picks = xi.concat(bench).map((p, i) => ({
    element: p.id, position: i + 1, multiplier: i === 8 ? 2 : (i < 11 ? 1 : 0),
    is_captain: i === 8, is_vice_captain: i === 9, selling_price: p.now_cost, purchase_price: p.now_cost
  }));
  const spent = squad.reduce((s, p) => s + p.now_cost, 0);
  // A realistic squad has little left in the bank: £1.5m.
  const bankTenths = 15;
  const picksResp = {
    active_chip: null, picks,
    entry_history: { event: o.finishedGws, points: 55, total_points: 270, bank: bankTenths, value: spent + bankTenths,
      event_transfers: 0, event_transfers_cost: 0, points_on_bench: 6 }
  };
  const entry = {
    id: o.teamId, name: 'Synthetic XI', player_first_name: 'Test', player_last_name: 'Manager',
    summary_overall_rank: 123456, last_deadline_bank: bankTenths, last_deadline_value: spent + bankTenths,
    leagues: { classic: [] }
  };
  const history = {
    current: Array.from({ length: o.finishedGws }, (_, i) => ({
      event: i + 1, points: 55, total_points: 55 * (i + 1), rank: 1e6, overall_rank: 1e6, bank: bankTenths,
      value: spent + bankTenths, event_transfers: i === 0 ? 0 : 1, event_transfers_cost: 0, points_on_bench: 5
    })),
    chips: [], past: []
  };

  const summaries = {};
  players.forEach(p => {
    summaries[p.id] = { history: historyById[p.id], history_past: [], fixtures: fixtures
      .filter(f => !f.finished && (f.team_h === p.team || f.team_a === p.team)).slice(0, 6)
      .map(f => ({ event: f.event, is_home: f.team_h === p.team, team_h: f.team_h, team_a: f.team_a,
        difficulty: f.team_h === p.team ? f.team_h_difficulty : f.team_a_difficulty })) };
  });

  const rateById = {};
  players.forEach(p => { rateById[p.id] = p.rate; });

  return {
    now, season: '2026-27',
    raw: { bootstrap, fixtures, live, summaries, entry, history, picks: { [o.finishedGws]: picksResp } },
    truth: { rateById, squadIds: squad.map(p => p.id), injuredMidId: injuredMid ? injuredMid.id : null,
      doubtDefId: doubtDef ? doubtDef.id : null }
  };
}

const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

/** Writes a season in the on-disk shape eval/fetch.cjs produces. */
function writeAsEvalData(season, dir) {
  const fs = require('fs'), path = require('path');
  const root = path.join(dir, season.season);
  fs.mkdirSync(path.join(root, 'live'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bootstrap.json'), JSON.stringify({
    fetchedAt: new Date(season.now).toISOString(),
    elements: season.raw.bootstrap.elements, teams: season.raw.bootstrap.teams, events: season.raw.bootstrap.events
  }));
  fs.writeFileSync(path.join(root, 'fixtures.json'), JSON.stringify(season.raw.fixtures));
  Object.keys(season.raw.live).forEach(gw => {
    fs.writeFileSync(path.join(root, 'live', 'gw' + gw + '.json'), JSON.stringify({ event: Number(gw), elements: season.raw.live[gw].elements }));
  });
  return root;
}

module.exports = { makeSeason, writeAsEvalData, rng };
