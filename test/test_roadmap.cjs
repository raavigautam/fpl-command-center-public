const S = require(require('path').join(__dirname, 'harness.cjs'));

const GWS = [10, 11, 12, 13, 14, 15];
let fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '  ' + extra : ''));
  if (!cond) fail++;
}

// --- bestXiXp_ ------------------------------------------------------------
function pl(type, xps) { return { elementType: type, xp: { perGw: xps.map(x => ({ xp: x })) } }; }
// 2 GK, 5 DEF, 5 MID, 3 FWD — a legal 15
const squad15 = []
  .concat([pl(1, [6]), pl(1, [1])])
  .concat([5, 4, 3, 2, 1].map(v => pl(2, [v])))
  .concat([9, 8, 7, 2, 1].map(v => pl(3, [v])))
  .concat([10, 3, 1].map(v => pl(4, [v])));
// best legal XI: GK 6; DEF min3 = 5+4+3; MID min2 = 9+8; FWD min1 = 10;
// 4 slots left from remaining: 7(MID), 3(FWD), 2(DEF), 2(MID) -> 7+3+2+2
const expected = 6 + (5 + 4 + 3) + (9 + 8) + 10 + (7 + 3 + 2 + 2);
ok('bestXiXp_ picks the optimal legal XI', S.bestXiXp_(squad15, 0) === expected,
   'got ' + S.bestXiXp_(squad15, 0) + ' expected ' + expected);
ok('bestXiXp_ never counts more than 11', S.bestXiXp_(squad15, 0) < squad15.reduce((s, p) => s + p.xp.perGw[0].xp, 0));

// --- synthetic world ------------------------------------------------------
function mkEl(id, type, team, cost, perGw) {
  return {
    id, web_name: 'P' + id, team, element_type: type, now_cost: cost,
    status: 'a', minutes: 900, form: '5.0', points_per_game: '5.0', ep_next: '5.0',
    selected_by_percent: '10.0', total_points: 50, ict_index: '50',
    transfers_in_event: 0, transfers_out_event: 0, cost_change_event: 0,
    __perGw: perGw
  };
}
// Deterministic projections, injected by stubbing projectPoints_.
const projections = {};
S.projectPoints_ = function (el) {
  const perGw = projections[el.id] || el.__perGw || GWS.map(() => 2);
  return {
    next: perGw[0],
    horizon: perGw.reduce((a, b) => a + b, 0),
    perGw: GWS.map((g, i) => ({ event: g, xp: perGw[i] }))
  };
};
S.buildFixtureSwings_ = () => [];
S.SEASON_CONTEXT_ = { finishedGws: 9, avgEntryScore: 50 };

const teams = [];
for (let t = 1; t <= 20; t++) teams.push({ id: t, name: 'T' + t, short_name: 'T' + t });

const elements = [];
let nid = 1;
// The manager's 15, all mediocre and flat.
const mySquad = [];
const shape = [[1, 2], [2, 5], [3, 5], [4, 3]];
shape.forEach(([type, n]) => {
  for (let i = 0; i < n; i++) {
    const el = mkEl(nid, type, ((nid % 20) + 1), 50, GWS.map(() => 3));
    elements.push(el);
    mySquad.push({
      id: nid, name: 'P' + nid, team: 'T' + el.team, teamId: el.team,
      position: S.POSITION_MAP[type], elementType: type, price: 5.0, sellingPrice: 5.0,
      isStarting: mySquad.length < 11, isCaptain: mySquad.length === 0,
      xp: S.projectPoints_(el)
    });
    nid++;
  }
});
// A market of alternatives. One MID is a monster but ONLY from GW13 on —
// the case a greedy planner mishandles.
const LATE_BLOOMER = nid;
elements.push(mkEl(nid++, 3, 7, 60, [3, 3, 3, 12, 12, 12]));
// A modest immediate upgrade — attractive to a one-week view.
const QUICK_WIN = nid;
elements.push(mkEl(nid++, 3, 8, 55, [6, 5, 4, 4, 4, 4]));
for (let i = 0; i < 60; i++) {
  const type = (i % 4) + 1;
  elements.push(mkEl(nid++, type, ((i % 20) + 1), 50 + (i % 10), GWS.map(() => 3 + (i % 3))));
}

