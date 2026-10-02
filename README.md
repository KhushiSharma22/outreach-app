# Outbound campaign studio

A frontend-only email outreach prototype with company context, a campaign assistant, structured audience filters, lead qualification, email review, scheduling, campaign insights, and follow-up sequences.

## Run locally

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:4173 in your browser.

## Flow

Company context → assistant or manual campaign → audience filters → discovery → lead review → email studio → approval and schedule → launch preview → insights.

After launching a campaign, open **Sequences** to customize and approve day 1, 3, 5, and 7 follow-ups. Days are measured from each recipient's initial email. Edits require fresh approval.

## Scope

Research, contact verification, AI writing, scheduling, delivery, and metrics are simulated. No authentication, backend, live integrations, or actual email sending. State resets on refresh. Fictional addresses use `.example`.

## Files

- `dist/index.html` — entry point
- `dist/style.css` — responsive interface
- `dist/model.js` — sample data and campaign rules
- `dist/app.js` — screens and interactions
- `tests/flow.test.cjs` — model and screen-render checks
- `PRD.md` — original plan; predates some frontend changes

## Checks

```sh
node --check dist/app.js
node --check dist/model.js
node tests/flow.test.cjs
```

`.openai/hosting.json` records the existing private Sites registration. It contains no credentials and is not required for local use.
