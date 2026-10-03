# GrowthScan — Start Here (no coding needed)

GrowthScan checks a public website and produces a report with evidence. You paste a website, click **Run GrowthScan**, wait about 6–10 minutes, and get a report you can read on screen and download as a PDF.

**What you need**

- A free **GitHub** account (github.com) — this is where the program's files live.
- A **Render** account (render.com) — this is the computer that runs the program for you. Saving reports requires one of Render's **paid** plans (the free plan can't keep files). Check Render's pricing page for the current price; the scanner needs a plan with **at least 2 GB of memory**.
- A **password you choose** to protect the tool.
- About **30 minutes** the first time.

---

## Part 1 — Put the files on GitHub (about 10 minutes)

1. Unzip **growthscan-github-upload.zip** on your computer. You will get a folder.
2. Go to **github.com** and sign in. Click the **+** at the top right → **New repository**.
3. Name it `growthscan` . Choose **Private** (important — only you can see it). Leave every checkbox empty. Click **Create repository**.
4. On the next page click the link **“uploading an existing file”**.
5. Open the unzipped folder. **Select everything inside it** (Ctrl+A on Windows, Cmd+A on Mac) and drag it into the GitHub page. Use **Chrome or Edge** — other browsers may not upload folders. (Drag the *contents*, not the folder itself, so that files like `Dockerfile` and `render.yaml` end up at the top level of the repo.)
6. Wait until every file shows as uploaded, then click the green **Commit changes** button.

*Check:* the repo page should list `Dockerfile`, `render.yaml`, `package.json`, and folders named `src`, `public`, `config`, `test`.

> GitHub's website accepts up to 100 files at a time. This package is under that limit on purpose. The sample reports are in a separate download so they don't count.

## Part 2 — Start it on Render (about 15 minutes, mostly waiting)

1. Go to **render.com** and sign up — choose **Sign in with GitHub**.
2. In the Render dashboard click **New +** → **Blueprint**.
3. Render asks to connect to GitHub. Allow it to see your `growthscan` repo (choose “only select repositories” and pick that one).
4. Select the `growthscan` repo. Render reads the `render.yaml` file and shows what it will create: one web service called **growthscan** with a 10 GB disk.
5. It asks for **APP_PASSWORD**. Type the password you chose. (This is the password you will use to sign in. It is stored in Render, not on GitHub.)
6. Click **Apply** / **Deploy**. The first build takes several minutes. When the service says **Live**, click the web address at the top of the page (it looks like `https://growthscan-xxxx.onrender.com`).

## Part 3 — Run a scan

1. Sign in. **Username:** `goodjoojoo` **Password:** the one you chose.
2. Type the website (for example `cedarcide.com`) and click **Run GrowthScan**.
3. Watch the progress boxes. A scan takes about 6–10 minutes. You can close the page and come back — your reports are listed under **Recent runs**.
4. When it finishes, read the report on screen. Click **Download PDF** for the PDF.

**What “DRAFT” means:** every report is marked **Draft — not approved for customer** until a person reviews it. Open the **Review & sign-off** tab to see what is still blocking approval and to record your sign-off. Don't send a draft to a customer.

**Good to know before you scan someone's site**

- The scan adds a product to a test cart and stops at checkout. It never places an order, but each product tested can show up as an *add-to-cart* in that site's analytics. Scan sites you own or have permission to test.
- Under **Advanced options** you can add 3–5 competitor websites, or choose which products are tested. If you skip this, it picks automatically.

## Part 4 — If a site blocks the scanner

Some websites show a “robot check” page to automated tools. When that happens GrowthScan **does not guess**. The report says **Scan incomplete — the site blocked automated access**, marks those checks **Blocked** (never as a problem), and explains what to do:

- Ask the site's owner to **allow the scanner** in their bot-protection settings. Open the **Review & sign-off** tab — it shows the address the website saw, which is what they need.
- Or run the scan from a different network the site accepts, then re-run.

## Part 5 — Updating and turning it off

- **Update the tool later:** on your GitHub repo click **Add file → Upload files**, drop in the new files, and **Commit changes**. Render rebuilds automatically.
- **Stop being charged:** in Render open the service → **Settings** and use the option to suspend or delete it. Deleting it also deletes saved reports, so download the PDFs first.
- **Change the password:** in Render open the service → **Environment**, edit `APP_PASSWORD`, save.

## If something goes wrong

| What you see | What to do |
|---|---|
| Render build fails | Open the service → **Logs**, copy the last 30 lines and send them to a developer (or to me). |
| Page asks for a password again and again | Check you are using username `goodjoojoo` and the exact password you set in Render. |
| “Evidence check failed” on a report | The scan's saved evidence didn't match. Re-run it; if it repeats, send the report's `run.json` to a developer. |
| Scan is stuck for 20+ minutes | Refresh. If it shows *Interrupted*, re-run it. |
| Speed results say “Requires validation” | The speed tests varied too much between runs. Re-run, or move to a larger Render plan. |

## Honest notes

- The code, tests and container were checked in a test environment. **I could not click through Render's or GitHub's screens myself**, so button names may differ slightly. If a step doesn't match, take a screenshot and ask.
- The tool is an **internal** tool with one shared login. Don't share the web address publicly.