const bootstrap = { teams, elements, events: [], total_players: 1000000 };
const fixtureEase = {};
for (let t = 1; t <= 20; t++) fixtureEase[t] = { eventIds: GWS };

const squad = {
  players: mySquad,
  starting: mySquad.filter(p => p.isStarting),
  bench: mySquad.filter(p => !p.isStarting),
  bank: 2.0, teamValue: 100.0
};

// --- the plan -------------------------------------------------------------
const t0 = Date.now();
const plan = S.buildTransferRoadmap_(bootstrap, fixtureEase, squad, 1, 'balanced', null);
const ms = Date.now() - t0;

ok('returns a plan', !!plan);
ok('plans every gameweek in the horizon', plan.weeks.length === GWS.length, plan.weeks.length + ' weeks');
ok('runs fast enough for a request path', ms < 3000, ms + 'ms');
ok('reports its objective', typeof plan.plannedXp === 'number', plan.plannedXp);

let bankOk = true, clubOk = true;
plan.weeks.forEach(w => { if (w.bank < -0.001) bankOk = false; });
ok('never goes overdrawn', bankOk, JSON.stringify(plan.weeks.map(w => w.bank)));

// No player bought twice across the plan.
const bought = {};
let dup = false;
plan.weeks.forEach(w => w.moves.forEach(m => { if (bought[m.inName]) dup = true; bought[m.inName] = true; }));
ok('never buys the same player twice', !dup);

// Free transfer accounting: ft in, moves, ft next week. FPL grants one free
// transfer every gameweek and paying a hit does not forfeit it, so the count
// can never drop below 1 — a two-move week funded by a -4 used to leave it at
// 0, which made the plan price the NEXT week's single move as another hit.
let ftOk = true;
for (let i = 1; i < plan.weeks.length; i++) {
  const prev = plan.weeks[i - 1];
  const expectFt = Math.max(1, Math.min(5, prev.freeTransfers - prev.moves.length + 1));
  if (plan.weeks[i].freeTransfers !== expectFt) ftOk = false;
}
ok('free transfers roll correctly', ftOk, JSON.stringify(plan.weeks.map(w => w.freeTransfers + '/' + w.moves.length)));
ok('free transfers never fall below one',
   plan.weeks.every(w => w.freeTransfers >= 1),
   JSON.stringify(plan.weeks.map(w => w.freeTransfers)));

// The regression directly: force a two-move week off a single free transfer
// and check the following week still starts with one.
{
  const forced = S.buildTransferRoadmap_(bootstrap, fixtureEase, squad, 1, 'aggressive', null);
  let bad = null;
  for (let i = 0; i < forced.weeks.length - 1; i++) {
    if (forced.weeks[i].moves.length >= 2 && forced.weeks[i + 1].freeTransfers < 1) {
      bad = 'GW' + forced.weeks[i].event + ' took ' + forced.weeks[i].moves.length +
            ' moves on ' + forced.weeks[i].freeTransfers + ' FT, next week had ' + forced.weeks[i + 1].freeTransfers;
    }
  }
  ok('a hit-funded double move does not zero out next week', bad === null, bad || 'no zeroed week');
  ok('every hit is a whole number of -4s',
     forced.weeks.every(w => (w.hits || 0) === Math.round(w.hits || 0) && (w.hits || 0) >= 0));
  ok('hits are only charged when moves exceed free transfers',
     forced.weeks.every(w => (w.hits || 0) === Math.max(0, w.moves.length - w.freeTransfers)),
     JSON.stringify(forced.weeks.map(w => w.moves.length + 'mv/' + w.freeTransfers + 'ft/' + (w.hits||0) + 'h')));
}

// The whole point: does the lookahead find the late bloomer?
const names = [];
plan.weeks.forEach(w => w.moves.forEach(m => names.push(m.inName)));
ok('finds the late-blooming target a greedy pass would skip',
   names.indexOf('P' + LATE_BLOOMER) !== -1, names.join(', '));

