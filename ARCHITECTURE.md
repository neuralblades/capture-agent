# Capture Agent — Architecture

This document describes the system as it actually exists, verified against the codebase rather than any planning doc. It's meant to stay current — update it alongside major structural changes, not as a one-time snapshot.

## What this is

A Chrome extension + FastAPI backend that captures content from wherever you encounter it (X, LinkedIn, GitHub, RSS feeds, any webpage), classifies it (is this an opportunity? what category?), and surfaces it for action — resume matching and application autofill for jobs, and a growing set of category-appropriate actions for everything else. Not a jobs tool with extra categories bolted on — a general capture-and-triage layer that jobs happen to be the most built-out branch of.

## System diagram

```
┌───────────────────────────────┐        ┌───────────────────────────────────┐
│   CAPTURE (extension side)    │        │        BACKEND (FastAPI)          │
│                               │        │                                   │
│  content/  — X.com            │  msg   │  main.py — HTTP endpoints         │
│  content/linkedin.js          │───────▶│  llm_processor.py — extraction   │ 
│  content/github.js            │        │    orchestration                  │
│  content/generic_capture.js   │        │  providers/ — Claude/Groq adapter │
│    (Standard + Power Mode)    │        │  digest.py — ranked digest        │
│  background/context_menu.js   │        │  feed_poller.py — RSS (asyncio    │
│    (right-click selection)    │        │    background task, not a         │
│  feed_poller.py (backend,     │        │    content-script)                │
│    passive, not extension)    │        │  contact_extractor.py             │
│                               │        │  email_generator.py               │
└───────────────┬───────────────┘        │  database.py — SQLite             │
                │ REST (JSON)            └─────────────────┬─────────────────┘
                ▼                                          │
        POST /capture ─────────────────────────────────────┘
                                                             │
                                              ┌──────────────┴──────────────┐
                                              ▼                             ▼
                                     Anthropic (Claude)                  Groq
                                                                  (GPT-OSS 120B —
                                                                   see note below)

┌──────────────────────────────────────────────────────────────────────┐
│                    extension/sidepanel/ — UI                         │
│  Docked side panel (default) or full-tab dashboard (?mode=dashboard) │
│  sidepanel.js — fetch/filter/render, shared by both layouts          │
│  metrics.js — local funnel counters (chrome.storage.local)           │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│              extension/actions/ — JARVIS action handlers             │
│  form_filler.js / universal_autofill.js — synthetic DOM events       │
│  email_drafter.py — Claude cold-email drafting                       │
└──────────────────────────────────────────────────────────────────────┘
```

Module boundaries are typed JSON contracts (`extension/sidepanel/contracts.js`, `backend/models.py`), not shared runtime types — any module can be replaced without the others knowing.

## Data model

Everything funnels through one core object, `CapturedPost` → persisted as a `posts` row (`backend/models.py`, `backend/database.py`):

| Field | Purpose |
|---|---|
| `platform` | Source: `twitter`, `linkedin`, `github`, `rss`, `web_selection`, or a Power-Mode hostname |
| `content`, `author`, `url` | Raw captured material |
| `image_url` | Optional — og:image or media thumbnail, degrades to null gracefully |
| `category` | Open-ended, LLM-assigned, self-consolidating (existing categories are fed back into the extraction prompt to prevent drift — see Known decisions) |
| `is_opportunity` | Boolean — gates match scoring and the Apply/Open Form action. Job-bot-sourced items (when that integration lands) would set this directly rather than asking the LLM to guess |
| `match_score` | 0–100, only computed when `is_opportunity` is true |
| `status`, `notes`, `resurface_at` | Generic per-item state — not job-specific. `status="applied"` replaced the old client-only "Mark as Applied" tracking entirely |
| `posted_at`, `captured_at` | Timestamps |

The principle behind this shape: the core data model doesn't know what a "job" or a "book" is. Type-specific behavior (match scoring, autofill) attaches conditionally on top of generic fields (`is_opportunity`, `category`), rather than the schema branching per content type.

## Capture sources

