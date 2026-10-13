const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail = 0;
function ok(n, c, x) { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; }

/* Reported bug: with GW1 being played and the GW2 deadline four days away,
 * the app produced copy saying GW2 was "already locked", labelled its
 * recommendations "this gameweek" without saying which, and priced chips
 * against a gameweek id that could never match the one they were valued for.
 *
 * Root cause: one variable, `is_current || is_next`, was standing in for
 * three different questions — what is being PLAYED, what is being PICKED FOR,
 * and what can be READ. resolveGameweekState_ answers them separately.
 */

const HOUR = 3600 * 1000;
function ev(id, deadlineOffsetHours, extra) {
  return Object.assign({
    id: id,
    deadline_time: new Date(NOW + deadlineOffsetHours * HOUR).toISOString(),
    finished: false, is_current: false, is_next: false
  }, extra || {});
}

const NOW = Date.parse('2026-08-23T12:00:00Z');

/* ---------- GW1 in progress, GW2 deadline still ahead ---------- */
// This is the exact reported state: GW1 kicked off two days ago, GW2's
// deadline is five days out.
let events = [
  ev(1, -48, { is_current: true }),
  ev(2, 120, { is_next: true }),
  ev(3, 288)
];
let st = S.resolveGameweekState_(events, NOW);

ok('the gameweek being played is GW1', st.liveEventId === 1, st.liveEventId);
ok('a gameweek is in play', st.liveInPlay === true);
ok('the gameweek being picked for is GW2', st.decisionEventId === 2, st.decisionEventId);
ok('GW2 is NOT locked — the whole reported bug', st.canActOn(2) === true);
ok('GW1 IS locked', st.canActOn(1) === false);
ok('squad is read from the locked gameweek', st.picksEventId === 1, st.picksEventId);
ok('the deadline shown belongs to the decision gameweek',
   st.decisionDeadline === events[1].deadline_time);

/* ---------- between gameweeks: GW1 finished, GW2 not yet started ---------- */
events = [
  ev(1, -168, { finished: true, is_current: true }),
  ev(2, 48, { is_next: true }),
  ev(3, 216)
];
st = S.resolveGameweekState_(events, NOW);
ok('nothing is being played between gameweeks', st.liveEventId === null, String(st.liveEventId));
ok('and the app says so rather than naming a live gameweek', st.liveInPlay === false);
ok('the decision gameweek is still GW2', st.decisionEventId === 2, st.decisionEventId);
ok('picks still read from the last locked gameweek', st.picksEventId === 1, st.picksEventId);

/* ---------- the hour after a deadline passes ---------- */
/* FPL's own is_current/is_next flags lag the deadline they describe: for a
 * while after GW2 locks, the API still reports GW1 as current and GW2 as
 * next. Reading the flags rather than the clock meant advising on a gameweek
 * that had just closed. */
events = [
  ev(1, -168, { finished: true, is_current: true }),
  ev(2, -1, { is_next: true }),
  ev(3, 167)
];
st = S.resolveGameweekState_(events, NOW);
ok('a just-passed deadline moves the decision on, whatever is_next says',
   st.decisionEventId === 3, st.decisionEventId);
ok('and the gameweek that just locked is the live one', st.liveEventId === 2, st.liveEventId);
ok('advice can no longer be given for the gameweek that just locked',
   st.canActOn(2) === false);

/* ---------- preseason ---------- */
events = [ev(1, 72, { is_next: true }), ev(2, 240)];
st = S.resolveGameweekState_(events, NOW);
ok('preseason has no live gameweek', st.liveEventId === null);
ok('preseason has not started', st.seasonStarted === false);
ok('preseason picks for GW1', st.decisionEventId === 1, st.decisionEventId);
ok('and nothing is readable yet', st.picksEventId === null, String(st.picksEventId));

/* ---------- end of season ---------- */
events = [ev(37, -336, { finished: true }), ev(38, -168, { finished: true, is_current: true })];
st = S.resolveGameweekState_(events, NOW);
ok('a finished season has nothing left to pick for', st.seasonOver === true);
ok('and names no decision gameweek', st.decisionEventId === null, String(st.decisionEventId));
ok('but still knows the last one played', st.lastFinishedEventId === 38, st.lastFinishedEventId);

/* ---------- the horizon and the label agree ---------- */
/* The projection window and the gameweek every number is LABELLED with are
 * now decided by the same function. When they were decided separately, a
 * projection for GW3 could be shown, snapshotted and graded as GW2. */
events = [ev(1, -48, { is_current: true }), ev(2, 120, { is_next: true }), ev(3, 288), ev(4, 456)];
st = S.resolveGameweekState_(events, NOW);
const horizon = events.filter(e => st.canActOn(e.id)).map(e => e.id);
ok('the horizon starts at the decision gameweek, not the live one',
   horizon[0] === st.decisionEventId, JSON.stringify(horizon));
ok('and the live gameweek is never in it', horizon.indexOf(st.liveEventId) === -1);

console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall checks passed');
process.exit(fail ? 1 : 0);
