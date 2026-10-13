// Loads Index.html's script block with a minimal DOM stub so the palette's
// pure logic and answer builders can be exercised without a browser.
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(require('path').join(__dirname, '..', 'Index.html'), 'utf8');
let js = html.match(/<script>([\s\S]*)<\/script>/)[1];
// Strip Apps Script template tags — they are server-rendered.
js = js.replace(/<\?[=!]?[\s\S]*?\?>/g, 'STUB');

const els = {};
function el(id) {
  if (!els[id]) els[id] = { id, value: '', innerHTML: '', textContent: '', hidden: false,
    children: [], classList: { add(){}, remove(){} }, focus(){}, addEventListener(){},
    querySelector: () => null, closest: () => null, scrollIntoView(){} };
  return els[id];
}
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  navigator: { platform: 'MacIntel', userAgent: 'test' },
  window: { top: { location: { href: '' } } },
  document: {
    getElementById: el,
    querySelectorAll: () => [],
    addEventListener: () => {},
    body: el('body')
  },
  google: { script: { run: (function () {
    // Chainable no-op: every google.script.run call in this file is
    // .withSuccessHandler(..).withFailureHandler(..).method(..)
    const chain = new Proxy({}, { get: () => () => chain });
    return chain;
  })() } }
};
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);
vm.runInContext(js, sandbox, { filename: 'Index.html:script' });

let fail = 0;
function ok(n, c, x) { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; }

// --- fuzzy matching ---
const s = sandbox.paletteScore_;
ok('exact prefix beats a substring', s('Semenyo', 'sem') > s('Rosenior', 'sen'));
ok('subsequence matches', s('Semenyo', 'smny') > 0);
ok('non-matching returns zero', s('Semenyo', 'zzz') === 0);
ok('empty query matches everything', s('Semenyo', '') > 0);
ok('a tighter match ranks higher', s('Salah', 'sal') > s('Marmoush', 'sal'), s('Salah','sal') + ' vs ' + s('Marmoush','sal'));

// --- answer builders against a realistic STATE ---
sandbox.STATE.data = {
  hasAiKey: true,
  captainSuggestions: [
    { name: 'Haaland', team: 'MCI', nextFixture: 'BUR (H)', xp: 7.4, margin: 1.2, confidence: 'Medium', form: '6.0' },
    { name: 'Salah', team: 'LIV', nextFixture: 'EVE (A)', xp: 6.2, margin: null, confidence: 'Low', form: '5.5' }
  ],
  squad: { players: [
    { id: 1, name: 'Semenyo', team: 'BOU', position: 'MID', price: 7.5, form: '6.2', selectedBy: 22.4,
      isStarting: true, isCaptain: false, status: 'a', reason: 'Strong underlying numbers.',
      xp: { next: 5.1, horizon: 28.4 } },
    { id: 2, name: 'Stach', team: 'LEE', position: 'MID', price: 5.0, form: '4.1', selectedBy: 3.2,
      isStarting: false, isCaptain: false, status: 'i', news: 'Knee injury - 50% chance', xp: { next: 1.2, horizon: 9.0 } }
  ] },
  leagueEo: { leagueName: 'The Office', net: -3.4, summary: 'You are behind the field.',
    threats: [{ name: 'Palmer', eo: 78, delta: -4.1 }] },
  roadmap: { horizonGws: 6, weeks: [
    { event: 10, moves: [{ inName: 'Semenyo', outName: 'Mbeumo' }], hits: 0 },
    { event: 11, moves: [], hits: 0 }
  ], divergence: { summary: 'Holding this week is worth 2.1 more.' } },
  priceWatch: { urgent: { name: 'Semenyo' }, targets: [{ name: 'Semenyo', why: 'A recommended transfer in', label: 'Rising — likely tonight' }], squad: [], movers: [] },
  lineup: { formation: '3-5-2', projected: 52.1, currentProjected: 49.8, changes: [{ inName: 'Semenyo', outName: 'Stach', gain: 2.3 }] }
};

function has(html, txt) { return String(html).indexOf(txt) !== -1; }
ok('/cap names the pick and the margin', has(sandbox.paletteCaptain_(), 'Haaland') && has(sandbox.paletteCaptain_(), '1.2 points clear'));
ok('/player finds a squad player fuzzily', has(sandbox.palettePlayer_('smny'), 'Semenyo'));
ok('/player shows the injury news over the generic read', has(sandbox.palettePlayer_('Stach'), 'Knee injury'));
ok('/player on an unknown name says so', has(sandbox.palettePlayer_('Zzzz'), 'No one in your squad matches'));
ok('/eo reports net exposure', has(sandbox.paletteEo_(), '-3.4') && has(sandbox.paletteEo_(), 'Palmer'));
ok('/plan lists every gameweek', has(sandbox.palettePlan_(), 'GW10') && has(sandbox.palettePlan_(), 'GW11'));
ok('/plan surfaces a divergence', has(sandbox.palettePlan_(), 'Holding this week'));
ok('/price leads with the urgent buy', has(sandbox.palettePrice_(), 'Semenyo'));
ok('/xi reports the formation and the swap', has(sandbox.paletteXi_(), '3-5-2') && has(sandbox.paletteXi_(), '+2.3'));

// Missing data must degrade, not throw.
const empty = { hasAiKey: false, squad: { players: [] } };
sandbox.STATE.data = empty;
['paletteCaptain_','paletteEo_','palettePlan_','palettePrice_','paletteXi_'].forEach(fn => {
  let threw = false, out = '';
  try { out = sandbox[fn](); } catch (e) { threw = true; }
  ok(fn + ' degrades rather than throwing on missing data', !threw && has(out, 'Not available'));
});

