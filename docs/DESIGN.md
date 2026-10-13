# FPL Command Centre — design spec

Two parts: a **prompt-style brief** you can paste whole into another tool, and a **token + component spec** for anyone implementing it.

---

## Part 1 — Prompt-style brief (paste this)

> Build a single-page Fantasy Premier League "command centre" dashboard for one manager (any FPL team ID). It reads live from the official FPL API (`fantasy.premierleague.com/api`: `bootstrap-static`, `fixtures`, `entry/{id}`, `entry/{id}/event/{gw}/picks`, `entry/{id}/history`, `leagues-classic/{id}/standings`) — browsers are CORS-blocked, so proxy the calls server-side and fall back to worked sample data if unreachable.
>
> **Tone: it decides.** Every panel states a recommendation in plain language and shows the arithmetic underneath — never a wall of stats for the user to interpret. Headlines read like a verdict: "Wissa out, Isak in. Captain Salah. No chip."
>
> **Visual direction: newsprint broadsheet.** Source Serif 4 throughout (headings and body — no sans-serif anywhere, the serif is the UI chrome). Paper-white ground `#f3f2f2`, near-black ink `#201e1d`. Two spot colours used sparingly like process inks: cyan `#0088b0` for interactive elements and positive numbers, magenta `#d6006c` for the rarer second accent (urgency, "IN" labels, countdowns). Left-aligned, asymmetric, generous whitespace. **No boxes, no cards, no dividers between sections** — hierarchy comes from type scale and negative space alone. The only rules that print are the masthead's thick (7px) / thin (2px) pair around the dateline rail, and 1px hairlines between rows in lists. Radius 2px maximum. No gradients, no shadows except on genuinely floating elements.
>
> **Sections, in order:**
> 1. **Masthead** — "The Command Centre", thick rule above, thin rule below, dateline rail carrying: gameweek number, deadline timestamp, a live ticking countdown in magenta, a data-source tag (Live / Sample), and a team-ID input with a refresh button. Right-aligned: squad name, manager, overall rank, team value, in-the-bank.
> 2. **The Ruling** — the week's verdict as a large serif headline (max 22ch), a supporting paragraph, then three flush-left columns: *Do this transfer*, *Captain*, *Chips*.
> 3. **Transfers** — ranked list, each row: OUT (name, club, price, why) above IN (name, club, price, why), with a large cyan projected-points-gain figure, a confidence tag, and the cost line ("Free transfer · £0.4m from bank"). Hairline between rows.
> 4. **Chip strategy** — five columns (Wildcard 1, Bench Boost, Triple Captain, Free Hit, Wildcard 2), each with a status pill (Hold / Play now / Used / target GW) and a one-sentence rationale tied to the user's own clubs' doubles and blanks.
> 5. **Next six gameweeks** — fixture difficulty grid, rows = the user's clubs only, columns = GW2–GW7, cell shows the opponent short code (`@` prefix for away). Single-hue scale, light cyan for easy through mid grey for hard — never red/green.
> 6. **Price watch** and **Injury & rotation risk** — two columns of hairline-separated rows. Price deltas in cyan (rise) / magenta (fall). Risk rows carry a small uppercase pill.
> 7. **Mini-league table** — the user's own row tinted cyan-100.
> 8. **Why this beats the way you play now** — closing section under a repeated thick/thin rule pair. Four big cyan stat figures (+14.1% backtested, 60% net-positive transfers, 30s vs an evening, weekly self-grading), then a comparison table: *Official site / YouTube+Reddit / Your spreadsheet / Command Centre* across six jobs (who to transfer, when to chip, captain, price moves, injury risk, was it right?). Close with an honest caveat in small grey type: captain-pick accuracy was only 5.3% in backtesting, so the captain panel is a shortlist, not a promise.
>
> **Responsive:** desktop is a 1360px max-width single column with multi-column sections collapsing via `repeat(auto-fit, minmax(…, 1fr))`. Mobile keeps the same order; the fixture grid scrolls horizontally at a 640px minimum width.
>
> **Controls:** three settings only — team ID, risk appetite (Safe / Balanced / Aggressive, which changes the transfer threshold and biases the captain pick toward or away from high-ownership players), and a toggle for the comparison section.

