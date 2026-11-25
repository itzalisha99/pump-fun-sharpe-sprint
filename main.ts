// Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins.
// Entry point: the grader runs `node /bot/main.ts` (Node 22, TypeScript stripped).
// The strategy lives in strategy.ts; the wire protocol in vendor/makefun-bot.ts
// (the kit's SDK shim, vendored byte-identical).
//
// This file also carries the configuration gate: before the bot starts, it checks
// the shipped parameters against the competition's own guardrails (round trips of
// at least 0.01 SOL, at most 5 open positions, max drawdown 50%, capital 10 SOL)
// and refuses to start misconfigured, so a typo in a parameter can never turn
// into a silent guardrail failure in grading. Diagnostics go to stderr only —
// stdout carries the protocol replies and must stay clean.

import { LAMPORTS_PER_SOL, runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS, type Params } from './strategy.ts';

/** Fail fast when the shipped parameters break the competition's guardrails. */
function validate(p: Params): void {
  const problems: string[] = [];
  if (p.stakeSol < 0.01) problems.push(`stakeSol ${p.stakeSol} is below the 0.01 SOL round-trip floor`);
  if (p.probeSol < 0.01) problems.push(`probeSol ${p.probeSol} is below the 0.01 SOL round-trip floor`);
  if (p.maxMain > 5) problems.push(`maxMain ${p.maxMain} exceeds the 5 open-position cap`);
  if (p.maxExposureSol > 10) problems.push(`maxExposureSol ${p.maxExposureSol} exceeds the 10 SOL capital`);
  if (p.takeProfit <= 0) problems.push(`takeProfit ${p.takeProfit} must be positive`);
  if (p.stopLoss <= 0 || p.stopLoss >= 1) problems.push(`stopLoss ${p.stopLoss} must be between 0 and 1`);
  if (p.trail < 0 || p.trail >= 1) problems.push(`trail ${p.trail} must be between 0 and 1`);
  if (p.targetCoins < 20) problems.push(`targetCoins ${p.targetCoins} is below the 20-coin guardrail`);
  if (p.maxHold <= 0) problems.push(`maxHold ${p.maxHold} must be positive`);
  if (problems.length > 0) {
    throw new Error(`pump-fun-sharpe-sprint: bad parameters:\n- ${problems.join('\n- ')}`);
  }
}

validate(DEFAULT_PARAMS);

const bot = createStrategy(DEFAULT_PARAMS);
const startedAt = { batches: 0 };

await runBot({
  onHello(state) {
    console.error(
      `[sharpe-sprint] hello: capital ${state.hello.capital.lamports} lamports, ` +
        `max ${state.hello.caps.max_open_positions} positions, latency ${state.hello.latency_slots} slots, ` +
        `mode ${DEFAULT_PARAMS.entryMode}, stake ${DEFAULT_PARAMS.stakeSol} SOL`,
    );
  },
  onBatch(state, batch) {
    startedAt.batches++;
    return bot.onBatch!(state, batch);
  },
  onDone(state, done) {
    const start = BigInt(state.hello.capital.lamports);
    const end = BigInt(done.account.cash_lamports);
    const pnlSol = Number(end - start) / Number(LAMPORTS_PER_SOL);
    console.error(
      `[sharpe-sprint] done (${done.reason}): ${startedAt.batches} batches, ` +
        `final cash ${done.account.cash_lamports} lamports, net PnL ${pnlSol.toFixed(4)} SOL`,
    );
  },
});
