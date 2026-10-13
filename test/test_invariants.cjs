const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail = 0;
function ok(n, c, x) { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; }

/* Every decision-engine bug reported so far shared a shape: the output was
 * not debatable, it was impossible. A Wildcard worth +262.9 over six weeks. A
 * −8 charged on a week with enough free transfers. Advice for a gameweek that
 * had already locked. None of that needs judgement to catch, only arithmetic
 * checked against itself — which is what checkModelInvariants_ does, before
 * the confident prose on the front page is allowed to sit on top of it.
 */

const HOUR = 3600 * 1000;
function player(id, elementType, teamId, xps) {
  return {
    id: id, name: 'P' + id, elementType: elementType, teamId: teamId, status: 'a',
    xp: { perGw: xps.map((x, i) => ({ event: i + 2, xp: x, fixtures: 1 })),
          horizon: Math.round(xps.reduce((s, x) => s + x, 0) * 100) / 100, next: xps[0] }
  };
}

/* A squad that is legal in every respect: 11 starters in a 1-4-4-2, four on
   the bench, no club over three, no duplicates. */
function goodData() {
  const players = [];
  let id = 1;
  const add = (type, n, teamBase) => { for (let i = 0; i < n; i++) players.push(player(id++, type, teamBase + i, [4, 4, 4])); };
  add(1, 2, 1);   // GK
  add(2, 5, 10);  // DEF
  add(3, 5, 20);  // MID
  add(4, 3, 30);  // FWD
  const starting = [players[0]].concat(players.slice(2, 6), players.slice(7, 11), players.slice(12, 14));
  const bench = players.filter(p => starting.indexOf(p) === -1);
  return {
    gameweekState: { liveEventId: 1, liveInPlay: true, decisionEventId: 2,
      decisionDeadline: new Date(Date.now() + 96 * HOUR).toISOString(), picksEventId: 1 },
    squad: { players: players, starting: starting, bench: bench, bank: 0.5, teamValue: 100 },
    captainSuggestions: [{ name: starting[5].name }],
    transferLedger: S.buildTransferLedger_([], 1),
    transferSuggestions: [],
    chipValues: {}
  };
}

/* ---------- a sound model passes ---------- */
let d = goodData();
let r = S.checkModelInvariants_(d);
ok('a consistent model passes every check', r.ok === true, JSON.stringify(r.failures));
ok('and the starting XI really is eleven', d.squad.starting.length === 11);

function failsWith(label, mutate, expect) {
  const data = goodData();
  mutate(data);
  const res = S.checkModelInvariants_(data);
  const hit = res.failures.filter(f => f.check.indexOf(expect) !== -1).length > 0;
  ok(label, !res.ok && hit, res.failures.map(f => f.check).join(' | ') || 'passed');
}

/* Plausibility is a heuristic, so it warns rather than silencing the page: a
   genuinely poor squad early in a season really can be worth forty points of
   rebuild, and blanking the verdict for that would be its own bug. */
function warnsWith(label, mutate, expect) {
  const data = goodData();
  mutate(data);
  const res = S.checkModelInvariants_(data);
  const hit = (res.warnings || []).filter(f => f.check.indexOf(expect) !== -1).length > 0;
  ok(label, hit, (res.warnings || []).map(f => f.check).join(' | ') || 'no warning');
}

/* ---------- gameweek state ---------- */
failsWith('advising on a gameweek whose deadline has passed is caught',
  d => { d.gameweekState.decisionDeadline = new Date(Date.now() - HOUR).toISOString(); },
  'decision gameweek is still open');

failsWith('picking for the gameweek already being played is caught',
  d => { d.gameweekState.decisionEventId = 1; d.captainSuggestions = []; },
  'decision gameweek is not the live one');

/* ---------- squad shape ---------- */
failsWith('an XI of ten is caught',
  d => { d.squad.starting = d.squad.starting.slice(0, 10); d.captainSuggestions = []; },
  'eleven players');

failsWith('an illegal formation is caught',
  d => { // six defenders
    d.squad.starting.forEach((p, i) => { if (i > 0 && i < 7) p.elementType = 2; });
    d.captainSuggestions = [];
  },
  'legal formation');

failsWith('a fourth player from one club is caught',
  d => { d.squad.players.slice(0, 4).forEach(p => { p.teamId = 99; }); },
  'three players');

failsWith('the same player twice is caught',
  d => { d.squad.players[3] = d.squad.players[2]; },
  'appears twice');

/* ---------- the captain has to be someone you are fielding ---------- */
failsWith('captaining a benched player is caught',
  d => { d.captainSuggestions = [{ name: d.squad.bench[0].name }]; },
  'suggested captain is in the starting XI');

/* ---------- transfer accounting ---------- */
failsWith('charging a hit for a move covered by a free transfer is caught',
  d => { d.transferLedger = { freeTransfersAvailable: 2, transfersRecommended: 1, freeMoves: 0,
    paidMoves: 1, hitCost: 4, grossGain: 10, netGain: 6, horizonGws: 6, atBankCap: false }; },
  'hits match the moves');

failsWith('a hit charged at the wrong rate is caught',
  d => { d.transferLedger = { freeTransfersAvailable: 1, transfersRecommended: 2, freeMoves: 1,
    paidMoves: 1, hitCost: 8, grossGain: 10, netGain: 2, horizonGws: 6, atBankCap: false }; },
  'four points per paid move');

