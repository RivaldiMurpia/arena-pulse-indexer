# Arena Pulse — Indexer

HyperIndex indexer for **Contex Arena** (`0x3b1d866777a8f26494249dfa7047f1ec9ffab563`)
on **Monad testnet** (chain id 10143). Built for the Monad Metropolis hackathon
**"Best Use of Envio"** bounty ($1,000, track-agnostic).

It indexes every bet, agent trade, round lifecycle event and price tick, and
maintains **derived analytics entities** (bettor leaderboards, per-round
per-agent stats) at index time. The companion dashboard (step 2) queries the
indexer's GraphQL endpoint.

> [!NOTE]
> This is a sidecar project. The `context-arena` repo is frozen — this indexer
> lives in its own repo and never modifies it.

## What it indexes

| Event | Entity writes |
|---|---|
| `AgentRegistered` | upsert `Agent` |
| `RoundStarted` | create `Round` (status `LIVE`) |
| `PriceUpdated` | append `PricePoint` |
| `AgentTrade` | append `Trade`; bump `Agent` trade/volume totals, `Round.tradeCount` |
| `BetPlaced` | upsert `Bet`; bump `Round` volume/betCount, `RoundAgentStat`, `Bettor` wagered |
| `RoundSettled` | finalize `Round` (`SETTLED`/`REFUND`); `Agent.roundsWon++` on real wins |
| `Claimed` | mark the bettor's `Bet` rows claimed + attributed `claimAmount`; bump `Bettor` claimed/wins |

Amounts are wei (18 decimals). `roundId`/`agentId` are stored as decimal strings.

## Schema

```
Agent ──1:n──▶ Trade ──n:1──▶ Round ◀──n:1── Bet ──n:1──▶ Bettor
  │              │               ▲                    │
  │              └───────────────┘                    │
  └─1:n──▶ Bet ──n:1──▶ RoundAgentStat (round × agent aggregates)
Round ──1:n──▶ PricePoint
```

- `Bet.id = "{roundId}-{bettor}-{agentId}"` — one row per position, mirroring
  the contract's `betOf[round][bettor][agent]` accumulation (repeat `BetPlaced`
  events sum into `amount`, counted by `betTxCount`).
- `Bettor`, `RoundAgentStat` and the counters on `Agent`/`Round` are
  **precomputed aggregates** — Envio's hosted GraphQL has no aggregation
  queries, so the dashboard reads these directly.
- `Claimed` attribution: in refund mode the payout is split across all of the
  bettor's bets pro-rata; in settled mode only bets on the winner receive a
  share (exactly how the contract pays out). `won = true` only for settled,
  non-refund claims.

## Run locally

Prerequisites: Node.js 22+, pnpm 8+, Docker (for Postgres).

```bash
pnpm install
pnpm codegen        # regenerate types from config.yaml / schema.graphql
pnpm test           # handler unit tests (in-memory, no network)
pnpm dev            # local indexer + Hasura console at http://localhost:8080
```

> Local dev uses Envio HyperSync. If it asks for a token, grab a free one at
> https://envio.dev/app/api-tokens and put it in `.env` as `ENVIO_API_TOKEN`.

Useful queries (Hasura console → API tab):

```graphql
# top bettors by volume
{ Bettor(order_by: {totalWagered: desc}, limit: 10) {
    id totalWagered totalClaimed winCount claimCount } }

# latest settled rounds with winners
{ Round(where: {status: {_eq: "SETTLED"}}, order_by: {settledAt: desc}, limit: 5) {
    id status winnerAgentId totalVolume betCount tradeCount } }

# per-agent betting volume in a round
{ RoundAgentStat(where: {round: {_eq: "12"}}) {
    agent volume betCount } }
```

## Project layout

```
config.yaml              # chain, contract, events, start block (66745181)
schema.graphql           # 7 entities + derived relations
src/handlers/ContextArena.ts   # all event handlers + aggregation logic
src/indexer.test.ts      # lifecycle tests (settled + refund rounds)
DEPLOY.md                # step-by-step Envio Cloud deploy runbook
```

## Versions

- `envio` npm package: **3.12.1** (pinned in package.json)
- Scaffolded with `envio init contract-import local` (contract not verified
  on the Monad testnet explorer, so the ABI was imported from the Foundry
  build artifact).
