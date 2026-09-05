# Implementation Plan: SAS Award Availability Dashboard

Static, free dashboard hosted on GitHub Pages showing the latest known SAS
award-seat availability for two routes (ARN→JFK, ARN→EWR). Data is collected
periodically by a scheduled GitHub Action and committed to the repo; the
frontend only ever reads static JSON files — no token or server is ever
exposed to the browser.

## 1. Proposed file structure

```
.
├── README.md
├── docs/                     # GitHub Pages source (Settings → Pages → /docs)
│   ├── PLAN.md               # this document
│   ├── index.html            # dashboard UI
│   ├── app.js                # fetches JSON below and renders it
│   ├── style.css
│   └── data/                 # published, "public" copies of latest results
│       ├── arn-jfk.json
│       ├── arn-ewr.json
│       └── meta.json         # last-updated timestamp, run status, etc.
├── scripts/
│   └── fetch-availability.mjs   # calls SAS endpoints, writes docs/data/*.json
├── .github/
│   └── workflows/
│       ├── fetch-availability.yml   # scheduled + manual (auth'd) run
│       └── pages.yml                # (or use built-in Pages deploy-from-branch)
└── package.json               # deps for the fetch script (e.g. node-fetch), lint/test scripts
```

Notes:
- Raw/config (e.g. endpoint URLs, headers, route definitions) lives in
  `scripts/config.json` or env vars — nothing secret is required to *read*
  the endpoints if they're public search APIs; if SAS ever requires an API
  key, it is stored as a GitHub Actions secret and only ever used
  server-side inside the workflow, never shipped to `docs/`.
- Only `docs/` is published to Pages, so anything under `scripts/` or
  `.github/` is never served to visitors.

## 2. Data flow

```mermaid
flowchart LR
    A[Scheduled cron\nGitHub Actions] --> B[fetch-availability.mjs]
    C[Manual "Run workflow"\nauthenticated GitHub user] --> B
    B --> D[Call SAS ARN-JFK endpoint]
    B --> E[Call SAS ARN-EWR endpoint]
    D --> F[Write docs/data/arn-jfk.json]
    E --> G[Write docs/data/arn-ewr.json]
    F --> H[git commit + push]
    G --> H
    H --> I[GitHub Pages rebuild/serve docs/]
    I --> J[Browser: index.html + app.js\nfetch('./data/*.json')]
    J --> K["Refresh" button\n(re-fetches the static JSON,\nno Action trigger)]
```

1. A GitHub Actions workflow runs on a schedule (e.g. every 30–60 min via
   `on: schedule`) and also supports `workflow_dispatch` for manual/auth'd runs.
2. The job runs `scripts/fetch-availability.mjs`, which calls the two SAS
   endpoints and normalizes the responses into `docs/data/arn-jfk.json`,
   `docs/data/arn-ewr.json`, and updates `docs/data/meta.json` with a
   `fetchedAt` timestamp and per-route status (success/error).
3. The workflow commits and pushes the updated JSON files (using the default
   `GITHUB_TOKEN`, scoped to `contents: write`) back to the repo, which
   triggers (or is part of) the Pages deployment.
4. The static frontend (`index.html` + `app.js`) fetches only the committed
   JSON files via relative URLs and renders them — this is plain client-side
   JS with no secrets, no server, no direct call to SAS from the browser
   (avoids CORS issues and avoids exposing any credentials/API shape).
5. A "Refresh" button in the UI simply re-fetches the same static JSON files
   (with cache-busting) to pick up the latest committed data — it does not
   call the SAS API and does not call the GitHub API to trigger a workflow.

## 3. GitHub Actions permissions

- Workflow-level `permissions:` block set to the minimum needed:
  - `contents: write` — required only for the commit/push-back step.
  - Everything else (`issues`, `pull-requests`, `actions`, etc.) omitted /
    set to `none`.
- Use the automatically-provided `GITHUB_TOKEN` (never a PAT) for the
  commit/push step — it's short-lived and scoped to this repository only.
- No token of any kind is passed to, or embedded in, `docs/` or any client
  file. The token only exists inside the Actions runner environment.
- If the SAS API requires an API key/cookie in the future, store it as an
  Actions **secret** and reference it only in the workflow's `env:` for the
  fetch step — never echo it to logs or write it into `docs/data/*.json`.
- Branch protection (optional but recommended): protect `main` so only the
  Actions bot (via its token) or reviewed PRs can write to it, if the repo
  otherwise disallows direct pushes.

## 4. Limitation: the public "Run now" button

- GitHub Actions has no supported way to let an anonymous website visitor
  trigger a workflow run without presenting *some* credential — triggering a
  run always requires calling the GitHub API (`workflow_dispatch` or
  `repository_dispatch`) with a token that has `actions: write` (or
  `contents: write` for dispatch), and that token cannot be safely embedded
  in public browser JS (anyone could extract and abuse it, e.g. to spam runs
  or exhaust Actions minutes).
- Therefore the dashboard's public "Refresh" button can only:
  - Re-fetch the already-published static JSON (cheap, safe, always available), or
  - Show the `meta.json` timestamp so users know how fresh the data is.
- A **real** "Run now" that triggers a fresh SAS fetch is only offered to
  users who authenticate as a GitHub user with appropriate repo permissions,
  e.g.:
  - They go to the repo's **Actions** tab and click "Run workflow" manually
    (simplest, no extra code), or
  - An optional small "Sign in with GitHub" (OAuth device flow or a
    GitHub App) in the frontend that, once the visitor authenticates as a
    collaborator with the right scope, calls the GitHub REST API
    `POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches` using
    *their own* token (never a repo secret) — this still requires that
    person to actually have permission on the repo, so it's not usable by
    arbitrary public visitors.
- In short: the schedule keeps data "fresh enough" for everyone; only
  authenticated maintainers can force an immediate re-fetch.

## 5. Expected setup steps in GitHub

1. Create/confirm the repo has an `.github/workflows/` directory (this repo
   already exists at `c:\ws\awards`).
2. Add the workflow file with:
   - `on: schedule` (cron) + `on: workflow_dispatch`.
   - `permissions: contents: write` at the top level.
   - Steps: checkout → setup Node → run `scripts/fetch-availability.mjs` →
     commit & push changed files in `docs/data/`.
3. Add `scripts/fetch-availability.mjs` and `package.json` with the fetch
   logic and route/endpoint configuration.
4. Add the static site under `docs/` (`index.html`, `app.js`, `style.css`,
   placeholder `data/*.json`).
5. In the GitHub repo settings:
   - **Settings → Pages**: set source to "Deploy from a branch", branch
     `main`, folder `/docs`.
   - **Settings → Actions → General → Workflow permissions**: ensure
     "Read and write permissions" is enabled (or rely on the explicit
     `permissions:` block in the workflow instead of the repo-wide default).
   - (Optional) **Settings → Environments/Secrets**: add any SAS API
     key/secret if one becomes necessary.
   - (Optional) **Settings → Branches**: add a protection rule for `main`.
6. Verify: manually trigger the workflow once (Actions tab → "Run workflow")
   and confirm `docs/data/*.json` gets committed and the Pages site updates.

## Open questions / follow-ups before implementation

- Exact SAS endpoint URL(s), required headers/params for ARN→JFK and
  ARN→EWR searches, and whether they require any key/cookie (affects
  whether Section 3's "optional secret" becomes mandatory).
- Desired schedule frequency (affects Actions minutes usage).
- Whether a GitHub OAuth "sign in" for maintainers is worth the extra
  complexity, or whether pointing them to the Actions tab is sufficient.
