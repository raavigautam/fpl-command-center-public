# FPL Command Center: technical notes

The full design record behind the app, kept as it was written during the build.

A live Fantasy Premier League dashboard for one manager's team — pulls your
squad from the FPL API, scores every player, and surfaces transfer, captain,
and chip-timing suggestions. Includes an optional AI chat assistant (your
own Anthropic API key) grounded in your actual squad data, and a weekly
self-evaluation loop that grades its own past decisions against what
actually happened.

## How it runs

This is a **Google Apps Script** project (`Code.js` = the server-side logic
that would be `Code.gs` in the Apps Script editor, `Index.html` = the
frontend). Apps Script was chosen originally for free hosting, secret
storage (`PropertiesService`), and email (`MailApp`) — no server to run or
pay for.

- **Live web app**: deployed from this Apps Script project (see Apps
  Script editor → Deploy → Manage deployments for the URL).
- **Config**: FPL team ID and (optional) Anthropic API key are entered
  through the app's own setup UI and stored via `PropertiesService` — not
  in this repo.

## Deployment

The private copy of this project deploys with `clasp push` + `clasp deploy` from
a GitHub Actions workflow on every push to `main`. That workflow and the
`.clasp.json` that points at the Apps Script project are not included in this
public repository; to run your own, create an Apps Script project, add a
`.clasp.json` for it, and push with `clasp`.

## Files

- `Code.js` — all server-side logic: FPL API calls (and their cache), scoring,
  the xP model, squad building, transfer/captain/lineup/chip suggestions,
  ownership analysis, AI chat, weekly eval loop and track record.
- `Index.html` — the main dashboard frontend.
- `Ratings.html` — the Player Ratings page (`?page=ratings`): every player
  scored, plus head-to-head comparison (see below). Accepts `?compare=a,b`
  so the dashboard's `/compare` command can deep-link into it.
- `Wire.html` — "The Wire" page (`?page=wire`): The Panel — everything the
  app reads from outside its own algorithm.
- `appsscript.json` — Apps Script manifest.
- `eval/` — the offline backtest: `fetch.cjs` pulls FPL data, `backtest.cjs`
  replays the model against every finished gameweek (see *Model eval* below).
  Node-only, `.cjs`, and stripped before `clasp push`.
- `test/` — Node-only tests for everything in `Code.js` that is pure
  computation, plus the dashboard's client-side palette logic. Run with
  `node test/run.cjs`. The files are `.cjs` deliberately: `clasp push -f`
  uploads any `.js` anywhere in the repo, so a test named `.js` would ship to
  production. See `test/README.md`.

## How the recommendations are made

Two numbers sit behind every call on the page.

**Score** ranks players against each other — form, next-gameweek projected
points, points-per-game, ICT, expected goal involvement *per 90 minutes*, and
community signal, each weighted, then multiplied by fixture ease, availability,
and start rate. It is dimensionless: useful for "who is better", useless for
"is this worth a −4". The full breakdown for every player is on the Player
Ratings page.

**xP (expected points)** is the same player in actual FPL points, per
gameweek, out to `LOOKAHEAD_GWS`. It blends the game's own `ep_next` with form
and points-per-game, then applies *that gameweek's actual fixture* — its
difficulty, home or away, doubled for a double gameweek and zeroed for a blank
— times availability. Every decision runs on this, because points are the only
unit you can weigh a 4-point hit against:

The blend shrinks its observations rather than reading them as rates. `form`
is points per match over a rolling 30 days and `points_per_game` is points per
match over the season; in October both average a decent run of matches, but
after GW1 they are the *same single match*. Weighting one match as an
established rate is how a defender who returned 14 in the opening weekend came
to project 51 points over six gameweeks. Each observation is now pulled toward
a prior — FPL's own `ep_next` for that specific player, or a positional rate
where it is missing — in proportion to how many matches back it, so one match
barely moves the prior and ten largely replace it. The same player projects
~27 over six gameweeks now, and the early-season page stops rearranging itself
around one good afternoon.

That is only half of it, though. Shrinking the observation fixes how far the
estimate moves off the prior; it does not stop that estimate being applied
*unchanged to every gameweek of the horizon*. The live page showed a defender
who scored ~15 in GW1 projecting **93.0 over six gameweeks** — a base rate of
15.0/GW held perfectly flat, i.e. "he will do that again, six times". (This
early, `ep_next` reads 0 for the whole pool, so the blend falls to
`form × 0.6 + ppg × 0.4`, and after one match form and points-per-game are the
same number — there is no dilution in it at all.)

So the gap between observation and prior now decays across the horizon, with a
half-life of `XP_FORM_HALF_LIFE_GWS` gameweeks. Form is a rolling 30-day
average: whatever it says about next Saturday, it says much less about a match
six weeks out, by which time the run has ended, the role has moved or the
fixtures have turned. The decay only bites where the two disagree — a player
performing at his own baseline has nothing to regress and his week-six number
equals his week-one number, while a freak run fades ~23% across the window. An
established premium keeps his level, because his prior *is* his quality.

The prior has to be per-player or the shrinkage destroys the thing it is
protecting. `ep_next` is per-player and is used wherever it exists, but it
reads 0 for the entire pool for the first game or two — the exact window this
matters most. The first fallback was a flat positional rate, and that made a
£15.5m striker and a £4.5m bench forward share a baseline: the board collapsed
to one number, Haaland projected 3.4 a week, and every transfer margin fell
inside the noise. The fallback now scales the positional rate by how a player
is priced against the median of players anyone would actually pick at his
position. Price is the only per-player estimate in bootstrap-static that a new
season does not wipe, it encodes last season's output and expected role, and
it is available from day one. The scaling is sub-linear (points do not rise as
fast as price at the top end, which is why premiums are a real decision) and
bounded at both ends by `XP_PRICE_PRIOR_MIN`/`MAX`.

One trap worth naming, because it cost a whole deploy: "has the season
started" is not `finishedGws > 0`. A gameweek IN PROGRESS has zero finished
gameweeks, so keying the shrinkage on that meant it took the preseason branch
and handed back the raw rate for the entire opening weekend — the fix shipped
and the page still read 93.0. `loadSeasonContext_` reports both counts now.
`startedGws` (deadline passed) is the right one for "does form carry
current-season data yet", since the API populates it from the first whistle;
`finishedGws` (ratified) stays the right one for anything derived from
minutes, which mid-gameweek would otherwise read every player still to kick
off as dropped.

Fixture difficulty is applied per gameweek and always has been, but it is
worth being clear about its size, because it cannot rescue a base rate that is
wrong: across the whole FDR scale plus the home/away edge the multiplier runs
from about **0.74× to 1.26×**, and the first gameweek of the horizon is
deliberately damped to half that. A ±26% adjustment on a rate that is 3×
too high is a rounding error.

- **Transfers** are ranked by xP gained over the horizon, checked against
  selling price (not current price), the three-per-club limit, and a running
  bank across multiple moves. Free-transfer count is estimated from your
  transfer history — the FPL API does not publish it — and anything beyond it
  is priced at −4 and only recommended if it still nets out ahead. That
  accounting is counted once, in `buildTransferLedger_`, and read by every
  surface that mentions it. It used to be restated independently by the plan
  headline, the action list, the roadmap and the prose model, which is how the
  front page came to announce "two free transfers" above a header saying one
  and a plan charging −8 for three moves *because* there was only one.
