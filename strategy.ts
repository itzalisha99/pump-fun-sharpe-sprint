// Steady Scalper — a Sharpe-first paper bot for the pump.fun replay.
//
// Rank is by HOURLY Sharpe, not PnL, so this bot chases steady, repeatable wins
// with tight downside control, not moonshots: it buys only coins that survived a
// dump and printed a fresh high, rides the winners with a wide trailing stop,
// cuts every loser at -20%, and never holds a position longer than 1200 slots.
//
// Entry (pullback-then-breakout, the shipped mode): a curve 60-3000 slots old
// whose price retraced at least 20% from its tape high, then printed a new high
// at least 10% above that high (and no more than 25% past it, so the entry is
// fresh), with at least 4 buys from at least 4 distinct wallets and net inflow
// >= 0.3 SOL over the last 20 trades, at least half of them buys. Real SOL
// reserves between 1 and 60. Chasing the first spike loses; surviving a dump
// and coming back is the signal. A momentum-ignition entry mode is also in this
// file, tried on the dev window and rejected there (it lost money).
//
// Sizing: 0.4 SOL per coin (or the 1%-of-real-reserve cap when smaller, never
// below 0.02 SOL), one position per coin, max 5 open, max 2.0 SOL exposure.
// Every round trip is >= 0.01 SOL (guardrail floor).
//
// Exits (checked every batch on the mark price, net of sell fees): take profit
// +75%, trailing stop 35% armed at +25%, hard stop -20%, max hold 1200 slots.
// No fade exit: cutting on flow noise cost more than it saved on dev.
//
// Guardrail pacing: the run needs >= 20 distinct coins with a >= 0.01 SOL round
// trip. When coins or fills lag the pace (25 coins / 60 fills over 6h), the bot
// opens tiny 0.012 SOL probe round trips on liquid curves and sells them as soon
// as they land (or after 200 slots).
//
// Speed: ring buffers with a head index (no splice), an incremental candidate set
// (only curves with an event in this batch are re-evaluated), exits checked only
// on held positions (<= 5). The tape high is committed with a one-batch lag so
// a breakout trade is judged against the high BEFORE it. No clock, no
// randomness, no I/O, no environment reads — deterministic.
//
// Two real bugs found and fixed during the build via the local sim: (1) the sell
// value was computed in lamports but compared against a cost in SOL, so every
// position was sold one batch after entry; (2) a sell that FAILED (2% seeded
// failed-tx draw) left its exiting flag set forever, stranding the position —
// failed/rejected sells now clear the flag and retry next batch.
//
// Written fresh in this session. Ideas only were taken from the kit's pilot
// momentum bot and our earlier pump.fun bots; no code was copied.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry trigger: 'momentum' (busy rising tape) or 'breakout' (pullback, then a new high). */
  entryMode: 'momentum' | 'breakout';
  /** Breakout: minimum retrace from the tape high before the breakout counts. */
  pullback: number;
  /** Breakout: price must print this far above the tape high to trigger. */
  breakoutUp: number;
  /** Breakout: do not enter once the price has already run this far past the breakout level. */
  breakoutMaxRun: number;
  /** Breakout: minimum buys / distinct buyers / net SOL over the last 20 trades. */
  breakoutMinBuys: number;
  breakoutMinBuyers: number;
  breakoutMinNetSol: number;
  /** Breakout: minimum share of buys among the last 20 trades. */
  breakoutMinBuyShare: number;
  /** Breakout: the tape high is the EARLY peak — only trades within this many
   *  slots of creation may raise it (0 = every trade may raise it). A frozen
   *  early peak is the level the breakout must beat. */
  peakWindow: number;
  /** Trades kept per curve tape (ring buffer capacity). */
  tapeCap: number;
  /** Entry window: last N trades of the tape. */
  windowTrades: number;
  /** Minimum buys in the window. */
  minBuys: number;
  /** Minimum distinct buying wallets in the window. */
  minBuyers: number;
  /** Minimum net SOL inflow (buys minus sells) over the window. */
  minNetSol: number;
  /** Minimum price rise over the window (fraction). */
  minPriceUp: number;
  /** Maximum price rise over the window (skip coins that already ran). */
  maxPriceUp: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Real SOL reserves at entry, min/max. */
  minRqSol: number;
  maxRqSol: number;
  /** Age in slots since CreateEvent, min/max. */
  minAge: number;
  maxAge: number;
  /** First buy (SOL), pyramid add (SOL), max per coin (SOL). */
  stakeSol: number;
  addSol: number;
  maxStakeSol: number;
  /** Price must be this far above the last buy's price to add. */
  addStep: number;
  /** Slippage bps on buys / sells. */
  buySlipBps: number;
  sellSlipBps: number;
  /** Exits (fractions vs cost / peak value). */
  takeProfit: number;
  trailArm: number;
  trail: number;
  stopLoss: number;
  /** Fade exit: net SOL over fadeWindow trades below this. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most main positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing targets over paceSecs. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  entryMode: 'breakout',
  pullback: 0.2,
  breakoutUp: 0.1,
  breakoutMaxRun: 0.25,
  breakoutMinBuys: 4,
  breakoutMinBuyers: 4,
  breakoutMinNetSol: 0.3,
  breakoutMinBuyShare: 0.5,
  peakWindow: 0,
  tapeCap: 64,
  windowTrades: 30,
  minBuys: 6,
  minBuyers: 5,
  minNetSol: 0.5,
  minPriceUp: 0.06,
  maxPriceUp: 1.2,
  nearHigh: 0.92,
  maxBuyerShare: 0.6,
  minRqSol: 1,
  maxRqSol: 60,
  minAge: 40,
  maxAge: 1200,
  stakeSol: 0.4,
  addSol: 0,
  maxStakeSol: 0.4,
  addStep: 0.12,
  buySlipBps: 5000,
  sellSlipBps: 10000,
  takeProfit: 0.75,
  trailArm: 0.25,
  trail: 0.35,
  stopLoss: 0.2,
  fadeWindow: 20,
  fadeNetSol: -1000,
  bigSellSol: 1000,
  maxHold: 1200,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  maxExposureSol: 2.0,
  targetCoins: 25,
  targetFills: 60,
  paceSecs: 21600,
  probeSol: 0.012,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Curve fee on a sell: 95 protocol + 30 creator bps. */
