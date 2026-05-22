# QuantHub · Product Analytics — CLAUDE.md

Project context for Claude Code. Read this at the start of every session.

---

## What This Is

A standalone product demand and revenue analytics dashboard that pulls HubSpot line item and deal data. It lives in its own repo and its own Cloudflare Worker (`quanthub-products`) — separate from the Sales Agent — to keep load times fast.

**Access is gated.** The portal requires a password to load. The Worker serves both the HTML and the data API, and only returns either to clients with a valid `qh_session` cookie. Without login, all routes either redirect to `/login` (for HTML navigations) or return 401 (for API calls).

Live URL:  `https://quanthub-products.michael-20e.workers.dev/` (login required)
Dev URL:   `https://quanthub-products-dev.michael-20e.workers.dev/` (login required)
GitHub Pages (`https://krausshauss.github.io/quanthub-product-analytics/`): redirect-to-Worker stub.

GitHub repo: `github.com/krausshauss/quanthub-product-analytics`

---

## People

| Person | Role | HubSpot Owner ID |
|---|---|---|
| Michael Krause | Owner / architect (`mkrause@quanthub.com`) | `90736265` |
| Jakob Krause | Collaborator / developer | — |
| Joe DeRario | Sales rep | `81657454` |
| Jason Rupert | Sales rep | `86826804` |
| Jakob Krause | Director of Sales | `90736265` |

Michael owns the GitHub account (`krausshauss`), Cloudflare account, and HubSpot account.
Jakob is a collaborator — he has push access to this repo and Worker Admin on Cloudflare.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla JS + CSS, no build step, no frameworks |
| Hosting | Cloudflare Worker (serves `public/` via Wrangler `[assets]`) |
| API + auth | Same Cloudflare Worker (`quanthub-products`) |
| Data source | HubSpot CRM v3/v4 API via Private App token |
| Styling | Light theme, QuantHub brand color `#0077B5`, font Manrope + DM Mono |

---

## File Structure

```
cloudflare-worker.js     ← Worker: auth + asset serving + HubSpot API proxy
wrangler.toml            ← Worker config (name, account_id, [assets] binding)
index.html               ← Root redirect-to-Worker stub (served by GitHub Pages)
public/                  ← Everything below served by the Worker via env.ASSETS
  index.html             ← Single-page app shell
  src/
    css/main.css         ← All styles
    js/
      config.js          ← WORKER_URL="" (same-origin), YEAR, fmtMoney(), fmtNum()
      hubspot.js         ← fetch wrapper; on 401 it redirects to /login
      app.js             ← Orchestrator: init, refresh, KPIs, coverage bar
      components/
        productTable.js  ← Sortable product performance table
        pipelineBar.js   ← Stacked bar chart (CW + pipeline per product)
        repMatrix.js     ← Per-rep × per-product breakdown
```

---

## Worker Routes

All routes are on the `quanthub-products` worker. Routes marked **(auth)** require a valid `qh_session` cookie; without one, GET HTML navigations redirect to `/login` and API calls return 401.

| Route | What it does |
|---|---|
| `GET  /login` | Login page (always public) |
| `POST /auth`  | Submit password (form-encoded); on success sets `qh_session` cookie (30 days, HttpOnly, Secure, SameSite=Lax) and redirects to `/` |
| `GET  /logout` | Clear cookie, redirect to `/login` |
| `GET  /`      | App HTML (auth) — served from `public/index.html` |
| `GET  /src/*` | App static assets (auth) — served from `public/src/` |
| `GET  /health` | Sanity check (auth) |
| `GET  /products/summary?year=YYYY` | Aggregated KPIs (auth) |
| `GET  /products/catalog` | Full HubSpot product library (auth) |
| `GET  /products/reps` | Per-rep × per-product breakdown (auth) |

**Rate limit:** 5 failed `/auth` attempts per IP per 15-minute window → 429. Per-isolate, not perfectly enforced across the Cloudflare edge but adequate for this portal's traffic.

