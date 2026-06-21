# Keepwarm

**Live:** https://rahulboraa.github.io/cron-jobs/

A personal keep-alive dashboard. Free-tier hosts like Render spin a web service
down after ~15 minutes of inactivity, so the next visitor waits ~50s for a cold
start. Keepwarm pings your URLs on a schedule so they never go cold.

The trick: the **engine is GitHub Actions**, not a server you have to keep awake
yourself. A scheduled workflow pings every URL, writes the results back into the
repo, and a static dashboard (GitHub Pages) reads those results.

```
GitHub Actions (cron */10)  →  pings your URLs  →  commits data/status.json
                                                          │
                          Dashboard (GitHub Pages) reads it ┘
                          and edits config/targets.json via the GitHub API
```

Everything is free and nothing needs to stay awake — GitHub runs the cron.

## Setup

1. **Create a public repo** and push this folder to it.
   ```bash
   git init && git add -A && git commit -m "init keepwarm"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. **Enable GitHub Pages.** Repo → Settings → Pages → Source: **Deploy from a
   branch**, branch **main**, folder **/ (root)**. Your dashboard will be at
   `https://<you>.github.io/<repo>/`.

3. **Let the workflow write back.** Repo → Settings → Actions → General →
   *Workflow permissions* → **Read and write permissions** → Save.
   (The workflow already requests `contents: write`; this toggle must also be on.)

4. **Add your services.** Either edit [`config/targets.json`](config/targets.json)
   directly, or add a token (next step) and manage them from the dashboard. The
   four entries shipped here are examples — replace them.

5. **(Optional) Edit from the dashboard.** Open the dashboard → gear icon →
   paste a **fine-grained personal access token** scoped to this repo only with
   **Contents: Read and write**. The token is stored in your browser's
   `localStorage` and is sent only to `api.github.com`. Without a token the
   dashboard is read-only (you edit `targets.json` by hand).

The first ping runs on the next 10-minute boundary, or trigger it now: repo →
Actions → **keep-awake** → **Run workflow**.

## How a service is defined

`config/targets.json`:

```json
{
  "services": [
    {
      "id": "portfolio-api",
      "name": "Portfolio API",
      "url": "https://portfolio-api.onrender.com",
      "intervalMinutes": 10,
      "enabled": true,
      "expectStatus": null
    }
  ]
}
```

- **intervalMinutes** — how often to ping. The cron fires every 10 min; a service
  with `intervalMinutes: 30` is only pinged when it's due, so one cron serves many
  intervals. Keep it under 15 for Render.
- **enabled** — `false` pauses it without removing it.
- **expectStatus** — require an exact code (e.g. `200`). `null` accepts any 2xx/3xx.

## Notes & limits

- **GitHub's minimum cron interval is 5 minutes**, and scheduled runs can be
  delayed under load. 10 minutes is a safe, low-noise default for a 15-minute
  spin-down. If you need tighter, change both the `cron:` line in
  [`.github/workflows/keep-awake.yml`](.github/workflows/keep-awake.yml) and the
  `CRON_SCHEDULE` env in the same file.
- **Pages must serve from the same branch the workflow commits to** (`main`/root),
  so the dashboard reads the freshest `data/`.
- GitHub Pages and `raw` content are CDN-cached for a few minutes, so the
  dashboard's "last check" can lag the actual ping slightly.
- **Wake all now / the bolt icon** fire a request straight from your browser to
  wake a service immediately. That's a client-side ping (separate from the cron)
  and works even without a token.

## Local preview

```bash
python3 -m http.server 8753
# open http://localhost:8753/
```

It reads the committed `data/*.json`, so you see real (or the sample) status.
