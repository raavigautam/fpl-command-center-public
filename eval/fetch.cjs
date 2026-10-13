#!/usr/bin/env node
/*
 * Pulls what the backtest needs from the official FPL API and writes it,
 * slimmed, under eval/data/<season>/. Run by .github/workflows/model-eval.yml;
 * can also be run by hand: `node eval/fetch.cjs [outDir]`.
 *
 *   bootstrap.json            latest players/teams/events (slim)
 *   fixtures.json             every fixture, with both sides' difficulty
 *   live/gw<N>.json           per-player stats for each FINISHED gameweek —
 *                             written once, never refetched (a finished
 *                             gameweek's numbers do not change after bonus).
 *                             The current gameweek is written early, marked
 *                             provisional, once every match has a score —
 *                             see PROVISIONAL_AFTER_HOURS
 *   snapshots/pre-gw<N>.json  player state as it stood before gameweek N's
 *                             deadline: ep_next, status, chance of playing,
 *                             price, form. None of this can be recovered
 *                             afterwards — the API only ever serves "now" —
 *                             so the workflow overwrites it on every run until
 *                             the deadline passes, and the last copy stands.
 *
 * .cjs on purpose: clasp pushes any .js in the repo to Apps Script.
 */
const fs = require('fs');
const path = require('path');

// Overridable only so the fetcher can be exercised against a local mock.
const BASE = process.env.FPL_API_BASE || 'https://fantasy.premierleague.com/api';
const HEADERS = {
  // The API serves browsers; a bare client sometimes gets a 403 from the CDN.
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json'
};

const ELEMENT_FIELDS = ['id', 'web_name', 'element_type', 'team', 'now_cost', 'status',
  'chance_of_playing_next_round', 'ep_next', 'ep_this', 'form', 'points_per_game', 'minutes',
  'total_points', 'selected_by_percent', 'expected_goal_involvements', 'expected_goal_involvements_per_90',
  'starts', 'penalties_order', 'news',
  // Season totals the component model (projectPointsV2_) reads.
  'expected_goals', 'expected_assists', 'expected_goals_conceded', 'saves', 'bonus',
  'defensive_contribution', 'clean_sheets', 'goals_conceded'];
const TEAM_FIELDS = ['id', 'name', 'short_name', 'strength', 'strength_attack_home', 'strength_attack_away',
  'strength_defence_home', 'strength_defence_away'];
const EVENT_FIELDS = ['id', 'name', 'deadline_time', 'finished', 'data_checked', 'is_current', 'is_next',
  'is_previous', 'average_entry_score'];
const FIXTURE_FIELDS = ['id', 'event', 'team_h', 'team_a', 'team_h_difficulty', 'team_a_difficulty',
  'finished', 'kickoff_time', 'team_h_score', 'team_a_score'];
const LIVE_FIELDS = ['minutes', 'total_points', 'starts', 'goals_scored', 'assists', 'clean_sheets',
  'goals_conceded', 'bonus', 'expected_goals', 'expected_assists', 'expected_goal_involvements',
  'expected_goals_conceded', 'saves', 'yellow_cards', 'red_cards', 'defensive_contribution', 'bps'];
// Bumped whenever LIVE_FIELDS grows: older files are re-fetched once so every
// gameweek carries the same fields (format 2 added defensive contributions).
const LIVE_FORMAT = 2;
// Hours after the gameweek's last kickoff before its live stats are trusted
// enough to score provisionally (match, then bonus, then FPL's first pass).
const PROVISIONAL_AFTER_HOURS = 6;

function pick(obj, fields) {
  const out = {};
  fields.forEach(f => { if (obj[f] !== undefined) out[f] = obj[f]; });
  return out;
}

async function getJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 403) {
        throw new Error('403 from ' + url + ' — the FPL API refused this runner. ' +
          'GitHub-hosted runners occasionally land on a blocked IP range; re-run the workflow.');
      }
      if (!res.ok) throw new Error(res.status + ' from ' + url);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