failsWith('a net gain that does not follow from gross less hits is caught',
  d => { d.transferLedger = { freeTransfersAvailable: 1, transfersRecommended: 2, freeMoves: 1,
    paidMoves: 1, hitCost: 4, grossGain: 10, netGain: 10, horizonGws: 6, atBankCap: false }; },
  'net gain is gross gain less hits');

failsWith('spending money the manager does not have is caught',
  d => { d.transferSuggestions = [{ out: 'A', into: 'B', bankAfter: -0.4 }]; },
  'bank never goes negative');

/* ---------- projections add up ---------- */
failsWith('a horizon that is not the sum of its gameweeks is caught',
  d => { d.squad.players[0].xp.horizon = 99; },
  'horizon equals the sum');

/* ---------- chip valuations ---------- */
failsWith('the reported Wildcard gain must be the difference it states',
  d => { d.chipValues = { wildcard: { gain: 20, rebuilt: 300, mine: 260, flagged: 0 } }; },
  'Wildcard gain is the difference');

warnsWith('a Wildcard worth hundreds of points is flagged',
  d => { d.chipValues = { wildcard: { gain: 262.9, rebuilt: 511.1, mine: 248.2, flagged: 0 } }; },
  'plausible range');
ok('but an implausible figure alone does not blank the page',
   (() => { const d2 = goodData(); d2.chipValues = { wildcard: { gain: 262.9, rebuilt: 511.1, mine: 248.2, flagged: 0 } };
            return S.checkModelInvariants_(d2).ok === true; })());

failsWith('the reported Free Hit gain must be the difference it states',
  d => { d.chipValues = { freeHit: { gain: 20, ideal: 60, mine: 26.5 } }; },
  'Free Hit gain is the difference');

/* The reported figures, which were arithmetically self-consistent and still
   wrong: 77.8 was the best eleven IN THE GAME, against a 26.5 that was
   whatever lineup happened to be set. Neither side was a team the manager
   could have fielded, so the difference was not the chip's value. */
warnsWith('a one-week Free Hit worth fifty points is flagged',
  d => { d.chipValues = { freeHit: { gain: 51.3, ideal: 77.8, mine: 26.5 } }; },
  'plausible range');

d = goodData();
d.chipValues = { freeHit: { gain: 13.2, ideal: 61.7, mine: 48.5 } };
ok('a plausible, legally-sourced Free Hit passes', S.checkModelInvariants_(d).ok === true,
   JSON.stringify(S.checkModelInvariants_(d).failures));

/* the real reported figures, once the valuations were rebuilt on legal squads */
d = goodData();
d.chipValues = { wildcard: { gain: 8.4, rebuilt: 268.4, mine: 260, flagged: 0 } };
ok('a plausible, self-consistent Wildcard passes', S.checkModelInvariants_(d).ok === true);

failsWith('a Bench Boost valued on a bench that is not four is caught',
  d => { d.chipValues = { benchBoost: { gain: 20 } }; d.squad.bench = d.squad.bench.slice(0, 3); },
  'four-man bench');

/* ---------- the front page refuses to publish over a failure ---------- */
d = goodData();
d.gameweekState.decisionDeadline = new Date(Date.now() - HOUR).toISOString();
r = S.checkModelInvariants_(d);
const ruling = S.buildInvalidModelRuling_(r);
ok('a failed check withholds the verdict rather than dressing it up',
   ruling.source === 'invalid' && ruling.headline.indexOf('withheld') !== -1, ruling.headline);
ok('and names the check that failed', ruling.body.indexOf('decision gameweek is still open') !== -1, ruling.body);

/* ---------- a flagged figure must not be acted on ---------- */
/* Live regression: the Wildcard was priced at +434.8 over six gameweeks, the
 * plausibility check flagged it, and the front page recommended playing it
 * anyway as instruction number six — because warnings were reported only on
 * the Debug page. Flagging a number in one place while acting on it in
 * another is not a guard rail. */
const flagged = S.buildActionList_({
  chipBoard: [{ label: 'Wildcard 1', status: 'Play now', detail: 'rebuild', value: 434.8 }],
  invariants: { ok: true, warnings: [{ check: 'Wildcard gain is within a plausible range', detail: '+434.8' }] }
});
ok('an implausibly-valued chip is not recommended as an action',
   (flagged.actions || []).filter(a => a.kind === 'chip').length === 0,
   (flagged.actions || []).length + ' actions');

const clean = S.buildActionList_({
  chipBoard: [{ label: 'Wildcard 1', status: 'Play now', detail: 'rebuild', value: 22 }],
  invariants: { ok: true, warnings: [] }
});
ok('a plausibly-valued chip still is',
   (clean.actions || []).filter(a => a.kind === 'chip').length === 1);

/* No invariants at all must not silently suppress every chip. */
const noInv = S.buildActionList_({
  chipBoard: [{ label: 'Wildcard 1', status: 'Play now', detail: 'rebuild', value: 22 }]
});
ok('a missing invariant block does not suppress chips',
   (noInv.actions || []).filter(a => a.kind === 'chip').length === 1);

console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall checks passed');
process.exit(fail ? 1 : 0);