// XSS: a player name is untrusted text as far as the palette is concerned.
sandbox.STATE.data = { squad: { players: [{ id: 9, name: '<img src=x onerror=alert(1)>', team: 'X', position: 'MID',
  price: 4.0, form: '0.0', selectedBy: 0.1, isStarting: false, isCaptain: false, status: 'a', xp: { next: 0, horizon: 0 } }] } };
const card = sandbox.palettePlayerCard_(sandbox.STATE.data.squad.players[0]);
ok('escapes player names', !has(card, '<img') && has(card, '&lt;img'));

// /compare deep link
sandbox.RATINGS_URL = 'https://example.test/?page=ratings';
sandbox.paletteCompare_('Semenyo Stach');
ok('/compare deep-links with both names',
   has(sandbox.window.top.location.href, 'compare=Semenyo%2CStach'), sandbox.window.top.location.href);
ok('/compare with no names explains itself', has(sandbox.paletteCompare_(''), 'Name two players'));

/* ===================== ESCAPE-BY-DEFAULT RENDERER ===================== */
const h = sandbox.h, raw = sandbox.raw;
ok('renders a plain element', h('div', {}, 'hi') === '<div>hi</div>', h('div',{},'hi'));
ok('escapes text content by default',
   h('div', {}, '<script>x</script>') === '<div>&lt;script&gt;x&lt;/script&gt;</div>', h('div',{},'<script>x</script>'));
ok('escapes attribute values',
   h('div', { title: '"><img src=x onerror=alert(1)>' }).indexOf('<img') === -1,
   h('div', { title: '"><img src=x>' }));
ok('escapes single quotes in attributes', h('div', { title: "it's" }).indexOf('&#39;') !== -1);
ok('raw() is the only way through', h('div', {}, raw('<b>x</b>')) === '<div><b>x</b></div>');
ok('drops null and false attributes', h('div', { a: null, b: false, c: 'x' }) === '<div c="x"></div>',
   h('div',{a:null,b:false,c:'x'}));
ok('renders boolean attributes bare', h('input', { disabled: true }) === '<input disabled>');
ok('void tags are not closed', h('br', {}) === '<br>');
ok('accepts an array of children', h('p', {}, ['a', 'b']) === '<p>ab</p>');
ok('skips null children', h('p', {}, ['a', null, false, 'b']) === '<p>ab</p>');
ok('handles no children at all', h('div', {}) === '<div></div>');
ok('coerces numbers', h('span', {}, 5) === '<span>5</span>');
ok('escapes ampersands once', h('span', {}, 'a & b') === '<span>a &amp; b</span>');

/* A nested h() call returns a plain HTML string, and h()'s own child
 * renderer treats a plain string as untrusted text — that is the entire
 * mechanism escape-by-default relies on. So nesting h() inside h() without
 * wrapping the inner call in raw() is a live footgun: it does not throw,
 * it does not look wrong in isolation, it just silently turns the inner
 * markup into visible escaped tag soup. Documented here as its own case,
 * separately from playerRowHtml_, so the failure mode is asserted on
 * directly rather than only inferred from one call site happening to get
 * it right. */
const nestedUnwrapped = h('div', {}, h('span', {}, 'x'));
ok('an unwrapped nested h() call is escaped, not rendered as markup — this is the footgun',
   nestedUnwrapped === '<div>&lt;span&gt;x&lt;/span&gt;</div>', nestedUnwrapped);
const nestedWrapped = h('div', {}, raw(h('span', {}, 'x')));
ok('wrapping the same nested call in raw() renders it as real markup',
   nestedWrapped === '<div><span>x</span></div>', nestedWrapped);

/* The renderers that adopted h() must still escape hostile input AND still
 * render their own structure as real tags. Checking only for a substring
 * like "cap-mark" is not enough — that string survives HTML-escaping intact
 * (escaping only touches & < > " '), so a test built that way passes
 * whether the tag is real markup or escaped text. That gap is exactly how
 * a real bug shipped: three of playerRowHtml_'s four fields were nested
 * h() calls missing their raw() wrapper, so the entire squad list rendered
 * literal "<div class="pos">GKP</div>..." as visible text on the page,
 * and the old test here saw nothing wrong. */
const nasty = '<img src=x onerror=alert(1)>';
const row = sandbox.playerRowHtml_({ name: nasty, position: 'MID', team: nasty, price: 5.0, form: '3.0',
  isCaptain: true, isVice: false, reason: nasty }, { tone: 'out', label: 'Out', n: 1 });
ok('the player row escapes hostile field content', row.indexOf('<img') === -1 && row.indexOf('&lt;img') !== -1);
ok('position renders as a real tag, not escaped text',
   row.indexOf('<div class="pos">MID</div>') !== -1, row);
ok('the meta line renders as a real tag',
   row.indexOf('<div class="meta">') !== -1, row);
ok('the captain badge renders as a real tag',
   row.indexOf('<span class="cap-mark">C</span>') !== -1, row);
ok('the out/start/bench mark renders as a real tag',
   row.indexOf('<span class="row-mark row-mark-out">Out') !== -1, row);
ok('the row never leaks its own generated markup as escaped tag soup — the actual bug',
   row.indexOf('&lt;div') === -1, row);

console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall checks passed');
process.exit(fail ? 1 : 0);
