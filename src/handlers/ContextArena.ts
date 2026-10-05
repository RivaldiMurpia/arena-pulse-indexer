/*
 * Arena Pulse — event handlers for the Contex Arena contract.
 *
 * Indexing strategy:
 * - Raw logs become Trade / PricePoint rows (unique chainId_block_logIndex ids).
 * - Bet rows are keyed by (roundId, bettor, agentId) so repeated BetPlaced
 *   events accumulate exactly like the contract's `betOf[round][bettor][agent]`
 *   mapping — one row per position, not per transaction.
 * - Bettor, RoundAgentStat and the counters on Agent / Round are derived
 *   aggregates maintained here at index time (Envio's hosted GraphQL has no
 *   aggregations, so we precompute).
 *
 * Reorg safety: Envio rolls handlers back and replays them on reorgs, and
 * every `set` is an upsert keyed by a deterministic id, so replays are
 * naturally idempotent. Aggregates are always read-modify-written from the
 * current stored state (never blind increments from zero), which keeps them
 * correct across replays.
 */
import { indexer } from "envio";
import type {
  Agent,
  Bet,
  Bettor,
  EvmOnEventContext,
  PricePoint,
  Round,
  RoundAgentStat,
  Trade,
} from "envio";

type Context = EvmOnEventContext;

const ZERO_BETTORS: Omit<Bettor, "id"> = {
  totalWagered: 0n,
  totalClaimed: 0n,
  betCount: 0,
  winCount: 0,
  claimCount: 0,
};

function newRound(id: string, timestamp: number): Round {
  return {
    id,
    startTime: BigInt(timestamp),
    endTime: 0n,
    startPrice: 0n,
    endPrice: 0n,
    status: "LIVE",
    winnerAgentId: undefined,
    totalVolume: 0n,
    betCount: 0,
    tradeCount: 0,
    settledAt: undefined,
  };
}

/**
 * Rounds are always created by RoundStarted before any other round-scoped
 * event, but this guard keeps the indexer resilient if an event ever arrives
 * out of order (e.g. a config start_block change).
 */
async function getOrCreateRound(
  context: Context,
  roundId: string,
  timestamp: number,
): Promise<Round> {
  const existing = await context.Round.get(roundId);
  if (existing) return existing;
  const stub = newRound(roundId, timestamp);
  context.Round.set(stub);
  return stub;
}

// ── AgentRegistered → upsert Agent ────────────────────────────────
indexer.onEvent({ contract: "ContextArena", event: "AgentRegistered" }, async ({ event, context }) => {
  const id = event.params.agentId.toString();
  const existing = await context.Agent.get(id);

  const agent: Agent = {
    id,
    name: event.params.name,
    wallet: event.params.wallet,
    registeredAt: existing?.registeredAt ?? BigInt(event.block.timestamp),
    totalTrades: existing?.totalTrades ?? 0,
    totalBuyVolume: existing?.totalBuyVolume ?? 0n,
    totalSellVolume: existing?.totalSellVolume ?? 0n,
    roundsWon: existing?.roundsWon ?? 0,
  };
  context.Agent.set(agent);
});

// ── RoundStarted → create Round ───────────────────────────────────
indexer.onEvent({ contract: "ContextArena", event: "RoundStarted" }, async ({ event, context }) => {
  const id = event.params.roundId.toString();
  const existing = await context.Round.get(id);

  const round: Round = {
    ...(existing ?? newRound(id, event.block.timestamp)),
    // RoundStarted is authoritative for these fields even on replay.
    startTime: BigInt(event.block.timestamp),
    endTime: event.params.endTime,
    startPrice: event.params.startPrice,
    status: "LIVE",
    winnerAgentId: undefined,
    endPrice: 0n,
    settledAt: undefined,
  };
  context.Round.set(round);
});

// ── PriceUpdated → append PricePoint ──────────────────────────────
indexer.onEvent({ contract: "ContextArena", event: "PriceUpdated" }, async ({ event, context }) => {
  const roundId = event.params.roundId.toString();

  const pricePoint: PricePoint = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    round: roundId,
    price: event.params.price,
    timestamp: BigInt(event.block.timestamp),
  };
  context.PricePoint.set(pricePoint);

  await getOrCreateRound(context, roundId, event.block.timestamp);
});

// ── AgentTrade → append Trade, update Agent + Round aggregates ─────
indexer.onEvent({ contract: "ContextArena", event: "AgentTrade" }, async ({ event, context }) => {
  const roundId = event.params.roundId.toString();
  const agentId = event.params.agentId.toString();

  const trade: Trade = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    round: roundId,
    agent: agentId,
    isBuy: event.params.isBuy,
    amountIn: event.params.amountIn,
    amountOut: event.params.amountOut,
    price: event.params.price,
    timestamp: BigInt(event.block.timestamp),
  };
  context.Trade.set(trade);

  const agent = await context.Agent.get(agentId);
  if (agent) {
    const updated: Agent = {
      ...agent,
      totalTrades: agent.totalTrades + 1,
      totalBuyVolume: agent.totalBuyVolume + (event.params.isBuy ? event.params.amountIn : 0n),
      totalSellVolume: agent.totalSellVolume + (event.params.isBuy ? 0n : event.params.amountIn),
    };
    context.Agent.set(updated);
  } else {
    context.log.warn(`AgentTrade for unknown agent ${agentId} in round ${roundId}`);
  }

  const round = await getOrCreateRound(context, roundId, event.block.timestamp);
  context.Round.set({ ...round, tradeCount: round.tradeCount + 1 });
});

