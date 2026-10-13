// The Player Ratings page's data: every player carries the breakdown of the
// xP the app actually decides on, in the compact form the page rebuilds.
const vm = require('vm');
const path = require('path');
const S = require(path.join(__dirname, 'harness.cjs'));
const { makeSeason } = require(path.join(__dirname, 'synth_season.cjs'));
let fail = 0;
function ok(n, c, x) { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; }

const season = makeSeason({ seed: 31, finishedGws: 5 });
const raw = season.raw;
const resp = b => ({ getResponseCode: () => (b ? 200 : 404), getContentText: () => JSON.stringify(b || {}) });
S.UrlFetchApp = {
  fetch: u => {
    const p = u.replace('https://fantasy.premierleague.com/api', '');
    return resp(p === '/bootstrap-static/' ? raw.bootstrap : p === '/fixtures/' ? raw.fixtures : /picks/.test(p) ? raw.picks[5] : null);
  },
  fetchAll: r => r.map(() => resp(null))
};
vm.runInContext('Date.now = function () { return ' + season.now + '; };', S);
S.PropertiesService.getScriptProperties().setProperty('TEAM_ID', '1');

const d = JSON.parse(S.getPredictionScoresJson());
const keys = d.xpPartsKeys || [];
ok('the page is told which model the app runs', d.model && d.model.name === S.XP_MODEL, JSON.stringify(d.model));
ok('breakdowns arrive as compact arrays in a stated key order',
  keys.length > 10 && d.players.every(p => Array.isArray(p.xpParts) && p.xpParts.length === keys.length));
const get = (p, k) => p.xpParts[keys.indexOf(k)];
const played = d.players.filter(p => get(p, 'v2') != null);
ok('players with minutes get both models’ figures', played.length > 100, played.length);
ok('the blended figure is the xP the page ranks on', played.every(p => Math.abs(get(p, 'blend') - p.xpNext) < 0.011));
ok('and it sits between the two models', played.every(p => {
  const lo = Math.min(get(p, 'v1'), get(p, 'v2')) - 0.02, hi = Math.max(get(p, 'v1'), get(p, 'v2')) + 0.02;
  return get(p, 'blend') >= lo && get(p, 'blend') <= hi;
}));
ok('v2’s parts add up to v2’s total', played.every(p => {
  const sum = ['appearance', 'goals', 'assists', 'cleanSheet', 'conceded', 'saves', 'defensive', 'bonus'].reduce((a, k) => a + (get(p, k) || 0), 0);
  return Math.abs(sum - get(p, 'v2')) < 0.1;
}));
ok('forwards earn no clean-sheet points', played.filter(p => p.position === 'FWD').every(p => get(p, 'cleanSheet') === 0));

console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall checks passed');
process.exit(fail ? 1 : 0);
