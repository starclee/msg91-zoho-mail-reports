# MSG91 Report Automation - Zoho Mail port

A Node.js port of `../Code.gs` (the Gmail/Apps Script version) onto Zoho
Mail. Polls a tagged inbox for MSG91 report zips/CSVs, splits records by
customer, replies with a per-file breakdown for each attachment plus one
merged consolidated report, and optionally posts to Zoho Cliq.

## Why this isn't a Zoho Apps Script / Deluge script

Zoho has no direct equivalent of Google Apps Script (one script, both a
time trigger and full mailbox API, running in the same runtime). The
closest thing - **Deluge** (Zoho's scripting language, used in Zoho Mail
filters and Zoho Flow) - was evaluated and ruled out for the actual
zip/CSV work:

- Deluge has no byte-array type and no documented bitwise operators, so
  the original's DEFLATE decoding isn't expressible in it at all.
- Deluge's `zipfile.extract()` caps output at 500KB-3MB, and `invokeurl`
  responses cap at 5MB - both far below the hundreds-of-MB reports this
  pipeline handles.

So this is a **plain Node.js** implementation instead, using the real
Zoho Mail REST API and Node's built-in `zlib` (via the `yauzl` package for
streaming zip reads) rather than a hand-rolled decoder - Node has zlib
natively, so the ~280 lines of `../Inflate.gs` simply aren't needed here.

## Architecture: why this isn't a Zoho Catalyst serverless Function either

