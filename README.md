# FPL Command Center

A personal decision engine for Fantasy Premier League. Before each deadline it
answers the questions a manager actually has (who to sell, who to buy, which
eleven, which captain, whether to play a chip) and prices every answer in
expected points, with the working underneath for when you disagree.

Built by a product manager with [Claude Code](https://claude.com/claude-code),
mostly from a phone, over the first weeks of the 2026-27 season.

## What it does

- **The front page.** A verdict first, then a numbered "do now" list, then the
  evidence. Every move carries its value in points and the window it covers.
- **Transfers that know your squad.** Gains are measured as the change in the
  best eleven you could field, not player against player. A −4 hit is only
  recommended when waiting a week for a free transfer would cost more.
- **Transfers FPL hasn't shown yet.** FPL only reveals a transfer after the
  deadline, so moves can be logged in the app and the whole plan is redone for
  the squad you actually hold.
- **Captaincy by simulation.** Each candidate's scoring shape comes from his
  match log; candidates are simulated against your mini-league's captains and
  ranked on rank movement, not just mean points.
- **Risk against your league.** Effective ownership is computed exactly over
  your mini-league, so the page shows where you are exposed and where you are
  differentiated.
- **Player comparison.** Any players side by side, with both models' numbers
  and the component breakdown behind them.
- **An assistant with tools.** A Claude tool loop with seven coarse tools
  (player history, comparisons, search, team form, your season, your league,
  recording a transfer). Every lookup is shown above the answer.
- **The Wire.** Gemini reads selected FPL YouTube videos and extracts the
  picks; Claude summarises where the pundits agree or disagree with the app.
  Agreement across channels feeds the score as a small, capped signal.
- **A track record.** Advice is snapshotted before each deadline and graded
  afterwards, including the captain call against a random-pick baseline.

## The model

Every recommendation runs on one number: **expected points (xP)** per player
per gameweek, over a six-gameweek horizon.

- **v1, points trend.** Form and points per game, shrunk toward a prior set by
  price and position so one good match cannot pass for a rate, with the form
  edge decaying across the horizon.
- **v2, components.** Rebuilt from FPL's scoring rules: expected goals for and
  against, the player's share of his team's chances, clean sheets, saves,
  defensive contributions, bonus and minutes, fixture by fixture.
- **Live: a 50/50 blend.** Chosen on held-out gameweeks; the choice and the
  evidence for it are written down in [`docs/TECHNICAL.md`](docs/TECHNICAL.md).

Some checks need no model at all. Before any recommendation is shown, the page
asserts what must be true of every answer: 11 players in a legal formation, at
most three per club, captain in the eleven, hits only beyond free transfers,
bank never below zero. A failure withholds the verdict and names the check.

## How it is evaluated

A GitHub Actions workflow ([`model-eval.yml`](.github/workflows/model-eval.yml))
can be started from a phone (the private deployment also runs it every six hours):

1. [`eval/fetch.cjs`](eval/fetch.cjs) pulls the official FPL data, and saves
   every player's state **before each deadline**, because the API only ever
   serves "now".
2. [`eval/backtest.cjs`](eval/backtest.cjs) loads the real `Code.js`, replays
   each finished gameweek and scores the forecasts against what happened, and
   against four baselines a manager could have read before the deadline: FPL's
   own projection, form, points per appearance and the last-three average.
3. It reports average error, **rank correlation within position** (what every
   decision depends on), top-ten picks promised against delivered (the
   optimiser's curse, measured directly), calibration by position and price,
   and how the forecast decays with distance. Tuning is chosen on some
   gameweeks and judged on one it never saw; nothing ships on an in-sample win.

First week scored on forecasts frozen before the deadline (Gameweek 6, 2026-27,
414 players):

| Predictor | Avg error | Rank corr. | Top-10 picks scored |
|---|---:|---:|---:|
| This model (50% blend) | **1.63** | 0.53 | 4.00 |
| FPL's own projection | 1.81 | **0.57** | **4.28** |
| Form | 1.93 | 0.48 | 3.58 |
| Points per appearance | 2.11 | 0.40 | 3.48 |

Closest to actual points, and best on injury-flagged players; FPL's projection
ranked in-form players better that week. One week, so it is a signal, not a
verdict.

## How it runs

A **Google Apps Script** web app: free hosting, secret storage and scheduled
triggers with no server to run. Browsers cannot call the FPL API directly
(CORS), so every request goes through the server.

| File | Role |
|---|---|
| `Code.js` | Server: FPL API and caching, both xP models, transfers, lineup, captaincy, chips, ownership, the assistant, grading |
| `Index.html` | The dashboard |
| `Ratings.html` | Player ratings and head-to-head comparison |
| `Wire.html` | The Wire: expert-video consensus and diagnostics |
| `Debug.html` | Load timings, invariants and model health |
| `eval/` | The offline backtest (Node) |
| `test/` | 23 Node suites for everything that is pure computation |

AI models are routed by job: Claude Opus for the assistant, Claude Haiku for
short copy, Gemini for reading videos. Keys are entered in the app and stored in
Apps Script's `PropertiesService`, never in the repository.

## Running it

```bash
node test/run.cjs                       # all test suites
node eval/fetch.cjs eval/data           # pull FPL data (needs network access to the FPL API)
node eval/backtest.cjs eval/data --tune # score the model and write a report
```

To host your own copy, create an Apps Script project, add a `.clasp.json`
pointing at it, and `clasp push`. Test and eval files are `.cjs` on purpose:
`clasp` uploads any `.js` it finds, and these must never ship.

## Docs

- [`docs/TECHNICAL.md`](docs/TECHNICAL.md): the full design record, section by
  section, including what went wrong and why each decision was made.
- [`docs/DESIGN.md`](docs/DESIGN.md) and [`docs/broadsheet.css`](docs/broadsheet.css):
  the broadsheet design system the UI follows.
- [`docs/EXPERT_PANEL_DESIGN.md`](docs/EXPERT_PANEL_DESIGN.md): the brief for
  The Wire.
- [`docs/CLAUDE.md`](docs/CLAUDE.md): the standing instructions given to Claude
  Code for UI work.

Not affiliated with the Premier League or Fantasy Premier League. Data comes
from the public FPL API.
