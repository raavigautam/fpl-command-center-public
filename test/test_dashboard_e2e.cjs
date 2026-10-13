// The whole dashboard build, end to end, against a synthetic season served
// through a stubbed UrlFetchApp: every stage of getDashboardData() runs on
// real-shaped API responses, with no network.
//
// This is where the decisions are checked as a set rather than one function
// at a time — that an injured starter is flagged and benched, that declared
// transfers flow through to the squad, the eleven, the captain and the
// remaining advice, that only one chip is ever "Play now", that the grading
// loop learns from the whole pool on raw numbers.
const vm = require('vm');
const S = require(require('path').join(__dirname, 'harness.cjs'));
const { makeSeason } = require(require('path').join(__dirname, 'synth_season.cjs'));

let fail = 0;
function ok(n, c, x) { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; }

const TEAM = 1234567;
const season = makeSeason({ seed: 11, finishedGws: 5, teamId: TEAM });
const raw = season.raw;
let liveOverride = null;

function respond(url) {
  const path = url.replace('https://fantasy.premierleague.com/api', '');
  let m;
  if (path === '/bootstrap-static/') return raw.bootstrap;
  if (path === '/fixtures/') return raw.fixtures;
  if ((m = path.match(/^\/entry\/(\d+)\/$/))) return raw.entry;
  if ((m = path.match(/^\/entry\/(\d+)\/history\/$/))) return raw.history;
  if ((m = path.match(/^\/entry\/(\d+)\/event\/(\d+)\/picks\/$/))) return raw.picks[m[2]] || null;
  if ((m = path.match(/^\/event\/(\d+)\/live\/$/))) return (liveOverride && liveOverride[m[1]]) || raw.live[m[1]] || null;
  if ((m = path.match(/^\/element-summary\/(\d+)\/$/))) return raw.summaries[m[1]] || null;
  return null;
}
function response(body) {
  return { getResponseCode: () => (body ? 200 : 404), getContentText: () => JSON.stringify(body || {}) };
}
S.UrlFetchApp = {
  fetch: (url) => response(respond(url)),
  fetchAll: (reqs) => reqs.map(r => response(respond(r.url)))
};
vm.runInContext('Date.now = function () { return ' + season.now + '; };', S);

// XP_MODEL=v2 (or blend) runs the whole build on the component model.
if (process.env.XP_MODEL) S.XP_MODEL = process.env.XP_MODEL;
const props = S.PropertiesService.getScriptProperties();
props.setProperty('TEAM_ID', String(TEAM));

function load() {
  // Per-request memos, as a fresh Apps Script execution would have them.
  S.BOOTSTRAP_MEMO_ = null; S.FIXTURES_MEMO_ = null; S.CALIBRATION_ = null;
  return JSON.parse(S.getDashboardDataJson(false));
}

/* ---------- the dashboard builds and is internally consistent ---------- */
let d = load();
ok('the dashboard builds a squad', d.squad && d.squad.players.length === 15, d.squad && d.squad.players.length);
ok('it advises on the open gameweek', d.pickingForEventId === 6, d.pickingForEventId);
ok('every invariant holds', d.invariants && d.invariants.ok, JSON.stringify(d.invariants && d.invariants.failures));

ok('squad rows carry how often each player has started recently',
  d.squad.players.filter(p => p.status === 'a' && raw.bootstrap.elements.filter(e => e.id === p.id)[0].minutes > 0)
    .every(p => p.rotation && p.rotation.matches >= 2),
  d.squad.players.map(p => p.rotation ? p.rotation.started + '/' + p.rotation.matches : 'none').join(' '));

/* ---------- the eleven is checked before anything else ---------- */
const injured = season.truth.injuredMidId, doubt = season.truth.doubtDefId;
const injName = d.squad.players.filter(p => p.id === injured)[0].name;
const warnings = d.lineup.xiWarnings || [];
ok('an injured starter is flagged as unable to play', warnings.some(w => w.id === injured && w.severity === 'unavailable'),
  JSON.stringify(warnings));
ok('a doubtful starter is flagged as a doubt', warnings.some(w => w.id === doubt && w.severity === 'doubt'));
ok('the recommended eleven benches the injured player', d.lineup.xi.every(p => p.id !== injured));
ok('the action list leads its lineup line with him',
  (d.actionList.actions || []).some(a => a.kind === 'lineup' && a.title.indexOf(injName) !== -1),
  JSON.stringify((d.actionList.actions || []).map(a => a.title)));
ok('the recommended eleven is a legal formation', d.lineup.xi.length === 11);

