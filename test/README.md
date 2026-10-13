# Tests

```bash
node test/run.cjs
```

No dependencies, no test framework — Node only.

## How they work

`harness.cjs` loads `Code.js` into a `vm` context with the Apps Script global
services (`PropertiesService`, `CacheService`, `UrlFetchApp`, `Utilities`, …)
replaced by in-memory stubs. Everything in `Code.js` that is pure computation —
the transfer planner, effective ownership, price pressure, the assistant's
tools and its tool-use loop — then runs and can be asserted on outside Apps
Script. Network access is stubbed to throw, so any test that would have made a
real call fails loudly rather than quietly hitting the FPL or Anthropic API.

`test_palette.cjs` does the same for `Index.html`: it extracts the page's
script block, strips the Apps Script template tags, and evaluates it against a
minimal DOM stub.

## Why `.cjs` and not `.js`

`.clasp.json` sets `scriptExtensions` to `[".js", ".gs"]` with
`skipSubdirectories: false`, so the deploy workflow's `clasp push -f` uploads
**any** `.js` anywhere in the repo into the live Apps Script project. A `.cjs`
is invisible to clasp and still runs as CommonJS under Node with no
`package.json`, so these can live beside the source without a `.claspignore`
and without any risk to the deploy pipeline.

Keep it that way: a test file named `.js` would ship to production.

## What is covered

