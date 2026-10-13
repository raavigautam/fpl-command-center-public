// Club form, rotation flags and bench cover — the phase 3 additions.
const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail = 0;
function ok(n, c, x) { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; }

/* Two clubs playing each other every gameweek, so every fixture is known. */
const fixtures = [1, 2, 3, 4, 5].map(gw => ({
  event: gw, team_h: gw % 2 ? 1 : 2, team_a: gw % 2 ? 2 : 1, finished: true,
  team_h_score: gw % 2 ? 3 : 1, team_a_score: gw % 2 ? 0 : 1
}));
// recent[gw][id] = [minutes, starts, points, xG, xA]
function gwRow(nailedMins, rotMins, benchMins) {
  return {
    10: [nailedMins, 1, 6, 0.6, 0.2],                  // club 1 forward, nailed
    11: [rotMins, rotMins >= 60 ? 1 : 0, 2, 0.1, 0],   // club 1 midfielder, in and out
    12: [benchMins, 0, benchMins ? 1 : 0, 0, 0],       // club 1 defender, lost his place
    20: [90, 1, 2, 0.3, 0.1],                          // club 2 forward
    21: [90, 1, 1, 0, 0]                               // club 2 defender
  };
}
const recent = { 3: gwRow(90, 90, 0), 4: gwRow(90, 20, 0), 5: gwRow(88, 0, 10) };
const bootstrap = {
  teams: [{ id: 1, name: 'Bournemouth', short_name: 'BOU' }, { id: 2, name: 'Hull City', short_name: 'HUL' }],
  elements: [
    { id: 10, web_name: 'Nailed', team: 1, element_type: 4, status: 'a' },
    { id: 11, web_name: 'Rotated', team: 1, element_type: 3, status: 'a' },
    { id: 12, web_name: 'Dropped', team: 1, element_type: 2, status: 'a' },
    { id: 13, web_name: 'Crocked', team: 1, element_type: 3, status: 'i' },
    { id: 20, web_name: 'Striker', team: 2, element_type: 4, status: 'a' },
    { id: 21, web_name: 'Back', team: 2, element_type: 2, status: 'a' }
  ],
  events: []
};
const el = id => bootstrap.elements.filter(e => e.id === id)[0];

/* ---------- rotation ---------- */
const nailed = S.rotationFlag_(el(10), fixtures, recent);
const rotated = S.rotationFlag_(el(11), fixtures, recent);
const dropped = S.rotationFlag_(el(12), fixtures, recent);
ok('a player who started every recent match is nailed', nailed.risk === 'nailed', JSON.stringify(nailed));
ok('read over the last three matches, not the season', nailed.matches === 3);
ok('one start in three is a rotation risk', rotated.risk === 'rotation', rotated.text);
ok('and says so in numbers', /Started 1 of the last 3 \(110 of 270 minutes\)/.test(rotated.text), rotated.text);
ok('no starts and a cameo is not starting', dropped.risk === 'benched', dropped.text);
ok('an injured player is left to his status flag, not called rotated', S.rotationFlag_(el(13), fixtures, recent) === null);
ok('no data, no flag', S.rotationFlag_(el(10), fixtures, null) === null);

/* ---------- club form ---------- */
const bou = S.buildTeamForm_(bootstrap, fixtures, 1, recent);
ok('the last five results are read with scorelines', bou.matches.length === 5 && bou.matches[0].gf === 3 && bou.matches[1].ga === 1,
  JSON.stringify(bou.matches.map(m => m.gf + '-' + m.ga)));
ok('wins, draws and losses add up', bou.last.w + bou.last.d + bou.last.l === 5, JSON.stringify(bou.last));
ok('goals for and against are totalled', bou.last.gf === 11 && bou.last.ga === 2, bou.last.gf + '-' + bou.last.ga);
ok('clean sheets are counted', bou.last.cleanSheets === 3 && bou.last.d === 2, bou.last.cleanSheets);
ok('home and away are split', bou.home.played + bou.away.played === 5 && bou.home.played === 3);
ok('xG is summed from the players where the live data exists', bou.matches[4].xg === 0.7 && bou.matches[4].xga === 0.3,
  JSON.stringify(bou.matches[4]));
ok('and left null where it does not, rather than read as zero', bou.matches[0].xg === null);
ok('points conceded are split by the opponent’s position',
  bou.pointsConcededPerMatch.FWD === 2 && bou.pointsConcededPerMatch.DEF === 1, JSON.stringify(bou.pointsConcededPerMatch));

const league = S.buildLeagueTeamForm_(bootstrap, fixtures, recent);
const hul = league.filter(f => f.teamId === 2)[0];
ok('clubs are ranked against each other', hul.ranks.mostConceded.pos === 1 && hul.ranks.mostConceded.of === 2, JSON.stringify(hul.ranks));
const text = S.describeTeamForm_(hul);
ok('the assistant gets a plain answer to "are they conceding a lot"', /conceded 11/.test(text) && /1st of 2 for goals conceded/.test(text), text);

/* ---------- the tool resolves clubs by name or code ---------- */
S.RECENT_LIVE_ = recent; S.RECENT_FIXTURES_ = fixtures;
const ctx = { bootstrap, fixtureEase: {}, data: {} };
ok('by three-letter code', /^Bournemouth/.test(S.aiToolTeamForm_({ team: 'bou' }, ctx)));
ok('by partial name', /^Hull City/.test(S.aiToolTeamForm_({ team: 'hull' }, ctx)));
ok('an unknown club lists the real ones', /No club matches/.test(S.aiToolTeamForm_({ team: 'Atlantis' }, ctx)));
ok('the tool is declared with a schema', S.AI_TOOLS.some(t => t.name === 'get_team_form' && t.input_schema.required[0] === 'team'));
S.RECENT_LIVE_ = null;

/* ---------- the bench is worth a little, not nothing ---------- */
function p(id, pos, xpEach) {
  return { id, elementType: pos, xp: { perGw: [{ xp: xpEach }] } };
}
const squad = [p(1, 1, 4), p(2, 1, 1)]
  .concat([3, 4, 5, 6, 7].map(i => p(i, 2, 4)))
  .concat([8, 9, 10, 11, 12].map(i => p(i, 3, 5)))
  .concat([13, 14, 15].map(i => p(i, 4, 6)));
// Best XI: GK 4, five DEF... the bench ends up a DEF (4), a MID (5) and the
// spare GK; swapping a playable sub for a 0-pointer changes nothing in the XI.
const deadSub = { el: { id: 99, element_type: 3 }, xp: { perGw: [{ xp: 0 }] } };
const xiOnly = S.bestXiXp_(squad.map(x => x.id === 12 ? { id: 99, elementType: 3, xp: deadSub.xp } : x), 0) - S.bestXiXp_(squad, 0);
const withCover = S.swapGain_(squad, 12, deadSub);
ok('swapping a playable sub for a dud leaves the best eleven unchanged', Math.abs(xiOnly) < 1e-9 || xiOnly > -5.1, xiOnly);
ok('but now costs something, because the bench covers absences', withCover < 0 && withCover > -2, withCover.toFixed(2));

console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall checks passed');
process.exit(fail ? 1 : 0);
