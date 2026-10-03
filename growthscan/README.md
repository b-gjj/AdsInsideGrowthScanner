> **New here? Open [START-HERE.md](START-HERE.md) — plain-English setup, no coding needed.**

# GrowthScan — Outside-In URL Runner (Ads Inside / Good Joo Joo)

**Operator experience:** open the hosted URL → sign in → paste `cedarcide.com` → **Run GrowthScan** → read the report in the Ads Inside design → review and sign off → **Download PDF**. No Node, Playwright or terminal.

## Run it on your own machine (about 10 minutes)
**With Docker** (Docker Desktop on Mac/Windows, or Docker Engine on Linux; allow it about 4 GB RAM):
```
docker build -t growthscan .
docker run -d --name growthscan -p 8080:8080 -e APP_PASSWORD='choose-a-password' -v growthscan-data:/data growthscan
```
Open http://localhost:8080, sign in as `goodjoojoo` with that password, paste a site (e.g. `example.com`), click **Run GrowthScan**. Reports and evidence persist in the `growthscan-data` volume. (I verified the image build and run with Podman on Linux; `-p` port mapping and Docker Desktop were not tested.)

**Without Docker** (Node 20+): `npm ci`, then `npx playwright install chromium` (on Linux add `--with-deps`), then `APP_PASSWORD='choose-a-password' npm start` and open http://localhost:8080. Not tested on macOS or Windows.

Running from your own office or home network often avoids bot protection that blocks data-centre addresses, and gives steadier Lighthouse timings than a small cloud instance.

