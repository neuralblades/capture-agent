# Capture Agent

A Manifest V3 Chrome extension that captures posts from X.com (Twitter) with one click, runs them through an LLM to pull out summaries, tags, and deadlines, and surfaces the result in a side panel dashboard with one-click follow-up actions (fill a form, draft a reply email, open the source).

## Overview

Browsing X.com surfaces things worth acting on — a scholarship deadline, a book recommendation, a study-plan thread — that are easy to lose in the scroll. Capture Agent adds a capture button to every tweet's action bar. Clicking it extracts the tweet's text, author, and media client-side and sends it to a FastAPI backend, which asks an LLM (Claude or Groq) to produce a structured record: a one-sentence summary, topical tags, `action_required`, and any deadlines with their relative phrasing ("by next Friday") resolved to absolute ISO 8601 dates. Extracted items land in the extension's side panel, grouped by type (Deadlines / Books / Study Plans), where JARVIS actions can act on them — filling a web form or drafting a cold email — without leaving the page.

## Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────┐
│         x.com / DOM          │        │   Extension Side Panel    │
│  ┌─────────────────────────┐ │        │  extension/sidepanel/     │
│  │  extension/content/      │ │        │  sidepanel.html/.js/.css  │
│  │  observer → extract      │ │  msg   │  ┌──────────────────┐    │
│  │  → injector (capture btn)│─┼───────▶│  │ background.js SW │    │
│  │  → messaging.js          │ │        │  │ (message router) │    │
│  └─────────────────────────┘ │        │  └─────────┬────────┘    │
└─────────────────────────────┘        └────────────┼─────────────┘
                                                       │ REST (JSON)
                                                       ▼
                                        ┌──────────────────────────┐
                                        │      backend/ (FastAPI)   │
                                        │  main.py → llm_processor  │
                                        │  → providers/ (adapter)   │
                                        │  → database.py (SQLite)   │
                                        └─────────────┬─────────────┘
                                                       │
                                          ┌────────────┴────────────┐
                                          ▼                         ▼
                                   Anthropic (Claude)          Groq

                    ┌───────────────────────────────────────┐
                    │      extension/actions/ (JARVIS)        │
                    │  form_filler.js   — DOM form fill        │
                    │  email_drafter.py — Claude cold email    │
                    │  invoked by the side panel via typed     │
                    │  JSON request/response contracts         │
                    └───────────────────────────────────────┘
```

Every arrow between modules is a **typed JSON contract**, not a shared runtime — the content script, side panel, backend, and JARVIS actions each define their own request/response shapes (`extension/sidepanel/contracts.js`, `backend/models.py`, the schemas documented in `extension/actions/README.md`) so any module can be replaced without the others knowing it happened.

## Components

### `extension/content/` — Extension Core
Content script injected into `x.com` / `twitter.com` tweet pages.
- `observer.js` — watches the DOM for newly rendered tweet cards.
- `selectors.js` — centralizes the (fragile, X.com-specific) CSS selectors so UI changes upstream only require edits here.
- `extract.js` — reads a tweet `<article>` into a `CaptureTweetPayload` (author, text, timestamp, media), explicitly excluding nested quote-tweet cards.
- `injector.js` — injects a capture button into each tweet's action bar and drives its idle/loading/success/error state.
- `messaging.js` — wraps `chrome.runtime.sendMessage` to hand the payload to the background service worker.
- `types.js` — shared JSDoc payload/message typedefs for this module.
- Owns `manifest.json` (Manifest V3: service-worker background, `activeTab` + host permissions scoped to `x.com`/`twitter.com`, no `unsafe-eval`).

### `extension/sidepanel/` — Dashboard UI
The extension's side panel, where captured items are triaged.
- `sidepanel.html` / `sidepanel.css` — panel markup and styling.
- `sidepanel.js` — renders tabbed, searchable item cards from `GET_ITEMS`, dispatches `RUN_ACTION` requests, and listens for `ITEMS_UPDATED` pushes. Falls back to sample data when run outside an extension runtime (e.g. previewing the HTML directly).
- `contracts.js` — the typed JSON contracts (`CapturedItem`, message types, action types) other modules import to stay in sync without hand-typing string literals.

### `backend/` — AI Backend
FastAPI service that turns raw captured text into structured, actionable data.
- `main.py` — `POST /capture` (extract + persist), `GET /posts`, `GET /posts/{id}`, `GET /health`. CORS is restricted to `chrome-extension://` origins by regex, since `/capture` is unauthenticated and triggers a paid LLM call.
- `llm_processor.py` — resolves a reference date and delegates extraction to the configured provider.
- `providers/` — adapter pattern over LLM backends (`base.py` defines the `LLMProvider` interface and shared system prompt; `anthropic_provider.py` and `groq_provider.py` implement it). Selected at runtime via the `LLM_PROVIDER` env var and cached per-process.
- `models.py` — Pydantic contracts (`CapturedPost`, `ExtractionResult`, `Deadline`, `PostRecord`) shared with the extension's JSON shape.
- `database.py` — SQLite persistence (`capture_agent.db`), one `posts` row per captured item with JSON-encoded `tags`/`deadlines`.
- `tests/` — pytest suite (provider adapters, extraction, DB, API), run in CI via `.github/workflows/backend-tests.yml`.

