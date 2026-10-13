const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail = 0;
function ok(n, c, x) { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; }

/* Reported bug: after ONE gameweek the model was projecting 51.2 points over
 * six weeks for a £4.5m defender, and a Wildcard worth +262.9.
 *
 * Root cause: `form` is points per match over a rolling 30 days and
 * `points_per_game` is points per match over the season. After GW1 both are
 * the same single match, and xpBaseRate_ read them as rates. A 14-point
 * opening weekend became a base rate near 8.5 a week, held for every gameweek
 * of the horizon. The fix treats one match as one match: shrink the
 * observation toward a prior in proportion to how much of it there is.
 */

function el(type, form, ppg, epNext, cost) {
  return { element_type: type, form: String(form), points_per_game: String(ppg), ep_next: String(epNext),
           now_cost: cost == null ? 50 : cost };
}
/* Median price among owned players, per position — what pricedPositionPrior_
   scales against. Set for every case so the prior is deterministic. */
S.PRICE_NORM_ = { 1: 45, 2: 45, 3: 60, 4: 65 };
function withGws(n, fn) {
  const prev = S.SEASON_CONTEXT_;
  S.SEASON_CONTEXT_ = { finishedGws: n, startedGws: n, avgEntryScore: 50 };
  try { return fn(); } finally { S.SEASON_CONTEXT_ = prev; }
}
/* The state the app is actually in for three days out of every seven, and the
   one this suite originally failed to cover: a gameweek IN PROGRESS. Real
   current-season form exists, but nothing is `finished` yet. */
function withLiveGw(started, finished, fn) {
  const prev = S.SEASON_CONTEXT_;
  S.SEASON_CONTEXT_ = { finishedGws: finished, startedGws: started, avgEntryScore: null };
  try { return fn(); } finally { S.SEASON_CONTEXT_ = prev; }
}

/* ---------- the exact reported case ---------- */
// A cheap defender who returned 14 in the opening weekend, with FPL's own
// projection for him at a sober 3.4.
const breakout = el(2, 14, 14, 3.4);

const afterOne = withGws(1, () => S.xpBaseRate_(breakout));
ok('one huge gameweek no longer reads as a rate', afterOne < 6, afterOne.toFixed(2));
ok('but it does move the number up off the prior', afterOne > 3.4, afterOne.toFixed(2));

// The number that actually reached the dashboard was the six-week total.
ok('the six-week projection lands in a believable range for a £4.5m defender',
   afterOne * 6 > 18 && afterOne * 6 < 36, (afterOne * 6).toFixed(1) + ' pts over 6 GWs');

/* ---------- evidence earns its weight ---------- */
const trace = [1, 2, 4, 8, 16, 30].map(n => withGws(n, () => S.xpBaseRate_(breakout)));
ok('the same form is trusted more as matches accumulate',
   trace.every((v, i) => i === 0 || v >= trace[i - 1] - 0.001),
   trace.map(v => v.toFixed(2)).join(' -> '));
/* "Fully trusted" is not the same as "taken at face value": ep_next still
   holds half the blend, so a player FPL projects at 3.4 who averages 14 lands
   between the two however many matches accumulate. What must happen is that
   the shrinkage stops being what holds it down. */
const unshrunk = 0.5 * 3.4 + 0.25 * 14 + 0.25 * 14;
const gapEarly = unshrunk - trace[0];
const gapLate = unshrunk - trace[trace.length - 1];
ok('a season of evidence closes most of the gap to the unshrunk blend',
   gapLate < gapEarly / 2, gapEarly.toFixed(2) + ' -> ' + gapLate.toFixed(2));

/* ---------- shrinkage is symmetric ---------- */
// A premium who blanked once must not be written off either.
const blanked = el(4, 1, 1, 1, 140);
const coldEarly = withGws(1, () => S.xpBaseRate_(blanked));
const coldLate = withGws(30, () => S.xpBaseRate_(blanked));
ok('one blank does not sink an established premium', coldEarly > 4, coldEarly.toFixed(2));
ok('thirty games of blanks eventually do', coldLate < coldEarly, coldLate.toFixed(2));

/* ---------- ordering survives ---------- */
/* Shrinkage must not flatten the pool into one number: a genuinely better
   player should still project higher after one gameweek. */
// Separated by price now — ep_next is form restated, so it cannot carry
// quality the observation does not already have (see XP_BLEND).
const better = withGws(1, () => S.xpBaseRate_(el(3, 12, 12, 12, 110)));
const worse = withGws(1, () => S.xpBaseRate_(el(3, 12, 12, 12, 45)));
ok('two players with identical form are still separated by their prior',
   better > worse, better.toFixed(2) + ' vs ' + worse.toFixed(2));

/* ---------- a gameweek IN PROGRESS is not preseason ---------- */
/* This shipped broken. The shrinkage keyed its "has the season started"
 * test on FINISHED gameweeks, and a gameweek in progress has none — so
 * throughout the entire opening weekend the shrinkage was bypassed and the
 * raw rate came straight back. The fix was deployed and the live page still
 * read 93.0, because the deployed fix never ran. `startedGws` counts
 * gameweeks whose deadline has passed, which is when the API starts
 * populating form at all. */
