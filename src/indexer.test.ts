/**
 * Arena Pulse — handler unit tests using Envio's in-memory test indexer.
 * Simulates a full round lifecycle (agents → bets → trades → settle → claim)
 * plus a refund-mode round, and asserts the derived aggregates.
 */
import { describe, it } from "vitest";
import { createTestIndexer } from "envio";

const MON = 10n ** 18n;

const AGENT0_WALLET = "0x1111111111111111111111111111111111111111";
const AGENT1_WALLET = "0x2222222222222222222222222222222222222222";
const BETTOR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BETTOR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type SimEvent = {
  contract: "ContextArena";
  event:
    | "AgentRegistered"
    | "RoundStarted"
    | "PriceUpdated"
    | "AgentTrade"
    | "BetPlaced"
    | "RoundSettled"
    | "Claimed";
  params: Record<string, bigint | string | boolean>;
};

async function run(events: SimEvent[]) {
  const indexer = createTestIndexer();
  await indexer.process({ chains: { 10143: { simulate: events } } });
  return indexer;
}

describe("full round lifecycle (settled, non-refund)", () => {
  it("maintains correct derived aggregates end to end", async (t) => {
    const indexer = await run([
      { contract: "ContextArena", event: "AgentRegistered", params: { agentId: 0n, name: "Degen Dan", wallet: AGENT0_WALLET } },
      { contract: "ContextArena", event: "AgentRegistered", params: { agentId: 1n, name: "The Professor", wallet: AGENT1_WALLET } },
      { contract: "ContextArena", event: "RoundStarted", params: { roundId: 0n, endTime: 1700000000n, startPrice: 100n * MON } },
      // bettor A places two bets on agent 0 -> accumulate into one Bet row
      { contract: "ContextArena", event: "BetPlaced", params: { roundId: 0n, bettor: BETTOR_A, agentId: 0n, amount: 1n * MON } },
      { contract: "ContextArena", event: "BetPlaced", params: { roundId: 0n, bettor: BETTOR_A, agentId: 0n, amount: 2n * MON } },
      // bettor B bets on agent 1
      { contract: "ContextArena", event: "BetPlaced", params: { roundId: 0n, bettor: BETTOR_B, agentId: 1n, amount: 5n * MON } },
      { contract: "ContextArena", event: "PriceUpdated", params: { roundId: 0n, price: 101n * MON } },
      { contract: "ContextArena", event: "AgentTrade", params: { roundId: 0n, agentId: 0n, isBuy: true, amountIn: MON / 2n, amountOut: 50n * MON, price: 100n * MON } },
      // pool = 8 MON, winning bets (agent 0) = 3 MON -> settle, agent 0 wins
      { contract: "ContextArena", event: "RoundSettled", params: { roundId: 0n, winnerAgentId: 0n, endPrice: 120n * MON, refundMode: false } },
      // bettor A claims: payout = 3 * 8 / 3 = 8 MON
      { contract: "ContextArena", event: "Claimed", params: { roundId: 0n, bettor: BETTOR_A, amount: 8n * MON } },
    ]);

    // Agents
    const agent0 = await indexer.Agent.getOrThrow("0");
    t.expect(agent0.name).toBe("Degen Dan");
    t.expect(agent0.totalTrades).toBe(1);
    t.expect(agent0.totalBuyVolume).toBe(MON / 2n);
    t.expect(agent0.totalSellVolume).toBe(0n);
    t.expect(agent0.roundsWon).toBe(1);
    t.expect(typeof agent0.registeredAt).toBe("bigint");

    const agent1 = await indexer.Agent.getOrThrow("1");
    t.expect(agent1.roundsWon).toBe(0);

    // Round
    const round = await indexer.Round.getOrThrow("0");
    t.expect(round.status).toBe("SETTLED");
    t.expect(round.totalVolume).toBe(8n * MON);
    t.expect(round.betCount).toBe(3);
    t.expect(round.tradeCount).toBe(1);
    t.expect(round.winnerAgentId).toBe("0");
    t.expect(round.endPrice).toBe(120n * MON);
    t.expect(round.settledAt).toBeTypeOf("bigint");

    // Bets — A's two placements accumulated into one row
    const betA = await indexer.Bet.getOrThrow(`0-${BETTOR_A}-0`);
    t.expect(betA.amount).toBe(3n * MON);
    t.expect(betA.betTxCount).toBe(2);
    t.expect(betA.claimed).toBe(true);
    t.expect(betA.won).toBe(true);
    t.expect(betA.claimAmount).toBe(8n * MON);

    const betB = await indexer.Bet.getOrThrow(`0-${BETTOR_B}-1`);
    t.expect(betB.amount).toBe(5n * MON);
    t.expect(betB.claimed).toBe(false);
    t.expect(betB.won).toBe(false);

    // Bettor aggregates
    const bettorA = await indexer.Bettor.getOrThrow(BETTOR_A);
    t.expect(bettorA.totalWagered).toBe(3n * MON);
    t.expect(bettorA.totalClaimed).toBe(8n * MON);
    t.expect(bettorA.betCount).toBe(2);
    t.expect(bettorA.winCount).toBe(1);
    t.expect(bettorA.claimCount).toBe(1);

    // Per-round-per-agent stats
    const stat00 = await indexer.RoundAgentStat.getOrThrow("0-0");
    t.expect(stat00.volume).toBe(3n * MON);
    t.expect(stat00.betCount).toBe(2);
    const stat01 = await indexer.RoundAgentStat.getOrThrow("0-1");
    t.expect(stat01.volume).toBe(5n * MON);
    t.expect(stat01.betCount).toBe(1);

    // Price point recorded
    const points = await indexer.PricePoint.getWhere({ round: { _eq: "0" } });
    t.expect(points.length).toBe(1);
    t.expect(points[0]!.price).toBe(101n * MON);

    // Trade recorded
    const trades = await indexer.Trade.getWhere({ round: { _eq: "0" } });
    t.expect(trades.length).toBe(1);
    t.expect(trades[0]!.isBuy).toBe(true);
  });
});

