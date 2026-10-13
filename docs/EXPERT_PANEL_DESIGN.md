# "The Panel" — expert YouTube analysis section

Design brief for ingesting 2-3 FPL YouTube channels and surfacing their recommendations as a new broadsheet section. Hand this to Claude Code alongside `PRESEASON_DATA_SOURCES.md`.

## The short answer

Yes, both Gemini and Claude have a role here, but a different one each — they're not competing for the same job:

- **Gemini watches the video.** The Gemini API can take a public YouTube URL directly (no download, no transcript scraping) and answer questions about it — verified this is a real, currently-free (preview) capability. This is the only one of the two that can actually "watch" a video; Claude has no video-input capability, so it needs a transcript or summary handed to it first.
- **Claude writes the column.** Feed Gemini's raw extraction into Claude (reusing the Anthropic key your app already has) to normalize it into the exact structured shape and newspaper voice the rest of the dashboard uses, and to cross-reference it against your own squad/algorithm's picks ("agrees with the Ruling" / "differs — Command Centre says X").

So: Gemini for ingestion, Claude for synthesis. Two API keys, two very different jobs, each doing what it's actually good at.

## Data flow

```
1. YouTube Data API (channels.list, playlistItems.list)
      → cheap polling: "has channel X posted a new video since I last checked?"
2. New video found
      → Gemini API, given the YouTube URL directly
      → prompt: "Extract every FPL recommendation in this video: transfers in/out,
         captain/vice picks, differentials, chip timing advice. Cite player names
         and the reasoning given. Note the video's overall stance/confidence."
3. Gemini's raw extraction
      → Claude, given Gemini's output + your live squad/ruling data (same
         buildAiContext_ pattern already in Code.js)
      → prompt: "Rewrite as 2-3 newspaper-style sentences per pick. Flag whether
         each pick agrees or differs from our own Ruling/Transfer suggestions."
4. Structured result cached (PropertiesService or a Sheet — see below)
5. getDashboardData() returns the last N cached takes, one per channel
6. New "The Panel" section renders them
```

## Why polling with the YouTube Data API, not scraping

- `channels.list` (1 quota unit) resolves a channel handle to its "uploads" playlist ID — do this once per channel and cache it.
- `playlistItems.list` (1 quota unit) returns the latest few videos in that playlist. Checking 2-3 channels a few times a day costs single-digit quota units against a 10,000/day free allowance — not remotely close to a limit.
- This is the official, sanctioned way to know "is there a new video" — no scraping needed for this part.
- Needs its own free API key from Google Cloud Console (separate from the Gemini key, same Google account can hold both).

## Setup requirements

Two new secrets, same `PropertiesService` pattern as the existing `ANTHROPIC_API_KEY`:

- `YOUTUBE_API_KEY` — free, from Google Cloud Console (enable "YouTube Data API v3" on a project).
- `GEMINI_API_KEY` — free, from Google AI Studio. Separate account/product from Anthropic's console, even though both are "Claude vs Gemini" AI providers — this is a real second key to generate and store, not optional.
- The 2-3 channel names/handles/IDs you want to track — a small config list, not something to auto-discover.

## Trigger design

Add a third weekly-ish job alongside the existing `checkAndSendReminder`/`weeklyVerdictCycle` pair (same `installWeeklyTrigger()` pattern):

- `checkExpertVideos_()` — runs every few hours (cheap enough to run often given the quota cost above), loops the configured channels, compares the latest video ID against a `LAST_SEEN_VIDEO_<channelId>` property, and only calls Gemini/Claude when something's actually new. This keeps the Gemini/Claude cost to roughly one call-pair per channel per video, not per trigger run.
- Store each channel's latest processed take, keyed by channel, so the section always shows "their most recent take" even between videos.

## Storage: PropertiesService vs a Sheet

- PropertiesService works fine at 2-3 channels (a handful of small JSON blobs, well under the 9KB/property and 500KB/project caps) — no new moving part, consistent with how `RULING_<eventId>` and `GRADE_<eventId>` already work.
- If this grows past a handful of channels, or you want a browsable history instead of just "latest per channel," a Google Sheet (the project's already Workspace-native) is the natural upgrade — one row per processed video, easy to eyeball/debug without opening the Apps Script property editor. Not needed to start.

## The new section: "The Panel"

Fits as a 9th broadsheet section, styled like syndicated opinion columns — consistent with the existing no-cards/no-logos/hairline-rule system:

- **Kicker**: `THE PANEL` (same small-caps treatment as other section kickers)
- One entry per tracked channel, most recent take only, separated by hairline rules (same `.rec-row` pattern as Transfers)
- Each entry: channel name as a byline (e.g. "— FPL Focal, posted 2 days ago"), a one-line pull-quote-style headline Claude wrote, 2-3 sentences of the actual recommendation, then a small line of pills — one per pick — each reading either "Agrees with the Ruling" (cyan, matches the app's own accent-for-agreement convention already used elsewhere) or "Differs — we say Isak" (magenta, matches the existing urgency/divergence convention)
- A plain text link to the source video ("Watch on YouTube →") — link out, don't embed or rehost, both simpler and cleaner on attribution
- No thumbnails, no channel logos, no embedded player — keeps it inside the "no decorative icons, no images" rule in `CLAUDE.md` and reads as text-first, same as everything else on the page

## Worth flagging before building

- **This republishes AI-derived summaries of other creators' opinions.** For a single-user personal dashboard the risk is low, but the safe pattern regardless is: summarize + link out, don't reproduce large chunks of transcript, and credit the channel by name in the UI (already part of the design above). Don't rehost their video or auto-quote long verbatim passages.
- **Gemini's YouTube-URL feature is explicitly "preview" pricing** (currently free) per Google's own docs — worth a quick check-in every so often that it hasn't moved to paid, since that's outside your control.
- **Coverage will be uneven, same as the friendlies data** — not every video will yield clean, extractable picks (some are more "reaction content" than structured recommendations). Same defensive pattern as the rest of Code.js: wrap in `safeCall_`, degrade to "no fresh take this week" rather than showing something malformed.

## Open questions for you

1. Which 2-3 channels? (Handle or channel URL is enough — Claude Code can resolve the uploads playlist ID from that.)
2. How often should it check for new videos — a few times a day, or just once around each gameweek deadline? (Affects nothing cost-wise given the quota headroom, purely a "how fresh does this need to be" call.)
3. Comfortable creating a Gemini API key (Google AI Studio) as a second AI provider alongside the existing Anthropic one, or would you rather explore a transcript-only approach that stays Claude-only? (The transcript-only path exists but leans on unofficial/ToS-gray scraping methods for third-party videos, since there's no official transcript-download API for videos you don't own — Gemini's native path is the cleaner one.)
