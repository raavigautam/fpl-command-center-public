// The component model (projectPointsV2_): each fixture's points built from
// FPL's scoring rules out of team xG for and against, the player's share of
// it, clean-sheet and defensive-contribution probabilities, and minutes.
const path = require('path');
const S = require(path.join(__dirname, 'harness.cjs'));
const { makeSeason } = require(path.join(__dirname, 'synth_season.cjs'));
let fail = 0;
function ok(n, c, x) { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; }
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-6);

/* ---------- probability helpers ---------- */
ok('P(X>=0) is 1', S.poissonTail_(2, 0) === 1);
ok('P(X>=1) = 1 - e^-λ', near(S.poissonTail_(1.5, 1), 1 - Math.exp(-1.5)));
ok('Poisson tail for a defender’s 8 actions reaching 10', near(S.poissonTail_(8, 10), 0.2834, 1e-3), S.poissonTail_(8, 10).toFixed(4));
ok('E[floor(X/2)] matches a direct sum', (() => {
  let direct = 0, p = Math.exp(-1.4);
  for (let k = 0; k < 40; k++) { if (k) p *= 1.4 / k; direct += Math.floor(k / 2) * p; }
  return near(S.poissonFloorMean_(1.4, 2), direct, 1e-5);
})());
const saved = S.V2_GOAL_DISPERSION;
S.V2_GOAL_DISPERSION = Infinity;
ok('infinite dispersion recovers the Poisson clean sheet', near(S.cleanSheetChance_(1.3), Math.exp(-1.3)));
S.V2_GOAL_DISPERSION = saved;
ok('clustered scoring makes clean sheets likelier than a Poisson says', S.cleanSheetChance_(1.3) > Math.exp(-1.3));
ok('and a stronger attack makes them rarer', S.cleanSheetChance_(2.0) < S.cleanSheetChance_(1.0));

// Defensive actions are over-dispersed: the negative binomial keeps the mean
// and fattens the tail, which is where the 12-action midfield threshold sits.
ok('a fatter tail than the Poisson at the same mean', S.negBinTail_(7, 6, 12) > S.poissonTail_(7, 12),
  S.negBinTail_(7, 6, 12).toFixed(3) + ' vs ' + S.poissonTail_(7, 12).toFixed(3));
ok('which converges to the Poisson as dispersion grows', near(S.negBinTail_(7, 1e7, 12), S.poissonTail_(7, 12), 1e-4));
ok('and is a probability', S.negBinTail_(9, 6, 10) > 0 && S.negBinTail_(9, 6, 10) < 1);

/* ---------- club rates from season totals ---------- */
const boot = {
  teams: [{ id: 1, name: 'Strong', short_name: 'STR' }, { id: 2, name: 'Weak', short_name: 'WEA' }],
  elements: [
    // Strong: 4 matches, 8.0 xG for; players on 990 x 4 minutes, xGC summing 11 x 2.0
    { id: 1, team: 1, element_type: 4, minutes: 360 * 11, expected_goals: '8.00', expected_goals_conceded: String(11 * 2.0) },
    // Weak: 4 matches, 2.4 xG for, 11 x 8.0 xGC
    { id: 2, team: 2, element_type: 4, minutes: 360 * 11, expected_goals: '2.40', expected_goals_conceded: String(11 * 8.0) }
  ]
};
const fx = [1, 2, 3, 4].map(gw => ({ event: gw, team_h: 1, team_a: 2, finished: true }));
S.V2_TEAM_PRIOR_MATCHES = 0;
let rates = S.loadTeamRates_(boot, fx);
ok('xG for per match is the players’ xG over matches', near(rates.byTeam[1].att, 2.0) && near(rates.byTeam[2].att, 0.6), JSON.stringify(rates.byTeam));
ok('xG against per match is Σ xGC over Σ minutes × 90', near(rates.byTeam[1].def, 0.5) && near(rates.byTeam[2].def, 2.0), JSON.stringify(rates.byTeam));
ok('the league average is the mean attack', near(rates.league, 1.3));
S.V2_TEAM_PRIOR_MATCHES = 4;
rates = S.loadTeamRates_(boot, fx);
ok('rates are shrunk toward the league average', rates.byTeam[1].att < 2.0 && rates.byTeam[1].att > 1.3);
ok('no finished matches means no rates to use', S.loadTeamRates_(boot, []).ready === false);

/* ---------- one fixture, by component ---------- */
S.TEAM_RATES_ = { ready: true, league: 1.3, byTeam: {
  1: { att: 2.0, def: 0.8, matches: 5 }, 2: { att: 0.7, def: 2.0, matches: 5 }, 3: { att: 1.3, def: 1.3, matches: 5 } } };
