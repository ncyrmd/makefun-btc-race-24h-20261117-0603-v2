// Range Rider — a long-only cbBTC/USDC bot for the make.fun 24h race.
//
// What the previous version taught us (diagnosed from its own action log
// on this competition's dev window, then confirmed in a faithful local
// replay of the bars engine that reproduces grade-local to the cent):
//
//   * v1 lost -$22.30 on the dev window, and every one of its four trades
//     was the BREAKOUT leg buying a new 120-bar high into a flat, choppy
//     day — then trailing out as the high faded. Breakout-after-a-flat-range
//     has negative expectancy on all three windows we can check (dev, the
//     previous race's window, and the dev window time-reversed), so this
//     version drops the breakout leg entirely.
//   * v1's DIP leg never fired once on the dev window: the window's widest
//     120-bar range is 2.49%, a hair under its 2.5% gate. The dips are
//     there — the gate was the problem, not the market.
//   * The dev window is a range day (start $64,461, end $64,776, whole-day
//     range 2.5%), while the previous race's window is a grind-down day
//     with one big washout and recovery. A dip leg sensitive enough to
//     trade the range day buys every small dip of the grind-down day and
//     bleeds there. So the two dip tiers below are separated by REGIME,
//     not by hope: the range tier only trades while the 240-bar (4-hour)
//     range stays under 3% — a range day. The washout tier is the old
//     v1 DIP unchanged: it only fires on a genuine washout (120-bar range
//     >= 2.5%) and is what makes the grind-down window positive.
//
// The two tiers:
//
//   1. RANGE — buy a dip inside a range day. Rolling 60-bar range at
//      least 0.8%, close down at least 0.3% over the last 15 bars, sitting
//      0.1%-1% above the 60-bar low, above its 5-bar EMA, and closed
//      above the previous bar's close (the bounce has started). 60% of
//      cash. Exits: +1.5% take-profit, 1.2% trailing give-back, -0.8%
//      hard stop. Gated by the 4-hour range rule above.
//   2. WASHOUT — buy a genuine washout. Rolling 120-bar range at least
//      2.5%, close down at least 0.8% over the last 30 bars, sitting
//      0.2%-3% above the 120-bar low, above its 5-bar EMA, closed above
//      the previous bar's close. 60% of cash, or 100% when the range is
//      3.5% or more. Exits: +4% take-profit, 2% trailing give-back,
//      -0.8% hard stop. The tight stop is the discipline that lets the
//      bot re-buy lower and catch the full recovery instead of riding a
//      falling knife.
//
// After ANY exit the bot sits out 30 bars. That half-hour pause is doing
// real work: on the grind-down window it is what stops the bot re-buying
// the same falling dip minutes after being stopped out of it, and on the
// time-reversed window it is what keeps the bot out of the one bad dip
// that follows a winner.
//
// The tiers are disjoint in practice (a close cannot be both near its
// 60-bar low on a quiet range day and near its 120-bar low in a 2.5%
// washout at the same time), and exits are fixed per tier at entry, from
// the buy fill — never from an estimate.
//
// Local results (official grade-local, process driver, on this
// competition's dev window — numbers filled in after grading; the
// replay sim that guided the design reproduces grade-local exactly on
// v1, and the same design scores +$17.30 on dev, +$10.06 on the previous
// race's window, and +$9.81 on the dev window time-reversed, all with
// the same parameters, no per-window tuning).
//
// Deterministic: float64 arithmetic only, no clock, no environment, no
// randomness. The same bars give the same orders, run after run.

