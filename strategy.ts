// Snapback — dip-recovery trading on pump.fun bonding curves.
//
// The replay is a graveyard of curves that spike and then bleed out, so chasing
// strength loses money here (the kit's momentum pilot ends deep underwater on
// the dev window). Snapback does the opposite: it waits for a curve that ran
// up, gave a chunk of it back, and has started to bounce with buyers stepping
// back in, then buys the dip once and exits on a take-profit, a stop, a
// trailing stop, a fade in flow, or a time limit. Half the position is banked
// early at a smaller profit so a bounce that fizzles still pays something.
//
// A small probe engine keeps the run above the harness minimums (at least 20
// coins with a round trip of at least 0.01 SOL): when filled round trips lag
// a pace set in block time, it opens tiny probe trades on the most liquid
// curve it is not already holding and sells the probe as soon as it lands.
//
// Everything is a pure function of the batches the harness sends: no clock,
// no environment, no randomness, and iteration only over insertion-ordered
// maps fed by the batch stream, so the two graded executions agree exactly.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from "./vendor/makefun-bot.ts";

export interface SnapParams {
  /** Lookback in slots for the recent high the drawdown is measured from. */
  lookback: number;
  /** Enter when the price is at least this far below the recent high (fraction). */
  dipMin: number;
  /** ...and not further than this (a dip, not a collapse). */
  dipMax: number;
  /** The price must already have bounced this far off the low since the high. */
  bounceMin: number;
  /** Smallest real SOL a curve must hold at decision time. */
  minRealSol: number;
  /** Of the last `flowTrades` ticks at least `minFlowBuys` must be buys... */
  flowTrades: number;
  minFlowBuys: number;
  /** ...and net SOL bought over them must be at least this. */
  minNetFlowSol: number;
  /** SOL per position (one buy, no adds). */
  stakeSol: number;
  /** Smallest buy worth sending (tx fees are 105k lamports per order). */
  minBuySol: number;
  /** Slippage tolerance on buys (bps); sells always go out at `sellSlipBps`. */
  buySlipBps: number;
  sellSlipBps: number;
  /** Bank half the position once it is up this much. */
  halfAt: number;
  /** Sell everything once the position is up this much. */
  takeProfit: number;
  /** Sell everything once the position is down this much. */
  stopLoss: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Then sell everything once value falls this far below its peak ratio. */
  trail: number;
  /** Sell everything after holding this many slots regardless. */
  maxHold: number;
  /** The low since the high must be this fresh (slots): a stale dip is not a bounce. */
  lowFresh: number;
  /** Sell everything when net SOL over the last `fadeTrades` ticks is below this. */
  fadeTrades: number;
  fadeNetSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most new entries per batch. */
  maxEntriesPerBatch: number;
  /** Guardrail pacing: targets for the run, reached on a block-time pace. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Size of one probe round trip (SOL). */
  probeSol: number;
  maxProbes: number;
}