console.log('\n  plan: ' + plan.weeks.map(w =>
  'GW' + w.event + (w.moves.length ? ' ' + w.moves.map(m => m.inName + '<-' + m.outName).join('+') : ' roll')
).join(' | '));
console.log('  plannedXp=' + plan.plannedXp + ' hits=' + plan.totalHits + ' moves=' + plan.totalPlannedMoves + ' in ' + ms + 'ms');

// --- divergence path ------------------------------------------------------
const suggestions = [{ outId: mySquad[12].id, inId: QUICK_WIN, projectedGain: 5.0 }];
const pinned = S.buildTransferRoadmap_(bootstrap, fixtureEase, squad, 1, 'balanced', suggestions);
ok('pins gameweek one to the recommended move',
   pinned.weeks[0].moves.length === 1 && pinned.weeks[0].moves[0].inName === 'P' + QUICK_WIN,
   JSON.stringify(pinned.weeks[0].moves.map(m => m.inName)));
ok('divergence is reported or absent, never malformed',
   pinned.divergence === null || (typeof pinned.divergence.gain === 'number' && !!pinned.divergence.summary),
   JSON.stringify(pinned.divergence && pinned.divergence.summary));

// --- risk appetite still bites -------------------------------------------
const safe = S.buildTransferRoadmap_(bootstrap, fixtureEase, squad, 1, 'safe', null);
const aggro = S.buildTransferRoadmap_(bootstrap, fixtureEase, squad, 1, 'aggressive', null);
ok('safe moves no more often than aggressive',
   safe.totalPlannedMoves <= aggro.totalPlannedMoves,
   'safe=' + safe.totalPlannedMoves + ' aggressive=' + aggro.totalPlannedMoves);