### `extension/actions/` — JARVIS Actions
Action handlers invoked from the side panel by item type, each speaking a typed JSON request/response contract so they're callable from any module regardless of language.
- `form_filler.js` — content script; fills form fields via synthetic DOM events (so framework-tracked inputs, not just raw `.value`, observe the change) in response to a `FILL_FORM` message.
- `email_drafter.py` — subprocess that drafts a cold email via the Claude API, reading an `EmailDraftRequest` JSON document from stdin and writing an `EmailDraftResult` to stdout.
- See `extension/actions/README.md` for the full request/response schemas.

## Tech Stack

| Layer | Technology |
|---|---|
| Extension | Manifest V3, vanilla JS (no build step / bundler), Chrome `chrome.runtime` messaging API |
| Backend | Python 3.12, FastAPI, Uvicorn, Pydantic v2 |
| LLM providers | Anthropic (Claude), Groq — pluggable via an adapter interface and `LLM_PROVIDER` |
| Persistence | SQLite (`sqlite3`, stdlib) |
| Testing | pytest (`backend/tests/`), GitHub Actions CI on `backend/**` changes |
| Config | `python-dotenv` (`backend/.env.example`) |

## AO Multi-Agent Workflow

This project was built by parallel AO sessions, each owning a disjoint module boundary declared in `CLAUDE.md` so concurrent sessions never touch the same files:

| Session | Owns | Delivered |
|---|---|---|
| Extension Core | `extension/content/`, `manifest.json` | X.com content script + DOM observer (PR #6) |
| Dashboard UI | `extension/sidepanel/` | Side panel dashboard UI (PR #8) |
| AI Backend | `backend/` | FastAPI + Claude extraction backend (PR #5), later refactored to a provider adapter pattern adding Groq support (PR #10) |
| JARVIS Actions | `extension/actions/` | `form_filler.js` + `email_drafter.py` (PR #7) |

Because every cross-module boundary is a typed JSON contract (see [Architecture](#architecture)) rather than shared in-process types, each session could implement and land its module independently — the merges above landed as separate PRs against `main` with no merge conflicts between sessions. Follow-up hardening (CORS restriction, SQLite connection cleanup, quote-tweet scoping, JARVIS input validation, the pytest suite + CI) was likewise done as small, targeted fixes on top of the merged modules.

## Quick Start

### Prerequisites
- Google Chrome (or another Manifest V3-compatible Chromium browser)
- Python 3.12+
- An API key for at least one LLM provider: [Anthropic](https://console.anthropic.com/) and/or [Groq](https://console.groq.com/)

### 1. Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate            # Windows; use `source .venv/bin/activate` on macOS/Linux
pip install -r requirements.txt

cp .env.example .env              # then fill in ANTHROPIC_API_KEY / GROQ_API_KEY and set LLM_PROVIDER

uvicorn main:app --reload --port 8000
```

Verify it's up: `curl http://localhost:8000/health` → `{"status": "ok"}`.

### 2. Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the repository root (where `manifest.json` lives).
4. Open a tweet on `x.com`, click the capture icon in its action bar, then open the extension's side panel to see the extracted item.

### 3. Run the backend tests (optional)

```bash
cd backend
pip install -r requirements-dev.txt
pytest -v
```

## Repository Layout

```
capture-agent/
├── manifest.json                 # MV3 manifest (Extension Core)
├── extension/
│   ├── background/                # Service worker: message routing
│   ├── content/                   # Extension Core: tweet capture on x.com
│   ├── sidepanel/                 # Dashboard UI
│   └── actions/                   # JARVIS Actions: form fill, email draft
└── backend/                       # AI Backend: FastAPI + LLM extraction + SQLite
    ├── providers/                  # LLM adapter pattern (Anthropic, Groq)
    └── tests/
```