## When a site blocks the scanner
Some sites (SiteGround, Cloudflare, DataDome…) answer automated visitors with a challenge page. The runner detects this, **never scores the challenge page**, marks every check that needs the site `Unscored · Blocked`, shows a notice on the report, and adds a hard readiness blocker. Checks that do not touch the site (email authentication, Meta Ad Library, Google Ads Transparency) still run. To assess the site itself: ask the site owner to allow the scanner (allow-list the runner's IP in their bot-protection settings), or re-run from a network the site accepts. `fixtures/*drgabriellelyon*` is an example of a blocked run.

## What the page is
The UI is the ChatGPT-built Ads Inside report design (cover, 01–06 sections, brand CSS, logos), served by the runner itself — same origin, one login — and driven by the live API (`/api/runs`) instead of a saved fixture. It renders the **GrowthScan master v1.3** model: 35 master checks (18 supported, 17 not yet assessed), runner checks as harness subtests, a *Requires validation* section for provisional findings, a *Review & sign-off* tab (operator-only, never printed), and a server-side PDF (`GET /api/runs/:id/report.pdf`, US Letter, filename and footer say DRAFT until approved).

## One-time deploy (developer, ~15 min)
1. Put this folder in a private Git repo.
2. **Render:** New → Blueprint → select the repo (`render.yaml`) → enter `APP_PASSWORD` → Deploy. **Fly.io:** see comments in `fly.toml`.
3. Open the service URL, sign in as `goodjoojoo` / your password.
Needs ≥2 GB RAM (4 GB / 2 vCPU recommended) and a persistent disk mounted at `/data` (evidence lives there). The app refuses to start without `APP_PASSWORD`.

## Choosing the products the journey tests
By default the scan tests up to 3 products automatically (the first linked from the home page, then the sitemap); **small sites are tested completely** (a one-product site tests its one product and is not blocked for it). To choose instead, open **Advanced options → Choose products to test**: it lists the site's product pages (static fetch; no cart actions), 3 are preselected, and you can pick 3–5 (swap in best sellers, the highest-priced item, any bundle or subscription). The report states how many products were tested of how many exist. The readiness gate requires `min(3, products on the site)`; if the catalog size can't be established from a readable sitemap, 3 are required.

Each product tested performs one real add-to-cart on the site (stopping at checkout entry, never placing an order), which can register an add-to-cart event in the site's analytics. The main form states this before you run.

## The 90-day roadmap
Phases are ordered by dependency, not effort: **Days 1–30 Fix and establish → 31–60 Validate and test → 61–90 Extend and optimize**. Each confirmed finding becomes a three-stage initiative (e.g. DMARC: inventory senders → resolve alignment gaps → move toward enforcement, with the first step chosen from the observed record: review existing reports if `rua` is present, add reporting if not). Large-effort findings start with scoping. Standing items cover baselines (Connected), re-scan and comparison, the Connected review, scope extension for unassessed master checks, regression watch, and “Next priorities determined after Connected review”. Every item carries a basis chip — *Confirmed finding*, *Requires validation*, *Validation of completed work*, *Requires Connected access*, *Conditional on results and approval*, *Scope extension* — and only *Confirmed finding* items assert a defect. Roadmap text is boundary-linted like findings. Playbooks live in `src/lib/roadmap.js`.

## Sign-off and readiness
A report is a **DRAFT** until: evidence verifies; at least 3 products were sampled (or an operator-selected set); no finding is provisional or boundary-suppressed; every supported master check is scored; 3–5 competitors are supplied; and a reviewer records an *Approved* sign-off with customer-ready approval and scope acknowledgement. A sign-off is bound to the exact `report.json` it reviewed and goes stale if the report changes. Reviewer names are self-declared (the app has one shared login).

## Optional environment variables
| Var | Purpose |
|---|---|
| `CRUX_API_KEY` | Enables PERF-06 real-user Core Web Vitals (CrUX). Otherwise unscored: NOT_CONFIGURED |
| `SERPAPI_KEY` | Licensed Google SERP data for INTEL-04. Without it, Google blocks the runner and the check is unscored: BLOCKED |
| `GS_LH_RUNS` | Lighthouse repeats (default 3; median reported) |
| `GS_USER_AGENT` | Override UA (default identifies as GrowthScan) |
| `GS_PACE_MS` | Min ms between requests to one host (default 500) |

## What a run does
Runs one at a time (queue) so Lighthouse isn't competing for CPU. Harnesses: **h1** technical/DNS → **h2** Lighthouse×3 + axe → **h3** mobile shopping journey (PDP → variants → add-to-cart → cart → checkout *entry*) → **h4** Meta Ad Library, Google Ads Transparency, SERP, optional competitors. Every artifact is saved under `/data/runs/<id>/` (`run.json`, `checks.json`, `report.json`, `evidence/<harness>/…`), timestamped and SHA-256 hashed.

## Rules the code enforces (see `test/invariants.test.js`)
- A check is **scored only from positive evidence**. Blocked / failed / timed-out / ambiguous → **unscored with a reason**, never zero. The mean excludes unscored checks and is shown beside coverage.
- Every catalog check always appears in the result (scored, unscored, or Connected-only).
- The journey **never fills or submits checkout/payment fields**; payment-like POSTs are aborted at the network layer; the browser context is discarded.
- Outside-In makes **no claim** about spend, targeting, ROAS, campaign structure, pixel accuracy or account performance. Findings are linted for those terms; six CONN-* checks are permanently unscored.
- Targets must be public http(s) on ports 80/443; private/loopback/link-local/metadata addresses are rejected, including on redirects and browser navigations.
- Evidence files from target sites are served as plain text under a restrictive CSP.

## Known limits (v0.2)
- Rubric scores are **absolute-v0**, not peer-calibrated. Runner check IDs (`TECH-`, `JRN-`…) are **not yet mapped** to the master 100-check IDs.
- Lighthouse on a slow host yields unreliable timings; the app lowers confidence and marks affected findings **provisional** (excluded from Top 3).
- Add-to-cart is a real action on the target site and may register an add-to-cart event in the target's analytics.
- Meta/Google intel is scraped from public UIs and can break when layouts change; failures surface as unscored checks, not zeros.
- Funnel type is only CART vs UNDETERMINED; non-cart funnels (LEAD/APPT/QUOTE) are marked not-applicable until the operator sets one.
- Journey observes one product, one variant interaction, one device profile.
