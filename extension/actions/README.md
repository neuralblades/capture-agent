# JARVIS Actions

Action handlers invoked by the JARVIS orchestration layer. Each action
communicates over a typed JSON contract so it can be called from any other
module without sharing language-specific types.

## form_filler.js

Content script. Fills form fields by dispatching synthetic DOM events
(`input`, `change`, or `click` as appropriate) so frameworks that track
input via their own value trackers — not just the raw `.value` property —
still observe the change. Listens for a `chrome.runtime` message with
`action: "FILL_FORM"`.

**Request** (`FormFillRequest`):

```json
{
  "fields": [
    { "selector": "#email", "value": "jane@example.com", "type": "text" },
    { "selector": "#subscribe", "value": "true", "type": "checkbox" }
  ]
}
```

`type` is one of `text | textarea | select | checkbox | radio`; it's
inferred from the matched element when omitted.

**Response** (`FormFillResult`):

```json
{ "success": true, "filled": 2, "errors": [] }
```

On a partial failure, `success` is `false` and `errors` lists
`{ "selector": string, "error": string }` for each field that couldn't be
filled (e.g. no element matched the selector).

## email_drafter.py

Drafts a cold email via the Claude API. Runs as a subprocess reading a
`EmailDraftRequest` JSON document from stdin (or `--input <file>`) and
writing an `EmailDraftResult` JSON document to stdout, so JS callers can
invoke it without a shared runtime. Requires `ANTHROPIC_API_KEY` in the
environment and the `anthropic` package (`pip install anthropic`).

**Request** (`EmailDraftRequest`):

```json
{
  "recipient_name": "Jane Doe",
  "recipient_company": "Acme Corp",
  "recipient_role": "VP of Engineering",
  "sender_name": "Alex Smith",
  "sender_company": "Capture Agent",
  "purpose": "Introduce our browser automation product",
  "key_points": ["Saves 5 hours/week on manual form entry", "SOC2 compliant"],
  "tone": "friendly",
  "max_words": 120
}
```

`recipient_name`, `recipient_company`, `sender_name`, and `purpose` are
required; everything else has a default.

**Response** (`EmailDraftResult`):

```json
{ "success": true, "subject": "...", "body": "...", "error": null }
```

On failure (missing fields, missing API key, or an unparseable model
response), `success` is `false` and `error` holds a human-readable message.

```
python email_drafter.py --input request.json
```