/* ===================== FUNDED UPGRADES =====================
 * Selling two mid-priced players to afford one premium was unrepresentable:
 * every branch was one-out-one-in, same position, self-funded.
 *
 * The fixture has to be built with care or it proves nothing. The players
 * being sold must actually be in the starting XI — selling bench fodder
 * changes the best-legal-XI objective by zero, so the search correctly
 * ignores it — and the premium must be affordable on two sales but NOT on
 * one, or a plain one-for-one branch would already reach it at half the
 * transfer cost. */
{
  const GW2 = [10,11,12,13,14,15];
  const teams2 = []; for (let t=1;t<=20;t++) teams2.push({id:t,name:'T'+t,short_name:'T'+t});
  const els = []; let id = 1; const mine = [];
  const proj = {};
  S.projectPoints_ = function (el) {
    const per = proj[el.id] || GW2.map(()=>2);
    return { next: per[0], horizon: per.reduce((a,b)=>a+b,0),
             perGw: GW2.map((g,i)=>({event:g, xp:per[i], fixtures:1, opponents:['X']})),
             availability:1, starter:1 };
  };
  function add(type, team, cost, per, own) {
    const el = { id, web_name:'P'+id, element_type:type, team, now_cost:cost, status:'a', minutes:900,
                 selected_by_percent:'5', transfers_in_event:0, transfers_out_event:0, cost_change_event:0 };
    proj[id] = per; els.push(el);
    if (own) mine.push({ id, name:'P'+id, team:'T'+team, teamId:team, position:S.POSITION_MAP[type],
      elementType:type, price:cost/10, sellingPrice:cost/10,
      isStarting: mine.length<11, isCaptain: mine.length===0, xp:S.projectPoints_(el) });
    return id++;
  }
  // Every midfielder is weak, so a legal XI (min 2 MID) is forced to field
  // two of them — which is what makes selling two of them actually move the
  // objective.
  add(1,1,45,GW2.map(()=>3),true); add(1,2,45,GW2.map(()=>2),true);
  for (let i=0;i<5;i++) add(2,3+i,45,GW2.map(()=>3),true);
  const MIDS = []; for (let i=0;i<5;i++) MIDS.push(add(3,8+i,65,GW2.map(()=>2.0),true));
  for (let i=0;i<3;i++) add(4,15+i,60,GW2.map(()=>3),true);

  // £9.0m superstar: two £6.5m sales plus £0.5m bank minus a £4.0m enabler
  // leaves £9.5m, so he is reachable on two sales and not on one (£7.0m).
  const PREMIUM = add(3,19,90,GW2.map(()=>11),false);
  add(3,20,40,GW2.map(()=>2.0),false);            // the cheap enabler
  for (let i=0;i<40;i++) add((i%4)+1, (i%20)+1, 50+(i%20), GW2.map(()=>2.2+(i%3)*0.2), false);

  const bootstrap2 = { teams:teams2, elements:els, events:[], total_players:1000000 };
  const fe2 = {}; for (let t=1;t<=20;t++) fe2[t] = { eventIds:GW2 };
  const squad2 = { players:mine, starting:mine.filter(p=>p.isStarting), bench:mine.filter(p=>!p.isStarting), bank:0.5 };

  const t0 = Date.now();
  const plan = S.buildTransferRoadmap_(bootstrap2, fe2, squad2, 2, 'aggressive', null);
  const ms = Date.now() - t0;

  const bought = [];
  plan.weeks.forEach(w => w.moves.forEach(m => bought.push(m.inName)));
  ok('the planner reaches a premium only two sales could fund',
     bought.indexOf('P'+PREMIUM) !== -1, bought.join(', ') || '(no moves)');
  ok('funded upgrades do not blow the runtime budget', ms < 4000, ms + 'ms');
  ok('the plan still never goes overdrawn', plan.weeks.every(w => w.bank >= -0.001),
     JSON.stringify(plan.weeks.map(w=>w.bank)));
  ok('the squad never buys the same player twice',
     bought.length === new Set(bought).size, bought.join(', '));
  ok('free transfers still never fall below one', plan.weeks.every(w => w.freeTransfers >= 1));
  ok('hits still match moves beyond the free transfers',
     plan.weeks.every(w => (w.hits||0) === Math.max(0, w.moves.length - w.freeTransfers)),
     JSON.stringify(plan.weeks.map(w=>w.moves.length+'mv/'+w.freeTransfers+'ft/'+(w.hits||0)+'h')));

  // A funded upgrade costs two transfers, so a marginal premium must not
  // trigger one.
  proj[PREMIUM] = GW2.map(()=>2.1);
  const weakPlan = S.buildTransferRoadmap_(bootstrap2, fe2, squad2, 2, 'safe', null);
  const weakBought = [];
  weakPlan.weeks.forEach(w => w.moves.forEach(m => weakBought.push(m.inName)));
  ok('a marginal premium is not worth two transfers',
     weakBought.indexOf('P'+PREMIUM) === -1, weakBought.join(', ') || '(no moves)');
  proj[PREMIUM] = GW2.map(()=>11);

  // Squad shape must survive: still 2 GK, 5 DEF, 5 MID, 3 FWD.
  const shapeAfter = {1:0,2:0,3:0,4:0};
  const held = {};
  mine.forEach(p => { held[p.id] = p.elementType; });
  plan.weeks.forEach(w => w.moves.forEach(m => {
    const outEl = els.filter(e => e.web_name === m.outName)[0];
    const inEl  = els.filter(e => e.web_name === m.inName)[0];
    if (outEl && inEl) { delete held[outEl.id]; held[inEl.id] = inEl.element_type; }
  }));
  Object.keys(held).forEach(k => { shapeAfter[held[k]]++; });
  ok('the squad keeps a legal shape through every funded upgrade',
     shapeAfter[1]===2 && shapeAfter[2]===5 && shapeAfter[3]===5 && shapeAfter[4]===3,
     JSON.stringify(shapeAfter));
  ok('the squad still has fifteen players', Object.keys(held).length===15, Object.keys(held).length);

  // Club limits must hold across BOTH arrivals of one combination.
  const clubCount = {};
  Object.keys(held).forEach(k => {
    const el = els.filter(e => e.id === Number(k))[0];
    if (el) clubCount[el.team] = (clubCount[el.team]||0)+1;
  });
  ok('no club exceeds three players after the plan',
     Object.keys(clubCount).every(k => clubCount[k] <= 3), JSON.stringify(clubCount));

  console.log('  funded-upgrade plan: ' + plan.weeks.map(w =>
    'GW'+w.event+(w.moves.length ? ' '+w.moves.map(m=>m.inName+'<-'+m.outName).join('+') : ' roll')).join(' | '));
}

console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall checks passed');
process.exit(fail ? 1 : 0);