---

## Part 2 — Token + component spec

### Colour

| Token | Value | Use |
| --- | --- | --- |
| `--color-bg` | `#f3f2f2` | Page ground, everywhere |
| `--color-text` | `#201e1d` | All body and heading ink |
| `--color-accent` | `#0088b0` | Interactive, positive figures |
| `--color-accent-700` | `#006786` | Accent at body-text size (contrast) |
| `--color-accent-2-700` | `#aa0b56` | Urgency, countdown, "IN", price falls |
| `--color-neutral-600` | `#7d7979` | Secondary metadata |
| `--color-neutral-700` | `#605d5d` | Kickers, labels |
| `--color-neutral-800` | `#444141` | Supporting body copy |
| `--color-neutral-300` | `#d7d3d3` | Hairline rules |
| `--color-accent-100` | `#e9f8ff` | Row highlight (your league row) |

Fixture-difficulty scale (single hue, light → dark): FDR 2 `#cbeeff` on `#004961` · FDR 3 `#f8f4f4` on `#444141` · FDR 4 `#d7d3d3` on `#2d2b2b` · FDR 5 `#7d7979` on `#f8f4f4`.

### Type

Source Serif 4, one family for everything.

| Role | Size | Weight |
| --- | --- | --- |
| Masthead | `clamp(38px, 6vw, 72px)` / 0.95 / `-0.02em` | 700 |
| Ruling headline | `clamp(28px, 3.4vw, 44px)` / 1.12 | 600 |
| Section heading | 30px | 600 |
| Lede paragraph | 18px / 1.55, max 62ch | 400 |
| Row title | 22px | 600 |
| Body | 15px / 1.5 | 400 |
| Metadata | 13–14px | 400 |
| Kicker | 11px, `letter-spacing: .28em`, uppercase | 700 |
| Big stat | 38–44px / 1 | 700 |

`text-wrap: pretty` on all prose. Measure never exceeds 64ch.

### Spacing & structure

5 / 10 / 15 / 20 / 30 / 40px scale. Section gap 64px, closing section 80px. Page padding 28px, max width 1360px. Radius: 2px on pills and grid cells, 0 everywhere else. Layout is flex/grid with `gap` only — never margins between siblings.

### Components

- **Rule pair** — `div` 7px solid ink, content, `div` 2px solid ink. Used twice: masthead and the closing section.
- **Dateline rail** — flex row, 13px, `space-between`, wraps on mobile; countdown animates opacity 1 → .35 → 1 over 2.4s.
- **Verdict column** — kicker / 26px 600 answer / 15px reason. Three across, collapse at 260px.
- **Recommendation row** — grid `minmax(0,1fr) auto`, 22px padding block, 1px top hairline. Right rail: big cyan figure, uppercase caption, confidence tag, cost line.
- **Status pill** — inline-block, 3px 9px, 12px, `.14em` uppercase 700. Tones: hot `#ffdee6`/`#790e3d`, cool `#e9f8ff`/`#004961`, warm `#f8f4f4`/`#605d5d`.
- **Fixture grid** — `grid-template-columns: 120px repeat(6, 1fr)`, 4px gap, 9px cell padding, centred 13px 600.
- **Table** — no vertical rules, 1px horizontal hairlines, uppercase header in `--color-neutral-700`.
- **Focus** — `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }` on every interactive element. Hover states one ramp step darker.

### Don't

- No cards, panels, boxed containers, or coloured section backgrounds.
- No sans-serif, no second typeface.
- Never both accents in one small component.
- No red/green traffic lights for difficulty — single-hue only.
- No emoji, no icon-heavy chrome (Phosphor duotone only if icons are genuinely needed).