---

## Worker Secrets

Set once via Wrangler CLI — never stored in files. For the dev environment, append `--env dev` to each command:

```bash
npx wrangler secret put HUBSPOT_TOKEN     # HubSpot Private App token (pat-na1-...)
npx wrangler secret put PORTAL_PASSWORD   # password used to log into the portal
npx wrangler secret put SESSION_SECRET    # long random string for HMAC-signing session cookies
```

Generate a fresh `SESSION_SECRET` with:
```bash
openssl rand -base64 48
```

**Rotating the portal password:** re-run `wrangler secret put PORTAL_PASSWORD` (and `--env dev` for the dev worker). Existing sessions stay valid until they expire (30 days) or `SESSION_SECRET` is rotated. Rotate `SESSION_SECRET` to invalidate every active session immediately.

---

## HubSpot Data Model

- **Deals** → have **Line Items** (via v4 associations batch API)
- **Line Items** → link to **Products** in the catalog
- Early-stage deals may have no line items — this is expected and handled gracefully
- All closed-won deals should have line items at close
- The worker fetches CW deals + open deals in parallel, batch-reads associations (100 at a time), then batch-reads line item properties

Key HubSpot API patterns used:
```
POST /crm/v3/objects/deals/search          ← filtered deal search
POST /crm/v4/associations/deals/line_items/batch/read  ← get line item IDs from deals
POST /crm/v3/objects/line_items/batch/read ← get line item properties
```

---

## Deploying the Worker

```bash
# Deploy to production
npx wrangler deploy

# Deploy to dev environment
npx wrangler deploy --env dev

# Check deployed worker
npx wrangler whoami
```

After deploying, the frontend at `config.js` must point to the correct `WORKER_URL`. Switch between dev and prod by editing that one line.

---

## Deploying the Frontend

Frontend assets live in `public/` and are deployed together with the Worker via Wrangler `[assets]`. Push to `main` is no longer required for the app to update — only the Worker matters. GitHub Pages serves only the root redirect stub.

```bash
npx wrangler deploy           # deploys public/ + worker to prod
npx wrangler deploy --env dev # deploys public/ + worker to dev
```

---

## Design Conventions

- No build step — all JS is plain ES5-compatible IIFE modules exposed on `window.*`
- Each component is a self-contained IIFE: `window.ProductTable`, `window.PipelineBar`, `window.RepMatrix`
- All components expose: `render(data)`, `renderLoading()`, `renderError(msg)`
- `app.js` is the orchestrator — it calls `HubSpot.fetchSummary()` and passes data to all components
- Money formatting: use `window.CONFIG.fmtMoney(n)` — outputs `$1.2M`, `$63K`, `$450`
- Colors: CW Revenue = `#0077B5` (brand blue), Pipeline = `#0EA5E9` (light blue)
- Tooltips: `.info-tip` with `data-tip="..."` — CSS-only, no JS
- Skeleton loading: `.skeleton-block` divs while data loads

---

## Known Data Facts (as of May 2026)

- ~402 total deals in HubSpot
- ~87 unique products across all deals
- ~$63K closed-won revenue YTD
- ~$3.7M open pipeline
- ~53 of 402 deals have line items quoted (13% coverage — early stage deals expected)
- Coverage bar turns green ≥80%, amber ≥50%, blue <50%

---

## Related Repos

| Repo | Purpose |
|---|---|
| `quanthub-sales-agent-dev` | Per-rep Sales Agent dashboard + AI follow-up checklist |
| `quanthub-dashboard` / `quanthub-dashboard-dev` | Team scorecard / leaderboard |
| `quanthub-product-analytics` | This repo — product demand + revenue |

All three share the same HubSpot Private App token (`HUBSPOT_TOKEN`).
The Sales Agent also uses `ANTHROPIC_API_KEY` for Claude AI features.