describe("refund-mode round", () => {
  it("refunds without counting wins", async (t) => {
    const indexer = await run([
      { contract: "ContextArena", event: "AgentRegistered", params: { agentId: 0n, name: "Degen Dan", wallet: AGENT0_WALLET } },
      { contract: "ContextArena", event: "RoundStarted", params: { roundId: 1n, endTime: 1700000000n, startPrice: 100n * MON } },
      { contract: "ContextArena", event: "BetPlaced", params: { roundId: 1n, bettor: BETTOR_A, agentId: 0n, amount: 2n * MON } },
      { contract: "ContextArena", event: "RoundSettled", params: { roundId: 1n, winnerAgentId: 0n, endPrice: 90n * MON, refundMode: true } },
      { contract: "ContextArena", event: "Claimed", params: { roundId: 1n, bettor: BETTOR_A, amount: 2n * MON } },
    ]);

    const round = await indexer.Round.getOrThrow("1");
    t.expect(round.status).toBe("REFUND");

    const bet = await indexer.Bet.getOrThrow(`1-${BETTOR_A}-0`);
    t.expect(bet.claimed).toBe(true);
    t.expect(bet.won).toBe(false);
    t.expect(bet.claimAmount).toBe(2n * MON);

    const bettorA = await indexer.Bettor.getOrThrow(BETTOR_A);
    t.expect(bettorA.totalClaimed).toBe(2n * MON);
    t.expect(bettorA.winCount).toBe(0);
    t.expect(bettorA.claimCount).toBe(1);

    const agent0 = await indexer.Agent.getOrThrow("0");
    t.expect(agent0.roundsWon).toBe(0);
  });
});
