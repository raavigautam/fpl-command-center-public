const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail = 0;
function ok(n, c, x) { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; }

/* Reported bug: a fresh squad (GW1 just played, no transfers possible before
 * the season starts) was reporting 2 free transfers entering GW2 instead of
 * the 1 every manager actually gets. Root cause: the loop already grants a
 * transfer via `ft + 1` on every iterated gameweek, and the starting value
 * ALSO counted as a grant — the very first allocation was being counted
 * twice.
 */

function gw(event, transfers, extra) {
  return Object.assign({ event: event, event_transfers: transfers, event_transfers_cost: 0,
    points: 50, points_on_bench: 0, rank: 1, overall_rank: 1, value: 1000, bank: 0 }, extra || {});
}

// --- the exact reported case ---
ok('fresh squad entering GW2 has exactly 1 free transfer, not 2',
   S.estimateFreeTransfers_({ current: [gw(1, 0)], chips: [] }) === 1);

// --- no history at all (can't read it) defaults to 1, not 0 or 2 ---
ok('missing history defaults to 1', S.estimateFreeTransfers_(null) === 1);
ok('empty history defaults to 1', S.estimateFreeTransfers_({ current: [] }) === 1);

// --- using the transfer immediately should leave 1 banked for next week, not 2 ---
ok('using your only transfer in GW2 leaves 1 for GW3, not 2',
   S.estimateFreeTransfers_({ current: [gw(1, 0), gw(2, 1)], chips: [] }) === 1);

// --- rolling a transfer should bank exactly 2, not 3 ---
ok('rolling GW2 banks exactly 2 for GW3',
   S.estimateFreeTransfers_({ current: [gw(1, 0), gw(2, 0)], chips: [] }) === 2);

// --- a longer accumulation, worked by hand against the real FPL rule ---
// GW2 baseline=1, spend 1 -> 0 banked. GW3 baseline=1, spend 0 -> bank 1.
// GW4 baseline=1+1=2, spend 0 -> bank 2. GW5 baseline=1+2=3.
ok('multi-gameweek accumulation matches the real FPL rule',
   S.estimateFreeTransfers_({ current: [gw(1, 0), gw(2, 1), gw(3, 0), gw(4, 0)], chips: [] }) === 3,
   'got ' + S.estimateFreeTransfers_({ current: [gw(1, 0), gw(2, 1), gw(3, 0), gw(4, 0)], chips: [] }));

// --- caps at the banked-transfer maximum ---
ok('banking never exceeds MAX_BANKED_TRANSFERS',
   S.estimateFreeTransfers_({ current: [gw(1,0),gw(2,0),gw(3,0),gw(4,0),gw(5,0),gw(6,0),gw(7,0),gw(8,0)], chips: [] })
     <= S.MAX_BANKED_TRANSFERS);

// --- a wildcard/free-hit gameweek doesn't consume or reset the bank ---
ok('a wildcard gameweek does not touch the transfer bank',
   S.estimateFreeTransfers_({ current: [gw(1, 0), gw(2, 0), gw(3, 20)], chips: [{ event: 3, name: 'wildcard' }] }) === 3,
   'got ' + S.estimateFreeTransfers_({ current: [gw(1, 0), gw(2, 0), gw(3, 20)], chips: [{ event: 3, name: 'wildcard' }] }));

// --- overspending a gameweek (a hit taken) never goes negative ---
ok('spending more transfers than banked floors at zero, not negative',
   S.estimateFreeTransfers_({ current: [gw(1, 0), gw(2, 3)], chips: [] }) >= 1);

console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall checks passed');
process.exit(fail ? 1 : 0);