| Suite | Covers |
|---|---|
| `test_roadmap.cjs` | Best-legal-XI scoring, the beam search's plan validity (budget, club limits, no double-buys), free-transfer accounting, gameweek-one pinning, divergence, risk appetite |
| `test_scale.cjs` | The planner against a realistic ~700-player pool: runtime budget, and the hit-funded double-move case |
| `test_eo.cjs` | Effective ownership arithmetic (captaincy at 2x, swing, threats vs edges, small-league guard) and price pressure normalised by owner base |
| `test_ai.cjs` | Player-name resolution, every assistant tool, error containment, tool-schema validity, transcript persistence and trimming |
| `test_loop.cjs` | The tool-use protocol: thinking blocks echoed verbatim, parallel results batched into one user message, the round cap, the forcing call |
| `test_palette.cjs` | Command-palette fuzzy matching, every inline answer, graceful degradation, and the escape-by-default `h()` renderer |
| `test_captain.cjs` | Distribution shaping and rescaling, the PRNG's determinism, that mean ordering and win ordering genuinely diverge, risk appetite changing the pick, tail means |
| `test_chips.cjs` | Bench Boost / Triple Captain valuation, board status against the bar, prose agreeing with the numbers, used chips |
| `test_calibration.cjs` | Recovering a known bias, the correction's timidity and clamp, per-position independence, corrupt-grade tolerance |
| `test_model.cjs` | Starter floor tightening with evidence, position-aware fixture multipliers splitting attackers from defenders, and every degradation path |
| `test_free_transfers.cjs` | `estimateFreeTransfers_` against the real FPL accumulation rule: the fresh-squad case, spending, rolling, banking, the wildcard/free-hit carve-out, the cap |
| `test_gwstate.cjs` | `resolveGameweekState_`: the gameweek being played vs picked for vs read, preseason, between gameweeks, the hour after a deadline passes, end of season, and that the projection horizon starts at the decision gameweek |
| `test_ledger.cjs` | `buildTransferLedger_` and the prose derived from it: hits charged only beyond the free transfers, net = gross − hits, the canonical one-line rendering, rolling, the banking cap, and every FT/move combination reconciling |
| `test_shrinkage.cjs` | `xpBaseRate_`'s Bayesian shrinkage: one gameweek not read as a rate, evidence earning weight, symmetry for a blanked premium, ordering preserved, preseason untouched |
| `test_dashboard_e2e.cjs` | The whole `getDashboardData()` build against a synthetic season served through a stubbed `UrlFetchApp`: the XI validity pass, transfer arithmetic and counterfactual, one chip decision, the per-gameweek XI, declared transfers flowing through every figure (and illegal ones refused), the re-taken snapshot, whole-pool v2 grading, and post-deadline reconciliation |
| `test_backtest.cjs` | `eval/backtest.cjs` on a synthetic season written in `eval/fetch.cjs`'s on-disk shape: no future data in a replay, every metric, tuning's leave-one-out estimate and that it leaves the model untouched, snapshot-preferred replays, and the too-little-data path |
| `test_recent_form.cjs` | Rotation flags (nailed, rotation risk, not starting, injured left to status), club form (results, goals, clean sheets, home/away, xG only where the data exists, points conceded by position, league ranks), the `get_team_form` tool, and that a playable bench player is worth something in a transfer |
| `test_model_v2.cjs` | The component model: Poisson and clustered-scoring helpers, club rates from season totals, each scoring component responding to the right side of the fixture (clean sheets to the opponent's attack, goals to its defence), penalty duty, saves, the defensive-contribution threshold, missing data falling back to priors, the minutes model, and the v1/v2/blend switch |
| `test_dashboard_e2e_v2.cjs` | The whole end-to-end dashboard suite again with `XP_MODEL = 'v2'` |
| `test_ratings_payload.cjs` | The Player Ratings data: the live model named, each player's xP breakdown in the compact key order, the blend equal to the xP ranked on and between the two models, v2's parts summing to its total |
| `test_invariants.cjs` | `checkModelInvariants_`: every impossible output it refuses to publish, and the plausibility warnings it flags without blanking the page |

`synth_season.cjs` (not a suite) generates the deterministic synthetic season
both of those use: twenty clubs, a full fixture list, ~360 players with hidden
true scoring rates, and real-shaped API responses.

## Bugs these caught

- **Free transfers driven to zero.** A two-move week funded by a −4 left the
  count at 0, so the plan priced the *next* week's single move as another hit.
  FPL grants a free transfer every gameweek and taking a hit does not forfeit
  it. The greedy planner never hit this because it capped moves at the free
  transfer count.
- **The effective-ownership "edge" bar was non-binding.** At 15 points of
  difference, any started player the field held below 85% EO counted as a
  differential — which is nearly the whole squad.
- **The position-aware fixture blend double-weighted one half.** It documented
  a 50/50 blend of FDR and team strength and computed something else, letting
  the strength term dominate.

They also caught two bad *test fixtures*, which is worth recording because
both looked like code failures at first. A two-candidate captaincy simulation
cannot show that boom-bust players top an XI more often (head to head, the
steady scorer wins most weeks — the effect needs the other nine players, with
real variance of their own). And a funded-upgrade fixture proves nothing if
the players being sold are bench fodder, since selling them moves the
best-legal-XI objective by exactly zero.

Two more bugs, found on the live page rather than by a test — both are what
prompted `test_free_transfers.cjs` and the strengthened assertions in
`test_palette.cjs`:

- **Free transfers were off by one, for every manager, all season.**
  `estimateFreeTransfers_` started its running total at 1 and then the loop
  added another 1 for the very first gameweek's allocation — the initial
  squad pick isn't a transfer at all, so there is no free-transfer concept
  before the season starts, and starting the counter at 1 double-counted the
  first grant. A fresh squad entering GW2 was reported as having 2 free
  transfers instead of 1, which meant a second suggested move that week was
  actually going to cost a −4 while every cost line on the page called it
  free.
- **The squad list rendered as visible tag soup.** Three of `playerRowHtml_`'s
  four fields were nested `h()` calls missing their `raw()` wrapper — a
  nested `h()` call returns an HTML *string*, and `h()`'s own child renderer
  treats a plain string as untrusted text and escapes it, which is the whole
  mechanism escape-by-default relies on. Every row in Your Squad showed
  literal `<div class="pos">GKP</div>...` as text. The existing test for this
  function only checked that substrings like `"cap-mark"` were present
  anywhere in the output — which is true whether the tag is real markup or
  escaped text, since escaping only touches `& < > " '` and leaves the rest
  of the string alone. That is exactly the gap that let it ship: a test built
  on substring presence cannot tell working markup from broken markup.

## The decision-engine review (the gameweek-state and chip-valuation pass)

An external review of the live pages produced a batch of findings, and tracing
each one back through the code turned up a related family of faults. All of
them were of the same kind: an output that was not debatable but *impossible*.
The suites above now cover each one.

- **The app did not reliably know what time it was.** One variable,
  `is_current || is_next`, was answering three different questions — which
  gameweek is being PLAYED, which is being PICKED FOR, and which can be READ.
  They have different answers for most of any given week.
  `resolveGameweekState_` separates them and is now the only thing that
  decides. Three concrete bugs fell out of the conflation: a chip whose best
  week was the one you were picking for could never say "play now" (its value
  came from the decision-gameweek horizon and was compared against the live
  gameweek's id, so they never matched); the prose model was handed one
  gameweek number beside another gameweek's deadline and merged them into copy
  telling the manager that the week they were being asked to pick for had
  already locked; and FPL's own `is_current`/`is_next` flags lag the deadline
  they describe, so for the hours after a deadline passed the app would still
  advise on the gameweek that had just closed.

- **The self-grading loop was training on the wrong week.** This was the worst
  of them, because it was silent. Every projection snapshotted for grading was
  `xp.next`, and `xp.next` is the first gameweek of the *actionable* horizon —
  so once GW2's deadline passed, the snapshot filed under "GW2" held GW3's
  projections, and the grader scored them against GW2's actual results. That
  one-week mismatch fed straight into `buildCalibration_`, whose entire job is
  to correct the model from this data. The learned correction was fitted to
  noise. Advice and actuals are now recorded separately (`snapshotDecision_`
  and `recordActualLineup_`, filed against the gameweeks they each belong to)
  and joined at grading time; grades carry an `alignedProjections` marker, and
  the calibration reader discards any week without one rather than averaging
  the old, mis-stepped history back in.

- **Expected points read one match as a rate.** `form` is points per match
  over a rolling 30 days and `points_per_game` is points per match over the
  season. In October both average a decent run of matches; after GW1 they are
  the *same single match*, and `xpBaseRate_` weighted them as though they were
  established rates. A defender who returned 14 in the opening weekend came
  out at a base rate near 8.5 a week and held it across the whole horizon — a
  51-point six-gameweek projection for a £4.5m player. Observations are now
  shrunk toward a prior (FPL's own `ep_next` for that player, or a positional
  rate where it is missing) in proportion to how many matches back them. The
  same player now projects ~27 over six gameweeks.

- **And the rate was then held flat across the whole horizon.** Found on the
  live page after the shrinkage fix, and a genuinely separate fault: shrinking
  the observation controls how far the estimate moves off the prior, but the
  estimate was still applied *unchanged* to every gameweek, so a hot streak
  was projected to persist at full strength for six weeks and the error
  compounded linearly. The page showed 93.0 over six gameweeks for a defender
  who scored ~15 once — a flat 15.0/GW, i.e. "he will do that again, six
  times". The gap between observation and prior now decays with a
  four-gameweek half-life, and only where the two actually disagree: a player
  at his own baseline does not fade at all, an established premium keeps his
  level, and only the freak run regresses. Worth recording that this changed
  the *advice*, not just the display — on the end-to-end fixture the engine
  stopped recommending a −4 hit and dropped to a single free transfer, because
  the inflated horizon gains that justified the hit were the bug.

- **And that fix did not run for three days out of every seven.** Caught from
  a snapshot of the live page taken two minutes after the deploy: version
  stamp `PR #35`, De Cuyper still projecting 93.0, Wildcard now +434.8. The
  shrinkage keyed its "has the season started" test on `finishedGws`, and a
  gameweek IN PROGRESS has zero finished gameweeks — so all through the
  opening weekend it took the preseason branch and handed back the raw rate
  untouched. The suite missed it because every case set `finishedGws: 1`,
  i.e. the state *after* a gameweek ends, never during one.
  `loadSeasonContext_` now reports `startedGws` (deadline passed) alongside
  `finishedGws` (ratified), because the two answer different questions: form
  and points-per-game are populated from the first whistle, while anything
  derived from minutes needs completed gameweeks or it reads every player
  still to kick off as dropped. `test_shrinkage.cjs` now exercises a live
  gameweek explicitly.

- **Then the correction went too far the other way.** Reported from the live
  page after the fix landed: De Cuyper had vanished from the recommendations
  entirely and transfers that made sense before had changed. The squad view
  showed why — Haaland, £15.5m, projecting 3.4 a week, with Isak (£9.0m),
  Semenyo (£8.5m) and Mbeumo (£8.0m) all on the same form and all collapsing
  to the same number. `ep_next` is the prior wherever it exists and is
  per-player, so it carries quality; but it reads 0 for the whole pool early
  in a season, and the fallback was a flat positional constant. A £15.5m
  striker and a £4.5m bench forward shared a baseline, so once the shrinkage
  pulled everyone's single match toward it the whole board flattened, every
  transfer margin fell inside the noise, and the ranking became arbitrary.
  Fixing over-confidence by destroying the signal is not a fix. The fallback
  prior now scales the positional rate by how a player is priced against the
  median of players anyone would actually pick at his position — price being
  the one per-player estimate in bootstrap-static that a new season does not
  wipe — sub-linearly and bounded at both ends. Haaland goes back to 6.7,
  bench fodder to 2.4, and a 15-point opening weekend still separates a player
  from a cold one without projecting him at 93 over six gameweeks.

- **A flagged number was still being acted on.** The same snapshot showed the
  +434.8 Wildcard recommended on the front page as instruction six. The
  plausibility check had flagged it — but warnings were rendered only on the
  Debug page, which is the one place nobody reads before making a transfer.
  Flagging a figure in one place while acting on it in another is not a guard
  rail, so `buildActionList_` now withholds any chip whose valuation the model
  flagged. The chip board still shows the row and the number; what is withheld
  is the instruction to go and play it.

- **Both squad-rebuilding chips were valued against teams nobody could
  field.** Free Hit compared the best eleven *in the game* — no budget, no
  three-per-club — against whatever lineup happened to be set, and reported
  the difference as the chip's worth (the live page said 51.3). Neither side
  was a team the manager could have had, and the baseline was wrong in the
  other direction too, since reordering your own lineup is free. Wildcard
  summed all *fifteen* projections on each side, pricing four players who
  never take the pitch. Both now compare best-legal-XI against best-legal-XI,
  with the no-chip baseline being the best you could do without it.

- **The transfer accounting was being reconstructed, not read.** Several
  layers each restated the free-transfer count, the number of moves and the
  hits in their own words, and the worst of them was a language model handed
  prose and left to infer the numbers back out. It announced "two free
  transfers" on a week with one, directly above a plan charging −8 for three
  moves *because* there was only one. `buildTransferLedger_` counts once;
  everything downstream reads it, and the model is given the finished
  arithmetic and told to explain it rather than re-derive it.

Every one of these would have been caught by asserting things that must be
true of any answer the app is willing to publish, which is what
`checkModelInvariants_` now does before the front page is rendered — an XI of
eleven in a legal formation, no club over three, a captain who is actually in
the eleven, hits charged only beyond the free transfers, net gain following
from gross less hits, a horizon equal to the sum of its gameweeks, chip gains
that are the differences they claim to be, and advice only for a gameweek
whose deadline has not passed. A failure withholds the verdict rather than
letting confident prose sit on top of an impossible number.

Plausibility bounds (a Wildcard worth hundreds of points, a one-week Free Hit
worth fifty) are kept deliberately separate as *warnings*. They are heuristics
and heuristics have false positives — a genuinely poor squad early in a season
really can be worth forty points of rebuild — so they are reported on the
Debug page without blanking the front page.