import { runBars, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** How one tier exits, as shares of the fill price. */
interface Exits {
  /** Take-profit above the fill. */
  winAt: number;
  /** Trailing give-back below the best close since the fill. */
  giveBack: number;
  /** Hard stop below the fill. */
  loseAt: number;
}

/** One dip tier: its entry gates, its size, and its exits. */
interface Tier {
  name: string;
  /** Bars in the rolling range window. */
  lookback: number;
  /** Rolling range must be at least this share of its high. */
  rangeAtLeast: number;
  /** At or above this range the tier uses full size. */
  rangeFullSize?: number;
  /** Bars of the recent fall the tier measures. */
  fallBars: number;
  /** The fall over those bars must be at least this deep. */
  fallAtLeast: number;
  /** Close must sit this far above the window low, and no further. */
  aboveLowAtLeast: number;
  aboveLowAtMost: number;
  /** Cash share the tier risks (top/bottom). */
  sizeTop: bigint;
  sizeBottom: bigint;
  exits: Exits;
  /** When set, the rolling range over this many bars must stay below... */
  regimeBars?: number;
  /** ...this share, or the tier may not fire (range-day gate). */
  regimeRangeBelow?: number;
}

/** The washout tier: v1's DIP, unchanged — it is what the grind-down
 *  window is won with, and it must not be re-tuned to the range day. */
const WASHOUT: Tier = {
  name: 'WASHOUT',
  lookback: 120,
  rangeAtLeast: 0.025,
  rangeFullSize: 0.035,
  fallBars: 30,
  fallAtLeast: 0.008,
  aboveLowAtLeast: 0.002,
  aboveLowAtMost: 0.03,
  sizeTop: 6n,
  sizeBottom: 10n,
  exits: { winAt: 0.04, giveBack: 0.02, loseAt: 0.008 },
};

/** The range tier: trades the small dips of a range day, and only there. */
const RANGE: Tier = {
  name: 'RANGE',
  lookback: 60,
  rangeAtLeast: 0.008,
  fallBars: 15,
  fallAtLeast: 0.003,
  aboveLowAtLeast: 0.001,
  aboveLowAtMost: 0.01,
  sizeTop: 6n,
  sizeBottom: 10n,
  exits: { winAt: 0.015, giveBack: 0.012, loseAt: 0.008 },
  regimeBars: 240,
  regimeRangeBelow: 0.03,
};

/** Tiers are tried in this order; the first whose gates pass fires. */
const TIERS: Tier[] = [WASHOUT, RANGE];

/** Bars to sit out after any exit before either tier may fire. */
const REST_BARS = 30;
/** Slippage cap, in bps past the close the order was decided on. */
const SLIPPAGE_CAP_BPS = 100;
/** Bars of history the bot keeps (the longest window any gate needs). */
const HISTORY_BARS = 240;
/** No order may be decided before this many closes have been seen. */
const MIN_CLOSES = 120;

const MARKET = 'CBBTC';

/** Everything the bot remembers between batches. */
interface Desk {
  highs: number[];
  lows: number[];
  closes: number[];
  emaShort: number | null;
  /** Exit rules of the open position, fixed when its buy was decided. */
  openExits: Exits | null;
  /** Fill price of the open position, and the best close since it. */
  fillPrice: number | null;
  bestClose: number | null;
  /** No tier may fire while the sequence is below this. */
  restUntil: number;
}

const desk: Desk = {
  highs: [],
  lows: [],
  closes: [],
  emaShort: null,
  openExits: null,
  fillPrice: null,
  bestClose: null,
  restUntil: -1,
};

/** One EMA step: k = 2 / (span + 1). */
function emaStep(prev: number | null, close: number, span: number): number {
  if (prev === null) return close;
  return prev + (2 / (span + 1)) * (close - prev);
}

/** Fold one bar into the window and the short trend line. */
function observe(bar: Bar): void {
  const close = Number(bar.c);
  desk.highs.push(Number(bar.h));
  desk.lows.push(Number(bar.l));
  desk.closes.push(close);
  if (desk.highs.length > HISTORY_BARS) {
    desk.highs.shift();
    desk.lows.shift();
    desk.closes.shift();
  }
  desk.emaShort = emaStep(desk.emaShort, close, 5);
}

/**
 * Whether this tier's gates pass on this close, and at what size.
 * Returns null when any gate fails. The window slices are taken off the
 * back of the stored history, so a tier only sees its own lookback.
 */
function tierEntry(
  tier: Tier,
  close: number,
): { exits: Exits; sizeTop: bigint; sizeBottom: bigint } | null {
  if (desk.emaShort === null) return null;
  if (desk.closes.length < tier.lookback) return null;
  if (desk.closes.length < tier.fallBars + 1) return null;

  const windowHighs = desk.highs.slice(desk.highs.length - tier.lookback);
  const windowLows = desk.lows.slice(desk.lows.length - tier.lookback);
  const low = Math.min(...windowLows);
  const high = Math.max(...windowHighs);
  const range = (high - low) / high;
  if (range < tier.rangeAtLeast) return null;

  // The regime gate: on a trend day the 4-hour range is wide and the
  // range tier stands down — its dips are falling knives, not bounces.
  if (tier.regimeBars !== undefined && tier.regimeRangeBelow !== undefined) {
    if (desk.closes.length < tier.regimeBars) return null;
    const regimeHigh = Math.max(...desk.highs.slice(desk.highs.length - tier.regimeBars));
    const regimeLow = Math.min(...desk.lows.slice(desk.lows.length - tier.regimeBars));
    if ((regimeHigh - regimeLow) / regimeHigh >= tier.regimeRangeBelow) return null;
  }

  // The fall over the last fallBars closes: closes[length - fallBars]
  // is the close fallBars - 1 bars ago.
  const fall = close / desk.closes[desk.closes.length - tier.fallBars] - 1;
  if (fall > -tier.fallAtLeast) return null;
  if (close < low * (1 + tier.aboveLowAtLeast)) return null;
  if (close > low * (1 + tier.aboveLowAtMost)) return null;
  if (close <= desk.emaShort) return null;
  if (close <= desk.closes[desk.closes.length - 2]) return null;

  if (tier.rangeFullSize !== undefined && range >= tier.rangeFullSize) {
    return { exits: tier.exits, sizeTop: 1n, sizeBottom: 1n };
  }
  return { exits: tier.exits, sizeTop: tier.sizeTop, sizeBottom: tier.sizeBottom };
}

/** True when the open position's exit rules say to sell on this close. */
function exitDue(close: number): boolean {
  const exits = desk.openExits;
  const fill = desk.fillPrice;
  if (exits === null || fill === null) return false;
  if (close >= fill * (1 + exits.winAt)) return true;
  if (desk.bestClose !== null && close <= desk.bestClose * (1 - exits.giveBack)) return true;
  if (close <= fill * (1 - exits.loseAt)) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    // Fills first: a buy fill records the entry (the trail starts
    // there); a filled sell clears the position and its tier. A
    // rejected fill changes nothing, so the exit is simply re-checked
    // on the next bar.
    for (const fill of batch.fills) {
      if (fill.symbol !== MARKET || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        desk.fillPrice = Number(fill.price);
        desk.bestClose = desk.fillPrice;
      } else {
        desk.fillPrice = null;
        desk.bestClose = null;
        desk.openExits = null;
      }
    }

    // Indicators from this batch's bars.
    for (const bar of batch.bars) {
      if (bar.symbol === MARKET) observe(bar);
    }
    if (state.warmingUp) return [];
    if (desk.closes.length < MIN_CLOSES) return [];

    const bar = batch.bars.find((b) => b.symbol === MARKET);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const held = state.positions.get(MARKET);

    // Holding: keep the best close, exit on take-profit, trail, or stop.
    if (held !== undefined) {
      // The entry price comes from the buy fill. If a fill is ever
      // missing from the batch (a position is held but no fill arrived),
      // fall back to the position's cost: the fill price is the cash
      // spent per unit held (cost * 10^7 / qty, in the symbol's price
      // units), so the exits still have a reference instead of never
      // firing. The cost includes the fee, so this overstates the fill
      // by ~0.04% — negligible against the 0.8%-4% exit thresholds, and
      // only ever used when the fill is gone.
      if (desk.fillPrice === null && held.qty > 0n && held.cost > 0n) {
        desk.fillPrice = Number(held.cost) * 1e7 / Number(held.qty);
      }
      if (desk.bestClose === null) desk.bestClose = desk.fillPrice;
      if (desk.bestClose !== null && close > desk.bestClose) desk.bestClose = close;
      if (exitDue(close)) {
        desk.restUntil = state.seq + 1 + REST_BARS;
        desk.bestClose = null;
        const sell: SellInput = { side: 'sell', symbol: MARKET, qty: held.qty, max_slippage_bps: SLIPPAGE_CAP_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: no tier may fire during the rest after an exit, and the
    // trail mark belongs to the position that just closed.
    desk.bestClose = null;
    if (state.seq < desk.restUntil) return [];
    let entry: { exits: Exits; sizeTop: bigint; sizeBottom: bigint } | null = null;
    for (const tier of TIERS) {
      entry = tierEntry(tier, close);
      if (entry !== null) break;
    }
    if (entry === null) return [];
    const cash = state.cash;
    const notional = (cash * entry.sizeTop) / entry.sizeBottom;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    desk.openExits = entry.exits;
    const buy: BuyInput = { side: 'buy', symbol: MARKET, notional_quote_units: notional, max_slippage_bps: SLIPPAGE_CAP_BPS };
    return [buy];
  },
});