function seasonOf(events) {
  const first = events.map(e => Date.parse(e.deadline_time)).filter(isFinite).sort((a, b) => a - b)[0];
  const year = new Date(first || Date.now()).getUTCFullYear();
  return year + '-' + String((year + 1) % 100).padStart(2, '0');
}

async function main() {
  const root = process.argv[2] || path.join(__dirname, 'data');
  const boot = await getJson(BASE + '/bootstrap-static/');
  const season = seasonOf(boot.events);
  const dir = path.join(root, season);

  const slim = {
    fetchedAt: new Date().toISOString(),
    elements: boot.elements.map(e => pick(e, ELEMENT_FIELDS)),
    teams: boot.teams.map(t => pick(t, TEAM_FIELDS)),
    events: boot.events.map(e => pick(e, EVENT_FIELDS))
  };
  writeJson(path.join(dir, 'bootstrap.json'), slim);

  const fixtures = await getJson(BASE + '/fixtures/');
  writeJson(path.join(dir, 'fixtures.json'), fixtures.map(f => pick(f, FIXTURE_FIELDS)));

  // The pre-deadline snapshot for the next gameweek still open.
  const now = Date.now();
  const open = boot.events
    .filter(e => Date.parse(e.deadline_time) > now)
    .sort((a, b) => a.id - b.id)[0];
  if (open) {
    writeJson(path.join(dir, 'snapshots', 'pre-gw' + open.id + '.json'), {
      event: open.id, deadline: open.deadline_time, takenAt: slim.fetchedAt,
      elements: slim.elements
    });
  }

  // Live stats for every finished gameweek not already on disk.
  const finished = boot.events.filter(e => e.finished && e.data_checked !== false).map(e => e.id);
  let fetched = 0;
  for (const id of finished) {
    const file = path.join(dir, 'live', 'gw' + id + '.json');
    if (fs.existsSync(file)) {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if ((existing.format || 1) >= LIVE_FORMAT && !existing.provisional) continue;
    }
    const live = await getJson(BASE + '/event/' + id + '/live/');
    writeJson(file, {
      event: id, format: LIVE_FORMAT,
      elements: live.elements.map(e => ({ id: e.id, stats: pick(e.stats || {}, LIVE_FIELDS) }))
    });
    fetched++;
  }

  // FPL can sit on `finished` for days after the last whistle (GW6 2026-27:
  // every score in by Monday night, nothing marked finished on Tuesday). Once
  // every fixture of the current gameweek has a score and the last kickoff is
  // PROVISIONAL_AFTER_HOURS old, score it as provisional: the file is
  // refetched on every run and replaced by the final numbers when FPL marks
  // the gameweek finished. Bonus and late corrections can still move a point.
  let provisional = null;
  const cur = boot.events.find(e => e.is_current && !(e.finished && e.data_checked !== false));
  if (cur) {
    const fx = fixtures.filter(f => f.event === cur.id);
    const lastKick = Math.max(...fx.map(f => Date.parse(f.kickoff_time) || Infinity));
    const allScored = fx.length > 0 && fx.every(f => f.team_h_score != null && f.team_a_score != null);
    if (allScored && now - lastKick > PROVISIONAL_AFTER_HOURS * 3600e3) {
      const live = await getJson(BASE + '/event/' + cur.id + '/live/');
      writeJson(path.join(dir, 'live', 'gw' + cur.id + '.json'), {
        event: cur.id, format: LIVE_FORMAT, provisional: true, fetchedAt: slim.fetchedAt,
        elements: live.elements.map(e => ({ id: e.id, stats: pick(e.stats || {}, LIVE_FIELDS) }))
      });
      provisional = cur.id;
    }
  }

  console.log('season ' + season + ': ' + slim.elements.length + ' players, ' + fixtures.length +
    ' fixtures, ' + finished.length + ' finished gameweeks (' + fetched + ' newly fetched)' +
    (open ? ', snapshot for GW' + open.id : '') +
    (provisional ? ', GW' + provisional + ' scored provisionally' : ''));
}

main().catch(err => { console.error(String(err && err.stack || err)); process.exit(1); });