const liveBase = withLiveGw(1, 0, () => S.xpBaseRate_(breakout));
ok('a live opening gameweek shrinks like any other evidence',
   liveBase < 6, liveBase.toFixed(2));
ok('it does NOT fall back to the raw rate', Math.abs(liveBase - 15) > 1, liveBase.toFixed(2));
ok('and it matches the same evidence once the gameweek finishes',
   Math.abs(liveBase - withGws(1, () => S.xpBaseRate_(breakout))) < 0.001,
   liveBase.toFixed(2));

/* The six-gameweek total is the number that reached the page. */
const liveCurve = withLiveGw(1, 0, () => S.xpBaseCurve_(breakout));
const liveSix = [0,1,2,3,4,5]
  .reduce((sum, i) => sum + liveCurve.prior + (liveCurve.base - liveCurve.prior) * S.horizonDecay_(i), 0);
ok('the reported 93.0 cannot recur mid-gameweek',
   liveSix > 18 && liveSix < 35, liveSix.toFixed(1) + ' base pts over 6 GWs (page showed 90 -> 93)');

/* ---------- preseason is untouched ---------- */
/* Before a ball is kicked, form and ep_next read 0 for the whole pool and
   points_per_game still carries LAST season's rate — an average over 38
   matches, which needs no shrinking and is the best prior available. */
const preseason = el(3, 0, 5.2, 0);
ok('preseason still reads last season straight through',
   withLiveGw(0, 0, () => S.xpBaseRate_(preseason)) === 5.2,
   String(withLiveGw(0, 0, () => S.xpBaseRate_(preseason))));
ok('true preseason is nothing STARTED, not nothing finished',
   withLiveGw(0, 0, () => S.xpBaseRate_(breakout)) === 14 &&
   withLiveGw(1, 0, () => S.xpBaseRate_(breakout)) < 6,
   'no ball kicked -> ' + withLiveGw(0, 0, () => S.xpBaseRate_(breakout)) +
   ' (last season, untouched); first whistle -> ' +
   withLiveGw(1, 0, () => S.xpBaseRate_(breakout)).toFixed(2) + ' (shrunk)');

/* ---------- no prior available ---------- */
/* ep_next is 0 for a game or two after the season starts. A positional rate
   stands in rather than the observation being taken at face value. */
const noPrior = withGws(1, () => S.xpBaseRate_(el(4, 13, 13, 0)));
ok('a missing ep_next falls back to a positional prior, not to raw form',
   noPrior < 8, noPrior.toFixed(2));

/* ---------- the rate must not persist flat across the horizon ---------- */
/* Reported from the live page: a defender who scored ~15 in GW1 was projected
 * at 93.0 over six gameweeks. Shrinking the observation fixes how far the
 * estimate moves off the prior; it does not fix the estimate then being
 * applied UNCHANGED to every gameweek, which projects a hot streak to persist
 * at full strength for six weeks and compounds the error linearly. `form` is a
 * rolling 30-day average — it says much less about a match six weeks out. */
const curve = withGws(1, () => S.xpBaseCurve_(breakout));
const at = idx => curve.prior + (curve.base - curve.prior) * S.horizonDecay_(idx);

ok('the near gameweek keeps the edge the evidence supports',
   Math.abs(at(0) - curve.base) < 0.001, at(0).toFixed(2));
ok('the far gameweek regresses toward the prior', at(5) < at(0), at(5).toFixed(2));
ok('and the curve is monotone, never bouncing',
   [0,1,2,3,4,5].every(i => i === 0 || at(i) <= at(i - 1) + 1e-9),
   [0,1,2,3,4,5].map(i => at(i).toFixed(2)).join(' -> '));
ok('it never falls through the prior', at(5) > curve.prior, at(5).toFixed(2) + ' vs prior ' + curve.prior);

/* The decay must only bite where observation and prior actually disagree.
   A player performing exactly at his baseline has nothing to regress, so his
   week-six number must equal his week-one number. */
// "At his own baseline" = form equal to what his price says to expect.
const steadyPrior = (() => { const c = withGws(1, () => S.xpBaseCurve_(el(3, 0.1, 0.1, 0, 60))); return c.prior; })();
const steady = withGws(1, () => S.xpBaseCurve_(el(3, steadyPrior, steadyPrior, steadyPrior, 60)));
const steadyAt = idx => steady.prior + (steady.base - steady.prior) * S.horizonDecay_(idx);
ok('a player at his own baseline does not fade at all',
   Math.abs(steadyAt(5) - steadyAt(0)) < 0.01,
   steadyAt(0).toFixed(2) + ' -> ' + steadyAt(5).toFixed(2));

/* An established premium must not be regressed to a positional average just
   for being far away — his prior IS his quality. */
const elite = withGws(1, () => S.xpBaseCurve_(el(4, 8, 8, 8, 155)));
const eliteAt = idx => elite.prior + (elite.base - elite.prior) * S.horizonDecay_(idx);
ok('an elite player keeps his level across the horizon', eliteAt(5) > 6.5, eliteAt(5).toFixed(2));