/* ---------- transfer arithmetic reconciles and has a stated counterfactual ---------- */
(d.transferSuggestions || []).forEach(t => {
  ok('net = gross − hit for ' + t.inName, Math.abs(t.projectedGain - t.hitCost - t.netGain) < 1e-9,
    t.projectedGain + ' − ' + t.hitCost + ' vs ' + t.netGain);
});
const injSale = (d.transferSuggestions || []).filter(t => t.outId === injured)[0];
if (injSale) {
  ok('selling an injured player is not credited with the buy’s whole output', injSale.projectedGain < injSale.inXp - 0.5,
    injSale.projectedGain + ' vs incoming ' + injSale.inXp);
  ok('and says what it was measured against', /benched, not scored as a zero/.test(injSale.counterfactual));
}

/* ---------- one chip decision ---------- */
ok('at most one chip reads Play now', (d.chipBoard || []).filter(c => c.status === 'Play now').length <= 1);
ok('there is a single chip decision with a reason', d.chipDecision && typeof d.chipDecision.reason === 'string', JSON.stringify(d.chipDecision));

/* ---------- best eleven per gameweek ---------- */
const weeks = (d.roadmap && d.roadmap.weeks) || [];
ok('the plan carries an eleven for every week', weeks.length === 6 && weeks.every(w => w.xi && w.xi.players.length === 11),
  weeks.map(w => w.xi && w.xi.players.length).join(','));
ok('every week has a captain', weeks.every(w => w.xi.captain && w.xi.captain.name));
ok('later weeks are marked provisional', weeks.slice(1).every(w => w.xi.provisional));
ok('no internal state leaks onto the wire', weeks.every(w => !('_state' in w)));
ok('FDR is labelled with the side it belongs to',
  /\(\d for [A-Z]{3}\)/.test(d.squad.players[0].reason + ' ' + JSON.stringify(d.transferSuggestions)));

/* ---------- the manager declares a transfer ---------- */
const sameClubCount = {};
d.squad.players.forEach(p => { sameClubCount[p.teamId] = (sameClubCount[p.teamId] || 0) + 1; });
const owned = {}; d.squad.players.forEach(p => { owned[p.id] = true; });
const buy = raw.bootstrap.elements
  .filter(el => el.element_type === 3 && !owned[el.id] && el.status === 'a' && (sameClubCount[el.team] || 0) < 3 && el.now_cost <= 75)
  .sort((a, b) => parseFloat(b.ep_next) - parseFloat(a.ep_next))[0];
const res = S.saveDeclaredTransfers(JSON.stringify({ eventId: 6, moves: [{ outId: injured, inId: buy.id }] }));
ok('a legal declared transfer is accepted', res.ok && res.summary.moves.length === 1, JSON.stringify(res));

d = load();
ok('the squad now holds the player bought', d.squad.players.some(p => p.id === buy.id));
ok('and not the player sold', d.squad.players.every(p => p.id !== injured));
ok('the bench, eleven and captain are recomputed for it', d.lineup.xi.length === 11 && d.captainSuggestions.length > 0);
ok('the injured player is no longer a warning', (d.lineup.xiWarnings || []).every(w => w.id !== injured));
ok('one free transfer was spent', d.declared.freeTransfersLeft === d.declared.freeTransfersBefore - 1 || d.declared.hits === 1,
  JSON.stringify({ before: d.declared.freeTransfersBefore, left: d.declared.freeTransfersLeft, hits: d.declared.hits }));
ok('the bank reflects the price difference', Math.abs(d.squad.bank - d.declared.bank) < 1e-9);
ok('no remaining suggestion buys someone already owned', (d.transferSuggestions || []).every(t => t.inId !== buy.id));
ok('the remaining advice is priced on the free transfers left',
  d.transferLedger.freeTransfersAvailable === d.declared.freeTransfersLeft, d.transferLedger.freeTransfersAvailable);
ok('invariants still hold on the declared squad', d.invariants.ok, JSON.stringify(d.invariants.failures));

/* ---------- a hit is priced against waiting for next week's free transfer ---------- */
// With this week's transfer spent, every further move is a hit — and a hit
// is only worth it when waiting would cost more than the hit.
ok('every hit still recommended loses more by waiting than it costs',
  (d.transferSuggestions || []).every(t => !t.usesHit || (t.waitCost != null && t.waitCost > 4 + S.HIT_NOW_MARGIN)),
  JSON.stringify((d.transferSuggestions || []).map(t => t.inName + ' wait ' + t.waitCost)));
ok('moves not worth a hit now are planned for later, free',
  (d.deferredTransfers || []).every(m => m.waitCost <= 4 + S.HIT_NOW_MARGIN && m.makeInEvent > 6 && m.gainIfWaited > 0),
  JSON.stringify(d.deferredTransfers));
// Unless a Wildcard or Free Hit is the call this week — it replaces the
// transfers, planned ones included.
const chipReplaces = d.actionList.actions.some(a => a.kind === 'chip' && /Wildcard|Free Hit/.test(a.title));
const planLines = d.actionList.actions.filter(a => a.kind === 'plan').length;
ok('and appear as "wait" lines, not as moves to make now',
  chipReplaces ? planLines === 0 : planLines === (d.deferredTransfers || []).length,
  d.actionList.headline + ' / chip replaces transfers: ' + chipReplaces);
