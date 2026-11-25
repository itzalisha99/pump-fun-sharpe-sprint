# Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/itzalisha99/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/itzalisha99/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the make.fun **Pump.fun Sharpe Sprint** bounty. It trades
paper SOL on a 6-hour pump.fun replay. Places go by **hourly Sharpe ratio**, so the
bot is built for steady, controlled gains — not one lucky moonshot.

## Strategy: pullback-then-breakout

Most pump.fun coins spike and die. Chasing the first spike loses, and buying the
dip loses too. The edge is in coins that **survive a dump and come back**:

1. **Pullback first** — the price must have retraced at least 20% from its tape high.
2. **Breakout second** — buy only when the price prints a new high at least 10%
   above that high, with at least 4 buys from 4 distinct wallets and net inflow
   over the last 20 trades. The breakout proves buyers are back.
3. **Ride it, cut it** — take profit +75%, a 35% trailing stop armed at +25%,
   a −20% hard stop, and a 1200-slot hold limit. No fade exit: cutting on flow
   noise cost more than it saved on the dev window.
4. **Small, capped stakes** — 0.4 SOL per coin (or the 1%-of-real-reserve cap when
   smaller), at most 5 open at once, max 2.0 SOL exposure. Every round trip is
   ≥ 0.01 SOL.

A guardrail pacer keeps the run above the 20-coin minimum: when coins or fills
lag the pace (25 coins / 60 fills over 6h), the bot opens tiny 0.012 SOL probe
round trips on liquid curves.

## Local result (dev window, official grader)

`grade-local --driver process`: **+0.438 SOL net PnL** (+4.38%), 179 fills over
43 coins, 90 round trips, 22.2% win rate, 5.0% max drawdown, 0 rejected.
Guardrails met. Two executions reproduced byte for byte (deterministic).
At 2x fees the bot still nets +0.267 SOL. Honest note: the top 3 coins made 62%
of the gains — the final window is unseen data, so no dev number is a promise.

## Files

- `main.ts` — entrypoint (`node /bot/main.ts`), plus a parameter gate that refuses
  to start if the shipped settings break the competition's guardrails.
- `strategy.ts` — the strategy (pullback-then-breakout; a momentum-ignition mode
  is also in the file, tried on dev and rejected there).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte-identical.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <this-repo> --driver process
```

No dependencies, no network, no secrets. Deterministic: no clock, no randomness,
no environment reads — the only randomness source is the harness seed.

## License

MIT — see [LICENSE](LICENSE).