ok('decay starts at full weight', S.horizonDecay_(0) === 1);
ok('and halves over the stated half-life',
   Math.abs(S.horizonDecay_(S.XP_FORM_HALF_LIFE_GWS) - 0.5) < 1e-9,
   String(S.horizonDecay_(S.XP_FORM_HALF_LIFE_GWS)));

/* The whole point, in one number: the six-gameweek total for the reported
   player, against the 93.0 the deployed page showed. */
const sixGw = [0,1,2,3,4,5].reduce((sum, i) => sum + at(i), 0);
ok('the reported 93-point projection is gone',
   sixGw > 18 && sixGw < 35, sixGw.toFixed(1) + ' base pts over 6 GWs (was ~90)');

/* ---------- preseason has no streak to fade ---------- */
const pre = withGws(0, () => S.xpBaseCurve_(el(3, 0, 5.2, 0)));
ok('a full-season baseline is a level, not a streak, so it does not decay',
   pre.prior === pre.base, pre.base + ' / ' + pre.prior);

/* ---------- the fallback prior must still know who the player is ---------- */
/* Second live regression, and the opposite failure from the first. `ep_next`
 * reads 0 for the whole pool early in a season, and the fallback prior was a
 * flat positional constant — so once the shrinkage pulled everyone's single
 * match toward it, a £15.5m striker and a £4.5m bench forward shared a
 * baseline. The board collapsed to one number: Haaland projecting 3.4 a week,
 * every transfer margin inside the noise, and the genuinely good early pick
 * no longer distinguishable from anyone else. Fixing over-confidence by
 * destroying the signal is not a fix. */
const same = f => (t, cost) => withLiveGw(1, 0, () => S.xpBaseRate_(el(t, f, f, 0, cost)));
const atForm2 = same(2);

const haaland = atForm2(4, 155);
const isak = atForm2(4, 90);
const benchFwd = atForm2(4, 45);

ok('identical form no longer means an identical projection',
   haaland > isak && isak > benchFwd,
   [haaland, isak, benchFwd].map(v => v.toFixed(2)).join(' > '));
ok('a premium striker projects like one, not like a bench player',
   haaland > 5.5, haaland.toFixed(2) + ' (the live page showed 3.4)');
ok('and bench fodder is not flattered up to a premium', benchFwd < 3, benchFwd.toFixed(2));

/* The point of the whole exercise: the good early pick must still stand out
   from the player he would replace, or the transfer engine has nothing to
   rank on. */
const deCuyper = withLiveGw(1, 0, () => S.xpBaseRate_(el(2, 15, 15, 0, 45)));
const maguire = withLiveGw(1, 0, () => S.xpBaseRate_(el(2, 1, 1, 0, 50)));
ok('a 15-point opening weekend still separates a player from a cold one',
   deCuyper - maguire > 1.5, deCuyper.toFixed(2) + ' vs ' + maguire.toFixed(2));
ok('but not by anything like the old margin', deCuyper < 6, deCuyper.toFixed(2));

/* The scaling is bounded at both ends: price is a signal, not a promise. */
const absurd = atForm2(4, 400);
ok('no price tag buys an unbounded projection',
   absurd / atForm2(4, 65) <= S.XP_PRICE_PRIOR_MAX + 0.001,
   absurd.toFixed(2));
ok('missing price data degrades to the flat positional rate',
   withLiveGw(1, 0, () => S.xpBaseRate_({ element_type: 4, form: '2', points_per_game: '2', ep_next: '0' })) > 0);

/* ep_next is form restated on the live API (354 of 355 fit players before
   GW6 of 2026-27), so it must never be the prior: a prior equal to the
   observation shrinks nothing. The live case that exposed it — a £6.2m
   defender on five matches of 11.0, with ep_next 11.0 — projected 62 points
   over six gameweeks. */
const tarkowski = withLiveGw(5, 5, () => S.xpBaseCurve_(el(2, 11, 8.6, 11, 62)));
ok('ep_next is never the prior', Math.abs(tarkowski.prior - 11) > 3, tarkowski.prior.toFixed(2));
ok('a five-match hot streak is regressed toward what the price says',
   tarkowski.base < 8 && tarkowski.base > tarkowski.prior, tarkowski.base.toFixed(2));
ok('ep_next does not move the projection at all',
   Math.abs(withLiveGw(5, 5, () => S.xpBaseRate_(el(2, 11, 8.6, 0, 62))) - tarkowski.base) < 1e-9);

/* ---------- the shrink function itself ---------- */
ok('no matches means the prior alone', S.shrinkRate_(20, 0, 4) === 4);
ok('the observation never fully replaces the prior', S.shrinkRate_(20, 1000, 4) < 20);
ok('and it approaches it', S.shrinkRate_(20, 1000, 4) > 19.9, S.shrinkRate_(20, 1000, 4).toFixed(3));
ok('an observation equal to the prior moves nothing', S.shrinkRate_(4, 5, 4) === 4);

console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall checks passed');
process.exit(fail ? 1 : 0);