S.PRICE_NORM_ = { 1: 45, 2: 45, 3: 60, 4: 65 };
const mm = { p60: 0.9, pShort: 0.05, minutesFraction: 0.88 };
const def = { element_type: 2, team: 3, minutes: 450, now_cost: 50, expected_goals: '0.2', expected_assists: '0.3', defensive_contribution: 45, bonus: 2 };
const rDef = S.perGameRatesV2_(def);
const vsWeakAttack = S.fixturePointsV2_(def, { opponent: 2, home: true }, S.TEAM_RATES_, mm, rDef);
const vsStrongAttack = S.fixturePointsV2_(def, { opponent: 1, home: true }, S.TEAM_RATES_, mm, rDef);
ok('a defender’s clean-sheet points depend on the opponent’s ATTACK',
  vsWeakAttack.parts.cleanSheet > 2 * vsStrongAttack.parts.cleanSheet,
  vsWeakAttack.parts.cleanSheet.toFixed(2) + ' vs ' + vsStrongAttack.parts.cleanSheet.toFixed(2));
ok('and so does the goals-conceded penalty', vsStrongAttack.parts.conceded < vsWeakAttack.parts.conceded);
ok('a 9-a-match defender has a real chance at the defensive-contribution threshold', vsWeakAttack.parts.defensive > 0.3, vsWeakAttack.parts.defensive.toFixed(2));
ok('a defender saves nothing', vsWeakAttack.parts.saves === 0);

const fwd = { element_type: 4, team: 3, minutes: 450, now_cost: 80, expected_goals: '2.5', expected_assists: '0.5', bonus: 3 };
const rFwd = S.perGameRatesV2_(fwd);
const vsLeaky = S.fixturePointsV2_(fwd, { opponent: 2, home: true }, S.TEAM_RATES_, mm, rFwd);
const vsTight = S.fixturePointsV2_(fwd, { opponent: 1, home: true }, S.TEAM_RATES_, mm, rFwd);
ok('a forward’s goals depend on the opponent’s DEFENCE', vsLeaky.parts.goals > 2 * vsTight.parts.goals,
  vsLeaky.parts.goals.toFixed(2) + ' vs ' + vsTight.parts.goals.toFixed(2));
ok('a forward earns no clean-sheet points', vsLeaky.parts.cleanSheet === 0);
ok('home is worth more than away', S.fixturePointsV2_(fwd, { opponent: 3, home: true }, S.TEAM_RATES_, mm, rFwd).total >
  S.fixturePointsV2_(fwd, { opponent: 3, home: false }, S.TEAM_RATES_, mm, rFwd).total);

const taker = Object.assign({}, fwd, { penalties_order: 1, minutes: 90, expected_goals: '0.3' });
const notTaker = Object.assign({}, fwd, { penalties_order: 2, minutes: 90, expected_goals: '0.3' });
ok('the first-choice penalty taker is credited with penalty xG', S.perGameRatesV2_(taker).xg90 > S.perGameRatesV2_(notTaker).xg90);

const gk = { element_type: 1, team: 3, minutes: 450, now_cost: 50, expected_goals: '0', expected_assists: '0', saves: 15, bonus: 1 };
const gkPts = S.fixturePointsV2_(gk, { opponent: 1, home: false }, S.TEAM_RATES_, mm, S.perGameRatesV2_(gk));
ok('a keeper earns save points', gkPts.parts.saves > 0);
ok('a keeper has no defensive-contribution threshold', gkPts.parts.defensive === 0);

// Bonus follows returns: with no bonus history, a player who creates more
// is expected to collect more; with a history, his own record moves it.
const quiet = { element_type: 4, team: 3, minutes: 450, now_cost: 60, expected_goals: '0.5', expected_assists: '0.2', bonus: 0 };
const busy = Object.assign({}, quiet, { expected_goals: '3.5' });
ok('more expected goals means more expected bonus', S.perGameRatesV2_(busy).bonusHybrid90 > S.perGameRatesV2_(quiet).bonusHybrid90);
const bonusMagnet = Object.assign({}, quiet, { bonus: 9 });
ok('and his own bonus record moves it', S.perGameRatesV2_(bonusMagnet).bonusHybrid90 > S.perGameRatesV2_(quiet).bonusHybrid90);