- **Captain** is not a points question, and treating it as one was this app's
  worst measured mistake — see *Captaincy* below.
- **Lineup** searches every legal formation for the highest-projecting XI and
  reports the swaps, the formation change, and the bench order. These are the
  cheapest points on the page — they cost no transfers.
- **Ownership edge** names the template players you do not own (rank downside)
  and the differentials you do (rank upside), because rank is a relative game.
- **Effective ownership** does the same against the league you are actually
  playing in, and does it exactly rather than by proxy — see below.

Weights and thresholds are constants near the top of each section in
`Code.js` — `SCORE_WEIGHTS`, `XP_FIXTURE_SWING`, `XP_PRIOR_MATCHES`,
`TRANSFER_MARGIN`, `HIT_MARGIN`, `CAPTAIN_OWNERSHIP_TILT`,
`TEMPLATE_OWNERSHIP`. Tuning them changes what gets recommended.

## The shape of the dashboard

Three tiers, in the order a manager needs them.

**Do now** — the one place that answers "so what do I actually do". Every
decision the app is making this week, numbered, once. The page used to state
the same four decisions three times over: verdict columns named the transfer,
captain and chip; the article deck restated the transfer, captain and lineup;
then the Transfers, Lineup and Bench-order sections said all of it again in
full.

Each figure carries its own window, because they are not the same unit — a
transfer gain is points over the lookahead, a lineup gain is points *this*
gameweek, a captain margin is the gap to the next-best option. The old page
printed all three as bare `+N` side by side.

**Your squad** — the decisions marked on the rows they are about. "Switch to
4-5-1" used to be its own section three below the squad list it described, and
the bench order a fourth, so reading the advice meant holding a formation in
your head while scrolling back. Rows now carry `Out · 01`, `Start · 03` keyed
to the numbered action, and the bench is listed in autosub order.

**Evidence** — the working, one closed row each, carrying the figure that
would make you open it. Thirteen sections at identical visual weight is not a
hierarchy, and most of them are reference rather than decisions: on a quiet
week the page still gave a full-width heading to an empty price watch. Native
`<details>`, so it is keyboard-accessible and holds no state of its own.

### Three modes

A manager's needs cycle hard by day: deadline day is *do now*, Saturday at 3pm
is *how am I doing*, Tuesday is planning. The matchday **data** blind spot was
fixed a while back — the live article exists — but the **layout** was identical
in all three modes, so between Saturday lunchtime and Monday night, when this
page gets looked at most, the thing being looked for sat in a card deck below
next week's advice.

With a gameweek in flight the live panel now leads and the next deadline's
advice follows it; the masthead clock switches with it, counting players still
to come rather than time to a deadline nobody is watching yet. Nothing new is
fetched — it is the same `liveGameweek` object, given the position it earns.

### Two clocks

The masthead used to read "GW 1" beside a deadline of 8/28 — because GW1 was
being *played* and 8/28 was *GW2's* deadline, with nothing on the page saying
so. The Ruling advised a captain for GW2 while the live article reported GW1's
captain, both unlabelled. The gameweek being played and the gameweek being
picked for are now named separately (`pickingForEventId` alongside
`currentEventId`), and every figure can be attributed to one or the other.

Naming them was not enough on its own, because the code underneath was still
deciding both from one variable — `is_current || is_next` — which was also
standing in for a third question, the gameweek the squad can actually be
*read* for. `resolveGameweekState_` is now the only thing that answers any of
them, and it answers them from the clock rather than from FPL's own
`is_current`/`is_next` flags, which lag the deadlines they describe (for the
hours after a deadline passed, the app would otherwise still be advising on
the gameweek that had just closed). Chip valuations, captaincy, the fixture
grid, the front-page verdict and the decision snapshot all take the *decision*
gameweek; reading the squad and rivals' picks — which the FPL API only exposes
once a deadline has gone — takes the locked one.

### One answer per question

The transfer roadmap used to re-derive its own moves rather than reading the
transfer engine's, so the two could disagree about the same move on the same
page — live evidence: Transfers said "Kayode in for Maguire" while the roadmap,
one section below, said "Kayode in for van Ewijk". The roadmap's first
gameweek now replays the suggestions and projects forward from them.

## The Ruling — verdict, then context articles

The front page carried one verdict and three columns, and everything else sat
below the fold in its own section. A reader who only looked at the top learned
the transfer, the captain and the chip, and nothing else.

Under the verdict there are now up to five short articles, each a header and a
finding, drawn from sections the page already computes (so none of them costs
an extra call) and written by rule rather than by the model — these are facts
about the manager's own team, and a model paraphrasing them could only make
them less true. More candidates are built than are shown; they are ordered by
how much they should matter right now and the first `ARTICLE_LIMIT` with real
content are the ones that run.

The armband, the lineup and the next planned move moved into **Do now** — what
remains in this deck is context: things worth knowing that are not themselves
something to do. The first slot is always the manager's own gameweek:

- **Gameweek N live** — while matches are being played: points so far against
  the live average, who is still to play, who is playing now, what the captain
  has returned, and whether a starter who did not feature leaves autosubs to
  come. The dashboard had a blind spot exactly when it gets looked at most —
  between Saturday lunchtime and Monday night it showed next week's advice and
  last week's review and said nothing about the matches in progress.
  "Yet to play" is decided from the fixture list, not from minutes: a player
  whose match is tomorrow and one who was left out this afternoon both read as
  zero minutes, and telling them apart is the whole point. Cached for three
  minutes.
- **Last time out** — between gameweeks, the same slot carries how the last one
  went.

Then, in priority order: **The armband** (the captain call and the honest
margin behind it), **Free points** (what starting the best legal XI is worth,
since it costs no transfer), **Rank risk** (template exposure and
differentials), **The road ahead** (the next planned move and where fixtures
turn), **Price watch**, and **Our record**.

## `ep_next` is form — what the first real backtest found

The first backtest on real data (GW2–5 of 2026-27) looked healthy, and the
live page did not: +41.2 for one defensive swap, Schade projecting 11.1, a
Konsa-for-Bogle transfer. The difference was `ep_next`. On the live API before
the GW6 deadline it **equalled `form` for 354 of 355 fit players**, and was
form × chance-of-playing for the doubts. The model treated it as FPL's own
independent estimate: half the blend, and the prior every observation was
shrunk toward. Shrinking form toward itself regresses nothing, so a five-match
hot streak was projected flat across six gameweeks. The backtest had replayed
those weeks without `ep_next`, so it tested the other path through the model.

With the replay changed to set `ep_next` to form, as the live API does:

| | MAE | Rank corr. | Top 10 per position: promised → delivered |
|---|---:|---:|---|
| `ep_next` as prior (deployed) | 2.12 | 0.39 | 6.70 → 4.19 (1.6× overpromised) |
| price-based prior (now) | **1.92** | **0.44** | 4.51 → 4.58 |

`ep_next` is no longer read by the projection. The base rate is form and
points-per-game, each shrunk toward the price-scaled positional prior. On the
real squad that prompted this, Calafiori → Tarkowski fell from +41.2 to +10.9
over six gameweeks, Konsa → Bogle disappeared, and Haaland replaced Schade as
captain.

