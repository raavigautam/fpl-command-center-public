// eval/backtest.cjs against a synthetic season written in the exact on-disk
// shape eval/fetch.cjs produces — so the workflow's data path, the replay,
// every metric and the tuning loop are exercised without a network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require(path.join(__dirname, '..', 'eval', 'backtest.cjs'));
const { makeSeason, writeAsEvalData } = require(path.join(__dirname, 'synth_season.cjs'));

let fail = 0;
function ok(n, c, x) { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x !== undefined ? '  ' + x : '')); if (!c) fail++; }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-eval-'));
const season = makeSeason({ seed: 3, finishedGws: 5 });
const dir = writeAsEvalData(season, tmp);

/* ---------- the replay never sees the future ---------- */
const data = B.loadSeason(tmp);
const liveIdx = B.indexLive(data.live);
const played = B.teamGws(data.fixtures);
const asOf = B.asOfBootstrap(data, liveIdx, played, 4).bootstrap;
const someone = asOf.elements.filter(e => e.minutes > 0)[0];
const truePts = [1, 2, 3].reduce((s, gw) => s + (liveIdx[gw][someone.id] ? liveIdx[gw][someone.id].points : 0), 0);
ok('as-of totals use only gameweeks before the target', someone.total_points === truePts, someone.total_points + ' vs ' + truePts);
ok('as-of events mark only earlier gameweeks finished', asOf.events.filter(e => e.finished).length === 3);
ok('unrecoverable fields are blanked, not borrowed from today', asOf.elements.every(e => e.status === 'a' && e.chance_of_playing_next_round === null));
ok('ep_next is set to form, as the live API serves it', asOf.elements.every(e => e.ep_next === e.form));

/* ---------- metrics ---------- */
ok('rank correlation of identical orderings is 1', Math.abs(B.spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-9);
ok('and of reversed orderings is −1', Math.abs(B.spearman([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-9);

/* ---------- a full run, with tuning ---------- */
const out = path.join(tmp, 'reports');
const res = B.run(['node', 'backtest', tmp, '--out', out, '--tune']);
const s = res.summary;
ok('every finished gameweek after the first is scored', JSON.stringify(s.targets) === '[2,3,4,5]', JSON.stringify(s.targets));
ok('each is labelled with how it was replayed', Object.values(s.sources).every(x => x === 'reconstructed'));
ok('the model and the baselines are all scored', ['pred', 'form', 'ppg', 'last3'].every(k => s.predictors[k] && isFinite(s.predictors[k].mae)));
ok('the model ranks players better than points-per-appearance on a season built from true rates',
  s.predictors.pred.spearman > s.predictors.ppg.spearman,
  s.predictors.pred.spearman.toFixed(3) + ' vs ' + s.predictors.ppg.spearman.toFixed(3));
ok('positions each get a bias ratio', [1, 2, 3, 4].every(p => isFinite(s.byPosition[p].ratio)));
ok('calibration buckets cover the projections', s.buckets.reduce((n, b) => n + b.n, 0) === s.n);
ok('the comparison with the best baseline has a confidence interval', s.vsBestBaseline && s.vsBestBaseline.ci && s.vsBestBaseline.ci.lo <= s.vsBestBaseline.ci.hi);
ok('the horizon is scored where results exist', s.horizon.length >= 3 && s.horizon[0].n > s.horizon[s.horizon.length - 1].n);
ok('tuning reports a leave-one-gameweek-out estimate', res.tuning && res.tuning.logo && isFinite(res.tuning.logo.tunedMae));
ok('tuning leaves the model’s constants untouched afterwards', (() => {
  const S = require(path.join(__dirname, 'harness.cjs'));
  return S.XP_PRIOR_MATCHES === res.tuning.current.XP_PRIOR_MATCHES;
})());
ok('the report is written', fs.existsSync(path.join(out, 'latest.md')) && fs.existsSync(path.join(out, 'latest.json')));
ok('and the trend line is appended', fs.readFileSync(path.join(out, 'history.jsonl'), 'utf8').trim().split('\n').length === 1);
ok('the report states its verdict against the baseline', /best simple baseline/.test(res.markdown));

/* ---------- a real pre-deadline snapshot is preferred when there is one ---------- */
const before5 = makeSeason({ seed: 3, finishedGws: 4 });
fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
fs.writeFileSync(path.join(dir, 'snapshots', 'pre-gw5.json'),
  JSON.stringify({ event: 5, elements: before5.raw.bootstrap.elements }));
const res2 = B.run(['node', 'backtest', tmp]);
ok('a gameweek with a snapshot is replayed from it', res2.summary.sources[5] === 'snapshot', JSON.stringify(res2.summary.sources));
ok('and FPL’s own ep_next becomes a baseline for it', res2.summary.predictors.epNext && res2.summary.predictors.epNext.gws === 1);

/* ---------- too little data says so instead of failing ---------- */
const thin = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-eval-thin-'));
writeAsEvalData(makeSeason({ seed: 3, finishedGws: 1 }), thin);
const res3 = B.run(['node', 'backtest', thin]);
ok('one finished gameweek produces an explanation, not a crash', res3.summary === null && /at least two/.test(res3.markdown));

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(thin, { recursive: true, force: true });
console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall checks passed');
process.exit(fail ? 1 : 0);