Zoho Catalyst (Zoho's serverless platform) was the next candidate, since it
does give you real Node.js, npm packages, and a Cron function type. But
its **Advanced I/O functions have a documented 30-second maximum execution
timeout** - unworkable for streaming a hundreds-of-MB zip. Catalyst's
Cron function type shares the same underlying serverless runtime, so the
same ceiling almost certainly applies there too.

So the code here is **runtime-agnostic Node.js**, not tied to any one
Zoho hosting surface:

- `src/` - all the actual logic (Zoho Mail client, zip/CSV aggregation,
  consolidation, Cliq notification). No execution-time assumptions baked
  in anywhere.
- `bin/run-once.js` - a plain CLI entry point. Point any scheduler at it:
  OS cron / Windows Task Scheduler, a `systemd` timer, `pm2`, or a small
  loop inside a **Zoho Catalyst AppSail** service (a long-running
  container, not subject to the Functions timeout). This is the
  recommended way to run it for real report volumes.
- `catalyst/msg91-report-cron/` - an optional thin adapter if you want to
  try it as an actual Catalyst Cron function anyway. Only use this for
  small/moderate report sizes that comfortably finish in well under 30s -
  see the caveat comment at the top of its `index.js`.

## Setup

### 1. Zoho Mail OAuth (Self Client)

Zoho Mail has no equivalent of Apps Script's implicit `Session`/`GmailApp`
authorization - you register an app and mint a long-lived refresh token
once, by hand:

1. Go to `api-console.zoho.com` → **GET STARTED** → **Self Client** →
   **CREATE NOW**. Note the `client_id` / `client_secret`.
2. Open the **Generate Code** tab. Scopes needed:
   `ZohoMail.messages.ALL,ZohoMail.folders.ALL,ZohoMail.tags.ALL,ZohoMail.accounts.READ`
   (adjust the `.ALL` suffixes to `.READ`/`.CREATE`/`.UPDATE` if you want
   to scope more tightly - see the code comments in `src/zohoMail.js` for
   which calls need which). Pick a short expiry, then **CREATE** and copy
   the generated `code` immediately.
3. Exchange it for tokens before it expires, and look up your account id,
   in one step - run `scripts/get-zoho-tokens.ps1` (PowerShell) from this
   directory:
   ```
   .\scripts\get-zoho-tokens.ps1
   ```
   It prompts for the Client ID/Secret/code interactively (nothing typed
   into a chat or written to a file), exchanges them, and prints
   `ZOHO_REFRESH_TOKEN`, `ZOHO_ACCOUNT_ID`, and `ZOHO_FROM_ADDRESS` -
   the answer to "Finding your accountId" below is folded into this script.
   If you'd rather do it by hand, the equivalent request is:
   ```
   POST https://accounts.zoho.com/oauth/v2/token
     client_id=...
     client_secret=...
     grant_type=authorization_code
     code=<code from step 2>
   ```
   The response's `refresh_token` does not expire - that's what goes in
   `ZOHO_REFRESH_TOKEN`. `access_token` is short-lived; the script fetches
   its own fresh one from `refresh_token` on every run, you don't need to
   save it.
4. If your account isn't on the US datacenter, pass
   `-AccountsHost accounts.zoho.<tld> -MailHost mail.zoho.<tld>` to the
   script (or use the matching hosts by hand), and set
   `ZOHO_ACCOUNTS_BASE_URL`/`ZOHO_MAIL_BASE_URL` in `.env` accordingly
   (see `.env.example`).

### 2. Finding your `accountId` and setting `ZOHO_FROM_ADDRESS`

Already printed by `scripts/get-zoho-tokens.ps1` above. By hand: call the
Zoho Mail accounts endpoint (`GET https://mail.zoho.com/api/accounts`,
`Authorization: Zoho-oauthtoken <access_token>`) - the numeric `accountId`
field is `ZOHO_ACCOUNT_ID`, and `mailboxAddress` on the same record is
`ZOHO_FROM_ADDRESS`.

### 3. Copy `.env.example` to `.env` and fill it in

```
cp .env.example .env
```

### 4. Set up your Gmail-filter equivalent

There's no Zoho Mail filter step required here - `checkForNewReports`
does the tag-based polling itself (create/find the `MSG91-Reports` tag,
list untagged-processed/error candidates, tag them once handled). Just
make sure incoming report emails end up tagged `MSG91-Reports` (a Zoho
Mail filter rule with a "Tag" action, matching however your Gmail filter
did by sender/subject, is the direct equivalent of the setup step in the
Gmail version's own README).

### 5. Run it locally (to test, before scheduling it anywhere)

```
npm install
npm start          # one poll cycle
```

### 6. Schedule it

**Option A - GitHub Actions (free, recommended).** This repo already has
`.github/workflows/poll-reports.yml`, which runs `bin/run-once.js` every
10 minutes on GitHub's own runners - no separate hosting account needed.

- GitHub Actions' free tier is 2,000 minutes/month on a **private** repo,
  or **unlimited** on a **public** one. At a 10-minute cadence this repo
  is public (no secrets are ever in the code - they're all in the
  env vars below) specifically to stay under that budget; if you'd rather
  keep it private, either widen the cron interval (e.g. `*/30 * * * *`
  comfortably fits the 2,000-minute budget) or expect to pay for extra
  minutes past it.
- It's best-effort timing, not exact - a run can start a few minutes late
  under GitHub's load. A schedule also auto-disables after 60 days with
  zero commits to the repo (a stale-repo safeguard on GitHub's side) -
  push anything occasionally, or use `workflow_dispatch` (already wired
  up - "Run workflow" button on the Actions tab) to nudge it back on.
- **Set the secrets** the workflow references: repo → **Settings** →
  **Secrets and variables** → **Actions** → **New repository secret**,
  one each for `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`,
  `ZOHO_REFRESH_TOKEN`, `ZOHO_ACCOUNT_ID`, `ZOHO_FROM_ADDRESS`,
  `ZOHO_NOTIFY_EMAIL`, and (if using Cliq) `CLIQ_WEBHOOK_URL`. The
  non-secret ones (`ZOHO_TRIGGER_LABEL` etc.) have defaults baked into the
  workflow and only need a **Variables** entry if you want to override
  them.
- Or via the `gh` CLI, run from this directory (values stay local to your
  terminal, never pasted into chat):
  ```
  gh secret set ZOHO_CLIENT_ID
  gh secret set ZOHO_CLIENT_SECRET
  gh secret set ZOHO_REFRESH_TOKEN
  gh secret set ZOHO_ACCOUNT_ID
  gh secret set ZOHO_FROM_ADDRESS
  gh secret set ZOHO_NOTIFY_EMAIL
  gh secret set CLIQ_WEBHOOK_URL   # only if CLIQ_ENABLED
  ```
  (each prompts for the value on stdin).

**Option B - Render Cron Job (paid, ~$1/month minimum).** `render.yaml`
in this repo is a Render Blueprint - **New +** → **Blueprint** on
[dashboard.render.com](https://dashboard.render.com), point it at this
repo, and Render sets up the Cron Job from that file. Render's Cron Jobs
don't have a free tier - check current pricing before deploying. Fill in
the same secrets under the service's **Environment** tab.

**Option C - anywhere else.** Any VM/server you control (Windows Task
Scheduler, cron, a Catalyst AppSail container) running
`node bin/run-once.js` on a timer works the same way - populate `.env`
there instead of platform secrets.

## What's different from the Gmail version

- **Labels → tags.** Zoho's tags are the non-exclusive analog of Gmail
  labels (folders are exclusive/tree-structured, so they don't fit this
  role - see comments in `src/zohoMail.js`).
- **No Drive-link scanning.** The Gmail version also scans message bodies
  for Google Drive file/folder links and resolves them via `DriveApp`.
  This port only reads zip/CSV **attachments**; Zoho WorkDrive shared-link
  resolution isn't implemented (the API research behind this port didn't
  cover WorkDrive's request/response shapes in enough depth to port it
  confidently). To add it: resolve a WorkDrive share link's file/folder id
  via the WorkDrive API, then feed its bytes through the same
  `aggregateZipBufferIntoCounts`/`CsvAggregator` used for attachments.
- **`label:X -label:Y` has no one-call equivalent.** Zoho Mail's search
  syntax has AND (`::`)/OR (`:or:`) but no NOT operator, so
  `findUnprocessedMessages` in `src/zohoMail.js` fetches the trigger-tag
  set and the exclude-tag sets separately and filters client-side.
- **No thread-level reply-all object.** Gmail's `GmailThread.replyAll()`
  has no Zoho Mail API equivalent - replies are always sent against one
  `messageId`. This port groups fetched messages by `threadId` in code and
  sends the final consolidated reply against the newest message in each
  group.
- **Reply-all is built by hand.** The Mail API's reply endpoint doesn't
  document whether it auto-fills To/Cc from the original message, so
  `zohoMail.replyAll` explicitly reconstructs them from the original
  message's own `fromAddress`/`toAddress`/`ccAddress` headers (dropping
  our own `fromAddress` so we don't reply to ourselves).

## Documented gaps (verify before depending on them)

These came up during API research and weren't resolved by Zoho's published
docs - flagged here rather than silently assumed:

- `POST /labels`'s exact request body field name for a label's display
  name (`src/zohoMail.js` uses `displayName`, matching the field name the
  rest of the Labels API returns - check the actual response if creation
  fails).
- Whether the Reply endpoint accepts an `attachments` array (this port
  never attaches files to a reply, so it doesn't matter here, but don't
  assume it works if you extend this).
- Zoho Mail's per-message list/search response wasn't confirmed to return
  a message's own applied tag ids as a field - `findUnprocessedMessages`
  works around this by querying per-tag instead of reading tags off each
  message.

## Files

| File | Mirrors | Notes |
|---|---|---|
| `src/config.js` | `Code.gs` `CONFIG` | env-var based |
| `src/clientLookup.js` | `../ClientLookup.gs` | keep both in sync |
| `src/consolidate.js` | `../Consolidate.gs` | streaming `CsvAggregator` instead of one-big-string parsing |
| `src/zip.js` | `../Inflate.gs` + `../LargeZip.gs` | Node's native zlib via `yauzl`, no hand-rolled decoder needed |
| `src/zohoMail.js` | Gmail-facing parts of `Code.gs` | OAuth, tags, search, reply |
| `src/cliq.js` | `../Cliq.gs` | same webhook approach |
| `src/processReports.js` | `checkForNewReports`/`processThread_` in `Code.gs` | orchestration |
