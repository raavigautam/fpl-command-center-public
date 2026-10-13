const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail = 0;
function ok(n, c, x) { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; }

/* Reported bug: the front page announced "two free transfers lock in +42.6
 * and +37 projected points" directly above a header reading 1 free transfer
 * and a plan charging −8 for three moves.
 *
 * Root cause: several layers each restated the transfer accounting in their
 * own words, and the worst of them was a language model handed prose and
 * asked to infer the numbers back out. buildTransferLedger_ counts once;
 * everything else reads it.
 */

function move(gain, usesHit) {
  return {
    out: 'A (DEF)', into: 'B (DEF)', outName: 'A', inName: 'B',
    projectedGain: gain, usesHit: !!usesHit,
    netGain: gain - (usesHit ? 4 : 0), horizonGws: 6, confidence: 'medium'
  };
}

/* ---------- the exact reported case: 1 FT, 3 moves ---------- */
let led = S.buildTransferLedger_([move(12.4), move(9.1, true), move(7.6, true)], 1);
ok('one free transfer is reported as one', led.freeTransfersAvailable === 1, led.freeTransfersAvailable);
ok('three moves are reported as three', led.transfersRecommended === 3, led.transfersRecommended);
ok('exactly one of them is free', led.freeMoves === 1, led.freeMoves);
ok('the other two cost a hit each', led.paidMoves === 2, led.paidMoves);
ok('which is an 8-point charge, not 4 and not 12', led.hitCost === 8, led.hitCost);
ok('gross gain adds the moves up', Math.abs(led.grossGain - 29.1) < 0.05, led.grossGain);
ok('net gain subtracts the hits', Math.abs(led.netGain - 21.1) < 0.05, led.netGain);
ok('the one-line rendering states all three facts',
   led.summary === '3 transfers · 1 FT · −8 hit', led.summary);

/* ---------- the prose is generated FROM the ledger ---------- */
/* This is the actual regression: the plan's sentence must not be able to
 * disagree with the numbers beside it. */
let plan = S.buildTransferPlan_([move(12.4), move(9.1, true), move(7.6, true)], 1, null, led);
ok('the plan reports the same free-transfer count', plan.freeTransfers === 1, plan.freeTransfers);
ok('the plan never claims free transfers it does not have',
   plan.headline.indexOf('2 free') === -1 && plan.detail.indexOf('free transfers banked') === -1,
   plan.headline + ' / ' + plan.detail);
ok('the headline quotes the real hit', plan.headline.indexOf('−8') !== -1, plan.headline);
ok('the detail quotes the net figure from the ledger',
   plan.detail.indexOf('+' + led.netGain.toFixed(1)) !== -1, plan.detail);
ok('the plan carries the ledger so downstream cannot recompute it', plan.ledger === led);

/* ---------- two banked transfers, two moves, no hit ---------- */
led = S.buildTransferLedger_([move(8), move(6)], 2);
ok('two moves on two free transfers cost nothing', led.hitCost === 0, led.hitCost);
ok('and both count as free', led.freeMoves === 2 && led.paidMoves === 0);
ok('the summary omits a hit that was not taken',
   led.summary === '2 transfers · 2 FT', led.summary);
plan = S.buildTransferPlan_([move(8), move(6)], 2, null, led);
ok('a costless plan says so', plan.action === 'transfer' && plan.headline.indexOf('all free') !== -1, plan.headline);

/* ---------- a single free move ---------- */
led = S.buildTransferLedger_([move(9)], 1);
ok('one move on one FT leaves nothing banked', led.freeTransfersUnused === 0, led.freeTransfersUnused);
ok('net equals gross when nothing is paid', led.netGain === led.grossGain, led.netGain);

/* ---------- rolling ---------- */
led = S.buildTransferLedger_([], 2);
ok('no moves means no hits', led.hitCost === 0 && led.transfersRecommended === 0);
ok('and both free transfers stay banked', led.freeTransfersUnused === 2, led.freeTransfersUnused);
ok('the summary says there is no transfer', led.summary === 'No transfer', led.summary);
plan = S.buildTransferPlan_([], 2, null, led);
ok('rolling is the recommended action', plan.action === 'roll', plan.action);
ok('and it says what banking buys', plan.detail.indexOf('3 free transfers') !== -1, plan.detail);

/* ---------- the banking cap ---------- */
led = S.buildTransferLedger_([], S.MAX_BANKED_TRANSFERS);
ok('the cap is recognised', led.atBankCap === true);
plan = S.buildTransferPlan_([], S.MAX_BANKED_TRANSFERS, null, led);
ok('at the cap the advice is to spend, not to roll',
   plan.headline.indexOf('cannot bank another') !== -1, plan.headline);

/* ---------- the ledger always reconciles ---------- */
/* Whatever the inputs, the identities the invariant check enforces must hold
 * — this is the property the contradictory front page violated. */
for (let ft = 1; ft <= 5; ft++) {
  for (let n = 0; n <= 5; n++) {
    const moves = [];
    for (let i = 0; i < n; i++) moves.push(move(5 + i, i >= ft));
    const l = S.buildTransferLedger_(moves, ft);
    if (l.freeMoves + l.paidMoves !== l.transfersRecommended) { ok('moves partition at ' + ft + '/' + n, false); }
    if (l.paidMoves !== Math.max(0, n - ft)) { ok('paid count at ' + ft + '/' + n, false, l.paidMoves); }
    if (l.hitCost !== l.paidMoves * 4) { ok('hit cost at ' + ft + '/' + n, false, l.hitCost); }
    if (Math.abs((l.grossGain - l.hitCost) - l.netGain) > 0.051) { ok('net at ' + ft + '/' + n, false, l.netGain); }
  }
}
ok('every free-transfer/move combination reconciles', true, '1-5 FT x 0-5 moves');

console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall checks passed');
process.exit(fail ? 1 : 0);