| Source | Mechanism | Notes |
|---|---|---|
| X.com | Content script, `MutationObserver` | Original implementation |
| LinkedIn | Content script | Separate file, own selector-durability comments |
| GitHub | Content script, floating button | Repo README + description; org capture also shipped (was originally out-of-scope — see Known decisions) |
| RSS | **Backend** asyncio task (`feed_poller.py`), not a content script | The one passive/always-on source — polls independent of the browser being open. Feed's own label persists via `author`, not a separate field |
| Generic web (Standard Mode) | One-shot `activeTab` script, no standing permission | Right-click, toolbar icon, or keyboard shortcut |
| Generic web (Power Mode) | Persistent floating button on any page | Opt-in via `optional_host_permissions` (`<all_urls>`), requested at runtime — not granted at install |

## API surface (`backend/main.py`)

`POST /capture` · `GET/PATCH/DELETE /posts` · `GET /categories` · `POST /calculate-match` · `POST /generate-form-answer` · `POST /map-form-fields` · `POST /generate-email` · `GET/POST/DELETE /feeds` · `GET /stats/overview` · `GET /stats/applied-count` · `GET /stats/captures-count` · `GET /digest` · `GET /digest.pdf` · `GET /health`

## UI surfaces

- **Docked side panel** (default): SaaS-styled (indigo accent, neutral surfaces, sans-serif) — platform/category tabs above one list.
- **Full-tab dashboard** (`?mode=dashboard`): same JS/data layer, sidebar navigation instead of stacked tabs. Requires an *external* mode-detection script (`dashboard-mode-init.js`) — MV3's CSP blocks inline `<script>` outright, no `unsafe-inline` escape hatch exists for extension pages.
- **Overview**: SaaS-styled (was newspaper-themed briefly, reverted — see Known decisions), collapsible category/platform breakdowns instead of a flat bar-per-category list, time-scoped stats.
- **Digest** (`GET /digest`, `/digest.pdf`): the one place the newspaper aesthetic (Playfair Display/Lora, cream/ink palette, dark-overlay hero images) actually lives — a generated, ranked, print-styled artifact, deliberately different from the daily-use app chrome. Ranking is an explicit, documented formula (recency decay + match score + deadline proximity), not an LLM judgment call. Rendered via WeasyPrint (pure Python, real CSS print support) — no headless-browser dependency.

## Known architectural decisions worth preserving

- **RSS is backend-driven, not extension-driven, on purpose.** Service workers have no `DOMParser`; XML parsing belongs in Python (`feedparser`).
- **Two visual languages, deliberately.** SaaS style for anything triaged repeatedly and fast (Inbox/RSS/GitHub/Jobs/Overview); newspaper style only for the digest, which is read occasionally and can afford ceremony. Not a toggle — the tradeoff (speed vs. character) was resolved per-screen, not left open.
- **`is_opportunity` and `status` are separate from `category`.** Category is open-ended and for browsing; the other two drive actual behavior (scoring, actions, filtering). Keeping them distinct is what let match-scoring and autofill generalize without forcing every category into a fixed taxonomy.
- **GitHub org capture shipped outside its issue's stated scope.** Noted here deliberately: the code is solid, but it's an example of scope drift worth watching for, not an endorsement of skipping issue boundaries.
- **Groq model dependency risk is real, not hypothetical.** `llama-3.3-70b-versatile` was decommissioned mid-project; the codebase now runs on `openai/gpt-oss-120b`. Same API surface, but a reminder that external model availability isn't guaranteed to be stable — worth a quick check if extraction quality ever seems off.

## Known gaps (as of this writing)

- No deployment/hosting exists. Everything — including the "passive" RSS poller — only runs while `uvicorn` is running locally.
- No archive/multi-select yet (in progress).
- RSS is not yet isolated from the default Inbox view (in progress) — currently unions with manually captured platforms in the "All" filter.
- Date filtering is Today/Yesterday/Last week only, no all-time default or custom range (in progress).
- Category cleanup for pre-normalization-fix data was scoped but not yet done — prevention (existing-category-aware prompting) landed, the one-time migration for already-messy historical categories did not.

## Development workflow

Built via Agent Orchestrator (AO) — Claude Code sessions in isolated git worktrees, one per GitHub issue, each scoped to a specific module boundary declared informally through issue descriptions (no longer a single static `CLAUDE.md` module list — the project outgrew that early pattern as sections multiplied). Convention: verify against actual source before scoping new work, not against prior planning docs — this document included; if it drifts from the code, the code is correct.