ok('the deferred moves are not charged in the ledger',
  d.transferLedger.transfersRecommended === (d.transferSuggestions || []).length);
ok('every recommended transfer says whether the new player starts this week',
  (d.transferSuggestions || []).every(t => typeof t.startsThisWeek === 'boolean' && /this week/.test(t.xiNote)));
ok('the form still offers the locked squad to sell from', d.transferBase.some(p => p.id === injured));

const snap = JSON.parse(props.getProperty('DECISION_6'));
ok('the graded snapshot is re-taken for the declared squad', snap.declaredSig === d.declared.signature && snap.recommendedXI.every(p => p.id !== injured));
ok('the snapshot carries whole-pool raw projections', typeof snap.pool === 'string' && snap.pool.split(',').length > 150,
  snap.pool ? snap.pool.split(',').length + ' players' : 'none');

/* ---------- illegal declarations are refused, not half-applied ---------- */
function refused(payload) {
  try { S.saveDeclaredTransfers(JSON.stringify(payload)); return null; } catch (e) { return e.message; }
}
const fwd = raw.bootstrap.elements.filter(el => el.element_type === 4 && !owned[el.id])[0];
ok('a cross-position transfer is refused', /like for like/.test(refused({ eventId: 6, moves: [{ outId: injured, inId: fwd.id }] }) || ''));
const pricey = raw.bootstrap.elements.filter(el => el.element_type === 3 && !owned[el.id]).sort((a, b) => b.now_cost - a.now_cost)[0];
const costOf = id => raw.bootstrap.elements.filter(el => el.id === id)[0].now_cost;
const cheapest = d.transferBase.filter(p => p.elementType === 3 && p.id !== injured)
  .sort((a, b) => costOf(a.id) - costOf(b.id))[0];
const overspend = refused({ eventId: 6, moves: [{ outId: cheapest.id, inId: pricey.id }] });
ok('an overspend or club breach is refused', overspend && /overspend|limit/.test(overspend), overspend);
ok('a declaration for the wrong gameweek is refused', /open gameweek/.test(refused({ eventId: 5, moves: [{ outId: injured, inId: buy.id }] }) || ''));
d = load();
ok('a refused declaration leaves the accepted one in place', d.squad.players.some(p => p.id === buy.id));

/* ---------- merging: selling back what you bought cancels the move ---------- */
const merged = S.mergeDeclaredMove_([{ outId: 1, inId: 2 }], { outId: 2, inId: 3 });
ok('A→B then B→C folds to A→C', merged.length === 1 && merged[0].outId === 1 && merged[0].inId === 3);
ok('A→B then B→A cancels', S.mergeDeclaredMove_([{ outId: 1, inId: 2 }], { outId: 2, inId: 1 }).length === 0);

/* ---------- after the deadline: grading learns from the pool ---------- */
// Advance to after GW6 finished: mark it finished and serve a live response.
raw.bootstrap.events.forEach(e => { if (e.id === 6) { e.finished = true; e.data_checked = true; e.is_current = true; } if (e.id === 7) e.is_next = true; });
raw.fixtures.forEach(f => { if (f.event === 6) f.finished = true; });
raw.picks[6] = JSON.parse(JSON.stringify(raw.picks[5]));
raw.picks[6].picks.forEach(p => { if (p.element === injured) { p.element = buy.id; p.selling_price = buy.now_cost; } });
liveOverride = { 6: { elements: raw.bootstrap.elements.map(el => ({ id: el.id, stats: { minutes: 90, total_points: Math.round(parseFloat(el.ep_next)) } })) } };
const gw7 = Date.parse(raw.bootstrap.events[6].deadline_time) - 24 * 3600 * 1000;
vm.runInContext('Date.now = function () { return ' + gw7 + '; };', S);
S.CacheService.getScriptCache().remove('CALIBRATION_V2');
d = load();
const grade = JSON.parse(props.getProperty('GRADE_6') || 'null');
ok('the finished gameweek is graded', !!grade, Object.keys(props.getProperties()).join(','));
ok('calibration is version 2, whole pool', grade && grade.calibration && grade.calibration.version === 2 && grade.calibration.n > 100,
  grade && grade.calibration && JSON.stringify({ v: grade.calibration.version, n: grade.calibration.n }));
ok('and records its error', grade && grade.calibration && grade.calibration.mae != null);
ok('the pool is dropped from the stored decision once scored', !JSON.parse(props.getProperty('DECISION_6')).pool);
ok('last week’s declaration is checked against the locked squad', d.declaredCheck && d.declaredCheck.matched === true,
  JSON.stringify(d.declaredCheck));
ok('and retired', props.getProperty('DECLARED_6') === null);
ok('the recommended eleven is graded against the same squad', grade && grade.lineupGain !== undefined);

console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall checks passed');
process.exit(fail ? 1 : 0);