**Fixtures were under-weighted by half or more.** Measured over GW1–5
(each player's points in a match against his own average in his other
matches, 60+ minutes), an FDR-2 fixture was worth about 1.2× to attackers and
1.5× to defenders, and an FDR-4 about 0.87× and 0.71×. Home advantage was
about ±2%. The model assumed ±10% per FDR step for everyone, ±6% for home and
away, and halved the coming gameweek's effect. The halving dated from when
`ep_next` was in the blend and was taken to price the next fixture already;
it no longer is. FPL is also publishing every club's attack and defence
strength as 0 this season, so the position-aware strength half of the fixture
rating has been inert and FDR is all there is.

The swing is now per position (`XP_FIXTURE_SWING_ATT` 0.15,
`XP_FIXTURE_SWING_DEF` 0.25 per step), with a 2% home edge and no halving. The
backtest's leave-one-gameweek-out search picked no halving, a 2% edge, 0.3 for
defenders and 0.15–0.2 for attackers in every held-out week. MAE went
1.920 → 1.892 and rank correlation 0.441 → 0.471. The conservative end of that
range is used because five weeks is not much.

**The bench is worth a little.** Transfer gains are the change in the best
eleven each gameweek, plus 12%/6%/3% of the first three outfield subs'
projections (`BENCH_COVER_WEIGHTS`) for autosub cover. Before, the bench was
valued at exactly zero, so swapping a playable sub for a dud cost nothing.

## xP v2 — the component model (live as a 50% blend)

`projectPointsV1_` projects points from points: a recent points rate, pulled
toward a price-based prior, times a per-FDR fixture nudge. `projectPointsV2_`
builds each fixture from FPL's scoring rules instead:

