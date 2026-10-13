# FPL Command Center

## Design is not optional

All UI work in this repo follows `DESIGN.md` and uses the tokens in `broadsheet.css`.
Read both before writing any markup or CSS.

Rules that override any default instinct:

- **Never hard-code a hex, font name, or spacing value.** Use `var(--color-*)`,
  `var(--font-*)`, `var(--space-*)`, `var(--radius-*)` from `broadsheet.css`.
- **One typeface: Source Serif 4.** No sans-serif anywhere, including UI chrome,
  buttons, labels, and tables.
- **No cards, panels, boxes, or borders for layout.** Sections are separated by
  whitespace and hairline rules only. The only heavy rules are the masthead's
  7px/2px pair.
- **Two accents, used like spot colour.** Cyan `--color-accent` for interactive
  elements and positive figures; magenta `--color-accent-2` rarely, for urgency.
  Never both in the same small component.
- **No red/green traffic lights.** Fixture difficulty uses the single-hue scale
  defined in `DESIGN.md`.
- **No emoji. No gradients. No decorative icons.** Phosphor duotone only if an
  icon is genuinely required.
- **Radius 2px maximum.**
- **Every recommendation states a decision in plain language first**, with the
  arithmetic underneath. Never a wall of stats.

## Layout

Flex/grid with `gap` only — never margins between siblings. Max width 1360px,
28px page padding. Multi-column sections collapse with
`repeat(auto-fit, minmax(<min>, 1fr))`. Mobile keeps the same section order; the
fixture grid scrolls horizontally at a 640px minimum width.

## Accessibility

`:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }`
on every interactive element. Accent at body-text size uses `--color-accent-700`.

## Data

Live from the official FPL API. Browsers are CORS-blocked, so all API calls go
through the server (Apps Script `Code.js` today). Any client build must call our
own endpoint, never `fantasy.premierleague.com` directly.