// ── BetPlaced → upsert Bet, update Round / RoundAgentStat / Bettor ─
indexer.onEvent({ contract: "ContextArena", event: "BetPlaced" }, async ({ event, context }) => {
  const roundId = event.params.roundId.toString();
  const agentId = event.params.agentId.toString();
  const bettorId = event.params.bettor;
  const amount = event.params.amount;

  // One row per (round, bettor, agent) — mirrors betOf[round][bettor][agent].
  const betId = `${roundId}-${bettorId}-${agentId}`;
  const existingBet = await context.Bet.get(betId);
  const bet: Bet = existingBet
    ? { ...existingBet, amount: existingBet.amount + amount, betTxCount: existingBet.betTxCount + 1 }
    : {
        id: betId,
        round: roundId,
        bettor: bettorId,
        agent: agentId,
        amount,
        betTxCount: 1,
        timestamp: BigInt(event.block.timestamp),
        claimed: false,
        claimAmount: 0n,
        won: false,
      };
  context.Bet.set(bet);

  const round = await getOrCreateRound(context, roundId, event.block.timestamp);
  context.Round.set({
    ...round,
    totalVolume: round.totalVolume + amount,
    betCount: round.betCount + 1,
  });

  const statId = `${roundId}-${agentId}`;
  const existingStat = await context.RoundAgentStat.get(statId);
  const stat: RoundAgentStat = existingStat
    ? { ...existingStat, volume: existingStat.volume + amount, betCount: existingStat.betCount + 1 }
    : { id: statId, round: roundId, agent: agentId, volume: amount, betCount: 1 };
  context.RoundAgentStat.set(stat);

  const existingBettor = await context.Bettor.get(bettorId);
  const bettor: Bettor = {
    id: bettorId,
    ...(existingBettor ?? ZERO_BETTORS),
    totalWagered: (existingBettor?.totalWagered ?? 0n) + amount,
    betCount: (existingBettor?.betCount ?? 0) + 1,
  };
  context.Bettor.set(bettor);
});

// ── RoundSettled → finalize Round, credit the winning Agent ───────
indexer.onEvent({ contract: "ContextArena", event: "RoundSettled" }, async ({ event, context }) => {
  const roundId = event.params.roundId.toString();
  const winnerAgentId = event.params.winnerAgentId.toString();

  const round = await getOrCreateRound(context, roundId, event.block.timestamp);
  context.Round.set({
    ...round,
    endPrice: event.params.endPrice,
    status: event.params.refundMode ? "REFUND" : "SETTLED",
    winnerAgentId,
    settledAt: BigInt(event.block.timestamp),
  });

  // No meaningful "winner" in refund mode — everyone just gets their stake back.
  if (!event.params.refundMode) {
    const agent = await context.Agent.get(winnerAgentId);
    if (agent) {
      context.Agent.set({ ...agent, roundsWon: agent.roundsWon + 1 });
    } else {
      context.log.warn(`RoundSettled for unknown agent ${winnerAgentId} in round ${roundId}`);
    }
  }
});

// ── Claimed → settle the bettor's positions, update Bettor ────────
// The contract allows exactly one claim per (round, bettor); the payout
// covers the bettor's whole position in that round:
// - refund mode: payout = sum of ALL the bettor's bets in the round
// - settled mode: payout = pro-rata share from bets on the WINNER only
// We attribute the payout across the eligible Bet rows proportionally so
// per-position claimAmount values sum back to the Claimed amount.
indexer.onEvent({ contract: "ContextArena", event: "Claimed" }, async ({ event, context }) => {
  const roundId = event.params.roundId.toString();
  const bettorId = event.params.bettor;
  const payout = event.params.amount;

  const round = await context.Round.get(roundId);
  const isRefund = round?.status === "REFUND";
  const winnerAgentId = round?.winnerAgentId;

  const bets = await context.Bet.getWhere({
    round: { _eq: roundId },
    bettor: { _eq: bettorId },
  });

  if (bets.length === 0) {
    context.log.warn(`Claimed event for ${bettorId} in round ${roundId} matched no Bet rows`);
  }

  const eligible = isRefund ? bets : bets.filter((b) => b.agent === winnerAgentId);
  const eligibleTotal = eligible.reduce((sum, b) => sum + b.amount, 0n);

  for (const b of bets) {
    const isEligible = isRefund || b.agent === winnerAgentId;
    const share = isEligible && eligibleTotal > 0n ? (b.amount * payout) / eligibleTotal : 0n;
    const updated: Bet = {
      ...b,
      claimed: true,
      claimAmount: share,
      won: isEligible && !isRefund,
    };
    context.Bet.set(updated);
  }

  const existingBettor = await context.Bettor.get(bettorId);
  const bettor: Bettor = {
    id: bettorId,
    ...(existingBettor ?? ZERO_BETTORS),
    totalClaimed: (existingBettor?.totalClaimed ?? 0n) + payout,
    claimCount: (existingBettor?.claimCount ?? 0) + 1,
    // In settled (non-refund) mode the contract only pays out to bettors who
    // backed the winner, so every such claim is a win.
    winCount: (existingBettor?.winCount ?? 0) + (isRefund ? 0 : 1),
  };
  context.Bettor.set(bettor);
});
