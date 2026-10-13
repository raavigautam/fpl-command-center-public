/**
 * FPL Command Center — Google Apps Script backend
 * ------------------------------------------------
 * Free, self-hosted FPL dashboard. Runs entirely on Google's servers
 * (your Google account), fetches live data straight from the official
 * Fantasy Premier League API on every request, and can email you
 * recommendations automatically before each gameweek deadline.
 *
 * SETUP (one time):
 *   1. Run `saveTeamId` once from the editor (Run > saveTeamId), OR just
 *      open the deployed web app and enter your Team ID in the setup box.
 *   2. Run `installWeeklyTrigger` once from the editor (Run menu) to turn
 *      on the automatic deadline-reminder emails and the weekly AI
 *      verdict refresh. Approve permissions when prompted (this is normal
 *      for any script you deploy yourself).
 *   3. Optional: enter an Anthropic API key in the app's AI Assistant box
 *      to turn on the chat assistant and the AI-written weekly verdict.
 *      Without a key, the verdict falls back to a rule-based summary —
 *      the app never breaks, it just gets terser.
 *   4. Optional: enter a YouTube Data API key and a Gemini API key in "The
 *      Panel" section (both free) to turn on expert-channel takes — see
 *      THE PANEL section below. Run installPanelTrigger() once to start
 *      checking the tracked channels for new videos every 6 hours.
 */

var BASE = 'https://fantasy.premierleague.com/api';
/* Two models, because the two jobs are not alike.
 *
 * The assistant reasons over a squad, decides which of five tools to call,
 * reads a match log back and weighs one player against another — and it is
 * the surface a manager judges the whole product by. The copy jobs (the
 * Ruling's prose, the Panel synthesis) restate figures this app has already
 * computed into a sentence, which is exactly what a small fast model is for.
 * Running both on one model meant either overpaying for the copy or
 * underpowering the assistant.
 *
 * Both bill to the manager's own key. The copy calls are cached per gameweek
 * and per video, so the recurring cost of a page load is unchanged; only
 * asking a question costs anything, and the squad state is cached between
 * questions in a session. */
var AI_MODEL_CHAT = 'claude-opus-5';
var AI_MODEL_COPY = 'claude-haiku-4-5';
var LOOKAHEAD_GWS = 6;
// Stamped by the deploy workflow (sed, right before `clasp push`) with the
// merged PR number and UTC deploy date (falls back to the short commit SHA
// for a push to main that isn't a PR merge), so the masthead can show which
// version of the code is actually live. Stays literally 'dev' for any
// local/manual push.
var APP_VERSION = 'dev';

// "The Panel" — tracked YouTube channels (see THE PANEL section near the bottom
// of this file). A short, hand-picked list by design, not auto-discovered —
// `id` just needs to be a stable slug used as a PropertiesService key prefix.
// The uploads playlist for each is resolved automatically (from `handle`)
// and cached on first use.
var PANEL_CHANNELS = [
  { id: 'fpl_focal', handle: '@fplfocal', name: 'FPL Focal' },
  { id: 'lets_talk_fpl', handle: '@letstalkfpl', name: "Let's Talk FPL" }
];

/* ===================== CONFIG ===================== */

function getTeamId() {
  return PropertiesService.getScriptProperties().getProperty('TEAM_ID') || '';
}

function saveTeamId(teamId) {
  teamId = String(teamId).trim();
  if (!/^\d+$/.test(teamId)) {
    throw new Error('Team ID must be a number. Find yours in the URL when viewing "Points" on fantasy.premierleague.com — the number after /entry/.');
  }
  PropertiesService.getScriptProperties().setProperty('TEAM_ID', teamId);
  return { ok: true, teamId: teamId };
}

function getRiskAppetite_() {
  return PropertiesService.getScriptProperties().getProperty('RISK_APPETITE') || 'balanced';
}

function saveRiskAppetite(value) {
  value = String(value).toLowerCase();
  if (['safe', 'balanced', 'aggressive'].indexOf(value) === -1) {
    throw new Error('Risk appetite must be safe, balanced, or aggressive.');
  }
  PropertiesService.getScriptProperties().setProperty('RISK_APPETITE', value);
  return { ok: true, riskAppetite: value };
}

/* ===================== WEB APP ENTRY POINTS ===================== */

function doGet(e) {
  var page = e && e.parameter && e.parameter.page;
  var isRatings = page === 'ratings';
  var isWire = page === 'wire';
  var isDebug = page === 'debug';
  var templateName = isRatings ? 'Ratings' : (isWire ? 'Wire' : (isDebug ? 'Debug' : 'Index'));
  var title = isRatings ? 'Player Ratings — FPL Command Center' : (isWire ? 'The Wire — FPL Command Center' : (isDebug ? 'Debug — FPL Command Center' : 'FPL Command Center'));
  try {
    var t = HtmlService.createTemplateFromFile(templateName);
    // Cross-page links must be absolute: this app is often viewed via the inner
    // script.googleusercontent.com content frame rather than the script.google.com/.../exec
    // wrapper, where a relative "?page=ratings" resolves against the content frame's own
    // origin (a static per-render endpoint that never re-invokes doGet) instead of the
    // dispatcher — producing a blank page with no error. getUrl() is always the real one.
    t.appUrl = ScriptApp.getService().getUrl();
    t.appVersion = APP_VERSION;
    // Player names handed over by the dashboard's /compare command. Escaped
    // for a JS string literal, not HTML: it is interpolated inside quotes in
    // Ratings.html, where an unescaped apostrophe or backslash would break
    // the script rather than merely render oddly. Length-capped because the
    // only legitimate payload is a handful of short names.
    t.compareParam = String((e && e.parameter && e.parameter.compare) || '')
      .slice(0, 120)
      .replace(/[\\'"<>\r\n]/g, '');
    return t.evaluate()
      .setTitle(title)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
      .setFaviconUrl('https://fantasy.premierleague.com/favicon.ico');
  } catch (err) {
    // Template evaluation errors otherwise render as a near-blank page with
    // no indication of what broke. Surface the real message instead.
    return HtmlService.createHtmlOutput(
      '<pre style="white-space:pre-wrap;font-family:monospace;padding:20px">' +
      'Error rendering page (' + templateName + '): ' +
      String(err && err.message || err) +
      '</pre>'
    );
  }
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Single entry point the client HTML calls (via google.script.run) to
 * load everything needed to render the dashboard.
 */
function getDashboardData() {
  // Thin wrapper so the buffered stage log is written exactly once, from a
  // `finally` — including on the paths that return early, and including when
  // something throws, which is precisely when the trace matters most.
  try {
    return getDashboardDataInner_();
  } finally {
    flushDebugLog_();
  }
}

function getDashboardDataInner_() {
  var teamId = getTeamId();
  if (!teamId) {
    return { needsSetup: true };
  }

  var requestId = Utilities.getUuid();
  var t0 = Date.now();

  var bootstrap = timedRequired_(requestId, t0, 'bootstrap', function () { return getBootstrap_(); });
  // Set before any scoring runs — several terms (minutes share, rotation
  // risk) are meaningless without knowing how far into the season we are.
  SEASON_CONTEXT_ = timedRequired_(requestId, t0, 'seasonContext', function () { return loadSeasonContext_(bootstrap); });
  // Read by pricedPositionPrior_ — the early-season fallback prior needs to
  // know what a player's price says about him relative to his position.
  PRICE_NORM_ = timedRequired_(requestId, t0, 'priceNorms', function () { return loadPriceNorms_(bootstrap); });
  CALIBRATION_ = null; // re-read once per request; a new grade may have landed
  COMMUNITY_SIGNAL_ = timedOptional_(requestId, t0, 'communitySignal', function () { return loadCommunitySignal_(bootstrap); }, { mentions: {}, panel: {} });
  var fixtures = timedRequired_(requestId, t0, 'fixtures', function () { return getFixtures_(); });
  var entry = timedOptional_(requestId, t0, 'entry', function () { return getEntry_(teamId); }, null,
    function (r) { return r && r.leagues && r.leagues.classic ? r.leagues.classic.length + ' leagues' : ''; });
  var history = timedOptional_(requestId, t0, 'history', function () { return getHistory_(teamId); }, null,
    function (r) { return r && r.current ? r.current.length + ' GWs, ' + ((r.chips || []).length) + ' chips' : ''; });

  var events = bootstrap.events;
  var gwState = resolveGameweekState_(events);
  var eventById = {};
  events.forEach(function (ev) { eventById[ev.id] = ev; });
  // The gameweek being PLAYED, and the gameweek being PICKED FOR. These are
  // different gameweeks for most of any given week and the app used to hold
  // only one variable for both. See resolveGameweekState_.
  var liveEvent = gwState.liveEventId != null ? eventById[gwState.liveEventId] : null;
  var decisionEvent = gwState.decisionEventId != null ? eventById[gwState.decisionEventId] : null;
  var picksEvent = gwState.picksEventId != null ? eventById[gwState.picksEventId] : null;

  // The FPL API only exposes a manager's squad picks (/entry/{id}/event/{id}/picks/)
  // AFTER that gameweek's deadline has passed — it 404s for an upcoming, unlocked
  // gameweek. So before GW1's deadline there is NO public API call that can read
  // your saved squad, however early you picked it. `preseason` records that
  // specifically, so the UI can explain the gap instead of just looking broken.
  var preseason = !gwState.seasonStarted;

  var picks = null;
  if (picksEvent) {
    picks = timedOptional_(requestId, t0, 'picks', function () { return getPicks_(teamId, picksEvent.id); });
  }

  var fixtureEase = timedRequired_(requestId, t0, 'fixtureEase', function () { return buildFixtureEaseMap_(bootstrap, fixtures, LOOKAHEAD_GWS); });
  // Recent results — who has been starting, and how clubs have been doing.
  // Optional: without them the page loses the rotation flags, nothing else.
  RECENT_FIXTURES_ = fixtures;
  // Club attack/defence rates for the component model; harmless under v1.
  TEAM_RATES_ = timedOptional_(requestId, t0, 'teamRates', function () { return loadTeamRates_(bootstrap, fixtures); }, null);
  RECENT_LIVE_ = timedOptional_(requestId, t0, 'recentLive', function () { return loadRecentLive_(bootstrap, RECENT_FORM_GWS); }, null,
    function (r) { return r ? Object.keys(r).length + ' GWs' : ''; });
  FIXTURE_EASE_MEMO_ = fixtureEase;
  HISTORY_MEMO_ = history;
  var chipsUsed = (history && history.chips) ? history.chips : [];
  var riskAppetite = getRiskAppetite_();
  var freeTransfers = timedOptional_(requestId, t0, 'freeTransfers', function () { return estimateFreeTransfers_(history); }, 1);

  /* Transfers the manager has told the app about (see saveDeclaredTransfers).
   * Last week's declaration is checked against the squad FPL locked and
   * retired; this week's is applied to the locked picks, so the squad, the
   * eleven, the captain and every remaining suggestion are for the team the
   * manager actually holds. `basePicks` stays the locked squad — it is what
   * the declaration form builds on. */
  var basePicks = picks;
  var squadEntry = entry;
  var adviceFreeTransfers = freeTransfers;
  var declaredSummary = null, declaredError = null, declaredCheck = null;
  if (picks && picks.picks && picksEvent) {
    declaredCheck = safeCall_(function () { return reconcileDeclared_(picksEvent.id, picks, bootstrap); });
  }
  if (picks && picks.picks && gwState.decisionEventId != null) {
    var declared = safeCall_(function () { return readDeclared_(gwState.decisionEventId); });
    if (declared && (declared.moves || []).length) {
      var applied = timedOptional_(requestId, t0, 'declaredTransfers', function () {
        return applyDeclaredTransfers_(bootstrap, picks, entry, declared, freeTransfers);
      });
      if (applied && applied.ok) {
        picks = applied.picks;
        squadEntry = applied.entry;
        adviceFreeTransfers = applied.freeTransfersLeft;
        declaredSummary = applied.summary;
      } else {
        declaredError = applied && applied.errors ? applied.errors.join(' ') : 'The saved transfers could not be applied.';
      }
    }
  }

  // Scoring signal availability: `form`/`ep_next` are rolling stats for the
  // CURRENT season and read 0.0 for the entire player pool before the first
  // ball of the season is kicked (and again for a game or two right after,
  // until results accumulate). `total_points`/`points_per_game`/`ict_index`
  // still hold last season's numbers during that same window — bootstrap-static
  // doesn't wipe them until GW1 actually kicks off. playerScore_ already leans
  // on those fields, so during preseason it's effectively last-season-weighted
  // automatically; this flag exists so the UI can say so explicitly rather than
  // quietly showing "current form" copy for numbers that are actually last season's.
  var dataBasis = preseason ? 'last-season' : 'current-season';

  var availableLeagues = (entry && entry.leagues && entry.leagues.classic)
    ? entry.leagues.classic.map(function (l) { return { id: l.id, name: l.name }; })
    : [];
  var selectedLeagueId = getSelectedLeagueId_(availableLeagues);

  var result = {
    needsSetup: false,
    teamId: teamId,
    entryName: entry ? entry.name : null,
    managerName: entry ? (entry.player_first_name + ' ' + entry.player_last_name) : null,
    overallRank: entry ? entry.summary_overall_rank : null,
    // The gameweek being PLAYED. Null between gameweeks — which is a real
    // state, distinct from "GW1 is in progress", and the UI reads differently
    // in each.
    currentEventId: gwState.liveEventId,
    // The masthead used to show "GW 1" beside a deadline that belonged to
    // GW2, because one is the gameweek being PLAYED and the other is the
    // gameweek being PICKED FOR — and nothing on the page said so. Both are
    // named now, and every figure can be attributed to one or the other.
    pickingForEventId: gwState.decisionEventId,
    // The deadline that belongs to pickingForEventId, not to whatever the API
    // currently flags as is_next — the two disagree for the hours between a
    // deadline passing and FPL's scheduler catching up.
    deadline: gwState.decisionDeadline,
    gameweekState: {
      liveEventId: gwState.liveEventId,
      liveInPlay: gwState.liveInPlay,
      decisionEventId: gwState.decisionEventId,
      decisionDeadline: gwState.decisionDeadline,
      picksEventId: gwState.picksEventId,
      seasonOver: gwState.seasonOver
    },
    seasonStarted: gwState.seasonStarted,
    preseason: preseason,
    dataBasis: dataBasis,
    chipsUsed: chipsUsed,
    riskAppetite: riskAppetite,
    hasAiKey: hasAiKey_(),
    freeTransfers: freeTransfers,
    finishedGws: SEASON_CONTEXT_ ? SEASON_CONTEXT_.finishedGws : 0,
    startedGws: SEASON_CONTEXT_ ? SEASON_CONTEXT_.startedGws : 0,
    avgEntryScore: SEASON_CONTEXT_ ? SEASON_CONTEXT_.avgEntryScore : null,
    dataSource: 'Live',
    availableLeagues: availableLeagues,
    selectedLeagueId: selectedLeagueId
  };
  if (declaredSummary || declaredError || declaredCheck) {
    result.declared = declaredSummary;
    result.declaredError = declaredError;
    result.declaredCheck = declaredCheck;
    // Under a declared Wildcard or Free Hit the engine treats every move as
    // free; the page still shows the manager's real banked count.
    result.freeTransfers = declaredSummary && declaredSummary.chip ? freeTransfers : adviceFreeTransfers;
  }

  // Mini-league standings only need `entry` (for the league list) and the
  // league standings endpoint — neither depends on squad picks — so this used
  // to be nested inside the picks-only branch below and silently never
  // rendered during preseason (or for anyone whose picks call failed for any
  // other reason) even though the data was available. It's independent now.
  if (selectedLeagueId) {
    result.miniLeague = timedOptional_(requestId, t0, 'miniLeague', function () { return buildMiniLeague_(selectedLeagueId, teamId); });
  }

  if (picks && picks.picks) {
    var squad = timedRequired_(requestId, t0, 'buildSquad', function () { return buildSquad_(bootstrap, picks, squadEntry, fixtureEase); });
    result.squad = squad;
    // What the "transfers I've made" form builds on: the squad FPL locked,
    // before any declaration, plus a compact index of every player to buy.
    result.transferBase = (basePicks.picks || []).map(function (bp) {
      var el = null;
      for (var bi = 0; bi < bootstrap.elements.length; bi++) if (bootstrap.elements[bi].id === bp.element) { el = bootstrap.elements[bi]; break; }
      return el ? { id: el.id, name: el.web_name, position: POSITION_MAP[el.element_type], elementType: el.element_type } : null;
    }).filter(Boolean);
    result.playerIndex = buildPlayerIndex_(bootstrap);
    result.fixtureTeams = {};
    Object.keys(fixtureEase).forEach(function (tid) { result.fixtureTeams[tid] = true; });
    // Effective ownership runs early now: it is no longer only a rank-risk
    // display, it is the captaincy model's read on what the field is doing,
    // and the armband cannot be chosen against a field that has not been
    // computed yet.
    // Deliberately the LOCKED gameweek, not the decision one: rivals' picks
    // are not public until a deadline passes, so this is necessarily a read
    // of the last field we can see. buildLeagueEo_ says so in its own basis
    // string.
    if (result.miniLeague && picksEvent) {
      result.leagueEo = timedOptional_(requestId, t0, 'leagueEo', function () {
        return buildLeagueEo_(bootstrap, fixtureEase, squad, result.miniLeague, teamId, picksEvent.id);
      }, null, function (r) { return r && r.managersCounted ? r.managersCounted + ' rivals' : 'none'; });
    }
    // This season's clubs, for checking AI copy against (rulingNamesWrongClub_).
    result.clubs = (bootstrap.teams || []).map(function (t) { return { name: t.name, short: t.short_name }; });
    var transferExtras = {};
    result.transferSuggestions = timedRequired_(requestId, t0, 'suggestTransfers', function () { return suggestTransfers_(bootstrap, fixtureEase, squad, riskAppetite, adviceFreeTransfers, transferExtras); });
    // Moves worth making, but not worth a hit THIS week — planned for the
    // next free transfer instead. Not counted in the ledger: nothing is spent.
    result.deferredTransfers = transferExtras.deferred || [];
    // Counted once, read everywhere — see buildTransferLedger_.
    result.transferLedger = timedRequired_(requestId, t0, 'transferLedger', function () { return buildTransferLedger_(result.transferSuggestions, adviceFreeTransfers); });
    result.transferPlan = timedRequired_(requestId, t0, 'transferPlan', function () { return buildTransferPlan_(result.transferSuggestions, adviceFreeTransfers, squad, result.transferLedger); });
    result.captainSuggestions = timedRequired_(requestId, t0, 'suggestCaptain', function () {
      return suggestCaptain_(squad, fixtureEase, riskAppetite, result.leagueEo, gwState.decisionEventId);
    });
    result.lineup = timedOptional_(requestId, t0, 'optimiseLineup', function () { return optimiseLineup_(squad); });
    result.roadmap = timedOptional_(requestId, t0, 'transferRoadmap', function () { return buildTransferRoadmap_(bootstrap, fixtureEase, squad, adviceFreeTransfers, riskAppetite, result.transferSuggestions, result.captainSuggestions); });
    result.ownershipEdge = timedOptional_(requestId, t0, 'ownershipEdge', function () { return buildOwnershipEdge_(bootstrap, fixtureEase, squad); });
    // Priced once, then read by both the prose notes and the board — so a
    // sentence and the figure beside it can never disagree. Runs after the
    // captain suggestions because the Triple Captain value is a third helping
    // of whoever the armband model actually chose.
    result.chipValues = timedOptional_(requestId, t0, 'chipValues', function () {
      var cv = buildChipValues_(bootstrap, fixtureEase, squad, result.captainSuggestions);
      // A Wildcard is the alternative to the transfer plan, so it is priced
      // against it — see rebaseWildcardOnPlan_.
      if (cv) rebaseWildcardOnPlan_(cv, result.roadmap);
      return cv;
    });
    result.chipSuggestions = timedRequired_(requestId, t0, 'suggestChips', function () { return suggestChips_(bootstrap, fixtures, fixtureEase, squad, chipsUsed, events, result.chipValues); });
    // Both take the DECISION gameweek. Passing the live one meant a chip
    // whose best week was the one you are picking for could never say "play
    // now" — its bestEvent came from the decision-gameweek-first horizon and
    // was compared against the id of a gameweek already locked, so the two
    // never matched and every chip read "target GW<n>" for the week it should
    // have been telling you to play it.
    result.chipBoard = timedRequired_(requestId, t0, 'chipBoard', function () { return buildChipBoard_(chipsUsed, fixtureEase, squad, events, decisionEvent, result.chipValues); });
    result.chipDecision = safeCall_(function () { return buildChipDecision_(result.chipBoard); });
    if (declaredSummary && declaredSummary.chip) {
      result.chipDecision = { play: declaredSummary.chip, declared: true,
        reason: 'You have told the app you are playing your ' + declaredSummary.chip + ' this gameweek.' };
    }
    if (result.chipDecision && result.chipSuggestions) result.chipSuggestions.unshift('Decision: ' + result.chipDecision.reason);
    result.fixtureGrid = timedRequired_(requestId, t0, 'fixtureGrid', function () { return buildFixtureGrid_(fixtureEase, squad, events, decisionEvent); });
    // Needs the transfer suggestions: a recommended buy about to rise is the
    // only price row with a deadline attached, so it has to run after them.
    result.priceWatch = timedRequired_(requestId, t0, 'priceWatch', function () { return buildPriceWatch_(squad, bootstrap, result.transferSuggestions); });
    result.riskWatch = timedRequired_(requestId, t0, 'riskWatch', function () { return buildRiskWatch_(squad); });
    // Built before the ruling and the articles, both of which lead with it
    // when a gameweek is actually in flight.
    result.liveGameweek = timedOptional_(requestId, t0, 'liveGameweek', function () { return buildLiveGameweek_(bootstrap, fixtures, squad, liveEvent); });
    // The one call on this path that can hit an external AI API (getRuling_ ->
    // generateAiRuling_ -> callClaude_, which retries with backoff on an
    // overloaded Anthropic API) — logged separately from every other stage
    // above so a slow/hung call here shows up as a distinctly long 'ruling'
    // row (or a missing one) rather than looking like everything stalled.
    /* Checked BEFORE the verdict is written, because the verdict is the part
     * that sounds certain. An impossible number with a decisive sentence on
     * top of it is worse than the number alone. */
    result.invariants = timedRequired_(requestId, t0, 'invariants', function () { return checkModelInvariants_(result); });

    // `false`: never generate prose here. A cache miss serves the rule-based
    // verdict and leaves the AI copy to the trigger — see getRuling_.
    result.ruling = (result.invariants && !result.invariants.ok)
      ? buildInvalidModelRuling_(result.invariants)
      : (timedOptional_(requestId, t0, 'ruling', function () { return getRuling_(gwState.decisionEventId != null ? gwState.decisionEventId : 'pre', result, false); })
        || buildRuleBasedRuling_(result, hasAiKey_() ? 'failed' : 'nokey'));
    // True when a verdict is being served rule-based while the AI prose for
    // it is queued for the next trigger tick — the page says so rather than
    // leaving the terser copy looking like a downgrade with no explanation.
    result.rulingPending = !!(result.ruling && result.ruling.source === 'rules' && hasAiKey_() &&
      (!result.invariants || result.invariants.ok));
    /* Two records, two gameweeks, two moments — see snapshotDecision_.
     * The advice is filed against the gameweek it is advice FOR (the one
     * still open); the team sheet is filed against the gameweek it was
     * actually fielded in (the one already locked). */
    if (gwState.decisionEventId != null) {
      timedOptional_(requestId, t0, 'snapshotDecision', function () {
        return snapshotDecision_(gwState.decisionEventId, squad, result.transferSuggestions, result.captainSuggestions, result.lineup, {
          // Only evaluated when a snapshot is actually written.
          poolFn: function () { return poolProjectionsCompact_(bootstrap, fixtureEase); },
          declaredSig: declaredSummary ? declaredSummary.signature : ''
        });
      });
    }
    if (picksEvent) {
      timedOptional_(requestId, t0, 'recordActualLineup', function () {
        return recordActualLineup_(picksEvent.id, squad);
      });
    }
    result.lastGrade = timedOptional_(requestId, t0, 'gradeFinishedGws', function () { return gradeFinishedGws_(bootstrap); });
    // After grading, so a gameweek graded on this very load is included.
    CALIBRATION_ = null;
    result.calibration = timedOptional_(requestId, t0, 'calibration', function () { return loadCalibration_() || null; });
    result.trackRecord = timedOptional_(requestId, t0, 'trackRecord', function () { return buildTrackRecord_(); });
    result.lastGameweek = timedOptional_(requestId, t0, 'lastGameweekReview', function () { return buildLastGameweekReview_(bootstrap, teamId, history); });
    // Last, because it reads from everything above it.
    result.actionList = timedOptional_(requestId, t0, 'actionList', function () { return buildActionList_(result); });
    result.articles = timedOptional_(requestId, t0, 'articles', function () { return buildArticles_(result); }, []);
  } else {
    // No squad readable — suggest a full initial XV instead. During preseason
    // this is EXPECTED (see the `preseason` comment above), not a failure, so
    // say that plainly rather than looking like a broken "no data" state.
    result.noSquadYet = true;
    result.suggestedSquad = timedRequired_(requestId, t0, 'suggestInitialSquad', function () { return suggestInitialSquad_(bootstrap, fixtureEase); });
    result.suggestedSquadBasis = dataBasis;
    if (preseason) {
      result.ruling = {
        headline: (gwState.decisionDeadline ? 'GW' + gwState.decisionEventId + ' kicks off ' + formatDeadline_(gwState.decisionDeadline) + '.' : 'Season not live yet.') + ' Your squad isn’t readable yet.',
        body: 'The FPL API only exposes a manager’s picks after that gameweek’s deadline passes — even if you’ve already saved a squad, there’s no public way to read it before then. Below is a suggested opening XV built from last season’s numbers (form and projected points reset to zero for everyone until GW1 kicks off). Once the deadline passes, this becomes your real dashboard automatically. Note: preseason friendlies aren’t tracked by the official FPL API at all, so they can’t factor in here — last season’s results are the closest available signal.',
        source: 'rules'
      };
    } else {
      result.ruling = {
        headline: 'Couldn’t read a saved squad for this team.',
        body: 'The season is live but this Team ID doesn’t have a readable squad for the current gameweek — double check the Team ID above. Meanwhile, here’s a suggested opening XV.',
        source: 'rules'
      };
    }
  }

  // requestId on the response itself lets a SUCCESSFUL load be matched to its
  // exact log row on the Debug page — separate question from the null-data
  // issue (a null response obviously can't carry this), but confirms
  // correlation works cleanly for every load that DOES arrive intact.
  result.requestId = requestId;
  result.appVersion = APP_VERSION;

  // Payload size AND the deployed version logged on every real production
  // load, not just estimated from synthetic test data. APP_VERSION here
  // specifically settles "did this exact request run against the build we
  // think is live" without inference from deploy timestamps — every log row
  // is now traceable to an exact commit/PR, so if a bad request ever
  // correlates with one specific version, that's directly visible instead
  // of argued from a theory.
  // `entries` exists only so buildLeagueEo_ can address each rival; it is
  // dead weight on the wire once that has run.
  if (result.miniLeague) delete result.miniLeague.entries;
  // Server-side lookup only — the array beside it carries the same rows.
  if (result.leagueEo) delete result.leagueEo.captainSharesById;
  // Consumed by suggestChips_ and buildChipBoard_ on the way out; the board
  // carries every figure the page renders, so this is dead weight on the wire.
  delete result.chipValues;

  var payloadSize = safeCall_(function () { return JSON.stringify(result).length; });
  logDebugStage_(requestId, t0, 'TOTAL', t0, 'ok',
    APP_VERSION + (payloadSize != null ? (', ' + payloadSize + ' bytes') : ''));
  return result;
}

/**
 * Client entry point for the main dashboard, in place of calling
 * getDashboardData() directly over google.script.run. Debug page evidence
 * (2026-08-22/23): multiple separate getDashboardData() executions logged
 * TOTAL: ok with a correctly-sized payload in the exact window the client
 * reported a null response after retries — while a trivial pingTest() on
 * the same page load always got through. The server isn't failing;
 * google.script.run's automatic object marshalling is dropping this
 * specific (larger, nested) response in transit. Returning it pre-
 * serialized as a JSON string bypasses that marshalling — a string
 * crosses the bridge as a primitive, not an object tree — and the client
 * does one JSON.parse() on arrival instead.
 */
function getDashboardDataJson(forceFresh) {
  // The masthead Refresh button passes true, so "refresh" means what a user
  // expects it to mean — go and ask the FPL API again — rather than
  // re-rendering whatever the 15-minute cache is still holding.
  if (forceFresh) safeCall_(function () { return clearDataCache(); });
  return JSON.stringify(getDashboardData());
}

function safeCall_(fn) {
  try { return fn(); } catch (err) { return null; }
}

/**
 * Runs fn while holding the script lock, for the handful of places that do a
 * read-modify-write on a single PropertiesService value. Two executions
 * overlapping there (two browser tabs, a page load racing a timer tick) both
 * read the same starting value and the second write silently discards the
 * first — which is how the recommendations log ends up with duplicate rows
 * despite having a dedupe list, and how debug rows vanish from the ring
 * buffer mid-diagnosis.
 *
 * Returns whatever fn returns; if the lock cannot be had inside timeoutMs it
 * runs fn anyway rather than dropping the work, because every caller here
 * would rather risk a lost update than skip the operation entirely.
 */
function withLock_(timeoutMs, fn) {
  var lock = null;
  try {
    lock = LockService.getScriptLock();
    lock.waitLock(timeoutMs);
  } catch (e) {
    lock = null; // contended or unavailable — proceed unlocked
  }
  try {
    return fn();
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e) { /* already released */ } }
  }
}

/* ===================== DEBUG LOG (PropertiesService-backed stage timing) =====================
 *
 * Built specifically because the main dashboard was reported stuck on
 * "Loading" with no error shown, and safeCall_ alone can't diagnose that —
 * it only catches THROWN exceptions, it can't see a stage that's just slow
 * or genuinely hung. This logs every stage of getDashboardData as it
 * completes (or errors), so if a later stage hangs or the whole request
 * eventually times out, every row up to that point is already saved. The
 * stage whose row never appears is the one that hung.
 *
 * A first version of this used a Google Sheet (like the existing
 * Recommendations Log), but that needs SpreadsheetApp.create — a scope this
 * deployment's OAuth grant didn't have, discovered via this very tool going
 * silent instead of showing a debug log. That scope requirement was never
 * actually necessary for what this needed to do (a bounded ring buffer of
 * recent stage timings, not durable unbounded history), so it's
 * PropertiesService instead — the same store every other cache/setting in
 * this file already uses, no OAuth prompt required at all.
 */

var DEBUG_LOG_PROP = 'DEBUG_LOG_ROWS';
// PropertiesService caps a single property at 9KB. Verified worst-case (every
// row an error, every detail hitting its truncation length) stays under
// ~6.8KB at these limits — comfortable margin, not just the typical-case size.
var DEBUG_LOG_MAX_ROWS = 30;
var DEBUG_LOG_DETAIL_MAX_CHARS = 100;
var DEBUG_LOGGING_ENABLED_PROP = 'DEBUG_LOGGING_ENABLED';

// Cached per script execution (not re-read per stage) — this logging adds a
// real PropertiesService read+write on every one of ~20 stages per
// dashboard load, overhead that didn't exist before this debugging effort.
// A toggle to disable it lets that overhead itself be tested as a
// contributing factor to the null-data issue, not just assumed away.
var DEBUG_LOGGING_ENABLED_CACHE_ = null;

function isDebugLoggingEnabled_() {
  if (DEBUG_LOGGING_ENABLED_CACHE_ === null) {
    var v = safeCall_(function () { return PropertiesService.getScriptProperties().getProperty(DEBUG_LOGGING_ENABLED_PROP); });
    DEBUG_LOGGING_ENABLED_CACHE_ = (v !== 'false'); // default ON
  }
  return DEBUG_LOGGING_ENABLED_CACHE_;
}

/** Debug page toggle — flips the flag isDebugLoggingEnabled_ reads, so a fresh script execution picks up the new value on its next call. */
function setDebugLoggingEnabled(enabled) {
  PropertiesService.getScriptProperties().setProperty(DEBUG_LOGGING_ENABLED_PROP, enabled ? 'true' : 'false');
  return { ok: true, enabled: !!enabled };
}

/*
 * Rows are buffered in memory and written ONCE per request, not once per
 * stage.
 *
 * The per-stage write was costing more than everything it was measuring.
 * Debug-page evidence from a real production load: 25 stages, 1,514ms of
 * actual work, 11,670ms wall clock — a flat ~390ms gap before every single
 * stage, which is a PropertiesService read plus write (plus, latterly, a
 * lock acquisition) paid 26 times. 87% of that request was the logger. The
 * tool built to explain why the dashboard was slow had become the reason it
 * was slow, and worse, it inflated every timing it reported.
 *
 * Buffering keeps every row and the same timings, at one write per request.
 */
var DEBUG_LOG_BUFFER_ = null;

/** Buffers one row. Wrapped in its own try/catch — a logging hiccup must never break the dashboard it's trying to help debug. */
function logDebugStage_(requestId, t0, stage, stageStart, status, detail) {
  if (!isDebugLoggingEnabled_()) return;
  try {
    var now = Date.now();
    if (!DEBUG_LOG_BUFFER_) DEBUG_LOG_BUFFER_ = [];
    DEBUG_LOG_BUFFER_.push([
      new Date().toISOString(), requestId.slice(0, 8), stage,
      now - stageStart, now - t0, status,
      (detail || '').slice(0, DEBUG_LOG_DETAIL_MAX_CHARS)
    ]);
  } catch (e) { /* never let logging break the thing it's debugging */ }
}

/**
 * Writes the buffered rows into the ring buffer. Called once, at the end of
 * a request, from a `finally` — so a request that throws still leaves its
 * partial trace behind, which is the entire point of stage logging.
 */
function flushDebugLog_() {
  var buffered = DEBUG_LOG_BUFFER_;
  DEBUG_LOG_BUFFER_ = null;
  if (!buffered || !buffered.length) return;
  try {
    withLock_(3000, function () {
      var props = PropertiesService.getScriptProperties();
      var raw = props.getProperty(DEBUG_LOG_PROP);
      var rows = raw ? JSON.parse(raw) : [];
      rows = rows.concat(buffered);
      if (rows.length > DEBUG_LOG_MAX_ROWS) rows = rows.slice(rows.length - DEBUG_LOG_MAX_ROWS);
      props.setProperty(DEBUG_LOG_PROP, JSON.stringify(rows));
    });
  } catch (e) { /* never let logging break the thing it's debugging */ }
}

/** Times + logs a REQUIRED stage (bootstrap, fixtures) — logs either way, but rethrows on error since the rest of the function can't proceed without it. */
function timedRequired_(requestId, t0, stage, fn) {
  var stageStart = Date.now();
  try {
    var result = fn();
    logDebugStage_(requestId, t0, stage, stageStart, 'ok');
    return result;
  } catch (e) {
    logDebugStage_(requestId, t0, stage, stageStart, 'error', e.message || String(e));
    throw e;
  }
}

/**
 * Times + logs an OPTIONAL stage — same degrade-gracefully contract as
 * safeCall_ (catches, returns fallback), but also logs timing/errors instead
 * of swallowing silently. Optional detailFn computes a success-path detail
 * string (e.g. a collection size) from the result — for the handful of
 * calls whose response size isn't bounded by this app's own code (a real
 * FPL account's transfer history or league count, unlike squad size which
 * is always exactly 15), so an unusually large real value shows up here
 * instead of only being visible from synthetic test data.
 */
function timedOptional_(requestId, t0, stage, fn, fallback, detailFn) {
  var stageStart = Date.now();
  try {
    var result = fn();
    var detail = detailFn ? safeCall_(function () { return detailFn(result); }) : '';
    logDebugStage_(requestId, t0, stage, stageStart, 'ok', detail);
    return result;
  } catch (e) {
    logDebugStage_(requestId, t0, stage, stageStart, 'error', e.message || String(e));
    return fallback === undefined ? null : fallback;
  }
}

/** Backend for the dedicated Debug page (?page=debug) — reads the ring buffer back, newest first. */
function getDebugPageData() {
  var logResult = { error: null, rows: [] };
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(DEBUG_LOG_PROP);
    var rows = raw ? JSON.parse(raw) : [];
    logResult.rows = rows.slice().reverse(); // newest first
  } catch (e) {
    logResult.error = e.message || String(e);
  }

  return {
    log: logResult,
    appVersion: APP_VERSION,
    debugLoggingEnabled: isDebugLoggingEnabled_(),
    triggerStatus: safeCall_(function () { return getTriggerStatus_(); }),
    hasAiKey: hasAiKey_(),
    hasYoutubeKey: hasYoutubeKey_(),
    hasGeminiKey: hasGeminiKey_(),
    teamId: getTeamId()
  };
}

/** "Run dashboard load now" button on the Debug page — a real getDashboardData() call, reported directly (success/failure/timing) without needing to leave this page or go back to a possibly-stuck main dashboard. */
function runDashboardDiag() {
  var t0 = Date.now();
  try {
    var data = getDashboardData();
    /* Health and correctness are different questions and this page used to
     * answer only the first. "The request came back in 3.1 seconds" says
     * nothing about whether what came back was possible — and the failures
     * worth catching here have all been of that second kind. */
    var inv = data.invariants || safeCall_(function () { return checkModelInvariants_(data); });
    return {
      ok: true,
      elapsedMs: Date.now() - t0,
      needsSetup: !!data.needsSetup,
      noSquadYet: !!data.noSquadYet,
      hasSquad: !!data.squad,
      gameweekState: data.gameweekState || null,
      transferLedger: data.transferLedger || null,
      invariants: inv || null
    };
  } catch (e) {
    return { ok: false, elapsedMs: Date.now() - t0, error: e.message || String(e) };
  }
}

/**
 * Deliberately does almost nothing — no PropertiesService, no UrlFetchApp,
 * no data of any real size. Isolates one specific question: does even a
 * near-instant, trivially small response come back correctly from THIS
 * exact page's google.script.run bridge, or does the null-data issue
 * happen regardless of what's actually being returned? If a tiny ping
 * ALSO fails from the main dashboard page, the cause is about the page's
 * calling context, not getDashboardData()'s specific response — every
 * prior test (payload size, debug logging overhead, PR #13's code) has
 * already been ruled out, so this is the next real fork in the diagnosis.
 */
function pingTest() {
  return { ok: true, ts: Date.now() };
}

/**
 * Isolated FPL API health check — hits bootstrap-static directly with none
 * of this app's own logic in the way (no squad building, no scoring, no
 * PropertiesService), so a slow/down upstream API shows up as exactly that
 * rather than looking indistinguishable from a bug in this app's own code.
 * Deliberately NOT folded into getDebugPageData() — if the FPL API were
 * genuinely down, that would make the Debug page itself slow to load, which
 * defeats the point of a page that's supposed to stay fast regardless.
 * "Check FPL API" is its own on-demand button instead, same as "Run it now".
 */
function checkFplApiHealth() {
  var t0 = Date.now();
  try {
    var res = UrlFetchApp.fetch(BASE + '/bootstrap-static/', {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FPLCommandCenter/1.0)' }
    });
    var code = res.getResponseCode();
    var elapsedMs = Date.now() - t0;
    var body = res.getContentText();
    var httpOk = code >= 200 && code < 300;

    var elementsCount = null;
    var parsedOk = false;
    if (httpOk) {
      try {
        var json = JSON.parse(body);
        parsedOk = !!(json && Array.isArray(json.elements) && Array.isArray(json.events));
        elementsCount = json.elements ? json.elements.length : null;
      } catch (e) { /* parsedOk stays false — valid HTTP response, invalid/unexpected body */ }
    }

    return {
      ok: httpOk && parsedOk,
      httpCode: code,
      elapsedMs: elapsedMs,
      bodyBytes: body.length,
      elementsCount: elementsCount,
      error: httpOk ? (parsedOk ? null : 'Got a 2xx response but the body wasn\'t valid FPL bootstrap JSON') : ('FPL API returned HTTP ' + code)
    };
  } catch (e) {
    return { ok: false, httpCode: null, elapsedMs: Date.now() - t0, bodyBytes: null, elementsCount: null, error: e.message || String(e) };
  }
}

/**
 * Single entry point for "The Wire" page (The Panel) — everything sourced
 * from outside this app's own algorithm, kept off the main dashboard and
 * grouped here instead. Already cached in PropertiesService, so this is
 * cheap — no new network calls, same data community signal scoring reads.
 */
function getWireData() {
  return {
    hasYoutubeKey: hasYoutubeKey_(),
    hasGeminiKey: hasGeminiKey_(),
    hasAiKey: hasAiKey_(),
    panel: safeCall_(function () { return getPanelEntries_(); }) || [],
    panelConsensus: safeCall_(function () { return buildPanelConsensus_(getPanelEntries_()); }),
    playerRecs: safeCall_(function () { return getPlayerRecommendations_(); }) || [],
    recSheetUrl: safeCall_(function () { return getRecommendationSheet_().getParent().getUrl(); }),
    // The Sheet-backed log fails silently when the deployment's OAuth grant
    // lacks Sheets access — SpreadsheetApp.create throws, safeCall_ swallows
    // it, and the page shows a bare "Nothing logged yet" that looks like an
    // empty feed rather than a permissions problem. Live evidence: The Panel
    // had processed videos while By Player showed nothing and the Sheet link
    // was absent. The reason now travels to the page.
    recSheetError: (function () {
      try { getRecommendationSheet_(); return null; }
      catch (e) { return String(e && e.message || e); }
    })(),
    triggerStatus: safeCall_(function () { return getTriggerStatus_(); })
  };
}

/* ===================== FPL API HELPERS ===================== */

function fetchJson_(url) {
  var res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FPLCommandCenter/1.0)' }
  });
  var code = res.getResponseCode();
  if (code >= 400) throw new Error('FPL API returned ' + code + ' for ' + url);
  return JSON.parse(res.getContentText());
}

/* --- bootstrap/fixtures cache -------------------------------------------
 *
 * bootstrap-static is ~1.5MB of JSON and was fetched and parsed from scratch
 * on every single page load, again by the Ratings page, and again by every
 * trigger tick — by a wide margin the most expensive thing in a dashboard
 * render, and the most likely reason a load ever ran long enough to look
 * hung. Only the ~30 per-player fields listed below are ever read, so this
 * caches a slimmed projection of it instead of the whole payload.
 *
 * Mechanics: slim -> JSON -> gzip -> base64 -> split across CacheService
 * keys (a single cache value caps at 100KB, and even slimmed this is bigger
 * than that). Every step is wrapped so a cache miss, a corrupt chunk, or a
 * gzip failure just falls through to the live fetch — the cache can only
 * ever make a request faster, never break it.
 *
 * TTLs are deliberately short: prices change nightly and injury news lands
 * at any time, so 15 minutes is the most staleness worth trading for the
 * speed. The masthead Refresh button clears both caches outright
 * (clearDataCache), so a user who wants this second's data can always get
 * it.
 */
var BOOTSTRAP_CACHE_KEY = 'BOOTSTRAP_SLIM_V2'; // V2 adds the underlying stats the component model reads
var BOOTSTRAP_CACHE_TTL = 900;   // 15 min
var FIXTURES_CACHE_KEY = 'FIXTURES_SLIM_V2'; // V2 keeps scores, for team form
var FIXTURES_CACHE_TTL = 1800;   // 30 min — fixture lists move far less than prices
var CACHE_CHUNK_CHARS = 90000;   // under CacheService's 100KB-per-value cap
var CACHE_MAX_CHUNKS = 12;

// Per-execution memo, so two calls inside one request never pay twice even
// on a cache miss.
var BOOTSTRAP_MEMO_ = null;
var FIXTURES_MEMO_ = null;
/* The assistant runs in the same execution as the dashboard render that
 * grounds it, and needs the same two derived objects. Bootstrap and fixtures
 * are already memoised above; these two are not, and rebuilding the fixture
 * ease map means re-walking every fixture for every club, while re-fetching
 * the history means a second network round trip for a response already in
 * memory. Both are set by getDashboardDataInner_ and read by askAI. */
var FIXTURE_EASE_MEMO_ = null;
var HISTORY_MEMO_ = null;

var BOOTSTRAP_ELEMENT_FIELDS = [
  'id', 'web_name', 'team', 'element_type', 'now_cost', 'cost_change_event',
  'status', 'news', 'form', 'points_per_game', 'total_points', 'minutes',
  'ep_next', 'ict_index', 'event_points', 'bonus',
  'expected_goal_involvements', 'expected_goal_involvements_per_90',
  'expected_goals_per_90', 'expected_assists_per_90',
  'expected_goals_conceded_per_90', 'clean_sheets_per_90', 'saves_per_90',
  'starts', 'starts_per_90', 'selected_by_percent',
  // Season totals the component model (projectPointsV2_) is built from.
  'expected_goals', 'expected_assists', 'expected_goals_conceded', 'saves',
  'defensive_contribution', 'clean_sheets', 'goals_conceded',
  'chance_of_playing_next_round', 'penalties_order',
  'transfers_in_event', 'transfers_out_event', 'cost_change_start',
  // Only the assistant reads these: a manager typing "Bruno" or "Fernandes"
  // should land on B.Fernandes, and neither string is his web_name.
  'first_name', 'second_name'
];
var BOOTSTRAP_TEAM_FIELDS = [
  'id', 'name', 'short_name',
  'strength_attack_home', 'strength_attack_away',
  'strength_defence_home', 'strength_defence_away'
];
var BOOTSTRAP_EVENT_FIELDS = [
  'id', 'name', 'deadline_time', 'is_current', 'is_next', 'finished',
  'average_entry_score', 'highest_score'
];

function pickFields_(obj, fields) {
  var out = {};
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (obj[f] !== undefined) out[f] = obj[f];
  }
  return out;
}

function slimBootstrap_(raw) {
  return {
    // Needed to convert `selected_by_percent` into an actual number of
    // owners, which is what makes a raw transfer count comparable between a
    // 45%-owned premium and a 2%-owned punt.
    total_players: raw.total_players,
    elements: (raw.elements || []).map(function (el) { return pickFields_(el, BOOTSTRAP_ELEMENT_FIELDS); }),
    teams: (raw.teams || []).map(function (t) { return pickFields_(t, BOOTSTRAP_TEAM_FIELDS); }),
    events: (raw.events || []).map(function (e) { return pickFields_(e, BOOTSTRAP_EVENT_FIELDS); })
  };
}

/** Only the fixture fields buildFixtureEaseMap_ actually reads. */
function slimFixtures_(raw) {
  return (raw || []).map(function (f) {
    return {
      event: f.event, team_h: f.team_h, team_a: f.team_a,
      team_h_difficulty: f.team_h_difficulty, team_a_difficulty: f.team_a_difficulty,
      kickoff_time: f.kickoff_time, finished: !!f.finished, started: !!f.started,
      // Read by buildTeamForm_ — results and scorelines are what "are they
      // conceding a lot" is answered from.
      id: f.id, team_h_score: f.team_h_score, team_a_score: f.team_a_score
    };
  });
}

function putChunkedCache_(key, str, ttl) {
  var packed = Utilities.base64Encode(
    Utilities.gzip(Utilities.newBlob(str, 'application/json')).getBytes()
  );
  var chunks = Math.ceil(packed.length / CACHE_CHUNK_CHARS);
  if (chunks > CACHE_MAX_CHUNKS) return false; // unexpectedly large — skip caching rather than thrash
  var cache = CacheService.getScriptCache();
  var payload = {};
  for (var i = 0; i < chunks; i++) {
    payload[key + '_' + i] = packed.substr(i * CACHE_CHUNK_CHARS, CACHE_CHUNK_CHARS);
  }
  payload[key + '_meta'] = String(chunks);
  cache.putAll(payload, ttl);
  return true;
}

function getChunkedCache_(key) {
  var cache = CacheService.getScriptCache();
  var meta = cache.get(key + '_meta');
  if (!meta) return null;
  var chunks = parseInt(meta, 10);
  if (!(chunks > 0)) return null;
  var wanted = [];
  for (var i = 0; i < chunks; i++) wanted.push(key + '_' + i);
  var got = cache.getAll(wanted);
  var packed = '';
  for (var j = 0; j < wanted.length; j++) {
    // A chunk can expire independently of the others; a partial payload is
    // worse than no payload, so bail to a live fetch rather than decode junk.
    if (got[wanted[j]] == null) return null;
    packed += got[wanted[j]];
  }
  return Utilities.ungzip(
    Utilities.newBlob(Utilities.base64Decode(packed), 'application/x-gzip')
  ).getDataAsString();
}

function cachedFetch_(cacheKey, ttl, fetchFn, slimFn) {
  var raw = safeCall_(function () { return getChunkedCache_(cacheKey); });
  if (raw) {
    var parsed = safeCall_(function () { return JSON.parse(raw); });
    if (parsed) return parsed;
  }
  var slim = slimFn(fetchFn());
  safeCall_(function () { return putChunkedCache_(cacheKey, JSON.stringify(slim), ttl); });
  return slim;
}

function getBootstrap_() {
  if (BOOTSTRAP_MEMO_) return BOOTSTRAP_MEMO_;
  BOOTSTRAP_MEMO_ = cachedFetch_(BOOTSTRAP_CACHE_KEY, BOOTSTRAP_CACHE_TTL,
    function () { return fetchJson_(BASE + '/bootstrap-static/'); }, slimBootstrap_);
  return BOOTSTRAP_MEMO_;
}

function getFixtures_() {
  if (FIXTURES_MEMO_) return FIXTURES_MEMO_;
  FIXTURES_MEMO_ = cachedFetch_(FIXTURES_CACHE_KEY, FIXTURES_CACHE_TTL,
    // NOT `?future=1`. That filter drops any fixture that has already kicked
    // off, which silently removes the ENTIRE gameweek currently in progress
    // from the fixture map — while that gameweek is still `!finished` and so
    // still the first entry in the lookahead window. The result was every
    // player projecting 0.0 expected points for "next" gameweek, a captain
    // section telling you not to captain anyone, and Free Hit triggering on
    // "15 of your players blank". The full list is barely larger, and which
    // fixtures count is decided here rather than by a query parameter whose
    // cutoff is kickoff time.
    function () { return fetchJson_(BASE + '/fixtures/'); }, slimFixtures_);
  return FIXTURES_MEMO_;
}

/**
 * Drops both caches so the next read goes to the FPL API. Called by the
 * masthead Refresh button (and available from the Debug page), so "the
 * numbers look stale" is always one click from being ruled out rather than
 * something a user has to wait 15 minutes to test.
 */
function clearDataCache() {
  BOOTSTRAP_MEMO_ = null;
  FIXTURES_MEMO_ = null;
  safeCall_(function () {
    var cache = CacheService.getScriptCache();
    [BOOTSTRAP_CACHE_KEY, FIXTURES_CACHE_KEY].forEach(function (key) {
      var keys = [key + '_meta'];
      for (var i = 0; i < CACHE_MAX_CHUNKS; i++) keys.push(key + '_' + i);
      cache.removeAll(keys);
    });
  });
  return { ok: true };
}
function getEntry_(teamId) { return fetchJson_(BASE + '/entry/' + teamId + '/'); }
function getHistory_(teamId) { return fetchJson_(BASE + '/entry/' + teamId + '/history/'); }
function getPicks_(teamId, eventId) { return fetchJson_(BASE + '/entry/' + teamId + '/event/' + eventId + '/picks/'); }
function getLeagueStandings_(leagueId) { return fetchJson_(BASE + '/leagues-classic/' + leagueId + '/standings/'); }

/* ===================== GAMEWEEK STATE ===================== */

/**
 * The one place that decides what time it is.
 *
 * Three different questions were being answered by one variable
 * (`currentEvent || nextEvent`), and they have three different answers:
 *
 *   liveEventId      the gameweek being PLAYED. Its deadline has gone, its
 *                    squad is locked, nothing about it can be changed. This
 *                    is the only gameweek `/entry/{id}/event/{n}/picks/` and
 *                    rivals' picks can be read for.
 *   decisionEventId  the gameweek being PICKED FOR — the first one whose
 *                    deadline is still in the future. Every recommendation
 *                    this app makes is for this gameweek and no other.
 *   picksEventId     the most recent locked gameweek, which is what the squad
 *                    is read from. Usually the live one; after the final
 *                    gameweek it is whatever was last locked.
 *
 * Collapsing these produced the whole class of bug this function exists to
 * remove: chip rows that could never say "play now" because they compared a
 * value computed for the decision gameweek against the live one's id;
 * captaincy advice computed on next week's fixtures but snapshotted and
 * graded against this week's results (which quietly poisoned the calibration
 * loop with a week's offset); and prose that described a locked gameweek and
 * an open one in the same breath without distinguishing them.
 *
 * Everything that answers "what should I do" takes decisionEventId.
 * Everything that reads what already happened takes liveEventId/picksEventId.
 */
function resolveGameweekState_(events, nowMs) {
  var now = nowMs != null ? nowMs : Date.now();
  var list = (events || []).slice().sort(function (a, b) { return a.id - b.id; });

  var deadlineOf = function (e) {
    if (!e || !e.deadline_time) return NaN;
    return Date.parse(e.deadline_time);
  };
  var locked = function (e) {
    var dl = deadlineOf(e);
    return isNaN(dl) ? !!e.finished : dl <= now;
  };

  // The decision gameweek is defined by the clock, not by the API's is_next
  // flag. is_next is maintained by FPL's own scheduler and lags the deadline
  // it describes; the deadline itself never lies.
  var openEvents = list.filter(function (e) { return !e.finished && !locked(e); });
  var decision = openEvents[0] || null;

  // The live gameweek is one that has started but not finished. Between
  // gameweeks there isn't one, and saying so is the point — "GW1 is live" and
  // "GW1 finished, GW2 is next" are different states and the UI reads
  // differently in each.
  var live = list.filter(function (e) { return !e.finished && locked(e); }).pop() || null;

  // The squad can only be read for a locked gameweek. That is the live one
  // while a gameweek is in flight, and the last finished one between them.
  var picks = live || list.filter(locked).pop() || null;

  var lastFinished = list.filter(function (e) { return e.finished; }).pop() || null;

  return {
    liveEventId: live ? live.id : null,
    liveInPlay: !!live,
    decisionEventId: decision ? decision.id : null,
    decisionDeadline: decision ? decision.deadline_time : null,
    picksEventId: picks ? picks.id : null,
    lastFinishedEventId: lastFinished ? lastFinished.id : null,
    seasonStarted: !!(live || lastFinished),
    // Nothing left to pick for: the season is over, or every remaining
    // deadline is unparseable. Callers must not render an action plan.
    seasonOver: !decision,
    /**
     * The single predicate every actionable recommendation is gated on.
     * A gameweek can be acted on only while its deadline is still ahead.
     */
    canActOn: function (eventId) {
      if (eventId == null) return false;
      var ev = list.filter(function (e) { return String(e.id) === String(eventId); })[0];
      if (!ev) return false;
      return !ev.finished && !locked(ev);
    }
  };
}

/* ===================== FIXTURE DIFFICULTY ===================== */

/**
 * Returns { teamId: { avgDifficulty, weightedDifficulty, nextOpponents: [...],
 *                     doubleGw: {eventId:count}, blankGws: [eventId,...] } }
 */
var FIXTURE_HORIZON_DECAY = 0.8; // each gameweek further out counts 20% less

function buildFixtureEaseMap_(bootstrap, fixtures, lookaheadGws) {
  // The horizon is the gameweeks you can STILL MAKE DECISIONS FOR — those
  // whose deadline has not passed. "Not finished" was the wrong test: a
  // gameweek in progress is not finished, but its deadline has gone, its
  // squad is locked, and no transfer or captain change can touch it. Leading
  // the window with it meant every projection's "next gameweek" was a
  // gameweek nobody could act on.
  //
  // The test lives in resolveGameweekState_ so that this window and the
  // gameweek every recommendation is LABELLED with are decided by the same
  // code. When they were decided separately they drifted apart, and a
  // projection for GW3 could be presented, snapshotted and graded as GW2.
  var state = resolveGameweekState_(bootstrap.events);
  var actionable = bootstrap.events.filter(function (e) { return state.canActOn(e.id); });
  // End of season, or unparseable deadlines: fall back to whatever is left
  // rather than returning an empty horizon and zeroing every projection.
  if (!actionable.length) actionable = bootstrap.events.filter(function (e) { return !e.finished; });

  var eventIds = actionable
    .map(function (e) { return e.id; }).sort(function (a, b) { return a - b; })
    .slice(0, lookaheadGws);
  var eventIdSet = {};
  eventIds.forEach(function (id) { eventIdSet[id] = true; });

  // League-average strengths, for the position-aware half of the fixture
  // adjustment. Computed here because this is the one place that already
  // walks every team, and read later by positionStrengthFactor_.
  TEAM_STRENGTH_NORM_ = loadTeamStrengthNorms_(bootstrap);

  var teams = {};
  var strengthById = {};
  bootstrap.teams.forEach(function (tm) {
    teams[tm.id] = { name: tm.name, shortName: tm.short_name, fixtures: [], countByEvent: {} };
    strengthById[tm.id] = {
      strength_attack_home: tm.strength_attack_home,
      strength_attack_away: tm.strength_attack_away,
      strength_defence_home: tm.strength_defence_home,
      strength_defence_away: tm.strength_defence_away
    };
  });

  fixtures.forEach(function (f) {
    if (!f.event) return; // unscheduled (TBD) fixture
    if (f.finished) return; // already played — cannot be projected for
    if (!eventIdSet[f.event]) return; // outside the decision horizon
    if (teams[f.team_h]) {
      teams[f.team_h].fixtures.push({
        event: f.event, opponent: f.team_a,
        opponentShort: teams[f.team_a] ? teams[f.team_a].shortName : '?',
        // The opponent's four strength numbers, carried on the fixture so the
        // projection never has to re-join back to bootstrap.teams per player.
        opponentTeam: strengthById[f.team_a] || null,
        home: true, difficulty: f.team_h_difficulty
      });
      teams[f.team_h].countByEvent[f.event] = (teams[f.team_h].countByEvent[f.event] || 0) + 1;
    }
    if (teams[f.team_a]) {
      teams[f.team_a].fixtures.push({
        event: f.event, opponent: f.team_h,
        opponentShort: teams[f.team_h] ? teams[f.team_h].shortName : '?',
        opponentTeam: strengthById[f.team_h] || null,
        home: false, difficulty: f.team_a_difficulty
      });
      teams[f.team_a].countByEvent[f.event] = (teams[f.team_a].countByEvent[f.event] || 0) + 1;
    }
  });

  var result = {};
  Object.keys(teams).forEach(function (tid) {
    var t = teams[tid];
    var upcoming = t.fixtures.filter(function (f) { return eventIds.indexOf(f.event) !== -1; });
    var avg = upcoming.length
      ? upcoming.reduce(function (s, f) { return s + f.difficulty; }, 0) / upcoming.length
      : 3;
    // A flat six-week average treats "brutal this week, easy after" and
    // "easy this week, brutal after" as identical, which is exactly wrong
    // for a decision you are making THIS week. The weighted figure decays
    // each successive gameweek, so the fixture immediately in front of a
    // player counts most and the sixth counts least — that's the one used
    // for scoring; the plain average is kept because the fixture grid and
    // the explanation copy both describe the run as a whole.
    var wSum = 0, wTotal = 0;
    upcoming.forEach(function (f) {
      var idx = eventIds.indexOf(f.event);
      var w = Math.pow(FIXTURE_HORIZON_DECAY, idx < 0 ? 0 : idx);
      wSum += f.difficulty * w;
      wTotal += w;
    });
    var weighted = wTotal ? wSum / wTotal : 3;
    var doubleGw = {};
    var blankGws = [];
    eventIds.forEach(function (evId) {
      var count = t.countByEvent[evId] || 0;
      if (count >= 2) doubleGw[evId] = count;
      if (count === 0) blankGws.push(evId);
    });
    result[tid] = {
      name: t.name,
      shortName: t.shortName,
      avgDifficulty: Math.round(avg * 10) / 10,
      weightedDifficulty: Math.round(weighted * 100) / 100,
      eventIds: eventIds,
      fixturesByEvent: (function () {
        var m = {};
        upcoming.forEach(function (f) { (m[f.event] = m[f.event] || []).push(f); });
        return m;
      })(),
      /* "(2 for EVE)", not "(2)". FDR belongs to one SIDE of a fixture —
       * Hull v Everton is a 2 for Everton and a 3 for Hull — and a bare
       * number on two players' cards read as the same match being rated
       * twice, inconsistently. Naming the side makes it a fact about the
       * player's own team, which is what it is. */
      nextOpponents: upcoming.slice(0, 5).map(function (f) {
        return (f.home ? '' : '@') + (teams[f.opponent] ? teams[f.opponent].shortName : '?') +
          ' (' + f.difficulty + ' for ' + t.shortName + ')';
      }),
      doubleGw: doubleGw,
      blankGws: blankGws
    };
  });
  return result;
}

/* ===================== RECENT FORM: CLUBS AND MINUTES =====================
 *
 * Two questions the app could not answer. "Are Bournemouth conceding a lot?"
 * had no route except through a player who happened to be in scope, because
 * nothing in the app modelled a club. And "is he actually starting?" was one
 * season-long minutes share, so a player benched for the last three matches
 * after a bright August still read as a regular.
 *
 * Both come from the per-gameweek live results — every player's minutes,
 * starts, points and expected goals for a finished gameweek. A finished
 * gameweek's numbers never change, so each is cached for hours, slimmed to
 * the six numbers used here.
 */
var RECENT_FORM_GWS = 5;          // matches a club's form is read over
var ROTATION_WINDOW_GWS = 3;      // matches a player's recent starts are read over
var FINISHED_LIVE_CACHE_TTL = 21600;
var RECENT_LIVE_ = null;          // per request: { gw: { id: [min, starts, pts, xg, xa] } }
var RECENT_FIXTURES_ = null;      // per request: the fixture list RECENT_LIVE_ is read against

/** rotationFlag_ against this request's data; null when it is not loaded. */
function rotationFor_(el) {
  return RECENT_LIVE_ ? rotationFlag_(el, RECENT_FIXTURES_, RECENT_LIVE_) : null;
}

/** One finished gameweek's results as { id: [minutes, starts, points, xG, xA] }. */
function getFinishedLiveSlim_(eventId) {
  var key = 'LIVEF_' + eventId;
  var cached = safeCall_(function () { return CacheService.getScriptCache().get(key); });
  var parsed = cached ? safeCall_(function () { return JSON.parse(cached); }) : null;
  if (parsed) return parsed;
  var live = getEventLive_(eventId);
  var out = {};
  (live.elements || []).forEach(function (e) {
    var st = e.stats || {};
    if (!st.minutes && !st.total_points) return; // most of the pool; absent means 0
    out[e.id] = [st.minutes || 0, st.starts || 0, st.total_points || 0,
      Math.round((parseFloat(st.expected_goals) || 0) * 100) / 100,
      Math.round((parseFloat(st.expected_assists) || 0) * 100) / 100];
  });
  safeCall_(function () { CacheService.getScriptCache().put(key, JSON.stringify(out), FINISHED_LIVE_CACHE_TTL); });
  return out;
}

/** The last `n` finished gameweeks' results, newest last. */
function loadRecentLive_(bootstrap, n) {
  var finished = bootstrap.events.filter(function (e) { return e.finished; })
    .map(function (e) { return e.id; }).sort(function (a, b) { return a - b; }).slice(-n);
  var out = {};
  finished.forEach(function (gw) {
    var slim = safeCall_(function () { return getFinishedLiveSlim_(gw); });
    if (slim) out[gw] = slim;
  });
  return out;
}

/**
 * Has he been starting? Read over the club's last ROTATION_WINDOW_GWS
 * matches, not the season, so a player who has lost his place shows it now
 * rather than once his season average catches up.
 *
 * Returns null without the data. Injured and suspended players are left to
 * their status flag — missing matches because you are hurt is not rotation.
 */
function rotationFlag_(el, fixtures, recent) {
  if (!recent || !Object.keys(recent).length) return null;
  if (el.status === 'i' || el.status === 's' || el.status === 'u') return null;
  // A player who has not played all season (a third keeper) has no place to
  // lose; flagging him every week is noise.
  if (el.minutes === 0) return null;
  var gws = Object.keys(recent).map(Number).sort(function (a, b) { return a - b; });
  var played = {};
  (fixtures || []).forEach(function (f) {
    if (f.team_h === el.team || f.team_a === el.team) played[f.event] = (played[f.event] || 0) + 1;
  });
  var window = gws.filter(function (gw) { return played[gw]; }).slice(-ROTATION_WINDOW_GWS);
  if (window.length < 2) return null;
  var matches = 0, started = 0, minutes = 0;
  window.forEach(function (gw) {
    matches += played[gw];
    var r = recent[gw][el.id];
    if (r) { minutes += r[0]; started += r[1]; }
  });
  var share = minutes / (90 * matches);
  var risk = started === 0 && minutes < 45 ? 'benched'
    : (started <= matches - 2 || share < 0.5 ? 'rotation' : (started === matches && share >= 0.85 ? 'nailed' : 'regular'));
  var text = 'Started ' + started + ' of the last ' + matches + ' (' + minutes + ' of ' + (90 * matches) + ' minutes)';
  return {
    matches: matches, started: started, minutes: minutes,
    share: Math.round(share * 100) / 100,
    risk: risk,
    text: risk === 'benched' ? text + ' — not starting.'
      : (risk === 'rotation' ? text + ' — rotation risk.' : text + '.')
  };
}

/**
 * A club's recent record: results with scorelines, goals and expected goals
 * for and against, clean sheets, the home/away split, and the FPL points its
 * opponents' defenders, midfielders and forwards have scored against it.
 * Expected goals are summed from player data, so only single-fixture
 * gameweeks carry them (a double gameweek cannot be split per match).
 */
function buildTeamForm_(bootstrap, fixtures, teamId, recent) {
  var teamsById = {};
  bootstrap.teams.forEach(function (t) { teamsById[t.id] = t; });
  var team = teamsById[teamId];
  if (!team) return null;
  var elById = {};
  bootstrap.elements.forEach(function (el) { elById[el.id] = el; });

  var played = (fixtures || []).filter(function (f) {
    return f.finished && (f.team_h === teamId || f.team_a === teamId) && f.team_h_score != null;
  }).sort(function (a, b) { return (a.event || 0) - (b.event || 0); });
  var perGw = {};
  played.forEach(function (f) { perGw[f.event] = (perGw[f.event] || 0) + 1; });

  /* Per-gameweek sums by club from the live data: xG, and points by position. */
  function clubSums(gw, clubId) {
    var r = recent && recent[gw];
    if (!r) return null;
    var sums = { xg: 0, pts: { 2: 0, 3: 0, 4: 0 } };
    Object.keys(r).forEach(function (id) {
      var el = elById[id];
      if (!el || el.team !== clubId) return;
      sums.xg += r[id][3];
      if (sums.pts[el.element_type] != null) sums.pts[el.element_type] += r[id][2];
    });
    return sums;
  }

  var matches = played.slice(-RECENT_FORM_GWS).map(function (f) {
    var home = f.team_h === teamId;
    var opp = home ? f.team_a : f.team_h;
    var gf = home ? f.team_h_score : f.team_a_score;
    var ga = home ? f.team_a_score : f.team_h_score;
    var single = perGw[f.event] === 1;
    var mine = single ? clubSums(f.event, teamId) : null;
    var theirs = single ? clubSums(f.event, opp) : null;
    return {
      event: f.event, opponent: teamsById[opp] ? teamsById[opp].short_name : '?', home: home,
      gf: gf, ga: ga, result: gf > ga ? 'W' : (gf === ga ? 'D' : 'L'),
      xg: mine ? Math.round(mine.xg * 100) / 100 : null,
      xga: theirs ? Math.round(theirs.xg * 100) / 100 : null,
      ptsConceded: theirs ? theirs.pts : null
    };
  });

  function summarise(list) {
    var withXg = list.filter(function (m) { return m.xg != null; });
    var n = list.length;
    return {
      played: n,
      w: list.filter(function (m) { return m.result === 'W'; }).length,
      d: list.filter(function (m) { return m.result === 'D'; }).length,
      l: list.filter(function (m) { return m.result === 'L'; }).length,
      gf: list.reduce(function (s2, m) { return s2 + m.gf; }, 0),
      ga: list.reduce(function (s2, m) { return s2 + m.ga; }, 0),
      cleanSheets: list.filter(function (m) { return m.ga === 0; }).length,
      xgPer: withXg.length ? Math.round(withXg.reduce(function (s2, m) { return s2 + m.xg; }, 0) / withXg.length * 100) / 100 : null,
      xgaPer: withXg.length ? Math.round(withXg.reduce(function (s2, m) { return s2 + m.xga; }, 0) / withXg.length * 100) / 100 : null
    };
  }
  var conceded = { 2: [], 3: [], 4: [] };
  matches.forEach(function (m) {
    if (!m.ptsConceded) return;
    [2, 3, 4].forEach(function (pos) { conceded[pos].push(m.ptsConceded[pos]); });
  });
  var avg = function (a) { return a.length ? Math.round(a.reduce(function (s2, x) { return s2 + x; }, 0) / a.length * 10) / 10 : null; };

  return {
    teamId: teamId, name: team.name, shortName: team.short_name,
    matches: matches,
    last: summarise(matches),
    home: summarise(matches.filter(function (m) { return m.home; })),
    away: summarise(matches.filter(function (m) { return !m.home; })),
    // FPL points scored AGAINST this club per match, by the opponent's position.
    pointsConcededPerMatch: { DEF: avg(conceded[2]), MID: avg(conceded[3]), FWD: avg(conceded[4]) }
  };
}

/** Every club's form, with league ranks for goals and xG against. */
function buildLeagueTeamForm_(bootstrap, fixtures, recent) {
  var all = bootstrap.teams.map(function (t) { return buildTeamForm_(bootstrap, fixtures, t.id, recent); }).filter(Boolean);
  function rank(key, getter, worstFirst) {
    var vals = all.filter(function (f) { return getter(f) != null; })
      .sort(function (a, b) { return worstFirst ? getter(b) - getter(a) : getter(a) - getter(b); });
    vals.forEach(function (f, i) { f.ranks = f.ranks || {}; f.ranks[key] = { pos: i + 1, of: vals.length }; });
  }
  rank('mostConceded', function (f) { return f.last.played ? f.last.ga / f.last.played : null; }, true);
  rank('highestXga', function (f) { return f.last.xgaPer; }, true);
  rank('mostScored', function (f) { return f.last.played ? f.last.gf / f.last.played : null; }, true);
  rank('highestXg', function (f) { return f.last.xgPer; }, true);
  return all;
}

/** Plain-text team form for the assistant. */
function describeTeamForm_(f) {
  if (!f) return 'No such club.';
  var L = [];
  var r = function (k) { return f.ranks && f.ranks[k] ? f.ranks[k].pos + ordinal_(f.ranks[k].pos) + ' of ' + f.ranks[k].of : '?'; };
  L.push(f.name + ' — last ' + f.last.played + ' matches: W' + f.last.w + ' D' + f.last.d + ' L' + f.last.l +
    ', scored ' + f.last.gf + ', conceded ' + f.last.ga + ', ' + f.last.cleanSheets + ' clean sheet' + (f.last.cleanSheets === 1 ? '' : 's') + '.');
  if (f.last.xgaPer != null) {
    L.push('Per match: xG ' + f.last.xgPer.toFixed(2) + ' for, ' + f.last.xgaPer.toFixed(2) + ' against.');
  }
  L.push('League rank over the same window: ' + r('mostConceded') + ' for goals conceded per match (1st = conceding most), ' +
    r('highestXga') + ' for xG against, ' + r('mostScored') + ' for goals scored, ' + r('highestXg') + ' for xG.');
  L.push('Home: ' + f.home.played + ' played, scored ' + f.home.gf + ', conceded ' + f.home.ga +
    '. Away: ' + f.away.played + ' played, scored ' + f.away.gf + ', conceded ' + f.away.ga + '.');
  var pc = f.pointsConcededPerMatch;
  if (pc.DEF != null) {
    L.push('FPL points opponents scored against them per match: defenders ' + pc.DEF + ', midfielders ' + pc.MID + ', forwards ' + pc.FWD + '.');
  }
  L.push('Results: ' + f.matches.map(function (m) {
    return 'GW' + m.event + ' ' + (m.home ? 'v ' : '@ ') + m.opponent + ' ' + m.gf + '-' + m.ga + ' ' + m.result +
      (m.xg != null ? ' (xG ' + m.xg.toFixed(1) + '-' + m.xga.toFixed(1) + ')' : '');
  }).join('; ') + '.');
  return L.join('\n');
}

function ordinal_(n) {
  var s2 = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return s2[(v - 20) % 10] || s2[v] || s2[0];
}

/* ===================== SCORING ===================== */

var STATUS_PENALTY = { a: 1, d: 0.6, i: 0.05, s: 0.05, u: 0 }; // available/doubtful/injured/suspended/unavailable
var STATUS_LABEL = { a: 'Available', d: 'Doubtful', i: 'Injured', s: 'Suspended', u: 'Unavailable' };

/**
 * Community signal — what the tracked YouTube analysts are actually backing,
 * folded into scoring as a real (small) term rather than a UI annotation.
 *
 * Reddit used to be the other half of this. It was removed: unauthenticated
 * access had already degraded to an RSS fallback with no scores and
 * best-effort comment counts, and what came back was overwhelmingly not
 * recommendation signal — "GW1 Lineups", "Bonus Points + Defcon", transfer
 * rumours, jokes. Counting those as evidence that a player is backed was
 * noise dressed as data.
 *
 * Two counts now, because they mean different things. How many videos pick a
 * player is volume — one analyst can post three videos in a week. How many
 * distinct CHANNELS pick him is agreement between independent sources, which
 * is the stronger signal, so it carries the heavier weight.
 *
 * Still deliberately a secondary nudge: a player at both caps adds at most
 * ~5.6 to a raw score that typically runs 10-50 for a rotation-relevant
 * player. It shifts close calls; it does not override form, fixtures or xGI.
 *
 * Counts any picked player, agrees or differs — not just "agrees" picks —
 * specifically to avoid the score reinforcing its own past calls (the
 * agree/differ verdict is itself computed by comparing against this app's
 * own suggestions, so feeding only "agrees" back in would create a slow
 * feedback loop).
 */
var COMMUNITY_VIDEO_WEIGHT = 0.5;   // per distinct video in the window picking the player
var COMMUNITY_VIDEO_CAP = 4;
var COMMUNITY_CHANNEL_WEIGHT = 1.2; // per distinct channel picking the player — independent agreement
var COMMUNITY_CHANNEL_CAP = 3;
var COMMUNITY_SIGNAL_ = null; // { videos: {webName: count}, channels: {webName: count} } — set once per request by loadCommunitySignal_

/** Builds the per-player community signal from already-cached Panel data — no network calls of its own. */
function loadCommunitySignal_(bootstrap) {
  var videos = {};
  var channelsByPlayer = {};

  var panelEntries = safeCall_(function () { return getPanelEntries_(); }) || [];
  panelEntries.forEach(function (entry) {
    var seenInThisVideo = {};
    (entry.picks || []).forEach(function (pick) {
      findMentionedPlayers_(pick.label, bootstrap).forEach(function (name) {
        // One video backing the same player in two picks is still one video.
        if (!seenInThisVideo[name]) {
          seenInThisVideo[name] = true;
          videos[name] = (videos[name] || 0) + 1;
        }
        (channelsByPlayer[name] = channelsByPlayer[name] || {})[entry.channelId] = true;
      });
    });
  });

  var channels = {};
  Object.keys(channelsByPlayer).forEach(function (name) {
    channels[name] = Object.keys(channelsByPlayer[name]).length;
  });

  return { videos: videos, channels: channels };
}

/** Capped, weighted community contribution for one player — same shape (input × weight) as every other scoring term, for the Ratings page breakdown. */
function communitySignalFor_(webName) {
  if (!COMMUNITY_SIGNAL_) return { videoCount: 0, channelCount: 0, contribution: 0 };
  var videoCount = Math.min((COMMUNITY_SIGNAL_.videos || {})[webName] || 0, COMMUNITY_VIDEO_CAP);
  var channelCount = Math.min((COMMUNITY_SIGNAL_.channels || {})[webName] || 0, COMMUNITY_CHANNEL_CAP);
  var contribution = Math.round((videoCount * COMMUNITY_VIDEO_WEIGHT + channelCount * COMMUNITY_CHANNEL_WEIGHT) * 100) / 100;
  return { videoCount: videoCount, channelCount: channelCount, contribution: contribution };
}

/* --- season context ------------------------------------------------------
 * A handful of derived facts about where the season is that several scoring
 * terms need and none of them can work out from a single element row. Set
 * once per request (same pattern as COMMUNITY_SIGNAL_) rather than threaded
 * through every signature.
 */
var SEASON_CONTEXT_ = null; // { finishedGws, startedGws, avgEntryScore }

/* Two different counts, because "how much of the season has happened" has two
 * different answers and they are not interchangeable.
 *
 * `finishedGws` counts COMPLETED gameweeks. That is the right denominator for
 * anything derived from minutes — mid-gameweek, half the league has not
 * kicked off yet, and dividing by a gameweek in progress would read every
 * player still to play as dropped.
 *
 * `startedGws` counts gameweeks whose deadline has PASSED. That is the right
 * count for "does form/points-per-game carry current-season data yet, and how
 * many matches back it" — because the API starts populating those the moment
 * the first ball is kicked, not when the gameweek is ratified.
 *
 * Collapsing them cost a whole fix: the shrinkage in xpBaseCurve_ treated
 * `finishedGws === 0` as preseason, and a gameweek IN PROGRESS also has zero
 * finished gameweeks. So through the entire opening weekend the shrinkage was
 * bypassed and one match was read as a rate again — the exact bug it was
 * written to prevent, live on the page with the fix supposedly deployed.
 */
function loadSeasonContext_(bootstrap) {
  var events = bootstrap.events || [];
  var finished = events.filter(function (e) { return e.finished; });
  var now = Date.now();
  var started = events.filter(function (e) {
    if (e.finished) return true;
    if (!e.deadline_time) return false;
    var dl = Date.parse(e.deadline_time);
    return !isNaN(dl) && dl <= now;
  });
  var scored = finished.filter(function (e) { return e.average_entry_score > 0; });
  return {
    finishedGws: finished.length,
    startedGws: started.length,
    avgEntryScore: scored.length
      ? Math.round(scored.reduce(function (s, e) { return s + e.average_entry_score; }, 0) / scored.length)
      : null
  };
}

/**
 * xGI per 90 minutes. `expected_goal_involvements` in bootstrap-static is a
 * SEASON CUMULATIVE total, so using it raw (as this did) quietly rewarded
 * players simply for having played more games: by GW30 an ever-present
 * midfielder carried ~10-15 xGI against a January signing's ~2, and at the
 * old weight that gap alone was worth ~40 points of raw score — far more
 * than form or fixtures could ever move. Per-90 is the rate the season
 * total was standing in for, and it's comparable across players from GW1.
 * The API supplies it directly; the fallback derives it for the rare row
 * that doesn't carry the field.
 */
function xgiPer90_(el) {
  var direct = parseFloat(el.expected_goal_involvements_per_90);
  if (!isNaN(direct) && direct > 0) return direct;
  var total = parseFloat(el.expected_goal_involvements) || 0;
  var mins = el.minutes || 0;
  if (mins < 90) return 0; // too small a sample to annualise honestly
  return total / (mins / 90);
}

/**
 * Share of available minutes played this season, 0-1 — the app's proxy for
 * "is this a starter or a rotation risk". Returns null before any gameweek
 * has finished, which callers read as "unknown" rather than "zero": a
 * preseason squad has no minutes for anyone and must not be scored as if
 * every player were dropped.
 */
function minutesShare_(el) {
  var gws = SEASON_CONTEXT_ ? SEASON_CONTEXT_.finishedGws : 0;
  if (!gws) return null;
  return Math.max(0, Math.min(1, (el.minutes || 0) / (90 * gws)));
}

/* Rotation risk, as a multiplier.
 *
 * The floor used to be a flat 0.55 whatever the evidence, which meant a
 * player who had not got on the pitch all season still projected 55% of a
 * starter's points. A 5.0-base-rate player who never plays came out at ~2.8 a
 * week — enough to flatter deep bench options in the squad builder and to pad
 * the transfer planner's candidate pool with players whose real expectation
 * is an appearance point or nothing.
 *
 * The gentleness was right for a different reason than it was applied: form,
 * ppg and ep_next already carry some minutes signal, so this should not be a
 * second full penalty for a player who is merely rotated. It should be a real
 * penalty for one who genuinely does not play, and those are different cases.
 *
 * So the floor tightens as evidence accumulates. Preseason there is no
 * minutes data for anyone and everything reads 0.9 — a mild "nobody is
 * confirmed nailed yet". Once gameweeks are on the board the floor slides
 * from lenient toward STARTER_FLOOR_SETTLED, reaching it by
 * STARTER_FLOOR_FULL_EVIDENCE gameweeks. A player with no minutes in
 * September is a maybe; one with no minutes in January is not.
 */
var STARTER_FLOOR_EARLY = 0.55;
var STARTER_FLOOR_SETTLED = 0.2;
var STARTER_FLOOR_FULL_EVIDENCE = 8; // gameweeks before the floor is fully tightened

function starterFloor_() {
  var gws = SEASON_CONTEXT_ ? SEASON_CONTEXT_.finishedGws : 0;
  if (!gws) return STARTER_FLOOR_EARLY;
  var evidence = Math.min(1, gws / STARTER_FLOOR_FULL_EVIDENCE);
  return STARTER_FLOOR_EARLY - (STARTER_FLOOR_EARLY - STARTER_FLOOR_SETTLED) * evidence;
}

function starterFactor_(el) {
  var share = minutesShare_(el);
  if (share === null) return 0.9;
  var floor = starterFloor_();
  return Math.round((floor + (1 - floor) * share) * 100) / 100;
}

/**
 * Availability 0-1. `chance_of_playing_next_round` is the club's own stated
 * percentage and is strictly better information than the coarse status
 * letter when it's present — a 75% doubt and a 25% doubt are both status
 * 'd', and the old code priced both at 0.6.
 */
function availabilityFactor_(el) {
  var chance = el.chance_of_playing_next_round;
  if (chance !== null && chance !== undefined && chance !== '') {
    var pct = parseFloat(chance);
    if (!isNaN(pct)) return Math.max(0, Math.min(1, pct / 100));
  }
  return STATUS_PENALTY[el.status] !== undefined ? STATUS_PENALTY[el.status] : 0.5;
}

var SCORE_WEIGHTS = {
  form: 2.2,
  epNext: 2.5,
  ppg: 0.8,
  ict: 0.08,
  xgi: 12   // now applied to xGI PER 90 (typically 0.1-0.9), not the season total
};

function playerScore_(el, fixtureEase) {
  var form = parseFloat(el.form) || 0;
  var ppg = parseFloat(el.points_per_game) || 0;
  var epNext = parseFloat(el.ep_next) || 0;
  var ict = parseFloat(el.ict_index) || 0;
  var xgi90 = xgiPer90_(el);
  var ease = fixtureEase[el.team] ? fixtureEase[el.team].weightedDifficulty : 3;
  var fixtureMultiplier = 1 + (3 - ease) * 0.12; // easier fixtures (lower difficulty) boost score
  var availability = availabilityFactor_(el);
  var starter = starterFactor_(el);
  var community = communitySignalFor_(el.web_name).contribution;

  var raw = (form * SCORE_WEIGHTS.form) + (epNext * SCORE_WEIGHTS.epNext) + (ppg * SCORE_WEIGHTS.ppg) +
    (ict * SCORE_WEIGHTS.ict) + (xgi90 * SCORE_WEIGHTS.xgi) + community;
  return Math.round(raw * fixtureMultiplier * availability * starter * 100) / 100;
}

function valueScore_(el, fixtureEase) {
  var price = (el.now_cost || 1) / 10;
  return Math.round((playerScore_(el, fixtureEase) / price) * 100) / 100;
}

/* ===================== CALIBRATION =====================
 *
 * The weekly grading loop was the best idea in this app and it terminated in
 * a display table. Every gameweek it recorded whether a decision came off,
 * and none of that evidence ever reached the model that made the decision:
 * the weights are hand-set constants, and no amount of graded history would
 * ever move them.
 *
 * Two things are wanted, and they are not the same thing:
 *
 *   1. IS THE MODEL ANY GOOD? Which the track record dodges — it grades the
 *      calls, never the arithmetic beneath them. Predicted points against
 *      actual points, week by week, answers it directly and is honest even
 *      when the answer stings.
 *   2. CAN IT BE MADE BETTER WITHOUT A REWRITE? Fitting the weights properly
 *      is a regression problem and does not belong inside a page load. But a
 *      systematic bias — the model running consistently hot on defenders,
 *      say — is a single multiplier per position, learnable by division, and
 *      it is where most of the recoverable error usually lives.
 *
 * So (1) is published as its own section and (2) is applied, conservatively:
 * the correction only engages after enough gameweeks to be more than noise,
 * is clamped so a strange month cannot distort the model, and is shrunk
 * toward 1 in proportion to how little evidence supports it. A correction
 * that swung hard on three gameweeks would be overfitting dressed as
 * learning.
 */
/* The sample is the whole player pool now (see gradeFinishedGws_), a few
 * hundred player-gameweeks per position per week rather than a handful, so
 * the evidence floor is set in gameweeks — what varies between weeks is the
 * fixtures, and three weeks is the least that averages over them. */
var CALIBRATION_MIN_GWS = 3;        // gameweeks of evidence before any correction applies
var CALIBRATION_FULL_TRUST_GWS = 10; // where the correction reaches full strength
var CALIBRATION_CLAMP = 0.25;       // never move a projection by more than ±25%
var CALIBRATION_MIN_SAMPLES = 12;   // player-gameweeks per position before trusting its bias
var CALIBRATION_VERSION = 2;        // grades older than this measured something else; see gradeFinishedGws_
var CAL_MIN_PREDICTED = 1.0;        // projections below this are not graded — selection on the forecast, not the outcome
var CALIBRATION_CACHE_KEY = 'CALIBRATION_V2';
var CALIBRATION_CACHE_TTL = 1800;

var CALIBRATION_ = null; // per-request memo, set by loadCalibration_

/**
 * Reads every graded gameweek back and works out how far off the projections
 * were, overall and per position.
 */
function buildCalibration_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var weeks = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('GRADE_') !== 0) return;
    var g = safeCall_(function () { return JSON.parse(all[k]); });
    // `alignedProjections` is the guarantee that a week's predictions were
    // made FOR the week they are scored against. Grades produced before
    // advice and actuals were split lack it, were a gameweek out of step, and
    // are therefore not evidence about the model at all — so they are dropped
    // rather than averaged in.
    // Version 1 grades scored the squad only, on calibrated and conditional
    // numbers — not evidence about the raw model. See gradeFinishedGws_.
    if (g && g.eventId && g.calibration && g.calibration.n && g.calibration.alignedProjections &&
        g.calibration.version >= CALIBRATION_VERSION) weeks.push(g);
  });
  if (!weeks.length) return null;
  weeks.sort(function (a, b) { return a.eventId - b.eventId; });

  var totals = { predicted: 0, actual: 0, n: 0 };
  var byPos = {};
  var series = [];

  weeks.forEach(function (g) {
    var c = g.calibration;
    totals.predicted += c.predicted;
    totals.actual += c.actual;
    totals.n += c.n;
    series.push({
      event: g.eventId,
      predicted: Math.round(c.predicted * 10) / 10,
      actual: c.actual,
      diff: Math.round((c.actual - c.predicted) * 10) / 10
    });
    Object.keys(c.byPosition || {}).forEach(function (pos) {
      var row = c.byPosition[pos];
      var acc = byPos[pos] || (byPos[pos] = { predicted: 0, actual: 0, n: 0 });
      acc.predicted += row.predicted;
      acc.actual += row.actual;
      acc.n += row.n;
    });
  });

  if (!totals.predicted) return null;

  /* Bias as a multiplier: what the projection should have been multiplied by
   * to land on reality. Above 1 means the model runs cold (it under-predicts),
   * below 1 that it runs hot. */
  function biasOf(row) {
    if (!row.predicted) return null;
    return Math.round((row.actual / row.predicted) * 1000) / 1000;
  }

  var positions = {};
  Object.keys(byPos).forEach(function (pos) {
    var row = byPos[pos];
    positions[pos] = {
      position: POSITION_MAP[pos] || pos,
      predicted: Math.round(row.predicted * 10) / 10,
      actual: row.actual,
      samples: row.n,
      bias: biasOf(row)
    };
  });

  // Confidence grows with the number of graded gameweeks, so an early
  // correction is deliberately timid rather than confidently wrong.
  var trust = weeks.length < CALIBRATION_MIN_GWS
    ? 0
    : Math.min(1, (weeks.length - CALIBRATION_MIN_GWS) /
        Math.max(1, CALIBRATION_FULL_TRUST_GWS - CALIBRATION_MIN_GWS));

  return {
    gwsGraded: weeks.length,
    firstEvent: weeks[0].eventId,
    lastEvent: weeks[weeks.length - 1].eventId,
    predicted: Math.round(totals.predicted * 10) / 10,
    actual: totals.actual,
    samples: totals.n,
    bias: biasOf(totals),
    positions: positions,
    series: series.slice(-10),
    trust: Math.round(trust * 100) / 100,
    applied: trust > 0
  };
}

/** Cached calibration — a finished gameweek's grade never changes. */
function loadCalibration_() {
  if (CALIBRATION_ !== null) return CALIBRATION_;
  var cached = safeCall_(function () { return CacheService.getScriptCache().get(CALIBRATION_CACHE_KEY); });
  var parsed = cached ? safeCall_(function () { return JSON.parse(cached); }) : null;
  if (parsed) { CALIBRATION_ = parsed; return CALIBRATION_; }

  var built = safeCall_(function () { return buildCalibration_(); }) || false;
  CALIBRATION_ = built;
  if (built) {
    safeCall_(function () {
      CacheService.getScriptCache().put(CALIBRATION_CACHE_KEY, JSON.stringify(built), CALIBRATION_CACHE_TTL);
    });
  }
  return CALIBRATION_;
}

/**
 * The multiplier to apply to one position's projections.
 *
 * Shrunk toward 1 by how much evidence there is, then clamped. Both matter:
 * the shrink stops three unusual gameweeks from rewriting the model, and the
 * clamp stops any amount of evidence from turning a projection into something
 * unrecognisable — if a position is really 40% out, that is a modelling bug to
 * find, not a coefficient to paper over.
 */
function calibrationFactorFor_(elementType) {
  var cal = loadCalibration_();
  if (!cal || !cal.applied) return 1;
  var row = cal.positions && cal.positions[elementType];
  // Fall back to the overall bias when a position has too little of its own.
  var bias = (row && row.samples >= CALIBRATION_MIN_SAMPLES && row.bias) ? row.bias : cal.bias;
  if (!bias || !isFinite(bias)) return 1;

  var shrunk = 1 + (bias - 1) * cal.trust;
  return Math.max(1 - CALIBRATION_CLAMP, Math.min(1 + CALIBRATION_CLAMP, shrunk));
}

/* ===================== EXPECTED POINTS (xP) =====================
 *
 * playerScore_ above is a dimensionless ranking number: useful for "who is
 * better", useless for "is this worth a -4". Every decision the app makes —
 * transfer or hold, captain, start or bench — is really a points question,
 * so those now run on this model instead, which returns actual expected FPL
 * points per gameweek.
 *
 * Making decisions points-denominated is what lets the app say things it
 * previously couldn't: that a transfer gains 2.1 points over six gameweeks
 * and therefore is NOT worth a 4-point hit; that the second captain option
 * is 0.3 points behind the first and so the call is close to a coin flip;
 * that a benched player out-projects a starter by 1.8 points this week.
 *
 * Base rate blends three FPL-supplied estimates of the same thing:
 *   ep_next          the game's own next-gameweek projection (fixture- and
 *                    minutes-aware already, which is why the fixture
 *                    adjustment below is only half-applied to gameweek 1)
 *   form             last ~30 days, points per match
 *   points_per_game  season average, the most stable of the three
 *
 * Then per gameweek: fixture difficulty and home/away for THAT gameweek's
 * actual fixture (not a six-week average), doubled for a double gameweek
 * and zeroed for a blank, times availability.
 */
var XP_FIXTURE_SWING = 0.10;  // per FDR step away from 3 — default when the position is unknown
var XP_HOME_EDGE = 0.02;      // home ~2% more, away ~2% less (measured ~±2% over GW1-5; was ±6%)
/* Per-position FDR swing, and whether the first gameweek of the horizon is
 * damped. Measured on GW1-5 of 2026-27 (each player's points in a match
 * against his own average in his other matches, 60+ minutes): an FDR-2
 * fixture was worth ~1.2x to attackers and ~1.5x to defenders, an FDR-4
 * ~0.87x and ~0.71x — against the flat ±10% per step assumed here, halved
 * again for the coming gameweek. The halving dated from when ep_next was in
 * the blend and was taken to price the next fixture already; it no longer is.
 * Values are set by the backtest's leave-one-gameweek-out search, not by
 * the raw measurement, which five weeks cannot pin down on its own. */
/* Leave-one-gameweek-out over GW2-5 picked no damping, a 2% home edge,
 * 0.3 for defenders and 0.15-0.2 for attackers in every held-out week;
 * MAE 1.920 -> 1.892, within-position rank correlation 0.441 -> 0.471. The
 * conservative end of that plateau is used: five weeks is not much. */
var XP_FIXTURE_SWING_ATT = 0.15;  // MID, FWD
var XP_FIXTURE_SWING_DEF = 0.25;  // GKP, DEF — clean sheets swing far harder than returns
var XP_FIRST_GW_DAMP = 1;         // the coming fixture counts in full
/* `ep_next` is NOT in the blend. Measured on the live API before GW6 of
 * 2026-27, it equalled `form` exactly for 354 of 355 fit players, and was
 * form × chance-of-playing for the doubts — FPL's "projection" is the
 * rolling average restated. Weighting it at half made the base rate ~75%
 * form, and using it as the shrinkage prior (below) meant form was shrunk
 * toward itself: no regression at all. That is how a £6.2m defender on a
 * five-match run of 11.0 projected 62 points over six gameweeks, and a
 * single defensive swap read +41.2. */
var XP_BLEND = { form: 0.6, ppg: 0.4 };

/** Points-per-appearance base rate, before any fixture or availability adjustment. */
/* Form is one number standing for very different amounts of evidence.
 *
 * `form` is points per match over a rolling 30 days and `points_per_game` is
 * points per match over the season so far. In October both are averages over
 * a decent run of matches. After GW1 they are the SAME SINGLE MATCH, and the
 * model was reading them as if they were rates: a defender who returned 14 in
 * the opening weekend came out with a base rate near 8.5 a week, held it for
 * every gameweek of the horizon, and arrived at the dashboard as a 51-point
 * six-week projection for a £4.5m player. Multiply that across a rebuilt
 * squad and the Wildcard appears to be worth hundreds of points, which is how
 * a chip valuation ends up recommending itself in week two.
 *
 * The fix is the standard one: treat the observation as a likelihood, not a
 * rate, and shrink it toward a prior in proportion to how much of it there
 * is. One match barely moves the prior; ten matches largely replace it.
 *
 * The prior is the positional rate scaled by price (pricedPositionPrior_).
 * It used to be `ep_next` wherever that existed, on the reading that it was
 * FPL's own independent per-player estimate. It is not: it is `form` (see
 * XP_BLEND), so the observation was being shrunk toward itself. The priced
 * prior is the estimate the backtest validated — over GW2-5 it was within 4%
 * of actual points overall and beat every simple baseline.
 */
var XP_PRIOR_MATCHES = 5;        // pseudo-matches of prior; ~5 real matches to halve its pull
var XP_FORM_WINDOW_MATCHES = 4;  // most matches a 30-day form figure can average over
var XP_POSITION_PRIOR = { 1: 3.0, 2: 3.1, 3: 3.3, 4: 3.5 }; // pts/match for a MEDIAN-PRICED starter
var XP_POSITION_PRIOR_DEFAULT = 3.2;

/* The fallback prior has to know who the player is.
 *
 * `ep_next` is the prior wherever it exists, and it is per-player, so it
 * carries quality. But it reads 0 for the entire pool for the first game or
 * two of a season — which is exactly the window the shrinkage matters most —
 * and the fallback was a flat positional constant. That made a £15.5m striker
 * and a £4.5m bench forward share a baseline, so once the shrinkage pulled
 * everyone's single match toward it, the whole board collapsed to one number:
 * Haaland projecting 3.4 a week, every transfer margin inside the noise, and
 * the genuinely good early pick no longer distinguishable from anyone else.
 * Fixing over-confidence by destroying the signal is not a fix.
 *
 * Price is the quality signal that survives the reset. FPL prices are set
 * from last season's output and expected role, they are available from the
 * first day, and they are the only per-player estimate in bootstrap-static
 * that a new season does not wipe. So the positional rate is scaled by how a
 * player is priced against the median of players anyone would actually pick
 * at his position — sub-linearly, because points do not rise as fast as price
 * at the top end, which is the whole reason premiums are a real decision
 * rather than an automatic one.
 */
var XP_PRICE_ELASTICITY = 0.9;
var XP_PRICE_PRIOR_MIN = 0.45; // never price a player below this share of the positional rate
var XP_PRICE_PRIOR_MAX = 2.4;  // nor above this, whatever the price tag says
var PRICE_NORM_ = null;        // { elementType: referencePriceTenths }, per request

/**
 * Reference price per position: the median among players with real ownership.
 *
 * Taking the median over the WHOLE pool would anchor on £4.0m bench fodder,
 * of which every position has dozens, and rate every actual pick as a
 * premium. Ownership is the cheapest available filter for "a player somebody
 * would really field".
 */
function loadPriceNorms_(bootstrap) {
  var byPos = {};
  (bootstrap && bootstrap.elements || []).forEach(function (el) {
    if ((parseFloat(el.selected_by_percent) || 0) < 1) return;
    (byPos[el.element_type] = byPos[el.element_type] || []).push(el.now_cost);
  });
  var norms = {};
  Object.keys(byPos).forEach(function (pos) {
    var list = byPos[pos].sort(function (a, b) { return a - b; });
    if (list.length) norms[pos] = list[Math.floor(list.length / 2)];
  });
  return norms;
}

/** The positional rate, scaled by how this player is priced against his peers. */
function pricedPositionPrior_(el) {
  var base = XP_POSITION_PRIOR[el.element_type] || XP_POSITION_PRIOR_DEFAULT;
  var ref = PRICE_NORM_ && PRICE_NORM_[el.element_type];
  var cost = el.now_cost;
  if (!ref || !cost) return base; // no price data — degrade to the flat rate
  var ratio = Math.pow(cost / ref, XP_PRICE_ELASTICITY);
  return base * Math.max(XP_PRICE_PRIOR_MIN, Math.min(XP_PRICE_PRIOR_MAX, ratio));
}

/**
 * Shrink an observed per-match rate toward a prior by how many matches back
 * it. With no matches the prior stands alone; the weight on the observation
 * rises as matches accumulate and never quite reaches 1.
 */
function shrinkRate_(observed, matches, prior) {
  var n = Math.max(0, matches || 0);
  if (!n) return prior;
  var weight = n / (n + XP_PRIOR_MATCHES);
  return prior + (observed - prior) * weight;
}

/* A rate is not a forecast for every week between now and October.
 *
 * Shrinking the observation fixes how far the estimate moves off the prior.
 * It does not fix the second half of the problem, which is that the estimate
 * was then applied UNCHANGED to every gameweek of the horizon — a player's
 * week-six number used the identical base rate as his week-one number, so a
 * hot streak was projected to persist for six weeks at full strength and the
 * error compounded linearly across the whole window.
 *
 * That is wrong on its own terms. `form` is explicitly a rolling 30-day
 * average; whatever it says about next Saturday, it says much less about a
 * match six weeks out, by which time the run has ended, the role has moved,
 * or the fixtures have turned. So the distance between the observation and
 * the prior decays across the horizon: near gameweeks keep the edge the
 * evidence supports, far ones settle back toward the baseline.
 *
 * The decay only bites when the two disagree. A player whose form matches his
 * baseline is unaffected at any distance — his week-six number equals his
 * week-one number, because there is nothing to regress. It is only the freak
 * run that fades, which is the behaviour wanted.
 */
var XP_FORM_HALF_LIFE_GWS = 4; // gameweeks for a form edge to lose half its weight

/** How much of the gap between observation and prior survives to gameweek `idx`. */
function horizonDecay_(idx) {
  return Math.pow(0.5, Math.max(0, idx) / XP_FORM_HALF_LIFE_GWS);
}

/**
 * The blended base rate AND the prior it was shrunk toward, so a caller can
 * regress it back across the horizon. `prior === base` means there is nothing
 * to decay (preseason, or a player performing exactly at his baseline).
 */
function xpBaseCurve_(el) {
  var epNext = parseFloat(el.ep_next) || 0;
  var rawForm = parseFloat(el.form) || 0;
  var rawPpg = parseFloat(el.points_per_game) || 0;
  /* STARTED, not finished. A gameweek in progress has produced real
   * current-season form and points-per-game — one match of them — and
   * counting only finished gameweeks read that as preseason and handed back
   * the raw rate unshrunk, which is how a 15-point opening weekend was still
   * projecting 93.0 over six gameweeks with this fix deployed. */
  var gws = SEASON_CONTEXT_ ? (SEASON_CONTEXT_.startedGws || 0) : 0;

  // True preseason — not one ball kicked. ep_next and form read 0 for the
  // entire pool, and ppg still carries LAST season's rate: an average over a
  // full season, which needs no shrinking and no decay, because it is a
  // baseline rather than a streak.
  if (!gws || (epNext <= 0 && rawForm <= 0)) return { base: rawPpg, prior: rawPpg };

  // Never ep_next — it is form restated, and a prior equal to the
  // observation shrinks nothing. See XP_BLEND.
  var prior = pricedPositionPrior_(el);
  // Form averages a rolling window, so it can never rest on more matches than
  // the season has played nor more than the window holds.
  var form = shrinkRate_(rawForm, Math.min(gws, XP_FORM_WINDOW_MATCHES), prior);
  var ppg = shrinkRate_(rawPpg, gws, prior);

  var base = (form * XP_BLEND.form) + (ppg * XP_BLEND.ppg);

  return { base: base, prior: prior };
}

/** The base rate for the next gameweek. Kept as its own name because that is
 *  what most callers want; the horizon shape lives in xpBaseCurve_. */
function xpBaseRate_(el) {
  return xpBaseCurve_(el).base;
}

/* Fixture difficulty is not one fact.
 *
 * FDR is a single number applied identically to every position, and a fixture
 * does not work that way: away at a side with a lethal attack and a leaky
 * defence is a good afternoon for your forwards and a bad one for your
 * defenders, in the same ninety minutes. Collapsing that into one multiplier
 * loses the half of it that matters most for the cheap defenders the transfer
 * engine likes to recommend.
 *
 * The API ships the four numbers needed to split it — each team's attacking
 * and defensive strength, home and away — and this app was already paying to
 * cache them and reading them nowhere. So:
 *
 *   attackers (MID, FWD)   scale on the opponent's DEFENSIVE strength
 *   defenders and keepers  scale on the opponent's ATTACKING strength
 *
 * normalised against the league average so the adjustment is relative, and
 * blended with FDR rather than replacing it — FDR encodes bookmaker-ish
 * judgement that the raw strength numbers do not, and the two disagree often
 * enough that trusting either alone is worse than trusting both.
 */
var XP_STRENGTH_BLEND = 0.5;   // how much of the fixture adjustment comes from strength rather than FDR
var XP_STRENGTH_SWING = 0.16;  // full-scale swing when an opponent is at the league extreme
var TEAM_STRENGTH_NORM_ = null; // { attackHome, attackAway, defenceHome, defenceAway } league means

/** League-average strengths, computed once per request from bootstrap.teams. */
function loadTeamStrengthNorms_(bootstrap) {
  var teams = (bootstrap && bootstrap.teams) || [];
  var sums = { ah: 0, aa: 0, dh: 0, da: 0 }, n = 0;
  teams.forEach(function (t) {
    if (t.strength_attack_home == null || t.strength_defence_home == null) return;
    sums.ah += t.strength_attack_home; sums.aa += t.strength_attack_away;
    sums.dh += t.strength_defence_home; sums.da += t.strength_defence_away;
    n++;
  });
  if (!n) return null;
  return { attackHome: sums.ah / n, attackAway: sums.aa / n, defenceHome: sums.dh / n, defenceAway: sums.da / n, teams: n };
}

/**
 * How much harder or easier this fixture is for THIS position than FDR alone
 * says. Returns 1 when the data is missing, so every caller degrades to the
 * previous behaviour rather than to a wrong number.
 */
function positionStrengthFactor_(fixture, elementType) {
  var norms = TEAM_STRENGTH_NORM_;
  var opp = fixture && fixture.opponentTeam;
  if (!norms || !opp) return 1;

  // The opponent's relevant strength is the one for the ground THEY are on,
  // which is the opposite of the player's own home/away.
  var oppAtHome = !fixture.home;
  var isAttacker = elementType === 3 || elementType === 4;

  var value, mean;
  if (isAttacker) {
    value = oppAtHome ? opp.strength_defence_home : opp.strength_defence_away;
    mean = oppAtHome ? norms.defenceHome : norms.defenceAway;
  } else {
    value = oppAtHome ? opp.strength_attack_home : opp.strength_attack_away;
    mean = oppAtHome ? norms.attackHome : norms.attackAway;
  }
  if (value == null || !mean) return 1;

  // A stronger opponent (in the dimension that hurts this position) is worse:
  // ratio above 1 means tougher, so the factor moves below 1.
  var ratio = value / mean;
  return 1 - (ratio - 1) * (XP_STRENGTH_SWING / 0.25);
}

/**
 * Fixture multiplier for one specific fixture, not a six-week average.
 *
 * `elementType` is optional: callers that do not have it (or fixtures with no
 * opponent recorded) get the original FDR-only behaviour.
 */
function fixtureMultiplierFor_(fixture, dampen, elementType) {
  var damp = dampen ? XP_FIRST_GW_DAMP : 1;
  var perPos = elementType === 3 || elementType === 4 ? XP_FIXTURE_SWING_ATT
    : (elementType === 1 || elementType === 2 ? XP_FIXTURE_SWING_DEF : XP_FIXTURE_SWING);
  var swing = perPos * damp;
  var edge = XP_HOME_EDGE * damp;
  var diff = fixture.difficulty || 3;

  var fdrPart = (3 - diff) * swing;
  var base = 1 + fdrPart + (fixture.home ? edge : -edge);
  if (!elementType) return base;

  var strength = positionStrengthFactor_(fixture, elementType);
  if (strength === 1) return base;

  // Blend rather than replace: the FDR half keeps the judgement baked into
  // the official difficulty, the strength half adds the position split it
  // cannot express. Both parts are scaled to a comparable swing before
  // weighting, so XP_STRENGTH_BLEND means what it says — at 0.5 neither
  // source dominates.
  var strengthPart = (strength - 1) * damp;
  return 1 + fdrPart * (1 - XP_STRENGTH_BLEND) + strengthPart * XP_STRENGTH_BLEND +
    (fixture.home ? edge : -edge);
}

/**
 * Expected points for one player across the lookahead window.
 *
 * Returns { next, horizon, perGw: [...], base, availability, starter }.
 * `next` is the number to captain on; `horizon` is the number to weigh a
 * transfer (and a 4-point hit) against.
 *
 * Availability is relaxed for later gameweeks — a player who is a 25% doubt
 * this week is not a 25% doubt in five weeks' time — so a short-term injury
 * doesn't permanently sink a good player in the transfer maths. That
 * recovery assumption is linear and deliberately conservative; it never
 * exceeds full fitness.
 */
function projectPointsV1_(el, fixtureEase) {
  var fe = fixtureEase[el.team];
  var curve = xpBaseCurve_(el);
  var availability = availabilityFactor_(el);
  var starter = starterFactor_(el);
  var eventIds = fe ? fe.eventIds : [];

  // Learned from this app's own graded history — 1 until there is enough of
  // it. See the CALIBRATION section above.
  var calibration = calibrationFactorFor_(el.element_type);

  var perGw = eventIds.map(function (evId, idx) {
    var fixtures = (fe.fixturesByEvent && fe.fixturesByEvent[evId]) || [];
    var recovered = idx === 0 ? availability : Math.min(1, availability + 0.25 * idx);
    // The rate itself decays toward the prior as the horizon extends — a form
    // edge is evidence about next week, not about six weeks from now.
    var base = curve.prior + (curve.base - curve.prior) * horizonDecay_(idx);
    var raw = 0;
    fixtures.forEach(function (f) {
      raw += base * fixtureMultiplierFor_(f, idx === 0, el.element_type) * recovered * starter;
    });
    var total = raw * calibration;
    return {
      event: evId,
      fixtures: fixtures.length,
      xp: Math.round(total * 100) / 100,
      // Before the calibration correction. This is what the grading loop must
      // learn from: scoring the corrected figure against reality measures the
      // model PLUS last week's correction, and the bias compounds.
      rawXp: Math.round(raw * 100) / 100,
      opponents: fixtures.map(function (f) { return (f.home ? '' : '@') + f.opponentShort; })
    };
  });

  var horizon = perGw.reduce(function (s, g) { return s + g.xp; }, 0);
  return {
    next: perGw.length ? perGw[0].xp : 0,
    rawNext: perGw.length ? perGw[0].rawXp : 0,
    calibration: calibration,
    horizon: Math.round(horizon * 100) / 100,
    perGw: perGw,
    base: Math.round(curve.base * 100) / 100,
    availability: availability,
    starter: starter
  };
}

/* ===================== EXPECTED POINTS v2: THE COMPONENT MODEL =====================
 *
 * v1 (projectPointsV1_) projects POINTS from points: a recent points rate,
 * pulled toward a price-based prior, times a per-FDR fixture nudge. Points
 * are a noisy record of what happened — a 0.4 xG tap-in and a 1.5 xG blank
 * both read as "form" — and they cannot see why a fixture is good: a
 * defender's clean-sheet chance depends on the opponent's attack, a
 * forward's goals on the opponent's defence, and FDR is one number for both.
 *
 * v2 builds each fixture's points from FPL's own scoring rules:
 *
 *   expected goals in THIS match, both ways
 *     λ for     = team attack × (opponent defence ÷ league average) × venue
 *     λ against = opponent attack × (team defence ÷ league average) × venue
 *   the player's slice of it
 *     his xG and xA per 90, shrunk toward a positional prior scaled by price,
 *     scaled by how much more or less the team creates in this match
 *   then the scoring rules
 *     goals 4/5/6, assists 3, clean sheet 4/4/1 if he plays 60 (P = e^-λ),
 *     −1 per two conceded (GK, DEF), +1 per three saves (GK), 2 for reaching
 *     the defensive-contribution threshold (10 for DEF, 12 for MID/FWD),
 *     appearance 2 for 60+ minutes / 1 for fewer, and bonus per 90
 *   times the chance he plays at all.
 *
 * Team rates come from season totals already in bootstrap-static: a club's
 * xG is the sum of its players' expected_goals; its xG against is the sum of
 * its players' expected_goals_conceded over their minutes — each player
 * accumulates the team's xGA while he is on the pitch, so the sum is eleven
 * times the team's xGA, over eleven times the team's minutes. Both are shrunk toward the
 * league average by V2_TEAM_PRIOR_MATCHES.
 *
 * Which model the app uses is XP_MODEL, with XP_V2_WEIGHT for a blend.
 */
/* A 50% v2 blend, by the manager's choice to lean on underlying numbers.
 * On GW2-5 it ranked players best of any weight (0.485 within-position vs
 * v1's 0.471) and delivered most from its top-10 picks (4.82 vs 4.72), at a
 * slightly higher MAE (1.909 vs 1.892). 75% was briefly live and was worse
 * than 50% on all three. The held-out choice itself picked v1 or 25%; the
 * Model eval report scores every weight each run — revisit from GW6 on. */
var XP_MODEL = 'blend';       // 'v1' | 'v2' | 'blend'
var XP_V2_WEIGHT = 0.5;       // v2's share when XP_MODEL is 'blend'

var V2_TEAM_PRIOR_MATCHES = 4;     // pseudo-matches of league average in each club's rates
var V2_LEAGUE_XG_DEFAULT = 1.35;   // xG per team per match before any is known
var V2_HOME = 0.08;                // home side creates ~8% more, away ~8% less
var V2_PRIOR_MINUTES = 450;        // pseudo-minutes of positional prior in each per-90 rate
var V2_PRICE_POWER = 1;            // how hard price scales the attacking priors (1 = as v1's prior)
var V2_PRIOR = {
  xg90:    { 1: 0.00, 2: 0.05, 3: 0.14, 4: 0.33 },
  xa90:    { 1: 0.01, 2: 0.06, 3: 0.12, 4: 0.11 },
  dc90:    { 1: 0.0,  2: 8.0,  3: 6.5,  4: 3.5 },
  bonus90: { 1: 0.25, 2: 0.22, 3: 0.25, 4: 0.30 },
  saves90: { 1: 2.6,  2: 0, 3: 0, 4: 0 }
};
var V2_GOAL_PTS = { 1: 6, 2: 6, 3: 5, 4: 4 };
var V2_CS_PTS = { 1: 4, 2: 4, 3: 1, 4: 0 };
var V2_DC_THRESHOLD = { 2: 10, 3: 12, 4: 12 };
var V2_DC_PTS = 2;
/* Bonus follows returns. Least squares over 2022-23 to 2025-26 (players
 * with 900+ minutes, ~1,300 player-seasons): bonus points per goal, per
 * assist, per clean sheet and per 90 by position. A flat bonus-per-90 gave
 * premium forwards 3.7x less bonus than they took on GW2-5 — bonus goes to
 * the players who score, which is who premiums are. */
var V2_BONUS = {
  1: { base90: 0.19, goal: 0,    assist: 0.13, cs: 0.33 },
  2: { base90: 0,    goal: 1.09, assist: 0.77, cs: 0.62 },
  3: { base90: 0.01, goal: 0.96, assist: 0.68, cs: 0.10 },
  4: { base90: 0.10, goal: 1.17, assist: 0.29, cs: 0 }
};
/* How far a player's match-to-match defensive actions spread around his own
 * mean. A Poisson tail under-read midfielders reaching 12 actions 2.2x on
 * GW2-5: the real counts are over-dispersed, and 12 sits deep in the tail. */
var V2_DC_DISPERSION = 3;
/* Defensive actions pile up fast (5-10 a match), so a player's own rate is
 * reliable after a match or two — unlike goals. Measured on 2025-26 (first
 * five gameweeks predicting the rest, 188 players): 135 pseudo-minutes of
 * positional prior forecast best; the shared 450 over-pulled attacking
 * full-backs toward centre-back numbers. The same season set r = 3: it
 * predicted 911 threshold hits against 911 actual (Poisson: 715). */
var V2_DC_PRIOR_MINUTES = 135;
var V2_BONUS_MODEL = 'hybrid';    // 'hybrid' | 'returns' (expected goals/assists/CS) | 'flat' (his own bonus per 90)
var V2_PEN_XG_PER_MATCH = 0.08;    // a club's penalty xG per match, credited to the first-choice taker's prior
var V2_START_PRIOR_MATCHES = 0.5; // pseudo-matches of 50/50 in the start share; 2 under-read regulars
var V2_P60_GIVEN_START = 0.95;     // starters who reach 60 minutes
/* Goals cluster: more 0-0s and more blow-outs than a Poisson on xG allows,
 * so e^-λ under-reads clean sheets (GW2-5: by 1.6-1.9x). A negative
 * binomial with dispersion r keeps the mean and fattens the zero:
 * P(0) = (1 + λ/r)^-r. Infinity recovers the Poisson. */
var V2_GOAL_DISPERSION = 2.5;
/* FPL assists are not xA: rebounds, won penalties and deflections count,
 * none of which xA measures. GW2-5 ran 1.33-1.45x the xA-based figure. */
var V2_ASSISTS_PER_XA = 1.35;
/* Residual per-component correction, actual ÷ projected. Fitted by the
 * backtest on training gameweeks only (see fitComponentScales in
 * eval/backtest.cjs); 1 means none. */
var V2_COMPONENT_SCALE = { appearance: 1, goals: 1, assists: 1, cleanSheet: 1, conceded: 1, saves: 1, defensive: 1, bonus: 1 };
var V2_MINUTES_PER_START = 85;
var V2_MINUTES_PER_SUB = 22;

var TEAM_RATES_ = null;            // per request: { ready, league, byTeam: { id: { att, def, matches } } }
var V2_MEMO_ = null;               // { fe, map } — projections are requested many times per request

/** Club attack/defence rates from season totals. See the section comment. */
function loadTeamRates_(bootstrap, fixtures) {
  var matches = {};
  (fixtures || []).forEach(function (f) {
    if (!f.finished) return;
    matches[f.team_h] = (matches[f.team_h] || 0) + 1;
    matches[f.team_a] = (matches[f.team_a] || 0) + 1;
  });
  var sums = {};
  var haveStats = false;
  bootstrap.elements.forEach(function (el) {
    if (el.expected_goals == null) return;
    haveStats = true;
    var t = sums[el.team] || (sums[el.team] = { xg: 0, xgc: 0, mins: 0 });
    t.xg += parseFloat(el.expected_goals) || 0;
    t.xgc += parseFloat(el.expected_goals_conceded) || 0;
    t.mins += el.minutes || 0;
  });
  var raw = {};
  var forSum = 0, n = 0;
  bootstrap.teams.forEach(function (tm) {
    var m = matches[tm.id] || 0, sm = sums[tm.id];
    if (!m || !sm || !sm.mins) { raw[tm.id] = { m: 0 }; return; }
    // Σ xGC over players = 11 × team xGA, and Σ minutes = 11 × 90 × matches,
    // so xGA per match = Σ xGC / Σ minutes × 90.
    raw[tm.id] = { m: m, xgFor: sm.xg / m, xgAgainst: sm.xgc / sm.mins * 90 };
    forSum += raw[tm.id].xgFor; n++;
  });
  var league = n ? forSum / n : V2_LEAGUE_XG_DEFAULT;
  var K = V2_TEAM_PRIOR_MATCHES;
  var byTeam = {};
  bootstrap.teams.forEach(function (tm) {
    var r = raw[tm.id];
    byTeam[tm.id] = r.m
      ? { att: (r.xgFor * r.m + league * K) / (r.m + K), def: (r.xgAgainst * r.m + league * K) / (r.m + K), matches: r.m }
      : { att: league, def: league, matches: 0 };
  });
  V2_MEMO_ = null;
  return { ready: haveStats && n > 0, league: league, byTeam: byTeam };
}

/** P(conceding none) with goals over-dispersed around xG — see V2_GOAL_DISPERSION. */
function cleanSheetChance_(lambda) {
  var r = V2_GOAL_DISPERSION;
  if (!(lambda > 0)) return 1;
  if (!isFinite(r) || r <= 0) return Math.exp(-lambda);
  return Math.pow(1 + lambda / r, -r);
}

/** P(X >= k) for X negative binomial with mean mu and dispersion r (Poisson as r grows). */
function negBinTail_(mu, r, k) {
  if (k <= 0) return 1;
  if (!(mu > 0)) return 0;
  if (!isFinite(r) || r <= 0) return poissonTail_(mu, k);
  var p = r / (r + mu);            // success probability
  var term = Math.pow(p, r), cdf = term;
  for (var i = 1; i < k; i++) { term *= (i - 1 + r) / i * (1 - p); cdf += term; }
  return Math.max(0, 1 - cdf);
}

/** P(X >= k) for X ~ Poisson(lambda). */
function poissonTail_(lambda, k) {
  if (k <= 0) return 1;
  if (!(lambda > 0)) return 0;
  var term = Math.exp(-lambda), cdf = term;
  for (var i = 1; i < k; i++) { term *= lambda / i; cdf += term; }
  return Math.max(0, 1 - cdf);
}

/** E[floor(X / d)] for X ~ Poisson(lambda): "one point per d" rules. */
function poissonFloorMean_(lambda, d) {
  if (!(lambda > 0)) return 0;
  // E[floor(X/d)] = Σ_{j>=1} P(X >= j·d); the tail vanishes quickly.
  var total = 0;
  for (var j = 1; j <= 12; j++) {
    var p = poissonTail_(lambda, j * d);
    if (p < 1e-6) break;
    total += p;
  }
  return total;
}

/** A season total as a per-90 rate, shrunk toward `prior` by V2_PRIOR_MINUTES. */
function shrunkPer90_(total, minutes, prior) {
  var pm = V2_PRIOR_MINUTES;
  return ((total || 0) + prior * pm / 90) / (((minutes || 0) + pm) / 90);
}

/**
 * How much he plays: P(starts and reaches 60), P(appears but short of 60),
 * and the expected share of 90 minutes. From his starts and minutes against
 * the club's matches, shrunk toward a coin flip so two games do not read as
 * certainty either way.
 */
function minutesModelV2_(el, teamMatches) {
  var M = teamMatches || 0;
  var starts = el.starts != null ? el.starts : 0;
  var mins = el.minutes || 0;
  var priorStart = mins > 0 ? 0.5 : 0.05;
  var K = V2_START_PRIOR_MATCHES;
  var startShare = (starts + priorStart * K) / (M + K);
  // Minutes beyond 90 per start came from the bench. (85 a start is the
  // average including substitutions; using it here credited every
  // full-90 regular with phantom sub appearances.)
  var subMinutes = Math.max(0, mins - starts * 90);
  var subShare = M ? Math.min(1 - startShare, subMinutes / (V2_MINUTES_PER_SUB * M)) : 0;
  return {
    p60: startShare * V2_P60_GIVEN_START,
    pShort: startShare * (1 - V2_P60_GIVEN_START) + subShare,
    minutesFraction: (startShare * V2_MINUTES_PER_START + subShare * V2_MINUTES_PER_SUB) / 90
  };
}

/** One player's expected points in one fixture, by scoring component. */
function fixturePointsV2_(el, fixture, rates, mm, perGame) {
  var pos = el.element_type;
  var league = rates.league || V2_LEAGUE_XG_DEFAULT;
  var mine = rates.byTeam[el.team], opp = rates.byTeam[fixture.opponent];
  if (!mine || !opp) return null;
  var venue = fixture.home ? 1 + V2_HOME : 1 - V2_HOME;
  var lamFor = mine.att * (opp.def / league) * venue;
  var lamAg = opp.att * (mine.def / league) * (fixture.home ? 1 - V2_HOME : 1 + V2_HOME);
  // His share scales with how much more (or less) the club creates here than usual.
  var attackScale = mine.att > 0 ? lamFor / mine.att : 1;
  var mf = mm.minutesFraction;

  var parts = {
    appearance: 2 * mm.p60 + 1 * mm.pShort,
    goals: perGame.xg90 * mf * attackScale * V2_GOAL_PTS[pos],
    assists: perGame.xa90 * mf * attackScale * 3 * V2_ASSISTS_PER_XA,
    cleanSheet: (V2_CS_PTS[pos] || 0) * mm.p60 * cleanSheetChance_(lamAg),
    conceded: (pos === 1 || pos === 2) ? -mm.p60 * poissonFloorMean_(lamAg, 2) : 0,
    saves: pos === 1 ? mm.p60 * poissonFloorMean_(perGame.saves90 * (lamAg / league), 3) : 0,
    defensive: V2_DC_THRESHOLD[pos] ? V2_DC_PTS * mm.p60 * negBinTail_(perGame.dc90, V2_DC_DISPERSION, V2_DC_THRESHOLD[pos]) : 0,
    bonus: 0
  };
  if (V2_BONUS_MODEL === 'flat') {
    parts.bonus = perGame.bonus90 * mf;
  } else if (V2_BONUS_MODEL === 'hybrid') {
    // His own bonus record, shrunk toward what his returns would earn — the
    // structural rate is the prior, his history the evidence — then scaled
    // by how much more (or less) this fixture gives him to score from.
    parts.bonus = perGame.bonusHybrid90 * mf * (0.5 + 0.5 * attackScale);
  } else {
  var bc = V2_BONUS[pos];
  var expGoals = perGame.xg90 * mf * attackScale;
  var expAssists = perGame.xa90 * mf * attackScale * V2_ASSISTS_PER_XA;
  parts.bonus = bc.base90 * mf + bc.goal * expGoals + bc.assist * expAssists +
    bc.cs * mm.p60 * cleanSheetChance_(lamAg);
  }
  var total = 0;
  Object.keys(parts).forEach(function (k) {
    var sc = V2_COMPONENT_SCALE[k];
    if (sc != null) parts[k] *= sc;
    total += parts[k];
  });
  return { total: total, parts: parts, lamFor: lamFor, lamAg: lamAg };
}

/** The per-90 rates v2 reads, each shrunk toward a price-scaled positional prior. */
function perGameRatesV2_(el) {
  var pos = el.element_type;
  var mins = el.minutes || 0;
  // Price says who the player is before the minutes do — the same signal the
  // backtest found v1 under-using. Bounded as pricedPositionPrior_ is.
  var priceScale = Math.pow(pricedPositionPrior_(el) / (XP_POSITION_PRIOR[pos] || XP_POSITION_PRIOR_DEFAULT), V2_PRICE_POWER);
  var penTaker = el.penalties_order === 1;
  var out = {
    xg90: shrunkPer90_(parseFloat(el.expected_goals), mins,
      V2_PRIOR.xg90[pos] * priceScale + (penTaker ? V2_PEN_XG_PER_MATCH : 0)),
    xa90: shrunkPer90_(parseFloat(el.expected_assists), mins, V2_PRIOR.xa90[pos] * priceScale),
    // Missing (not zero) means the source does not carry it: use the prior.
    dc90: el.defensive_contribution == null ? V2_PRIOR.dc90[pos]
      : (el.defensive_contribution + V2_PRIOR.dc90[pos] * V2_DC_PRIOR_MINUTES / 90) / ((mins + V2_DC_PRIOR_MINUTES) / 90),
    bonus90: shrunkPer90_(el.bonus, mins, V2_PRIOR.bonus90[pos]),
    saves90: pos === 1 ? shrunkPer90_(el.saves, mins, V2_PRIOR.saves90[1]) : 0,
    penTaker: penTaker
  };
  // The bonus his expected returns would earn per 90 at an average fixture
  // (league-average clean-sheet chance), used as the prior for his own record.
  var bc = V2_BONUS[pos];
  var avgCs = cleanSheetChance_(TEAM_RATES_ && TEAM_RATES_.league ? TEAM_RATES_.league : V2_LEAGUE_XG_DEFAULT);
  var structural = bc.base90 + bc.goal * out.xg90 + bc.assist * out.xa90 * V2_ASSISTS_PER_XA + bc.cs * avgCs;
  out.bonusHybrid90 = shrunkPer90_(el.bonus, mins, structural);
  return out;
}

/** v2 projection, in the same shape projectPointsV1_ returns. */
function projectPointsV2_(el, fixtureEase) {
  var fe = fixtureEase[el.team];
  var rates = TEAM_RATES_;
  var eventIds = fe ? fe.eventIds : [];
  var availability = availabilityFactor_(el);
  var mm = minutesModelV2_(el, rates.byTeam[el.team] ? rates.byTeam[el.team].matches : 0);
  var perGame = perGameRatesV2_(el);
  var calibration = calibrationFactorFor_(el.element_type);
  var nextParts = null;

  var perGw = eventIds.map(function (evId, idx) {
    var fixtures = (fe.fixturesByEvent && fe.fixturesByEvent[evId]) || [];
    var recovered = idx === 0 ? availability : Math.min(1, availability + 0.25 * idx);
    var raw = 0;
    fixtures.forEach(function (f) {
      var fp = fixturePointsV2_(el, f, rates, mm, perGame);
      if (!fp) return;
      raw += fp.total * recovered;
      if (idx === 0 && !nextParts) nextParts = fp;
    });
    var total = raw * calibration;
    return {
      event: evId, fixtures: fixtures.length,
      xp: Math.round(total * 100) / 100,
      rawXp: Math.round(raw * 100) / 100,
      opponents: fixtures.map(function (f) { return (f.home ? '' : '@') + f.opponentShort; })
    };
  });
  var horizon = perGw.reduce(function (s2, g) { return s2 + g.xp; }, 0);
  return {
    next: perGw.length ? perGw[0].xp : 0,
    rawNext: perGw.length ? perGw[0].rawXp : 0,
    calibration: calibration,
    horizon: Math.round(horizon * 100) / 100,
    perGw: perGw,
    base: nextParts ? Math.round(nextParts.total * 100) / 100 : 0,
    availability: availability,
    starter: Math.round(mm.minutesFraction * 100) / 100,
    model: 'v2',
    // The next fixture, broken into the scoring rules — the "why" behind it.
    components: nextParts ? (function () {
      var c = {};
      Object.keys(nextParts.parts).forEach(function (k) { c[k] = Math.round(nextParts.parts[k] * availability * 100) / 100; });
      c.teamXg = Math.round(nextParts.lamFor * 100) / 100;
      c.opponentXg = Math.round(nextParts.lamAg * 100) / 100;
      c.cleanSheetChance = Math.round(cleanSheetChance_(nextParts.lamAg) * 100) / 100;
      c.penaltyTaker = perGame.penTaker;
      return c;
    })() : null
  };
}

/** Whether v2 has what it needs for this player. */
function v2Ready_(el) {
  return !!(TEAM_RATES_ && TEAM_RATES_.ready && el && el.expected_goals != null);
}

/**
 * Expected points for one player across the lookahead window — the single
 * entry point every decision reads. Dispatches on XP_MODEL; anything v2
 * cannot price (no team rates yet, no underlying stats) falls back to v1.
 */
function projectPoints_(el, fixtureEase) {
  if (XP_MODEL === 'v1' || !v2Ready_(el)) return projectPointsV1_(el, fixtureEase);
  if (!V2_MEMO_ || V2_MEMO_.fe !== fixtureEase) V2_MEMO_ = { fe: fixtureEase, map: {} };
  var key = el.id + '|' + el.minutes + '|' + el.status + '|' + el.chance_of_playing_next_round + '|' + el.now_cost +
    '|' + el.form + '|' + XP_MODEL + '|' + XP_V2_WEIGHT;
  if (el.id != null && V2_MEMO_.map[key]) return V2_MEMO_.map[key];

  var v2 = projectPointsV2_(el, fixtureEase);
  var out = v2;
  if (XP_MODEL === 'blend') {
    var v1 = projectPointsV1_(el, fixtureEase);
    var w = XP_V2_WEIGHT;
    var mix = function (a, b) { return Math.round((a * w + b * (1 - w)) * 100) / 100; };
    var perGw = v2.perGw.map(function (g, i) {
      var o = v1.perGw[i] || g;
      return { event: g.event, fixtures: g.fixtures, xp: mix(g.xp, o.xp), rawXp: mix(g.rawXp, o.rawXp), opponents: g.opponents };
    });
    out = {
      next: perGw.length ? perGw[0].xp : 0,
      rawNext: perGw.length ? perGw[0].rawXp : 0,
      calibration: v2.calibration,
      horizon: Math.round(perGw.reduce(function (s2, g) { return s2 + g.xp; }, 0) * 100) / 100,
      perGw: perGw, base: mix(v2.base, v1.base),
      availability: v2.availability, starter: v1.starter, model: 'blend', components: v2.components
    };
  }
  if (el.id != null) V2_MEMO_.map[key] = out;
  return out;
}

/** Plain-language "why" sentence for a single player — the arithmetic underneath the verdict. */
function explainPlayer_(el, fixtureEase) {
  var fe = fixtureEase[el.team];
  var ease = fe ? fe.avgDifficulty : 3;
  var bits = [];

  if (el.status !== 'a') {
    bits.push((STATUS_LABEL[el.status] || 'Flagged') + (el.news ? ' — ' + el.news : '.'));
  }

  var form = parseFloat(el.form) || 0;
  if (form >= 6) bits.push('In strong form (' + el.form + ' pts/match).');
  else if (form <= 2 && el.minutes > 0) bits.push('Form has cooled (' + el.form + ' pts/match).');
  else if (form === 0) {
    // No current-season matches played yet (preseason, or GW1 hasn't finished) —
    // form is meaningless right now. Fall back to last season's numbers, which
    // bootstrap-static still carries in total_points/points_per_game until the
    // new season's first ball is kicked, rather than a content-free "no signal".
    var ppg = parseFloat(el.points_per_game) || 0;
    if (el.total_points > 0 || ppg > 0) {
      bits.push('No current-season matches yet — last season: ' + el.total_points + ' pts (' + ppg + '/match).');
    }
  }

  if (fe) {
    if (ease <= 2.4) bits.push('Kind run of fixtures next (avg difficulty ' + ease + ').');
    else if (ease >= 3.6) bits.push('Tough run of fixtures next (avg difficulty ' + ease + ').');
  }

  var community = communitySignalFor_(el.web_name);
  if (community.videoCount > 0) {
    bits.push('Backed by ' + community.channelCount + ' tracked channel' + (community.channelCount === 1 ? '' : 's') +
      ' across ' + community.videoCount + ' video' + (community.videoCount === 1 ? '' : 's') + ' this week.');
  }

  if (!bits.length) bits.push('Steady — no strong signal either way this week.');
  return bits.join(' ');
}

/**
 * The Player Ratings page's single data source. Runs the exact same
 * playerScore_/valueScore_ arithmetic the rest of the app uses internally
 * for transfer/captain/squad suggestions, but returns the full per-player
 * breakdown (each weighted component, the fixture and availability
 * multipliers) instead of just the final number — so the ratings page can
 * show the arithmetic behind every score rather than a black-box figure.
 */
function getPredictionScores() {
  var bootstrap = getBootstrap_();
  SEASON_CONTEXT_ = loadSeasonContext_(bootstrap);
  PRICE_NORM_ = loadPriceNorms_(bootstrap);
  COMMUNITY_SIGNAL_ = safeCall_(function () { return loadCommunitySignal_(bootstrap); }) || { videos: {}, channels: {} };
  var fixtures = getFixtures_();
  var fixtureEase = buildFixtureEaseMap_(bootstrap, fixtures, LOOKAHEAD_GWS);
  // The same model the dashboard runs — without club rates the v2 half of
  // the blend falls back to v1 and the two pages would disagree.
  TEAM_RATES_ = safeCall_(function () { return loadTeamRates_(bootstrap, fixtures); });

  var teamsById = {};
  bootstrap.teams.forEach(function (t) { teamsById[t.id] = t; });

  // Which of these players the manager already owns. A comparison page that
  // cannot say "you have this one" is doing half the job — every judgement on
  // it ("is this an upgrade?") is relative to the squad. Optional: an
  // unreadable squad (preseason, bad team id) degrades to an empty set rather
  // than failing the whole page.
  var ownedIds = safeCall_(function () {
    var teamId = getTeamId();
    if (!teamId) return null;
    // The squad is only readable for a gameweek whose deadline has gone —
    // asking for an upcoming one 404s. resolveGameweekState_ knows which that
    // is; `is_current || is_next` did not, and could ask for the wrong one.
    var evId = resolveGameweekState_(bootstrap.events).picksEventId;
    if (evId == null) return null;
    var picks = getPicks_(teamId, evId);
    var set = {};
    (picks && picks.picks ? picks.picks : []).forEach(function (p) { set[p.element] = true; });
    return set;
  }) || {};

  var rows = bootstrap.elements
    .filter(function (el) { return el.minutes > 0 || el.total_points > 0 || el.status !== 'a'; })
    .map(function (el) {
      var form = parseFloat(el.form) || 0;
      var ppg = parseFloat(el.points_per_game) || 0;
      var epNext = parseFloat(el.ep_next) || 0;
      var ict = parseFloat(el.ict_index) || 0;
      var xgi = Math.round(xgiPer90_(el) * 100) / 100;
      var fe = fixtureEase[el.team];
      var ease = fe ? fe.weightedDifficulty : 3;
      var fixtureMultiplier = Math.round((1 + (3 - ease) * 0.12) * 1000) / 1000;
      var statusMultiplier = availabilityFactor_(el);
      var starterMultiplier = starterFactor_(el);
      var community = communitySignalFor_(el.web_name);
      var xp = projectPoints_(el, fixtureEase);
      var parts = xpBreakdown_(el, fixtureEase, xp);

      return {
        id: el.id,
        name: el.web_name,
        team: teamsById[el.team] ? teamsById[el.team].short_name : '?',
        teamId: el.team,
        position: POSITION_MAP[el.element_type],
        elementType: el.element_type,
        price: el.now_cost / 10,
        status: el.status,
        statusLabel: STATUS_LABEL[el.status] || 'Flagged',
        nextOpponents: fe ? fe.nextOpponents.slice(0, 3) : [],
        fixtureEase: ease,
        // Raw inputs only, not precomputed per-component contribution objects — this
        // payload goes over google.script.run for every player in the game (600+),
        // and its sandboxed-iframe bridge is dramatically slower to serialize deeply
        // nested objects than flat numbers. The client already has `weights` and
        // recomputes the arithmetic locally when a row is expanded.
        inputs: {
          form: form, epNext: epNext, ppg: ppg, ict: ict, xgi: xgi,
          communityVideos: community.videoCount, communityChannels: community.channelCount
        },
        fixtureMultiplier: fixtureMultiplier,
        statusMultiplier: statusMultiplier,
        starterMultiplier: starterMultiplier,
        ownership: parseFloat(el.selected_by_percent) || 0,
        inSquad: !!ownedIds[el.id],
        // Net transfers this gameweek — the price-change signal, and the
        // clearest read on what the wider game is doing right now.
        netTransfers: (el.transfers_in_event || 0) - (el.transfers_out_event || 0),
        // Expected points, alongside the ranking score — this is the column
        // that answers "how many points is this player actually worth to me
        // next week", which the dimensionless score never could.
        xpNext: xp.next,
        xpHorizon: xp.horizon,
        // Where the xP comes from: both models' figures for the next
        // gameweek and the component model's parts, as a bare array in
        // XP_PARTS_KEYS order — 700 players' worth of repeated key names was
        // ~45% of this payload. The page rebuilds the object on arrival.
        xpParts: XP_PARTS_KEYS.map(function (k) { var v = parts[k]; return v === true ? 1 : (v === false ? 0 : (v == null ? null : v)); }),
        score: playerScore_(el, fixtureEase),
        // Expected points per million over the horizon — NOT the dimensionless
        // score divided by price, which the column header ("Value (pts/£m)")
        // claimed it was. Score is a ranking number; dividing it by price gave
        // a figure whose units were nothing at all, presented as points.
        value: Math.round((xp.horizon / Math.max(0.1, el.now_cost / 10)) * 100) / 100,
        reason: explainPlayer_(el, fixtureEase)
      };
    });

  /*
   * Recommendation tiers, per position — a centre-back and a striker never
   * compete for the same slot.
   *
   * Two things were wrong with the old version. It ranked on `score`, the
   * dimensionless number, while the rest of the app decides on expected
   * points; and it was purely percentile, so the top 15% of every position
   * was "Strong Buy" every single week whether or not anyone was actually
   * worth buying. A tier that is never scarce carries no information — eight
   * of the top nine rows on the live page were Strong Buy.
   *
   * Now a tier needs BOTH a rank and a real gap over the position's median,
   * so in a week where nothing stands out the top tiers legitimately empty
   * out. And a flagged player reads as "Flagged", not "Avoid": Ajayi sat
   * fifth by score carrying a red Avoid pill, which just looks broken. Avoid
   * is reserved for available players who genuinely do not project well.
   */
  var byPosition = {};
  rows.forEach(function (r) { (byPosition[r.elementType] = byPosition[r.elementType] || []).push(r); });
  Object.keys(byPosition).forEach(function (posType) {
    var group = byPosition[posType].slice().sort(function (a, b) { return b.xpHorizon - a.xpHorizon; });
    var n = group.length;
    var available = group.filter(function (r) { return r.status === 'a'; });
    var median = available.length
      ? available[Math.floor(available.length / 2)].xpHorizon
      : 0;

    group.forEach(function (r, idx) {
      var percentile = n > 1 ? idx / (n - 1) : 0; // 0 = best in position, 1 = worst
      r.positionRank = idx + 1;
      r.positionCount = n;
      r.vsPositionMedian = median > 0 ? Math.round((r.xpHorizon / median) * 100) / 100 : null;

      if (r.status !== 'a') {
        r.recommendation = 'Flagged';
      } else if (percentile <= 0.15 && median > 0 && r.xpHorizon >= median * 1.25) {
        r.recommendation = 'Strong Buy';
      } else if (percentile <= 0.4 && median > 0 && r.xpHorizon >= median * 1.05) {
        r.recommendation = 'Consider';
      } else if (percentile <= 0.75) {
        r.recommendation = 'Hold';
      } else {
        r.recommendation = 'Avoid';
      }
    });
  });

  // Default order is expected points over the horizon, not the ranking score —
  // the page's own copy says xP is what the transfer and captain sections
  // decide on, so the table should open in that order rather than one that
  // disagrees with it.
  rows.sort(function (a, b) { return b.xpHorizon - a.xpHorizon; });

  return {
    generatedAt: new Date().toISOString(),
    model: { name: XP_MODEL, v2Weight: XP_MODEL === 'blend' ? XP_V2_WEIGHT : (XP_MODEL === 'v2' ? 1 : 0) },
    xpPartsKeys: XP_PARTS_KEYS,
    weights: {
      form: SCORE_WEIGHTS.form, epNext: SCORE_WEIGHTS.epNext, ppg: SCORE_WEIGHTS.ppg,
      ict: SCORE_WEIGHTS.ict, xgi: SCORE_WEIGHTS.xgi,
      communityVideos: COMMUNITY_VIDEO_WEIGHT, communityChannels: COMMUNITY_CHANNEL_WEIGHT
    },
    horizonGws: LOOKAHEAD_GWS,
    players: rows
  };
}

/**
 * The next-gameweek xP of one player, explained: the points-trend model (v1),
 * the component model (v2) and the blend the app uses, then v2's points by
 * scoring rule and the inputs behind them. Flat numbers only — this goes over
 * google.script.run for every player in the game (see getPredictionScores).
 */
var XP_PARTS_KEYS = ['v1', 'v2', 'blend', 'v1Base', 'v1Fixture', 'v1Start', 'availability',
  'appearance', 'goals', 'assists', 'cleanSheet', 'conceded', 'saves', 'defensive', 'bonus',
  'teamXg', 'opponentXg', 'csChance', 'penaltyTaker', 'xg90', 'xa90', 'dc90', 'dcChance', 'p60'];

function xpBreakdown_(el, fixtureEase, blended) {
  var r2 = function (x) { return x == null || !isFinite(x) ? null : Math.round(x * 100) / 100; };
  var v1 = projectPointsV1_(el, fixtureEase);
  var fe = fixtureEase[el.team];
  var nextFix = fe && fe.eventIds.length ? (fe.fixturesByEvent[fe.eventIds[0]] || [])[0] : null;
  var out = {
    v1: r2(v1.next), blend: r2(blended.next),
    v1Base: r2(v1.base),
    v1Fixture: nextFix ? r2(fixtureMultiplierFor_(nextFix, true, el.element_type)) : null,
    v1Start: v1.starter, availability: r2(v1.availability)
  };
  if (!v2Ready_(el)) return out;
  var v2 = projectPointsV2_(el, fixtureEase);
  var c = v2.components || {};
  var pg = perGameRatesV2_(el);
  var mm = minutesModelV2_(el, TEAM_RATES_.byTeam[el.team] ? TEAM_RATES_.byTeam[el.team].matches : 0);
  out.v2 = r2(v2.next);
  out.appearance = c.appearance; out.goals = c.goals; out.assists = c.assists; out.cleanSheet = c.cleanSheet;
  out.conceded = c.conceded; out.saves = c.saves; out.defensive = c.defensive; out.bonus = c.bonus;
  out.teamXg = c.teamXg; out.opponentXg = c.opponentXg; out.csChance = c.cleanSheetChance; out.penaltyTaker = !!c.penaltyTaker;
  out.xg90 = r2(pg.xg90); out.xa90 = r2(pg.xa90); out.dc90 = r2(pg.dc90);
  out.dcChance = V2_DC_THRESHOLD[el.element_type] ? r2(negBinTail_(pg.dc90, V2_DC_DISPERSION, V2_DC_THRESHOLD[el.element_type])) : null;
  out.p60 = r2(mm.p60);
  return out;
}

/**
 * Client entry point for the Ratings page, in place of calling
 * getPredictionScores() directly over google.script.run — the same fix
 * already applied to the dashboard.
 *
 * This response is by far the largest thing this app sends: ~370KB as a
 * nested object tree for a full 700-player pool, against the ~35KB dashboard
 * payload that was already dropping in transit before it was pre-serialized.
 * A string crosses the bridge as a primitive rather than an object tree, so
 * the marshalling that loses the big ones never runs; the client does one
 * JSON.parse() on arrival.
 */
function getPredictionScoresJson() {
  return JSON.stringify(getPredictionScores());
}

var POSITION_MAP = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

/* ===================== SQUAD BUILDING (existing team) ===================== */

function buildSquad_(bootstrap, picksResp, entry, fixtureEase) {
  var elementsById = {};
  bootstrap.elements.forEach(function (el) { elementsById[el.id] = el; });
  var teamsById = {};
  bootstrap.teams.forEach(function (t) { teamsById[t.id] = t; });

  var players = picksResp.picks.map(function (p) {
    var el = elementsById[p.element];
    return {
      id: el.id,
      name: el.web_name,
      team: teamsById[el.team] ? teamsById[el.team].short_name : '?',
      teamId: el.team,
      position: POSITION_MAP[el.element_type],
      elementType: el.element_type,
      price: el.now_cost / 10,
      // FPL's own sell value, not just now_cost/10 — the two diverge once a
      // player has risen in price, since you only bank half the profit.
      // picksResp always carries this per-pick, so no need to derive it.
      // Guarded: `selling_price` is absent from some picks responses (and any
      // synthetic/fallback squad), and `undefined / 10` is NaN — which used to
      // propagate all the way into the transfer cost line as
      // "Free transfer · £NaNm from bank". Current price is the honest
      // fallback: before any price change the two are identical anyway.
      sellingPrice: isFinite(p.selling_price) ? p.selling_price / 10 : el.now_cost / 10,
      form: el.form,
      totalPoints: el.total_points,
      status: el.status,
      news: el.news,
      isCaptain: p.is_captain,
      isVice: p.is_vice_captain,
      multiplier: p.multiplier,
      isStarting: p.position <= 11,
      pickPosition: p.position,
      reason: (function () {
        var why = explainPlayer_(el, fixtureEase);
        var rot = rotationFor_(el);
        return rot && (rot.risk === 'rotation' || rot.risk === 'benched') ? why + ' ' + rot.text : why;
      })(),
      rotation: rotationFor_(el),
      priceChangeEvent: (el.cost_change_event || 0) / 10,
      // Carried through so the captain, lineup and ownership sections can
      // work off `squad` alone rather than each re-joining back to
      // bootstrap.elements with its own copy of the lookup.
      selectedBy: parseFloat(el.selected_by_percent) || 0,
      penaltiesOrder: el.penalties_order || null,
      chanceOfPlaying: el.chance_of_playing_next_round,
      xgi90: Math.round(xgiPer90_(el) * 100) / 100,
      minutesShare: minutesShare_(el),
      xp: projectPoints_(el, fixtureEase)
    };
  });

  var bank = entry && entry.last_deadline_bank != null ? entry.last_deadline_bank / 10 : null;
  var teamValue = entry && entry.last_deadline_value != null ? entry.last_deadline_value / 10 : null;

  return {
    players: players,
    starting: players.filter(function (p) { return p.isStarting; }),
    bench: players.filter(function (p) { return !p.isStarting; }).sort(function (a, b) { return a.pickPosition - b.pickPosition; }),
    bank: bank,
    teamValue: teamValue,
    entryHistory: picksResp.entry_history || null
  };
}

/* ===================== FREE TRANSFERS ===================== */

var MAX_BANKED_TRANSFERS = 5;

/**
 * How many free transfers the manager has this week.
 *
 * The FPL API does not expose this anywhere, which is why every
 * recommendation this app made used to say "Free transfer" regardless — a
 * second or third suggested move in the same week was silently costing 4
 * points a piece and the cost line said otherwise. It is derivable from
 * history: one transfer is granted per gameweek, unused ones bank up to a
 * cap, and each transfer made spends one.
 *
 * Two things make this an ESTIMATE rather than a fact, and the UI labels it
 * as one: wildcard and free-hit gameweeks are assumed to leave the bank
 * untouched (that is the behaviour in recent seasons, but it is a rule that
 * has changed before), and a manager who joined mid-season starts from the
 * first gameweek history records rather than from GW1. Being roughly right
 * about this is still far better than the flat "everything is free" it
 * replaces — the difference between one free transfer and two is the
 * difference between a good move and a -4.
 */
function estimateFreeTransfers_(history) {
  if (!history || !history.current || !history.current.length) return 1;

  var chipByEvent = {};
  (history.chips || []).forEach(function (c) { chipByEvent[c.event] = c.name; });

  // Starts at 0, not 1: there is no free-transfer concept before the season
  // begins — the initial squad pick isn't a "transfer" at all. The loop's
  // own `+ 1` for each iterated gameweek is what grants the first-ever
  // allocation, on the first pass (GW1: 0 used, 0 + 1 = 1, which is the
  // baseline the manager actually holds entering GW2). Starting at 1 here
  // double-counted that first grant — one from this initial value, a second
  // from the loop's own `+ 1` — and reported one extra free transfer for
  // every manager, every gameweek, all season.
  var ft = 0;
  history.current.forEach(function (gw) {
    var chip = chipByEvent[gw.event];
    if (chip !== 'wildcard' && chip !== 'freehit') {
      ft = Math.max(0, ft - (gw.event_transfers || 0));
    }
    ft = Math.min(MAX_BANKED_TRANSFERS, ft + 1); // next gameweek's allocation
  });
  return Math.max(1, Math.min(MAX_BANKED_TRANSFERS, ft));
}

/* ===================== TRANSFER SUGGESTIONS ===================== */

/* ===================== TRANSFERS ALREADY MADE ===================== */

/* The FPL API publishes a manager's picks only once a deadline passes. Between
 * making a transfer and that deadline, everything this app read was LAST
 * week's locked squad, so the eleven and the captain it recommended were for a
 * team the manager no longer had — and the graded "recommended XI" was scored
 * against a lineup built from different players.
 *
 * There is no public endpoint for the pending squad, and holding the
 * manager's FPL login to read the private one would be a credential worth
 * stealing in a script property. So the manager tells the app what they did:
 * a list of (out, in) pairs against the last locked squad, plus an optional
 * Wildcard / Free Hit, filed against the gameweek it is for. Every figure on
 * the page then runs on the squad they actually hold. Once the deadline
 * passes and the real picks are readable, the declaration is checked against
 * them and discarded — the API is the truth from then on. */
var DECLARED_PROP_PREFIX = 'DECLARED_';
var DECLARED_CHIPS = { wildcard: 'Wildcard', freehit: 'Free Hit' };

/** Every player as [id, name, club, position, price, status] — the form's search list. */
function buildPlayerIndex_(bootstrap) {
  var shortById = {};
  bootstrap.teams.forEach(function (t) { shortById[t.id] = t.short_name; });
  return bootstrap.elements.map(function (el) {
    return [el.id, el.web_name, shortById[el.team] || '?', POSITION_MAP[el.element_type], el.now_cost / 10, el.status];
  });
}

function readDeclared_(eventId) {
  if (eventId == null) return null;
  var raw = PropertiesService.getScriptProperties().getProperty(DECLARED_PROP_PREFIX + eventId);
  return raw ? safeCall_(function () { return JSON.parse(raw); }) : null;
}

/** Stable identity for a declaration, so an unchanged one is recognised. */
function declaredSignature_(declared) {
  if (!declared || !(declared.moves || []).length) return '';
  return declared.moves.map(function (m) { return m.outId + '>' + m.inId; }).sort().join(',') +
    (declared.chip ? '|' + declared.chip : '');
}

/**
 * Folds one more move into a declaration. Selling a player bought earlier in
 * the same week collapses into one move from the original squad (A→B then
 * B→C is A→C), and buying back the player sold cancels the move entirely.
 */
function mergeDeclaredMove_(moves, move) {
  var out = (moves || []).map(function (m) { return { outId: m.outId, inId: m.inId }; });
  for (var i = 0; i < out.length; i++) {
    if (out[i].inId === move.outId) {
      if (out[i].outId === move.inId) { out.splice(i, 1); return out; }
      out[i].inId = move.inId;
      return out;
    }
  }
  out.push({ outId: move.outId, inId: move.inId });
  return out;
}

/**
 * Applies a declaration to the last locked picks. Pure: returns new picks,
 * a new entry and a summary, or { ok: false, errors } with every rule the
 * declaration breaks, so nothing invalid is ever silently half-applied.
 */
function applyDeclaredTransfers_(bootstrap, picksResp, entry, declared, freeTransfers) {
  var elementsById = {};
  bootstrap.elements.forEach(function (el) { elementsById[el.id] = el; });
  var teamsById = {};
  bootstrap.teams.forEach(function (t) { teamsById[t.id] = t; });
  var errors = [];
  var moves = (declared && declared.moves) || [];
  var chip = declared && declared.chip && DECLARED_CHIPS[declared.chip] ? declared.chip : null;

  var picks = (picksResp.picks || []).map(function (p) {
    var c = {}; Object.keys(p).forEach(function (k) { c[k] = p[k]; }); return c;
  });
  var bankTenths = entry && entry.last_deadline_bank != null ? entry.last_deadline_bank : 0;
  var valueTenths = entry && entry.last_deadline_value != null ? entry.last_deadline_value : null;
  var seenOut = {}, seenIn = {};
  var described = [];

  moves.forEach(function (m) {
    var outEl = elementsById[m.outId], inEl = elementsById[m.inId];
    var slot = picks.filter(function (p) { return p.element === m.outId; })[0];
    if (!outEl || !slot) { errors.push('Player ' + (outEl ? outEl.web_name : m.outId) + ' is not in your last locked squad.'); return; }
    if (!inEl) { errors.push('Unknown incoming player ' + m.inId + '.'); return; }
    if (seenOut[m.outId]) { errors.push(outEl.web_name + ' is sold twice.'); return; }
    if (seenIn[m.inId]) { errors.push(inEl.web_name + ' is bought twice.'); return; }
    if (outEl.element_type !== inEl.element_type) {
      errors.push(inEl.web_name + ' (' + POSITION_MAP[inEl.element_type] + ') cannot replace ' + outEl.web_name +
        ' (' + POSITION_MAP[outEl.element_type] + ') — transfers are like for like.');
      return;
    }
    seenOut[m.outId] = true; seenIn[m.inId] = true;
    var sell = isFinite(slot.selling_price) ? slot.selling_price : outEl.now_cost;
    bankTenths -= inEl.now_cost - sell;
    if (valueTenths != null) valueTenths += inEl.now_cost - sell;
    slot.element = inEl.id;
    // Bought this week, so it sells for what it cost until the price moves.
    slot.selling_price = inEl.now_cost;
    slot.purchase_price = inEl.now_cost;
    slot.is_captain = false;
    slot.is_vice_captain = false;
    described.push({
      outId: outEl.id, outName: outEl.web_name, inId: inEl.id, inName: inEl.web_name,
      position: POSITION_MAP[inEl.element_type],
      inTeam: teamsById[inEl.team] ? teamsById[inEl.team].short_name : '?',
      priceDelta: Math.round((inEl.now_cost - sell)) / 10
    });
  });

  var ids = {};
  picks.forEach(function (p) {
    if (ids[p.element]) errors.push((elementsById[p.element] || {}).web_name + ' would be in the squad twice.');
    ids[p.element] = true;
  });
  var clubs = {};
  picks.forEach(function (p) {
    var el = elementsById[p.element]; if (!el) return;
    clubs[el.team] = (clubs[el.team] || 0) + 1;
  });
  Object.keys(clubs).forEach(function (t) {
    if (clubs[t] > 3) errors.push('That puts ' + clubs[t] + ' ' + (teamsById[t] ? teamsById[t].name : 'club ' + t) + ' players in the squad; the limit is three.');
  });
  if (bankTenths < 0) errors.push('Those moves overspend by £' + (Math.abs(bankTenths) / 10).toFixed(1) + 'm.');

  if (errors.length) return { ok: false, errors: errors };

  var ft = freeTransfers == null ? 1 : freeTransfers;
  var hits = chip ? 0 : Math.max(0, described.length - ft);
  // Under a Wildcard or Free Hit every transfer that week is free.
  var ftLeft = chip ? 15 : Math.max(0, ft - described.length);

  var newEntry = {};
  Object.keys(entry || {}).forEach(function (k) { newEntry[k] = entry[k]; });
  newEntry.last_deadline_bank = bankTenths;
  if (valueTenths != null) newEntry.last_deadline_value = valueTenths;

  var newPicks = {};
  Object.keys(picksResp).forEach(function (k) { newPicks[k] = picksResp[k]; });
  newPicks.picks = picks;

  return {
    ok: true,
    picks: newPicks,
    entry: newEntry,
    freeTransfersLeft: ftLeft,
    summary: {
      eventId: declared.eventId,
      moves: described,
      chip: chip ? DECLARED_CHIPS[chip] : null,
      hits: hits,
      freeTransfersBefore: ft,
      freeTransfersLeft: ftLeft,
      bank: bankTenths / 10,
      squadAfter: picks.map(function (p) { return p.element; }),
      signature: declaredSignature_(declared),
      savedAt: declared.savedAt || null
    }
  };
}

/** The decision gameweek, the locked picks it builds on, and the inputs to validate against. */
function declaredContext_() {
  var teamId = getTeamId();
  if (!teamId) throw new Error('Set your team ID first.');
  var bootstrap = getBootstrap_();
  SEASON_CONTEXT_ = loadSeasonContext_(bootstrap);
  var gs = resolveGameweekState_(bootstrap.events);
  if (gs.decisionEventId == null || gs.picksEventId == null) {
    throw new Error('There is no open gameweek with a locked squad to build on right now.');
  }
  var picks = getPicks_(teamId, gs.picksEventId);
  var entry = safeCall_(function () { return getEntry_(teamId); });
  var history = safeCall_(function () { return getHistory_(teamId); });
  var ft = safeCall_(function () { return estimateFreeTransfers_(history); });
  return { bootstrap: bootstrap, gs: gs, picks: picks, entry: entry, freeTransfers: ft == null ? 1 : ft };
}

/**
 * Client entry point. `payload` is { eventId, moves: [{ outId, inId }], chip }
 * (or its JSON string). Replaces any earlier declaration for the gameweek.
 * Returns the applied summary, or throws with every rule it breaks.
 */
function saveDeclaredTransfers(payload) {
  var p = typeof payload === 'string' ? JSON.parse(payload) : payload;
  var ctx = declaredContext_();
  if (String(p.eventId) !== String(ctx.gs.decisionEventId)) {
    throw new Error('Those transfers are for GW' + p.eventId + ', but the open gameweek is GW' + ctx.gs.decisionEventId + '. Refresh and try again.');
  }
  var moves = [];
  (p.moves || []).forEach(function (m) {
    var outId = parseInt(m.outId, 10), inId = parseInt(m.inId, 10);
    if (isFinite(outId) && isFinite(inId) && outId !== inId) moves = mergeDeclaredMove_(moves, { outId: outId, inId: inId });
  });
  if (moves.length > 15) throw new Error('A squad only has fifteen players.');
  var declared = {
    eventId: ctx.gs.decisionEventId,
    moves: moves,
    chip: p.chip && DECLARED_CHIPS[p.chip] ? p.chip : null,
    savedAt: new Date().toISOString()
  };
  var key = DECLARED_PROP_PREFIX + declared.eventId;
  var props = PropertiesService.getScriptProperties();
  if (!moves.length) { props.deleteProperty(key); return { ok: true, cleared: true }; }
  var applied = applyDeclaredTransfers_(ctx.bootstrap, ctx.picks, ctx.entry, declared, ctx.freeTransfers);
  if (!applied.ok) throw new Error(applied.errors.join(' '));
  declared.squadAfter = applied.summary.squadAfter;
  props.setProperty(key, JSON.stringify(declared));
  return { ok: true, summary: applied.summary };
}

/** Client entry point: forget this gameweek's declaration. */
function clearDeclaredTransfers(eventId) {
  if (eventId == null) return { ok: true };
  PropertiesService.getScriptProperties().deleteProperty(DECLARED_PROP_PREFIX + eventId);
  return { ok: true };
}

/**
 * After a deadline: does the squad FPL actually locked match what the
 * manager said they did? Either way the declaration is retired — the real
 * picks are readable now and nothing should be built on a guess about them.
 */
function reconcileDeclared_(eventId, lockedPicks, bootstrap) {
  var declared = readDeclared_(eventId);
  if (!declared || !lockedPicks || !lockedPicks.picks) return null;
  var locked = {};
  lockedPicks.picks.forEach(function (p) { locked[p.element] = true; });
  var nameOf = {};
  bootstrap.elements.forEach(function (el) { nameOf[el.id] = el.web_name; });
  var missing = (declared.squadAfter || []).filter(function (id) { return !locked[id]; });
  PropertiesService.getScriptProperties().deleteProperty(DECLARED_PROP_PREFIX + eventId);
  return {
    eventId: eventId,
    matched: !missing.length,
    note: missing.length
      ? 'The transfers you told the app about for GW' + eventId + ' do not match the squad FPL locked: ' +
        missing.map(function (id) { return nameOf[id] || id; }).join(', ') +
        ' never arrived. The page now reads your real squad.'
      : 'Your GW' + eventId + ' transfers matched the squad FPL locked.'
  };
}

var TRANSFER_HIT_COST = 4;

/**
 * Expected points a move must gain over the lookahead window before the app
 * will call it. These are real points now, not a ratio of an abstract score
 * — the old `candidate > weak * 1.15` test could not distinguish a 15%
 * improvement on a bench fodder defender (worth ~0.4 points) from a 15%
 * improvement on a premium forward (worth ~4), and recommended both with
 * equal confidence.
 */
var TRANSFER_MARGIN = { safe: 3.0, balanced: 2.0, aggressive: 1.0 };
/** Extra margin required ON TOP of the 4-point hit before advising one. */
var HIT_MARGIN = { safe: 3.0, balanced: 2.0, aggressive: 0.5 };

function suggestTransfers_(bootstrap, fixtureEase, squad, riskAppetite, freeTransfers, out) {
  var teamsById = {};
  bootstrap.teams.forEach(function (t) { teamsById[t.id] = t; });
  var elementsById = {};
  bootstrap.elements.forEach(function (el) { elementsById[el.id] = el; });

  var squadIds = squad.players.map(function (p) { return p.id; });
  var margin = TRANSFER_MARGIN[riskAppetite] || TRANSFER_MARGIN.balanced;
  var hitMargin = HIT_MARGIN[riskAppetite] || HIT_MARGIN.balanced;
  var maxSuggestions = riskAppetite === 'aggressive' ? 5 : (riskAppetite === 'safe' ? 2 : 3);
  // Deliberately FINISHED, not started: this gates a `minutes > 0` filter on
  // the candidate pool, and mid-gameweek that filter would throw out everyone
  // whose fixture is on Sunday. See loadSeasonContext_ for the distinction.
  var preseason = !SEASON_CONTEXT_ || !SEASON_CONTEXT_.finishedGws;

  // FPL allows at most three players from any one club. The old code never
  // checked this, so it could confidently recommend a transfer the game
  // would simply refuse to accept.
  var clubCount = {};
  squad.players.forEach(function (p) { clubCount[p.teamId] = (clubCount[p.teamId] || 0) + 1; });

  var bankTenths = Math.round((squad.bank || 0) * 10);

  var current = squad.players.map(function (p) {
    var el = elementsById[p.id];
    return { pick: p, el: el, xp: projectPoints_(el, fixtureEase) };
  });

  /* The counterfactual a transfer is measured against.
   *
   * A transfer used to be valued as (incoming player's projection) minus
   * (outgoing player's projection). For an injured player that subtracts a
   * zero, so the move was credited with the incoming player's ENTIRE output —
   * "Schade in for Gakpo: +57.6 over six gameweeks" — when the real
   * alternative to selling an injured starter is benching him and starting
   * the twelfth man, which costs nothing. The gain is now the change in the
   * best legal eleven you could field each gameweek, with and without the
   * move — plus a small allowance for the bench's autosub cover (see
   * squadValueAt_), so a bench player is worth a little, not nothing. */
  var squadState = current.map(function (c) {
    return { id: c.pick.id, name: c.pick.name, elementType: c.el.element_type, xp: c.xp };
  });
  var deferred = [];

  var pool = bootstrap.elements.filter(function (el) {
    return squadIds.indexOf(el.id) === -1 &&
      el.status === 'a' &&
      (preseason || el.minutes > 0);
  }).map(function (el) {
    return { el: el, xp: projectPoints_(el, fixtureEase) };
  });

  var byPosition = {};
  pool.forEach(function (c) { (byPosition[c.el.element_type] = byPosition[c.el.element_type] || []).push(c); });
  Object.keys(byPosition).forEach(function (k) {
    byPosition[k].sort(function (a, b) { return b.xp.horizon - a.xp.horizon; });
  });

  // Every legal (out, in) pair worth considering, scored in points over the
  // horizon — then ranked globally. The old version walked the six worst
  // players in isolation and took each one's top candidate, which meant two
  // weak players in the same position were both told to buy the same man.
  var pairs = [];
  current.forEach(function (out) {
    // Selling price, not current price: once a player has risen you only
    // bank half the profit, so budgeting from now_cost (as this did)
    // overstates what the manager can actually spend.
    var sellTenths = isFinite(out.pick.sellingPrice)
      ? Math.round(out.pick.sellingPrice * 10)
      : out.el.now_cost;
    var maxSpend = sellTenths + bankTenths;
    var candidates = byPosition[out.el.element_type] || [];
    var considered = 0;

    for (var i = 0; i < candidates.length && considered < 8; i++) {
      var cand = candidates[i];
      if (cand.el.now_cost > maxSpend) continue;
      var clubAfter = (clubCount[cand.el.team] || 0) - (out.pick.teamId === cand.el.team ? 1 : 0);
      if (clubAfter >= 3) continue;
      considered++;
      var gain = Math.round(swapGain_(squadState, out.pick.id, cand) * 100) / 100;
      if (gain <= 0) continue;
      pairs.push({ out: out, cand: cand, gain: gain, sellTenths: sellTenths });
    }
  });

  pairs.sort(function (a, b) { return b.gain - a.gain; });

  var usedOut = {}, usedIn = {}, suggestions = [];
  // 0 is a real answer once the manager has already spent this week's
  // transfers (see applyDeclaredTransfers_): every further move is a hit.
  var ftLeft = freeTransfers == null ? 1 : Math.max(0, freeTransfers);
  // Affordability above was checked per pair against the FULL bank, which is
  // right for any one move on its own but wrong for a list of them: three
  // suggested moves that each spend the same £1.5m are not three moves the
  // manager can actually make. The bank is tracked as moves are accepted, and
  // a pair that no longer fits is skipped in favour of the next best.
  var runningBank = bankTenths;
  var runningClubCount = {};
  Object.keys(clubCount).forEach(function (k) { runningClubCount[k] = clubCount[k]; });

  for (var k = 0; k < pairs.length && suggestions.length < maxSuggestions; k++) {
    var pair = pairs[k];
    if (usedOut[pair.out.pick.id] || usedIn[pair.cand.el.id]) continue;

    var spend = pair.cand.el.now_cost - pair.sellTenths;
    if (spend > runningBank) continue;
    // Re-check the club limit against the squad as it stands after the moves
    // already accepted, not against the original squad.
    var clubAfter = (runningClubCount[pair.cand.el.team] || 0) -
      (pair.out.pick.teamId === pair.cand.el.team ? 1 : 0);
    if (clubAfter >= 3) continue;

    // Re-measured against the squad as it stands after the moves already
    // accepted. Two moves are not worth the sum of their solo values: the
    // second one may only displace a player the first one already benched.
    if (suggestions.length) {
      pair.gain = Math.round(swapGain_(squadState, pair.out.pick.id, pair.cand) * 100) / 100;
    }

    var isFree = suggestions.length < ftLeft;
    // Rounded once, to the precision it is displayed at, BEFORE the hit is
    // taken off — so "+41.2 gross, nets 37.2" always reconciles on the page.
    // Gross was shown to one place and net to two, which is how 41.23 − 4
    // came to read as "41.2 ... nets 37.23".
    pair.gain = Math.round(pair.gain * 10) / 10;
    var netGain = Math.round((pair.gain - (isFree ? 0 : TRANSFER_HIT_COST)) * 10) / 10;
    var bar = isFree ? margin : (TRANSFER_HIT_COST + hitMargin);
    if (pair.gain < bar) continue;

    /* A hit is bought against WAITING, not against never making the move.
     *
     * Every gameweek brings a free transfer, so the alternative to "−4 now"
     * is "the same move next week, free" — which costs only the points the
     * move would have earned in the weeks it waits. Comparing the hit with
     * doing nothing for six weeks is how Konsa → Gvardiol was recommended at
     * −4 for +6.7 when it was worth +1.0 in the gameweek being paid for:
     * waiting a week was three points better. With moves already queued
     * for later free transfers, this one waits behind them, so it would be
     * made one gameweek later per move ahead of it in the queue. */
    pair.perGw = swapGainPerGw_(squadState, pair.out.pick.id, pair.cand);
    pair.impact = xiImpact_(squadState, pair.out.pick.id, pair.cand);
    if (!isFree) {
      var waitWeeks = deferred.length + 1;
      var waitCost = 0;
      for (var w = 0; w < waitWeeks && w < pair.perGw.length; w++) waitCost += pair.perGw[w];
      waitCost = Math.round(waitCost * 10) / 10;
      if (waitCost <= TRANSFER_HIT_COST + HIT_NOW_MARGIN) {
        if (waitWeeks < pair.perGw.length && deferred.length < MAX_DEFERRED_TRANSFERS &&
            !deferred.some(function (dm) { return dm.outId === pair.out.pick.id || dm.inId === pair.cand.el.id; })) {
          var later = pair.cand.xp.perGw[waitWeeks];
          deferred.push({
            outId: pair.out.pick.id, outName: pair.out.pick.name,
            inId: pair.cand.el.id, inName: pair.cand.el.web_name,
            inTeam: teamsById[pair.cand.el.team] ? teamsById[pair.cand.el.team].short_name : '?',
            position: POSITION_MAP[pair.cand.el.element_type],
            makeInEvent: later ? later.event : null,
            gain: pair.gain,
            waitCost: waitCost,
            gainIfWaited: Math.round((pair.gain - waitCost) * 10) / 10,
            gainThisWeek: pair.perGw[0],
            note: 'Taking it now costs a −' + TRANSFER_HIT_COST + ' to gain ' + waitCost.toFixed(1) +
              ' before ' + (later ? 'GW' + later.event : 'next week') + '; making it then with a free transfer keeps +' +
              (pair.gain - waitCost).toFixed(1) + ' of the +' + pair.gain.toFixed(1) + '.'
          });
        }
        continue;
      }
      pair.waitCost = waitCost;
    }

    usedOut[pair.out.pick.id] = true;
    usedIn[pair.cand.el.id] = true;
    for (var si = 0; si < squadState.length; si++) {
      if (squadState[si].id === pair.out.pick.id) {
        squadState[si] = { id: pair.cand.el.id, name: pair.cand.el.web_name, elementType: pair.cand.el.element_type, xp: pair.cand.xp };
        break;
      }
    }
    runningBank -= spend;
    runningClubCount[pair.out.pick.teamId] = (runningClubCount[pair.out.pick.teamId] || 1) - 1;
    runningClubCount[pair.cand.el.team] = (runningClubCount[pair.cand.el.team] || 0) + 1;
    suggestions.push(buildTransferRow_(pair, teamsById, fixtureEase, isFree, netGain, runningBank));
  }

  if (out) out.deferred = deferred;
  return suggestions;
}

/* How much better than "make it next week" a hit has to be. */
var HIT_NOW_MARGIN = 1.0;
var MAX_DEFERRED_TRANSFERS = 2;

/** The squad-value gain of a swap, gameweek by gameweek (same objective as swapGain_). */
function swapGainPerGw_(state, outId, cand) {
  var swapped = state.map(function (p) {
    return p.id === outId ? { id: cand.el.id, name: cand.el.web_name, elementType: cand.el.element_type, xp: cand.xp } : p;
  });
  var gws = cand.xp && cand.xp.perGw ? cand.xp.perGw.length : 0;
  var per = [];
  for (var idx = 0; idx < gws; idx++) per.push(Math.round((squadValueAt_(swapped, idx) - squadValueAt_(state, idx)) * 100) / 100);
  return per;
}

/**
 * What a swap does to THIS gameweek's eleven: does the new player start,
 * and if so whose place does he take. A transfer described only by its
 * six-week total hides the answer to "would he even play this week?".
 */
function xiImpact_(state, outId, cand) {
  var before = bestXiPicks_(state, 0);
  var swapped = state.map(function (p) {
    return p.id === outId ? { id: cand.el.id, name: cand.el.web_name, elementType: cand.el.element_type, xp: cand.xp } : p;
  });
  var after = bestXiPicks_(swapped, 0);
  var afterIds = {}, beforeIds = {};
  after.players.forEach(function (p) { afterIds[p.id] = true; });
  before.players.forEach(function (p) { beforeIds[p.id] = true; });
  var starts = !!afterIds[cand.el.id];
  var outStarted = !!beforeIds[outId];
  // Who leaves the eleven to make room — the sold player if he started,
  // otherwise whoever the new man pushes to the bench.
  var displaced = outStarted ? null : before.players.filter(function (p) { return !afterIds[p.id] && p.id !== outId; })[0];
  return {
    starts: starts,
    replaces: starts ? (outStarted ? 'the player sold' : (displaced ? displaced.name : null)) : null,
    outStarted: outStarted
  };
}

/**
 * Horizon points the best legal eleven gains, summed over every gameweek in
 * the window, if `outId` is replaced by `cand`. `state` is a list of
 * { id, elementType, xp } — anything bestXiXp_ can read.
 */
function swapGain_(state, outId, cand) {
  var swapped = state.map(function (p) {
    return p.id === outId ? { id: cand.el.id, elementType: cand.el.element_type, xp: cand.xp } : p;
  });
  var gws = cand.xp && cand.xp.perGw ? cand.xp.perGw.length : 0;
  var gain = 0;
  for (var idx = 0; idx < gws; idx++) gain += squadValueAt_(swapped, idx) - squadValueAt_(state, idx);
  return gain;
}

/* The bench is not worth nothing.
 *
 * Scoring a squad on its best eleven alone values the bench at exactly zero,
 * so a transfer that swaps a playable first sub for a non-playing one costs
 * nothing — and every week some starter does not play, and the first sub's
 * points count. These are rough autosub rates, not a model of who gets
 * injured: the first outfield sub comes on often enough to matter, the
 * third almost never. Small on purpose — a starter is still worth roughly
 * ten times the first sub. */
var BENCH_COVER_WEIGHTS = [0.12, 0.06, 0.03];

/** Best-XI points for one gameweek plus the cover the outfield bench provides. */
function squadValueAt_(players, idx) {
  var picks = bestXiPicks_(players, idx);
  var cover = 0;
  picks.bench.filter(function (p) { return p.elementType !== 1; }).forEach(function (p, i) {
    if (i < BENCH_COVER_WEIGHTS.length) cover += p.xp * BENCH_COVER_WEIGHTS[i];
  });
  return picks.total + cover;
}

/* A single swap that moves the best eleven by more than this per gameweek is
 * almost certainly an inflated projection on the incoming side, not a real
 * edge — even a premium for an injured starter is worth ~3-4 a week over the
 * bench player who would otherwise come in. Flagged, not hidden. */
var TRANSFER_IMPLAUSIBLE_PER_GW = 4.5;

function buildTransferRow_(pair, teamsById, fixtureEase, isFree, netGain, bankTenths) {
  var out = pair.out, cand = pair.cand;
  var inTeam = teamsById[cand.el.team] ? teamsById[cand.el.team].short_name : '?';
  var priceDelta = (cand.el.now_cost - pair.sellTenths) / 10;
  var fe = fixtureEase[cand.el.team];
  var nextRun = fe ? fe.nextOpponents.slice(0, 3).join(', ') : 'n/a';

  var costLine;
  if (!isFree) {
    costLine = '−4 hit · +' + pair.gain.toFixed(1) + ' − 4 = ' + (netGain >= 0 ? '+' : '') + netGain.toFixed(1) + ' net' +
      (priceDelta > 0 ? ' · £' + priceDelta.toFixed(1) + 'm from bank' : '');
  } else if (priceDelta <= 0) {
    costLine = 'Free transfer · frees up £' + Math.abs(priceDelta).toFixed(1) + 'm';
  } else {
    costLine = 'Free transfer · £' + priceDelta.toFixed(1) + 'm from bank';
  }

  var outReason;
  if (out.el.status !== 'a') {
    outReason = 'Availability concern: ' + (out.el.news || STATUS_LABEL[out.el.status]);
  } else if (out.xp.starter < 0.75) {
    outReason = 'Rotation risk — started a minority of available minutes.';
  } else {
    outReason = 'Projects ' + out.xp.horizon.toFixed(1) + ' pts over the next ' +
      out.xp.perGw.length + ' gameweeks, the weakest return in your squad for the money.';
  }

  return {
    // Legacy display strings — the frontend and the decision snapshot both
    // parse names back out of these, so their shape is load-bearing.
    out: out.pick.name + ' (' + out.pick.team + ', £' + out.pick.price.toFixed(1) + 'm)',
    into: cand.el.web_name + ' (' + inTeam + ', £' + (cand.el.now_cost / 10).toFixed(1) + 'm)',
    outReason: outReason,
    intoReason: 'Projects ' + cand.xp.horizon.toFixed(1) + ' pts over the same window · form ' +
      cand.el.form + ' · next: ' + nextRun + (function () {
        var rot = rotationFor_(cand.el);
        return rot ? ' · ' + rot.text.charAt(0).toLowerCase() + rot.text.slice(1).replace(/\.$/, '') : '';
      })(),
    inRotation: rotationFor_(cand.el),
    position: POSITION_MAP[cand.el.element_type],
    // Structured fields — ids so the weekly grading can match players
    // exactly instead of by display name, which is ambiguous (two players
    // can share a web_name) and breaks the moment a name is re-rendered.
    outId: out.pick.id,
    inId: cand.el.id,
    outName: out.pick.name,
    inName: cand.el.web_name,
    // Full club names, so copy written about this move never has to supply
    // them from memory (see rulingNamesWrongClub_).
    outClub: teamsById[out.pick.teamId] ? teamsById[out.pick.teamId].name : null,
    inClub: teamsById[cand.el.team] ? teamsById[cand.el.team].name : null,
    outXp: out.xp.horizon,
    inXp: cand.xp.horizon,
    outXpNext: out.xp.next,
    inXpNext: cand.xp.next,
    horizonGws: cand.xp.perGw.length,
    projectedGain: Math.round(pair.gain * 10) / 10,
    netGain: netGain,
    hitCost: isFree ? 0 : TRANSFER_HIT_COST,
    // The six-week figure split: what it is worth in the gameweek being
    // picked for, and what it is worth after — the answer to "would he even
    // start this week, and is it worth paying for now rather than later".
    gainThisWeek: pair.perGw ? Math.round(pair.perGw[0] * 10) / 10 : null,
    gainLater: pair.perGw ? Math.round((pair.gain - pair.perGw[0]) * 10) / 10 : null,
    startsThisWeek: pair.impact ? pair.impact.starts : null,
    xiNote: pair.impact
      ? (pair.impact.starts
        ? cand.el.web_name + ' starts this week' + (pair.impact.replaces && pair.impact.replaces !== 'the player sold'
          ? ' in place of ' + pair.impact.replaces
          : (pair.impact.outStarted ? ' in ' + out.pick.name + '\u2019s place' : '')) + ' (+' + (pair.perGw[0] || 0).toFixed(1) + ' this week).'
        : cand.el.web_name + ' would not start this week (+' + (pair.perGw[0] || 0).toFixed(1) + '); the gain comes later.')
      : null,
    waitCost: pair.waitCost != null ? pair.waitCost : null,
    // What the gain is measured against, in words, so the figure can be
    // argued with. See suggestTransfers_.
    counterfactual: 'Measured against the best eleven you could field each gameweek without this move' +
      (out.el.status !== 'a' || out.xp.next < 0.5
        ? ' — ' + out.pick.name + ' would be benched, not scored as a zero.'
        : '.'),
    implausible: pair.gain / Math.max(1, cand.xp.perGw.length) > TRANSFER_IMPLAUSIBLE_PER_GW,
    usesHit: !isFree,
    confidence: pair.gain >= 8 ? 'High' : (pair.gain >= 4 ? 'Medium' : 'Low'),
    costLine: costLine
  };
}

/**
 * The headline transfer decision, in the "state a call, show the arithmetic"
 * shape the rest of the app uses. This is the answer to the question a
 * manager actually asks on a Friday — make a move, take a hit, or roll it —
 * which the ranked list alone never explicitly gave.
 */
/* One place that counts transfers, and one place that phrases them.
 *
 * The free-transfer count, the number of moves, the hits they cost and the
 * net gain were each being restated by several layers — the plan headline,
 * the action list, the roadmap, and (worst) the prose model that writes the
 * front-page verdict, which was handed sentences and asked to infer the
 * arithmetic back out of them. It inferred wrong, and the page contradicted
 * itself: a verdict announcing "two free transfers" above a header saying one
 * and a plan charging −8 for three moves.
 *
 * This is the ledger. Everything downstream reads these numbers; nothing
 * recomputes them, and the language model is given the finished figures and
 * told to explain them rather than to reconstruct them.
 */
function buildTransferLedger_(suggestions, freeTransfers) {
  var moves = suggestions || [];
  // Zero only once declared transfers have spent the week's allowance.
  var available = freeTransfers == null ? 1 : Math.max(0, freeTransfers);
  var free = moves.filter(function (m) { return !m.usesHit; }).length;
  var paid = moves.filter(function (m) { return m.usesHit; }).length;

  var grossGain = moves.reduce(function (sum, m) { return sum + (m.projectedGain || 0); }, 0);
  var hitCost = paid * TRANSFER_HIT_COST;
  var horizonGws = moves.length ? (moves[0].horizonGws || LOOKAHEAD_GWS) : LOOKAHEAD_GWS;

  var parts = [];
  if (moves.length) {
    parts.push(moves.length + ' transfer' + (moves.length === 1 ? '' : 's'));
    parts.push(available + ' FT');
    if (hitCost) parts.push('\u2212' + hitCost + ' hit');
  }

  return {
    freeTransfersAvailable: available,
    // What is left over if the recommendation is followed exactly. Rolls into
    // next week (to the cap) when it is not spent.
    freeTransfersUnused: Math.max(0, available - free),
    transfersRecommended: moves.length,
    freeMoves: free,
    paidMoves: paid,
    hitCost: hitCost,
    grossGain: Math.round(grossGain * 10) / 10,
    netGain: Math.round((grossGain - hitCost) * 10) / 10,
    horizonGws: horizonGws,
    atBankCap: available >= MAX_BANKED_TRANSFERS,
    // The canonical one-line rendering. Deterministic, so no two surfaces can
    // phrase the same accounting differently.
    summary: parts.length ? parts.join(' \u00b7 ') : 'No transfer'
  };
}

function buildTransferPlan_(suggestions, freeTransfers, squad, ledger) {
  var led = ledger || buildTransferLedger_(suggestions, freeTransfers);
  var free = led.freeTransfersAvailable;
  var top = (suggestions || [])[0];

  if (!top) {
    return {
      action: 'roll',
      headline: led.atBankCap
        ? 'Use a transfer — you cannot bank another.'
        : (free === 0 ? 'No more moves this week.' : 'Roll your transfer.'),
      detail: led.atBankCap
        ? 'You are at the ' + MAX_BANKED_TRANSFERS + '-transfer cap, so this week\'s free transfer is lost if unused — but nothing in the squad clears the bar, so spend it on the smallest upgrade rather than forcing a big one.'
        : 'No move clears the bar this week. Banking takes you to ' + Math.min(MAX_BANKED_TRANSFERS, free + 1) +
          ' free transfers next week, which buys a two-move fix without a hit.',
      freeTransfers: free,
      ledger: led
    };
  }

  return {
    action: led.paidMoves ? 'hit' : 'transfer',
    headline: led.freeMoves === 1 && !led.paidMoves
      ? top.inName + ' in for ' + top.outName + '.'
      : (led.paidMoves
        ? (led.freeMoves
          ? led.freeMoves + ' free move' + (led.freeMoves === 1 ? '' : 's') + ' plus a \u2212' + led.hitCost + ' worth taking.'
          : 'Your free transfers are spent; a \u2212' + led.hitCost + ' is still worth taking.')
        : led.freeMoves + ' moves, all free.'),
    // Every figure in this sentence comes off the ledger, so it cannot drift
    // from the header above it or the roadmap below it.
    detail: 'Projected +' + top.projectedGain.toFixed(1) + ' pts over the next ' + led.horizonGws +
      ' gameweeks on the top move' +
      (led.paidMoves
        ? '; all ' + led.transfersRecommended + ' net +' + led.netGain.toFixed(1) + ' after the \u2212' + led.hitCost + '.'
        : (free > 1 ? '. You have ' + free + ' free transfers banked.' : '.')),
    freeTransfers: free,
    ledger: led
  };
}

/* ===================== TRANSFER ROADMAP ===================== */

/* ===================== THE MULTI-WEEK PLAN =====================
 *
 * The old plan was greedy: each gameweek it took the single best move
 * available at that moment and moved on. Greedy is cheap and explicable, and
 * it is wrong in a specific, recurring way — it cannot see that a move which
 * looks second-best this week is first-best once you account for what it lets
 * you do next week. It walks into local optima: it spends a transfer on a
 * marginal upgrade, arrives at the gameweek where fixtures actually turn with
 * nothing banked, and pays 4 points for the move it should have been saving
 * for. Every decision it made was locally defensible and the sequence was
 * bad. That is the definition of the failure mode.
 *
 * The rigorous fix is a mixed-integer program over the remaining season. That
 * is not available here: Apps Script has no solver, a six-minute execution
 * ceiling, and ~700 players × 6 gameweeks × the transfer/budget/club
 * constraints is not something to hand-roll in JavaScript on a request path.
 *
 * What is available, and recovers most of what greedy loses, is a bounded
 * lookahead — a beam search over whole PLANS rather than a sequence of
 * independent best-moves:
 *
 *   - The candidate pool is pruned to the top ROADMAP_POOL_PER_POSITION
 *     players per position by expected points over the horizon. Nothing
 *     outside that set is a plausible transfer target, and pruning is what
 *     brings the search inside the execution budget.
 *   - Each gameweek every surviving plan branches: roll, take one of the top
 *     candidate moves, or take two (paying the hit if it is not covered by
 *     banked transfers). Rolling is a real branch, not a heuristic tripwire,
 *     so banking a transfer competes on the same arithmetic as spending one.
 *   - Plans are scored on the expected points of the BEST LEGAL XI each
 *     gameweek, minus hits — not on the squad total. This is the part greedy
 *     could not do at all: a fifth midfielder you cannot field is worth
 *     nothing, so the search values squad structure rather than just the sum
 *     of fifteen projections.
 *   - After each gameweek only the top ROADMAP_BEAM_WIDTH plans survive.
 *
 * The first gameweek stays pinned to the transfer engine's own suggestions.
 * Those are the app's answer to "what do I do now", and a plan that quietly
 * disagreed with the section above it would recreate exactly the bug the
 * roadmap was rebuilt to remove. Instead the search is run a second time with
 * the first gameweek unpinned, and if planning further ahead genuinely beats
 * the recommended move, that difference is reported as its own finding
 * (`divergence`) rather than as a competing instruction.
 */
/* Risk appetite, in the only currency the search understands.
 *
 * The greedy version expressed it as a minimum gain a move had to clear.
 * A beam search has no such threshold — it compares whole plans — so the
 * setting becomes a per-move friction charge instead: the points a cautious
 * manager implicitly pays for churning a squad on a projection that might be
 * wrong. Safe demands more before it moves; aggressive charges nothing and
 * will take any positive-value transfer. */
var ROADMAP_CHURN_PENALTY = { safe: 1.0, balanced: 0.5, aggressive: 0 };
var ROADMAP_BEAM_WIDTH = 6;          // plans carried forward per gameweek
var ROADMAP_CANDIDATES_PER_WEEK = 8; // single-move branches considered per plan
var ROADMAP_POOL_PER_POSITION = 30;  // pruned candidate pool — beyond this nothing is a real target
var ROADMAP_CANDIDATES_PER_SLOT = 3;
var ROADMAP_PAIR_BRANCHES = 3;       // top single moves that also get a second-move branch
var ROADMAP_DIVERGENCE_MIN = 1.5;    // points of horizon value before a different first week is worth reporting

/* Squad structure: 1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD, eleven in total. */
var XI_MIN = { 1: 1, 2: 3, 3: 2, 4: 1 };
var XI_MAX = { 1: 1, 2: 5, 3: 5, 4: 3 };

/**
 * Expected points of the best legal starting XI for one gameweek.
 *
 * Fill each position's minimum with its best players, then fill the four
 * remaining slots from whatever is left, respecting the per-position caps.
 * With only lower and upper bounds per position and a fixed total, taking the
 * highest remaining projection at each step is optimal — no search needed.
 *
 * This is the objective the whole plan is scored on. Scoring the fifteen-man
 * squad total instead (what the greedy version did) makes the planner
 * indifferent between a player who walks into the XI and a fifth defender who
 * sits on the bench all month.
 */
function bestXiXp_(players, idx) {
  var byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    var xp = p.xp.perGw[idx] ? p.xp.perGw[idx].xp : 0;
    (byPos[p.elementType] || (byPos[p.elementType] = [])).push(xp);
  }
  var desc = function (a, b) { return b - a; };
  [1, 2, 3, 4].forEach(function (k) { byPos[k].sort(desc); });

  var total = 0, used = { 1: 0, 2: 0, 3: 0, 4: 0 }, slots = 11;
  [1, 2, 3, 4].forEach(function (k) {
    var need = Math.min(XI_MIN[k], byPos[k].length);
    for (var i = 0; i < need; i++) { total += byPos[k][i]; used[k]++; slots--; }
  });

  // Remaining slots go to the best available projection anywhere, subject to
  // each position's ceiling.
  var rest = [];
  [1, 2, 3, 4].forEach(function (k) {
    for (var i = used[k]; i < byPos[k].length && i < XI_MAX[k]; i++) rest.push({ pos: k, xp: byPos[k][i] });
  });
  rest.sort(function (a, b) { return b.xp - a.xp; });
  for (var r = 0; r < rest.length && slots > 0; r++) {
    if (used[rest[r].pos] >= XI_MAX[rest[r].pos]) continue;
    total += rest[r].xp;
    used[rest[r].pos]++;
    slots--;
  }
  return total;
}

/**
 * The same eleven as bestXiXp_, as players: formation, the XI by position,
 * the bench in autosub order, and captain/vice by projection. Not used inside
 * the search — this allocates, and the search calls bestXiXp_ thousands of
 * times — only to present the plan that won.
 */
function bestXiPicks_(players, idx) {
  var xpOf = function (p) { return p.xp && p.xp.perGw && p.xp.perGw[idx] ? p.xp.perGw[idx].xp : 0; };
  var byPos = { 1: [], 2: [], 3: [], 4: [] };
  players.forEach(function (p) { (byPos[p.elementType] || (byPos[p.elementType] = [])).push(p); });
  [1, 2, 3, 4].forEach(function (k) { byPos[k].sort(function (a, b) { return xpOf(b) - xpOf(a); }); });

  var chosen = [], used = { 1: 0, 2: 0, 3: 0, 4: 0 }, slots = 11;
  [1, 2, 3, 4].forEach(function (k) {
    var need = Math.min(XI_MIN[k], byPos[k].length);
    for (var i = 0; i < need; i++) { chosen.push(byPos[k][i]); used[k]++; slots--; }
  });
  var rest = [];
  [1, 2, 3, 4].forEach(function (k) {
    for (var i = used[k]; i < byPos[k].length && i < XI_MAX[k]; i++) rest.push(byPos[k][i]);
  });
  rest.sort(function (a, b) { return xpOf(b) - xpOf(a); });
  for (var r = 0; r < rest.length && slots > 0; r++) {
    if (used[rest[r].elementType] >= XI_MAX[rest[r].elementType]) continue;
    chosen.push(rest[r]); used[rest[r].elementType]++; slots--;
  }
  var chosenIds = {};
  chosen.forEach(function (p) { chosenIds[p.id] = true; });
  var row = function (p) {
    return { id: p.id, name: p.name, team: p.team, position: POSITION_MAP[p.elementType], elementType: p.elementType,
      xp: Math.round(xpOf(p) * 10) / 10 };
  };
  var xi = chosen.slice().sort(function (a, b) { return a.elementType - b.elementType || xpOf(b) - xpOf(a); }).map(row);
  var byXp = xi.slice().sort(function (a, b) { return b.xp - a.xp; });
  var bench = players.filter(function (p) { return !chosenIds[p.id]; });
  var benchGk = bench.filter(function (p) { return p.elementType === 1; });
  var benchOut = bench.filter(function (p) { return p.elementType !== 1; })
    .sort(function (a, b) { return xpOf(b) - xpOf(a); }).concat(benchGk).map(row);
  return {
    formation: used[2] + '-' + used[3] + '-' + used[4],
    total: Math.round(xi.reduce(function (s2, p) { return s2 + p.xp; }, 0) * 10) / 10,
    players: xi,
    bench: benchOut,
    captain: byXp[0] ? { name: byXp[0].name, xp: byXp[0].xp, basis: 'mean' } : null,
    vice: byXp[1] ? { name: byXp[1].name, xp: byXp[1].xp } : null
  };
}

/** Expected points a projection has left from gameweek index `from` onward. */
function xpRemaining_(xp, from) {
  var total = 0;
  for (var i = from; i < xp.perGw.length; i++) total += xp.perGw[i].xp;
  return total;
}

function xpAt_(xp, idx) {
  return xp.perGw[idx] ? xp.perGw[idx].xp : 0;
}

/** A plan's squad and budget state, cloned so branches never share mutation. */
function cloneRoadmapNode_(node) {
  var clubCount = {};
  for (var k in node.clubCount) if (node.clubCount.hasOwnProperty(k)) clubCount[k] = node.clubCount[k];
  var taken = {};
  for (var t in node.taken) if (node.taken.hasOwnProperty(t)) taken[t] = true;
  return {
    state: node.state.slice(),
    bank: node.bank,
    clubCount: clubCount,
    taken: taken,
    ft: node.ft,
    score: node.score,
    weeks: node.weeks.slice()
  };
}

/**
 * Single moves worth considering for one plan in one gameweek, best first.
 * Capped per slot before the global cap so one dominant position cannot crowd
 * out every other candidate.
 */
function roadmapCandidates_(node, idx, poolByPos, teamsById) {
  var out = [];
  for (var s = 0; s < node.state.length; s++) {
    var held = node.state[s];
    var candidates = poolByPos[held.elementType] || [];
    var found = 0;
    for (var i = 0; i < candidates.length && found < ROADMAP_CANDIDATES_PER_SLOT; i++) {
      var cand = candidates[i];
      if (node.taken[cand.el.id]) continue;
      if (cand.el.now_cost > held.sellTenths + node.bank) continue;
      var clubAfter = (node.clubCount[cand.el.team] || 0) - (held.teamId === cand.el.team ? 1 : 0);
      if (clubAfter >= 3) continue;
      var gain = xpRemaining_(cand.xp, idx) - xpRemaining_(held.xp, idx);
      if (gain <= 0) continue;
      found++;
      out.push({
        slot: s, held: held, cand: cand, gain: gain,
        waitCost: xpAt_(cand.xp, idx) - xpAt_(held.xp, idx)
      });
    }
  }
  out.sort(function (a, b) { return b.gain - a.gain; });
  return out.slice(0, ROADMAP_CANDIDATES_PER_WEEK);
}

/* How wide the funded-upgrade search is allowed to get.
 *
 * Two sales times one target is a three-body problem, and enumerating it
 * fully across fifteen squad slots and a thirty-deep pool per position is far
 * more work than the rest of the beam search combined. It does not need to
 * be exhaustive to be useful: the sales worth considering are the weakest
 * players in the squad, and the targets worth considering are the best ones
 * a single sale could not reach. Everything else is either a move the search
 * already has as a plain one-for-one, or a downgrade.
 */
var UPGRADE_SELL_CANDIDATES = 4;   // weakest holdings considered as funding
var UPGRADE_TARGETS = 4;           // premium targets considered per branch
var UPGRADE_MIN_PREMIUM_GAP = 8;   // tenths of a million a target must exceed a single sale by

/**
 * Combinations that sell two players to buy one better one.
 *
 * The second sale has to be replaced too — a squad must keep fifteen — so
 * each combination is three moves in FPL terms: two out, two in, one of which
 * is the premium and the other a cheap enabler in the vacated position. That
 * is what makes this expensive in transfers and why it only ever wins when
 * the upgrade is large.
 */
function fundedUpgradeBranches_(node, idx, poolByPos, teamsById) {
  var out = [];

  // The weakest holdings by what they still project, since those are the ones
  // whose sale costs least. Goalkeepers are excluded as funding: selling one
  // forces buying another, and the position's spread is too narrow for the
  // trade to ever pay.
  var sellable = node.state.map(function (p, i) {
    return { slot: i, player: p, remaining: xpRemaining_(p.xp, idx) };
  }).filter(function (r) { return r.player.elementType !== 1; })
    .sort(function (a, b) { return a.remaining - b.remaining; })
    .slice(0, UPGRADE_SELL_CANDIDATES);
  if (sellable.length < 2) return out;

  for (var a = 0; a < sellable.length; a++) {
    for (var b = a + 1; b < sellable.length; b++) {
      var s1 = sellable[a], s2 = sellable[b];
      var proceeds = s1.player.sellTenths + s2.player.sellTenths + node.bank;
      var singleBest = Math.max(s1.player.sellTenths, s2.player.sellTenths) + node.bank;

      // Both vacated positions have to be filled again. The premium goes into
      // one of them; the other takes the cheapest adequate body, which is what
      // actually frees the money.
      [[s1, s2], [s2, s1]].forEach(function (order) {
        var upgradeSlot = order[0], enablerSlot = order[1];

        var enabler = cheapestFill_(node, enablerSlot, poolByPos, idx, {});
        if (!enabler) return;

        var budget = proceeds - enabler.el.now_cost;
        var targets = (poolByPos[upgradeSlot.player.elementType] || []).filter(function (c) {
          if (node.taken[c.el.id] || c.el.id === enabler.el.id) return false;
          if (c.el.now_cost > budget) return false;
          // Only targets a SINGLE sale could not have reached — anything
          // cheaper is already covered by the plain one-for-one branches, at
          // half the transfer cost.
          return c.el.now_cost > singleBest + UPGRADE_MIN_PREMIUM_GAP;
        }).slice(0, UPGRADE_TARGETS);

        targets.forEach(function (target) {
          // Club limits have to hold for the pair together, not just each move
          // in isolation — two arrivals from the same club can be individually
          // legal and jointly illegal.
          var after = {};
          after[target.el.team] = (after[target.el.team] || 0) + 1;
          after[enabler.el.team] = (after[enabler.el.team] || 0) + 1;
          var ok = true;
          Object.keys(after).forEach(function (teamId) {
            var current = node.clubCount[teamId] || 0;
            if (String(upgradeSlot.player.teamId) === teamId) current--;
            if (String(enablerSlot.player.teamId) === teamId) current--;
            if (current + after[teamId] > 3) ok = false;
          });
          if (!ok) return;

          var gain = (xpRemaining_(target.xp, idx) + xpRemaining_(enabler.xp, idx)) -
            (xpRemaining_(upgradeSlot.player.xp, idx) + xpRemaining_(enablerSlot.player.xp, idx));
          if (gain <= 0) return;

          out.push({
            gain: gain,
            moves: [
              { heldId: upgradeSlot.player.id, cand: target, gain: gain },
              { heldId: enablerSlot.player.id, cand: enabler, gain: 0 }
            ]
          });
        });
      });
    }
  }

  return out.sort(function (x, y) { return y.gain - x.gain; }).slice(0, ROADMAP_PAIR_BRANCHES);
}

/** The cheapest available body for a vacated slot's position. */
function cheapestFill_(node, slotRow, poolByPos, idx, exclude) {
  var pool = poolByPos[slotRow.player.elementType] || [];
  var best = null;
  for (var i = 0; i < pool.length; i++) {
    var c = pool[i];
    if (node.taken[c.el.id] || exclude[c.el.id]) continue;
    if (!best || c.el.now_cost < best.el.now_cost) best = c;
  }
  return best;
}

/** Applies one move to a node in place. The node must already be a clone. */
function applyRoadmapMove_(node, move, teamsById) {
  var held = node.state[move.slot];
  var cand = move.cand;
  node.taken[cand.el.id] = true;
  node.clubCount[held.teamId] = (node.clubCount[held.teamId] || 1) - 1;
  node.clubCount[cand.el.team] = (node.clubCount[cand.el.team] || 0) + 1;
  node.bank -= (cand.el.now_cost - held.sellTenths);
  node.state[move.slot] = {
    id: cand.el.id, name: cand.el.web_name, teamId: cand.el.team,
    team: teamsById[cand.el.team] ? teamsById[cand.el.team].short_name : '?',
    elementType: cand.el.element_type, cost: cand.el.now_cost,
    sellTenths: cand.el.now_cost, xp: cand.xp
  };
  return {
    outName: held.name, outTeam: held.team,
    inName: cand.el.web_name,
    inTeam: teamsById[cand.el.team] ? teamsById[cand.el.team].short_name : '?',
    position: POSITION_MAP[held.elementType],
    gain: Math.round(move.gain * 10) / 10,
    price: cand.el.now_cost / 10
  };
}

/**
 * Advances one plan through one gameweek, returning every branch worth
 * carrying: roll, each single move, and a second move on the strongest few.
 */
function expandRoadmapNode_(node, idx, eventId, poolByPos, teamsById, churn) {
  var branches = [];

  function finish(next, moves, hits, note) {
    var xi = bestXiXp_(next.state, idx);
    next.score += xi - hits * TRANSFER_HIT_COST - moves.length * churn;
    next.weeks.push({
      event: eventId,
      freeTransfers: node.ft,
      action: moves.length ? 'transfer' : 'roll',
      moves: moves,
      hits: hits,
      note: note,
      squadXp: Math.round(xi * 10) / 10,
      bank: Math.round(next.bank) / 10,
      // The fifteen as they stand this week, so the winning plan can show the
      // eleven and captain it implies. Stripped before the plan is returned.
      _state: next.state.slice()
    });
    // At least 1: every gameweek grants a free transfer, and paying a hit
    // does not forfeit it. Without the clamp a hit-funded double move leaves
    // ft at 0 and the plan prices the NEXT week's single move as another hit.
    next.ft = Math.max(1, Math.min(MAX_BANKED_TRANSFERS, node.ft - moves.length + 1));
    branches.push(next);
  }

  var cands = roadmapCandidates_(node, idx, poolByPos, teamsById);

  // Branch 1 — roll. Always available, always scored, never assumed.
  var rolled = cloneRoadmapNode_(node);
  var best = cands[0];
  finish(rolled, [], 0,
    best
      ? 'Holding. The best move available (' + best.cand.el.web_name + ' for ' + best.held.name +
        ') costs ' + Math.max(0, best.waitCost).toFixed(1) + ' pts to delay and banks a transfer.'
      : 'Holding — no affordable upgrade in the squad.');

  // Branch 2 — one move, one branch per candidate.
  for (var c = 0; c < cands.length; c++) {
    var single = cloneRoadmapNode_(node);
    var m = applyRoadmapMove_(single, cands[c], teamsById);
    var hit1 = node.ft >= 1 ? 0 : 1;
    finish(single, [m], hit1, hit1 ? 'Costs a ' + (hit1 * TRANSFER_HIT_COST) + '-point hit.' : null);
  }

  // Branch 3 — two moves on the strongest few. This is where a hit gets
  // priced honestly: the second move is only kept if the plan still comes out
  // ahead of the same plan without it, which is the comparison the greedy
  // version could never make.
  for (var d = 0; d < Math.min(ROADMAP_PAIR_BRANCHES, cands.length); d++) {
    var pair = cloneRoadmapNode_(node);
    var firstMove = applyRoadmapMove_(pair, cands[d], teamsById);
    var second = roadmapCandidates_(pair, idx, poolByPos, teamsById)[0];
    if (!second) continue;
    var secondMove = applyRoadmapMove_(pair, second, teamsById);
    var hits = Math.max(0, 2 - node.ft);
    finish(pair, [firstMove, secondMove], hits,
      hits ? 'Two moves, ' + (hits * TRANSFER_HIT_COST) + ' points of hits paid for the second.' : 'Two free transfers used.');
  }

  // Branch 4 — the funded upgrade.
  //
  // Every branch above is one-out-one-in, same position, paid for by that one
  // sale plus the bank. That makes the most common real upgrade path in FPL
  // unrepresentable: selling two mid-priced players to afford one premium.
  // Without it the premium tier is unreachable from below unless the bank
  // already covers the gap, and squad SHAPE — where the money sits — is never
  // a decision the planner can take.
  fundedUpgradeBranches_(node, idx, poolByPos, teamsById).forEach(function (combo) {
    var up = cloneRoadmapNode_(node);
    var moves = combo.moves.map(function (m) {
      // Slots are resolved against the live node as each sale is applied, so
      // the second sale cannot address a slot the first one already replaced.
      var slot = -1;
      for (var q = 0; q < up.state.length; q++) if (up.state[q].id === m.heldId) { slot = q; break; }
      if (slot === -1) return null;
      return applyRoadmapMove_(up, { slot: slot, cand: m.cand, gain: m.gain }, teamsById);
    }).filter(Boolean);
    if (moves.length !== combo.moves.length) return;
    var upHits = Math.max(0, moves.length - node.ft);
    finish(up, moves, upHits,
      'Two sales fund one upgrade' + (upHits ? ', ' + (upHits * TRANSFER_HIT_COST) + ' points of hits paid' : '') + '.');
  });

  return branches;
}

function buildTransferRoadmap_(bootstrap, fixtureEase, squad, freeTransfers, riskAppetite, suggestions, captainSuggestions) {
  // 0 is real once declared transfers have spent the week; null means unknown.
  var ft0 = freeTransfers == null ? 1 : freeTransfers;
  var teamsById = {};
  bootstrap.teams.forEach(function (t) { teamsById[t.id] = t; });
  var elementsById = {};
  bootstrap.elements.forEach(function (el) { elementsById[el.id] = el; });

  var churn = ROADMAP_CHURN_PENALTY[riskAppetite];
  if (churn == null) churn = ROADMAP_CHURN_PENALTY.balanced;
  // FINISHED, not started — same reason as suggestTransfers_.
  var preseason = !SEASON_CONTEXT_ || !SEASON_CONTEXT_.finishedGws;
  var anyFe = fixtureEase[squad.players[0] && squad.players[0].teamId] ||
    fixtureEase[Object.keys(fixtureEase)[0]];
  var eventIds = anyFe ? anyFe.eventIds : [];
  if (!eventIds.length) return null;

  var squadIds = {};
  squad.players.forEach(function (p) { squadIds[p.id] = true; });

  // Pruned pool. Everything downstream searches only this set, and the cap per
  // position is what keeps a six-week beam search inside the execution budget.
  var pool = bootstrap.elements.filter(function (el) {
    return !squadIds[el.id] && el.status === 'a' && (preseason || el.minutes > 0);
  }).map(function (el) {
    return { el: el, xp: projectPoints_(el, fixtureEase) };
  });
  var poolByPos = {};
  pool.forEach(function (c) { (poolByPos[c.el.element_type] = poolByPos[c.el.element_type] || []).push(c); });
  Object.keys(poolByPos).forEach(function (k) {
    poolByPos[k].sort(function (a, b) { return b.xp.horizon - a.xp.horizon; });
    poolByPos[k] = poolByPos[k].slice(0, ROADMAP_POOL_PER_POSITION);
  });

  function rootNode() {
    var state = squad.players.map(function (p) {
      return { id: p.id, name: p.name, teamId: p.teamId, team: p.team,
        elementType: p.elementType, cost: elementsById[p.id] ? elementsById[p.id].now_cost : Math.round(p.price * 10),
        sellTenths: isFinite(p.sellingPrice) ? Math.round(p.sellingPrice * 10) : Math.round(p.price * 10),
        xp: p.xp };
    });
    var clubCount = {};
    state.forEach(function (p) { clubCount[p.teamId] = (clubCount[p.teamId] || 0) + 1; });
    return {
      state: state,
      bank: Math.round((squad.bank || 0) * 10),
      clubCount: clubCount,
      taken: {},
      ft: ft0,
      score: 0,
      weeks: []
    };
  }

  /**
   * Applies the transfer engine's own suggestions as gameweek one, so the
   * plan starts from the move the rest of the page is recommending rather
   * than re-deriving a possibly different one.
   */
  function pinFirstWeek(node) {
    var moves = [];
    suggestions.forEach(function (s) {
      var slot = -1;
      for (var q = 0; q < node.state.length; q++) { if (node.state[q].id === s.outId) { slot = q; break; } }
      var cand = null;
      var bucket = poolByPos[node.state[slot] ? node.state[slot].elementType : 0] || [];
      for (var b = 0; b < bucket.length; b++) if (bucket[b].el.id === s.inId) { cand = bucket[b]; break; }
      // A suggested target can sit outside the pruned pool — the pool is
      // ranked on horizon points and a suggestion can be driven by this
      // week's fixture. Fall back to the full pool rather than dropping the
      // move and silently disagreeing with the section above.
      if (!cand) for (var f = 0; f < pool.length; f++) if (pool[f].el.id === s.inId) { cand = pool[f]; break; }
      if (slot === -1 || !cand) return;
      moves.push(applyRoadmapMove_(node, { slot: slot, cand: cand, gain: s.projectedGain }, teamsById));
    });

    var xi = bestXiXp_(node.state, 0);
    var hits = Math.max(0, moves.length - ft0);
    node.score += xi - hits * TRANSFER_HIT_COST;
    node.weeks.push({
      event: eventIds[0],
      freeTransfers: ft0,
      action: moves.length ? 'transfer' : 'roll',
      moves: moves,
      hits: hits,
      note: moves.length ? null : 'No move clears the bar this gameweek.',
      squadXp: Math.round(xi * 10) / 10,
      bank: Math.round(node.bank) / 10,
      _state: node.state.slice()
    });
    node.ft = Math.max(1, Math.min(MAX_BANKED_TRANSFERS, ft0 - moves.length + 1));
    return node;
  }

  /** Beam search from `startIdx` to the end of the horizon. */
  function search(seed, startIdx) {
    var beam = [seed];
    for (var idx = startIdx; idx < eventIds.length; idx++) {
      var next = [];
      for (var b = 0; b < beam.length; b++) {
        next = next.concat(expandRoadmapNode_(beam[b], idx, eventIds[idx], poolByPos, teamsById, churn));
      }
      next.sort(function (a, b2) { return b2.score - a.score; });
      beam = next.slice(0, ROADMAP_BEAM_WIDTH);
      if (!beam.length) break;
    }
    return beam[0] || seed;
  }

  var pinned = (suggestions && suggestions.length)
    ? search(pinFirstWeek(rootNode()), 1)
    : search(rootNode(), 0);

  // The same search with gameweek one unpinned. Not a second recommendation —
  // a measurement of what the recommended move costs the rest of the horizon,
  // which is the one thing a single-week transfer engine cannot tell you.
  var divergence = null;
  if (suggestions && suggestions.length) {
    var free = safeCall_(function () { return search(rootNode(), 0); });
    if (free && free.score - pinned.score >= ROADMAP_DIVERGENCE_MIN) {
      var freeFirst = free.weeks[0];
      divergence = {
        gain: Math.round((free.score - pinned.score) * 10) / 10,
        action: freeFirst.action,
        moves: freeFirst.moves,
        summary: freeFirst.action === 'roll'
          ? 'Planned over all ' + eventIds.length + ' gameweeks, holding this week and moving later is worth ' +
            (Math.round((free.score - pinned.score) * 10) / 10).toFixed(1) +
            ' points more than the transfer recommended above. The recommendation is scored on this week; this is scored on the horizon.'
          : 'Planned over all ' + eventIds.length + ' gameweeks, ' +
            freeFirst.moves.map(function (m) { return m.inName + ' for ' + m.outName; }).join(' and ') +
            ' is worth ' + (Math.round((free.score - pinned.score) * 10) / 10).toFixed(1) +
            ' points more than the transfer recommended above.'
      };
    }
  }

  /* The eleven and captain each week of the plan implies. This week's is a
   * firm call; later weeks are provisional — they assume the plan is
   * followed and nobody new gets injured — and their captain is the highest
   * mean in the eleven, because the full armband simulation is too costly to
   * run for every week of the window on a page load. */
  var topCaptain = (captainSuggestions || [])[0];
  var weeks = pinned.weeks.map(function (w, i) {
    var copy = {};
    Object.keys(w).forEach(function (k) { if (k !== '_state') copy[k] = w[k]; });
    if (w._state) {
      copy.xi = bestXiPicks_(w._state, i);
      if (i === 0 && topCaptain && copy.xi.players.some(function (p) { return p.name === topCaptain.name; })) {
        copy.xi.captain = { name: topCaptain.name, xp: Math.round((topCaptain.xp || 0) * 10) / 10, basis: 'simulated' };
      }
      copy.xi.provisional = i > 0;
    }
    return copy;
  });
  return {
    horizonGws: eventIds.length,
    weeks: weeks,
    fixtureSwings: buildFixtureSwings_(fixtureEase, squad),
    totalPlannedMoves: weeks.reduce(function (s, w) { return s + w.moves.length; }, 0),
    totalHits: weeks.reduce(function (s, w) { return s + (w.hits || 0); }, 0),
    // The plan's own objective: best-legal-XI points across the horizon, net
    // of hits. It is what every branch was ranked on, so it belongs on the
    // page rather than only in the search.
    plannedXp: Math.round(pinned.score * 10) / 10,
    beamWidth: ROADMAP_BEAM_WIDTH,
    poolPerPosition: ROADMAP_POOL_PER_POSITION,
    divergence: divergence
  };
}

/**
 * Where each of the manager's clubs turns — the run-of-fixtures change that
 * decides WHEN a transfer is worth making, not just whether. Compares the
 * first half of the lookahead window against the second for every club in
 * the squad, and reports only the clubs that actually move.
 */
var FIXTURE_SWING_MIN = 0.6; // FDR points of change worth mentioning

function buildFixtureSwings_(fixtureEase, squad) {
  var seen = {};
  var swings = [];

  squad.players.forEach(function (p) {
    if (seen[p.teamId]) return;
    seen[p.teamId] = true;
    var fe = fixtureEase[p.teamId];
    if (!fe || !fe.eventIds || fe.eventIds.length < 4) return;

    var half = Math.floor(fe.eventIds.length / 2);
    function avgOver(ids) {
      var diffs = [];
      ids.forEach(function (evId) {
        (fe.fixturesByEvent[evId] || []).forEach(function (f) { diffs.push(f.difficulty); });
      });
      return diffs.length ? diffs.reduce(function (s, d) { return s + d; }, 0) / diffs.length : null;
    }
    var before = avgOver(fe.eventIds.slice(0, half));
    var after = avgOver(fe.eventIds.slice(half));
    if (before == null || after == null) return;
    var delta = before - after; // positive = fixtures get easier
    if (Math.abs(delta) < FIXTURE_SWING_MIN) return;

    swings.push({
      club: fe.shortName,
      before: Math.round(before * 10) / 10,
      after: Math.round(after * 10) / 10,
      turnsAt: fe.eventIds[half],
      direction: delta > 0 ? 'easier' : 'harder',
      players: squad.players.filter(function (q) { return q.teamId === p.teamId; })
        .map(function (q) { return q.name; })
    });
  });

  swings.sort(function (a, b) { return Math.abs(b.before - b.after) - Math.abs(a.before - a.after); });
  return swings;
}

/* ===================== CAPTAIN SUGGESTIONS ===================== */

/**
 * Captaincy was this app's worst call by a distance — 5.3% of gameweeks in
 * backtesting had the suggested captain as the actual top scorer — and the
 * reason was visible in six lines of code: the pick was `form × six-week
 * average fixture ease`, and nothing else. That formula could not see the
 * fixture actually being played this week, could not tell home from away,
 * did not know a double gameweek existed, ignored penalties, ignored
 * minutes, and ignored the game's own projection.
 *
 * This version prices the one gameweek in front of the manager: that
 * gameweek's actual fixture(s), home or away, doubled where a team plays
 * twice, times availability and start likelihood, on top of the blended
 * base rate. It also reports the MARGIN over the next-best option, because
 * the honest answer most weeks is that the top two are within a point of
 * each other and the pick is close to a coin flip — which the old single
 * ranked list never admitted.
 */
/* ===================== SCORING DISTRIBUTIONS =====================
 *
 * Every model above this point predicts a MEAN. That is the right quantity
 * for a transfer — you hold a player for six gameweeks and the average is
 * what you collect — and it is the wrong quantity for the armband.
 *
 * Captaincy is a max-of-distribution problem. The question is not "who scores
 * most on average", it is "who is most likely to be the one who goes big",
 * and FPL points are lumpy enough that those are different players. A
 * midfielder who returns 5 or 6 almost every week has a higher mean than a
 * forward who blanks twice and then hauls 15, and the forward wins the
 * armband far more often. Ranking on mean systematically prefers the
 * metronome in the one decision where the tail is the entire point — which
 * is the mechanism behind this app's own worst measured number, a captain
 * hit rate below what picking at random from the XI would produce.
 *
 * So this section models the SHAPE of a player's scoring, not just its
 * centre:
 *
 *   - The shape comes from his own recent match log — the actual points he
 *     scored in each of his last dozen appearances, which the assistant's
 *     `getElementSummary_` already fetches and caches. It is his real
 *     distribution, skew and all, not an assumed one.
 *   - The LEVEL comes from the existing xP model, which knows about this
 *     week's fixture, home advantage, doubles, blanks and availability. The
 *     shape is rescaled so its mean matches that projection.
 *
 * Splitting it this way matters: the match log knows how a player scores but
 * nothing about Saturday's opponent, and the xP model knows the opponent but
 * nothing about the shape. Neither is sufficient alone.
 *
 * A player with too short a log (a new signing, the opening weeks of a
 * season) falls back to a positional template — keepers tight, forwards
 * long-tailed — which is a weaker assumption honestly applied rather than a
 * refusal to answer.
 */
/* Shared with the assistant's per-player lookup, which reads the same cached
 * summaries: one entry serves both, so the match log a manager asks about in
 * the chat is the same data the armband was decided on. */
var AI_HISTORY_MAX_MATCHES = 12;     // appearances kept per player
var ELEMENT_SUMMARY_CACHE_TTL = 900; // 15 min — a match log only changes when a match finishes

var DIST_SIMS = 4000;             // draws per captaincy simulation
var DIST_MIN_MATCHES = 5;         // appearances before a player's own log beats the template
var DIST_MAX_MATCHES = 12;
var ELEMENT_SUMMARY_BATCH = 30;   // players fetched per fetchAll round

/* Positional fallback shapes: representative points-per-APPEARANCE samples,
 * ordered by how long-tailed the position really is. Only their shape is
 * used — every one is rescaled to whatever mean the xP model projects — so
 * what these encode is the ratio of a big week to a quiet one, which is what
 * separates a keeper from a forward.
 */
var DIST_TEMPLATES = {
  1: [2, 2, 2, 3, 3, 6, 6, 2, 3, 8],        // GKP — appearance plus saves, clean sheets, rare haul
  2: [1, 2, 2, 2, 2, 6, 6, 1, 9, 2],        // DEF — the clean sheet is the event
  3: [2, 2, 2, 3, 5, 2, 9, 2, 12, 3],       // MID — returns arrive in chunks
  4: [2, 2, 2, 6, 2, 12, 2, 8, 2, 2]        // FWD — blanks and hauls, little in between
};

/**
 * Element summaries for many players at once.
 *
 * One at a time this is a network call per player and a captaincy decision
 * needs eleven of them; issued together through `UrlFetchApp.fetchAll` they
 * run concurrently, which is the difference between ~5s and ~500ms on the
 * dashboard's request path. Already-cached ids never reach the network.
 */
function fetchElementSummaries_(ids) {
  var out = {};
  var missing = [];

  ids.forEach(function (id) {
    var cached = safeCall_(function () { return CacheService.getScriptCache().get('ELSUM_' + id); });
    var parsed = cached ? safeCall_(function () { return JSON.parse(cached); }) : null;
    if (parsed) out[id] = parsed;
    else if (missing.indexOf(id) === -1) missing.push(id);
  });
  if (!missing.length) return out;

  for (var start = 0; start < missing.length; start += ELEMENT_SUMMARY_BATCH) {
    var batch = missing.slice(start, start + ELEMENT_SUMMARY_BATCH);
    var responses = safeCall_(function () {
      return UrlFetchApp.fetchAll(batch.map(function (id) {
        return {
          url: BASE + '/element-summary/' + id + '/',
          muteHttpExceptions: true,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FPLCommandCenter/1.0)' }
        };
      }));
    });
    if (!responses) continue;

    for (var i = 0; i < responses.length; i++) {
      if (responses[i].getResponseCode() !== 200) continue;
      var body = safeCall_(function () { return JSON.parse(responses[i].getContentText()); });
      if (!body) continue;
      var slim = slimElementSummary_(body);
      out[batch[i]] = slim;
      safeCall_(function () {
        CacheService.getScriptCache().put('ELSUM_' + batch[i], JSON.stringify(slim), ELEMENT_SUMMARY_CACHE_TTL);
      });
    }
  }
  return out;
}

/**
 * Points a player actually scored in the appearances on record, newest last.
 * Matches he did not feature in are excluded deliberately: this is the shape
 * of a performance, and the separate question of whether he plays at all is
 * already priced by the xP model's availability and starter factors. Mixing
 * the two here would count the same discount twice.
 */
function appearancePoints_(summary) {
  if (!summary || !summary.history) return [];
  return summary.history
    .filter(function (h) { return (h.minutes || 0) > 0; })
    .map(function (h) { return h.total_points || 0; })
    .slice(-DIST_MAX_MATCHES);
}

/**
 * A player's scoring distribution for one gameweek.
 *
 * Returns { samples, playRate, source }. `samples` is a conditional-on-playing
 * set of point outcomes whose mean has been rescaled to `targetXp / playRate`,
 * so that once the (1 - playRate) chance of a blank is folded in, the
 * unconditional mean lands back on exactly the xP the rest of the app quotes.
 * The simulation and the headline number can never disagree.
 */
function buildDistribution_(el, summary, targetXp, playRate) {
  var own = appearancePoints_(summary);
  var usingOwn = own.length >= DIST_MIN_MATCHES;
  var shape = usingOwn ? own : (DIST_TEMPLATES[el.element_type] || DIST_TEMPLATES[3]);

  var shapeMean = shape.reduce(function (s, v) { return s + v; }, 0) / shape.length;
  var p = Math.max(0.05, Math.min(1, playRate || 1));
  var conditionalTarget = targetXp / p;

  // Rescaling multiplies every sample by one constant, which moves the mean
  // onto the target while leaving the coefficient of variation — the shape,
  // the thing the log is actually evidence for — untouched.
  var factor = shapeMean > 0 ? conditionalTarget / shapeMean : 0;
  return {
    samples: shape.map(function (v) { return v * factor; }),
    playRate: p,
    source: usingOwn ? 'log' : 'template',
    matches: own.length
  };
}

/**
 * Deterministic PRNG (mulberry32). The simulation must give the same answer
 * for the same gameweek every time it runs: an armband recommendation that
 * changed on every page refresh, because the noise landed differently, would
 * be worthless however sound the model behind it. Seeded from the gameweek
 * so it does move when the week does.
 */
function seededRandom_(seed) {
  var a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One draw: a blank if he does not feature, otherwise a sample from his shape. */
function drawPoints_(dist, rand) {
  if (rand() > dist.playRate) return 0;
  return dist.samples[Math.floor(rand() * dist.samples.length)] || 0;
}

/**
 * Mean of the worst (or best) `q` share of a sorted sample — a conditional
 * tail expectation.
 *
 * A single percentile was the obvious thing to reach for and is the wrong
 * tool: it reads one point off the distribution, so a player who hauls in a
 * quarter of his weeks can have his entire upside sit just past whatever
 * cutoff you picked, and the number reports none of it. The tail MEAN
 * integrates over everything past the cutoff instead, which is both stabler
 * against exactly that boundary effect and directly sayable in English —
 * "on your worst weeks this costs you 6 points, on your best it gains 14"
 * is a sentence; "the 25th percentile is −6" is not.
 */
function tailMean_(sorted, q, upper) {
  if (!sorted.length) return 0;
  var count = Math.max(1, Math.round(q * sorted.length));
  var slice = upper ? sorted.slice(sorted.length - count) : sorted.slice(0, count);
  return slice.reduce(function (s, v) { return s + v; }, 0) / slice.length;
}

/* ===================== CAPTAINCY =====================
 *
 * Three different questions get confused here constantly, and the old model
 * answered none of them cleanly:
 *
 *   1. Which captain maximises my POINTS? The highest mean. Provably. If FPL
 *      were scored in the absolute this section would be one `sort` and there
 *      would be nothing else to say.
 *   2. Which captain is most likely to be my best pick in hindsight? The
 *      highest P(tops the XI) — a tail question, and a different answer.
 *   3. Which captain maximises my RANK? Neither of the above. Rank moves on
 *      the difference between your score and the field's, so the quantity
 *      that matters is the distribution of (your captain − their captain),
 *      doubled. Captaining the same player as everyone else has an expected
 *      rank effect of zero however many points he scores.
 *
 * FPL is a rank game, so (3) is the real objective, and it is now computable:
 * the effective-ownership work gives the actual captaincy shares of the
 * manager's rivals, from their real picks. The field's captain is simulated
 * as a mixture over those shares, every candidate is simulated against it,
 * and the delta distribution is what gets ranked.
 *
 * That is also what finally gives the risk setting a real meaning here. It
 * used to be a ±10% nudge on a mean, which is not a risk preference, just a
 * thumb on a scale. Now it selects WHICH PART of the delta distribution to
 * optimise:
 *
 *   safe        the 25th percentile — protect the floor, accept a lower
 *               ceiling; the template captain usually wins this
 *   balanced    the mean — straight expected rank movement
 *   aggressive  the 75th percentile — chase the week that gains rank,
 *               accept the weeks that lose it
 *
 * Reported alongside, always: the mean (so the points-maximising pick is
 * never hidden), P(tops your XI), and P(beats the field). When the ordering
 * by risk preference disagrees with the ordering by mean, the page says so —
 * that disagreement IS the decision, and burying it would be the same
 * mistake as printing a confident ranking of near-identical options.
 *
 * Known simplification: draws are independent across players. Real returns
 * correlate — teammates share a clean sheet, a team having a good day lifts
 * all of its attackers — so P(tops the XI) is a little overconfident for a
 * squad stacked on one club. The delta-versus-field figures that drive the
 * recommendation are far less sensitive to this, since they turn on one
 * player against one player.
 */
var CAPTAIN_PENALTY_EDGE = 1.05;   // first-choice penalty taker
/* Which part of the delta distribution each risk setting optimises. `null`
 * means the mean — straight expected rank movement. The tail share is the
 * fraction of weeks a floor or ceiling figure averages over. */
var CAPTAIN_TAIL_SHARE = 0.25;
var CAPTAIN_RISK_MODE = { safe: 'floor', balanced: 'mean', aggressive: 'ceiling' };
var CAPTAIN_MAX_CANDIDATES = 6;    // simulated in full; the rest cannot win from their mean

/**
 * Simulates every plausible armband against the field's.
 *
 * `fieldShares` is [{ id, weight }] summing to at most 1 — the fraction of
 * rivals captaining each player. Any remainder is treated as rivals whose
 * captain is unknown, modelled by the most-captained player, which is the
 * conservative reading: it assumes the unseen part of the field is templatey.
 */
function simulateCaptaincy_(candidates, fieldDists, fieldShares, seed) {
  var rand = seededRandom_(seed);
  var n = candidates.length;
  if (!n) return [];

  var topCount = [], beatField = [], deltaSums = [], deltas = [];
  for (var c = 0; c < n; c++) { topCount.push(0); beatField.push(0); deltaSums.push(0); deltas.push([]); }

  var haveField = fieldShares && fieldShares.length;

  for (var s = 0; s < DIST_SIMS; s++) {
    // One draw of the whole XI, shared across every candidate in this
    // iteration: each candidate must be judged against the SAME week, or the
    // comparison is between different simulated universes.
    var drawn = [];
    for (var i = 0; i < n; i++) drawn.push(drawPoints_(candidates[i].dist, rand));

    var best = 0;
    for (var b = 1; b < n; b++) if (drawn[b] > drawn[best]) best = b;
    topCount[best]++;

    if (haveField) {
      // Which player the field captained this week, then how he did.
      var roll = rand();
      var acc = 0, pickId = fieldShares[0].id;
      for (var f = 0; f < fieldShares.length; f++) {
        acc += fieldShares[f].weight;
        if (roll <= acc) { pickId = fieldShares[f].id; break; }
      }
      var fieldPts = fieldDists[pickId] ? drawPoints_(fieldDists[pickId], rand) : 0;

      for (var k = 0; k < n; k++) {
        // Doubled on both sides: this is the swing in captain points alone,
        // which is the only part of the two scores that differs by choice.
        var d = (drawn[k] - fieldPts) * 2;
        deltaSums[k] += d;
        deltas[k].push(d);
        if (drawn[k] > fieldPts) beatField[k]++;
      }
    }
  }

  return candidates.map(function (cand, i) {
    var sorted = haveField ? deltas[i].slice().sort(function (a, b) { return a - b; }) : [];
    return {
      index: i,
      topShare: topCount[i] / DIST_SIMS,
      beatFieldShare: haveField ? beatField[i] / DIST_SIMS : null,
      deltaMean: haveField ? deltaSums[i] / DIST_SIMS : null,
      deltaFloor: haveField ? tailMean_(sorted, CAPTAIN_TAIL_SHARE, false) : null,
      deltaCeiling: haveField ? tailMean_(sorted, CAPTAIN_TAIL_SHARE, true) : null
    };
  });
}

/** Captaincy shares across the manager's rivals, from their real picks. */
function fieldCaptainShares_(leagueEo) {
  if (!leagueEo || leagueEo.unavailable || !(leagueEo.captainShares || []).length) return null;
  var shares = leagueEo.captainShares
    .filter(function (r) { return r.captained > 0; })
    .sort(function (a, b) { return b.captained - a.captained; })
    .slice(0, 8)
    .map(function (r) { return { id: r.id, name: r.name, weight: r.captained / 100 }; });
  if (!shares.length) return null;

  var total = shares.reduce(function (s, r) { return s + r.weight; }, 0);
  if (total < 1) {
    // Rivals outside the top few captains, or ones whose pick did not resolve.
    // Folding the remainder into the most-captained player keeps the field
    // more templatey than it really is, which understates a differential's
    // edge rather than overstating it — the safe direction to be wrong in.
    shares[0].weight += (1 - total);
  } else if (total > 1) {
    shares = shares.map(function (r) { return { id: r.id, name: r.name, weight: r.weight / total }; });
  }
  return shares;
}

function suggestCaptain_(squad, fixtureEase, riskAppetite, leagueEo, eventId) {
  var starters = squad.starting.filter(function (p) {
    var gw = p.xp && p.xp.perGw && p.xp.perGw[0];
    return gw && gw.fixtures > 0; // a blank gameweek is not a captaincy option
  });
  if (!starters.length) starters = squad.starting.slice();

  // Mean ordering decides who gets simulated. A player five points of mean
  // behind cannot make that up on shape, so simulating the whole XI would
  // spend draws on players who cannot win.
  var byMean = starters.slice().sort(function (a, b) {
    return (b.xp ? b.xp.next : 0) - (a.xp ? a.xp.next : 0);
  }).slice(0, CAPTAIN_MAX_CANDIDATES);

  var fieldShares = fieldCaptainShares_(leagueEo);
  var summaryIds = byMean.map(function (p) { return p.id; });
  (fieldShares || []).forEach(function (f) {
    if (summaryIds.indexOf(f.id) === -1) summaryIds.push(f.id);
  });

  var summaries = safeCall_(function () { return fetchElementSummaries_(summaryIds); }) || {};

  var candidates = byMean.map(function (p) {
    var xp = p.xp || { next: 0, perGw: [], availability: 1, starter: 1 };
    var playRate = Math.max(0.05, Math.min(1, (xp.availability != null ? xp.availability : 1) *
      (xp.starter != null ? xp.starter : 1)));
    var el = { element_type: p.elementType };
    return {
      pick: p,
      dist: buildDistribution_(el, summaries[p.id], xp.next, playRate)
    };
  });

  // The field's captains need distributions too, and they are rarely all in
  // the manager's own squad.
  var fieldDists = {};
  (fieldShares || []).forEach(function (f) {
    var own = candidates.filter(function (c) { return c.pick.id === f.id; })[0];
    if (own) { fieldDists[f.id] = own.dist; return; }
    var meta = leagueEo.captainSharesById && leagueEo.captainSharesById[f.id];
    if (!meta) { fieldDists[f.id] = null; return; }
    fieldDists[f.id] = buildDistribution_(
      { element_type: meta.elementType },
      summaries[f.id],
      meta.xpNext,
      Math.max(0.05, Math.min(1, meta.playRate || 1)));
  });

  // Seeded on the gameweek, so the answer is stable across page loads. A
  // captain recommendation that changed every time you hit Refresh, because
  // the noise landed differently, would be worthless however good the model.
  var sim = simulateCaptaincy_(candidates, fieldDists, fieldShares, (eventId || 1) * 7919);

  var mode = CAPTAIN_RISK_MODE[riskAppetite] || CAPTAIN_RISK_MODE.balanced;

  var scored = candidates.map(function (cand, i) {
    var p = cand.pick;
    var xp = p.xp || { next: 0, perGw: [] };
    var gw = xp.perGw && xp.perGw[0];
    var fixtures = gw ? gw.fixtures : 0;
    var opponents = gw && gw.opponents.length ? gw.opponents.join(' + ') : 'no fixture';
    var onPens = p.penaltiesOrder === 1;
    var s = sim[i];

    // Penalties are a real edge on the tail rather than on the mean — the
    // model's own log already contains any spot-kicks he has taken, so this
    // stays a light tie-break rather than a second helping of the same fact.
    var penEdge = onPens ? CAPTAIN_PENALTY_EDGE : 1;

    var rankScore;
    if (s.deltaMean == null) rankScore = xp.next * penEdge;              // no league read — fall back to points
    else if (mode === 'floor') rankScore = s.deltaFloor * penEdge;       // safe: how bad are the bad weeks
    else if (mode === 'ceiling') rankScore = s.deltaCeiling * penEdge;   // aggressive: how good are the good ones
    else rankScore = s.deltaMean * penEdge;                              // balanced: expected rank movement

    var bits = [];
    if (fixtures === 0) bits.push('Blank gameweek — no fixture, do not captain.');
    else if (fixtures > 1) bits.push('Double gameweek (' + opponents + ').');
    else bits.push(opponents + ' this week.');
    bits.push('Projects ' + xp.next.toFixed(1) + ' pts (doubled: ' + (xp.next * 2).toFixed(1) + ').');
    bits.push('Tops your eleven in ' + Math.round(s.topShare * 100) + '% of simulations.');
    if (s.beatFieldShare != null) {
      bits.push('Outscores your league’s captain ' + Math.round(s.beatFieldShare * 100) + '% of the time — ' +
        'on your worst weeks that is ' + s.deltaFloor.toFixed(1) + ' pts against the field, on your best ' +
        (s.deltaCeiling >= 0 ? '+' : '') + s.deltaCeiling.toFixed(1) + '.');
    }
    if (cand.dist.source === 'log') {
      bits.push('Shape taken from his last ' + cand.dist.matches + ' appearances.');
    } else {
      bits.push('Too few appearances on record — shape assumed from position.');
    }
    if (onPens) bits.push('First-choice penalty taker.');
    if (p.selectedBy >= 30) bits.push('Owned by ' + p.selectedBy.toFixed(0) + '% — the template pick.');
    else if (p.selectedBy <= 10) bits.push('Only ' + p.selectedBy.toFixed(1) + '% owned — a genuine differential.');
    if (p.chanceOfPlaying != null && p.chanceOfPlaying !== 100) bits.push(p.chanceOfPlaying + '% chance of playing.');

    return {
      name: p.name,
      team: p.team,
      form: p.form,
      nextFixture: opponents,
      fixtures: fixtures,
      xp: Math.round(xp.next * 100) / 100,
      xpDoubled: Math.round(xp.next * 200) / 100,
      ownership: p.selectedBy,
      onPens: onPens,
      topShare: Math.round(s.topShare * 1000) / 10,
      beatFieldShare: s.beatFieldShare == null ? null : Math.round(s.beatFieldShare * 1000) / 10,
      deltaMean: s.deltaMean == null ? null : Math.round(s.deltaMean * 100) / 100,
      deltaFloor: s.deltaFloor == null ? null : Math.round(s.deltaFloor * 100) / 100,
      deltaCeiling: s.deltaCeiling == null ? null : Math.round(s.deltaCeiling * 100) / 100,
      distSource: cand.dist.source,
      distMatches: cand.dist.matches,
      score: rankScore,
      reason: bits.join(' ')
    };
  });

  var byMeanOrder = scored.slice().sort(function (a, b) { return b.xp - a.xp; });
  scored.sort(function (a, b) { return b.score - a.score; });

  var top = scored.slice(0, 3);
  top.forEach(function (c, i) {
    // The margin is now stated in the currency the pick was actually made in:
    // the gap in simulated chance of topping the eleven, not a difference of
    // means that the ranking may not even have used.
    c.margin = i === 0 && scored.length > 1
      ? Math.round((scored[0].xp - scored[1].xp) * 100) / 100
      : null;
    c.topShareMargin = i === 0 && scored.length > 1
      ? Math.round((scored[0].topShare - scored[1].topShare) * 10) / 10
      : null;
  });

  if (top.length) {
    var m = top[0].topShareMargin;
    top[0].confidence = m == null ? 'Low'
      : (m >= 12 ? 'Clear' : (m >= 5 ? 'Slight edge' : 'Coin flip'));
    // When optimising for rank picks someone other than the points-maximising
    // player, that disagreement is the whole decision and belongs on the page.
    if (byMeanOrder.length && byMeanOrder[0].name !== top[0].name) {
      top[0].disagreesWithMean = {
        name: byMeanOrder[0].name,
        xp: byMeanOrder[0].xp,
        note: byMeanOrder[0].name + ' projects more points (' + byMeanOrder[0].xp.toFixed(1) + ' against ' +
          top[0].xp.toFixed(1) + '), but ' + top[0].name +
          (mode === 'floor'
            ? ' gives up less on your worst weeks, which is what Safe optimises for.'
            : (mode === 'ceiling'
                ? ' gains more on your best weeks, which is what Aggressive optimises for.'
                : ' moves your rank further, because fewer of your rivals have the armband on him.'))
      };
    }
    top[0].basis = fieldShares
      ? 'Ranked on simulated rank movement against your league’s actual captains.'
      : 'Ranked on projected points — no league captaincy data available to compare against.';
  }
  return top;
}

/* ===================== STARTING XI ===================== */

/**
 * The weekly decision the app never made. It read the manager's starting XI
 * and bench, scored every one of those fifteen players, and then said
 * nothing at all about whether the right eleven were starting — even when
 * its own numbers said a bench player out-projected a starter.
 *
 * Searches every legal formation (1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD) for the
 * highest-projecting valid XI, then reports the swaps against what is
 * currently set. Blank gameweeks fall out of this for free: a player with
 * no fixture projects zero and is benched automatically.
 */
var FORMATIONS = (function () {
  var out = [];
  for (var d = 3; d <= 5; d++) {
    for (var m = 2; m <= 5; m++) {
      for (var f = 1; f <= 3; f++) {
        if (d + m + f === 10) out.push({ 2: d, 3: m, 4: f });
      }
    }
  }
  return out;
})();

/** Whether a player can be fielded at all this gameweek. */
function startable_(p) {
  if (p.status === 'i' || p.status === 's' || p.status === 'u' || p.status === 'n') return false;
  if (p.chanceOfPlaying === 0) return false;
  return true;
}

function optimiseLineup_(squad) {
  var byPos = { 1: [], 2: [], 3: [], 4: [] };
  squad.players.forEach(function (p) {
    if (byPos[p.elementType]) byPos[p.elementType].push(p);
  });
  // Injured, suspended and unavailable players go to the back of their
  // position whatever they project, so they start only when nobody else can.
  // Their xP is usually near zero anyway; this makes it a rule rather than a
  // consequence of how the availability discount happens to round.
  Object.keys(byPos).forEach(function (k) {
    byPos[k].sort(function (a, b) {
      var sa = startable_(a) ? 1 : 0, sb = startable_(b) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return (b.xp ? b.xp.next : 0) - (a.xp ? a.xp.next : 0);
    });
  });
  if (!byPos[1].length) return null;

  var best = null;
  FORMATIONS.forEach(function (shape) {
    if (byPos[2].length < shape[2] || byPos[3].length < shape[3] || byPos[4].length < shape[4]) return;
    var xi = [byPos[1][0]]
      .concat(byPos[2].slice(0, shape[2]))
      .concat(byPos[3].slice(0, shape[3]))
      .concat(byPos[4].slice(0, shape[4]));
    var total = xi.reduce(function (s, p) { return s + (p.xp ? p.xp.next : 0); }, 0);
    if (!best || total > best.total) {
      best = { total: total, xi: xi, shape: shape };
    }
  });
  if (!best) return null;

  var bestIds = {};
  best.xi.forEach(function (p) { bestIds[p.id] = true; });
  var currentIds = {};
  squad.starting.forEach(function (p) { currentIds[p.id] = true; });

  var bringIn = best.xi.filter(function (p) { return !currentIds[p.id]; })
    .sort(function (a, b) { return b.xp.next - a.xp.next; });
  var dropOut = squad.starting.filter(function (p) { return !bestIds[p.id]; })
    .sort(function (a, b) { return a.xp.next - b.xp.next; });

  // Pair like for like FIRST. Naively zipping the two lists (best incoming
  // against worst outgoing) produced swaps that read as nonsense whenever
  // the optimal shape differed from the current one — a midfielder shown as
  // replacing a goalkeeper, and individual "gains" that came out negative
  // even though the eleven as a whole projected higher. Same-position swaps
  // are a straight comparison and get a gain figure; anything left over is a
  // formation change and is reported as one, without a misleading per-player
  // delta attached to it.
  var changes = [];
  var remainingOut = dropOut.slice();
  bringIn.slice().forEach(function (p) {
    var matchIdx = -1;
    for (var i = 0; i < remainingOut.length; i++) {
      if (remainingOut[i].elementType === p.elementType) { matchIdx = i; break; }
    }
    if (matchIdx === -1) return;
    var outP = remainingOut.splice(matchIdx, 1)[0];
    bringIn.splice(bringIn.indexOf(p), 1);
    changes.push({
      inName: p.name, inTeam: p.team, inPosition: p.position,
      inXp: Math.round(p.xp.next * 100) / 100,
      outName: outP.name, outTeam: outP.team, outPosition: outP.position,
      outXp: Math.round(outP.xp.next * 100) / 100,
      gain: Math.round((p.xp.next - outP.xp.next) * 100) / 100,
      reason: (p.xp.perGw[0] && p.xp.perGw[0].fixtures === 0)
        ? 'No fixture — do not start.'
        : ((outP.xp.perGw[0] && outP.xp.perGw[0].fixtures === 0)
          ? outP.name + ' has no fixture this gameweek.'
          : (outP.xp.availability < 0.6
            ? outP.name + ' is an availability risk.'
            : p.name + ' projects ' + Math.round((p.xp.next - outP.xp.next) * 10) / 10 + ' pts more this week.'))
    });
  });

  var currentShape = { 2: 0, 3: 0, 4: 0 };
  squad.starting.forEach(function (p) { if (currentShape[p.elementType] !== undefined) currentShape[p.elementType]++; });
  var currentFormation = currentShape[2] + '-' + currentShape[3] + '-' + currentShape[4];
  var bestFormation = best.shape[2] + '-' + best.shape[3] + '-' + best.shape[4];

  var currentTotal = squad.starting.reduce(function (s, p) { return s + (p.xp ? p.xp.next : 0); }, 0);

  // Bench order matters on its own: autosubs come on in listed order, so a
  // wrongly-ordered bench quietly costs points whenever a starter is a late
  // withdrawal — an entirely free gain the app was not surfacing. The spare
  // keeper is listed separately rather than as "4th", because it can only
  // ever sub for the other keeper and is not part of the 1-2-3 order.
  var benched = squad.players.filter(function (p) { return !bestIds[p.id]; });
  var benchGk = benched.filter(function (p) { return p.elementType === 1; })
    .map(function (p) { return { name: p.name, team: p.team, xp: Math.round(p.xp.next * 100) / 100 }; })[0] || null;
  var benchOrder = benched.filter(function (p) { return p.elementType !== 1; })
    .sort(function (a, b) { return b.xp.next - a.xp.next; })
    .map(function (p, i) {
      return { order: i + 1, name: p.name, team: p.team, position: p.position, xp: Math.round(p.xp.next * 100) / 100 };
    });

  /* The validity pass on the eleven the manager has actually SET. Run before
   * anything is rendered, so a starter who cannot play is the first thing
   * said rather than something to be inferred from a small xP figure. */
  var xiWarnings = [];
  squad.starting.forEach(function (p) {
    var benchedByUs = !bestIds[p.id];
    var noFixture = p.xp && p.xp.perGw && p.xp.perGw[0] && p.xp.perGw[0].fixtures === 0;
    if (!startable_(p)) {
      xiWarnings.push({ id: p.id, name: p.name, severity: 'unavailable', status: p.status,
        text: p.name + ' is ' + (STATUS_LABEL[p.status] || 'unavailable').toLowerCase() +
          (p.news ? ' (' + p.news + ')' : '') + ' and in your starting eleven' +
          (benchedByUs ? ' — bench him.' : ' — and nobody fit can cover his position.') });
    } else if (noFixture) {
      xiWarnings.push({ id: p.id, name: p.name, severity: 'unavailable', status: p.status,
        text: p.name + ' has no fixture this gameweek and is in your starting eleven.' });
    } else if (p.rotation && (p.rotation.risk === 'rotation' || p.rotation.risk === 'benched')) {
      xiWarnings.push({ id: p.id, name: p.name, severity: 'rotation', status: p.status,
        text: p.name + ': ' + p.rotation.text.replace(/^Started/, 'started') +
          (benchedByUs ? ' The recommended eleven benches him.' : ' He still starts in the recommended eleven — nobody fit on your bench projects more.') });
    } else if (p.status === 'd') {
      var pct = p.chanceOfPlaying != null ? p.chanceOfPlaying + '%' : 'a doubt';
      xiWarnings.push({ id: p.id, name: p.name, severity: 'doubt', status: p.status,
        text: p.name + ' is ' + pct + (p.chanceOfPlaying != null ? ' to play' : '') +
          (benchedByUs
            ? ' — the recommended eleven benches him.'
            : ' — he still starts in the recommended eleven: his discounted ' + p.xp.next.toFixed(1) +
              ' beats every fit alternative on your bench.') });
    }
  });

  return {
    // The recommended eleven as ids, so the weekly grading can score exactly
    // this XI rather than reconstructing it from the display-name swaps
    // (which silently missed any player moved by a formation change).
    xiIds: best.xi.map(function (p) { return p.id; }),
    xiWarnings: xiWarnings,
    // The recommended eleven itself, by position, so it can be shown as a
    // team sheet rather than only as the swaps from the one that is set.
    xi: best.xi.map(function (p) {
      return { id: p.id, name: p.name, team: p.team, position: p.position, elementType: p.elementType,
        status: p.status, xp: Math.round(p.xp.next * 100) / 100 };
    }),
    formation: bestFormation,
    currentFormation: currentFormation,
    formationChanged: bestFormation !== currentFormation,
    projected: Math.round(best.total * 10) / 10,
    currentProjected: Math.round(currentTotal * 10) / 10,
    gain: Math.round((best.total - currentTotal) * 10) / 10,
    changes: changes,
    // Left over after like-for-like pairing: these exist only because the
    // shape itself changes, so they are presented as a formation move.
    formationIn: bringIn.map(function (p) {
      return { name: p.name, team: p.team, position: p.position, xp: Math.round(p.xp.next * 100) / 100 };
    }),
    formationOut: remainingOut.map(function (p) {
      return { name: p.name, team: p.team, position: p.position, xp: Math.round(p.xp.next * 100) / 100 };
    }),
    benchGk: benchGk,
    benchOrder: benchOrder
  };
}

/* ===================== OWNERSHIP EDGE ===================== */

/**
 * Rank in FPL is a relative game, and this app was playing it as an absolute
 * one: `selected_by_percent` sat unused in every player row while the
 * dashboard optimised purely for raw points. But a 60%-owned striker you do
 * not own costs you rank every week he scores whether or not your own
 * forward outscores him, and a 3%-owned midfielder is the only way to gain
 * rank rather than hold it. This section names both — the template you are
 * exposed to, and the differentials you actually have.
 */
var TEMPLATE_OWNERSHIP = 25;    // owned by this % or more = template
var DIFFERENTIAL_OWNERSHIP = 8; // owned by this % or less = differential

function buildOwnershipEdge_(bootstrap, fixtureEase, squad) {
  var squadIds = {};
  squad.players.forEach(function (p) { squadIds[p.id] = true; });
  var teamsById = {};
  bootstrap.teams.forEach(function (t) { teamsById[t.id] = t; });

  var template = bootstrap.elements
    .filter(function (el) {
      return (parseFloat(el.selected_by_percent) || 0) >= TEMPLATE_OWNERSHIP && el.status === 'a';
    })
    .sort(function (a, b) { return parseFloat(b.selected_by_percent) - parseFloat(a.selected_by_percent); });

  var owned = template.filter(function (el) { return squadIds[el.id]; });
  var missing = template.filter(function (el) { return !squadIds[el.id]; })
    .slice(0, 5)
    .map(function (el) {
      var xp = projectPoints_(el, fixtureEase);
      return {
        name: el.web_name,
        team: teamsById[el.team] ? teamsById[el.team].short_name : '?',
        position: POSITION_MAP[el.element_type],
        price: el.now_cost / 10,
        ownership: parseFloat(el.selected_by_percent) || 0,
        xpNext: Math.round(xp.next * 100) / 100
      };
    });

  var differentials = squad.players
    .filter(function (p) { return p.selectedBy <= DIFFERENTIAL_OWNERSHIP && p.isStarting; })
    .sort(function (a, b) { return b.xp.next - a.xp.next; })
    .map(function (p) {
      return {
        name: p.name, team: p.team, position: p.position,
        ownership: p.selectedBy,
        xpNext: Math.round(p.xp.next * 100) / 100
      };
    });

  var exposure = missing.reduce(function (s, m) { return s + m.xpNext; }, 0);
  var coverage = template.length ? Math.round((owned.length / template.length) * 100) : null;

  var summary;
  if (!template.length) {
    summary = 'No player is owned by ' + TEMPLATE_OWNERSHIP + '% or more yet — there is no template to be exposed to this early.';
  } else if (!missing.length) {
    summary = 'You own every template player. Your rank will track the average closely — safe, but it means only your differentials can move you up.';
  } else {
    summary = 'You own ' + owned.length + ' of the ' + template.length + ' template players. The ' + missing.length +
      ' you are missing project ' + exposure.toFixed(1) + ' pts between them this week — that is your rank downside if they all deliver.';
  }

  return {
    coverage: coverage,
    templateSize: template.length,
    ownedCount: owned.length,
    missing: missing,
    differentials: differentials,
    exposure: Math.round(exposure * 10) / 10,
    summary: summary
  };
}

/* ===================== EFFECTIVE OWNERSHIP =====================
 *
 * `selected_by_percent` is the whole game's ownership of a player — every
 * manager, benched or started, captained or not. Two things make it the
 * wrong number for judging rank risk:
 *
 *   1. It counts squad membership, not deployment. A player owned by 40%
 *      and benched by most of them costs you very little to miss.
 *   2. It ignores captaincy, which is where the points actually swing. A
 *      player on 30% ownership captained by two thirds of his owners hurts
 *      twice as much as the number suggests.
 *
 * Effective Ownership is the fix, and it is exactly computable from picks:
 * every manager's pick carries a `multiplier` (0 benched, 1 started, 2
 * captain, 3 triple captain), so
 *
 *     EO% = 100 × Σ multiplier ÷ number of managers
 *
 * is not an estimate — it is the field's real exposure, chips included.
 *
 * The field this measures is the manager's own mini-league rather than the
 * global top 10k, for two reasons. The public API does not publish a
 * captaincy distribution at any rank tier, so a global EO could only ever
 * be guessed at; and the league standings endpoint plus one picks call per
 * rival gives the exact answer for the table the manager is actually
 * trying to win. Rank against 11 million strangers is an abstraction; rank
 * against the twelve people in your league is the game.
 *
 * Cost is one HTTP call per rival, issued together through
 * `UrlFetchApp.fetchAll` so they run concurrently rather than serially —
 * the difference between ~600ms and ~15s for a 24-manager league. A
 * finished gameweek's picks are immutable, so the computed table is cached
 * under its event id and the fetches happen once per gameweek per league.
 *
 * A caveat the UI has to carry: picks are only readable AFTER a deadline
 * passes, so this is the field's exposure in the gameweek being PLAYED,
 * used as the best available read on the one being picked for. That is a
 * real approximation, and the section says so rather than implying the
 * rivals have already made next week's moves.
 */
var LEAGUE_EO_MAX_ENTRIES = 24;   // rivals fetched — the top of the table is who you are chasing
var LEAGUE_EO_CACHE_TTL = 21600;  // 6h; a locked gameweek's picks never change
var LEAGUE_EO_MIN_ENTRIES = 3;    // below this the percentages are noise, not a field
var EO_TEMPLATE_THRESHOLD = 50;   // EO at or above this = you are betting against the room by not owning
var EO_THREAT_THRESHOLD = 15;     // field EO worth naming as a threat when you do not own him
/* Percentage points of exposure you must hold OVER the field before a player
 * is your edge rather than just someone you happen to own. It has to be this
 * high: your own multiplier is 100 for a starter, so a low bar would qualify
 * every starter the field holds below that bar — which is most of the squad,
 * and calling all of them differentials says nothing. At 50 a starter counts
 * only below 50% field EO, while a captain (200) counts against a field that
 * captains him up to 150 — which is the right asymmetry, because the armband
 * is where the exposure actually is. */
var EO_EDGE_THRESHOLD = 50;

/**
 * Every rival's picks for one locked gameweek, fetched concurrently.
 * Returns [{ entryId, name, picks: [{element, multiplier}] }]; entries whose
 * fetch failed are dropped rather than counted as empty squads, which would
 * silently deflate every EO figure.
 */
function fetchRivalPicks_(entries, eventId) {
  if (!entries.length) return [];
  var requests = entries.map(function (e) {
    return {
      url: BASE + '/entry/' + e.entryId + '/event/' + eventId + '/picks/',
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FPLCommandCenter/1.0)' }
    };
  });

  var responses = safeCall_(function () { return UrlFetchApp.fetchAll(requests); });
  if (!responses) return [];

  var out = [];
  for (var i = 0; i < responses.length; i++) {
    if (responses[i].getResponseCode() !== 200) continue;
    var body = safeCall_(function () { return JSON.parse(responses[i].getContentText()); });
    if (!body || !body.picks) continue;
    out.push({ entryId: entries[i].entryId, name: entries[i].name, picks: body.picks });
  }
  return out;
}

/**
 * Effective ownership across the manager's mini-league, and what it means
 * for their own rank — the "safety vs ceiling" read.
 *
 * `rivals` excludes the manager themselves: EO is the exposure of the field
 * you are being measured against, and including your own squad in it would
 * flatter every player you already own.
 */
function buildLeagueEo_(bootstrap, fixtureEase, squad, miniLeague, teamId, eventId) {
  if (!miniLeague || !eventId) return null;

  var rivals = (miniLeague.entries || []).filter(function (e) {
    return String(e.entryId) !== String(teamId);
  }).slice(0, LEAGUE_EO_MAX_ENTRIES);
  if (rivals.length < LEAGUE_EO_MIN_ENTRIES) {
    return {
      unavailable: 'Only ' + rivals.length + ' other manager' + (rivals.length === 1 ? '' : 's') +
        ' in this league — effective ownership needs at least ' + LEAGUE_EO_MIN_ENTRIES +
        ' to mean anything. Pick a bigger league to see it.'
    };
  }

  var cacheKey = 'EO_' + miniLeague.leagueId + '_' + eventId + '_' + rivals.length;
  var cached = safeCall_(function () { return CacheService.getScriptCache().get(cacheKey); });
  var table = cached ? safeCall_(function () { return JSON.parse(cached); }) : null;

  if (!table) {
    var picksByRival = fetchRivalPicks_(rivals, eventId);
    if (picksByRival.length < LEAGUE_EO_MIN_ENTRIES) return null;

    // multiplierSum drives EO; squadCount is raw ownership, kept separate so
    // the UI can show a player who is widely owned but widely benched for
    // what he is — a non-threat this week.
    var agg = {};
    picksByRival.forEach(function (r) {
      r.picks.forEach(function (p) {
        var row = agg[p.element] || (agg[p.element] = { multiplierSum: 0, squadCount: 0, captainCount: 0 });
        row.multiplierSum += (p.multiplier || 0);
        row.squadCount += 1;
        if ((p.multiplier || 0) >= 2) row.captainCount += 1;
      });
    });

    table = { n: picksByRival.length, agg: agg };
    safeCall_(function () {
      CacheService.getScriptCache().put(cacheKey, JSON.stringify(table), LEAGUE_EO_CACHE_TTL);
    });
  }

  var n = table.n;
  var agg = table.agg;
  var elementsById = {};
  bootstrap.elements.forEach(function (el) { elementsById[el.id] = el; });
  var teamsById = {};
  bootstrap.teams.forEach(function (t) { teamsById[t.id] = t; });

  function eoFor(elementId) {
    var row = agg[elementId];
    if (!row) return { eo: 0, owned: 0, captained: 0 };
    return {
      eo: Math.round((row.multiplierSum / n) * 1000) / 10,
      owned: Math.round((row.squadCount / n) * 1000) / 10,
      captained: Math.round((row.captainCount / n) * 1000) / 10
    };
  }

  // Your own multiplier per player, from your actual picks — a captain you
  // own at 2x against a field EO of 90 is still a differential the other way.
  var mine = {};
  squad.players.forEach(function (p) {
    mine[p.id] = p.isStarting ? (p.isCaptain ? 2 : 1) : 0;
  });

  // Every player either side owns, scored by the swing he represents:
  //   delta = (your multiplier − field EO) × his expected points
  // Positive means he gains you rank if he returns; negative means he costs
  // you rank if he does. This is the whole risk position in one number.
  var considered = {};
  Object.keys(agg).forEach(function (id) { considered[id] = true; });
  squad.players.forEach(function (p) { considered[p.id] = true; });

  var rows = Object.keys(considered).map(function (id) {
    var el = elementsById[id];
    if (!el) return null;
    var e = eoFor(id);
    var xp = projectPoints_(el, fixtureEase);
    var myMult = mine[id] || 0;
    return {
      id: Number(id),
      name: el.web_name,
      team: teamsById[el.team] ? teamsById[el.team].short_name : '?',
      position: POSITION_MAP[el.element_type],
      price: el.now_cost / 10,
      eo: e.eo,
      owned: e.owned,
      captained: e.captained,
      globalOwnership: parseFloat(el.selected_by_percent) || 0,
      mine: myMult,
      xpNext: Math.round(xp.next * 100) / 100,
      delta: Math.round((myMult - e.eo / 100) * xp.next * 100) / 100
    };
  }).filter(function (r) { return r && (r.eo > 0 || r.mine > 0); });

  // Threats: the field is heavily exposed and you are not. Sorted by what it
  // costs you, not by ownership — a 90% EO player with a blank fixture is not
  // the problem a 55% EO player at home to the bottom club is.
  var threats = rows.filter(function (r) { return r.mine === 0 && r.eo >= EO_THREAT_THRESHOLD; })
    .sort(function (a, b) { return a.delta - b.delta; })
    .slice(0, 6);

  // Edges: you are more exposed than the field, by ownership or by armband.
  var edges = rows.filter(function (r) { return r.mine > 0 && r.mine * 100 - r.eo >= EO_EDGE_THRESHOLD; })
    .sort(function (a, b) { return b.delta - a.delta; })
    .slice(0, 6);

  var downside = threats.reduce(function (s, r) { return s + r.delta; }, 0);
  var upside = edges.reduce(function (s, r) { return s + r.delta; }, 0);
  var net = rows.reduce(function (s, r) { return s + r.delta; }, 0);

  // Template coverage measured against the field that matters, not the game.
  var leagueTemplate = rows.filter(function (r) { return r.eo >= EO_TEMPLATE_THRESHOLD; });
  var templateOwned = leagueTemplate.filter(function (r) { return r.mine > 0; });

  // Who the rivals actually captained, and enough about each to simulate his
  // week. This is the input the captaincy model needs to answer "does this
  // pick move my rank" rather than only "does this pick score points" — and
  // it exists only because the picks were fetched anyway for the EO table.
  var captainShares = [];
  var captainSharesById = {};
  Object.keys(agg).forEach(function (id) {
    var r = agg[id];
    if (!r.captainCount) return;
    var el = elementsById[id];
    if (!el) return;
    var xp = projectPoints_(el, fixtureEase);
    var share = {
      id: Number(id),
      name: el.web_name,
      captained: Math.round((r.captainCount / n) * 1000) / 10,
      elementType: el.element_type,
      xpNext: xp.next,
      playRate: Math.max(0.05, Math.min(1, (xp.availability || 1) * (xp.starter || 1)))
    };
    captainShares.push(share);
    captainSharesById[share.id] = share;
  });
  captainShares.sort(function (a, b) { return b.captained - a.captained; });

  var stance;
  if (net > 4) stance = 'aggressive';
  else if (net < -4) stance = 'exposed';
  else stance = 'balanced';

  var summary;
  if (stance === 'exposed') {
    summary = 'You are behind the field on paper: your league is ' + Math.abs(Math.round(net * 10) / 10) +
      ' expected points more exposed to this gameweek than you are. That is a safe position if the template blanks and a losing one if it delivers.';
  } else if (stance === 'aggressive') {
    summary = 'You are ahead of the field by ' + (Math.round(net * 10) / 10) +
      ' expected points of exposure — you gain on the league in a good week and lose ground in a bad one.';
  } else {
    summary = 'Your exposure tracks the league closely (' + (net >= 0 ? '+' : '') + (Math.round(net * 10) / 10) +
      ' expected points). Rank will move on the margins, not on any one player.';
  }

  return {
    leagueId: miniLeague.leagueId,
    leagueName: miniLeague.leagueName,
    eventId: eventId,
    managersCounted: n,
    threats: threats,
    edges: edges,
    downside: Math.round(downside * 10) / 10,
    upside: Math.round(upside * 10) / 10,
    net: Math.round(net * 10) / 10,
    stance: stance,
    templateSize: leagueTemplate.length,
    templateOwned: templateOwned.length,
    captainShares: captainShares,
    captainSharesById: captainSharesById,
    summary: summary,
    // Stated, not buried: picks are only public after a deadline, so this is
    // last locked gameweek's field applied to next gameweek's fixtures.
    basis: 'Computed from ' + n + ' rivals’ actual GW' + eventId + ' picks. Rivals’ next-gameweek squads are not public until that deadline passes.'
  };
}

/* ===================== CHIP VALUE =====================
 *
 * Chips were the last thing on this page decided by counting rather than by
 * arithmetic. Three flagged players suggested a Wildcard; ANY ONE player with
 * a double gameweek — the fifteenth man included — produced "a strong Triple
 * Captain candidate". Meanwhile every other section had been converted to
 * expected points precisely so that decisions could be compared against each
 * other and against a −4.
 *
 * The odd thing is that nothing new had to be computed. A chip is worth the
 * difference between the gameweek you play it in and the same gameweek
 * without it, and every input for that difference was already being produced:
 *
 *   Bench Boost     your bench's projected points that week. That is the
 *                   whole chip — nothing else changes.
 *   Triple Captain  one extra helping of your captain. On the mean that is
 *                   his xP; what actually makes a Triple Captain memorable is
 *                   his ceiling, which the captaincy simulation now models,
 *                   so both are reported.
 *   Free Hit        the best legal eleven you could field from the whole
 *                   player pool that week, minus what your own eleven
 *                   projects. Blank gameweeks fall out for free: a squad with
 *                   six players not playing has a terrible baseline, so the
 *                   difference is large exactly when it should be.
 *   Wildcard        what the squad you would build is worth against the squad
 *                   you have, over the whole horizon rather than one week —
 *                   a Wildcard is a structural move, not a gameweek move.
 *
 * Every figure below is in points, so "hold" and "play now" stop being
 * opinions and become a comparison. Where a chip's value is below the bar,
 * the board says what it is waiting for in the same unit.
 */
var CHIP_BENCH_BOOST_BAR = 14;   // points on the bench before the chip is worth burning
var CHIP_TRIPLE_CAPTAIN_BAR = 8; // extra captain points before it beats saving the chip
var CHIP_FREE_HIT_BAR = 12;      // points over your own XI
var CHIP_WILDCARD_BAR = 15;      // horizon points over the current squad

/** Points a set of players projects in one specific gameweek index. */
function xpAtIndex_(players, idx) {
  return players.reduce(function (s, p) {
    var gw = p.xp && p.xp.perGw && p.xp.perGw[idx];
    return s + (gw ? gw.xp : 0);
  }, 0);
}

/**
 * Bench Boost: the bench's own projection, which is exactly what the chip
 * pays. The best week to play it is simply the week that number is highest.
 */
function valueBenchBoost_(squad, eventIds) {
  var best = null;
  eventIds.forEach(function (evId, idx) {
    var value = xpAtIndex_(squad.bench, idx);
    if (!best || value > best.value) best = { eventId: evId, idx: idx, value: value };
  });
  if (!best) return null;
  var thisWeek = xpAtIndex_(squad.bench, 0);
  return {
    bestEvent: best.eventId,
    bestValue: Math.round(best.value * 10) / 10,
    thisWeek: Math.round(thisWeek * 10) / 10,
    detail: 'Your bench projects ' + best.value.toFixed(1) + ' points in GW' + best.eventId +
      (best.idx === 0 ? ' — this week' : '') + '.'
  };
}

/**
 * Triple Captain: one more helping of the armband. Reported on both the mean
 * and the ceiling, because they answer different questions — the mean is what
 * it is worth on average, the ceiling is the week people actually play it for.
 */
function valueTripleCaptain_(squad, captainSuggestions, eventIds) {
  var top = (captainSuggestions || [])[0];
  if (!top) return null;

  var holder = squad.starting.filter(function (p) { return p.name === top.name; })[0];
  var best = null;
  if (holder && holder.xp && holder.xp.perGw) {
    holder.xp.perGw.forEach(function (gw, idx) {
      if (!best || gw.xp > best.value) best = { eventId: eventIds[idx], idx: idx, value: gw.xp, fixtures: gw.fixtures };
    });
  }
  var thisWeek = top.xp || 0;
  var peak = best ? best.value : thisWeek;

  return {
    name: top.name,
    bestEvent: best ? best.eventId : (eventIds[0] || null),
    bestValue: Math.round(peak * 10) / 10,
    thisWeek: Math.round(thisWeek * 10) / 10,
    isDouble: !!(best && best.fixtures > 1),
    // The extra captain points the simulation says a good week delivers — the
    // reason anyone holds this chip for a double rather than spending it on a
    // decent single fixture.
    ceiling: top.deltaCeiling != null ? Math.round((top.deltaCeiling / 2 + peak) * 10) / 10 : null,
    detail: 'A third helping of ' + top.name + ' is worth ' + peak.toFixed(1) + ' points in GW' +
      (best ? best.eventId : eventIds[0]) + (best && best.fixtures > 1 ? ', where he plays twice' : '') + '.'
  };
}

/**
 * Free Hit: the best legal eleven available from the entire player pool for
 * one gameweek, against what your own eleven projects for it.
 *
 * The squad is unconstrained by budget for the comparison — a Free Hit squad
 * still has to fit the budget in reality, so this is an upper bound and the
 * board says so. What it is genuinely good at is finding the blank: your own
 * baseline collapses when six of your players have no fixture, and the gap
 * opens up on its own without any rule about counting blanks.
 */
/* A chip is worth the difference between playing it and not playing it.
 *
 * Both of these valuations used to compare against something else. The Free
 * Hit measured the best eleven IN THE GAME — no budget, no three-per-club, a
 * team nobody could field — against the eleven you happen to have set, and
 * reported the difference as the chip's value. That number is an upper bound
 * on an upper bound: the chip cannot buy you an illegal squad, and not
 * playing it does not oblige you to leave a bad lineup alone. The Wildcard
 * summed all FIFTEEN projections on each side, which prices four players who
 * will not take the pitch and rewards a rebuild for stacking a strong bench.
 *
 * Both now compare best-legal-XI against best-legal-XI, and both baselines
 * are the best you could do WITHOUT the chip — because the lineup is free.
 */

/** The single-gameweek projection for one player, as a score for the builder. */
function gwScorer_(fixtureEase, idx) {
  return function (el) {
    var xp = projectPoints_(el, fixtureEase);
    var gw = xp.perGw[idx];
    return gw ? gw.xp : 0;
  };
}

/* Building a legal fifteen is the expensive part of the Free Hit valuation,
 * so it is not run for every gameweek in the horizon. The cheap unconstrained
 * ceiling ranks the candidate weeks first, and only the most promising few
 * get a real squad built for them — a week whose ceiling is low cannot have a
 * high floor. */
var FREE_HIT_WEEKS_COSTED = 2;

function valueFreeHit_(bootstrap, fixtureEase, squad, eventIds) {
  // Pass one: the unconstrained ceiling per gameweek. Cheap, and only used to
  // decide which weeks are worth costing properly.
  var ranked = eventIds.map(function (evId, idx) {
    var byPos = { 1: [], 2: [], 3: [], 4: [] };
    bootstrap.elements.forEach(function (el) {
      if (el.status !== 'a') return;
      var gw = projectPoints_(el, fixtureEase).perGw[idx];
      if (!gw || !gw.xp) return;
      var bucket = byPos[el.element_type];
      if (bucket) bucket.push(gw.xp);
    });
    var desc = function (a, b) { return b - a; };
    Object.keys(byPos).forEach(function (k) { byPos[k].sort(desc); byPos[k] = byPos[k].slice(0, 6); });
    return { eventId: evId, idx: idx, ceiling: bestXiFromPools_(byPos) };
  }).filter(function (r) { return r.ceiling > 0; });

  if (!ranked.length) return null;
  ranked.sort(function (a, b) { return b.ceiling - a.ceiling; });

  var budget = (squad.teamValue != null ? squad.teamValue : 100) + (squad.bank || 0);
  var best = null;

  ranked.slice(0, FREE_HIT_WEEKS_COSTED).forEach(function (cand) {
    // What the chip actually buys: the best eleven from a legal fifteen you
    // could really assemble at your budget, for this one gameweek.
    var fh = safeCall_(function () {
      return suggestInitialSquad_(bootstrap, fixtureEase, budget, gwScorer_(fixtureEase, cand.idx));
    });
    if (!fh || !fh.players || !fh.complete) return;
    var withChip = bestXiXp_(fh.players, cand.idx);
    // The counterfactual is your own best legal eleven, not whatever eleven is
    // currently set — you can reorder the lineup for nothing.
    var withoutChip = bestXiXp_(squad.players, cand.idx);
    var gain = withChip - withoutChip;
    if (!best || gain > best.gain) {
      best = { eventId: cand.eventId, idx: cand.idx, gain: gain, ideal: withChip, mine: withoutChip, ceiling: cand.ceiling };
    }
  });

  if (!best) return null;
  return {
    bestEvent: best.eventId,
    gain: Math.round(best.gain * 10) / 10,
    ideal: Math.round(best.ideal * 10) / 10,
    mine: Math.round(best.mine * 10) / 10,
    ceiling: Math.round(best.ceiling * 10) / 10,
    detail: 'In GW' + best.eventId + ' your best legal eleven projects ' + best.mine.toFixed(1) +
      '; the best eleven a Free Hit could buy at your budget projects ' + best.ideal.toFixed(1) + '.'
  };
}

/**
 * Best legal XI given per-position pools of already-sorted projections.
 * Same structure as bestXiXp_, which works from player objects; this one
 * works from bare numbers because the Free Hit's ceiling pass never needs
 * the players.
 */
function bestXiFromPools_(byPos) {
  var total = 0, used = { 1: 0, 2: 0, 3: 0, 4: 0 }, slots = 11;
  [1, 2, 3, 4].forEach(function (k) {
    var need = Math.min(XI_MIN[k], byPos[k].length);
    for (var i = 0; i < need; i++) { total += byPos[k][i]; used[k]++; slots--; }
  });
  var rest = [];
  [1, 2, 3, 4].forEach(function (k) {
    for (var i = used[k]; i < byPos[k].length && i < XI_MAX[k]; i++) rest.push({ pos: k, xp: byPos[k][i] });
  });
  rest.sort(function (a, b) { return b.xp - a.xp; });
  for (var r = 0; r < rest.length && slots > 0; r++) {
    if (used[rest[r].pos] >= XI_MAX[rest[r].pos]) continue;
    total += rest[r].xp;
    used[rest[r].pos]++;
    slots--;
  }
  return total;
}

/**
 * Wildcard: what a squad rebuilt from scratch is worth against the one you
 * have, measured over the whole horizon rather than one gameweek — a Wildcard
 * changes structure, and structure pays out over weeks.
 *
 * Scored on the best legal ELEVEN each gameweek, on both sides. Summing all
 * fifteen projections (which this did) counts a bench nobody fields and
 * flatters any rebuild that happens to buy four playable reserves; it is also
 * the reason the chip could report a gain in the hundreds. The roadmap search
 * has scored plans on the best legal XI since it was rebuilt, and this is the
 * same objective, so the two can no longer disagree about what a squad is
 * worth.
 */
function valueWildcard_(bootstrap, fixtureEase, squad, eventIds) {
  var budget = (squad.teamValue != null ? squad.teamValue : 100) + (squad.bank || 0);
  var rebuilt = safeCall_(function () { return suggestInitialSquad_(bootstrap, fixtureEase, budget); });
  if (!rebuilt || !rebuilt.players || !rebuilt.complete) return null;

  var xiHorizon = function (players) {
    var total = 0;
    for (var idx = 0; idx < eventIds.length; idx++) total += bestXiXp_(players, idx);
    return total;
  };
  var theirs = xiHorizon(rebuilt.players);
  var mine = xiHorizon(squad.players);
  if (!theirs || !mine) return null;

  return {
    gain: Math.round((theirs - mine) * 10) / 10,
    rebuilt: Math.round(theirs * 10) / 10,
    mine: Math.round(mine * 10) / 10,
    flagged: squad.players.filter(function (p) { return p.status !== 'a'; }).length,
    detail: 'A squad rebuilt at your budget starts ' + eventIds.length + ' elevens projecting ' +
      theirs.toFixed(1) + ' points in total; yours project ' + mine.toFixed(1) + '.'
  };
}

/** Every chip, priced. */
function buildChipValues_(bootstrap, fixtureEase, squad, captainSuggestions) {
  var anyFe = fixtureEase[squad.players[0] && squad.players[0].teamId] ||
    fixtureEase[Object.keys(fixtureEase)[0]];
  var eventIds = anyFe ? anyFe.eventIds : [];
  if (!eventIds.length) return null;

  return {
    eventIds: eventIds,
    benchBoost: safeCall_(function () { return valueBenchBoost_(squad, eventIds); }),
    tripleCaptain: safeCall_(function () { return valueTripleCaptain_(squad, captainSuggestions, eventIds); }),
    freeHit: safeCall_(function () { return valueFreeHit_(bootstrap, fixtureEase, squad, eventIds); }),
    wildcard: safeCall_(function () { return valueWildcard_(bootstrap, fixtureEase, squad, eventIds); })
  };
}

/* ===================== CHIP SUGGESTIONS ===================== */

/**
 * The prose chip notes that sit in the AI context and the evidence row.
 *
 * These used to be produced by counting — three flagged players, one player
 * with a double — and said things like "a strong Triple Captain candidate"
 * about a fifteenth man. They are now generated from the same point values
 * the board is built on, so the sentence and the number can never disagree,
 * and each one states what it would take to change the answer.
 */
function suggestChips_(bootstrap, fixtures, fixtureEase, squad, chipsUsed, events, chipValues) {
  var used = {};
  chipsUsed.forEach(function (c) { used[c.name] = (used[c.name] || 0) + 1; });

  var v = chipValues || {};
  var out = [];

  if (v.benchBoost && (used['bboost'] || 0) < 2) {
    var bb = v.benchBoost;
    out.push('Bench Boost: your bench peaks at ' + bb.bestValue.toFixed(1) + ' points in GW' + bb.bestEvent +
      (bb.bestValue >= CHIP_BENCH_BOOST_BAR
        ? ' — that clears its bar (whether to play it is the single chip decision above).'
        : ', below the ' + CHIP_BENCH_BOOST_BAR + ' points that make it worth burning. Hold.'));
  }

  if (v.tripleCaptain && (used['3xc'] || 0) < 2) {
    var tc = v.tripleCaptain;
    out.push('Triple Captain: a third helping of ' + tc.name + ' is worth ' + tc.bestValue.toFixed(1) +
      ' points in GW' + tc.bestEvent + (tc.isDouble ? ', where he plays twice' : '') +
      (tc.bestValue >= CHIP_TRIPLE_CAPTAIN_BAR ? ' — that clears the bar.' : ' — under the ' +
        CHIP_TRIPLE_CAPTAIN_BAR + ' points worth spending it on. Hold for a double.'));
  }

  if (v.freeHit && (used['freehit'] || 0) < 2) {
    var fh = v.freeHit;
    out.push('Free Hit: in GW' + fh.bestEvent + ' the best legal eleven your budget could buy projects ' +
      fh.ideal.toFixed(1) + ' against your own best legal eleven on ' + fh.mine.toFixed(1) +
      ' — a gain of ' + fh.gain.toFixed(1) +
      (fh.gain >= CHIP_FREE_HIT_BAR ? '. That clears the bar.' : ', under the ' + CHIP_FREE_HIT_BAR + ' worth spending it on.'));
  }

  if (v.wildcard && (used['wildcard'] || 0) < 2) {
    var wc = v.wildcard;
    out.push('Wildcard: a squad rebuilt at your budget fields elevens worth ' + wc.gain.toFixed(1) +
      ' points more than yours over the horizon' +
      (wc.flagged >= 3 ? ', and ' + wc.flagged + ' of your players are flagged' : '') +
      (wc.gain >= CHIP_WILDCARD_BAR ? ' — that clears the bar.' : '. Under the ' +
        CHIP_WILDCARD_BAR + ' points that justify it; hold.'));
  }

  if (!out.length) {
    out.push('No chip is worth playing right now, and none of them expire soon — hold all of them and reassess when a double or blank gameweek appears.');
  }
  return out;
}

/**
 * Five slots, each carrying what the chip is worth in points and what it is
 * waiting for in the same unit.
 *
 * The old board decided by counting — three flagged players, one player with
 * a double — which produced advice that could not be argued with because it
 * never stated a quantity. Every row now leads with a number that can be
 * compared against the bar, against the other chips, and against simply not
 * playing it.
 */
function buildChipBoard_(chipsUsed, fixtureEase, squad, events, decisionEvent, chipValues) {
  var usedByName = {};
  var wildcardUses = [];
  chipsUsed.forEach(function (c) {
    usedByName[c.name] = c;
    if (c.name === 'wildcard') wildcardUses.push(c);
  });
  wildcardUses.sort(function (a, b) { return a.event - b.event; });

  var v = chipValues || {};
  // The gameweek being PICKED FOR. "Play now" means this one — never the
  // gameweek currently being played, which cannot be changed.
  var thisEvent = decisionEvent ? decisionEvent.id : null;

  function used(key, label) {
    var u = usedByName[key];
    return u ? { label: label, status: 'Used', detail: 'Played in GW' + u.event + '.', value: null } : null;
  }

  /* One row. `value` is the chip's worth in points, `bar` the level it has to
   * clear, `bestEvent` the gameweek it peaks in. "Play now" means the peak is
   * this gameweek AND it clears the bar; anything else is a target or a hold,
   * and the detail says how far short it is rather than just "not yet". */
  function row(label, val, bar, unit) {
    if (!val) return { label: label, status: 'Hold', detail: 'Not enough fixture data yet to value this one.', value: null };
    var peak = val.bestValue != null ? val.bestValue : val.gain;
    var clears = peak >= bar;
    var isNow = val.bestEvent != null && thisEvent != null && String(val.bestEvent) === String(thisEvent);
    var status = clears ? (isNow ? 'Play now' : 'Target GW' + val.bestEvent) : 'Hold';
    var detail = val.detail;
    if (!clears) {
      detail += ' That is short of the ' + bar + ' ' + unit + ' worth spending a chip on — hold unless a better week appears.';
    } else if (!isNow) {
      detail += ' Worth ' + peak.toFixed(1) + ' there against ' +
        (val.thisWeek != null ? val.thisWeek.toFixed(1) : 'less') + ' this week.';
    }
    return {
      label: label, status: status, detail: detail,
      value: Math.round(peak * 10) / 10,
      bar: bar,
      bestEvent: val.bestEvent != null ? val.bestEvent : null
    };
  }

  var board = [];

  board.push(wildcardUses[0]
    ? { label: 'Wildcard 1', status: 'Used', detail: 'Played in GW' + wildcardUses[0].event + '.', value: null }
    : (function () {
        var w = v.wildcard;
        if (!w) return { label: 'Wildcard 1', status: 'Hold', detail: 'Cannot value a rebuild right now.', value: null };
        var clears = w.gain >= CHIP_WILDCARD_BAR;
        return {
          label: 'Wildcard 1',
          status: clears ? 'Play now' : 'Hold',
          value: w.gain,
          bar: CHIP_WILDCARD_BAR,
          detail: w.detail + ' That is ' + (w.gain >= 0 ? '+' : '') + w.gain.toFixed(1) + ' over the horizon' +
            (clears
              ? ' — enough structural gain to justify the reset.'
              : ', short of the ' + CHIP_WILDCARD_BAR + ' points that justify burning it.') +
            (w.flagged >= 3 ? ' ' + w.flagged + ' of your players are also flagged.' : '')
        };
      })());

  board.push(used('bboost', 'Bench Boost') ||
    row('Bench Boost', v.benchBoost, CHIP_BENCH_BOOST_BAR, 'points'));

  board.push(used('3xc', 'Triple Captain') ||
    (function () {
      var t = v.tripleCaptain;
      var r = row('Triple Captain', t, CHIP_TRIPLE_CAPTAIN_BAR, 'points');
      if (t && t.ceiling != null && r.value != null) {
        r.detail += ' On a good week the simulation puts that nearer ' + t.ceiling.toFixed(1) + '.';
      }
      return r;
    })());

  board.push(used('freehit', 'Free Hit') ||
    (function () {
      var f = v.freeHit;
      if (!f) return { label: 'Free Hit', status: 'Hold', detail: 'Cannot value a free hit right now.', value: null };
      var clears = f.gain >= CHIP_FREE_HIT_BAR;
      var isNow = thisEvent != null && String(f.bestEvent) === String(thisEvent);
      return {
        label: 'Free Hit',
        status: clears ? (isNow ? 'Play now' : 'Target GW' + f.bestEvent) : 'Hold',
        value: f.gain,
        bar: CHIP_FREE_HIT_BAR,
        bestEvent: f.bestEvent,
        // Both sides of this are now teams that could actually be fielded:
        // a legal fifteen at the manager's own budget against their own best
        // legal eleven. The unconstrained figure is still reported, but as
        // what it is — a ceiling — rather than as the chip's value.
        detail: f.detail + ' A gain of ' + f.gain.toFixed(1) +
          (clears ? ' is worth the chip.' : ' is under the ' + CHIP_FREE_HIT_BAR + ' points worth spending it on.') +
          (f.ceiling != null ? ' Ignoring budget entirely, the ceiling is ' + f.ceiling.toFixed(1) + '.' : '')
      };
    })());

  board.push(wildcardUses[1]
    ? { label: 'Wildcard 2', status: 'Used', detail: 'Played in GW' + wildcardUses[1].event + '.', value: null }
    : { label: 'Wildcard 2', status: 'Hold', value: null,
        detail: 'Second Wildcard opens after GW20 — reassess in the second half of the season.' });

  return resolveChipBoard_(board);
}

/* Chips are branches of one plan, not four independent offers.
 *
 * Each row above is priced on its own, and on its own each can clear its
 * bar — which is how the page came to call all four "worth playing" in the
 * same week, beside a six-week transfer plan that a Wildcard would make
 * meaningless. Only one chip can be played in a gameweek, so:
 *   - a value past the plausibility line is not a recommendation at all; it
 *     is a sign that a projection upstream is inflated, and it says so;
 *   - of what is left, only the chip that clears its bar by the most is
 *     "Play now", and the others say why they are waiting. */
var CHIP_IMPLAUSIBLE = { 'Wildcard 1': 'WILDCARD', 'Free Hit': 'FREE_HIT' };

function chipImplausibleLimit_(label) {
  if (CHIP_IMPLAUSIBLE[label] === 'WILDCARD') return WILDCARD_IMPLAUSIBLE_GAIN;
  if (CHIP_IMPLAUSIBLE[label] === 'FREE_HIT') return FREE_HIT_IMPLAUSIBLE_GAIN;
  return null;
}

function resolveChipBoard_(board) {
  board.forEach(function (r) {
    var limit = chipImplausibleLimit_(r.label);
    if (limit == null || r.value == null || r.value <= limit) return;
    if (r.status === 'Used') return;
    r.status = 'Check';
    r.implausible = true;
    r.detail += ' Not recommended: a gain of ' + r.value.toFixed(1) + ' is past the ' + limit +
      ' that any real ' + r.label.replace(/ \d+$/, '') + ' delivers, which means a projection upstream is inflated — ' +
      'see Model calibration before acting on it.';
  });

  var live = board.filter(function (r) { return r.status === 'Play now' && r.value != null && r.bar; });
  live.sort(function (a, b) { return (b.value - b.bar) - (a.value - a.bar); });
  live.slice(1).forEach(function (r) {
    r.status = 'Hold';
    r.detail += ' Only one chip can be played in a gameweek, and ' + live[0].label +
      ' clears its bar by more this week (' + (live[0].value - live[0].bar).toFixed(1) + ' against ' +
      (r.value - r.bar).toFixed(1) + ').';
  });
  return board;
}

/** The single chip call for the decision gameweek, with its reason. */
function buildChipDecision_(board) {
  var play = (board || []).filter(function (r) { return r.status === 'Play now'; })[0];
  if (!play) {
    var target = (board || []).filter(function (r) { return String(r.status).indexOf('Target') === 0; })[0];
    return {
      play: null,
      reason: 'Hold every chip this gameweek — none clears its bar now' +
        (target ? '; ' + target.label + ' peaks in GW' + target.bestEvent + '.' : '.')
    };
  }
  var replacesTransfers = /^Wildcard|^Free Hit/.test(play.label);
  return {
    play: play.label,
    value: play.value,
    bar: play.bar,
    replacesTransfers: replacesTransfers,
    reason: 'Play the ' + play.label.replace(/ \d+$/, '') + ': worth ' + play.value.toFixed(1) + ' against a bar of ' + play.bar +
      (replacesTransfers ? ', measured against following the transfer plan rather than against doing nothing — it replaces this week\'s transfers.' : '.')
  };
}

/**
 * Re-bases the Wildcard on the plan it would replace.
 *
 * The rebuild used to be compared against the current squad left untouched
 * for six weeks — a baseline nobody follows, since the roadmap above it is
 * already making transfers. The honest question is "Wildcard, or the plan",
 * so the baseline is whichever of the two is better: the squad as it is, or
 * the roadmap's points net of its hits.
 */
function rebaseWildcardOnPlan_(chipValues, roadmap) {
  var wc = chipValues && chipValues.wildcard;
  if (!wc || !roadmap || !(roadmap.weeks || []).length) return;
  var planPts = roadmap.weeks.reduce(function (sum, w) { return sum + (w.squadXp || 0) - (w.hits || 0) * TRANSFER_HIT_COST; }, 0);
  var squadOnly = wc.mine;
  var baseline = Math.max(squadOnly, planPts);
  wc.squadOnly = squadOnly;
  wc.planPoints = Math.round(planPts * 10) / 10;
  wc.mine = Math.round(baseline * 10) / 10;
  wc.gain = Math.round((wc.rebuilt - wc.mine) * 10) / 10;
  wc.baseline = planPts > squadOnly ? 'plan' : 'squad';
  wc.detail = 'A squad rebuilt at your budget projects ' + wc.rebuilt.toFixed(1) + ' over the horizon; ' +
    (wc.baseline === 'plan'
      ? 'following the transfer plan instead projects ' + wc.mine.toFixed(1) + ' after its hits.'
      : 'your squad as it stands projects ' + wc.mine.toFixed(1) + ', and the transfer plan does no better.');
}

/** Fixture difficulty grid rows for the user's own clubs, LOOKAHEAD_GWS columns. */
function buildFixtureGrid_(fixtureEase, squad, events, decisionEvent) {
  var clubIds = [];
  squad.players.forEach(function (p) {
    if (clubIds.indexOf(p.teamId) === -1) clubIds.push(p.teamId);
  });

  var eventIds = [];
  var fe0 = fixtureEase[clubIds[0]];
  if (fe0) eventIds = fe0.eventIds;

  var rows = clubIds.map(function (tid) {
    var fe = fixtureEase[tid];
    if (!fe) return null;
    var cells = eventIds.map(function (evId) {
      var fs = fe.fixturesByEvent[evId];
      if (!fs || !fs.length) return { label: '—', difficulty: 0 };
      return {
        label: fs.map(function (f) { return (f.home ? '' : '@') + f.opponentShort; }).join(' / '),
        difficulty: Math.round(fs.reduce(function (s, f) { return s + f.difficulty; }, 0) / fs.length)
      };
    });
    return { club: fe.shortName, avgDifficulty: fe.avgDifficulty, cells: cells };
  }).filter(Boolean);

  return { eventIds: eventIds, rows: rows };
}

/** Squad price movement this event — cyan for rises, magenta for falls. */
/* ===================== PRICE PRESSURE =====================
 *
 * The old price watch reported `cost_change_event` — a price change that has
 * ALREADY happened. That is history, and history is the one thing a manager
 * can do nothing about. The decision it should be informing is the opposite
 * one: buy him tonight, or lose 0.1 tomorrow.
 *
 * FPL never publishes the price-change algorithm, so nothing here can claim
 * to predict a change outright. What it can do is measure the pressure
 * behind one. Every element carries `transfers_in_event` and
 * `transfers_out_event`, and the threshold a player has to cross scales with
 * how many people already own him — so the meaningful quantity is not the
 * raw net transfer count but that count set against his own owner base:
 *
 *     pressure = (transfers_in − transfers_out) ÷ owners
 *
 * 60,000 net transfers into a 2%-owned punt is a stampede; the same number
 * into a 45%-owned premium is noise. Dividing by owners is what makes those
 * two comparable, and it is why a bare transfer count — which is all most
 * dashboards show — ranks them the wrong way round.
 *
 * Two honest limits, both stated on the page rather than buried here:
 *   - Counts accumulate across the whole gameweek while prices change
 *     nightly, so a player who has already moved this gameweek has spent
 *     some of the momentum still showing in his numbers. Those are marked
 *     as already moved instead of being double-counted as fresh pressure.
 *   - The bands below are calibrated by observation, not by the real
 *     threshold, so they read as pressure, never as a promise.
 */
var PRICE_PRESSURE_STRONG = 0.30;  // net transfers worth ~30% of the owner base — a move is likely
var PRICE_PRESSURE_BUILDING = 0.15;
var PRICE_MIN_OWNERS = 3000;       // floor: below this, percentages swing wildly on tiny absolute numbers
var PRICE_MARKET_MOVERS = 5;

/** Pressure band for one element, or null when nothing is moving. */
function pricePressureFor_(el, totalPlayers) {
  var net = (el.transfers_in_event || 0) - (el.transfers_out_event || 0);
  if (!net) return null;

  var owners = Math.max(((parseFloat(el.selected_by_percent) || 0) / 100) * (totalPlayers || 0), PRICE_MIN_OWNERS);
  var pressure = net / owners;
  var mag = Math.abs(pressure);
  if (mag < PRICE_PRESSURE_BUILDING) return null;

  var rising = pressure > 0;
  return {
    net: net,
    pressure: Math.round(pressure * 100) / 100,
    direction: rising ? 'rise' : 'fall',
    band: mag >= PRICE_PRESSURE_STRONG ? 'strong' : 'building',
    label: mag >= PRICE_PRESSURE_STRONG
      ? (rising ? 'Rising — likely tonight' : 'Falling — likely tonight')
      : (rising ? 'Rising — pressure building' : 'Falling — pressure building'),
    // A change already banked this gameweek means part of this momentum has
    // been spent; saying so is more useful than implying it is all still to come.
    alreadyMoved: (el.cost_change_event || 0) !== 0
  };
}

function priceRow_(el, teamsById, totalPlayers, why) {
  var p = pricePressureFor_(el, totalPlayers);
  if (!p) return null;
  return {
    id: el.id,
    name: el.web_name,
    team: teamsById[el.team] ? teamsById[el.team].short_name : '?',
    position: POSITION_MAP[el.element_type],
    price: el.now_cost / 10,
    net: p.net,
    pressure: p.pressure,
    direction: p.direction,
    band: p.band,
    label: p.label,
    alreadyMoved: p.alreadyMoved,
    changedThisEvent: (el.cost_change_event || 0) / 10,
    why: why
  };
}

/**
 * Three groups, in the order they cost or save you money:
 *   - targets  — a recommended buy about to rise is the only genuinely
 *                time-critical row on the page.
 *   - squad    — your own holdings gaining or bleeding value.
 *   - movers   — the rest of the market, for context.
 */
function buildPriceWatch_(squad, bootstrap, transferSuggestions) {
  var totalPlayers = bootstrap.total_players || 0;
  var teamsById = {};
  bootstrap.teams.forEach(function (t) { teamsById[t.id] = t; });

  var squadIds = {};
  squad.players.forEach(function (p) { squadIds[p.id] = true; });

  var targetIds = {};
  (transferSuggestions || []).forEach(function (t) { if (t.inId) targetIds[t.inId] = true; });

  var targets = [], mine = [], movers = [];
  bootstrap.elements.forEach(function (el) {
    if (targetIds[el.id]) {
      var tr = priceRow_(el, teamsById, totalPlayers, 'A recommended transfer in');
      if (tr) targets.push(tr);
    } else if (squadIds[el.id]) {
      var sr = priceRow_(el, teamsById, totalPlayers, 'In your squad');
      if (sr) mine.push(sr);
    } else if (el.status === 'a' && (parseFloat(el.selected_by_percent) || 0) >= 1) {
      var mr = priceRow_(el, teamsById, totalPlayers, 'Market');
      if (mr && mr.band === 'strong') movers.push(mr);
    }
  });

  function byPressure(a, b) { return Math.abs(b.pressure) - Math.abs(a.pressure); }
  targets.sort(byPressure);
  mine.sort(byPressure);
  movers.sort(byPressure);

  // The single most time-critical row, if there is one: a player you have
  // been told to buy who looks like rising before you can act.
  var urgent = targets.filter(function (t) {
    return t.direction === 'rise' && t.band === 'strong' && !t.alreadyMoved;
  })[0] || null;

  // Value already banked or lost this gameweek — the retrospective figure the
  // old section led with, kept because squad value is real, just demoted.
  var settled = squad.players
    .filter(function (p) { return p.priceChangeEvent && p.priceChangeEvent !== 0; })
    .map(function (p) {
      return { name: p.name, team: p.team, delta: p.priceChangeEvent, direction: p.priceChangeEvent > 0 ? 'rise' : 'fall' };
    })
    .sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });

  return {
    urgent: urgent,
    targets: targets,
    squad: mine,
    movers: movers.slice(0, PRICE_MARKET_MOVERS),
    settled: settled,
    netSquadChange: Math.round(settled.reduce(function (s, r) { return s + r.delta; }, 0) * 10) / 10
  };
}

/** Injury & rotation risk rows for the squad. */
function buildRiskWatch_(squad) {
  return squad.players
    .filter(function (p) { return p.status !== 'a'; })
    .map(function (p) {
      return {
        name: p.name, team: p.team,
        pill: STATUS_LABEL[p.status] || 'Flagged',
        news: p.news || 'No further detail from the FPL API.'
      };
    });
}

/** The user's own mini-league (first classic league on their entry), with their row flagged. */
function buildMiniLeague_(leagueId, teamId) {
  var standings = getLeagueStandings_(leagueId);
  var league = standings.league || {};
  var results = (standings.standings && standings.standings.results) || [];
  return {
    leagueId: leagueId,
    leagueName: league.name || ('League ' + leagueId),
    rows: results.slice(0, 10).map(function (r) {
      return {
        rank: r.rank, name: r.player_name, entryName: r.entry_name, total: r.total,
        isYou: String(r.entry) === String(teamId)
      };
    }),
    // The full entry list (not just the ten rows rendered) so effective
    // ownership can be computed against the whole table off this one fetch
    // rather than calling the standings endpoint a second time.
    entries: results.slice(0, LEAGUE_EO_MAX_ENTRIES + 1).map(function (r) {
      return { entryId: r.entry, name: r.player_name, entryName: r.entry_name, rank: r.rank };
    })
  };
}

/**
 * Which classic league to show in the Mini-league section. FPL auto-enrolls
 * every manager into broad system leagues (their favourite club, their
 * country, a "GW1" league, an overall bracket) alongside any private leagues
 * they've actually joined with friends — blindly using the first league in
 * the list (the old behaviour) usually surfaced one of those system leagues,
 * not the one the manager actually cares about. So this is a saved choice:
 * defaults to the smallest system league heuristically, but the app exposes
 * the full list (`availableLeagues`) so the manager can pick the right one
 * and it's remembered from then on via `saveMiniLeagueId`.
 */
function getSelectedLeagueId_(availableLeagues) {
  if (!availableLeagues.length) return null;
  var saved = PropertiesService.getScriptProperties().getProperty('MINI_LEAGUE_ID');
  if (saved && availableLeagues.some(function (l) { return String(l.id) === saved; })) {
    return saved;
  }
  return String(availableLeagues[0].id);
}

function saveMiniLeagueId(leagueId) {
  leagueId = String(leagueId).trim();
  if (!/^\d+$/.test(leagueId)) throw new Error('League ID must be a number.');
  PropertiesService.getScriptProperties().setProperty('MINI_LEAGUE_ID', leagueId);
  return { ok: true };
}

function formatDeadline_(iso) {
  try {
    var d = new Date(iso);
    return Utilities.formatDate(d, Session.getScriptTimeZone() || 'America/Los_Angeles', 'EEE MMM d, h:mm a');
  } catch (e) {
    return iso;
  }
}

/* ===================== PRE-SEASON: SUGGEST INITIAL SQUAD ===================== */

/**
 * A full 15-man opening squad, for the window before a real one is readable.
 *
 * This used to be one greedy pass ranked by points-per-million, which broke
 * badly on real price distributions: because a premium's score grows faster
 * than his price, the "best value" list is topped by the MOST expensive
 * players, so the greedy fill bought two £14m goalkeepers, ran out of money,
 * and returned an 8-man squad flagged `complete: false` that the page then
 * rendered as if it were advice. Its budget reserve (a flat £4.0m per unfilled
 * slot) was too crude to prevent it.
 *
 * Two passes instead, which cannot produce an illegal or incomplete squad:
 *
 *   1. Baseline — fill every slot with the cheapest available player for that
 *      position, respecting the three-per-club limit. Always affordable,
 *      always complete, and deliberately bad.
 *   2. Upgrade — repeatedly apply the single swap that buys the most extra
 *      score for the money still in the bank, until nothing affordable
 *      improves the squad.
 *
 * Unspent budget is worth nothing in FPL — it does not carry, it does not
 * compound — so the second pass converting leftover cash into squad quality
 * is the whole point, not a refinement.
 */
/**
 * A legal fifteen inside a budget: 2/5/5/3, at most three per club, spent
 * down from a cheapest-legal baseline by repeated best-value upgrades.
 *
 * `scoreFn` is what "best" means. It defaults to the app's general player
 * score (which weighs the whole horizon), and callers that care about one
 * specific gameweek — the Free Hit valuation — pass a function scoring that
 * gameweek alone. Without it a one-week chip was being valued off a six-week
 * ranking, which is a different question.
 */
function suggestInitialSquad_(bootstrap, fixtureEase, budgetMillions, scoreFn) {
  // Defaults to the £100.0m every manager starts with. The Wildcard valuation
  // passes the manager's ACTUAL budget instead — squad value plus bank — since
  // a wildcard rebuilds against what they have now, not against a fresh start.
  var BUDGET = budgetMillions != null ? Math.round(budgetMillions * 10) : 1000;
  var score = scoreFn || function (el) { return playerScore_(el, fixtureEase); };
  var needs = { 1: 2, 2: 5, 3: 5, 4: 3 };
  var maxPerClub = 3;
  var UPGRADE_PASSES = 60; // bounded — this runs inside a page load

  var scored = bootstrap.elements
    .filter(function (el) { return el.status === 'a' || el.status === 'd'; })
    .map(function (el) { return { el: el, score: score(el) }; });

  var cheapestByPos = {};
  var bestByPos = {};
  scored.forEach(function (c) {
    var p = c.el.element_type;
    (cheapestByPos[p] = cheapestByPos[p] || []).push(c);
  });
  Object.keys(cheapestByPos).forEach(function (p) {
    // Cheapest first for the baseline; a score-ordered copy for the upgrade
    // pass. Sorting each list once beats re-sorting inside the pass loop.
    cheapestByPos[p].sort(function (a, b) { return a.el.now_cost - b.el.now_cost; });
    bestByPos[p] = cheapestByPos[p].slice().sort(function (a, b) { return b.score - a.score; });
  });

  var squad = [];
  var spend = 0;
  var clubCount = {};
  var squadIds = {};
  var posCount = { 1: 0, 2: 0, 3: 0, 4: 0 };

  Object.keys(needs).forEach(function (posKey) {
    var pos = Number(posKey);
    var list = cheapestByPos[pos] || [];
    for (var i = 0; i < list.length && posCount[pos] < needs[pos]; i++) {
      var el = list[i].el;
      if (squadIds[el.id]) continue;
      if ((clubCount[el.team] || 0) >= maxPerClub) continue;
      squad.push(el);
      squadIds[el.id] = true;
      spend += el.now_cost;
      clubCount[el.team] = (clubCount[el.team] || 0) + 1;
      posCount[pos]++;
    }
  });

  var complete = Object.keys(needs).every(function (p) { return posCount[p] === needs[p]; });

  var scoreById = {};
  scored.forEach(function (c) { scoreById[c.el.id] = c.score; });

  if (complete) {
    for (var pass = 0; pass < UPGRADE_PASSES; pass++) {
      var budgetLeft = BUDGET - spend;
      var bestSwap = null;

      for (var s = 0; s < squad.length; s++) {
        var held = squad[s];
        var maxCost = held.now_cost + budgetLeft;
        var candidates = bestByPos[held.element_type] || [];
        var checked = 0;
        for (var i = 0; i < candidates.length && checked < 6; i++) {
          var cand = candidates[i].el;
          if (squadIds[cand.id]) continue;
          if (cand.now_cost > maxCost) continue;
          var clubAfter = (clubCount[cand.team] || 0) - (held.team === cand.team ? 1 : 0);
          if (clubAfter >= maxPerClub) continue;
          var gain = candidates[i].score - (scoreById[held.id] || 0);
          if (gain <= 0) break; // score-ordered: nothing further down can be better
          checked++;
          // Ranked by gain PER POUND, not by raw gain. Taking the biggest
          // available gain each pass spends the whole budget on the first
          // premium it finds and leaves ten slots on minimum-price players;
          // efficiency spreads the same money across the upgrades that
          // return the most for it. A swap that costs nothing (or frees
          // money) is strictly free improvement and always goes first.
          var costDelta = cand.now_cost - held.now_cost;
          var efficiency = costDelta <= 0 ? Infinity : gain / costDelta;
          if (!bestSwap || efficiency > bestSwap.efficiency ||
            (efficiency === bestSwap.efficiency && gain > bestSwap.gain)) {
            bestSwap = { idx: s, held: held, cand: cand, gain: gain, efficiency: efficiency };
          }
        }
      }

      if (!bestSwap) break;
      clubCount[bestSwap.held.team]--;
      clubCount[bestSwap.cand.team] = (clubCount[bestSwap.cand.team] || 0) + 1;
      delete squadIds[bestSwap.held.id];
      squadIds[bestSwap.cand.id] = true;
      spend += bestSwap.cand.now_cost - bestSwap.held.now_cost;
      squad[bestSwap.idx] = bestSwap.cand;
    }
  }

  var teamsById = {};
  bootstrap.teams.forEach(function (t) { teamsById[t.id] = t; });

  var order = { 1: 0, 2: 1, 3: 2, 4: 3 };
  squad.sort(function (a, b) {
    if (order[a.element_type] !== order[b.element_type]) return order[a.element_type] - order[b.element_type];
    return b.now_cost - a.now_cost;
  });

  return {
    players: squad.map(function (el) {
      return {
        name: el.web_name,
        // id, elementType and xp carried so a caller can value this squad
        // rather than only display it — the chip valuations run the same
        // best-legal-XI arithmetic over these that they run over the
        // manager's own squad, and that needs the position back as a number.
        id: el.id,
        elementType: el.element_type,
        team: teamsById[el.team] ? teamsById[el.team].short_name : '?',
        position: POSITION_MAP[el.element_type],
        price: el.now_cost / 10,
        form: el.form,
        totalPoints: el.total_points,
        xp: projectPoints_(el, fixtureEase),
        reason: explainPlayer_(el, fixtureEase)
      };
    }),
    totalSpend: spend / 10,
    remaining: (BUDGET - spend) / 10,
    complete: complete
  };
}

/* ===================== MODEL INVARIANTS ===================== */

/* Things that must be true of any answer this app is willing to publish.
 *
 * Every bug worth fixing in the decision engine so far has been of one shape:
 * an output that was not merely debatable but impossible — a chip valued
 * against a team nobody could field, a hit charged for a transfer that was
 * free, advice for a gameweek that had already locked, a captain who was not
 * in the eleven. None of those need a model to detect. They need arithmetic
 * checked against itself.
 *
 * So the numbers are checked before they are shown, and a failure downgrades
 * the front-page verdict to the rule-based one rather than letting confident
 * prose sit on top of an impossible figure. The interface is the part users
 * trust; it should not be the part with no guard rail.
 *
 * Each check returns a message when it FAILS and nothing when it passes.
 */
function checkModelInvariants_(data) {
  var failures = [];
  var warnings = [];
  var fail = function (name, detail) { failures.push({ check: name, detail: detail }); };
  /* Not everything worth flagging is worth silencing the page over.
   *
   * A broken identity — a hit charged at five points, a horizon that is not
   * the sum of its gameweeks, an XI of ten — is proof of a fault, and
   * publishing over it is what this whole function exists to prevent. But
   * "this number looks too big" is a heuristic, and heuristics have false
   * positives: a genuinely poor squad early in a season really can be worth
   * forty points of rebuild. Blanking the verdict for that would be its own
   * bug, so plausibility is reported, not enforced. */
  var warn = function (name, detail) { warnings.push({ check: name, detail: detail }); };

  var squad = data.squad;
  var gs = data.gameweekState || {};

  /* --- gameweek state ------------------------------------------------- */
  if (gs.decisionEventId != null && gs.liveEventId != null &&
      String(gs.decisionEventId) === String(gs.liveEventId)) {
    fail('decision gameweek is not the live one',
      'GW' + gs.decisionEventId + ' is both being played and being picked for.');
  }
  if (gs.decisionEventId != null && gs.decisionDeadline) {
    var dl = Date.parse(gs.decisionDeadline);
    if (!isNaN(dl) && dl <= Date.now()) {
      fail('decision gameweek is still open',
        'GW' + gs.decisionEventId + ' is being advised on but its deadline has passed.');
    }
  }

  /* --- squad shape ---------------------------------------------------- */
  if (squad && squad.starting && squad.players) {
    if (squad.starting.length !== 11) {
      fail('starting XI contains eleven players', squad.starting.length + ' found.');
    }

    var counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    squad.starting.forEach(function (p) {
      if (counts[p.elementType] != null) counts[p.elementType]++;
    });
    [1, 2, 3, 4].forEach(function (k) {
      if (counts[k] < XI_MIN[k] || counts[k] > XI_MAX[k]) {
        fail('starting XI is a legal formation',
          (POSITION_MAP[k] || k) + ' count ' + counts[k] + ' outside ' + XI_MIN[k] + '-' + XI_MAX[k] + '.');
      }
    });

    var byClub = {};
    squad.players.forEach(function (p) { byClub[p.teamId] = (byClub[p.teamId] || 0) + 1; });
    Object.keys(byClub).forEach(function (teamId) {
      if (byClub[teamId] > 3) fail('no club supplies more than three players', teamId + ' supplies ' + byClub[teamId] + '.');
    });

    var seen = {};
    squad.players.forEach(function (p) {
      if (seen[p.id]) fail('no player appears twice in the squad', p.name + ' appears more than once.');
      seen[p.id] = true;
    });
  }

  /* --- the captain has to be someone you are fielding ------------------ */
  var topCaptain = (data.captainSuggestions || [])[0];
  if (topCaptain && squad && squad.starting) {
    var inXi = squad.starting.filter(function (p) { return p.name === topCaptain.name; }).length > 0;
    if (!inXi) fail('suggested captain is in the starting XI', topCaptain.name + ' is not in it.');
  }

  /* --- transfer accounting reconciles --------------------------------- */
  var led = data.transferLedger;
  if (led) {
    var expectedPaid = Math.max(0, led.transfersRecommended - led.freeTransfersAvailable);
    if (led.paidMoves !== expectedPaid) {
      fail('hits match the moves beyond the free transfers',
        led.transfersRecommended + ' moves on ' + led.freeTransfersAvailable + ' FT should be ' +
        expectedPaid + ' paid, ledger says ' + led.paidMoves + '.');
    }
    if (led.hitCost !== led.paidMoves * TRANSFER_HIT_COST) {
      fail('hit cost is four points per paid move', led.paidMoves + ' paid moves charged ' + led.hitCost + '.');
    }
    if (Math.abs((led.grossGain - led.hitCost) - led.netGain) > 0.11) {
      fail('net gain is gross gain less hits',
        led.grossGain + ' - ' + led.hitCost + ' != ' + led.netGain + '.');
    }
    if (led.freeMoves + led.paidMoves !== led.transfersRecommended) {
      fail('every recommended move is either free or paid',
        led.freeMoves + ' + ' + led.paidMoves + ' != ' + led.transfersRecommended + '.');
    }
  }

  (data.transferSuggestions || []).forEach(function (t) {
    if (t.implausible) {
      warn('Transfer gain is within a plausible range',
        t.inName + ' for ' + t.outName + ' moves the best eleven by +' + t.projectedGain + ' over ' + t.horizonGws +
        ' gameweeks — more than ' + TRANSFER_IMPLAUSIBLE_PER_GW + ' a week from one swap usually means the incoming projection is inflated.');
    }
  });

  /* --- every player belongs to a club with a fixture list -------------- */
  if (squad && squad.players && data.fixtureTeams) {
    squad.players.forEach(function (p) {
      if (!data.fixtureTeams[p.teamId]) {
        fail('every player belongs to a known club', p.name + ' has team id ' + p.teamId + ', which has no fixture list.');
      }
    });
  }

  /* --- you cannot spend money you do not have -------------------------- */
  (data.transferSuggestions || []).forEach(function (t) {
    if (t.bankAfter != null && t.bankAfter < -0.001) {
      fail('bank never goes negative', t.out + ' -> ' + t.into + ' leaves £' + t.bankAfter + 'm.');
    }
  });

  /* --- projections add up --------------------------------------------- */
  if (squad && squad.players) {
    squad.players.forEach(function (p) {
      if (!p.xp || !p.xp.perGw) return;
      var summed = p.xp.perGw.reduce(function (sum, g) { return sum + g.xp; }, 0);
      if (Math.abs(summed - p.xp.horizon) > 0.05) {
        fail('horizon equals the sum of its gameweeks',
          p.name + ': gameweeks sum to ' + summed.toFixed(2) + ', horizon says ' + p.xp.horizon + '.');
      }
    });
  }

  /* --- chip valuations are differences between fieldable teams --------- */
  var cv = data.chipValues || {};
  if (cv.freeHit) {
    if (!isFinite(cv.freeHit.gain)) fail('Free Hit value is a real number', String(cv.freeHit.gain));
    // The chip's value is measured against your own best legal eleven, so the
    // baseline must be that eleven — never a number larger than the team the
    // chip would buy you.
    if (cv.freeHit.ideal != null && cv.freeHit.mine != null &&
        Math.abs((cv.freeHit.ideal - cv.freeHit.mine) - cv.freeHit.gain) > 0.11) {
      fail('Free Hit gain is the difference it reports',
        cv.freeHit.ideal + ' - ' + cv.freeHit.mine + ' != ' + cv.freeHit.gain + '.');
    }
    /* One gameweek, eleven players, both teams legal and inside the same
     * budget. A gain past this is not a good week, it is a comparison against
     * a team nobody could field — which is exactly what the old valuation
     * did, reporting 51.3 by measuring the best eleven IN THE GAME against
     * whatever lineup happened to be set. */
    if (cv.freeHit.gain > FREE_HIT_IMPLAUSIBLE_GAIN) {
      warn('Free Hit gain is within a plausible range',
        '+' + cv.freeHit.gain + ' in one gameweek means the baseline is not a fieldable team.');
    }
  }
  if (cv.wildcard) {
    if (!isFinite(cv.wildcard.gain)) fail('Wildcard value is a real number', String(cv.wildcard.gain));
    if (cv.wildcard.rebuilt != null && cv.wildcard.mine != null &&
        Math.abs((cv.wildcard.rebuilt - cv.wildcard.mine) - cv.wildcard.gain) > 0.11) {
      fail('Wildcard gain is the difference it reports',
        cv.wildcard.rebuilt + ' - ' + cv.wildcard.mine + ' != ' + cv.wildcard.gain + '.');
    }
    /* A rebuild is fifteen players deep, not a different sport. A horizon
     * gain of more than a couple of points per gameweek means something
     * upstream is double-counting — which is exactly how a six-week Wildcard
     * came to advertise +262.9 and recommend itself in week two. */
    if (cv.wildcard.gain > WILDCARD_IMPLAUSIBLE_GAIN) {
      warn('Wildcard gain is within a plausible range',
        '+' + cv.wildcard.gain + ' over the horizon is not a real marginal advantage.');
    }
  }
  if (cv.benchBoost && data.squad && data.squad.bench && data.squad.bench.length !== 4) {
    fail('Bench Boost values a four-man bench', data.squad.bench.length + ' on the bench.');
  }

  // `ok` is about failures only. Warnings travel alongside so the debug page
  // and the verdict can mention them without either one being suppressed.
  return { ok: !failures.length, failures: failures, warnings: warnings, checked: true };
}

/* Roughly two and a half points a gameweek of structural edge, over the whole
 * horizon. A real wildcard is worth something like this; anything far beyond
 * it is an arithmetic fault, not an opportunity. */
/* Five a gameweek, not two and a half: the bar for PLAYING a Wildcard is
 * CHIP_WILDCARD_BAR (15), and with the implausibility line at the same 15
 * every Wildcard that cleared its bar was also, by definition, implausible. */
var WILDCARD_IMPLAUSIBLE_GAIN = 5 * LOOKAHEAD_GWS;
/* A Free Hit buys one gameweek. Swapping an entire eleven for the best legal
 * one money can buy is worth a lot; it is not worth thirty points. */
var FREE_HIT_IMPLAUSIBLE_GAIN = 30;

/* ===================== AI ASSISTANT ===================== */

function hasAiKey_() {
  return !!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
}

function saveAiKey(key) {
  key = String(key).trim();
  if (key.indexOf('sk-ant-') !== 0) {
    throw new Error('That doesn\'t look like an Anthropic API key — it should start with "sk-ant-".');
  }
  PropertiesService.getScriptProperties().setProperty('ANTHROPIC_API_KEY', key);
  return { ok: true };
}

function clearAiKey() {
  PropertiesService.getScriptProperties().deleteProperty('ANTHROPIC_API_KEY');
  return { ok: true };
}

function hasYoutubeKey_() {
  return !!PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
}

function saveYoutubeKey(key) {
  key = String(key).trim();
  if (!key) throw new Error('Enter a YouTube Data API key.');
  PropertiesService.getScriptProperties().setProperty('YOUTUBE_API_KEY', key);
  return { ok: true };
}

function clearYoutubeKey() {
  PropertiesService.getScriptProperties().deleteProperty('YOUTUBE_API_KEY');
  return { ok: true };
}

function hasGeminiKey_() {
  return !!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
}

function saveGeminiKey(key) {
  key = String(key).trim();
  if (!key) throw new Error('Enter a Gemini API key.');
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
  return { ok: true };
}

function clearGeminiKey() {
  PropertiesService.getScriptProperties().deleteProperty('GEMINI_API_KEY');
  return { ok: true };
}

/** Grounds the AI in the same numbers the dashboard just showed the user — never lets it guess. */
function buildAiContext_(data) {
  var lines = [];
  lines.push('Team: ' + (data.entryName || 'unknown') + ' (manager ' + (data.managerName || 'unknown') + ')');

  /* Which gameweek is which, stated once and unambiguously.
   *
   * The model used to be given a single "Gameweek: N" beside a deadline that
   * belonged to a different gameweek, plus a live-score paragraph ending
   * "this gameweek is already locked". It did what anyone would do with that
   * and merged them, producing copy that told the manager the gameweek they
   * were being asked to pick for had already locked. Naming both gameweeks
   * separately, and saying explicitly which one every recommendation below
   * refers to, is what stops that. */
  var gs = data.gameweekState || {};
  if (gs.liveInPlay && gs.liveEventId != null) {
    lines.push('GW' + gs.liveEventId + ' IS BEING PLAYED RIGHT NOW. It is locked: nothing about it can be changed, ' +
      'and no advice below refers to it.');
  } else if (data.currentEventId != null) {
    lines.push('No gameweek is in progress.');
  }
  if (gs.decisionEventId != null) {
    lines.push('EVERY recommendation below is for GW' + gs.decisionEventId + ', whose deadline is ' + data.deadline +
      ' and has NOT passed. GW' + gs.decisionEventId + ' is open. Never describe it as locked, closed or already decided.');
  }

  lines.push('Fixture difficulty (FDR, 1 easy to 5 hard) is rated from ONE side of a match: "(2 for EVE)" is how hard the ' +
    'match is for Everton. The same match has a different FDR for the other team, so two players on opposite sides of one ' +
    'fixture showing different numbers is correct, not inconsistent.');
  lines.push('Bank: £' + (data.squad && data.squad.bank != null ? data.squad.bank.toFixed(1) : '?') + 'm, Squad value: £' + (data.squad && data.squad.teamValue != null ? data.squad.teamValue.toFixed(1) : '?') + 'm');

  /* The transfer accounting, finished. The model is given the arithmetic
   * already done and told not to redo it, because when it was given prose and
   * left to infer the numbers it inferred them wrong — announcing two free
   * transfers on a week with one, above a plan that charged a hit for exactly
   * that reason. Explaining a decision and reconstructing its accounting are
   * different jobs and only the first one belongs to a language model. */
  var led = data.transferLedger;
  if (led) {
    lines.push('\nTRANSFER LEDGER — these figures are already computed. Use them EXACTLY as given. ' +
      'Do not add, subtract, re-derive or restate them differently:');
    lines.push('- Free transfers available: ' + led.freeTransfersAvailable + ' (estimated from transfer history)');
    lines.push('- Transfers recommended: ' + led.transfersRecommended +
      ' (' + led.freeMoves + ' free, ' + led.paidMoves + ' paid)');
    lines.push('- Points cost of hits: ' + led.hitCost);
    lines.push('- Projected gain over ' + led.horizonGws + ' gameweeks: +' + led.grossGain +
      ' gross, +' + led.netGain + ' net of hits');
    lines.push('- Canonical one-line rendering: ' + led.summary);
  } else if (data.freeTransfers) {
    lines.push('Free transfers available (estimated from transfer history): ' + data.freeTransfers +
      '. Any transfer beyond that costs 4 points.');
  }

  if (data.squad) {
    if (data.declared && (data.declared.moves || []).length) {
      lines.push('\nTRANSFERS THE MANAGER HAS ALREADY MADE for GW' + data.declared.eventId + ' (told to the app; ' +
        'the squad below already includes them): ' + data.declared.moves.map(function (m) {
          return m.inName + ' in for ' + m.outName;
        }).join(', ') + (data.declared.chip ? ' — playing ' + data.declared.chip : '') +
        '. Hits taken: ' + (data.declared.hits * TRANSFER_HIT_COST) + '. Free transfers left: ' + data.declared.freeTransfersLeft + '.');
    }
    /* The eleven the manager has SET, labelled as such. It used to be listed
     * as "Starting XI" with no warning on it, so the model described an
     * injured player sitting in it as part of the team, and the bench came
     * with no xP or status at all — it could not see the fit 6.2 waiting
     * there. The recommended eleven follows, and the check between them. */
    var describe = function (p) {
      return p.name + ' (' + p.position + ', ' + p.team + ', £' + p.price.toFixed(1) + 'm, form ' + p.form +
        ', status ' + (STATUS_LABEL[p.status] || p.status) +
        (p.chanceOfPlaying != null && p.status !== 'a' ? ' ' + p.chanceOfPlaying + '%' : '') +
        (p.xp ? ', xP this GW ' + p.xp.next.toFixed(1) : '') +
        (p.rotation ? ', ' + p.rotation.text.replace(/\.$/, '').toLowerCase() : '') +
        (p.selectedBy ? ', owned by ' + p.selectedBy.toFixed(1) + '%' : '') +
        (p.isCaptain ? ', CAPTAIN' : '') + (p.isVice ? ', VICE' : '') + ')';
    };
    lines.push('\nThe eleven the manager currently has SET (not necessarily what to play):');
    data.squad.starting.forEach(function (p) { lines.push('- ' + describe(p)); });
    lines.push('\nBench:');
    data.squad.bench.forEach(function (p) { lines.push('- ' + describe(p)); });
    var lu = data.lineup;
    if (lu) {
      if ((lu.xiWarnings || []).length) {
        lines.push('\nXI CHECK — say these first if the manager asks about their team:');
        lu.xiWarnings.forEach(function (w) { lines.push('- ' + w.text); });
      }
      if ((lu.xi || []).length) {
        var top = (data.captainSuggestions || [])[0];
        lines.push('\nRECOMMENDED ELEVEN for GW' + (gs.decisionEventId != null ? gs.decisionEventId : '?') + ' (' + lu.formation +
          ', projects ' + lu.projected.toFixed(1) + ' against ' + lu.currentProjected.toFixed(1) + ' for the eleven that is set): ' +
          lu.xi.map(function (p) { return p.name + ' ' + p.xp.toFixed(1); }).join(', ') +
          (top ? '. Captain: ' + top.name + '.' : '.') +
          ((lu.benchOrder || []).length ? ' Bench order: ' + lu.benchOrder.map(function (b) { return b.name; }).join(', ') + '.' : ''));
      }
    }
  } else if (data.suggestedSquad) {
    // Preseason: no real squad is readable yet (see getDashboardData's `preseason`
    // comment) — this is the only comparison basis that exists at all, so without
    // it every downstream "agrees/differs" verdict has nothing to compare against.
    lines.push('\nNo squad picked/readable yet (preseason). Suggested opening XV (' + data.suggestedSquadBasis + ' data):');
    data.suggestedSquad.players.forEach(function (p) {
      lines.push('- ' + p.name + ' (' + p.position + ', ' + p.team + ', £' + p.price.toFixed(1) + 'm)');
    });
  }

  if (data.transferSuggestions && data.transferSuggestions.length) {
    lines.push('\nTransfer suggestions (rule-based engine):');
    data.transferSuggestions.forEach(function (t) {
      lines.push('- OUT ' + t.out + ' / IN ' + t.into +
        (t.outClub && t.inClub ? ' [' + t.outName + ' plays for ' + t.outClub + '; ' + t.inName + ' plays for ' + t.inClub + ']' : '') +
        ' — projected +' + t.projectedGain + ' expected points over ' +
        t.horizonGws + ' gameweeks' + (t.usesHit ? ' (costs a -4 hit; nets ' + t.netGain + ')' : ' (free transfer)') +
        ', confidence ' + t.confidence);
    });
  }
  if (data.transferPlan) {
    lines.push('\nThe recommended action this week: ' + data.transferPlan.headline + ' ' + data.transferPlan.detail);
  }

  if (data.captainSuggestions && data.captainSuggestions.length) {
    lines.push('\nCaptain options (rule-based engine):');
    data.captainSuggestions.forEach(function (c) {
      lines.push('- ' + c.name + ' (' + c.team + '), ' + (c.xp != null ? c.xp.toFixed(1) + ' expected points' : 'form ' + c.form) +
        ', next ' + c.nextFixture + (c.fixtures > 1 ? ' (DOUBLE GAMEWEEK)' : '') +
        (c.onPens ? ', on penalties' : '') +
        (c.ownership != null ? ', owned by ' + c.ownership.toFixed(1) + '%' : '') +
        (c.topShare != null ? ' — tops the XI in ' + Math.round(c.topShare) + '% of simulations' : '') +
        (c.beatFieldShare != null ? ', beats the league\u2019s captain ' + Math.round(c.beatFieldShare) + '% of the time' : '') +
        (c.deltaFloor != null ? ' (worst weeks ' + c.deltaFloor.toFixed(1) + ' vs the field, best weeks ' +
          (c.deltaCeiling >= 0 ? '+' : '') + c.deltaCeiling.toFixed(1) + ')' : '') +
        (c.confidence ? ' [' + c.confidence + ']' : ''));
    });
    var capTop = data.captainSuggestions[0];
    if (capTop && capTop.basis) lines.push(capTop.basis);
    if (capTop && capTop.disagreesWithMean) {
      lines.push('NOTE — the highest-projecting player is not the recommendation: ' + capTop.disagreesWithMean.note);
    }
    lines.push('How captaincy is decided: each candidate\u2019s scoring SHAPE comes from his own recent match log, ' +
      'rescaled so its mean equals the xP above; candidates are then simulated against the league\u2019s actual captains, ' +
      'and ranked on rank movement (worst-quarter mean for Safe, average for Balanced, best-quarter mean for Aggressive). ' +
      'Highest expected points and best captain pick are therefore different questions, and can have different answers.');
  }

  if (data.lineup) {
    lines.push('\nBest legal XI by expected points: ' + data.lineup.formation + ', projecting ' + data.lineup.projected +
      ' vs the ' + data.lineup.currentProjected + ' the currently-set eleven projects.');
    (data.lineup.changes || []).forEach(function (c) {
      lines.push('- Start ' + c.inName + ' over ' + c.outName + ' (+' + c.gain + ' pts): ' + c.reason);
    });
  }

  if (data.ownershipEdge) {
    lines.push('\nOwnership: ' + data.ownershipEdge.summary);
    if ((data.ownershipEdge.missing || []).length) {
      lines.push('Template players not owned: ' + data.ownershipEdge.missing.map(function (m) {
        return m.name + ' (' + m.ownership.toFixed(0) + '%)';
      }).join(', '));
    }
  }

  if (data.liveGameweek) {
    var lgc = data.liveGameweek;
    lines.push('\nGAMEWEEK ' + lgc.eventId + ' IS IN PROGRESS RIGHT NOW: ' + lgc.pointsSoFar + ' points so far' +
      (lgc.average != null ? ' against a live average of ' + lgc.average : '') +
      ', ' + lgc.playersYetToPlay + ' players still to play, ' + lgc.playersInPlay + ' playing now, ' +
      lgc.benchPoints + ' on the bench.' +
      (lgc.captain ? ' Captain ' + lgc.captain.name + ' on ' + lgc.captain.points + ' (' + lgc.captain.contributed + ' doubled).' : '') +
      (lgc.blanked.length ? ' Did not feature: ' + lgc.blanked.join(', ') + '.' : '') +
      ' GW' + lgc.eventId + ' is locked and cannot be changed. Nothing in this brief is advice about GW' +
      lgc.eventId + '; it is all about the open gameweek named at the top.');
  }

  if (data.lastGameweek) {
    var g = data.lastGameweek;
    lines.push('\nLast gameweek (GW' + g.eventId + '): ' + g.points + ' pts against an average of ' + g.average +
      (g.rankDelta != null ? ', overall rank ' + (g.rankDelta > 0 ? 'up ' : 'down ') + Math.abs(g.rankDelta) : '') +
      ', ' + g.benchPoints + ' pts left on the bench.');
    if ((g.worked || []).length) lines.push('What worked: ' + g.worked.join(' '));
    if ((g.didntWork || []).length) lines.push('What did not: ' + g.didntWork.join(' '));
  }

  if (data.roadmap && (data.roadmap.weeks || []).length) {
    lines.push('\nPlanned transfers over the next ' + data.roadmap.horizonGws + ' gameweeks (bounded lookahead: whole plans are ' +
      'compared, scored on the best legal XI each week minus any hits, so rolling competes with moving on the same arithmetic):');
    data.roadmap.weeks.forEach(function (w) {
      lines.push('- GW' + w.event + ' (' + w.freeTransfers + ' FT): ' +
        (w.moves.length
          ? w.moves.map(function (m) { return m.inName + ' in for ' + m.outName + ' (+' + m.gain + ')'; }).join('; ') +
            (w.hits ? ' — costs a ' + (w.hits * TRANSFER_HIT_COST) + '-point hit' : '')
          : 'roll' + (w.note ? ' — ' + w.note : '')));
    });
    if (data.roadmap.plannedXp != null) {
      lines.push('The whole plan projects ' + data.roadmap.plannedXp + ' points across the window, after hits.');
    }
    if (data.roadmap.divergence) {
      // The one place the app's own two engines can legitimately disagree, so
      // the assistant should be able to explain it rather than pick a side.
      lines.push('NOTE — the horizon disagrees with this week\u2019s recommendation: ' + data.roadmap.divergence.summary +
        ' The recommendation above is scored on the coming gameweek; the plan is scored on all ' + data.roadmap.horizonGws + '.');
    }
    (data.roadmap.fixtureSwings || []).forEach(function (s) {
      lines.push('- ' + s.club + ' fixtures turn ' + s.direction + ' from GW' + s.turnsAt +
        ' (' + s.before + ' -> ' + s.after + '), affecting ' + s.players.join(', '));
    });
  }

  if (data.calibration && data.calibration.predicted) {
    var cal = data.calibration;
    var off = ((cal.actual - cal.predicted) / cal.predicted) * 100;
    lines.push('\nModel calibration across ' + cal.gwsGraded + ' graded gameweeks: projected ' + cal.predicted +
      ' points for players who featured, they scored ' + cal.actual + ' — ' +
      (off >= 0 ? 'the model runs ' + off.toFixed(0) + '% cold (under-rates)' : 'the model runs ' + Math.abs(off).toFixed(0) + '% hot (flatters)') + '.' +
      (cal.applied ? ' ' + Math.round(cal.trust * 100) + '% of that bias is being corrected for in current projections.'
                   : ' Too few gameweeks to correct for it yet.'));
    Object.keys(cal.positions || {}).forEach(function (k) {
      var p = cal.positions[k];
      if (!p.predicted) return;
      var po = ((p.actual - p.predicted) / p.predicted) * 100;
      lines.push('- ' + p.position + ': projected ' + p.predicted + ', actual ' + p.actual +
        ' (' + (po >= 0 ? '+' : '') + po.toFixed(0) + '%, ' + p.samples + ' player-gameweeks)');
    });
  }

  if (data.trackRecord) {
    // The assistant should be able to answer "has your advice actually
    // worked?" honestly rather than from the marketing copy.
    lines.push('\nThis app\'s own graded track record on this team (' + data.trackRecord.gwsGraded + ' gameweeks): ' +
      (data.trackRecord.learnings || []).join(' '));
  }

  if (data.chipDecision) {
    lines.push('\nCHIP DECISION — one chip at most per gameweek, and this is the call: ' + data.chipDecision.reason);
  }
  if (data.chipSuggestions && data.chipSuggestions.length) {
    lines.push('\nChip notes (each priced alone; the decision above is the recommendation):');
    data.chipSuggestions.forEach(function (c) { lines.push('- ' + c); });
  }

  return lines.join('\n');
}

/* ===================== ASSISTANT TOOLS =====================
 *
 * The assistant was a single shot: build one context block describing the
 * squad as it stands right now, hand it to the model, take 2-4 sentences
 * back. That grounds it well in the PRESENT and leaves it unable to answer
 * anything about the past, which is most of what a manager actually asks —
 * "has he started the last three?", "what did Salah do against Everton last
 * time?", "am I above or below where I was in October?". None of that is in
 * bootstrap-static, so no context block, however large, could contain it.
 *
 * It lives one API call away, in `/element-summary/{id}/`: every fixture a
 * player has played this season with minutes, goals, assists and points, plus
 * previous-season totals and his upcoming run. Fetching that for ~700 players
 * on the off-chance is absurd; fetching it for the one player being asked
 * about is a single call. That is a tool, not a context field.
 *
 * So the assistant gets tools and a loop. It decides what it needs to look
 * up, the loop fetches it, and the model answers from real match data instead
 * of hedging. The tools are deliberately few and coarse — a model choosing
 * between five obvious tools is reliable in a way that one choosing between
 * twenty overlapping ones is not.
 */
var AI_TOOL_MAX_ROUNDS = 5;      // model turns per question before the loop gives up
var AI_SEARCH_MAX_RESULTS = 12;

var AI_TOOLS = [
  {
    name: 'get_player_history',
    description: 'Match-by-match record for one player this season: minutes, goals, assists, points, ' +
      'clean sheets, bonus and opponent for each fixture played, plus previous-season totals and his upcoming fixtures. ' +
      'Use this for any question about what a player has actually DONE — form over a run of games, whether he starts, ' +
      'how he performed against a specific opponent, or whether a hot streak is real. Works for any player in the game, ' +
      'not just ones in the manager’s squad.',
    input_schema: {
      type: 'object',
      properties: {
        player: { type: 'string', description: 'Player name as it appears on the shirt, e.g. "Salah", "Semenyo", "B.Fernandes".' }
      },
      required: ['player']
    }
  },
  {
    name: 'compare_players',
    description: 'Side-by-side of this app’s own numbers for two to four players: expected points for the coming ' +
      'gameweek and over the horizon, price, ownership, form, expected goal involvements per 90, minutes share and ' +
      'the fixture run. Use it whenever a question weighs one player against another.',
    input_schema: {
      type: 'object',
      properties: {
        players: { type: 'array', items: { type: 'string' }, description: 'Two to four player names.' }
      },
      required: ['players']
    }
  },
  {
    name: 'get_my_season',
    description: 'The manager’s own season, gameweek by gameweek: points, gameweek rank, overall rank, points left ' +
      'on the bench, transfers made and what they cost, squad value, and which chips were played when. Use this for ' +
      'any question about how their season has gone or where a decision hurt.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'search_players',
    description: 'Find players matching criteria, ranked by this app’s own expected points. Use it for open questions ' +
      'like "who are the best midfielders under 7.0" or "which cheap defenders have good fixtures".',
    input_schema: {
      type: 'object',
      properties: {
        position: { type: 'string', enum: ['GKP', 'DEF', 'MID', 'FWD'], description: 'Restrict to one position.' },
        max_price: { type: 'number', description: 'Maximum price in millions, e.g. 7.5.' },
        min_price: { type: 'number', description: 'Minimum price in millions.' },
        max_ownership: { type: 'number', description: 'Maximum ownership percentage — use for differential questions.' },
        available_only: { type: 'boolean', description: 'Exclude injured, suspended and doubtful players. Defaults to true.' }
      }
    }
  },
  {
    name: 'get_team_form',
    description: 'A club\u2019s recent record over its last five matches: results with scorelines, goals and expected goals for ' +
      'and against, clean sheets, the home/away split, league ranks for goals and xG conceded and scored, and the FPL points ' +
      'opposing defenders, midfielders and forwards have scored against it. Use it for any question about a TEAM \u2014 is a ' +
      'defence leaking, is an attack firing, is a fixture against them good for attackers or defenders.',
    input_schema: {
      type: 'object',
      properties: { team: { type: 'string', description: 'Club name or three-letter code, e.g. "Bournemouth" or "BOU".' } },
      required: ['team']
    }
  },
  {
    name: 'record_transfer',
    description: 'Record a transfer the manager says they have ALREADY MADE in the FPL app for the open gameweek, so the ' +
      'app recommends the eleven and captain for the squad they now hold. The FPL API does not show pending transfers ' +
      'until the deadline, so without this every recommendation is for last week\u2019s squad. Call it once per transfer, only ' +
      'when the manager states they made it — never to suggest or try out a move. Returns the new best eleven, bench order ' +
      'and captain.',
    input_schema: {
      type: 'object',
      properties: {
        sold: { type: 'string', description: 'The player the manager sold, as named in their squad.' },
        bought: { type: 'string', description: 'The player the manager bought.' },
        chip: { type: 'string', enum: ['wildcard', 'freehit'], description: 'Only if the manager says this week\u2019s transfers are on a Wildcard or Free Hit.' }
      },
      required: ['sold', 'bought']
    }
  },
  {
    name: 'get_league',
    description: 'The manager’s mini-league: the standings, and the effective ownership of every player across their ' +
      'rivals’ actual squads — who is captained by how many of them, and what each player does to the manager’s ' +
      'rank. Use this for questions about rivals, rank risk, or whether to play safe or chase.',
    input_schema: { type: 'object', properties: {} }
  }
];

/**
 * Resolves a free-text player name to a bootstrap element.
 *
 * Exact web_name first, then prefix, then substring, then the full name from
 * first/second name fields — a manager typing "Bruno" or "Fernandes" should
 * land on B.Fernandes even though neither string is his web_name. Ties break
 * on expected points, so a search for a common surname returns the player
 * anyone asking is far more likely to have meant.
 */
function aiResolvePlayer_(bootstrap, name, fixtureEase) {
  var n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  var els = bootstrap.elements;

  function rank(list) {
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    return list.slice().sort(function (a, b) {
      return projectPoints_(b, fixtureEase).horizon - projectPoints_(a, fixtureEase).horizon;
    })[0];
  }

  var exact = els.filter(function (el) { return String(el.web_name).toLowerCase() === n; });
  if (exact.length) return rank(exact);
  var prefix = els.filter(function (el) { return String(el.web_name).toLowerCase().indexOf(n) === 0; });
  if (prefix.length) return rank(prefix);
  var sub = els.filter(function (el) { return String(el.web_name).toLowerCase().indexOf(n) !== -1; });
  if (sub.length) return rank(sub);
  var full = els.filter(function (el) {
    return ((el.first_name || '') + ' ' + (el.second_name || '')).toLowerCase().indexOf(n) !== -1;
  });
  return rank(full);
}

function getElementSummary_(elementId) {
  var key = 'ELSUM_' + elementId;
  var cached = safeCall_(function () { return CacheService.getScriptCache().get(key); });
  if (cached) {
    var parsed = safeCall_(function () { return JSON.parse(cached); });
    if (parsed) return parsed;
  }
  var slim = slimElementSummary_(fetchJson_(BASE + '/element-summary/' + elementId + '/'));
  safeCall_(function () { CacheService.getScriptCache().put(key, JSON.stringify(slim), ELEMENT_SUMMARY_CACHE_TTL); });
  return slim;
}

/**
 * Only the fields anything here reads — the raw element-summary carries every
 * stat FPL tracks and would blow the 100KB per-value cache cap. Shared by the
 * assistant's single-player lookup and the captaincy model's batch fetch, so
 * one cached entry serves both rather than each caching its own projection.
 */
function slimElementSummary_(body) {
  return {
    history: (body.history || []).slice(-AI_HISTORY_MAX_MATCHES).map(function (h) {
      return { round: h.round, opponent_team: h.opponent_team, was_home: h.was_home, minutes: h.minutes,
        total_points: h.total_points, goals_scored: h.goals_scored, assists: h.assists,
        clean_sheets: h.clean_sheets, bonus: h.bonus, yellow_cards: h.yellow_cards, red_cards: h.red_cards,
        team_h_score: h.team_h_score, team_a_score: h.team_a_score };
    }),
    history_past: (body.history_past || []).slice(-3).map(function (h) {
      return { season_name: h.season_name, total_points: h.total_points, minutes: h.minutes,
        goals_scored: h.goals_scored, assists: h.assists };
    }),
    fixtures: (body.fixtures || []).slice(0, 6).map(function (f) {
      return { event: f.event, is_home: f.is_home, difficulty: f.difficulty,
        team_h: f.team_h, team_a: f.team_a };
    })
  };
}

/* --- the tool bodies ---------------------------------------------------- */

function aiToolPlayerHistory_(input, ctx) {
  var el = aiResolvePlayer_(ctx.bootstrap, input.player, ctx.fixtureEase);
  if (!el) return 'No player in the game matches "' + input.player + '". Names are matched against the short name FPL prints on the shirt.';

  var teams = {};
  ctx.bootstrap.teams.forEach(function (t) { teams[t.id] = t.short_name; });
  var summary = getElementSummary_(el.id);
  var xp = projectPoints_(el, ctx.fixtureEase);

  var lines = [];
  lines.push(el.web_name + ' (' + (teams[el.team] || '?') + ', ' + POSITION_MAP[el.element_type] +
    ', £' + (el.now_cost / 10).toFixed(1) + 'm, owned by ' + el.selected_by_percent + '%)');
  lines.push('Status: ' + (STATUS_LABEL[el.status] || el.status) + (el.news ? ' — ' + el.news : ''));
  lines.push('Season so far: ' + el.total_points + ' points, ' + el.minutes + ' minutes, form ' + el.form +
    ', ' + el.points_per_game + ' points per game.');
  lines.push('This app projects ' + xp.next.toFixed(1) + ' points next gameweek and ' + xp.horizon.toFixed(1) + ' over the horizon.');

  if (summary.history.length) {
    lines.push('\nMatch by match (most recent last):');
    summary.history.forEach(function (h) {
      var score = (h.team_h_score != null && h.team_a_score != null) ? h.team_h_score + '-' + h.team_a_score : '';
      var bits = [h.minutes + ' mins', h.total_points + ' pts'];
      if (h.goals_scored) bits.push(h.goals_scored + ' goal' + (h.goals_scored === 1 ? '' : 's'));
      if (h.assists) bits.push(h.assists + ' assist' + (h.assists === 1 ? '' : 's'));
      if (h.clean_sheets) bits.push('clean sheet');
      if (h.bonus) bits.push(h.bonus + ' bonus');
      if (h.red_cards) bits.push('red card');
      lines.push('- GW' + h.round + ' ' + (h.was_home ? 'vs ' : 'at ') + (teams[h.opponent_team] || '?') +
        (score ? ' (' + score + ')' : '') + ': ' + bits.join(', '));
    });
  } else {
    lines.push('\nNo appearances recorded this season.');
  }

  if (summary.history_past.length) {
    lines.push('\nPrevious seasons:');
    summary.history_past.forEach(function (h) {
      lines.push('- ' + h.season_name + ': ' + h.total_points + ' points, ' + h.minutes + ' minutes, ' +
        h.goals_scored + ' goals, ' + h.assists + ' assists.');
    });
  }

  if (summary.fixtures.length) {
    lines.push('\nUpcoming: ' + summary.fixtures.map(function (f) {
      var opp = f.is_home ? f.team_a : f.team_h;
      return 'GW' + f.event + ' ' + (f.is_home ? 'vs ' : 'at ') + (teams[opp] || '?') + ' (FDR ' + f.difficulty + ')';
    }).join(', '));
  }

  return lines.join('\n');
}

function aiToolComparePlayers_(input, ctx) {
  var names = (input.players || []).slice(0, 4);
  if (names.length < 2) return 'Give at least two player names to compare.';

  var teams = {};
  ctx.bootstrap.teams.forEach(function (t) { teams[t.id] = t.short_name; });
  var squadIds = {};
  ((ctx.data.squad && ctx.data.squad.players) || []).forEach(function (p) { squadIds[p.id] = true; });

  var lines = [];
  var unresolved = [];
  names.forEach(function (name) {
    var el = aiResolvePlayer_(ctx.bootstrap, name, ctx.fixtureEase);
    if (!el) { unresolved.push(name); return; }
    var xp = projectPoints_(el, ctx.fixtureEase);
    var fe = ctx.fixtureEase[el.team];
    lines.push([
      el.web_name + ' (' + (teams[el.team] || '?') + ', ' + POSITION_MAP[el.element_type] + ')',
      '  price £' + (el.now_cost / 10).toFixed(1) + 'm, owned by ' + el.selected_by_percent + '%' +
        (squadIds[el.id] ? ' — IN THE MANAGER’S SQUAD' : ''),
      '  xP next gameweek ' + xp.next.toFixed(2) + ', over the horizon ' + xp.horizon.toFixed(2) +
        ', per million ' + (xp.horizon / (el.now_cost / 10)).toFixed(2),
      '  form ' + el.form + ', ' + el.points_per_game + ' points per game, ' + el.total_points + ' total',
      '  xGI per 90 ' + xgiPer90_(el).toFixed(2) + ', started ' + Math.round(minutesShare_(el) * 100) + '% of available minutes' +
        (function () { var rot = rotationFor_(el); return rot ? '; recently: ' + rot.text.toLowerCase() : ''; })(),
      '  status ' + (STATUS_LABEL[el.status] || el.status) + (el.news ? ' (' + el.news + ')' : ''),
      '  next fixtures: ' + (fe && fe.nextOpponents ? fe.nextOpponents.join(', ') : 'unknown') +
        (fe && (fe.blankGws || []).length ? ' — BLANK in GW' + fe.blankGws.join(', GW') : '') +
        (fe && Object.keys(fe.doubleGw || {}).length ? ' — DOUBLE in GW' + Object.keys(fe.doubleGw).join(', GW') : '')
    ].join('\n'));
  });

  if (unresolved.length) lines.push('Could not find: ' + unresolved.join(', ') + '.');
  return lines.join('\n\n');
}

function aiToolMySeason_(input, ctx) {
  var history = ctx.history;
  if (!history || !(history.current || []).length) return 'No gameweek history available for this team yet.';

  var lines = ['Gameweek by gameweek for ' + (ctx.data.entryName || 'this team') + ':'];
  history.current.forEach(function (h) {
    lines.push('- GW' + h.event + ': ' + h.points + ' pts (gameweek rank ' + (h.rank != null ? h.rank.toLocaleString() : '?') +
      '), overall rank ' + (h.overall_rank != null ? h.overall_rank.toLocaleString() : '?') +
      ', ' + h.points_on_bench + ' left on the bench, ' + h.event_transfers + ' transfer' +
      (h.event_transfers === 1 ? '' : 's') + (h.event_transfers_cost ? ' costing ' + h.event_transfers_cost : '') +
      ', squad value £' + (h.value / 10).toFixed(1) + 'm, £' + (h.bank / 10).toFixed(1) + 'm banked.');
  });

  var totalBench = history.current.reduce(function (s, h) { return s + (h.points_on_bench || 0); }, 0);
  var totalHits = history.current.reduce(function (s, h) { return s + (h.event_transfers_cost || 0); }, 0);
  lines.push('\nSeason totals: ' + totalBench + ' points left on the bench, ' + totalHits + ' points paid in hits.');

  if ((history.chips || []).length) {
    lines.push('Chips played: ' + history.chips.map(function (c) { return c.name + ' in GW' + c.event; }).join(', ') + '.');
  } else {
    lines.push('No chips played yet.');
  }
  if ((history.past || []).length) {
    lines.push('Previous seasons: ' + history.past.map(function (p) {
      return p.season_name + ' — ' + p.total_points + ' pts, finished ' + (p.rank != null ? p.rank.toLocaleString() : '?');
    }).join('; ') + '.');
  }
  return lines.join('\n');
}

function aiToolSearchPlayers_(input, ctx) {
  var teams = {};
  ctx.bootstrap.teams.forEach(function (t) { teams[t.id] = t.short_name; });
  var wantType = null;
  if (input.position) {
    for (var k in POSITION_MAP) if (POSITION_MAP[k] === input.position) wantType = Number(k);
  }
  var availableOnly = input.available_only !== false;

  var rows = ctx.bootstrap.elements.filter(function (el) {
    if (wantType && el.element_type !== wantType) return false;
    if (availableOnly && el.status !== 'a') return false;
    var price = el.now_cost / 10;
    if (input.max_price != null && price > input.max_price) return false;
    if (input.min_price != null && price < input.min_price) return false;
    var own = parseFloat(el.selected_by_percent) || 0;
    if (input.max_ownership != null && own > input.max_ownership) return false;
    // A player who has not played is noise in every one of these searches.
    return el.minutes > 0;
  }).map(function (el) {
    return { el: el, xp: projectPoints_(el, ctx.fixtureEase) };
  }).sort(function (a, b) { return b.xp.horizon - a.xp.horizon; })
    .slice(0, AI_SEARCH_MAX_RESULTS);

  if (!rows.length) return 'No player matches those criteria.';

  var squadIds = {};
  ((ctx.data.squad && ctx.data.squad.players) || []).forEach(function (p) { squadIds[p.id] = true; });

  return 'Ranked by expected points over the horizon:\n' + rows.map(function (r) {
    return '- ' + r.el.web_name + ' (' + (teams[r.el.team] || '?') + ', ' + POSITION_MAP[r.el.element_type] +
      ', £' + (r.el.now_cost / 10).toFixed(1) + 'm, ' + r.el.selected_by_percent + '% owned): ' +
      r.xp.next.toFixed(1) + ' xP next, ' + r.xp.horizon.toFixed(1) + ' over the horizon, form ' + r.el.form +
      (squadIds[r.el.id] ? ' — already in the squad' : '');
  }).join('\n');
}

function aiToolLeague_(input, ctx) {
  var ml = ctx.data.miniLeague;
  var eo = ctx.data.leagueEo;
  if (!ml && !eo) return 'No mini-league is selected for this team.';

  var lines = [];
  if (ml) {
    lines.push(ml.leagueName + ' standings:');
    (ml.rows || []).forEach(function (r) {
      lines.push('- ' + r.rank + '. ' + r.name + ' (' + r.entryName + ') — ' + r.total + ' pts' + (r.isYou ? '  <== THE MANAGER' : ''));
    });
  }
  if (eo && !eo.unavailable) {
    lines.push('\nEffective ownership across ' + eo.managersCounted + ' rivals, from their real GW' + eo.eventId + ' picks.');
    lines.push(eo.summary);
    if ((eo.threats || []).length) {
      lines.push('\nPlayers the field has and the manager does not:');
      eo.threats.forEach(function (r) {
        lines.push('- ' + r.name + ' (' + r.team + '): ' + r.eo.toFixed(0) + '% effective ownership, in ' +
          r.owned.toFixed(0) + '% of squads, captained by ' + r.captained.toFixed(0) + '%, projecting ' +
          r.xpNext.toFixed(1) + ' — worth ' + r.delta.toFixed(1) + ' to the manager’s rank.');
      });
    }
    if ((eo.edges || []).length) {
      lines.push('\nPlayers the manager has and the field does not:');
      eo.edges.forEach(function (r) {
        lines.push('- ' + r.name + ' (' + r.team + '): ' + r.eo.toFixed(0) + '% effective ownership against the manager’s ' +
          (r.mine === 2 ? 'captain' : 'starter') + ' — worth ' + r.delta.toFixed(1) + ' to rank.');
      });
    }
  } else if (eo && eo.unavailable) {
    lines.push('\nEffective ownership unavailable: ' + eo.unavailable);
  }
  return lines.join('\n');
}

/* The manager telling the assistant about a transfer they have ALREADY made.
 *
 * Same store as the dashboard's form (saveDeclaredTransfers), so the two can
 * never disagree. After saving, the dashboard is rebuilt on the new squad and
 * the tool hands back the recommended eleven and captain for it — the answer
 * to "I've just bought X, who do I play?" has to come from the squad that
 * includes X, not from the state block written before he arrived. */
function aiToolRecordTransfer_(input, ctx) {
  var data = ctx.data || {};
  var squad = data.squad;
  if (!squad) return 'There is no readable squad to apply a transfer to yet.';
  var gw = data.pickingForEventId;
  if (gw == null) return 'There is no open gameweek to record a transfer for.';

  var soldName = String(input.sold || '').trim().toLowerCase();
  var inSquad = function (pred) { return squad.players.filter(pred); };
  var sold = inSquad(function (p) { return p.name.toLowerCase() === soldName; })[0] ||
    inSquad(function (p) { return p.name.toLowerCase().indexOf(soldName) === 0; })[0] ||
    inSquad(function (p) { return soldName && p.name.toLowerCase().indexOf(soldName) !== -1; })[0];
  if (!sold) return 'Nobody called "' + input.sold + '" is in the squad. The squad is: ' +
    squad.players.map(function (p) { return p.name; }).join(', ') + '.';
  var bought = aiResolvePlayer_(ctx.bootstrap, input.bought, ctx.fixtureEase);
  if (!bought) return 'No player matches "' + input.bought + '".';

  var existing = readDeclared_(gw);
  var moves = mergeDeclaredMove_(existing ? existing.moves : [], { outId: sold.id, inId: bought.id });
  var chip = input.chip && DECLARED_CHIPS[input.chip] ? input.chip : (existing ? existing.chip : null);
  try {
    saveDeclaredTransfers({ eventId: gw, moves: moves, chip: chip });
  } catch (err) {
    return 'Not recorded — ' + (err && err.message ? err.message : err);
  }
  ctx.squadChanged = true;

  var fresh = getDashboardData();
  ctx.data = fresh;
  var lines = ['Recorded for GW' + gw + ': ' + bought.web_name + ' in for ' + sold.name + '.'];
  if (fresh.declared) {
    lines.push('All transfers recorded this week: ' + fresh.declared.moves.map(function (m) {
      return m.inName + ' in for ' + m.outName;
    }).join(', ') + '. Hits: ' + (fresh.declared.hits * TRANSFER_HIT_COST) + ' points. Bank now £' +
      fresh.declared.bank.toFixed(1) + 'm. Free transfers left: ' + fresh.declared.freeTransfersLeft + '.');
  }
  var lu = fresh.lineup;
  if (lu && lu.xi) {
    lines.push('Best eleven for the new squad (' + lu.formation + ', ' + lu.projected.toFixed(1) + ' xP): ' +
      lu.xi.map(function (p) { return p.name + ' ' + p.xp.toFixed(1); }).join(', ') + '.');
    if ((lu.benchOrder || []).length) lines.push('Bench order: ' + lu.benchOrder.map(function (b) { return b.name; }).join(', ') + '.');
    (lu.xiWarnings || []).forEach(function (w) { lines.push('Check: ' + w.text); });
  }
  var cap = (fresh.captainSuggestions || [])[0], vice = (fresh.captainSuggestions || [])[1];
  if (cap) lines.push('Captain: ' + cap.name + ' (' + cap.xp.toFixed(1) + ' xP)' + (vice ? ', vice ' + vice.name : '') + '.');
  return lines.join('\n');
}

/* A club, not a player: results, goals and xG for and against, clean
 * sheets, home/away, and what its opponents' players have scored against it.
 * "Are Bournemouth conceding a lot?" used to be unanswerable without a
 * Bournemouth player in scope. */
function aiToolTeamForm_(input, ctx) {
  var q = String(input.team || '').trim().toLowerCase();
  if (!q) return 'Name a club.';
  var team = ctx.bootstrap.teams.filter(function (t) { return t.short_name.toLowerCase() === q || t.name.toLowerCase() === q; })[0] ||
    ctx.bootstrap.teams.filter(function (t) { return t.name.toLowerCase().indexOf(q) === 0; })[0] ||
    ctx.bootstrap.teams.filter(function (t) { return t.name.toLowerCase().indexOf(q) !== -1; })[0];
  if (!team) return 'No club matches "' + input.team + '". Clubs: ' + ctx.bootstrap.teams.map(function (t) { return t.name; }).join(', ') + '.';
  var recent = RECENT_LIVE_ || loadRecentLive_(ctx.bootstrap, RECENT_FORM_GWS);
  var all = buildLeagueTeamForm_(ctx.bootstrap, RECENT_FIXTURES_ || getFixtures_(), recent);
  var f = all.filter(function (x) { return x.teamId === team.id; })[0];
  var fe = ctx.fixtureEase && ctx.fixtureEase[team.id];
  return describeTeamForm_(f) + (fe && fe.nextOpponents ? '\nNext fixtures: ' + fe.nextOpponents.join(', ') + '.' : '');
}

var AI_TOOL_HANDLERS = {
  get_team_form: aiToolTeamForm_,
  get_player_history: aiToolPlayerHistory_,
  compare_players: aiToolComparePlayers_,
  get_my_season: aiToolMySeason_,
  search_players: aiToolSearchPlayers_,
  get_league: aiToolLeague_,
  record_transfer: aiToolRecordTransfer_
};

/** Runs one tool call, turning any failure into a result the model can read. */
function runAiTool_(name, input, ctx) {
  var handler = AI_TOOL_HANDLERS[name];
  if (!handler) return { text: 'Unknown tool: ' + name, isError: true };
  try {
    return { text: String(handler(input || {}, ctx) || 'No data.'), isError: false };
  } catch (err) {
    // Returned as a tool_result rather than thrown: the model can say "I
    // could not look that up" and still answer the rest of the question,
    // where a thrown error loses the whole turn.
    return { text: 'That lookup failed: ' + (err && err.message ? err.message : String(err)), isError: true };
  }
}

/**
 * One request to the Messages API, with retry on Anthropic's own overload
 * signal (HTTP 529) and nothing else — a bad request or a bad key fails
 * immediately, because retrying those only wastes the user's time.
 *
 * Returns the parsed response body rather than a string: a tool-using turn
 * needs `stop_reason` and the full `content` array, and the caller decides
 * what to do with them.
 */
function callClaudeRaw_(payload) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('No AI key saved.');

  var maxAttempts = 3;
  var delayMs = 2000;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      muteHttpExceptions: true,
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(payload)
    });

    var code = res.getResponseCode();
    var body = JSON.parse(res.getContentText());
    var overloaded = code === 529 || (body.error && body.error.type === 'overloaded_error');
    if (overloaded && attempt < maxAttempts) {
      Utilities.sleep(delayMs);
      delayMs *= 2;
      continue;
    }
    if (code >= 400) {
      throw new Error((body.error && body.error.message) || ('Anthropic API returned ' + code));
    }
    return body;
  }
}

/** First text block of a response, which is the answer for a non-tool turn. */
function claudeText_(body) {
  var out = [];
  (body.content || []).forEach(function (block) {
    if (block.type === 'text' && block.text) out.push(block.text);
  });
  return out.join('\n').trim();
}

/**
 * Backwards-compatible wrapper for the copy-writing callers (the Ruling, the
 * Panel synthesis). Those are single-shot, no tools, and want a string.
 */
function callClaude_(systemPrompt, messages, maxTokens, model) {
  return claudeText_(callClaudeRaw_({
    model: model || AI_MODEL_COPY,
    max_tokens: maxTokens || 700,
    system: systemPrompt,
    messages: messages
  }));
}

/**
 * The assistant's turn: call, run whatever tools it asks for, call again,
 * until it stops asking. Bounded by AI_TOOL_MAX_ROUNDS so a model that keeps
 * looking things up cannot run out the Apps Script execution ceiling.
 *
 * Two details that are easy to get wrong and silently break the loop:
 *   - The assistant's content array is echoed back VERBATIM, thinking blocks
 *     included. Stripping them to text loses the reasoning state the model
 *     needs to continue its own turn.
 *   - Every tool_use block in one response must be answered by a tool_result
 *     in ONE following user message. Splitting them across messages teaches
 *     the model to stop making parallel calls.
 */
function runAiTurn_(systemBlocks, messages, ctx) {
  var used = [];
  for (var round = 0; round < AI_TOOL_MAX_ROUNDS; round++) {
    var body = callClaudeRaw_({
      model: AI_MODEL_CHAT,
      max_tokens: 2000,
      system: systemBlocks,
      messages: messages,
      tools: AI_TOOLS,
      output_config: { effort: 'medium' }
    });

    if (body.stop_reason !== 'tool_use') {
      return { text: claudeText_(body), toolsUsed: used };
    }

    var calls = (body.content || []).filter(function (b) { return b.type === 'tool_use'; });
    if (!calls.length) return { text: claudeText_(body), toolsUsed: used };

    messages.push({ role: 'assistant', content: body.content });

    var results = calls.map(function (call) {
      var out = runAiTool_(call.name, call.input, ctx);
      used.push({ name: call.name, input: call.input, ok: !out.isError });
      return { type: 'tool_result', tool_use_id: call.id, content: out.text, is_error: out.isError };
    });
    messages.push({ role: 'user', content: results });
  }

  // Out of rounds. Ask for an answer from what it has rather than returning
  // nothing — the tool results are all still in `messages`.
  var last = callClaudeRaw_({
    model: AI_MODEL_CHAT,
    max_tokens: 1200,
    system: systemBlocks,
    messages: messages.concat([{
      role: 'user',
      content: 'Answer now from what you have already looked up. Do not request anything further.'
    }]),
    output_config: { effort: 'low' }
  });
  return { text: claudeText_(last), toolsUsed: used };
}

/* --- conversation memory -------------------------------------------------
 *
 * The chat used to live entirely in the page's own JavaScript, so every
 * reload — and this page reloads on every Refresh, every team-id change and
 * every deploy — started a stranger. An assistant that cannot remember what
 * you asked it four minutes ago is a search box with a personality.
 *
 * Stored server-side in PropertiesService rather than in the browser: this
 * app is single-tenant by construction (one saved team id, one API key), the
 * Apps Script sandbox reloads its iframe origin often enough that
 * localStorage is unreliable, and keeping it server-side means the history is
 * there for the model without a round trip to fetch it back from the client.
 *
 * A single property caps at 9KB, so the transcript is trimmed from the oldest
 * end and each message is truncated. Losing the start of a long conversation
 * is a mild degradation; failing to save it at all is not.
 */
var CHAT_HISTORY_PROP = 'CHAT_HISTORY';
var CHAT_HISTORY_MAX_TURNS = 12;
var CHAT_MESSAGE_MAX_CHARS = 1200;

function readChatHistory_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CHAT_HISTORY_PROP);
  var list = raw ? (safeCall_(function () { return JSON.parse(raw); }) || []) : [];
  return list.filter(function (m) {
    return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content;
  });
}

function writeChatHistory_(history) {
  var trimmed = history.slice(-CHAT_HISTORY_MAX_TURNS).map(function (m) {
    return { role: m.role, content: String(m.content).slice(0, CHAT_MESSAGE_MAX_CHARS) };
  });
  // Drop from the oldest end until it fits, rather than throwing away the
  // whole transcript because one long answer pushed it over.
  while (trimmed.length > 2) {
    var json = JSON.stringify(trimmed);
    if (json.length < 8500) break;
    trimmed.shift();
  }
  safeCall_(function () {
    PropertiesService.getScriptProperties().setProperty(CHAT_HISTORY_PROP, JSON.stringify(trimmed));
  });
  return trimmed;
}

/** Client entry point: the transcript to render on page load. */
function getChatHistory() {
  return readChatHistory_();
}

function clearChatHistory() {
  PropertiesService.getScriptProperties().deleteProperty(CHAT_HISTORY_PROP);
  return { ok: true };
}

var AI_SYSTEM_PROMPT =
  'You are the assistant embedded in a Fantasy Premier League dashboard called the FPL Command Center. You are talking to ' +
  'the manager whose squad is described below, about their own team.\n\n' +
  'GROUNDING. The squad state below is current and authoritative — never contradict it, and never invent a price, a fixture, ' +
  'an injury or a statistic. But it is only the present. For anything historical — what a player has actually done, how a run ' +
  'of games went, how the manager’s season has gone, who their rivals own — USE YOUR TOOLS. Do not guess and do not answer ' +
  '"I don\'t have that" for something a tool can fetch. If a question turns on a fact you can look up, look it up first.\n\n' +
  'For any question about a club rather than a player (is a defence leaking, is a fixture good for attackers), call ' +
  'get_team_form. Each player line says how many of his club\'s last three matches he started; treat a rotation risk as a ' +
  'reason to doubt the projection.\n\n' +
  'If the manager says they have already made a transfer ("I sold X for Y", "just brought in Y"), call record_transfer and ' +
  'answer from what it returns — the squad state below was written before that move. When asked who to start or captain, ' +
  'lead with the XI CHECK and the RECOMMENDED ELEVEN, not the eleven the manager happens to have set.\n\n' +
  'ANSWERING. Match the length of the answer to the question. A question with a one-line answer gets one line. A question ' +
  'that genuinely turns on several things gets the several things, briefly. Lead with the answer, then the reason for it; ' +
  'never open with a restatement of the question or a preamble about what you are about to do.\n\n' +
  'HONESTY. Give the number and the margin, not just the verdict — "Haaland, but only by 0.4 expected points" is a better ' +
  'answer than "Haaland". When the arithmetic is close, say it is close: most weeks it is, and a confident-sounding ranking ' +
  'of near-identical options is the most common way this kind of tool misleads people. If the data genuinely cannot answer ' +
  'the question, say so plainly in a sentence.\n\n' +
  'VOICE. A well-informed friend who has done the reading, not a report generator. Plain sentences, no bullet-point dumps ' +
  'unless a list is genuinely the clearest form, no bold-faced headers, no restating the whole squad back at them.';

/**
 * Chat entry point called from the client.
 *
 * The dashboard state is rebuilt on every question rather than carried in the
 * transcript, so an answer given after a price change or an injury is grounded
 * in the state as it is now, not as it was when the conversation started.
 */
function askAI(question) {
  if (!hasAiKey_()) throw new Error('No AI key saved yet.');
  question = String(question || '').trim();
  if (!question) throw new Error('Ask a question first.');

  var data = getDashboardData();
  var context = buildAiContext_(data);

  var ctx = {
    data: data,
    bootstrap: getBootstrap_(),
    fixtureEase: null,
    history: null
  };
  // getDashboardData() above ran in this same execution, so both of these
  // are already built — recomputing the ease map or re-fetching the history
  // would be pure duplicate work on every question.
  ctx.fixtureEase = FIXTURE_EASE_MEMO_ ||
    buildFixtureEaseMap_(ctx.bootstrap, getFixtures_(), LOOKAHEAD_GWS);
  ctx.history = HISTORY_MEMO_ || safeCall_(function () { return getHistory_(getTeamId()); });
  // Several scoring terms read this global and are meaningless without it —
  // the tools call projectPoints_ directly, outside a dashboard render.
  if (!SEASON_CONTEXT_) SEASON_CONTEXT_ = safeCall_(function () { return loadSeasonContext_(ctx.bootstrap); });
  if (!PRICE_NORM_) PRICE_NORM_ = safeCall_(function () { return loadPriceNorms_(ctx.bootstrap); });

  // Two system blocks, split at the only boundary that matters for caching:
  // the instructions never change, the squad state changes on every load.
  // The cache breakpoint sits after the state block so a follow-up question
  // in the same session re-reads both rather than re-paying for them.
  var systemBlocks = [
    { type: 'text', text: AI_SYSTEM_PROMPT },
    { type: 'text', text: 'CURRENT SQUAD STATE\n\n' + context, cache_control: { type: 'ephemeral' } }
  ];

  var stored = readChatHistory_();
  var messages = stored.map(function (m) { return { role: m.role, content: m.content }; });
  messages.push({ role: 'user', content: question });

  var result = runAiTurn_(systemBlocks, messages, ctx);
  var answer = result.text || 'No answer came back — try asking again.';

  writeChatHistory_(stored.concat([
    { role: 'user', content: question },
    { role: 'assistant', content: answer }
  ]));

  return {
    answer: answer,
    // The page reloads itself when the squad it is showing is out of date.
    squadChanged: !!ctx.squadChanged,
    // Surfaced so the page can show what was actually looked up. An assistant
    // that quietly fetches a match log reads as one that made the numbers up.
    toolsUsed: result.toolsUsed.map(function (t) { return describeAiTool_(t); })
  };
}

/** Plain-language label for one tool call, for the transcript. */
function describeAiTool_(t) {
  var i = t.input || {};
  switch (t.name) {
    case 'get_player_history': return 'Read ' + (i.player || 'a player') + '’s match history';
    case 'compare_players': return 'Compared ' + ((i.players || []).join(', ') || 'players');
    case 'get_my_season': return 'Read your season, gameweek by gameweek';
    case 'search_players': return 'Searched the player pool' +
      (i.position ? ' for ' + i.position + 's' : '') +
      (i.max_price != null ? ' under £' + i.max_price + 'm' : '');
    case 'get_league': return 'Read your mini-league and its effective ownership';
    case 'get_team_form': return 'Read ' + (i.team || 'a club') + '’s recent results';
    case 'record_transfer': return 'Recorded ' + (i.bought || 'a player') + ' in for ' + (i.sold || 'a player');
    default: return t.name;
  }
}

/**
 * "The Ruling" — the week's headline verdict. Cached per gameweek in
 * PropertiesService so it's generated once (by whichever happens first:
 * a page load, or the weekly trigger below) and re-served after that,
 * keeping API cost flat regardless of how many times the page is opened.
 * Falls back to a rule-based verdict when no AI key is saved, so the
 * section never breaks — it just gets terser and less prose-y.
 */
/**
 * The verdict headline/body used to be cached per-gameweek and never
 * touched again, which meant it kept repeating a stale call (e.g. "swap
 * player X") even after live form/fixture data had moved on and the
 * underlying transfer/captain suggestions had already changed — the
 * player might have had a great match in the meantime and the copy
 * wouldn't know. It's now keyed on a signature of the actual calls the
 * text is based on (top transfer, top captain, live chip status), so a
 * regenerate only happens when one of those calls itself changes — not
 * on every minor score wobble, and not needlessly re-spending an AI call
 * when nothing that matters has moved.
 */
/* Never generate on the request path.
 *
 * A cache hit was fast and a cache miss called an external LLM inside the
 * page load — which meant the slowest loads in the app were precisely the
 * weeks something interesting had happened, since a changed signature is
 * exactly what a changed recommendation looks like. The manager who most
 * needed the page was the one who waited for it.
 *
 * Two paths now. On the REQUEST path (`allowGenerate` false) a stale or
 * missing verdict serves the rule-based one immediately and marks the cache
 * so the next trigger tick rewrites it. The page is never wrong in substance
 * — the rule-based verdict states the same transfer, captain and chip — it
 * just reads terser for one load. On the TRIGGER path (`weeklyVerdictCycle`,
 * off the clock, nobody waiting) generation is allowed and the prose lands in
 * the cache for every subsequent load.
 */
function getRuling_(eventId, data, allowGenerate) {
  var props = PropertiesService.getScriptProperties();
  var cacheKey = 'RULING_' + eventId;
  var signature = rulingSignature_(data);
  var cached = props.getProperty(cacheKey);
  if (cached) {
    try {
      var parsed = JSON.parse(cached);
      // A `pending` entry is the rule-based stand-in a page load left for the
      // trigger to replace. It used to be returned here like any other hit,
      // so the trigger (and the Diagnostics "force refresh") found it, saw a
      // matching signature and handed it straight back: once a page load got
      // in first, the written verdict never arrived for the rest of the week.
      if (parsed && parsed.signature === signature && !(allowGenerate && parsed.pending)) return parsed.ruling;
    } catch (e) { /* fall through and regenerate */ }
  }

  var fallback = buildRuleBasedRuling_(data, hasAiKey_() ? 'pending' : 'nokey');

  /* Safety net. Deferring generation to the trigger is only an improvement if
   * a trigger is actually running; without one, deferring would mean the AI
   * verdict silently never appears again for anyone who never installed it.
   * So the request path stays allowed to generate when no trigger exists —
   * accepting the slow load rather than losing the feature — and the trigger,
   * once installed, is what buys the fast one. */
  if (!allowGenerate && hasAiKey_()) {
    var noTrigger = safeCall_(function () { return !getTriggerStatus_().weeklyInstalled; });
    if (noTrigger) allowGenerate = true;
  }

  if (!allowGenerate) {
    // Store the fallback under the CURRENT signature so repeat loads are
    // served from cache too, with `pending` marking it as awaiting prose. The
    // trigger looks for exactly that flag.
    safeCall_(function () {
      props.setProperty(cacheKey, JSON.stringify({ signature: signature, ruling: fallback, pending: hasAiKey_() }));
    });
    return fallback;
  }

  var status = {};
  var ruling = hasAiKey_() ? safeCall_(function () { return generateAiRuling_(data, status); }) : null;
  // A withheld or failed verdict stays `pending`, so the next trigger tick
  // tries again rather than leaving the stand-in up all week.
  var pending = !ruling && hasAiKey_();
  if (!ruling) ruling = buildRuleBasedRuling_(data, !hasAiKey_() ? 'nokey' : (status.rejected ? 'withheld' : 'failed'));

  props.setProperty(cacheKey, JSON.stringify({
    signature: signature, ruling: ruling, pending: pending,
    // What was thrown away and why, for the Debug page's sake.
    rejected: status.rejected || null
  }));
  return ruling;
}

function rulingSignature_(data) {
  var transfer = (data.transferSuggestions || [])[0];
  var captain = (data.captainSuggestions || [])[0];
  var chip = data.chipBoard ? data.chipBoard.filter(function (c) {
    return c.status === 'Play now' || String(c.status).indexOf('Target') === 0;
  })[0] : null;

  return [
    // Bumped when the prompt or its checks change, so a verdict cached under
    // the old rules is rewritten rather than served for the rest of the week.
    RULING_PROMPT_VERSION,
    transfer ? (transfer.out + '>' + transfer.into) : '',
    captain ? captain.name : '',
    chip ? (chip.label + ':' + chip.status) : ''
  ].join('|');
}

function generateAiRuling_(data, status) {
  var context = buildAiContext_(data);
  var systemPrompt = 'You write the front-page verdict for a Fantasy Premier League dashboard. Newsprint tone: decisive, ' +
    'plain language, no hedging, no stat dumps. Given the data below, respond with EXACTLY two lines, nothing else:\n' +
    'Line 1: a headline of 22 characters or fewer per word-budget (aim for ~10-15 words) stating the week\'s single biggest ' +
    'call, e.g. "Wissa out, Isak in. Captain Salah. No chip."\n' +
    'Line 2: one supporting sentence (max 30 words) with the key number behind that call.\n' +
    'Rules: name a club only as the data below gives it for that player. Never supply a club from memory: squads ' +
    'change every season. Size the claim to the number: a gain of a few points is worth making, not "essential".\n\n' + context;

  var text = callClaude_(systemPrompt, [{ role: 'user', content: 'Write the verdict.' }], 200);
  var lines = text.split('\n').map(function (l) { return stripMarkdown_(l); }).filter(Boolean);
  var ruling = {
    headline: lines[0] || 'No strong verdict this week.',
    body: lines[1] || 'Squad looks broadly settled — see the sections below for the detail.',
    source: 'ai'
  };
  // Returning null hands getRuling_ the rule-based verdict instead.
  if (rulingNamesWrongClub_(ruling.headline + ' ' + ruling.body, data)) {
    if (status) status.rejected = ruling.headline + ' / ' + ruling.body;
    return null;
  }
  return ruling;
}

var RULING_PROMPT_VERSION = 'r2';

/* Names the clubs are also called by, beyond FPL's own `name` and
 * `short_name`. Bare "City" and "United" are left out: they are ambiguous. */
var CLUB_ALIASES = {
  'Aston Villa': ['Villa'], 'Brighton': ['Brighton & Hove Albion', 'Brighton and Hove Albion'],
  'Crystal Palace': ['Palace'], 'Man City': ['Manchester City'], 'Man Utd': ['Manchester United', 'Man United'],
  'Newcastle': ['Newcastle United'], "Nott'm Forest": ['Nottingham Forest', 'Forest'],
  'Spurs': ['Tottenham', 'Tottenham Hotspur'], 'Wolves': ['Wolverhampton', 'Wolverhampton Wanderers'],
  'West Ham': ['West Ham United'], 'Leeds': ['Leeds United'], 'Sheffield Utd': ['Sheffield United']
};

/* Does the verdict name a club the call it describes does not involve?
 *
 * GW7 2026-27 printed "Swap Konsa for Bogle. Brighton's form defence beats
 * Aston Villa's setup" when Konsa plays for Arsenal and Bogle for Leeds. Konsa
 * used to play for Villa: the copy model filled the clubs in from memory, and
 * Brighton came from elsewhere in the squad. So the allowed clubs are only
 * those of the players in the headline calls (top transfer, captain) and of
 * their next opponents, which the data spells out. Any other club named means
 * the text is not grounded, and the rule-based verdict is shown instead. */
function rulingNamesWrongClub_(text, data) {
  var clubs = data.clubs || [];
  if (!clubs.length || !text) return false;
  var shortToClub = {};
  clubs.forEach(function (c) { shortToClub[c.short] = c; });

  var allowed = {};
  var allow = function (c) { if (c) allowed[c.name] = true; };
  var allowShortsIn = function (str) {
    String(str || '').replace(/\b[A-Z]{3}\b/g, function (code) { allow(shortToClub[code]); return code; });
  };
  var byName = {};
  clubs.forEach(function (c) { byName[c.name] = c; });
  var t = (data.transferSuggestions || [])[0];
  if (t) {
    allow(byName[t.outClub]); allow(byName[t.inClub]);
    allowShortsIn(t.out); allowShortsIn(t.into); allowShortsIn(t.intoReason);
  }
  var cap = (data.captainSuggestions || [])[0];
  if (cap) { allowShortsIn(cap.team); allowShortsIn(cap.nextFixture); allow(byName[cap.team]); }

  var escape = function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  return clubs.some(function (c) {
    if (allowed[c.name]) return false;
    var names = [c.name].concat(CLUB_ALIASES[c.name] || []);
    var hit = names.some(function (n) { return new RegExp('(^|[^A-Za-z])' + escape(n) + '(?![A-Za-z])').test(text); }) ||
      new RegExp('\\b' + c.short + '\\b').test(text);
    return hit;
  });
}

/**
 * The model answers in markdown by default, and this text is escaped and
 * injected as plain prose — so a bolded headline rendered on the front page
 * as literal asterisks: "**Semenyo out, Stach in.**". Strips the emphasis
 * markers, list bullets, heading hashes and wrapping quotes rather than
 * rendering markdown, because the design calls for one typeface and no
 * inline styling in the verdict.
 */
function stripMarkdown_(line) {
  return String(line == null ? '' : line)
    .replace(/^\s*[-*+]\s+/, '')        // list bullet
    .replace(/^\s*#{1,6}\s*/, '')       // heading hashes
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // bold
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2') // italic
    .replace(/`([^`]+)`/g, '$1')        // code span
    .replace(/^\s*["'\u201c\u2018]+|["'\u201d\u2019]+\s*$/g, '') // wrapping quotes
    .trim();
}

/**
 * What the front page says when the numbers behind it do not hold up.
 *
 * Deliberately not a verdict. The failure mode this exists to prevent is a
 * confident recommendation resting on arithmetic that has already been shown
 * to be wrong, so the honest output is to say so and name the check that
 * failed rather than to publish the call anyway with a caveat attached.
 */
function buildInvalidModelRuling_(invariants) {
  var first = (invariants.failures || [])[0];
  var n = (invariants.failures || []).length;
  return {
    headline: 'Recommendations withheld — the model failed its own checks.',
    body: (first ? 'Failed: ' + first.check + ' (' + first.detail + ')' : 'A consistency check failed.') +
      (n > 1 ? ' Plus ' + (n - 1) + ' other check' + (n === 2 ? '' : 's') + '.' : '') +
      ' The sections below still show the underlying data; treat any figure in them as unverified.',
    source: 'invalid'
  };
}

/* Why the plain verdict is showing, said plainly. It used to say "add an
 * Anthropic API key" whatever the reason, which told a manager with a key
 * saved to go and save it again. */
var RULE_BASED_RULING_NOTE = {
  nokey: 'Rule-based verdict (add an Anthropic API key in the AI Assistant panel for a written weekly verdict).',
  pending: 'Rule-based verdict for now. The advice changed, and the written verdict is rewritten off the page load, within six hours.',
  withheld: 'Rule-based verdict. The written one named a club the data does not support, so it was withheld; it is retried every six hours.',
  failed: 'Rule-based verdict. The written one could not be generated this time; it is retried every six hours.'
};

function buildRuleBasedRuling_(data, reason) {
  var parts = [];
  if (data.transferSuggestions && data.transferSuggestions.length) {
    var t = data.transferSuggestions[0];
    parts.push(t.out.split(' (')[0] + ' out, ' + t.into.split(' (')[0] + ' in');
  }
  if (data.captainSuggestions && data.captainSuggestions.length) {
    parts.push('Captain ' + data.captainSuggestions[0].name);
  }
  var chipCall = 'No chip';
  if (data.chipBoard) {
    var playNow = data.chipBoard.filter(function (c) { return c.status === 'Play now' || String(c.status).indexOf('Target') === 0; })[0];
    if (playNow) chipCall = playNow.label + ' — ' + playNow.status;
  }
  parts.push(chipCall);

  return {
    headline: parts.length ? (parts.join('. ') + '.') : 'Squad looks settled — no strong changes flagged.',
    body: RULE_BASED_RULING_NOTE[reason] || RULE_BASED_RULING_NOTE.nokey,
    source: 'rules'
  };
}

/* ===================== WEEKLY SELF-GRADING ===================== */

/**
 * Records what this app told the manager to do for ONE gameweek — the
 * captain call, the top transfer call, the XI it would field, and every
 * per-player projection behind them — BEFORE results are known. Idempotent
 * per event: once a snapshot exists for a gameweek it is never overwritten,
 * so a later re-render (after the suggestions have changed because the
 * underlying data moved) can't quietly rewrite history.
 *
 * `eventId` is the DECISION gameweek — the one still being picked for. It
 * used to be `is_current || is_next`, which for a running season is always a
 * gameweek whose deadline has already gone, and that was a week-offset bug
 * with real consequences. Every projection stored here is `xp.next`, and
 * `xp.next` is the first gameweek of the ACTIONABLE horizon: once GW2's
 * deadline passes, that horizon starts at GW3. So the snapshot filed under
 * "GW2" held GW3's projections, and gradeFinishedGws_ then scored them
 * against GW2's actual results — feeding a systematic one-week mismatch
 * straight into buildCalibration_, which exists to correct the model from
 * exactly this data. The learned correction was being trained on noise.
 *
 * What was actually FIELDED in a gameweek is a different fact, known only
 * once that deadline passes, and is recorded separately by
 * recordActualLineup_. Grading joins the two.
 */
function snapshotDecision_(eventId, squad, transferSuggestions, captainSuggestions, lineup, opts) {
  if (eventId == null) return;
  opts = opts || {};
  var key = 'DECISION_' + eventId;
  var props = PropertiesService.getScriptProperties();
  /* Never overwritten — with one exception. Once the manager has told the app
   * which transfers they made (see saveDeclaredTransfers), the advice that
   * deserves grading is the advice for the squad they actually hold, not the
   * squad they had before the move. A changed declaration re-snapshots; the
   * deadline has not passed (this is only ever called for the decision
   * gameweek), so nothing already known about the outcome can leak in. */
  var declaredSig = opts.declaredSig || '';
  var existingRaw = props.getProperty(key);
  if (existingRaw) {
    var existing = safeCall_(function () { return JSON.parse(existingRaw); });
    if (!existing || (existing.declaredSig || '') === declaredSig) return;
  }
  // The check above and the write below are not atomic on their own: two
  // simultaneous first-loads of a gameweek would both see no snapshot and
  // both write, and "never overwrite" is the whole point of this function.

  var top = (captainSuggestions || [])[0];
  var transfer = (transferSuggestions || [])[0];

  var snapshot = {
    eventId: eventId,
    /* Marks this record as one whose projections belong to the gameweek it is
     * filed under. Records written before that was true carry no such marker,
     * and the calibration loop refuses to learn from them — see
     * gradeFinishedGws_. Discarding that history is the point: it was a week
     * out of step, so it was never evidence about anything. */
    projectionsFor: eventId,
    // Element id, not just the display name — grading used to re-find the
    // player by scanning bootstrap for a matching web_name, which silently
    // graded the wrong player whenever two share one (and graded nothing at
    // all if the name rendered differently).
    suggestedCaptain: top ? { name: top.name, id: null, xp: top.xp, margin: top.margin } : null,
    suggestedCaptainId: (function () {
      if (!top) return null;
      var match = squad.players.filter(function (p) { return p.name === top.name; })[0];
      return match ? match.id : null;
    })(),
    transferSuggested: transfer ? {
      outName: transfer.outName || transfer.out.split(' (')[0],
      inName: transfer.inName || transfer.into.split(' (')[0],
      outId: transfer.outId || null,
      inId: transfer.inId || null,
      projectedGain: transfer.projectedGain,
      usesHit: !!transfer.usesHit
    } : null,
    // The lineup call is gradeable too: did the XI this app would have
    // picked actually outscore the one that was set? That is a cleaner
    // question than the captain one (eleven decisions, not one) and it is
    // the only part of the weekly advice with no variance excuse.
    recommendedXI: (lineup && lineup.xiIds && lineup.xiIds.length === 11)
      ? lineup.xiIds.map(function (id) {
        var match = squad.players.filter(function (p) { return p.id === id; })[0];
        return { id: id, name: match ? match.name : null };
      })
      : null,
    /* What the model actually predicted, per player, before results existed.
     *
     * Without this the grading loop can only ever score DECISIONS — was the
     * captain right, did the transfer pay — and never the model underneath
     * them. Two dozen numbers a week is what turns "the app got this call
     * wrong" into "the app runs 8% hot on defenders", which is the difference
     * between a display and a feedback loop. Position is stored alongside
     * because the bias is very unlikely to be uniform across positions. */
    projections: squad.players.map(function (p) {
      return {
        id: p.id,
        pos: p.elementType,
        xp: p.xp ? Math.round(p.xp.next * 100) / 100 : null,
        // Uncalibrated — see projectPoints_. The calibration loop reads this.
        rawXp: p.xp && p.xp.rawNext != null ? p.xp.rawNext : null,
        started: !!p.isStarting
      };
    }),
    /* Every player's raw next-gameweek projection, not just the fifteen in
     * this squad. Fifteen players a week is ~19 midfielders after five
     * gameweeks — too few to tell a bias from a bad afternoon. The pool is
     * several hundred a week. Compact "id:xp" pairs because a script
     * property holds 9KB; the grading pass deletes it once it is scored. */
    pool: opts.pool || (opts.poolFn ? safeCall_(opts.poolFn) : null),
    declaredSig: declaredSig
  };
  withLock_(10000, function () {
    var again = props.getProperty(key); // re-check under the lock
    if (again) {
      var prev = safeCall_(function () { return JSON.parse(again); });
      if (!prev || (prev.declaredSig || '') === declaredSig) return;
    }
    props.setProperty(key, JSON.stringify(snapshot));
  });
}

/* Only players with a real projection are kept: a 0.1 for a fourth-choice
 * keeper carries no information about bias and costs space. */
var POOL_SNAPSHOT_MIN_XP = 0.3;

/** "id:rawXp,id:rawXp,..." for every player worth grading. */
function poolProjectionsCompact_(bootstrap, fixtureEase) {
  var parts = [];
  bootstrap.elements.forEach(function (el) {
    if (el.status === 'u') return;
    var xp = projectPoints_(el, fixtureEase);
    var raw = xp.rawNext != null ? xp.rawNext : xp.next;
    if (!(raw >= POOL_SNAPSHOT_MIN_XP)) return;
    parts.push(el.id + ':' + (Math.round(raw * 10) / 10));
  });
  return parts.join(',');
}

function parsePoolProjections_(str) {
  var out = [];
  String(str || '').split(',').forEach(function (pair) {
    var bits = pair.split(':');
    var id = parseInt(bits[0], 10), xp = parseFloat(bits[1]);
    if (isFinite(id) && isFinite(xp)) out.push({ id: id, xp: xp });
  });
  return out;
}

/**
 * What was actually FIELDED in a locked gameweek: the eleven that started and
 * who wore the armband.
 *
 * This is deliberately a separate record from the advice snapshot, written at
 * a different time. The advice for GW N is knowable (and must be frozen)
 * BEFORE N's deadline; what N was actually played with is only readable AFTER
 * it. Holding both in one record forced the app to pick one moment for both,
 * and it picked the wrong one — filing next week's advice against this week's
 * team sheet. Grading joins them by gameweek id.
 *
 * Idempotent, like the snapshot: a gameweek's team sheet is fixed once its
 * deadline passes, so the first read is the only one that matters.
 */
function recordActualLineup_(eventId, squad) {
  if (eventId == null || !squad || !squad.starting) return;
  var key = 'ACTUAL_' + eventId;
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(key)) return;

  var captain = squad.starting.filter(function (p) { return p.isCaptain; })[0];
  var record = {
    eventId: eventId,
    startingXI: squad.starting.map(function (p) { return { id: p.id, name: p.name }; }),
    captainId: captain ? captain.id : null
  };
  withLock_(10000, function () {
    if (props.getProperty(key)) return;
    props.setProperty(key, JSON.stringify(record));
  });
}

/** Live per-player points for a finished (or in-progress) gameweek. */
function getEventLive_(eventId) {
  return fetchJson_(BASE + '/event/' + eventId + '/live/');
}

/**
 * Grades every finished gameweek that has a decision snapshot but no
 * grade yet, then returns the most recent grade. This is the function
 * that makes "weekly self-grading" a real, checkable claim rather than
 * marketing copy: every call the app made gets checked against what the
 * live FPL data says actually happened, the first time this runs after
 * that gameweek finishes.
 *
 * Bounded to GRADE_BACKFILL_LIMIT gameweeks per run. This sits on the
 * critical path of a dashboard render, and an ungraded backlog (a season's
 * worth of snapshots after the cache or the trigger has been down) would
 * otherwise fire one /event/{id}/live/ request per gameweek in a single
 * execution and blow the Apps Script runtime limit — turning a stale grade
 * into a dashboard that will not load at all. The backlog simply clears a
 * few gameweeks per visit instead.
 */
var GRADE_BACKFILL_LIMIT = 3;

function gradeFinishedGws_(bootstrap) {
  var props = PropertiesService.getScriptProperties();
  var finishedEvents = bootstrap.events.filter(function (e) { return e.finished; }).map(function (e) { return e.id; });

  var graded = 0;
  finishedEvents.slice().reverse().forEach(function (eventId) {
    if (graded >= GRADE_BACKFILL_LIMIT) return;
    var gradeKey = 'GRADE_' + eventId;
    if (props.getProperty(gradeKey)) return; // already graded
    var raw = props.getProperty('DECISION_' + eventId);
    if (!raw) return; // nothing was snapshotted for this gameweek — can't grade it
    graded++;

    safeCall_(function () {
      var decision = JSON.parse(raw);
      /* The team sheet for this gameweek, written by recordActualLineup_ once
       * the deadline passed. Snapshots taken before advice and actuals were
       * split carry their own startingXI/captainId, so those still grade —
       * the fallback is what keeps existing history readable rather than
       * silently ungradeable. */
      var actual = safeCall_(function () {
        var a = props.getProperty('ACTUAL_' + eventId);
        return a ? JSON.parse(a) : null;
      }) || (decision.startingXI ? { startingXI: decision.startingXI, captainId: decision.captainId } : null);
      if (!actual || !actual.startingXI) return;

      var live = getEventLive_(eventId);
      var pointsById = {};
      var liveById = {};
      live.elements.forEach(function (el) {
        pointsById[el.id] = el.stats ? el.stats.total_points : 0;
        liveById[el.id] = el;
      });

      var squadWithPoints = actual.startingXI.map(function (p) {
        return { id: p.id, name: p.name, points: pointsById[p.id] || 0 };
      });
      var actualTop = squadWithPoints.slice().sort(function (a, b) { return b.points - a.points; })[0];
      var captainEntry = actual.captainId
        ? actual.startingXI.filter(function (x) { return x.id === actual.captainId; })[0]
        : null;
      var captainPlayer = captainEntry ? { name: captainEntry.name, points: pointsById[captainEntry.id] || 0 } : null;

      var grade = {
        eventId: eventId,
        captainName: captainPlayer ? captainPlayer.name : (decision.suggestedCaptain ? decision.suggestedCaptain.name : null),
        captainPoints: captainPlayer ? captainPlayer.points : null,
        actualTopScorerName: actualTop ? actualTop.name : null,
        actualTopScorerPoints: actualTop ? actualTop.points : null,
        captainCorrect: !!(captainPlayer && actualTop && captainPlayer.name === actualTop.name),
        // The points the doubling actually left behind. Whether the captain
        // was literally top scorer is a harsh binary — being one point off
        // the best pick scores as a miss — so the gap is recorded too, and
        // it is the number the track record leans on.
        captainPointsMissed: (captainPlayer && actualTop)
          ? Math.max(0, actualTop.points - captainPlayer.points)
          : null,
        /* Captain EFFICIENCY: the doubled points banked as a share of what a
         * perfect armband would have banked. This is the metric the track
         * record should have been leading with all along.
         *
         * "Was he the top scorer" is a tail question, and scoring a decision
         * on whether it caught the tail flatters nobody: even an optimal
         * mean-maximising picker only lands it a quarter of the time, and a
         * pick one point off the best reads as a total miss. Efficiency
         * measures the thing that actually hit the manager's score, degrades
         * gracefully, and is comparable week to week. */
        captainEfficiency: (captainPlayer && actualTop && actualTop.points > 0)
          ? Math.round((captainPlayer.points / actualTop.points) * 1000) / 1000
          : null,
        // Where the captain finished among the eleven. A pick that lands
        // second or third every week is a good model having ordinary luck;
        // a binary cannot tell that apart from one that lands eleventh.
        captainRankInXi: (captainPlayer && squadWithPoints.length)
          ? squadWithPoints.slice().sort(function (a, b) { return b.points - a.points; })
              .findIndex(function (p) { return p.name === captainPlayer.name; }) + 1
          : null,
        xiSize: squadWithPoints.length
      };

      /* Calibration, version 2.
       *
       * Three things were wrong with the first version, and each one pushed
       * the measured bias in its own direction:
       *   - it graded only the fifteen players in this squad (~19 midfielders
       *     after five gameweeks — noise, not a bias);
       *   - it graded the CALIBRATED projection, so each week's correction was
       *     learned on top of the last one and compounded;
       *   - it dropped players who did not feature, but scored them against a
       *     projection that already priced in the chance of not featuring —
       *     an unconditional forecast against a conditional outcome, which
       *     reads every forecast as too low.
       * Now: the whole pool, the raw projection, and every outcome including
       * the zeros. Only projections of CAL_MIN_PREDICTED or more are counted,
       * which is selection on the forecast (harmless) rather than on the
       * outcome (biasing). */
      var poolRows = decision.pool ? parsePoolProjections_(decision.pool) : [];
      if (poolRows.length && String(decision.projectionsFor) === String(eventId)) {
        var posById = {};
        bootstrap.elements.forEach(function (el) { posById[el.id] = el.element_type; });
        var byPos = {};
        poolRows.forEach(function (row) {
          if (row.xp < CAL_MIN_PREDICTED) return;
          var pos = posById[row.id];
          if (!pos) return;
          var acc = byPos[pos] || (byPos[pos] = { predicted: 0, actual: 0, n: 0, absErr: 0 });
          var actualPts = pointsById[row.id] || 0;
          acc.predicted += row.xp;
          acc.actual += actualPts;
          acc.absErr += Math.abs(actualPts - row.xp);
          acc.n++;
        });
        var calibration = { byPosition: {}, predicted: 0, actual: 0, n: 0, absErr: 0 };
        Object.keys(byPos).forEach(function (pos) {
          var row = byPos[pos];
          calibration.byPosition[pos] = {
            predicted: Math.round(row.predicted * 100) / 100,
            actual: row.actual,
            n: row.n,
            mae: Math.round((row.absErr / row.n) * 100) / 100
          };
          calibration.predicted += row.predicted;
          calibration.actual += row.actual;
          calibration.absErr += row.absErr;
          calibration.n += row.n;
        });
        calibration.predicted = Math.round(calibration.predicted * 100) / 100;
        calibration.mae = calibration.n ? Math.round((calibration.absErr / calibration.n) * 100) / 100 : null;
        delete calibration.absErr;
        // Read by buildCalibration_ as the proof that this week's evidence is
        // week-aligned, raw, whole-pool and unconditional.
        calibration.alignedProjections = true;
        calibration.version = CALIBRATION_VERSION;
        if (calibration.n) grade.calibration = calibration;
      }

      if (decision.transferSuggested) {
        var ts = decision.transferSuggested;
        var outId = ts.outId || findElementIdByName_(bootstrap, ts.outName);
        var inId = ts.inId || findElementIdByName_(bootstrap, ts.inName);
        if (outId && inId) {
          var outPts = pointsById[outId] || 0;
          var inPts = pointsById[inId] || 0;
          grade.transferOutName = ts.outName;
          grade.transferInName = ts.inName;
          grade.transferNetGain = inPts - outPts;
          grade.transferWasRight = inPts > outPts;
          grade.transferUsedHit = !!ts.usesHit;
        }
      }

      if (decision.recommendedXI && decision.recommendedXI.length === squadWithPoints.length) {
        var recPts = decision.recommendedXI.reduce(function (s, p) { return s + (pointsById[p.id] || 0); }, 0);
        var actualPts = squadWithPoints.reduce(function (s, p) { return s + p.points; }, 0);
        grade.lineupGain = recPts - actualPts;
        grade.lineupWasRight = recPts > actualPts;
      }

      props.setProperty(gradeKey, JSON.stringify(grade));
      // The pool has been scored; it is the bulk of the record and a season
      // of them would exhaust the property store.
      if (decision.pool) {
        delete decision.pool;
        props.setProperty('DECISION_' + eventId, JSON.stringify(decision));
      }
    });
  });

  var gradedEvents = finishedEvents.filter(function (id) { return !!props.getProperty('GRADE_' + id); });
  if (!gradedEvents.length) return null;
  var latest = gradedEvents[gradedEvents.length - 1];
  var grade = JSON.parse(props.getProperty('GRADE_' + latest));
  grade.summary = buildGradeSummary_(grade);
  return grade;
}

function findElementIdByName_(bootstrap, webName) {
  var matches = bootstrap.elements.filter(function (el) { return el.web_name === webName; });
  return matches.length === 1 ? matches[0].id : null; // ambiguous name grades nothing rather than the wrong player
}

function buildGradeSummary_(grade) {
  var bits = [];
  if (grade.captainName) {
    bits.push('GW' + grade.eventId + ' captain call (' + grade.captainName + ', ' + grade.captainPoints + ' pts) ' +
      (grade.captainCorrect ? 'was right — top scorer in your XI.' : 'missed — ' + grade.actualTopScorerName + ' top-scored with ' + grade.actualTopScorerPoints + ' pts.'));
  }
  if (grade.transferNetGain !== undefined) {
    bits.push('Transfer call (' + grade.transferInName + ' in for ' + grade.transferOutName + ') ' +
      (grade.transferWasRight ? 'paid off: +' + grade.transferNetGain + ' pts.' : 'cost ' + Math.abs(grade.transferNetGain) + ' pts.'));
  }
  if (grade.lineupGain !== undefined && grade.lineupGain !== 0) {
    bits.push('The XI this app would have started ' +
      (grade.lineupGain > 0 ? 'beat yours by ' + grade.lineupGain : 'trailed yours by ' + Math.abs(grade.lineupGain)) + ' pts.');
  }
  return bits.length ? bits.join(' ') : ('GW' + grade.eventId + ': not enough data to grade this week.');
}

/* ===================== THE ACTION LIST ===================== */

/**
 * Every decision the app is making this week, once.
 *
 * The front page used to state the same four decisions three times over:
 * the verdict columns named the transfer, the captain and the chip; the
 * article deck restated the transfer, the captain and the lineup; and then
 * the Transfers, Lineup and Bench-order sections said all of it again in
 * full. Three tellings, no single place that answered "so what do I
 * actually do".
 *
 * This is that place. Everything else on the page becomes evidence for it.
 *
 * The figures deliberately carry their own window. A transfer gain is
 * points over the whole lookahead; a lineup gain is points THIS gameweek;
 * a captain margin is neither — it is the gap to the next-best option. The
 * old page printed all three as bare "+N" figures side by side as though
 * they were the same unit, so the totals here are kept separate rather than
 * summed into one meaningless number.
 */
function buildActionList_(data) {
  var actions = [];
  var marks = {}; // playerId -> { label, n } for the squad list to render in place

  /* "this gameweek" is ambiguous on any day a gameweek is being played: it
   * reads as the one on the screen with live scores next to it, when every
   * figure here belongs to the one still open. Naming the gameweek costs two
   * characters and removes the ambiguity entirely. */
  var gw = data.pickingForEventId;
  var thisGw = gw != null ? 'GW' + gw : 'this gameweek';
  var overHorizon = function (n) {
    return gw != null ? 'GW' + gw + '\u2013' + (gw + n - 1) : n + ' gameweeks';
  };

  /* Decided first, because a Wildcard or Free Hit is not an extra line on
   * top of the transfers — it is the alternative to them. Listing both is
   * how the page used to recommend a six-week plan and, five lines further
   * down, the chip that throws it away. */
  var chip = (data.chipBoard || []).filter(function (b) { return b.status === 'Play now'; })[0];
  /* A chip whose valuation the model itself flagged as implausible does not
   * get recommended as an action.
   *
   * The plausibility checks were reported only on the Debug page, which is
   * the one place nobody reads before making a transfer. So a Wildcard priced
   * at +434.8 over six gameweeks — a figure the invariant had already flagged
   * — was still rendered on the front page as instruction number six, with a
   * confident sentence under it. Flagging a number in one place while acting
   * on it in another is not a guard rail.
   *
   * The chip board below still shows the row and its figure; what is withheld
   * is the recommendation to go and play it. */
  var chipFlagged = chip && (((data.invariants || {}).warnings) || []).filter(function (w) {
    return w.check.indexOf(chip.label.replace(/ \d+$/, '')) === 0;
  }).length > 0;
  if (chip && chipFlagged) chip = null;
  var chipReplacesTransfers = !!(chip && /^Wildcard|^Free Hit/.test(chip.label));

  (chipReplacesTransfers ? [] : (data.transferSuggestions || [])).forEach(function (t) {
    var n = actions.length + 1;
    if (t.outId) marks[t.outId] = { label: 'Out', n: n, tone: 'out' };
    actions.push({
      kind: 'transfer',
      n: n,
      title: t.outName + ' out · ' + t.inName + ' in',
      detail: (t.xiNote ? t.xiNote + ' ' : '') +
        t.outName + ' projects ' + t.outXp.toFixed(1) + ' points over the next ' + t.horizonGws +
        ' gameweeks; ' + t.inName + ' projects ' + t.inXp.toFixed(1) + '. ' + t.costLine + '.' +
        (t.usesHit && t.waitCost != null
          ? ' Worth the hit now: waiting for next week\u2019s free transfer would cost ' + t.waitCost.toFixed(1) + '.'
          : ''),
      figure: (t.usesHit ? t.netGain : t.projectedGain),
      figurePrefix: '+',
      figureUnit: 'pts · ' + overHorizon(t.horizonGws),
      tag: t.usesHit ? '−4 hit' : 'Free transfer',
      tone: t.usesHit ? 'warm' : 'cool'
    });
  });

  /* Moves that are worth making but not worth a hit this week. Listed so
   * the page says "wait" rather than going quiet about a move it rates. */
  (chipReplacesTransfers ? [] : (data.deferredTransfers || [])).forEach(function (dm) {
    actions.push({
      kind: 'plan',
      n: actions.length + 1,
      title: (dm.makeInEvent ? 'GW' + dm.makeInEvent + ': ' : 'Next week: ') + dm.outName + ' out · ' + dm.inName + ' in',
      detail: 'Not this week. ' + dm.note,
      figure: dm.gainIfWaited,
      figurePrefix: '+',
      figureUnit: 'pts if made then, free',
      tag: 'Wait',
      tone: 'cool'
    });
  });

  var l = data.lineup;
  var blockers = l ? (l.xiWarnings || []).filter(function (w) { return w.severity === 'unavailable'; }) : [];
  if (l && (l.gain > 0.05 || blockers.length)) {
    var n = actions.length + 1;
    (l.changes || []).forEach(function (c) { c.actionN = n; });
    var bits = [];
    (l.changes || []).forEach(function (c) { bits.push(c.inName + ' over ' + c.outName); });
    if ((l.formationIn || []).length) {
      bits.push('start ' + l.formationIn.map(function (p) { return p.name; }).join(' and ') +
        '; bench ' + (l.formationOut || []).map(function (p) { return p.name; }).join(' and '));
    }
    actions.push({
      kind: 'lineup',
      n: n,
      title: blockers.length
        ? 'Fix your eleven: ' + blockers.map(function (w) { return w.name; }).join(' and ') + ' cannot play'
        : (l.formationChanged ? 'Switch to ' + l.formation : 'Change your eleven'),
      detail: (blockers.length ? blockers.map(function (w) { return w.text; }).join(' ') + ' ' : '') +
        (bits.length ? bits.join('; ') + '. ' : '') + 'Costs no transfer.',
      figure: l.gain,
      figurePrefix: '+',
      figureUnit: 'pts · ' + thisGw,
      tag: 'Free',
      tone: 'cool'
    });
    // The squad list marks these in place rather than repeating them below.
    (l.changes || []).forEach(function (c) { c.markN = n; });
    l.markN = n;
  }

  var c = (data.captainSuggestions || [])[0];
  var alt = (data.captainSuggestions || [])[1];
  if (c) {
    // The figure is the simulated chance he tops the eleven, not the gap in
    // means. A margin of means was never what the pick was made on once the
    // model started ranking on rank movement, and printing it implied a
    // precision the decision does not have.
    var capDetail = c.nextFixture + '. Projects ' + c.xp.toFixed(1) + ', doubled ' + c.xpDoubled.toFixed(1) + '.';
    if (c.topShare != null) {
      capDetail += ' Tops your eleven in ' + Math.round(c.topShare) + '% of simulations' +
        (alt && alt.topShare != null ? ' against ' + Math.round(alt.topShare) + '% for ' + alt.name : '') + '.';
    } else if (alt) {
      capDetail += ' ' + alt.name + ' is next at ' + alt.xp.toFixed(1) + '.';
    }
    if (c.beatFieldShare != null) {
      capDetail += ' Beats your league’s captain ' + Math.round(c.beatFieldShare) + '% of the time.';
    }
    if (c.disagreesWithMean) capDetail += ' ' + c.disagreesWithMean.note;
    actions.push({
      kind: 'captain',
      n: actions.length + 1,
      title: 'Captain ' + c.name,
      detail: capDetail,
      figure: c.topShare != null ? c.topShare : (c.margin != null ? c.margin : null),
      figurePrefix: c.topShare != null ? '' : '+',
      figureDecimals: c.topShare != null ? 0 : 1,
      figureUnit: c.topShare != null ? '% chance he tops your XI' : 'pts clear of next',
      tag: c.confidence || null,
      tone: c.confidence === 'Clear' ? 'cool' : 'warm'
    });
  }

  if (chip) {
    actions.push({
      kind: 'chip', n: actions.length + 1,
      title: 'Play your ' + chip.label,
      detail: chip.detail + (chipReplacesTransfers && (data.transferSuggestions || []).length
        ? ' This replaces the ' + data.transferSuggestions.length + ' transfer' +
          (data.transferSuggestions.length === 1 ? '' : 's') + ' the plan would otherwise make — do not make both.'
        : ''),
      figure: chip.value != null ? chip.value : null,
      figurePrefix: chip.value != null && chip.value >= 0 ? '+' : '',
      figureUnit: chip.value != null ? 'pts the chip is worth' : null,
      tag: 'Chip', tone: 'warm'
    });
  }

  // Kept apart on purpose — see the note above about units.
  var horizonPoints = 0, horizonGws = null, thisWeekPoints = 0;
  actions.forEach(function (a) {
    if (a.kind === 'transfer' && a.figure != null) { horizonPoints += a.figure; horizonGws = (data.transferSuggestions[0] || {}).horizonGws; }
    if (a.kind === 'lineup' && a.figure != null) thisWeekPoints += a.figure;
  });

  var summaryBits = [];
  var transferCount = actions.filter(function (a) { return a.kind === 'transfer'; }).length;
  if (transferCount) {
    summaryBits.push('The ' + (transferCount === 1 ? 'transfer is' : transferCount + ' transfers are') +
      ' worth ' + horizonPoints.toFixed(1) + ' points over ' + (horizonGws || LOOKAHEAD_GWS) + ' gameweeks');
  }
  if (thisWeekPoints > 0) {
    summaryBits.push('the lineup change is worth ' + thisWeekPoints.toFixed(1) + ' this gameweek and costs nothing');
  }
  if (!actions.length) {
    return {
      actions: [], marks: {},
      headline: 'Nothing to do this week.',
      summary: 'No transfer clears the bar, your eleven is already the best available, and the captain call is the obvious one. Bank the transfer.',
      deadline: data.deadline || null
    };
  }

  return {
    actions: actions,
    marks: marks,
    // "Wait" lines are advice about a later deadline, not moves to make now.
    headline: (function () {
      var now = actions.filter(function (a) { return a.kind !== 'plan'; }).length;
      var later = actions.length - now;
      return now
        ? now + ' move' + (now === 1 ? '' : 's') + ' before the deadline' + (later ? ', ' + later + ' to wait on.' : '.')
        : 'Nothing to do now; ' + later + ' move' + (later === 1 ? '' : 's') + ' to make with next week\u2019s free transfer.';
    })(),
    summary: summaryBits.length
      ? summaryBits.join('; ') + '. Everything below this is the evidence for these ' + actions.length + ' lines.'
      : 'Everything below this is the evidence for these ' + actions.length + ' lines.',
    horizonPoints: Math.round(horizonPoints * 10) / 10,
    thisWeekPoints: Math.round(thisWeekPoints * 10) / 10,
    deadline: data.deadline || null
  };
}

/* ===================== THE RULING'S ARTICLES ===================== */

/**
 * The front page carried one verdict and three columns, and every other
 * finding on the page sat below the fold in its own section. A reader who
 * only looked at the top learned the transfer, the captain and the chip, and
 * nothing else — not that their gameweek was already going badly, not that
 * they were leaving points on the bench, not that the app's own captain
 * calls had been landing 17% of the time.
 *
 * These are short articles for the top of the page, each one a header and a
 * finding: a decision or an observation in plain language, with the
 * arithmetic behind it. All of it is drawn from sections already computed,
 * so nothing here costs an extra call, and all of it is rule-based rather
 * than AI-written — these are facts about the manager's own team, and a
 * model paraphrasing them could only make them less true.
 *
 * More candidates are built than are shown. They are ordered by how much
 * they should matter to a reader right now — a gameweek in flight outranks
 * anything about next week — and the first ARTICLE_LIMIT with real content
 * are the ones that run.
 */
var ARTICLE_LIMIT = 5;

function buildArticles_(data) {
  var out = [];

  function add(kicker, headline, body, figure, figureLabel) {
    if (!headline || !body) return;
    out.push({
      kicker: kicker, headline: headline, body: body,
      figure: figure != null ? String(figure) : null,
      figureLabel: figureLabel || null
    });
  }

  // 1. The gameweek. In flight it outranks everything — it is the only thing
  //    on this page the reader cannot change and is watching anyway. Between
  //    gameweeks the same slot carries how the last one went.
  var lg = data.liveGameweek;
  if (!lg && data.lastGameweek) {
    var g = data.lastGameweek;
    add('Last time out',
      g.vsAverage != null && g.vsAverage >= 0
        ? 'GW' + g.eventId + ' beat the average by ' + g.vsAverage + '.'
        : (g.vsAverage != null ? 'GW' + g.eventId + ' fell ' + Math.abs(g.vsAverage) + ' short of the average.'
          : 'GW' + g.eventId + ' is in the books.'),
      (g.worked || []).concat(g.didntWork || []).slice(0, 2).join(' '),
      g.points != null ? g.points : null, 'Points');
  }
  if (lg) {
    var stateBits = [];
    if (lg.playersInPlay) stateBits.push(lg.playersInPlay + ' playing now');
    if (lg.playersYetToPlay) stateBits.push(lg.playersYetToPlay + ' still to play');
    var vs = lg.vsAverage != null
      ? (lg.vsAverage >= 0 ? lg.vsAverage + ' above' : Math.abs(lg.vsAverage) + ' below') + ' the average of ' + lg.average
      : null;

    var body = [
      lg.complete ? 'Every player has finished.'
        : (stateBits.length ? stateBits.join(', ') + '.' : 'Matches under way.'),
      vs ? 'That is ' + vs + '.' : null,
      lg.captain ? 'Captain ' + lg.captain.name + ' has ' + lg.captain.points + ' (' + lg.captain.contributed + ' doubled).' : null,
      lg.autosubsAvailable
        ? lg.blanked.join(', ') + ' did not feature, so autosubs will cover that from your bench.'
        : (lg.benchPoints > 0 ? lg.benchPoints + ' points sat on the bench.' : null)
    ].filter(Boolean).join(' ');

    add('Gameweek ' + lg.eventId + ' live',
      lg.complete ? 'Gameweek finished on ' + lg.pointsSoFar + '.' : lg.pointsSoFar + ' points and counting.',
      body, lg.pointsSoFar, lg.complete ? 'Final' : 'Points so far');
  }

  /*
   * The armband, the lineup and the next planned move used to be articles
   * here AND verdict columns above AND full sections below — the same three
   * decisions told three times. They live in the action list now, once.
   * What remains in this deck is context: things worth knowing that are not
   * themselves something to do.
   */

  // Rank is relative — the thing most managers never think about. When the
  // league's own effective ownership is available it replaces the game-wide
  // template read here: a named rival's captain is a sharper fact than a
  // global ownership percentage, and it is the table the manager is actually
  // trying to win.
  var eo = data.leagueEo;
  var o = data.ownershipEdge;
  if (eo && !eo.unavailable && (eo.threats || []).length) {
    var top = eo.threats[0];
    add('Rank risk',
      top.name + ' is on ' + top.eo.toFixed(0) + '% effective ownership and you do not own him.',
      eo.summary + ' ' + top.name + ' is in ' + top.owned.toFixed(0) + '% of your rivals\u2019 squads and captained by ' +
        top.captained.toFixed(0) + '% of them, projecting ' + top.xpNext.toFixed(1) + ' points this gameweek.',
      (eo.net >= 0 ? '+' : '') + eo.net.toFixed(1), 'Net exposure vs your league');
  } else if (o && (o.missing || []).length) {
    add('Rank risk',
      'You are exposed on ' + o.missing.length + ' template ' + (o.missing.length === 1 ? 'player' : 'players') + '.',
      o.summary + ' The biggest is ' + o.missing[0].name + ' at ' + o.missing[0].ownership.toFixed(0) + '% owned.',
      o.exposure != null ? o.exposure.toFixed(1) : null, 'Points of rank downside');
  } else if (o && (o.differentials || []).length) {
    add('Rank risk', 'You own the template.',
      o.summary + ' Your differentials are the only thing that can move you up: ' +
        o.differentials.slice(0, 3).map(function (d) { return d.name + ' (' + d.ownership.toFixed(1) + '%)'; }).join(', ') + '.',
      null, null);
  }

  // Where fixtures turn — the reason a move is worth making later rather than now.
  var swing = data.roadmap && (data.roadmap.fixtureSwings || [])[0];
  if (swing) {
    add('Fixtures turn',
      swing.club + '\u2019s run gets ' + swing.direction + ' at GW' + swing.turnsAt + '.',
      'Average difficulty moves from ' + swing.before.toFixed(1) + ' to ' + swing.after.toFixed(1) +
        ', which affects ' + swing.players.join(', ') + '. This is what decides when a move is worth making, not just whether.',
      'GW' + swing.turnsAt, 'Turns ' + swing.direction);
  }

  // Price movement. The forward-looking half leads when there is anything
  // to act on — a recommended buy about to rise is the one thing on this
  // page with a clock on it. Settled changes are money that has already
  // moved, so they only run when nothing is still in play.
  var pw = data.priceWatch || {};
  if (pw.urgent) {
    add('Price watch',
      pw.urgent.name + ' looks like rising before the next price update.',
      'He is a recommended transfer in and has taken net transfers worth ' +
        Math.round(pw.urgent.pressure * 100) + '% of his owner base this gameweek. Buying tonight is worth 0.1 against buying tomorrow, ' +
        'and you only ever bank half of a rise you did not buy into. Prices update in the small hours, UK time.',
      '\u00a3' + pw.urgent.price.toFixed(1) + 'm', 'Before the next update');
  } else if ((pw.targets || []).length || (pw.squad || []).length) {
    var moving = (pw.targets || []).concat(pw.squad || []);
    var up = moving.filter(function (p) { return p.direction === 'rise'; });
    var down = moving.filter(function (p) { return p.direction !== 'rise'; });
    add('Price watch',
      down.length > up.length ? 'Value is draining out of your squad.' : 'The market is moving on players you hold.',
      [up.length ? up.map(function (p) { return p.name; }).join(', ') + ' under buying pressure' : null,
       down.length ? down.map(function (p) { return p.name; }).join(', ') + ' under selling pressure' : null]
        .filter(Boolean).join('; ') + '. Selling price is only half of any rise, so a fall costs you more than a rise earns.',
      null, null);
  } else if ((pw.settled || []).length) {
    var rises = pw.settled.filter(function (p) { return p.direction === 'rise'; });
    var falls = pw.settled.filter(function (p) { return p.direction !== 'rise'; });
    add('Price watch',
      rises.length === falls.length ? 'Prices moved both ways.'
        : (rises.length > falls.length ? 'Your squad gained value.' : 'Your squad lost value.'),
      [rises.length ? rises.map(function (p) { return p.name; }).join(', ') + ' rose' : null,
       falls.length ? falls.map(function (p) { return p.name; }).join(', ') + ' fell' : null]
        .filter(Boolean).join('; ') + ' this gameweek. Nothing else in the squad is under pressure right now.',
      null, null);
  }

  // Whether any of this advice has been working.
  var tr = data.trackRecord;
  if (tr && (tr.learnings || []).length && tr.gwsGraded >= 3) {
    add('Our record', tr.gwsGraded + ' gameweeks graded.', tr.learnings[0],
      tr.captainHitRate != null ? tr.captainHitRate + '%' : null,
      tr.captainHitRate != null ? 'Captain calls right' : null);
  }

  return out.slice(0, ARTICLE_LIMIT);
}

/* ===================== LIVE GAMEWEEK ===================== */

/**
 * How the gameweek in progress is actually going.
 *
 * The dashboard had a blind spot exactly when a manager looks at it most:
 * between Saturday lunchtime and Monday night it showed next week's advice
 * and last week's review, and said nothing at all about the matches being
 * played. Everything needed is one call away — /event/{id}/live/ carries
 * per-player points, minutes and provisional bonus for the gameweek in
 * flight.
 *
 * "Yet to play" is decided from the fixture list rather than from minutes:
 * a player on zero minutes whose match kicks off tomorrow and one who was
 * left on the bench this afternoon both read as zero, and telling them apart
 * is the whole point of a live view.
 *
 * Cached for LIVE_CACHE_TTL. Live scores move constantly but not per second,
 * and this sits on the critical path of every page load during the one
 * window when the page gets refreshed most.
 */
var LIVE_CACHE_TTL = 180; // 3 minutes

function getEventLiveCached_(eventId) {
  var key = 'LIVE_' + eventId;
  var cached = safeCall_(function () { return CacheService.getScriptCache().get(key); });
  if (cached) {
    var parsed = safeCall_(function () { return JSON.parse(cached); });
    if (parsed) return parsed;
  }
  var live = getEventLive_(eventId);
  // Only the two fields this needs, so it fits a cache value comfortably.
  var slim = { elements: (live.elements || []).map(function (e) {
    return { id: e.id, points: e.stats ? e.stats.total_points : 0, minutes: e.stats ? e.stats.minutes : 0, bonus: e.stats ? e.stats.bonus : 0 };
  }) };
  safeCall_(function () { CacheService.getScriptCache().put(key, JSON.stringify(slim), LIVE_CACHE_TTL); });
  return slim;
}

function buildLiveGameweek_(bootstrap, fixtures, squad, currentEvent) {
  if (!currentEvent || currentEvent.finished) return null;
  // Before the deadline there is nothing live to report — that is the
  // upcoming gameweek, which every other section on the page already covers.
  var deadline = Date.parse(currentEvent.deadline_time);
  if (!isNaN(deadline) && deadline > Date.now()) return null;

  var live = safeCall_(function () { return getEventLiveCached_(currentEvent.id); });
  if (!live || !live.elements) return null;

  var statsById = {};
  live.elements.forEach(function (e) { statsById[e.id] = e; });

  // Fixture state per club for this gameweek: not started / in play / done.
  var clubState = {};
  (fixtures || []).forEach(function (f) {
    if (f.event !== currentEvent.id) return;
    [f.team_h, f.team_a].forEach(function (tid) {
      var state = f.finished ? 'done' : (f.started ? 'live' : 'upcoming');
      var existing = clubState[tid];
      // A double gameweek: still "upcoming" if any fixture has not kicked off.
      if (!existing || state === 'upcoming' || (state === 'live' && existing === 'done')) clubState[tid] = state;
    });
  });

  function decorate(p) {
    var s = statsById[p.id] || { points: 0, minutes: 0, bonus: 0 };
    return {
      name: p.name, team: p.team, position: p.position,
      points: s.points || 0, minutes: s.minutes || 0, bonus: s.bonus || 0,
      state: clubState[p.teamId] || 'upcoming',
      isCaptain: p.isCaptain, isVice: p.isVice, multiplier: p.multiplier || 1
    };
  }

  var starters = squad.starting.map(decorate);
  var bench = squad.bench.map(decorate);

  var pointsSoFar = starters.reduce(function (s, p) { return s + p.points * (p.multiplier || 1); }, 0);
  var benchPoints = bench.reduce(function (s, p) { return s + p.points; }, 0);
  var yetToPlay = starters.filter(function (p) { return p.state === 'upcoming'; });
  var inPlay = starters.filter(function (p) { return p.state === 'live'; });

  // A starter whose match has finished without him appearing will be
  // auto-substituted, so his zero is not final — worth saying, because it is
  // the difference between a bad score and a score that is still moving.
  var blanked = starters.filter(function (p) { return p.state === 'done' && p.minutes === 0; });
  var benchReady = bench.filter(function (p) { return p.state !== 'done' || p.minutes > 0; });

  var captain = starters.filter(function (p) { return (p.multiplier || 1) >= 2; })[0] ||
    starters.filter(function (p) { return p.isCaptain; })[0] || null;

  var top = starters.slice().sort(function (a, b) { return b.points - a.points; })[0] || null;
  var average = currentEvent.average_entry_score || null;

  return {
    eventId: currentEvent.id,
    pointsSoFar: pointsSoFar,
    average: average,
    vsAverage: average != null ? pointsSoFar - average : null,
    playersYetToPlay: yetToPlay.length,
    yetToPlayNames: yetToPlay.map(function (p) { return p.name; }),
    playersInPlay: inPlay.length,
    benchPoints: benchPoints,
    captain: captain ? {
      name: captain.name, points: captain.points, multiplier: captain.multiplier,
      contributed: captain.points * (captain.multiplier || 1),
      state: captain.state
    } : null,
    top: top && top.points > 0 ? { name: top.name, points: top.points } : null,
    blanked: blanked.map(function (p) { return p.name; }),
    autosubsAvailable: blanked.length > 0 && benchReady.length > 0,
    provisionalBonus: starters.reduce(function (s, p) { return s + (p.bonus || 0); }, 0),
    complete: yetToPlay.length === 0 && inPlay.length === 0
  };
}

/* ===================== LAST GAMEWEEK REVIEW ===================== */

/**
 * What actually happened last gameweek — the question the app never
 * answered. It graded its own calls (captain, top transfer) and showed one
 * sentence about them, but said nothing about the manager's own gameweek:
 * the score against the average, the rank move, the points sat on the bench,
 * whether the captain armband went on the right player, and whether the
 * transfers made were worth their cost.
 *
 * Costs three API calls (that gameweek's picks, the previous gameweek's
 * picks to diff transfers, and the live points), so the whole result is
 * cached in PropertiesService under the gameweek id. A finished gameweek is
 * immutable, so that cache is written once and read forever after — the
 * dashboard pays this once per week, not once per page load.
 */
var GW_REVIEW_PROP_PREFIX = 'GWREVIEW_';

function buildLastGameweekReview_(bootstrap, teamId, history) {
  var finished = bootstrap.events.filter(function (e) { return e.finished; });
  if (!finished.length) return null;
  var event = finished[finished.length - 1];

  var props = PropertiesService.getScriptProperties();
  var cacheKey = GW_REVIEW_PROP_PREFIX + event.id;
  var cached = props.getProperty(cacheKey);
  if (cached) {
    var parsed = safeCall_(function () { return JSON.parse(cached); });
    if (parsed) return parsed;
  }

  var picks = safeCall_(function () { return getPicks_(teamId, event.id); });
  if (!picks || !picks.picks) return null;
  var live = safeCall_(function () { return getEventLive_(event.id); });
  if (!live || !live.elements) return null;

  var pointsById = {};
  live.elements.forEach(function (e) { pointsById[e.id] = e.stats ? e.stats.total_points : 0; });
  var elementsById = {};
  bootstrap.elements.forEach(function (el) { elementsById[el.id] = el; });
  var teamsById = {};
  bootstrap.teams.forEach(function (t) { teamsById[t.id] = t; });

  function describe(id) {
    var el = elementsById[id];
    return {
      id: id,
      name: el ? el.web_name : ('#' + id),
      team: el && teamsById[el.team] ? teamsById[el.team].short_name : '?',
      points: pointsById[id] || 0
    };
  }

  var starters = picks.picks.filter(function (p) { return p.position <= 11; }).map(function (p) {
    var d = describe(p.element);
    d.multiplier = p.multiplier;
    d.isCaptain = p.is_captain;
    return d;
  });
  var bench = picks.picks.filter(function (p) { return p.position > 11; })
    .sort(function (a, b) { return a.position - b.position; })
    .map(function (p) { return describe(p.element); });

  var byPoints = starters.slice().sort(function (a, b) { return b.points - a.points; });
  var best = byPoints[0] || null;
  var worst = byPoints[byPoints.length - 1] || null;

  // Captain: what the armband returned, and what the best choice in the same
  // XI would have returned. The gap is the real cost of the call — being one
  // point off the best pick is a very different miss from being ten off, and
  // "was the captain top scorer" (a bare yes/no) cannot tell them apart.
  // Whoever actually wore the armband, which is not always who was named:
  // if the captain does not play, FPL passes it to the vice and sets the
  // captain's multiplier to 0. The pick carrying a multiplier of 2 or more
  // is the one that was really doubled, and a takeover is exactly the sort
  // of thing a review of last gameweek should point out.
  var namedCaptain = starters.filter(function (p) { return p.isCaptain; })[0] || null;
  var doubled = starters.filter(function (p) { return (p.multiplier || 0) >= 2; })
    .sort(function (a, b) { return b.multiplier - a.multiplier; })[0] || null;
  var captainPick = doubled || namedCaptain;
  var captainMultiplier = captainPick ? Math.max(2, captainPick.multiplier || 2) : 2;
  var viceTookOver = !!(namedCaptain && doubled && namedCaptain.id !== doubled.id);
  var captain = captainPick ? {
    name: captainPick.name,
    team: captainPick.team,
    points: captainPick.points,
    multiplier: captainMultiplier,
    viceTookOver: viceTookOver,
    namedCaptain: viceTookOver && namedCaptain ? namedCaptain.name : null,
    contributed: captainPick.points * captainMultiplier,
    best: best ? { name: best.name, points: best.points } : null,
    // Extra points a perfect armband would have added, over and above what
    // the actual captain contributed.
    pointsLeft: best ? Math.max(0, (best.points - captainPick.points) * (captainMultiplier - 1)) : 0,
    wasBest: !!(best && best.name === captainPick.name)
  } : null;

  var histByEvent = {};
  ((history && history.current) || []).forEach(function (h) { histByEvent[h.event] = h; });
  var thisGw = histByEvent[event.id] || null;
  var prevGw = histByEvent[event.id - 1] || null;

  var benchPoints = thisGw && thisGw.points_on_bench != null
    ? thisGw.points_on_bench
    : bench.reduce(function (s, p) { return s + p.points; }, 0);
  var bestBench = bench.slice().sort(function (a, b) { return b.points - a.points; })[0] || null;

  // Transfers: diff this gameweek's squad against the previous one. The API
  // reports how MANY transfers were made and what they cost, but never who
  // moved — so the only way to say whether a transfer worked is to work out
  // which players changed and compare what they actually scored.
  var transfers = { count: thisGw ? (thisGw.event_transfers || 0) : 0, cost: thisGw ? (thisGw.event_transfers_cost || 0) : 0, inPlayers: [], outPlayers: [], net: null };
  if (transfers.count > 0 && event.id > 1) {
    var prevPicks = safeCall_(function () { return getPicks_(teamId, event.id - 1); });
    if (prevPicks && prevPicks.picks) {
      var prevIds = {}, nowIds = {};
      prevPicks.picks.forEach(function (p) { prevIds[p.element] = true; });
      picks.picks.forEach(function (p) { nowIds[p.element] = true; });
      transfers.inPlayers = picks.picks.filter(function (p) { return !prevIds[p.element]; })
        .map(function (p) { return describe(p.element); });
      transfers.outPlayers = prevPicks.picks.filter(function (p) { return !nowIds[p.element]; })
        .map(function (p) { return describe(p.element); });
      var inPts = transfers.inPlayers.reduce(function (s, p) { return s + p.points; }, 0);
      var outPts = transfers.outPlayers.reduce(function (s, p) { return s + p.points; }, 0);
      transfers.net = inPts - outPts - transfers.cost;
    }
  }

  var points = thisGw ? thisGw.points : null;
  var average = event.average_entry_score || null;
  var rankDelta = (thisGw && prevGw && thisGw.overall_rank != null && prevGw.overall_rank != null)
    ? prevGw.overall_rank - thisGw.overall_rank // positive = moved up
    : null;

  // Plain-language findings, split the way the question is actually asked.
  var worked = [], didntWork = [];

  if (points != null && average != null) {
    (points >= average ? worked : didntWork).push(
      points + ' points against a gameweek average of ' + average + ' — ' +
      (points >= average ? (points - average) + ' above.' : (average - points) + ' below.'));
  }
  if (rankDelta != null && rankDelta !== 0) {
    (rankDelta > 0 ? worked : didntWork).push('Overall rank ' +
      (rankDelta > 0 ? 'up ' : 'down ') + Math.abs(rankDelta).toLocaleString() +
      ' places, to ' + (thisGw.overall_rank || 0).toLocaleString() + '.');
  }
  if (captain) {
    if (captain.viceTookOver) {
      didntWork.push('Your captain ' + captain.namedCaptain + ' did not play, so the armband passed to ' +
        captain.name + ' (' + captain.points + ' pts).');
    }
    if (captain.wasBest) {
      worked.push('The armband was on your best player: ' + captain.name + ' returned ' +
        captain.points + ', worth ' + captain.contributed + ' captained.');
    } else if (captain.pointsLeft > 0) {
      didntWork.push('Captain ' + captain.name + ' scored ' + captain.points + '; ' +
        captain.best.name + ' scored ' + captain.best.points + '. The armband on him instead was worth ' +
        captain.pointsLeft + ' more points.');
    }
  }
  if (bestBench && best && bestBench.points > 0) {
    if (benchPoints >= 12) {
      didntWork.push(benchPoints + ' points left on your bench' +
        (bestBench.points > 0 ? ', ' + bestBench.points + ' of them from ' + bestBench.name : '') + '.');
    } else if (benchPoints <= 4) {
      worked.push('Only ' + benchPoints + ' points left on the bench — the right eleven started.');
    }
  }
  if (transfers.count > 0 && transfers.net != null) {
    (transfers.net >= 0 ? worked : didntWork).push(
      transfers.count + ' transfer' + (transfers.count === 1 ? '' : 's') +
      (transfers.cost ? ' (−' + transfers.cost + ' hit)' : '') + ': ' +
      transfers.inPlayers.map(function (p) { return p.name + ' ' + p.points; }).join(', ') +
      ' in for ' + transfers.outPlayers.map(function (p) { return p.name + ' ' + p.points; }).join(', ') +
      ' — net ' + (transfers.net >= 0 ? '+' : '') + transfers.net + ' points.');
  } else if (transfers.count === 0) {
    worked.push('No transfers made, so nothing was spent on a hit.');
  }
  if (worst && worst.points <= 1) {
    didntWork.push(worst.name + ' returned ' + worst.points + ' from a starting spot.');
  }

  var review = {
    eventId: event.id,
    points: points,
    average: average,
    highest: event.highest_score || null,
    vsAverage: (points != null && average != null) ? points - average : null,
    overallRank: thisGw ? thisGw.overall_rank : null,
    rankDelta: rankDelta,
    captain: captain,
    benchPoints: benchPoints,
    bestBench: bestBench,
    best: best,
    worst: worst,
    transfers: transfers,
    worked: worked,
    didntWork: didntWork
  };

  // A finished gameweek never changes, so this is written once and read back
  // on every subsequent load.
  safeCall_(function () { props.setProperty(cacheKey, JSON.stringify(review)); });
  return review;
}

/* ===================== TRACK RECORD ===================== */

/**
 * The season-long version of the weekly grade.
 *
 * The app already checked each gameweek's calls against what happened, then
 * threw the result away — only the single most recent grade was ever shown.
 * Every one of those grades was already sitting in PropertiesService, so
 * this reads them all back and turns them into the thing a manager can
 * actually learn from: how often the captain call lands, what it costs when
 * it does not, whether the transfers are net-positive, and whether the
 * lineup advice is worth following. A hit rate over twenty gameweeks is
 * evidence. One gameweek is an anecdote.
 *
 * `learnings` are stated as conclusions rather than numbers so the section
 * reads like the rest of the app — a decision with the arithmetic
 * underneath, not a stat dump.
 */
function buildTrackRecord_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var grades = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('GRADE_') !== 0) return;
    var g = safeCall_(function () { return JSON.parse(all[k]); });
    if (g && g.eventId) grades.push(g);
  });
  if (!grades.length) return null;
  grades.sort(function (a, b) { return a.eventId - b.eventId; });

  var capCalls = grades.filter(function (g) { return g.captainPoints != null; });
  var capHits = capCalls.filter(function (g) { return g.captainCorrect; }).length;
  var capPoints = capCalls.reduce(function (s, g) { return s + g.captainPoints; }, 0);
  var capMissed = capCalls.reduce(function (s, g) { return s + (g.captainPointsMissed || 0); }, 0);

  /* Captain efficiency: points banked as a share of a perfect armband, across
   * every graded week. Leading with this rather than the hit rate is the
   * whole point — see the note in gradeFinishedGws_. The hit rate stays, but
   * it now travels with the base rate it should always have been read
   * against: one in `xiSize` is what picking at random would manage, so a
   * hit rate quoted without it is a number with no scale. */
  var effCalls = capCalls.filter(function (g) { return g.captainEfficiency != null; });
  var capEfficiency = effCalls.length
    ? Math.round((effCalls.reduce(function (s, g) { return s + g.captainEfficiency; }, 0) / effCalls.length) * 1000) / 10
    : null;
  var rankCalls = capCalls.filter(function (g) { return g.captainRankInXi != null; });
  var capAvgRank = rankCalls.length
    ? Math.round((rankCalls.reduce(function (s, g) { return s + g.captainRankInXi; }, 0) / rankCalls.length) * 10) / 10
    : null;
  var capTop3 = rankCalls.length
    ? Math.round((rankCalls.filter(function (g) { return g.captainRankInXi <= 3; }).length / rankCalls.length) * 100)
    : null;
  var avgXiSize = rankCalls.length
    ? rankCalls.reduce(function (s, g) { return s + (g.xiSize || 11); }, 0) / rankCalls.length
    : 11;
  var capRandomBaseline = Math.round((1 / avgXiSize) * 100);

  var trCalls = grades.filter(function (g) { return g.transferNetGain !== undefined; });
  var trWins = trCalls.filter(function (g) { return g.transferWasRight; }).length;
  var trNet = trCalls.reduce(function (s, g) { return s + g.transferNetGain; }, 0);
  var trHitCost = trCalls.filter(function (g) { return g.transferUsedHit; }).length * TRANSFER_HIT_COST;

  var lineupCalls = grades.filter(function (g) { return g.lineupGain !== undefined; });
  var lineupNet = lineupCalls.reduce(function (s, g) { return s + g.lineupGain; }, 0);

  var learnings = [];
  if (capCalls.length >= 3) {
    var rate = Math.round((capHits / capCalls.length) * 100);
    var avgMissed = capMissed / capCalls.length;
    if (capEfficiency != null) {
      learnings.push('The armband has banked ' + capEfficiency + '% of what a perfect captain call would have' +
        (capTop3 != null ? ', finishing in your top three ' + capTop3 + '% of weeks' : '') +
        (capAvgRank != null ? ' and ' + capAvgRank + 'th in your eleven on average' : '') +
        '. That is the number to judge it on: picking the literal top scorer is a coin toss even for a good model — ' +
        'a random pick from your eleven lands it about ' + capRandomBaseline + '% of the time, and this one is landing ' + rate + '%.');
    } else {
      learnings.push('Captaincy landed ' + rate + '% of ' + capCalls.length + ' gameweeks against a ~' +
        capRandomBaseline + '% random baseline, and the gap to the best option in your own eleven averages ' +
        avgMissed.toFixed(1) + ' pts a week (doubled, ' + (avgMissed * 2).toFixed(1) + ').');
    }
  }
  if (trCalls.length >= 3) {
    var netAfterHits = trNet - trHitCost;
    learnings.push('Transfer calls are ' + (netAfterHits >= 0 ? 'net +' : 'net ') + netAfterHits +
      ' pts across ' + trCalls.length + ' calls' + (trHitCost ? ' (after ' + trHitCost + ' pts of hits)' : '') +
      ' — ' + Math.round((trWins / trCalls.length) * 100) + '% came out ahead in the following gameweek.');
  }
  if (lineupCalls.length >= 3) {
    learnings.push(lineupNet > 0
      ? 'Following the recommended XI would have gained ' + lineupNet + ' pts over ' + lineupCalls.length + ' gameweeks — the cheapest points on this page, since it costs no transfers.'
      : 'The recommended XI has not beaten the one you set (' + lineupNet + ' pts over ' + lineupCalls.length + ' gameweeks) — your own bench decisions are doing fine.');
  }
  if (!learnings.length) {
    learnings.push('Only ' + grades.length + ' gameweek' + (grades.length === 1 ? '' : 's') +
      ' graded so far — too few to draw a conclusion from. Come back after a few more.');
  }

  return {
    captainEfficiency: capEfficiency,
    captainAvgRank: capAvgRank,
    captainTop3Rate: capTop3,
    captainRandomBaseline: capRandomBaseline,
    gwsGraded: grades.length,
    firstEvent: grades[0].eventId,
    lastEvent: grades[grades.length - 1].eventId,
    captainCalls: capCalls.length,
    captainHits: capHits,
    captainHitRate: capCalls.length ? Math.round((capHits / capCalls.length) * 100) : null,
    captainPointsTotal: capPoints,
    captainPointsMissed: capMissed,
    transferCalls: trCalls.length,
    transferWinRate: trCalls.length ? Math.round((trWins / trCalls.length) * 100) : null,
    transferNet: trNet,
    transferNetAfterHits: trNet - trHitCost,
    lineupCalls: lineupCalls.length,
    lineupNet: lineupNet,
    learnings: learnings
  };
}

/* ===================== AUTOMATIC WEEKLY DEADLINE EMAIL + AI VERDICT ===================== */

/**
 * Run this once from the Apps Script editor (Run menu) to turn on
 * automatic deadline-reminder emails AND the weekly AI verdict refresh.
 * Checks every 6 hours; each job only actually fires once per gameweek.
 */
function installWeeklyTrigger() {
  ['checkAndSendReminder', 'weeklyVerdictCycle'].forEach(function (fn) {
    ScriptApp.getProjectTriggers().forEach(function (tr) {
      if (tr.getHandlerFunction() === fn) ScriptApp.deleteTrigger(tr);
    });
    ScriptApp.newTrigger(fn).timeBased().everyHours(6).create();
  });
  return 'Triggers installed — deadline reminders and the weekly AI verdict both refresh every 6 hours (each only acts once per gameweek).';
}

/**
 * Unlike The Panel, this pipeline had no way to tell from
 * the UI whether `installWeeklyTrigger()` had ever actually been run —
 * if it hadn't (or a redeploy wiped the trigger), the deadline email and
 * the verdict auto-refresh would silently never fire, forever, with
 * nothing in the app to notice. Surfaced on The Wire's Diagnostics panel
 * alongside the Panel status.
 */
function getTriggerStatus_() {
  var installed = { checkAndSendReminder: false, weeklyVerdictCycle: false, checkExpertVideosTick: false };
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    var fn = tr.getHandlerFunction();
    if (installed.hasOwnProperty(fn)) installed[fn] = true;
  });
  return {
    weeklyInstalled: installed.checkAndSendReminder && installed.weeklyVerdictCycle,

    panelInstalled: installed.checkExpertVideosTick,
    lastEmailedEvent: PropertiesService.getScriptProperties().getProperty('LAST_EMAILED_EVENT') || null
  };
}

/**
 * Proactive half of "always have AI parsing for every weekly run": this
 * runs on a timer independent of anyone opening the app, so the cached
 * verdict (and the reminder email below) reflect the CURRENT gameweek
 * even in a week nobody looks at the dashboard. getRuling_ is cached per
 * event+signature in PropertiesService, so calling this every 6 hours is
 * cheap — it only calls the AI when the cache is empty for the current
 * gameweek (e.g. right after a new gameweek goes live) or when live form/
 * fixture data has actually changed the top transfer, captain, or chip
 * call since the cached verdict was written.
 */
/* The verdict is cached per gameweek, and it must be the gameweek the
 * dashboard will look it up under — the one being PICKED FOR. Keying it on
 * the gameweek being PLAYED writes an entry nobody reads, and between
 * gameweeks there is no such gameweek at all, so the trigger would simply
 * stop generating. Both are `pickingForEventId`, same as getDashboardData. */
function weeklyVerdictCycle() {
  var data = safeCall_(function () { return getDashboardData(); });
  if (!data || data.needsSetup || data.pickingForEventId == null) return;
  // Never spend an AI call on prose that sits above a figure already known to
  // be impossible.
  if (data.invariants && !data.invariants.ok) return;
  // The one caller allowed to spend an AI call: nobody is waiting on this.
  getRuling_(data.pickingForEventId, data, true);
}

/** Same check as weeklyVerdictCycle, but returns the ruling so The Wire's Diagnostics panel can show it. */
function debugWeeklyVerdict() {
  var data = safeCall_(function () { return getDashboardData(); });
  if (!data || data.needsSetup || data.pickingForEventId == null) return null;
  if (data.invariants && !data.invariants.ok) return buildInvalidModelRuling_(data.invariants);
  return getRuling_(data.pickingForEventId, data, true);
}

function checkAndSendReminder() {
  var teamId = getTeamId();
  if (!teamId) return;

  var bootstrap = getBootstrap_();
  // The deadline worth an email is the next one that can still be acted on.
  // `is_next` lags the deadline it describes, so reading it could name a
  // gameweek that had already locked — and then quietly send nothing, because
  // the hours-away test below would be negative.
  var gwState = resolveGameweekState_(bootstrap.events);
  if (gwState.decisionEventId == null) return;
  var nextEvent = bootstrap.events.filter(function (e) { return e.id === gwState.decisionEventId; })[0];
  if (!nextEvent) return;

  var deadline = new Date(nextEvent.deadline_time);
  var hoursAway = (deadline.getTime() - Date.now()) / 3600000;
  var props = PropertiesService.getScriptProperties();
  var lastEmailed = props.getProperty('LAST_EMAILED_EVENT');

  if (hoursAway > 0 && hoursAway <= 36 && lastEmailed !== String(nextEvent.id)) {
    var data = getDashboardData();
    sendReminderEmail_(data, nextEvent);
    props.setProperty('LAST_EMAILED_EVENT', String(nextEvent.id));
  }
}

function sendReminderEmail_(data, nextEvent) {
  var email = Session.getEffectiveUser().getEmail();
  if (!email) return;

  var lines = [];
  lines.push('Gameweek ' + nextEvent.id + ' deadline: ' + new Date(nextEvent.deadline_time).toString());
  lines.push('');
  if (data.ruling) {
    lines.push('THE RULING: ' + data.ruling.headline);
    lines.push(data.ruling.body);
    lines.push('');
  }
  if (data.transferSuggestions && data.transferSuggestions.length) {
    lines.push('TRANSFER SUGGESTIONS:');
    data.transferSuggestions.forEach(function (s) {
      lines.push('  OUT: ' + s.out + ' (' + s.outReason + ')');
      lines.push('  IN:  ' + s.into + ' (' + s.intoReason + ')');
      lines.push('');
    });
  }
  if (data.captainSuggestions && data.captainSuggestions.length) {
    lines.push('CAPTAIN OPTIONS:');
    data.captainSuggestions.forEach(function (c) {
      lines.push('  ' + c.name + ' (' + c.team + ') — form ' + c.form + ', next: ' + c.nextFixture);
    });
    lines.push('');
  }
  if (data.chipSuggestions && data.chipSuggestions.length) {
    lines.push('CHIP NOTES:');
    data.chipSuggestions.forEach(function (c) { lines.push('  - ' + c); });
  }

  MailApp.sendEmail(email, 'FPL Reminder — GW' + nextEvent.id + ' deadline in <36h', lines.join('\n'));
}

/* ===================== RECOMMENDATION LOG (Sheet-backed, player-level) =====================
 *
 * The Panel produces recommendations tied to a
 * specific player at some point in time — this is the durable, queryable
 * history of that, one row per (player, source) mention, so "who's
 * recommended Isak and why" is a lookup instead of something re-derived
 * from scratch on every request. PropertiesService (used everywhere else
 * in this file) tops out at 9KB/property and 500KB/project — fine for
 * "latest per channel", not for an accumulating history — so this uses a
 * Google Sheet instead, auto-created on first use (no manual setup step,
 * same philosophy as PANEL_CHANNELS' uploads-playlist resolution).
 *
 * Deduped on (video, player) so the same pick is never logged twice, even
 * if a channel's rolling window is re-scanned or a video is reprocessed
 * after a partial failure.
 */

var REC_SHEET_ID_PROP = 'REC_SHEET_ID';
var REC_SHEET_TAB_NAME = 'Recommendations';
var REC_DEDUPE_PROP = 'REC_LOGGED_KEYS';
var REC_DEDUPE_CAP = 500; // oldest keys pruned once the rolling list exceeds this

function getRecommendationSheet_() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty(REC_SHEET_ID_PROP);
  var ss = sheetId ? safeCall_(function () { return SpreadsheetApp.openById(sheetId); }) : null;

  if (!ss) {
    ss = SpreadsheetApp.create('FPL Command Center — Recommendations Log');
    props.setProperty(REC_SHEET_ID_PROP, ss.getId());
    var sheet = ss.getActiveSheet();
    sheet.setName(REC_SHEET_TAB_NAME);
    sheet.appendRow(['Timestamp', 'Player', 'Source Type', 'Source Name', 'Verdict', 'Reasoning', 'Source URL', 'Dedupe Key']);
    sheet.setFrozenRows(1);
    Logger.log('Created recommendations log: %s', ss.getUrl());
  }
  return ss.getSheetByName(REC_SHEET_TAB_NAME) || ss.getSheets()[0];
}

function loggedRecKeys_() {
  var raw = PropertiesService.getScriptProperties().getProperty(REC_DEDUPE_PROP);
  return raw ? JSON.parse(raw) : [];
}

function markRecKeysLogged_(newKeys) {
  withLock_(10000, function () {
    var merged = loggedRecKeys_().concat(newKeys);
    if (merged.length > REC_DEDUPE_CAP) merged = merged.slice(merged.length - REC_DEDUPE_CAP);
    PropertiesService.getScriptProperties().setProperty(REC_DEDUPE_PROP, JSON.stringify(merged));
  });
}

/**
 * entries: [{ player, sourceType, sourceName, verdict, reasoning, sourceUrl, dedupeKey }]
 * Silently no-ops entries whose dedupeKey was already logged. Never throws —
 * callers (the Panel pipeline) must not break if Sheets has a hiccup.
 */
function logRecommendations_(entries) {
  if (!entries || !entries.length) return;
  var already = {};
  loggedRecKeys_().forEach(function (k) { already[k] = true; });
  var fresh = entries.filter(function (e) { return e.player && !already[e.dedupeKey]; });
  if (!fresh.length) return;

  var sheet = getRecommendationSheet_();
  var now = new Date().toISOString();
  var rows = fresh.map(function (e) {
    return [now, e.player, e.sourceType, e.sourceName, e.verdict, e.reasoning, e.sourceUrl, e.dedupeKey];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  markRecKeysLogged_(fresh.map(function (e) { return e.dedupeKey; }));
}

/**
 * Reads the full log and unions it by player — "who recommended Isak and
 * why", across every Panel video ever logged. Sorted by
 * mention count (most-talked-about first), each player's own list newest
 * first and capped, so the payload stays reasonable over google.script.run.
 */
function getPlayerRecommendations_() {
  var sheet = getRecommendationSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var byPlayer = {};
  values.forEach(function (row) {
    var player = row[1];
    if (!player) return;
    (byPlayer[player] = byPlayer[player] || []).push({
      timestamp: row[0] instanceof Date ? row[0].toISOString() : String(row[0]),
      sourceType: row[2], sourceName: row[3], verdict: row[4], reasoning: row[5], sourceUrl: row[6]
    });
  });

  return Object.keys(byPlayer).map(function (name) {
    var recs = byPlayer[name].sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
    return { player: name, count: recs.length, recommendations: recs.slice(0, 10) };
  }).sort(function (a, b) { return b.count - a.count; }).slice(0, 30);
}

/* ===================== PLAYER NAME MATCHING ===================== */

/**
 * FPL players (by web_name) mentioned in a block of text.
 *
 * The original did a lowercased substring test, which tagged any text
 * containing a player's name as a fragment of another word: "He's taking the
 * assist" matched King, and it matched him twice because two players share
 * that web_name. Live examples from The Wire: a post about Tzolis tagged
 * "Tzolis, King, King", and one about John Egan tagged "Egan, John".
 *
 * Two changes fix both classes of error. Matching is whole-word and
 * case-sensitive against the original text — web_name is properly
 * capitalised, so "King" no longer hides inside "taking" — and the result is
 * deduplicated, so two players sharing a name produce one tag rather than
 * the same name twice.
 */
function findMentionedPlayers_(text, bootstrap) {
  var source = String(text || '');
  if (!source) return [];
  var seen = {};
  var out = [];
  bootstrap.elements.forEach(function (el) {
    var name = el.web_name;
    if (!name || name.length < 3) return;
    if (seen[name]) return;
    // Escape regex metacharacters — real web_names contain dots and hyphens
    // ("B.Fernandes", "Vinícius Jr.", "Ait-Nouri").
    var escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // \b is unreliable next to accented letters and dots, so the boundary is
    // asserted explicitly: not preceded or followed by a word character.
    var re = new RegExp('(^|[^A-Za-z0-9])' + escaped + '($|[^A-Za-z0-9])');
    if (re.test(source)) {
      seen[name] = true;
      out.push(name);
    }
  });
  return out;
}

/* ===================== THE PANEL (expert YouTube analysis) =====================
 *
 * Tracks a short, hand-picked list of FPL YouTube channels (PANEL_CHANNELS,
 * near the top of this file) and turns their latest upload into a short
 * newspaper-style entry, cross-checked against this app's own Ruling.
 *
 * Two AI providers, two different jobs (see EXPERT_PANEL_DESIGN.md):
 *   - Gemini takes the YouTube URL directly (no download, no transcript
 *     scraping) and extracts the raw FPL recommendations from the video.
 *   - Claude (reusing callClaude_ / the existing Anthropic key) turns that
 *     raw extraction into 2-3 newspaper-style sentences and flags whether
 *     each pick agrees or differs from this app's own suggestions.
 *
 * Dedup: every video is processed at most once. Each channel's last
 * processed video ID is cached (PANEL_LASTSEEN_<channelId>) and checked
 * BEFORE calling Gemini/Claude, so a channel with no new upload since the
 * last check costs a single cheap YouTube Data API call, not a re-run of
 * the expensive AI pipeline. If the AI pipeline fails partway (Gemini or
 * Claude error, malformed output), the "last seen" video ID is NOT
 * advanced, so the next tick retries the same video rather than silently
 * skipping it forever.
 *
 * SETUP: enter a YouTube Data API key (free — Google Cloud Console, enable
 * "YouTube Data API v3") and a Gemini API key (free — Google AI Studio) in
 * "The Panel" section of the app. Then run installPanelTrigger() once from
 * the Apps Script editor to start checking every 6 hours. Run debugPanel()
 * to test immediately and check the execution log (View > Logs).
 */

var GEMINI_MODEL = 'gemini-3.6-flash';
// The rolling window The Panel reports on. Everything published inside it is
// eligible; anything older ages out of both the page and the community-signal
// scoring term, so a good take from three weeks ago stops counting as current.
var PANEL_WINDOW_DAYS = 7;
var PANEL_FETCH_PER_CHANNEL = 15;      // uploads pulled per channel before the window filter (still 1 quota unit)
var PANEL_MAX_VIDEOS_PER_CHANNEL = 4;  // kept per channel — a 9KB property holds roughly this much prose
var PANEL_MAX_NEW_VIDEOS_PER_RUN = 2;  // caps AI spend per channel per tick; the rest are picked up next tick
/* --- relevance gate ------------------------------------------------------
 *
 * An FPL channel does not only publish FPL tactics. The same uploads feed
 * carries shorts, giveaways, sponsor reads, watchalongs and off-season
 * filler, and every one of them used to be sent to Gemini, synthesised by
 * Claude, stored as a Panel entry, and — worst of all — mined for player
 * names that fed the community term in the scoring model. A sponsor read
 * that says "imagine Haaland on this sofa" is not a Haaland recommendation,
 * but nothing in the pipeline could tell the difference.
 *
 * Two gates, cheapest first:
 *
 *   1. The title, before any API call is spent. Only hard negatives are
 *      rejected here — a terse title like "GW12" is a perfectly normal name
 *      for a real tactics video, so an absent positive marker proves nothing
 *      and is not treated as evidence.
 *   2. Gemini's own verdict, which is the reliable one because it has
 *      actually watched the video. The extraction prompt now opens with a
 *      RELEVANT line, so one call does both jobs rather than paying for a
 *      classification pass and an extraction pass.
 *
 * Rejected video ids are remembered per channel so the same upload is not
 * re-classified on every tick — a skip has to be as durable as a hit or the
 * gate costs more than it saves.
 */
var PANEL_TITLE_REJECT = /#shorts\b|\bshorts\b|giveaway|sponsor|advert|\bad\b|unboxing|watchalong|watch along|live ?stream|streaming now|highlights|full match|reaction|merch|discount code|q ?& ?a with|behind the scenes/i;
var PANEL_SKIP_PROP_PREFIX = 'PANEL_SKIPPED_';
var PANEL_SKIP_MAX_IDS = 40;

/** Video ids this channel has already been rejected on, as a lookup. */
function readPanelSkips_(channelId) {
  var raw = PropertiesService.getScriptProperties().getProperty(PANEL_SKIP_PROP_PREFIX + channelId);
  var list = raw ? (safeCall_(function () { return JSON.parse(raw); }) || []) : [];
  var map = {};
  list.forEach(function (id) { map[id] = true; });
  return { list: list, map: map };
}

function markPanelSkipped_(channelId, videoId) {
  var skips = readPanelSkips_(channelId);
  if (skips.map[videoId]) return;
  var list = [videoId].concat(skips.list).slice(0, PANEL_SKIP_MAX_IDS);
  PropertiesService.getScriptProperties().setProperty(PANEL_SKIP_PROP_PREFIX + channelId, JSON.stringify(list));
}

var GEMINI_EXTRACTION_PROMPT = 'You are reading a video from a Fantasy Premier League channel. ' +
  'FIRST LINE of your reply must be exactly "RELEVANT: yes" or "RELEVANT: no". Answer no if the video makes no actual FPL squad ' +
  'recommendations — a sponsor read, a giveaway, a watchalong, match highlights, a season recap, or general football chat with no ' +
  'transfer, captaincy or chip advice in it. Answer yes only if the video recommends specific players or chip timing.\n\n' +
  'If yes, then extract every Fantasy Premier League recommendation made in the video: transfers in/out, ' +
  'captain/vice-captain picks, differentials, and chip timing advice. Cite the specific player names and the reasoning given ' +
  'for each. Note the video\'s overall stance/confidence. Be concise and factual — report what the video actually says, ' +
  'don\'t add opinions of your own. A player mentioned in passing, in a sponsor segment, or as an opponent rather than as a ' +
  'recommendation is not a recommendation — leave them out.';

/** Splits Gemini's reply into its relevance verdict and the extraction body. */
function parseExtractionRelevance_(raw) {
  var text = String(raw || '');
  var m = text.match(/^\s*RELEVANT:\s*(yes|no)\b/i);
  if (!m) {
    // No verdict line means an older or malformed reply. Treating that as
    // irrelevant would silently empty the Panel on any prompt drift, so the
    // benefit of the doubt goes to the video and the title gate stands alone.
    return { relevant: true, body: text };
  }
  return {
    relevant: m[1].toLowerCase() === 'yes',
    body: text.slice(m[0].length).replace(/^[\s:—-]+/, '')
  };
}

/** Calls the Gemini API with a YouTube URL directly — no download or transcript scraping needed. */
function callGemini_(youtubeUrl, prompt) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('No Gemini key saved.');

  var res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey),
    {
      method: 'post',
      muteHttpExceptions: true,
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{
          parts: [
            { file_data: { file_uri: youtubeUrl } },
            { text: prompt }
          ]
        }]
      })
    }
  );

  var code = res.getResponseCode();
  var body = JSON.parse(res.getContentText());
  if (code >= 400) throw new Error((body.error && body.error.message) || ('Gemini API returned ' + code));

  var parts = body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts;
  if (!parts) throw new Error('Gemini returned no extraction for this video.');
  return parts.map(function (p) { return p.text || ''; }).join('\n').trim();
}

/** Resolves a channel @handle to its uploads-playlist ID (1 quota unit) — call once per channel, cache the result. */
function resolveYoutubeChannel_(handle) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
  if (!apiKey) throw new Error('No YouTube key saved.');
  var cleanHandle = String(handle).replace(/^@/, '');

  var body = fetchJson_(
    'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=' +
    encodeURIComponent(cleanHandle) + '&key=' + encodeURIComponent(apiKey)
  );
  var item = body.items && body.items[0];
  if (!item) return null;
  return { channelId: item.id, uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads };
}

/**
 * Recent uploads from a playlist, newest first (1 quota unit — the same cost
 * as asking for one, since playlistItems.list bills per call, not per item).
 * Asking for only the newest video meant a channel that posted twice in a
 * day had its earlier take silently dropped, and a channel that posted a
 * trailer or a stream announcement on top of a real preview showed nothing
 * useful all week.
 */
function getRecentPlaylistVideos_(playlistId, maxResults) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
  if (!apiKey) throw new Error('No YouTube key saved.');

  var body = fetchJson_(
    'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=' +
    Math.min(50, Math.max(1, maxResults || 10)) + '&playlistId=' +
    encodeURIComponent(playlistId) + '&key=' + encodeURIComponent(apiKey)
  );
  return (body.items || []).map(function (item) {
    return {
      videoId: item.contentDetails.videoId,
      title: item.snippet.title,
      publishedAt: item.contentDetails.videoPublishedAt || item.snippet.publishedAt
    };
  }).filter(function (v) { return v.videoId && v.publishedAt; })
    .sort(function (a, b) { return Date.parse(b.publishedAt) - Date.parse(a.publishedAt); });
}

/**
 * Turns Gemini's raw extraction into the exact shape "The Panel" section
 * renders: a pull-quote headline, 2-3 sentences of newspaper prose, and a
 * pill per pick flagging whether it agrees or differs from this app's own
 * Ruling/transfer/captain suggestions (grounded in the same dashboard data
 * buildAiContext_ already feeds the chat assistant — never invented).
 */
function synthesizePanelEntry_(extraction, dashboardData, channel) {
  var context = buildAiContext_(dashboardData);
  var systemPrompt = 'You write a syndicated-opinion-style entry for a Fantasy Premier League dashboard section called ' +
    '"The Panel", summarizing a YouTube analyst\'s latest video. You are given (1) a raw extraction of that video\'s FPL ' +
    'recommendations and (2) this dashboard\'s own current squad/suggested-squad and Ruling data, grounded in real ' +
    'numbers. Write in newspaper-style prose: decisive, plain language, no hedging, no stat dumps.\n\n' +
    'Pick selection matters — "picks" means the video\'s DISTINCT, NOTABLE calls only, at most 5 total. Never list every ' +
    'name in a predicted/suggested squad the video shows — that is not a pick. Include only: (a) an explicit chip call ' +
    '(e.g. "activate Bench Boost now"), (b) the captain/vice-captain pick, (c) up to 3 individual players the analyst ' +
    'specifically singled out with a case FOR them (a differential, a transfer target, a stated standout) — skip anyone ' +
    'only mentioned in passing as part of a squad list.\n\n' +
    'For each pick, decide AGREES or DIFFERS against the dashboard data below: a player pick agrees if that same player ' +
    'already appears in the dashboard\'s own suggested-squad/transfer/captain data; a chip pick agrees only if the ' +
    'dashboard\'s own chip guidance names the same chip right now. If the dashboard has no chip guidance or no squad data ' +
    'to compare against at all (this happens preseason), say that plainly in the note rather than defaulting to "differs" ' +
    'with a generic explanation.\n\n' +
    /* The reported failure came from here: an entry asserting that the
     * gameweek the manager was being asked to pick for "is already locked".
     * Nothing in the extraction says which gameweek a video is about — the
     * model was inferring one from prose and getting it wrong. It is not
     * allowed to infer one. The only gameweek state that exists is the one
     * stated in the dashboard data below. */
    'GAMEWEEK ATTRIBUTION: the video extraction does NOT reliably say which gameweek it is about. Never infer one, ' +
    'never state that a gameweek is locked, closed or passed, and never contradict the gameweek state given in the ' +
    'dashboard data below. If you need to name a gameweek, use the one the dashboard data says is being picked for.\n\n' +
    'Respond with ONLY strict JSON, no markdown fences, no commentary, in exactly this shape:\n' +
    '{"headline": "one-line pull-quote under 15 words", "body": "2-3 sentences summarizing the actual recommendations", ' +
    '"picks": [{"label": "player name and what for, e.g. Haaland (C)", "agrees": true, "note": "we say Isak — only when agrees is false"}]}\n\n' +
    'DASHBOARD DATA:\n' + context;

  // 1200, not 500: a truncated response (max_tokens cut off mid-object) throws
  // "Unexpected end of JSON input" from JSON.parse below with zero indication
  // that truncation was the cause — generous headroom is cheaper than that
  // debugging trip. Extracting the first-{-to-last-} span (not just stripping
  // ```json fences) survives any stray preamble/postamble text too.
  var raw = callClaude_(systemPrompt, [{ role: 'user', content: 'Video extraction from ' + channel.name + ':\n\n' + extraction }], 1200);
  var start = raw.indexOf('{');
  var end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Panel synthesis returned no JSON object. Raw response: ' + raw.slice(0, 300));
  }
  var cleaned = raw.slice(start, end + 1);
  var parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Panel synthesis returned malformed JSON (' + e.message + '). Raw response: ' + raw.slice(0, 300));
  }
  if (!parsed.headline || !parsed.body) throw new Error('Malformed panel synthesis — missing headline or body. Raw response: ' + raw.slice(0, 300));
  if (parsed.picks && parsed.picks.length > 5) parsed.picks = parsed.picks.slice(0, 5); // belt-and-suspenders — the prompt caps this too, but models don't always obey
  return parsed;
}

/**
 * Full pipeline for one tracked channel: resolve → check for a new video →
 * Gemini extraction → Claude synthesis → cache. Returns the new entry, or
 * null if there's nothing new (or something failed — never throws, so one
 * broken channel never blocks the others).
 */
function refreshExpertChannel_(channel, dashboardData) {
  var props = PropertiesService.getScriptProperties();
  var uploadsKey = 'PANEL_UPLOADS_' + channel.id;
  var uploadsPlaylistId = props.getProperty(uploadsKey);

  if (!uploadsPlaylistId) {
    var resolved = resolveYoutubeChannel_(channel.handle);
    if (!resolved) return []; // handle doesn't resolve — likely a placeholder/typo, skip quietly
    uploadsPlaylistId = resolved.uploadsPlaylistId;
    props.setProperty(uploadsKey, uploadsPlaylistId);
  }

  var cutoff = Date.now() - PANEL_WINDOW_DAYS * 86400000;
  var skips = readPanelSkips_(channel.id);
  var recent = getRecentPlaylistVideos_(uploadsPlaylistId, PANEL_FETCH_PER_CHANNEL)
    .filter(function (v) { return Date.parse(v.publishedAt) >= cutoff; })
    // The title gate, before a single API call is spent. Filtering here
    // rather than inside the loop also means a channel whose window is all
    // shorts still gets its real tactics video looked at, because the junk
    // never occupies one of the PANEL_MAX_NEW_VIDEOS_PER_RUN slots.
    .filter(function (v) { return !PANEL_TITLE_REJECT.test(v.title || ''); })
    .filter(function (v) { return !skips.map[v.videoId]; })
    .slice(0, PANEL_MAX_VIDEOS_PER_CHANNEL);
  if (!recent.length) return []; // nothing usable in the window — no fresh take, and no AI call spent finding that out

  var stored = readPanelEntries_(channel.id);
  var have = {};
  stored.forEach(function (e) { have[e.videoId] = true; });

  var added = [];
  for (var i = 0; i < recent.length && added.length < PANEL_MAX_NEW_VIDEOS_PER_RUN; i++) {
    var video = recent[i];
    if (have[video.videoId]) continue; // already processed — the dedupe guard

    var entry = safeCall_(function () {
      return processPanelVideo_(channel, video, dashboardData);
    });
    // One unwatchable video (private, members-only, a live stream Gemini
    // cannot read) must not stop the others in the same window.
    if (entry) added.push(entry);
  }

  if (added.length) {
    var merged = added.concat(stored);
    writePanelEntries_(channel.id, merged);
  } else if (stored.length) {
    // Still prune: an entry that has aged out of the window should stop
    // counting toward the community signal even in a week with no new uploads.
    writePanelEntries_(channel.id, stored);
  }
  return added;
}

/** Gemini extraction + Claude synthesis for one video, plus its player-level log rows. */
function processPanelVideo_(channel, video, dashboardData) {
  var youtubeUrl = 'https://www.youtube.com/watch?v=' + video.videoId;
  var verdict = parseExtractionRelevance_(callGemini_(youtubeUrl, GEMINI_EXTRACTION_PROMPT));
  if (!verdict.relevant) {
    // Remembered so the next tick does not pay to reach the same conclusion.
    markPanelSkipped_(channel.id, video.videoId);
    return null;
  }
  var extraction = verdict.body;
  var synthesis = synthesizePanelEntry_(extraction, dashboardData, channel);

  var entry = {
    channelId: channel.id,
    channelName: channel.name,
    videoId: video.videoId,
    videoTitle: video.title,
    videoUrl: youtubeUrl,
    publishedAt: video.publishedAt,
    headline: synthesis.headline,
    body: synthesis.body,
    picks: synthesis.picks || [],
    processedAt: new Date().toISOString()
  };

  // Player-level log, deduped per (video, player) — see RECOMMENDATION LOG
  // above. Resolves each pick's free-text label (e.g. "Haaland (C)") back to
  // real player names via findMentionedPlayers_; a chip pick like
  // "Bench Boost (chip)" resolves to zero players and is skipped here, which
  // is correct — it's not a per-player recommendation.
  safeCall_(function () {
    var bootstrap = getBootstrap_();
    var recs = [];
    (entry.picks || []).forEach(function (pick) {
      findMentionedPlayers_(pick.label, bootstrap).forEach(function (player) {
        recs.push({
          player: player, sourceType: 'Panel', sourceName: channel.name,
          verdict: pick.agrees ? 'Agrees' : 'Differs',
          reasoning: pick.note || synthesis.body,
          sourceUrl: youtubeUrl,
          dedupeKey: 'panel:' + video.videoId + ':' + player
        });
      });
    });
    logRecommendations_(recs);
  });

  // A video that survived both gates but yielded no pick naming a real
  // player has nothing to contribute to either the Panel or the community
  // signal, and storing it would occupy one of this channel's few slots
  // with an empty row.
  if (!(entry.picks || []).length) {
    markPanelSkipped_(channel.id, video.videoId);
    return null;
  }

  return entry;
}

/**
 * Stored entries for one channel, newest first, pruned to the window and to
 * PANEL_MAX_VIDEOS_PER_CHANNEL. A single PropertiesService value caps at 9KB
 * and each entry carries prose, so the cap is a storage constraint as much
 * as an editorial one.
 */
function readPanelEntries_(channelId) {
  var raw = PropertiesService.getScriptProperties().getProperty('PANEL_ENTRIES_' + channelId);
  var list = raw ? safeCall_(function () { return JSON.parse(raw); }) : null;
  if (!list || !list.length) {
    // Migration: before the window existed, one entry per channel was stored
    // under PANEL_LATEST_<id>. Read it so the section is not blank on the
    // first load after this change.
    var legacy = PropertiesService.getScriptProperties().getProperty('PANEL_LATEST_' + channelId);
    var one = legacy ? safeCall_(function () { return JSON.parse(legacy); }) : null;
    list = one ? [one] : [];
  }
  return prunePanelEntries_(list);
}

function writePanelEntries_(channelId, entries) {
  PropertiesService.getScriptProperties()
    .setProperty('PANEL_ENTRIES_' + channelId, JSON.stringify(prunePanelEntries_(entries)));
}

function prunePanelEntries_(entries) {
  var cutoff = Date.now() - PANEL_WINDOW_DAYS * 86400000;
  var seen = {};
  return (entries || [])
    .filter(function (e) {
      if (!e || !e.videoId || seen[e.videoId]) return false;
      seen[e.videoId] = true;
      var t = Date.parse(e.publishedAt);
      return isNaN(t) ? true : t >= cutoff;
    })
    .sort(function (a, b) { return Date.parse(b.publishedAt) - Date.parse(a.publishedAt); })
    .slice(0, PANEL_MAX_VIDEOS_PER_CHANNEL);
}

/** Every tracked channel's takes inside the window, newest first across all channels. */
function getPanelEntries_() {
  var all = [];
  PANEL_CHANNELS.forEach(function (ch) {
    readPanelEntries_(ch.id).forEach(function (e) { all.push(e); });
  });
  return all.sort(function (a, b) { return Date.parse(b.publishedAt) - Date.parse(a.publishedAt); });
}

/**
 * What the tracked channels collectively back this week.
 *
 * A single video's picks are one analyst's opinion. The same player named by
 * three channels independently is the closest thing to a consensus this app
 * can observe — and disagreement is just as informative, so a pick backed by
 * some and contradicted by the dashboard is still counted and shown with its
 * split. Chip and captain calls are separated out because those are single
 * decisions where a tally is directly actionable, unlike a transfer target.
 */
function buildPanelConsensus_(entries) {
  entries = entries || [];
  if (!entries.length) return null;

  var byLabel = {};
  entries.forEach(function (entry) {
    (entry.picks || []).forEach(function (pick) {
      var label = String(pick.label || '').trim();
      if (!label) return;
      var key = label.toLowerCase();
      var rec = byLabel[key] || (byLabel[key] = {
        label: label, channels: {}, videos: 0, agrees: 0, differs: 0, notes: []
      });
      rec.channels[entry.channelId] = entry.channelName;
      rec.videos++;
      if (pick.agrees) rec.agrees++; else rec.differs++;
      if (pick.note && rec.notes.length < 2) rec.notes.push(pick.note);
    });
  });

  var picks = Object.keys(byLabel).map(function (k) {
    var r = byLabel[k];
    var names = Object.keys(r.channels).map(function (id) { return r.channels[id]; });
    return {
      label: r.label,
      channelCount: names.length,
      channels: names,
      videos: r.videos,
      agrees: r.agrees,
      differs: r.differs,
      note: r.notes[0] || null
    };
  }).sort(function (a, b) {
    if (b.channelCount !== a.channelCount) return b.channelCount - a.channelCount;
    return b.videos - a.videos;
  });

  var channelIds = {};
  entries.forEach(function (e) { channelIds[e.channelId] = true; });
  var channelCount = Object.keys(channelIds).length;
  var agreed = picks.filter(function (p) { return p.channelCount > 1; });

  return {
    windowDays: PANEL_WINDOW_DAYS,
    videoCount: entries.length,
    channelCount: channelCount,
    picks: picks.slice(0, 12),
    agreedCount: agreed.length,
    summary: agreed.length
      ? agreed.length + ' call' + (agreed.length === 1 ? '' : 's') + ' backed by more than one channel across ' +
        entries.length + ' video' + (entries.length === 1 ? '' : 's') + ' in the last ' + PANEL_WINDOW_DAYS + ' days.'
      : 'No two channels landed on the same call across ' + entries.length + ' video' +
        (entries.length === 1 ? '' : 's') + ' this week — treat every pick below as one analyst\'s opinion.'
  };
}

/** Timer entry point — swallows errors per-channel so one bad channel/video never blocks the others or the trigger chain. */
function checkExpertVideosTick() {
  if (!hasYoutubeKey_() || !hasGeminiKey_() || !hasAiKey_()) return; // needs all three keys to do anything useful
  var dashboardData = safeCall_(function () { return getDashboardData(); });
  if (!dashboardData) return;
  PANEL_CHANNELS.forEach(function (ch) {
    safeCall_(function () { return refreshExpertChannel_(ch, dashboardData); });
  });
}

/** Run once from the Apps Script editor (Run menu) to turn on the 6-hourly check. */
function installPanelTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'checkExpertVideosTick') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('checkExpertVideosTick').timeBased().everyHours(6).create();
  return 'Panel trigger installed — tracked channels are checked for new videos every 6 hours.';
}

/** Manual test entry point — run from the Apps Script editor and check the execution log (View > Logs). */
function debugPanel() {
  if (!hasYoutubeKey_()) { Logger.log('No YouTube key saved — add one in "The Panel" section first.'); return null; }
  if (!hasGeminiKey_()) { Logger.log('No Gemini key saved — add one in "The Panel" section first.'); return null; }
  if (!hasAiKey_()) { Logger.log('No Anthropic key saved — add one in the AI Assistant section first.'); return null; }

  var dashboardData = getDashboardData();
  var results = PANEL_CHANNELS.map(function (ch) {
    var added = refreshExpertChannel_(ch, dashboardData) || [];
    if (!added.length) {
      Logger.log('%s: nothing new inside the %s-day window.', ch.name, PANEL_WINDOW_DAYS);
    } else {
      added.forEach(function (entry) {
        Logger.log('%s: "%s" — %s', ch.name, entry.videoTitle, entry.headline);
      });
    }
    return { channel: ch.name, added: added.length, entries: added };
  });
  var consensus = safeCall_(function () { return buildPanelConsensus_(getPanelEntries_()); });
  if (consensus) Logger.log('Consensus: %s', consensus.summary);
  return { channels: results, consensus: consensus };
}
