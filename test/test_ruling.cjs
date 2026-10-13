const S = require(require('path').join(__dirname, 'harness.cjs'));
let fail = 0;
function ok(n, c, x) { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; }

/* GW7 2026-27: the AI verdict read "Swap Konsa for Bogle. Brighton's form
 * defence beats Aston Villa's setup" when Konsa plays for Arsenal and Bogle
 * for Leeds. The copy model supplied clubs from memory. rulingNamesWrongClub_
 * rejects any club the headline calls do not involve, so the rule-based
 * verdict is shown instead. */
const clubs = [
  ['Arsenal', 'ARS'], ['Aston Villa', 'AVL'], ['Brighton', 'BHA'], ['Leeds', 'LEE'], ['Man City', 'MCI'],
  ['Sunderland', 'SUN'], ['Bournemouth', 'BOU'], ['Spurs', 'TOT'], ['Ipswich', 'IPS'], ["Nott'm Forest", 'NFO']
].map(([name, short]) => ({ name, short }));
const data = {
  clubs,
  transferSuggestions: [{
    out: 'Konsa (ARS, £4.6m)', into: 'Bogle (LEE, £4.5m)', outName: 'Konsa', inName: 'Bogle',
    outClub: 'Arsenal', inClub: 'Leeds', intoReason: 'Projects 27.7 pts over the same window · form 5.0 · next: SUN, BOU, TOT'
  }],
  captainSuggestions: [{ name: 'Haaland', team: 'MCI', nextFixture: 'IPS (H)' }]
};
const wrong = S.rulingNamesWrongClub_;

ok('the GW7 verdict is rejected',
  wrong("Swap Konsa for Bogle. Brighton's form defence beats Aston Villa's setup; Leeds fixture turns favourable from GW10 onwards.", data));
ok('an alias for a wrong club is rejected', wrong('Konsa out, Bogle in: Villa have nothing on Leeds.', data));
ok('a wrong short name is rejected', wrong('Konsa out, Bogle in. BHA defence is the reason.', data));
ok('the clubs of the move are allowed',
  !wrong("Konsa out, Bogle in. Leeds' run beats Arsenal's for the next six weeks.", data));
ok("the incoming player's next opponents are allowed",
  !wrong('Bogle in for Konsa: Leeds face Sunderland, Bournemouth and Spurs.', data));
ok("the captain's club and opponent are allowed", !wrong('Captain Haaland: Man City host Ipswich.', data));
ok('a verdict naming no club passes', !wrong('Konsa out, Bogle in. Captain Haaland. No chip.', data));
ok('Forest is matched as a word, not inside another', !wrong('Konsa out, Bogle in; the forecast holds.', data));
ok('no club list means no check', !wrong("Brighton's defence", { transferSuggestions: data.transferSuggestions }));

/* The stand-in a page load leaves must be replaced by the trigger. It used to
 * be returned as a cache hit, so the written verdict never arrived. The
 * harness has no network, so generation fails: what matters is that it was
 * attempted, and that the note says why the plain verdict is showing. */
const props = S.PropertiesService.getScriptProperties();
props.setProperty('ANTHROPIC_API_KEY', 'test-key');
const sig = S.rulingSignature_(data);
const standIn = S.buildRuleBasedRuling_(data, 'pending');
props.setProperty('RULING_7', JSON.stringify({ signature: sig, ruling: standIn, pending: true }));
const fromTrigger = S.getRuling_(7, data, true);
ok('the trigger does not hand back a pending stand-in', fromTrigger.body.indexOf('could not be generated') !== -1, fromTrigger.body);
ok('a failed attempt stays pending, so the next tick retries', JSON.parse(props.getProperty('RULING_7')).pending === true);
props.setProperty('RULING_7', JSON.stringify({ signature: sig, ruling: { headline: 'Written.', body: 'x', source: 'ai' }, pending: false }));
ok('a written verdict is still served from cache', S.getRuling_(7, data, true).headline === 'Written.');
props.deleteProperty('ANTHROPIC_API_KEY');
ok('without a key the note asks for one', S.buildRuleBasedRuling_(data, 'nokey').body.indexOf('add an Anthropic API key') !== -1);
ok('with a key the note never asks for one', ['pending', 'withheld', 'failed'].every(r =>
  S.buildRuleBasedRuling_(data, r).body.indexOf('add an Anthropic API key') === -1));

process.exit(fail ? 1 : 0);