const SELL_FEE = 0.0125;

interface Tape {
  created: number | null;
  complete: boolean;
  entries: number;
  lastExit: number;
  /** Highest price seen on the tape, and the lowest price since that high.
   *  Updated with a one-batch lag (see commitPeaks): a breakout trade must be
   *  judged against the high BEFORE it, or it erases its own trigger. */
  peak: number;
  trough: number;
  /** Prices pushed since the last commit, with their slots. */
  staged: { slot: number; price: number }[];
  /** Ring buffers, capacity p.tapeCap. */
  slot: Float64Array;
  buy: Uint8Array;
  sol: Float64Array;
  user: string[];
  price: Float64Array;
  head: number;
  count: number;
}

interface Held {
  opened: number;
  peakValue: number;
  lastAddPrice: number;
  exiting: boolean;
}

interface Probe {
  stage: 'buying' | 'selling';
  opened: number;
  cost: number;
  exiting: boolean;
}

const priceOf = (vq: bigint, vt: bigint): number => (vt === 0n ? 0 : Number(vq) / Number(vt));

/** Net SOL received for selling `tokens` at current virtual reserves (fees + tx fee off).
 *  Reserves are in lamports, so the quote out is divided back to SOL. */
function sellValueSol(tokens: bigint, vq: bigint, vt: bigint, txFeeSol: number): number {
  const t = Number(tokens);
  if (t <= 0 || vt === 0n) return 0;
  const qLamports = (t * Number(vq)) / (Number(vt) + t);
  return (qLamports / LAMPORTS) * (1 - SELL_FEE) - txFeeSol;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, Probe>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        complete: false,
        entries: 0,
        lastExit: -1e12,
        peak: 0,
        trough: 0,
        staged: [],
        slot: new Float64Array(p.tapeCap),
        buy: new Uint8Array(p.tapeCap),
        sol: new Float64Array(p.tapeCap),
        user: new Array<string>(p.tapeCap),
        price: new Float64Array(p.tapeCap),
        head: 0,
        count: 0,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Tapes with staged (uncommitted) prices from the previous batch. */
  const stagedTapes = new Set<Tape>();

  /** Fold last batch's staged prices into peak/trough. Runs at the start of
   *  onBatch, before the new batch's events are folded, so a breakout is always
   *  judged against the high from BEFORE the trade that prints it. The peak is
   *  the EARLY peak: only trades within peakWindow slots of creation may raise
   *  it; the trough (lowest since the peak) keeps updating. */
  const commitPeaks = (): void => {
    for (const t of stagedTapes) {
      for (const s of t.staged) {
        const inWindow = p.peakWindow === 0 || t.created === null || s.slot - t.created <= p.peakWindow;
        if (inWindow && s.price > t.peak) {
          t.peak = s.price;
          t.trough = s.price;
        } else if (s.price < t.trough) {
          t.trough = s.price;
        }
      }
      t.staged.length = 0;
    }
    stagedTapes.clear();
  };

  /** Push one trade onto a tape's ring buffer; stage its price for the next batch. */
  const pushTrade = (t: Tape, slot: number, isBuy: boolean, sol: number, user: string, price: number): void => {
    const i = t.head;
    t.slot[i] = slot;
    t.buy[i] = isBuy ? 1 : 0;
    t.sol[i] = sol;
    t.user[i] = user;
    t.price[i] = price;
    t.head = (t.head + 1) % p.tapeCap;
    if (t.count < p.tapeCap) t.count++;
    t.staged.push({ slot, price });
    stagedTapes.add(t);
  };

  /** Read the last n trades of a tape in order (oldest first). Index 0 = oldest. */
  const windowTrades = (t: Tape, n: number): { slot: number; buy: boolean; sol: number; user: string; price: number }[] => {
    const k = Math.min(n, t.count);
    const out: { slot: number; buy: boolean; sol: number; user: string; price: number }[] = [];
    const start = (t.head - k + p.tapeCap * 2) % p.tapeCap;
    for (let j = 0; j < k; j++) {
      const i = (start + j) % p.tapeCap;
      out.push({ slot: t.slot[i]!, buy: t.buy[i] === 1, sol: t.sol[i]!, user: t.user[i]!, price: t.price[i]! });
    }
    return out;
  };

  /** Breakout entry: the coin pulled back from its tape high, then printed a new
   *  high with buyers back in the tape. Surviving a dump and coming back is the
   *  signal; chasing the first spike is not. */
  const breakoutSignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < 60 || age > 3000) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.entries >= p.maxEntries) return false;
    if (now - t.lastExit < p.cooldown) return false;
    if (t.peak <= 0 || t.trough > t.peak * (1 - p.pullback)) return false;
    const w = windowTrades(t, 20);
    if (w.length < 8) return false;
    const last = w[w.length - 1]!.price;
    if (last < t.peak * (1 + p.breakoutUp)) return false;
    if (last > t.peak * (1 + p.breakoutUp + p.breakoutMaxRun)) return false;
    let buys = 0;
    let net = 0;
    const buyers = new Set<string>();
    for (const tr of w) {
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) {
        buys++;
        buyers.add(tr.user);
      }
    }
    if (buys < p.breakoutMinBuys) return false;
    if (buyers.size < p.breakoutMinBuyers) return false;
    if (net < p.breakoutMinNetSol) return false;
    if (w.length > 0 && buys / w.length < p.breakoutMinBuyShare) return false;
    return true;
  };

  /** Entry signal on a tape at slot `now`, with the curve's real SOL reserves. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (p.entryMode === 'breakout') return breakoutSignal(t, now, rqSol);
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxAge) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.entries >= p.maxEntries) return false;
    if (now - t.lastExit < p.cooldown) return false;
    const w = windowTrades(t, p.windowTrades);
    if (w.length < 8) return false;
    let buys = 0;
    let net = 0;
    let buySol = 0;
    let high = 0;
    const buyers = new Map<string, number>();
    for (const tr of w) {
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) {
        buys++;
        buySol += tr.sol;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      }
      if (tr.price > high) high = tr.price;
    }
    if (buys < p.minBuys) return false;
    if (buyers.size < p.minBuyers) return false;
    if (net < p.minNetSol) return false;
    const first = w[0]!.price;
    const last = w[w.length - 1]!.price;
    if (first <= 0 || last <= 0) return false;
    const up = last / first - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    let biggest = 0;
    for (const v of buyers.values()) if (v > biggest) biggest = v;
    if (buySol > 0 && biggest / buySol > p.maxBuyerShare) return false;
    return true;
  };

  /** Fade / big-sell exit signal from a tape's recent trades. */
  const exitFlow = (t: Tape): boolean => {
    const w = windowTrades(t, p.fadeWindow);
    let net = 0;
    for (const tr of w) {
      if (!tr.buy && tr.sol >= p.bigSellSol) return true;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net < p.fadeNetSol;
  };

  const onBatch = (state: BotState, batch: Batch): OrderInput[] => {
    const now = batch.slot;
    const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS;
    const orders: OrderInput[] = [];
    let free = state.freeCashLamports();
    const txFee = state.txFeeLamports();

    // Commit last batch's prices into peak/trough BEFORE folding this batch,
    // so breakout signals judge against the high before the triggering trade.
    commitPeaks();

    // Track pacing clock from event block times.
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstTime === null) firstTime = e.block_time;
        lastTime = e.block_time;
        break;
      }
    }

    // Count my own fills (harness closes have client_ids starting with '_').
    // A sell that FAILED or was REJECTED leaves the position open: clear its
    // exiting flag so the exit loop retries it next batch (a 2% failed-tx draw
    // otherwise strands the position until the flatten).
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
      if ((f.status === 'failed' || f.status === 'rejected') && f.side === 'sell') {
        const h = held.get(f.mint);
        if (h !== undefined) h.exiting = false;
        const pr = probes.get(f.mint);
        if (pr !== undefined) pr.exiting = false;
      }
    }

    // Fold this batch's events into tapes. Only curves with events are touched.
    const touched = new Set<Pubkey>();
    for (const e of batch.events) {
      touched.add(e.mint);
      const t = tapeOf(e.mint);
      if (e.event === 'CreateEvent') {
        if (t.created === null) t.created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        pushTrade(t, e.slot, e.is_buy, Number(BigInt(e.sol_amount)) / LAMPORTS, e.user, price);
      } else {
        t.complete = true;
      }
    }

    // Sync held positions with the account: force-closed or sold positions leave.
    // A position with ANY order still pending (buy in flight) stays — its fill
    // has not landed yet, so the account cannot show it.
    for (const [mint] of held) {
      const pos = state.positions.get(mint);
      const hasPending = [...state.pending.values()].some((po) => po.order.mint === mint);
      if (pos === undefined && !hasPending) {
        held.delete(mint);
        const t = tapes.get(mint);
        if (t !== undefined) t.lastExit = now;
      }
    }
    // Sync probes the same way.
    for (const [mint, pr] of probes) {
      const pos = state.positions.get(mint);
      const hasPending = [...state.pending.values()].some((po) => po.order.mint === mint);
      if (pos === undefined && !hasPending && (pr.stage === 'selling' || pr.exiting)) {
        probes.delete(mint);
        const t = tapes.get(mint);
        if (t !== undefined) t.lastExit = now;
      }
    }

    // ---- exits on held positions (at most 5) ----
    const heldMints = [...held.keys()];
    for (const mint of heldMints) {
      const h = held.get(mint)!;
      if (h.exiting) continue;
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = sellValueSol(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFeeSol);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (cost <= 0) continue;
      if (value > h.peakValue) h.peakValue = value;
      const t = tapes.get(mint);
      let sell = false;
      if (value >= cost * (1 + p.takeProfit)) sell = true;
      else if (value <= cost * (1 - p.stopLoss)) sell = true;
      else if (value >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) sell = true;
      else if (now - h.opened >= p.maxHold) sell = true;
      else if (t !== undefined && exitFlow(t)) sell = true;
      if (sell) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
        h.exiting = true;
      }
    }

    // ---- probe sells ----
    for (const [mint, pr] of probes) {
      if (pr.stage !== 'selling' || pr.exiting) continue;
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = sellValueSol(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFeeSol);
      if (value >= pr.cost * 1.03 || value <= pr.cost * 0.95 || now - pr.opened >= 200) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
        pr.exiting = true; // one sell only; the sync step removes it once the fill lands
      }
    }

    // ---- entries ----
    let slots = p.maxMain - held.size;
    // Invested per held mint, recomputed from the landed cost plus buys still in
    // flight: a failed buy never inflates it, so it self-corrects every batch.
    const investedByMint = new Map<Pubkey, number>();
    for (const [mint] of held) {
      const pos = state.positions.get(mint);
      let inv = pos === undefined ? 0 : Number(pos.cost_lamports) / LAMPORTS;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'buy') inv += Number(BigInt(po.order.quote_lamports)) / LAMPORTS;
      }
      investedByMint.set(mint, inv);
    }
    let exposure = 0;
    for (const v of investedByMint.values()) exposure += v;
    const pendingBuyMints = new Set<Pubkey>();
    for (const po of state.pending.values()) if (po.order.side === 'buy') pendingBuyMints.add(po.order.mint);

    // Pyramid adds first (positions already held, signal still hot).
    for (const mint of heldMints) {
      const h = held.get(mint);
      if (h === undefined || h.exiting) continue;
      if (p.addSol <= 0) continue;
      const invested = investedByMint.get(mint) ?? 0;
      if (invested >= p.maxStakeSol) continue;
      if (pendingBuyMints.has(mint)) continue;
      const t = tapes.get(mint);
      const curve = state.curves.get(mint);
      if (t === undefined || curve === undefined || curve.complete) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (!entrySignal(t, now, rqSol)) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price < h.lastAddPrice * (1 + p.addStep)) continue;
      const amount = BigInt(Math.round(p.addSol * LAMPORTS));
      const cap = state.maxBuyLamports(mint);
      if (cap < amount) continue;
      if (free < amount + txFee) continue;
      if (exposure + p.addSol > p.maxExposureSol) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
      free -= amount + txFee;
      exposure += p.addSol;
      investedByMint.set(mint, invested + p.addSol);
      h.lastAddPrice = price;
      pendingBuyMints.add(mint);
    }

    // Fresh entries: only curves touched by this batch, in event order.
    if (slots > 0 && orders.length < state.hello.caps.max_orders_per_batch) {
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
        const mint = e.mint;
        if (held.has(mint) || probes.has(mint) || pendingBuyMints.has(mint)) continue;
        if (slots <= 0) break;
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        const t = tapes.get(mint);
        const curve = state.curves.get(mint);
        if (t === undefined || curve === undefined || curve.complete) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        const amount = BigInt(Math.round(p.stakeSol * LAMPORTS));
        const cap = state.maxBuyLamports(mint);
        // Take the stake, or the 1%-of-reserve cap when it is smaller — but never
        // below 0.02 SOL, so the round trip stays well above the 0.01 SOL floor.
        const buy = cap < amount ? cap : amount;
        if (buy < BigInt(Math.round(0.02 * LAMPORTS))) continue;
        if (free < buy + txFee) continue;
        if (exposure + Number(buy) / LAMPORTS > p.maxExposureSol) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        orders.push({ side: 'buy', mint, quote_lamports: buy, max_slippage_bps: p.buySlipBps });
        free -= buy + txFee;
        exposure += Number(buy) / LAMPORTS;
        slots -= 1;
        t.entries += 1;
        held.set(mint, { opened: now, peakValue: 0, lastAddPrice: price, exiting: false });
        pendingBuyMints.add(mint);
      }
    }

    // ---- guardrail pacing: probe round trips when coins/fills lag ----
    if (firstTime !== null && lastTime !== null && probes.size < p.maxProbes) {
      const elapsed = Math.max(0, lastTime - firstTime);
      const frac = Math.min(1, elapsed / p.paceSecs);
      const needCoins = myCoins.size < Math.floor(p.targetCoins * frac);
      const needFills = myFills < Math.floor(p.targetFills * frac);
      if ((needCoins || needFills) && elapsed > 60) {
        // Most liquid touched curve this batch that is not held and old enough.
        let best: Pubkey | null = null;
        let bestRq = 0;
        for (const mint of touched) {
          if (held.has(mint) || probes.has(mint) || pendingBuyMints.has(mint)) continue;
          const t = tapes.get(mint);
          const curve = state.curves.get(mint);
          if (t === undefined || curve === undefined || curve.complete) continue;
          if (t.created === null || now - t.created < 100) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (rqSol >= 5 && rqSol <= 60 && rqSol > bestRq) {
            bestRq = rqSol;
            best = mint;
          }
        }
        if (best !== null) {
          const amount = BigInt(Math.round(p.probeSol * LAMPORTS));
          const cap = state.maxBuyLamports(best);
          if (cap >= amount && free >= amount + txFee && orders.length < state.hello.caps.max_orders_per_batch) {
            orders.push({ side: 'buy', mint: best, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
            free -= amount + txFee;
            probes.set(best, { stage: 'selling', opened: now, cost: p.probeSol, exiting: false });
          }
        }
      }
    }

    // Prune stale tapes (old, not held, not probed) so the map stays small.
    if (tapes.size > 8000) {
      for (const [mint, t] of tapes) {
        if (tapes.size <= 8000) break;
        if (held.has(mint) || probes.has(mint)) continue;
        if (t.created !== null && now - t.created > 20000) tapes.delete(mint);
      }
    }

    return orders;
  };

  return { onBatch };
}