// Defensive contributions are a PLAYER-level check: an attacking full-back
// who makes 3-4 actions a match is not handed centre-back numbers because
// his position is DEF, and a ball-winner is not pulled down to average.
const fullBack = { element_type: 2, team: 3, minutes: 450, now_cost: 50, expected_goals: '0.3', expected_assists: '0.6', defensive_contribution: 17, bonus: 2 };
const stopper = Object.assign({}, fullBack, { defensive_contribution: 61 });
const fbRate = S.perGameRatesV2_(fullBack).dc90, stRate = S.perGameRatesV2_(stopper).dc90;
ok('a 3.4-a-match full-back stays near his own rate, not the DEF average', fbRate < 5, fbRate.toFixed(1));
ok('a 12-a-match ball-winner stays near his', stRate > 11, stRate.toFixed(1));
ok('so their threshold chances are far apart',
  S.negBinTail_(stRate, S.V2_DC_DISPERSION, 10) > 4 * S.negBinTail_(fbRate, S.V2_DC_DISPERSION, 10));

const noDc = Object.assign({}, def); delete noDc.defensive_contribution;
ok('missing defensive data falls back to the prior, not to zero', near(S.perGameRatesV2_(noDc).dc90, S.V2_PRIOR.dc90[2]));

/* ---------- minutes ---------- */
const nailed = S.minutesModelV2_({ starts: 5, minutes: 450 }, 5);
const bench = S.minutesModelV2_({ starts: 0, minutes: 40 }, 5);
const unused = S.minutesModelV2_({ starts: 0, minutes: 0 }, 5);
ok('five starts in five is near-certain to play 60', nailed.p60 > 0.85, nailed.p60.toFixed(2));
ok('a full-90 regular is not credited with sub appearances', nailed.pShort < 0.1, nailed.pShort.toFixed(2));
ok('a bench player mostly appears as a sub', bench.p60 < 0.1 && bench.pShort > 0.2, JSON.stringify(bench));
ok('an unused player is unlikely to feature', unused.p60 < 0.05);

/* ---------- the switch between models ---------- */
const season = makeSeason({ seed: 21, finishedGws: 5 });
const vm = require('vm');
vm.runInContext('Date.now = function () { return ' + season.now + '; };', S);
const b = season.raw.bootstrap;
S.SEASON_CONTEXT_ = S.loadSeasonContext_(b);
S.PRICE_NORM_ = S.loadPriceNorms_(b);
S.CALIBRATION_ = false;
const fe = S.buildFixtureEaseMap_(b, season.raw.fixtures, 6);
S.TEAM_RATES_ = S.loadTeamRates_(b, season.raw.fixtures);
ok('team rates load from a real-shaped bootstrap', S.TEAM_RATES_.ready);
const someone = b.elements.filter(e => e.minutes > 300 && e.element_type === 3)[0];

ok('the app runs the 50% blend', S.XP_MODEL === 'blend' && S.XP_V2_WEIGHT === 0.5);
S.XP_MODEL = 'v1';
const v1 = S.projectPoints_(someone, fe);
ok('v1 is unchanged when selected', JSON.stringify(v1) === JSON.stringify(S.projectPointsV1_(someone, fe)));
S.XP_MODEL = 'v2';
const v2 = S.projectPoints_(someone, fe);
ok('v2 reports itself and its components', v2.model === 'v2' && v2.components && v2.components.appearance > 0, JSON.stringify(v2.components));
ok('v2 horizon is the sum of its gameweeks', Math.abs(v2.perGw.reduce((a, g) => a + g.xp, 0) - v2.horizon) < 0.05);
const all = b.elements.filter(e => e.minutes > 0).map(e => S.projectPoints_(e, fe).next);
ok('every v2 projection is in a believable range', all.every(x => x >= 0 && x < 15), Math.max.apply(null, all).toFixed(2));
S.XP_MODEL = 'blend'; S.XP_V2_WEIGHT = 0.5;
const bl = S.projectPoints_(someone, fe);
ok('a blend sits between the two', bl.next >= Math.min(v1.next, v2.next) - 0.01 && bl.next <= Math.max(v1.next, v2.next) + 0.01,
  v1.next + ' / ' + bl.next + ' / ' + v2.next);
const saveRates = S.TEAM_RATES_;
S.TEAM_RATES_ = null; S.XP_MODEL = 'v2';
ok('without team rates v2 falls back to v1 rather than failing', S.projectPoints_(someone, fe).model === undefined);
S.TEAM_RATES_ = saveRates; S.XP_MODEL = 'blend'; S.XP_V2_WEIGHT = 0.5;

console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall checks passed');
process.exit(fail ? 1 : 0);