- **Expected goals in this match, both ways.** Team attack × (opponent defence
  ÷ league average) × venue. Club rates come from season totals already in
  bootstrap: xG for is the sum of the players' `expected_goals`; xG against is
  Σ `expected_goals_conceded` ÷ Σ minutes × 90 (each player accumulates the
  team's xGA while on the pitch). Both are shrunk toward the league average.
- **His slice:** xG and xA per 90, shrunk toward a price-scaled positional
  prior, scaled by how much more or less his club creates in this fixture.
  The first-choice penalty taker's prior includes a club's penalty xG.
- **The scoring rules:** goals 4/5/6, assists 3 (× 1.35, because FPL counts
  assists xA does not), clean sheet 4/4/1 for 60 minutes, −1 per two conceded,
  +1 per three saves, 2 for reaching the defensive-contribution threshold
  (10 for DEF, 12 for MID/FWD), appearance 2/1, bonus per 90.
- **Clean sheets allow for clustered scoring.** Goals bunch together (more
  0–0s and more blowouts than random scoring gives), so P(clean sheet) uses a
  negative binomial, (1 + λ/r)^−r, not e^−λ. With e^−λ, clean sheets were
  under-projected 1.6–1.9× on GW2–5.
- **Minutes:** P(60+), P(cameo) and share of 90 from starts and minutes
  against the club's matches.

- **Bonus follows returns, and the player's own record moves it.** Bonus per
  goal, assist and clean sheet by position comes from a regression over
  2022-23 to 2025-26 (~1,300 player-seasons: about 1 per goal, 0.3–0.8 per
  assist, 0.6 per DEF clean sheet). That rate is the prior; his own bonus per
  90 is the evidence. A flat per-90 rate under-gave premium forwards 3.7×.
- **Defensive contributions are a player-level check, and over-dispersed.**
  His own actions per 90 are trusted after ~1.5 matches (135 pseudo-minutes of
  positional prior, not the 450 used for goals). Measured on 2025-26 (first
  five gameweeks predicting the rest), that forecast best, and 450 pulled
  attacking full-backs toward centre-back numbers. Reaching 10/12 uses a
  negative binomial with r = 3, which predicted 911 threshold hits against
  911 actual on 2025-26 (a Poisson: 715).
- **No finishing-skill factor, measured, not assumed.** Over 2022-23 to
  2025-26, beating xG one season barely predicts the next (correlation 0.15).
  A goals ÷ xG factor helps only when shrunk by ~80 xG of evidence, and then by
  0.6%. A raw factor makes forecasts much worse (MAE 2.40 vs 1.54).

Each projection carries its breakdown (`components`): points by source, team
and opponent xG, clean-sheet chance and penalty duty.

`XP_MODEL` picks the model: `'v1'`, `'v2'`, or `'blend'` at `XP_V2_WEIGHT`.
**The app runs a 50% v2 blend**, chosen by the manager to lean on underlying
numbers. On GW2–5 it ranked players best of any weight (0.485 vs v1's 0.471)
and delivered most from its top-10 picks (4.82 vs 4.72), at a slightly higher
MAE (1.909 vs 1.892). The held-out choice itself picked v1 or 25%, so this is
a judgement call; the Model eval report scores every weight on each run. Before the switch: The backtest now scores all three every run and chooses the
blend weight leave-one-gameweek-out. On GW2–5 the held-out result was a tie
(1.893 against v1's 1.892), so the app stays on v1. Two things should move it:

- defensive contributions are only in data fetched from now on (GW1–5 is
  re-fetched once by the workflow);
- GW6 is the first gameweek neither model has been tuned on.

The clustering (2.5) and assist (1.35) settings were read off GW2–5 by
component, so GW6 is also their first fair test.

## Club form and rotation

The per-gameweek live results for the last five finished gameweeks are cached
(they never change) and read two ways:

- **Rotation flags.** Every player's starts and minutes over his club's last
  three matches: *nailed*, *regular*, *rotation risk* (one start in three, or
  under half the minutes), or *not starting*. Shown on squad rows, in the XI
  check above the eleven, on transfer targets, and to the assistant. Injured
  players are left to their status flag. The flag is display only: the
  projection's minutes term is still the season share, until the backtest
  says a recent-window version predicts better.
- **`get_team_form`**, an assistant tool: a club's last five results with
  scorelines, goals and xG for and against (xG summed from player data, so
  only single-fixture gameweeks carry it), clean sheets, home/away split,
  league ranks for conceding and scoring, and the FPL points opposing
  defenders, midfielders and forwards have scored against it. That makes
  "are Bournemouth conceding a lot?" answerable.

## Transfers you have already made

FPL publishes a manager's picks only once a deadline passes. Between making a
transfer in the FPL app and that deadline, the page was reading **last week's**
squad, so the eleven and captain it recommended were for a team the manager no
longer had. There is no public endpoint for the pending squad, and storing the
manager's FPL login to read the private one would leave a credential in a script
property worth stealing.

So the manager tells the app what they did, either through the form at the top
of *Your squad* or by telling the assistant ("I sold Gakpo for Schade"), which
calls its `record_transfer` tool. Both write the same record:
`DECLARED_<gw>` holds (out, in) pairs against the last locked squad, plus an
optional Wildcard or Free Hit. On every load it is applied to the locked picks
before anything else runs, so the squad, the recommended eleven, bench order,
captain, the free transfers left, the bank and every remaining suggestion are
all for the squad actually held.

- **Validated, never half-applied**: like-for-like positions, budget (selling
  price, then bank), three per club, no duplicates. A declaration that breaks a
  rule is refused with every reason.
- **Merged**: selling someone bought earlier the same week folds into one move
  (A→B then B→C is A→C), and buying back the player sold cancels the move.
- **Graded fairly**: the decision snapshot is re-taken when the declaration
  changes, so the graded "recommended XI" is the one for the squad actually
  fielded. Before, it was the first recommendation of the week, often for a
  team the manager then changed.
- **Reconciled**: once the deadline passes and the real picks are readable, the
  declaration is checked against them, the page says whether they matched, and
  the record is retired. The API is the truth from then on.

**Play this eleven.** *Your squad* now leads with the validity check on the
eleven you have set (who *cannot play*, who is a *doubt* or a *rotation* risk
and whether he still starts), then one list: the recommended eleven in full
detail with the recommended armband, then the bench in autosub order. Anyone
the recommendation moves is marked on their row (*Start*, *Bench*, *Out*).
Below it is **the best eleven, gameweek by gameweek**: the eleven and captain each
later week of the transfer plan implies. This week's captain comes from the
full simulation. Later weeks use the highest projection in that week's eleven,
because running the simulation six times would not fit in a page load, so
they are marked provisional.

## Gameweek review and the transfer roadmap

**Gameweek N review** (under the verdict) answers "what happened last time":
score against the gameweek average, rank movement, points left on the bench,
what the armband returned against the best option in the same XI, and — by
diffing the previous gameweek's picks, since the API never says who moved —
what each transfer actually scored against the player it replaced. It splits
into *what worked* and *what did not*. A finished gameweek is immutable, so
the whole review is computed once and cached under its gameweek id.

**The next N gameweeks** is week-on-week strategy rather than one move for
right now. Each gameweek it asks: what is the best move available valued over
the gameweeks *remaining from that point*, what does waiting a week cost, and
is the gain worth a transfer at all. When this week's slice of a gain is small
it recommends rolling, because that banks a second transfer for almost no
cost — the reasoning is stated in points on every row. It also reports where
each of your clubs' fixtures turn, which is what decides *when* a move is
worth making rather than whether.

It is a **bounded lookahead**, not a greedy pass and not an optimal plan.
Greedy — taking the best move available each week and moving on — fails in a
specific, recurring way: it spends a transfer on a marginal upgrade, reaches
the gameweek where fixtures actually turn with nothing banked, and pays 4
points for the move it should have been saving for. Every decision was locally
defensible and the sequence was bad.

So it is a beam search over whole plans. Each gameweek, every surviving plan
branches into rolling, taking one of the top candidate moves, or taking two
and paying the hit; the top `ROADMAP_BEAM_WIDTH` carry forward. Two things
follow that greedy could not do at all:

- **Rolling competes on the same arithmetic as moving**, rather than through a
  heuristic tripwire. Banking a transfer is a branch that gets scored.
- **Plans are scored on the best legal XI each gameweek, minus hits** — not on
  the fifteen-man squad total. A fifth defender who never starts is correctly
  worth nothing, so the search values squad *structure*, which is the thing a
  sum of fifteen projections cannot see.

Candidates are pruned to the `ROADMAP_POOL_PER_POSITION` best players per
position, which is what keeps a six-gameweek search at roughly 30ms against a
700-player pool. A true optimum is a mixed-integer program over every player
and every remaining gameweek; there is no solver in Apps Script, the execution
ceiling is six minutes, and that is not something to hand-roll in JavaScript on
a request path.

The first gameweek stays **pinned to the transfer engine's own suggestions** —
a plan quietly disagreeing with the section above it would recreate the exact
bug this section was rebuilt to remove. The search runs a second time with the
first gameweek unpinned, and if planning further ahead genuinely beats the
recommended move, that shows up as **"the horizon disagrees"**: a stated cost,
not a competing instruction. Risk appetite survives as a per-move friction
charge, since a search that compares whole plans has no gain threshold to set.

## Captaincy

Every other model here predicts a **mean**. That is right for a transfer — you
hold a player for six gameweeks and the average is what you collect — and
wrong for the armband.

Captaincy is a *max-of-distribution* problem: the question is not who scores
most on average, it is who is most likely to be the one who goes big. FPL
points are lumpy enough that those are different players. A midfielder
returning 5 or 6 most weeks has a higher mean than a forward who blanks twice
then hauls 15, and the forward wins the armband far more often. Ranking on the
mean systematically prefers the metronome in the one decision where the tail is
the entire point — which is the mechanism behind a backtested hit rate *below*
what picking at random from your XI would manage.

**Shape and level come from different places.** A player's scoring shape is
taken from his own recent match log (`/element-summary/`, already cached for
the assistant) — his real distribution, skew and all. The level comes from the
xP model, which knows about this week's fixture, home advantage, doubles,
blanks and availability. The shape is rescaled so its mean lands exactly on the
quoted xP, so the simulation and the headline number can never disagree.
Neither source is sufficient alone: the match log knows nothing about
Saturday's opponent, and the xP model knows nothing about shape. Too short a
log falls back to a positional template — keepers tight, forwards long-tailed.

**Three questions, separated.** Highest mean maximises *points*. Highest
P(tops the XI) is a different answer. Neither maximises **rank**, which moves
on the difference between your captain and the field's — and that is now
computable, because the effective-ownership work gives the real captaincy
shares of actual rivals. Candidates are simulated against a mixture over those
shares, and the delta distribution is what gets ranked.

That is also what finally gives the risk setting a real meaning here. It used
to be a ±10% nudge on a mean, which is a thumb on a scale, not a risk
preference. It now selects *which part* of the delta distribution to optimise:

| Setting | Optimises | In practice |
|---|---|---|
| Safe | mean of the worst quarter of weeks | usually the template captain |
| Balanced | the mean | straight expected rank movement |
| Aggressive | mean of the best quarter | the differential with a ceiling |

Conditional tail means rather than percentiles: a single percentile reads one
point off the distribution, so a player who hauls in a quarter of his weeks can
have his entire upside sit just past the cutoff and be reported as having none.

When ranking for rank picks someone other than the points-maximising player,
**the page says so** — that disagreement *is* the decision.

The simulation is seeded on the gameweek. A captain recommendation that changed
every time you hit Refresh, because the noise landed differently, would be
worthless however sound the model behind it.

**The metrics changed too.** "Was he the literal top scorer" is a tail question
on which even an optimal mean-maximising picker lands about a quarter of the
time, so it makes a good model look broken and says nothing about the points
that actually reached your score. The track record now leads with **captain
efficiency** (points banked as a share of a perfect armband) and where the
captain finished in your XI; the hit rate stays, travelling with the random
baseline it should always have been read against.

*Known simplification:* draws are independent across players. Real returns
correlate — teammates share a clean sheet — so P(tops the XI) is slightly
overconfident for a squad stacked on one club. The delta-versus-field figures
that drive the recommendation are far less sensitive, since they turn on one
player against one player.

## Chip strategy

Chips were the last thing on the page decided by counting rather than
arithmetic. Any one player with a double gameweek — your fifteenth man
included — produced "a strong Triple Captain candidate".

Nothing new had to be computed. A chip is worth the difference between the
gameweek you play it in and the same gameweek without it:

- **Bench Boost** — your bench's projected points that week. That is the whole
  chip; nothing else changes.
- **Triple Captain** — one more helping of the armband, reported on both the
  mean and the simulated ceiling, because the ceiling is the week people
  actually play it for.
- **Free Hit** — the best eleven a legal fifteen at *your* budget could field
  that week, minus your own best legal eleven. Blank gameweeks fall out for
  free: a squad with six players not playing has a terrible baseline, so the
  gap opens on its own without any rule about counting blanks. The
  unconstrained figure is still reported, but as what it is — a ceiling —
  rather than as the chip's value.
- **Wildcard** — a squad rebuilt at your *actual* budget, measured over the
  whole horizon rather than one week, because a Wildcard changes structure.

Both of the squad-rebuilding chips used to be measured against something that
was not a team. Free Hit compared the best eleven *in the game* — no budget,
no three-per-club — against whatever lineup happened to be set, which is an
upper bound on an upper bound: the chip cannot buy an illegal squad, and not
playing it does not oblige you to leave a bad lineup alone. Wildcard summed
all *fifteen* projections on each side, pricing four players who never take
the pitch and rewarding a rebuild for stacking a bench. Both now compare
best-legal-XI against best-legal-XI, with the no-chip baseline being the best
you could do *without* the chip — the same objective the transfer roadmap has
been scored on since it was rebuilt, so the two can no longer disagree about
what a squad is worth.

Every row leads with a number comparable against the bar, against the other
chips, and against not playing it. The prose notes are generated from the same
values as the board, so a sentence and the figure beside it cannot disagree.

## Model calibration

The weekly grading loop was the best idea here and it terminated in a display
table. It graded the *calls* — was the captain right, did the transfer pay —
and never the arithmetic beneath them, which is the question a manager weighing
how much to trust the page actually has.

Snapshots now carry the per-player projections, so grading compares predicted
points against actual. That gets its own section, deliberately unflattering:
overall, per position, and gameweek by gameweek.

It also feeds back. Fitting the weights properly is a regression problem that
does not belong in a page load, but a systematic bias — running hot on
defenders, say — is one multiplier per position, learnable by division, and
that is where most recoverable error sits. The correction is deliberately
timid: nothing before four graded gameweeks, shrunk toward no-change in
proportion to how little evidence supports it, and clamped at ±25%, because a
position further out than that is a bug to find rather than a coefficient to
paper over.

**Version 2 (current).** The first version had three biases of its own, each
pushing the measured error in a different direction:

- it graded only the fifteen players in the manager's squad — after five
  gameweeks that was 19 midfielders and 11 forwards, which is noise, not bias;
- it graded the *calibrated* projection, so each week's correction was learned
  on top of the previous one and compounded;
- it counted only players who featured, but scored them against a projection
  that already priced in the chance of not featuring — an unconditional
  forecast against a conditional outcome, which makes every forecast look low.

Snapshots now store the **raw** (uncalibrated) next-gameweek projection for
**every player** projecting 0.3 or more, as compact `id:xp` pairs (pruned once
graded, so a season fits in the property store). Grading compares every one
projecting 1.0 or more against what they actually scored, zeros included —
selection on the forecast, which is harmless, rather than on the outcome,
which biases. That is a few hundred player-gameweeks per position per week.
The correction starts after three graded weeks and reaches full strength at
ten. Version 1 grades are ignored; they measured something else.

### The week the loop was grading

For a while it was correcting the model against the wrong gameweek, and the
failure was silent because every number involved looked reasonable. Every
projection snapshotted for grading is `xp.next`, and `xp.next` is the first
gameweek of the *actionable* horizon — the one whose deadline has not passed.
Once GW2's deadline went, that horizon started at GW3, so the snapshot filed
under "GW2" held GW3's projections and the grader scored them against GW2's
actual results. A systematic one-week offset, fed straight into the thing
whose entire job is to learn a correction from it.

The cause was that one record held two facts known at two different times: the
advice for a gameweek (which must be frozen *before* its deadline) and the
team actually fielded in it (readable only *after*). They are now separate —
`snapshotDecision_` files advice against the gameweek it is advice for,
`recordActualLineup_` files the team sheet against the gameweek it was played
in — and grading joins them by gameweek id. New grades carry an
`alignedProjections` marker; the calibration reader takes only marked weeks,
so the mis-stepped history is discarded rather than averaged back in. Losing
it costs nothing, because it was never evidence about anything.

## Invariants — what the page refuses to publish

Every decision-engine bug worth fixing so far has had the same shape: an
output that was not merely debatable but *impossible*. A chip valued against a
team nobody could field. A −4 charged on a week with a free transfer spare. A
captain who was not in the eleven. Advice for a gameweek that had already
locked. None of that needs a model to detect; it needs arithmetic checked
against itself.

`checkModelInvariants_` runs before the verdict is written, because the
verdict is the part that sounds certain, and a confident sentence on top of an
impossible number is worse than the number alone. It asserts eleven players in
a legal formation, no club over three, no duplicates, a suggested captain who
is in the XI, hits charged only beyond the free transfers, four points per
hit, net gain following from gross less hits, a bank that never goes negative,
a horizon equal to the sum of its gameweeks, chip gains that are the
differences they claim to be, and a decision gameweek that is open and is not
the one being played. A failure withholds the Ruling and says which check
failed.

Plausibility bounds are kept deliberately separate, as warnings rather than
failures. "This number looks too big" is a heuristic, and heuristics have
false positives — a genuinely poor squad early in a season really can be worth
forty points of rebuild — so an implausible figure is surfaced on the Debug
page without blanking the front page. Only a broken identity does that.

## Effective ownership

`selected_by_percent` — the whole game's ownership — is the wrong number for
judging rank risk, for two reasons. It counts squad membership rather than
deployment, so a player owned by 40% and benched by most of them costs you
almost nothing to miss; and it ignores captaincy, which is where the points
actually swing.

Effective Ownership fixes both, and it is exactly computable rather than
estimated. Every pick in the API carries a `multiplier` — 0 benched, 1
started, 2 captain, 3 triple captain — so

    EO% = 100 x sum(multiplier) / managers

is the field's real exposure, chips included.

The field measured is **your own mini-league**, not the global top 10k. The
public API publishes no captaincy distribution at any rank tier, so a global EO
could only ever be guessed at; the league standings endpoint plus one picks
call per rival gives the exact answer for the table you are actually trying to
win. Rank against eleven million strangers is an abstraction. Rank against the
twelve people in your league is the game.

Each row carries the **swing** it represents — your own multiplier minus the
field's EO, times that player's expected points — which is the whole risk
position in one number, and the "safety vs ceiling" read the section leads
with. Cost is one call per rival, issued together through
`UrlFetchApp.fetchAll` so they run concurrently: ~600ms for a 24-manager league
rather than ~15s serially, cached under the gameweek id since a locked
gameweek's picks never change.

One caveat the page states rather than buries: picks are only readable *after*
a deadline passes, so this is the field's exposure in the gameweek being
played, applied to the one being picked for.

## Price watch

The old price watch reported `cost_change_event` — a change that has already
happened, which is the one thing you can do nothing about. It now measures the
pressure behind a change instead.

FPL never publishes the price-change algorithm, so nothing here claims to
predict one. What is measurable is that the threshold scales with how many
people already own a player, which makes the meaningful quantity not the raw
net transfer count but that count against his own owner base:

    pressure = (transfers_in - transfers_out) / owners

60,000 net transfers into a 2%-owned punt is a stampede; the same number into a
45%-owned premium is noise. Dividing by owners is what makes them comparable,
and it is why ranking on a bare transfer count — which is what most dashboards
show — gets them the wrong way round.

A **recommended buy under strong rising pressure** is the only row on the
dashboard with a deadline of tonight, so it leads. Counts accumulate across the
whole gameweek while prices change nightly, so anyone who has already moved
this gameweek is marked as having spent part of the momentum still showing in
their numbers.

## The command palette (Cmd+K)

The page answers a lot of questions and charges the same price for every
answer: find the section, open the right row, read across a table. That is
right for reading the week's verdict and wrong for "what is Semenyo
projecting" — a question with a two-line answer you want without leaving where
you are.

`Cmd+K` (`Ctrl+K` elsewhere) opens a terminal over the page. Commands that have
a short answer **render it in place** rather than navigating, which is the
entire point; a palette that only ever scrolled you somewhere would be a table
of contents with extra steps.

- `/cap` — the captain call and the simulated chance behind it
- `/player <name>` — one player in your squad, in full
- `/live` — how the gameweek in progress is going
- `/eo`, `/plan`, `/price`, `/xi` — each section's answer, inline
- `/compare <a> <b>` — deep-links to Player Ratings, which already lines four
  players up against every component behind their scores
- `/ask <question>` — hands the question to the assistant
- `/do`, `/refresh` — jump, and reload

Matching is subsequence rather than substring, so `smny` finds Semenyo. The
section index is read from the rendered DOM rather than a hand-kept list, so a
section added to the page is reachable without anyone remembering to register
it. Nothing costs a round trip except `/ask`.

## The AI assistant

The assistant used to be a single shot: build one context block describing the
squad as it stands, hand it over, take a few sentences back. That grounds it
well in the **present** and leaves it unable to answer anything about the past
— which is most of what a manager actually asks. "Has he started the last
three?" "What did Salah do at Everton last time?" "Am I above where I was in
October?" None of that is in `bootstrap-static`, so no context block, however
large, could contain it.

It lives one call away, in `/element-summary/{id}/`. Fetching that for ~700
players on the off-chance is absurd; fetching it for the one player being asked
about is a single call. That is a tool, not a context field.

So the assistant has tools and a loop. It decides what it needs, the loop
fetches it, and it answers from real match data instead of hedging:

- `get_player_history` — match by match for any player in the game: minutes,
  goals, assists, points, bonus, opponent; plus previous-season totals and the
  upcoming run
- `compare_players` — two to four players against this app's own numbers
- `get_my_season` — your season gameweek by gameweek: points, both ranks, bench
  points, transfers and what they cost, squad value, chips
- `search_players` — the pool by position, price, ownership, availability
- `get_league` — your standings and the effective ownership behind them

The tools are deliberately few and coarse: a model choosing between five
obvious tools is reliable in a way that one choosing between twenty
overlapping ones is not. Every lookup it makes is **named above its answer** —
an assistant that quietly fetches a match log and states the result reads as
one that made the number up.

Two more things changed. The **conversation persists** server-side, so a
Refresh, a team-id change or a deploy no longer starts a stranger; an assistant
that cannot remember what you asked four minutes ago is a search box with a
personality. And the squad state is **rebuilt on every question** rather than
carried in the transcript, so an answer given after a price change is grounded
in the state as it is now.

**Two models, because the two jobs are not alike.** The assistant reasons over
a squad, picks tools, reads a match log back and weighs players against each
other — it runs on `claude-opus-5`. The copy jobs (the Ruling's prose, the
Panel synthesis) restate figures already computed into a sentence, which is
what a small fast model is for — those stay on `claude-haiku-4-5`. Both bill to
your own key; the copy calls are cached per gameweek and per video, so the
recurring cost of a page load is unchanged, and the squad state is prompt-cached
between questions in a session. Change `AI_MODEL_CHAT` near the top of
`Code.js` if you would rather trade quality for cost.

## Player Ratings (`?page=ratings`)

Every player in the game, scored by the same arithmetic the dashboard uses on
your squad. The table opens sorted by **xP horizon**, not the ranking score —
xP is what the transfer and captain sections decide on, so the page should
agree with them.

**Head to head.** Add up to four players and their full breakdowns line up in
columns: the decision numbers (xP next, xP horizon, xP per £m, rank in
position, how far above the position median), then every weighted component
and multiplier, then the plain-language read. The better figure on each row is
marked — and when every player ties, nothing is marked rather than all of them.

Three things on this page were saying something untrue and now don't:

- **"Value (pts/£m)"** was `score / price`. Score is dimensionless, so that
  column's units were nothing at all, presented as points. It is expected
  points per million now.
- **Recommendation tiers** were purely percentile, so the top 15% of every
  position was "Strong Buy" every week whether or not anyone was worth buying —
  eight of the top nine rows on the live page carried it. A tier now needs both
  a rank *and* a real gap over the position's median, so in a flat week the top
  tiers legitimately come back empty.
- **Flagged players** were labelled "Avoid", which put a red pill on players
  sitting fifth by score. Availability news is not a verdict on quality:
  they read as "Flagged", and Avoid is reserved for available players who
  genuinely do not project well.

The page also shows which players are **already in your squad**, their next
three fixtures, and filters for squad-only and available-only.

The response is served pre-serialized (`getPredictionScoresJson`) for the same
reason the dashboard is: at ~370KB for a full player pool it is by a distance
the largest thing this app sends over `google.script.run`, and the ~35KB
dashboard payload was already being dropped by that bridge's object
marshalling. A string crosses as a primitive.

## Track record

Every gameweek's calls are snapshotted before results are known and graded
against live FPL data once it finishes — the captain pick, the top transfer,
and the recommended XI. The **Track record** section reads all of those grades
back and reports the season-long rates: how often the captain call lands, what
it costs when it misses, whether transfers are net-positive after hits, and
whether the recommended XI beats the one you set. Where those numbers exist,
they replace the backtest figures in the closing section — a measured claim
about your team beats a simulated one.

## Fixtures and the decision horizon

The lookahead window is the gameweeks whose **deadline has not passed** — the
ones you can still make decisions for. "Not finished" is the wrong test: a
gameweek in progress is not finished, but its squad is locked. The app also
reads the full `/fixtures/` list rather than `?future=1`, because that filter
drops any fixture already kicked off — which removed the in-progress gameweek
from the fixture map entirely while it was still leading the lookahead window.
The symptom was every player projecting 0.0 expected points, a captain section
saying "blank gameweek — do not captain" about everyone, and Free Hit
triggering on "15 of your players blank".

## Performance

The dashboard load was 11.7 seconds. Only 1.5 of those seconds was work.

The stage logger wrote a row to `PropertiesService` as each stage completed —
a read plus a write, ~390ms, paid 26 times per request. The Debug page's own
log made it plain: a flat ~390ms gap before every single stage, 10.2 seconds
of an 11.7 second request. The tool built to explain why the dashboard was
slow had become the reason it was slow, and it inflated every timing it
reported. Rows are now buffered in memory and written once per request, from
a `finally` so a request that throws still leaves its partial trace: 52
property calls down to 3.

## Rendering

The dashboard renders by accumulating one long `innerHTML` string, and its XSS
safety rested entirely on remembering `escapeHtml_` at every point where
API-supplied text is interpolated — player news, league names, the Panel's
prose. That discipline held, but it is discipline: every new section re-rolled
the dice, and the failure is silent when it loses.

`h(tag, attrs, children)` inverts the default. Text is escaped unless wrapped
in `raw()`, which makes including unescaped markup a visible, greppable act
rather than the consequence of forgetting something; attribute values are
always escaped with no opt-out. It is not a framework and does not need
adopting wholesale — the existing builders are fine where they only interpolate
numbers this app computed itself. It is for the places that render text from
outside, which is where the risk lives.

## Caching

`bootstrap-static` is ~700KB and was fetched and parsed on every page load,
again by the Ratings page, and again by every trigger tick. It is now slimmed
to the ~30 fields the app actually reads, gzipped, and split across
CacheService keys (15-minute TTL; fixtures 30 minutes). Every step falls
through to a live fetch on any failure, so the cache can only make a request
faster, never break it. The masthead Refresh button clears it outright.

## Model eval — the backtest you can run from your phone

`.github/workflows/model-eval.yml` ("Model eval" in the Actions tab) fetches
the FPL data, runs the unit tests, backtests the model against every finished
gameweek, and puts the report on the run's summary page. Run it from anywhere
with **Actions → Model eval → Run workflow**, which works from a phone browser.
It also runs every six hours on its own (once the workflow is on `main`).

Data and reports go to the **`eval-data` branch**, never `main`, so `main`
stays code-only and a data commit can never trigger a deploy:

```
eval-data/<season>/bootstrap.json            latest player state (slim)
                  /fixtures.json             every fixture, both sides' FDR
                  /live/gw<N>.json           per-player results, finished GWs
                  /snapshots/pre-gw<N>.json  player state before GW N's deadline
eval-data/reports/latest.md|json, history.jsonl
```

The six-hourly schedule exists for the snapshots. FPL's API only ever serves
"now", so FPL's own `ep_next`, the injury flags and chance-of-playing as they
stood before a deadline are gone once it passes. A snapshot overwritten every
six hours until the deadline is the only way to keep them.

**How a gameweek is replayed.** For each finished gameweek *T* after the first,
`eval/backtest.cjs` loads `Code.js` itself through the test harness, sets the
clock to an hour before *T*'s deadline, gives it the player state as it stood
then, and scores its projections against what happened in *T*. With a
snapshot the replay is faithful. Without one (GW1–5 of this season, before the
workflow existed) the state is rebuilt from results 1..*T*−1 — form,
points-per-game, minutes — and runs without `ep_next` or injury flags, so those
weeks test the scoring model, not the availability model. The report labels
every gameweek with which kind it was.

**What it reports**, against four baselines a manager could have read before
the deadline (FPL's `ep_next` where a snapshot has it, form, points per
appearance, the mean of the last three gameweeks):

- **Error**: mean absolute error, RMSE, and actual ÷ projected, overall, by
  position (the calibration the app should apply), by price band, and in
  calibration buckets ("when it says 4, what happens?");
- **Ranking**: rank correlation within each position — what every decision
  actually depends on;
- **Top 10 per position**: what the model promised them against what they
  delivered. Promised well above delivered is the optimiser's curse that
  inflates transfer and Wildcard gains, measured directly;
- **The horizon**: actual ÷ projected two, three and four gameweeks out;
- **A verdict**: whether the model beats the best baseline beyond noise, with
  a bootstrap 95% interval.

`--tune` searches `XP_PRIOR_MATCHES`, `XP_FORM_HALF_LIFE_GWS` and
`XP_FIXTURE_SWING` (27 combinations) and reports a **leave-one-gameweek-out**
estimate: choose the constants on the other weeks, score them on the held-out
one. The in-sample winner always looks better than it is; only the held-out
number says whether changing a constant would help. The backtest never edits
the model — a change is a reviewed commit.

Run it locally with `node eval/fetch.cjs && node eval/backtest.cjs eval/data --tune`.

## Backtest results (2025-26 season, full GW1–38 simulation)

> **Superseded.** A later review found this backtest scored a different formula from the one the app ran (it left out FPL's `ep_next` and weighted ICT differently), so these figures are not evidence about any version of the app. The model eval above replaced it.

Full backtest code/data lives in a separate `backtest/` folder shared via
Drive (not yet in this repo) — headline numbers:

- Algorithm total: **1,932 pts** vs. a static "hold GW1 squad all season"
  baseline of **1,693 pts** (+14.1%).
- Transfer quality: 60% of transfers were net-positive over the following
  3 gameweeks.
- Captain pick accuracy: only **5.3%** of gameweeks had the suggested
  captain as the actual top scorer — the biggest known weakness, flagged
  for future tuning (captaincy is inherently high-variance to call in
  advance; see `evaluation_report.html` for the full breakdown).

**These numbers predate several changes to the algorithm** — the
community-signal scoring input described below, and then the larger rework
above (xP-based decisions, per-90 xGI, per-gameweek fixture weighting,
hit-aware transfers, the rewritten captain model). They describe the algorithm
as it stood before all of that, not the current one. Treat them as directional
until the backtest is re-run; the Track record section is the live,
current-formula answer to the same question.

The captain figure in particular is the one the rework targeted: the old pick
was `form × six-week average fixture ease` and nothing else — it could not see
this week's actual fixture, home from away, a double gameweek, penalties, or
minutes. Whether the new model does better is a question the track record will
answer with real gameweeks rather than a claim made here.

## Known gaps / not yet done

- **Captaincy is modelled properly now but not yet re-measured.** The 5.3%
  backtest figure predates the simulation model entirely, so it says nothing
  about the current one either way. The efficiency and top-three figures on the
  Track record page are the ones to watch; they need a season's worth of
  gameweeks before they mean much.
- **Simulated returns are independent across players.** Teammates really
  share clean sheets, and a team having a good day lifts all its attackers,
  so P(tops the XI) is a little overconfident for a squad stacked on one
  club. Correlated draws are the obvious next refinement.
- **Effective ownership is your league's, not the global top 10k's.** That is a
  deliberate choice (the public API publishes no captaincy distribution at any
  rank tier, so a global figure could only be guessed at) but it does mean the
  tool cannot tell you what the elite are doing, only what the people you are
  playing against are.
- **The plan is a bounded search, not an optimum.** The candidate pool is
  pruned to the best 30 per position and the beam is six wide, so a genuinely
  exotic multi-week route can be missed. A mixed-integer program would find it;
  Apps Script has no solver and a six-minute ceiling. Funded upgrades (two
  sales paying for one premium) are searched, but only from the four weakest
  holdings against four targets — a three-body enumeration over the full squad
  is far more work than the rest of the search combined.
- **The AI verdict is written one load behind.** Generating prose in the
  request path meant the slowest loads were the weeks something interesting
  happened, so a changed verdict now serves the rule-based version immediately
  and the trigger writes the prose for the next load. Without the trigger
  installed, the request path still generates — losing the feature would be
  worse than a slow load.
- A parallel Node/Express + Railway rewrite was scoped but not built
  beyond a `package.json` — deprioritized in favor of finishing this
  pipeline. Full architecture plan is preserved in the project's Drive
  handoff doc if ever revisited.

## Deadline reminders + weekly AI verdict

`checkAndSendReminder` emails the app's own effective user (`MailApp`) once
a gameweek deadline is within 36 hours, deduped per gameweek via
`LAST_EMAILED_EVENT` in `PropertiesService` so it can't double-send.
`weeklyVerdictCycle` proactively refreshes the cached front-page verdict
(`getRuling_`) so it reflects the current gameweek even if nobody opens the
dashboard — the cache is keyed on the actual top transfer/captain/chip call,
so this only spends an AI call when that call has genuinely changed, not on
every tick.

Optional setup, from the Apps Script editor: `installWeeklyTrigger()` once
to start both checking every 6 hours — or use the "Install Weekly trigger"
button and "Weekly (reminders + verdict)" status badge on The Wire page's
Diagnostics panel, no editor needed. Unlike The Panel below,
this pipeline has no other on-page freshness signal, so the Diagnostics
status badge is the only way to confirm it's actually installed.

## The Wire — The Panel (`?page=wire`)

A dedicated page, separate from the main dashboard, for everything the app
reads from outside its own algorithm. Linked from the masthead nav on both
the dashboard and Player Ratings ("The Wire →"). Backend entry point:
`getWireData()` in `Code.js`, rendered by `Wire.html`.

It does double duty: shown on this page for a human to read, **and** folded
into `playerScore_` as a real "community signal" scoring term (see below) —
not just UI decoration.

**Reddit Pulse was removed.** Unauthenticated access had already degraded to
an RSS fallback with no upvote scores and best-effort comment counts, and
what came back was overwhelmingly not recommendation signal — "GW1 Lineups",
"Bonus Points + Defcon", transfer rumours, jokes. Counting those as evidence
that a player was backed was noise dressed as data.

### The Panel (expert YouTube analysis)

Turns 2-3 tracked FPL YouTube channels' latest uploads into short
newspaper-style entries, cross-checked against this app's own Ruling
("agrees with the Ruling" / "differs — we say Isak"). Design brief:
`docs/EXPERT_PANEL_DESIGN.md`.

**Not every upload is a take.** An FPL channel's uploads feed also carries
shorts, giveaways, sponsor reads, watchalongs and off-season filler, and every
one of them used to be sent to Gemini, synthesised, stored, and mined for
player names that fed the community term in the scoring model. A sponsor read
saying "imagine Haaland on this sofa" is not a Haaland recommendation, and
nothing in the pipeline could tell the difference.

Two gates now, cheapest first. A **title filter** runs before any API call is
spent, rejecting only hard negatives — a terse title like "GW12" is a perfectly
normal name for a real tactics video, so an absent positive marker proves
nothing and is not treated as evidence. Then **Gemini's own verdict**, which is
the reliable one because it has actually watched the video: the extraction
prompt opens with a `RELEVANT: yes|no` line, so one call does both jobs rather
than paying for a classification pass and an extraction pass. A malformed reply
gives the video the benefit of the doubt rather than silently emptying the
Panel on any prompt drift, and rejected video ids are remembered per channel —
a skip has to be as durable as a hit or the gate costs more than it saves.

Two AI providers doing two different jobs: Gemini takes a YouTube URL
directly (no download, no transcript scraping) and extracts the raw FPL
recommendations from the video; Claude (the existing Anthropic key) turns
that into the newspaper voice and the agree/differ verdicts, grounded in
the same squad/Ruling data the chat assistant uses. Every video is
processed at most once — each channel's last-seen video ID is cached and
checked before any AI call runs.

Setup, all free:
- A YouTube Data API key (Google Cloud Console → enable "YouTube Data API
  v3") and a Gemini API key (Google AI Studio) entered through The Wire's
  setup box — same `PropertiesService` pattern as the Anthropic key, never
  touches this repo.
- The tracked channels live in `PANEL_CHANNELS` at the top of `Code.js` —
  a short hand-picked list (`@handle` is enough), not auto-discovered.
- From the Apps Script editor: `installPanelTrigger()` once to start
  checking every 6 hours, `debugPanel()` to test immediately (check
  View > Logs) — or use the Diagnostics buttons on The Wire page itself,
  no editor needed.
- A channel's newest upload older than `PANEL_MAX_VIDEO_AGE_DAYS` (7) reads
  as "no fresh take" rather than being processed, so a quiet channel
  doesn't get an AI call spent resurfacing a stale video.

### The 7-day window

The Panel used to read only each channel's single newest upload, which meant
a channel that posted twice in a day had its earlier take silently dropped,
and a channel whose newest upload was a trailer or a stream announcement
showed nothing useful all week. It now reads **every video each tracked
channel published in the last `PANEL_WINDOW_DAYS` (7) days**, newest first —
up to `PANEL_MAX_VIDEOS_PER_CHANNEL` (4) kept per channel, with at most
`PANEL_MAX_NEW_VIDEOS_PER_RUN` (2) newly processed per channel per tick so
AI spend stays bounded; the rest are picked up on the next tick. Anything
older than the window ages out of both the page and the scoring term, so a
good take from three weeks ago stops counting as current.

Fetching 15 uploads costs the same 1 YouTube quota unit as fetching 1 —
`playlistItems.list` bills per call, not per item — so the only real cost is
one Gemini + one Claude call per *new* video, and each video is processed at
most once ever.

**This week's consensus** (`buildPanelConsensus_`) aggregates every pick
across every video in the window. A single video's picks are one analyst's
opinion; the same player named by several channels independently is the
closest thing to a consensus this app can observe. The section reports, per
call, how many distinct channels and how many videos back it, and whether it
agrees or differs from the Ruling.

`synthesizePanelEntry_`'s prompt caps "picks" at 5 and explicitly excludes
predicted-squad listings — only genuine calls (a chip decision, the
captain, a handful of specifically-argued differentials) count as a pick.
Comparison data comes from `buildAiContext_`, which falls back to the
suggested-squad data during preseason (no real squad is readable before
GW1's deadline) so agree/differ verdicts have something real to compare
against instead of a blanket "no data" for every player.

### By Player — the Sheet-backed union (also on `?page=wire`)

Both feeds above log one row per (player, source) mention — as it
happens, deduped so nothing gets logged twice — to a Google Sheet
auto-created on first use (`REC_SHEET_ID` in `PropertiesService`, no
manual setup). `getPlayerRecommendations_()` reads it back grouped by
player: who recommended Isak, from where, and why, across every Panel
video ever processed — the full history, not just the current week shown
above. A direct link to the Sheet is shown on the page.
This is the durable-history upgrade `PropertiesService` alone can't do
(9KB/property, 500KB/project caps) — matches the storage tradeoff called
out in `docs/EXPERT_PANEL_DESIGN.md`.

### Community signal (feeds back into scoring)

`loadCommunitySignal_()` reads the cached Panel entries (no extra network
calls) and builds two per-player counts; `communitySignalFor_()` turns those
into a capped, weighted term added directly into `playerScore_`'s raw score —
same `(input × weight)` shape as form/fixtures/xGI, so it's fully visible in
the Player Ratings breakdown, not a hidden fudge factor:

- **Videos** backing the player, up to 4 × 0.5. This is volume — one analyst
  can post three videos in a week.
- **Distinct channels** backing the player, up to 3 × 1.2. This is agreement
  between independent sources, which is the stronger signal, so it carries
  the heavier weight.

Counts *any* pick, agrees or differs — using only "agrees" picks would let
the score slowly reinforce its own past calls, since the agree/differ verdict
is itself computed by comparing against this app's own suggestions.

Deliberately a secondary nudge: a player at both caps adds at most ~5.6 to a
raw score that typically runs 10-50 for a rotation-relevant player. Weights
and caps are constants near the top of the `SCORING` section in `Code.js` —
tune freely, but remember this changes which transfers/captains get suggested
(see the backtest caveat above).
