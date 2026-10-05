# DEPLOY.md — Ship the indexer to Envio Cloud

Step-by-step for deploying `arena-pulse-indexer` to Envio Cloud's **free
development plan**. You only need a browser, a terminal, and your GitHub
account — no code changes.

Time needed: ~15 minutes (plus sync time, which is automatic).

---

## 1. Create an Envio account

1. Go to **https://envio.dev** and click **Sign up / Log in**.
2. Sign in with **GitHub** (this is the account Envio Cloud will deploy from).

## 2. Install the Envio Cloud CLI

In your terminal (Git Bash / PowerShell on Windows, or any shell):

```bash
npm install -g envio-cloud
```

Verify:

```bash
envio-cloud --version
```

## 3. Log in

```bash
envio-cloud login
```

A browser window opens — approve the GitHub login. The session lasts 30 days.

## 4. Push this project to GitHub on the `envio` branch

Envio Cloud deploys from a Git branch (conventionally named `envio`).
From the `arena-pulse/indexer` folder:

```bash
git init
git add .
git commit -m "Arena Pulse indexer: Contex Arena on Monad testnet"
```

Create the repo on GitHub (e.g. `RivaldiMurpia/arena-pulse-indexer` — via
https://github.com/new, **public** so the bounty judges can read it), then:

```bash
git branch -M main
git remote add origin https://github.com/RivaldiMurpia/arena-pulse-indexer.git
git push -u origin main
git checkout -b envio
git push -u origin envio
```

> Copy the commit SHA — you'll need it below:
> `git rev-parse HEAD`

## 5. Connect the Envio GitHub App

Envio needs permission to read the repo before it will deploy:

1. Open **https://github.com/apps/envio-deployments/installations/select_target**
2. Select your GitHub account/org and grant access to the
   `arena-pulse-indexer` repo.

## 6. Register the indexer

```bash
envio-cloud indexer add \
  --name arena-pulse-indexer \
  --repo RivaldiMurpia/arena-pulse-indexer \
  --branch envio \
  --yes
```

If it asks for an org, set it once first:

```bash
envio-cloud config set-org <your-github-username-or-org>
```

## 7. Watch it sync

```bash
envio-cloud deployment status arena-pulse-indexer <COMMIT_SHA> --watch-till-synced
```

Replace `<COMMIT_SHA>` with the SHA from step 4. Historical sync should take
a few minutes (the contract has been live since ~30 Sep 2026; HyperSync is
fast). If something looks stuck:

```bash
envio-cloud deployment logs arena-pulse-indexer <COMMIT_SHA> --follow
```

## 8. Get the GraphQL endpoint

```bash
envio-cloud deployment endpoint arena-pulse-indexer <COMMIT_SHA>
```

This prints the **GraphQL query URL** — save it, the dashboard (step 2 of
Arena Pulse) will read all its data from here. You can also open the
deployment in your browser:

```
https://envio.dev/app/<your-org>/arena-pulse-indexer/<COMMIT_SHA>
```

Quick sanity check — open the endpoint URL pattern in a browser or run:

```graphql
{ Round(limit: 3, order_by: {startTime: desc}) {
    id status totalVolume betCount } }
```

You should see real rounds from the live game.

---

## Important: the 30-day development-plan rule

The free development plan **automatically deletes deployments older than
30 days** (plus soft limits: 100k events / 5 GB / 7 days idle → 7-day grace
period first). A fresh deploy now stays live through the whole judging phase,
so just don't delete it, and re-deploy if you ever get a deprecation notice.

Our event volume is tiny (a few thousand events/day — price ticks are the
bulk), so the soft limits are not a concern.

## Updating the indexer later

Push to the `envio` branch — if auto-deploy is on it redeploys automatically.
Otherwise register the new commit:

```bash
git push origin envio
envio-cloud deployment status arena-pulse-indexer <NEW_COMMIT_SHA> --watch-till-synced
```

## Reference

- Full CLI reference: https://docs.envio.dev/docs/HyperIndex/envio-cloud-cli
- Free HyperSync API token (only needed for local `pnpm dev`):
  https://envio.dev/app/api-tokens