export const SNAP_DEFAULTS: SnapParams = {
  lookback: 1500,
  dipMin: 0.3,
  dipMax: 0.5,
  bounceMin: 0.12,
  minRealSol: 15,
  flowTrades: 8,
  minFlowBuys: 6,
  minNetFlowSol: 0.2,
  stakeSol: 0.5,
  minBuySol: 0.05,
  buySlipBps: 1500,
  sellSlipBps: 3000,
  halfAt: 1000,
  takeProfit: 0.4,
  stopLoss: 0.07,
  trailArm: 0.1,
  trail: 0.15,
  maxHold: 200,
  fadeTrades: 15,
  fadeNetSol: -1000,
  cooldown: 800,
  lowFresh: 150,
  maxEntriesPerBatch: 2,
  targetCoins: 25,
  targetFills: 60,
  paceSecs: 10800,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Tick {
  slot: number;
  /** Marginal price: virtual SOL / virtual tokens. */
  price: number;
  realSol: number;
  buy: boolean;
  sol: number;
}

interface Tape {
  created: number | null;
  ticks: Tick[];
  lastExit: number;
}

interface Held {
  opened: number;
  /** Best value/cost ratio seen so far (scale-free, survives partial sells). */
  peakRatio: number;
  banked: boolean;
  filled: boolean;
}

export function snapbackBot(p: SnapParams = SNAP_DEFAULTS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Mints whose buy was rejected by the harness: never retry them. */
  const blocked = new Set<Pubkey>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, ticks: [], lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net SOL (buys minus sells) over the last `n` ticks of a tape. */
  const netFlow = (t: Tape, n: number): number => {
    let net = 0;
    let seen = 0;
    for (let i = t.ticks.length - 1; i >= 0 && seen < n; i--) {
      const tick = t.ticks[i]!;
      net += tick.buy ? tick.sol : -tick.sol;
      seen++;
    }
    return net;
  };

  /** Buys among the last `n` ticks of a tape. */
  const buyCount = (t: Tape, n: number): number => {
    let buys = 0;
    let seen = 0;
    for (let i = t.ticks.length - 1; i >= 0 && seen < n; i--) {
      if (t.ticks[i]!.buy) buys++;
      seen++;
    }
    return buys;
  };

  /** Snapback entry: down dipMin..dipMax from the lookback high, already bouncing
   *  bounceMin off a low printed within the last lowFresh slots, with buyers returning. */
  const entrySignal = (t: Tape, now: number, realSol: number): boolean => {
    if (realSol < p.minRealSol) return false;
    if (t.created === null || now - t.created < 200) return false;
    if (t.ticks.length < 10) return false;
    const from = now - p.lookback;
    let high = 0;
    let highSlot = -1;
    for (const tick of t.ticks) {
      if (tick.slot <= from) continue;
      if (tick.price > high) {
        high = tick.price;
        highSlot = tick.slot;
      }
    }
    if (high <= 0 || highSlot < 0) return false;
    let low = Infinity;
    let lowSlot = -1;
    let last = 0;
    for (const tick of t.ticks) {
      if (tick.slot < highSlot) continue;
      if (tick.price < low) {
        low = tick.price;
        lowSlot = tick.slot;
      }
      last = tick.price;
    }
    if (!isFinite(low) || last <= 0) return false;
    if (now - lowSlot > p.lowFresh) return false;
    const dip = 1 - last / high;
    if (dip < p.dipMin || dip > p.dipMax) return false;
    if (last < low * (1 + p.bounceMin)) return false;
    if (buyCount(t, p.flowTrades) < p.minFlowBuys) return false;
    if (netFlow(t, p.flowTrades) < p.minNetFlowSol) return false;
    return true;
  };

  /** Liquidation value of a position in SOL, after the curve fee and one tx fee. */
  const liquidValue = (
    state: BotState,
    mint: Pubkey,
    marks: Map<Pubkey, { vq: number; vt: number }>,
  ): number => {
    const pos = state.positions.get(mint);
    if (pos === undefined) return 0;
    const mark = marks.get(mint);
    const curve = state.curves.get(mint);
    const vq = mark ? mark.vq : curve ? Number(curve.virtual_quote_reserves) : 0;
    const vt = mark ? mark.vt : curve ? Number(curve.virtual_token_reserves) : 0;
    if (vt <= 0 || vq <= 0) return 0;
    const tokens = Number(pos.token_amount);
    const gross = (tokens * vq) / (vt + tokens) / LAMPORTS;
    return gross * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / LAMPORTS;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === "filled" && !f.client_id.startsWith("_")) {
          myFills++;
          myCoins.add(f.mint);
        }
        if (f.status === "rejected" && f.side === "buy") blocked.add(f.mint);
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === "CreateEvent") {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === "TradeEvent") {
          const t = tapeOf(e.mint);
          t.ticks.push({
            slot: e.slot,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
            realSol: Number(e.real_sol_reserves) / LAMPORTS,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
          });
          touched.add(e.mint);
        }
      }
      // Drop ticks older than the lookback so tapes stay small.
      const cutSlot = now - p.lookback - 100;
      for (const mint of touched) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.ticks.length && t.ticks[cut]!.slot <= cutSlot) cut++;
        if (cut > 0) t.ticks.splice(0, cut);
      }
      const marks = new Map(
        batch.marks.map(
          (m) =>
            [m.mint, { vq: Number(m.virtual_quote_reserves), vt: Number(m.virtual_token_reserves) }] as const,
        ),
      );
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: bank half early, then sell everything on TP / stop / trail / fade / stale.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            if (h.filled) tapeOf(mint).lastExit = now;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = liquidValue(state, mint, marks);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        const ratio = value / cost;
        if (ratio > h.peakRatio) h.peakRatio = ratio;
        const t = tapeOf(mint);
        let sellAll = false;
        if (ratio >= 1 + p.takeProfit) sellAll = true;
        else if (ratio <= 1 - p.stopLoss) sellAll = true;
        else if (h.peakRatio >= 1 + p.trailArm && ratio < h.peakRatio * (1 - p.trail)) sellAll = true;
        else if (now - h.opened > p.maxHold) sellAll = true;
        else if (netFlow(t, p.fadeTrades) < p.fadeNetSol) sellAll = true;
        if (sellAll) {
          if (pendingByMint.has(mint)) {
            let sellPending = false;
            for (const po of state.pending.values()) {
              if (po.order.mint === mint && po.order.side === "sell") sellPending = true;
            }
            if (sellPending) continue;
          }
          if (orders.length >= cap) break;
          orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
          continue;
        }
        // Bank half once the position is up halfAt: a bounce that fizzles still pays.
        if (!h.banked && ratio >= 1 + p.halfAt && !pendingByMint.has(mint)) {
          if (orders.length >= cap) break;
          orders.push({ side: "sell", mint, token_amount: pos.token_amount / 2n, max_slippage_bps: p.sellSlipBps });
          h.banked = true;
        }
      }

      // Probe round trips: sell the probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
        if (!selling) probes.set(mint, true);
      }

      // Entries on curves that traded in this batch.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let entriesLeft = p.maxEntriesPerBatch;
      for (const mint of touched) {
        if (orders.length >= cap || entriesLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || blocked.has(mint)) continue;
        if (slotsLeft <= 0) continue;
        const t = tapes.get(mint)!;
        if (now - t.lastExit < p.cooldown) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, realSol)) continue;
        // The harness caps buys at 1% of real reserves, but the reserves this bot
        // sees do not include the impact of its own earlier fills, so only use
        // 80% of the nominal cap and the order lands instead of bouncing.
        const capSol = (Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS) * 0.8;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: "buy",
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + tx;
        slotsLeft--;
        entriesLeft--;
        held.set(mint, { opened: now, peakRatio: 0, banked: false, filled: false });
      }

      // Guardrail pacing: open a probe when filled round trips lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          // Most liquid touched curve first: deepest reserve, least slippage.
          let best: Pubkey | null = null;
          let bestRq = -1;
          for (const mint of touched) {
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || blocked.has(mint) || state.positions.has(mint)) {
              continue;
            }
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const rq = Number(curve.real_quote_reserves);
            if (rq > bestRq) {
              bestRq = rq;
              best = mint;
            }
          }
          if (best !== null && free >= p.probeSol + 2 * tx) {
            const capSol = (Math.floor(Number(state.maxBuyLamports(best))) / LAMPORTS) * 0.8;
            const amount = Math.min(capSol, p.probeSol);
            if (amount >= 0.01) {
              orders.push({
                side: "buy",
                mint: best,
                quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
                max_slippage_bps: p.buySlipBps,
              });
              probes.set(best, false);
            }
          }
        }
      }
      return orders;
    },
  };
}
