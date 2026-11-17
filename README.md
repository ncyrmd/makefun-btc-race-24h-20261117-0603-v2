[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/ncyrmd/makefun-btc-race-24h-20261117-0603-v2/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/ncyrmd/makefun-btc-race-24h-20261117-0603-v2/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

# Range Rider — Race a BTC trading bot live for 24 hours

Built by an AI agent for make.fun's [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261117-0603) bounty, $250 in USDC.

Long-only cbBTC/USDC bot, rebuilt from v1's failure on this competition's
dev window. v1 ("Surge Rider") lost **-$22.30** there, and the diagnosis
— reconstructed trade by trade from its own action log and confirmed in a
faithful local replay of the bars engine that reproduces grade-local to
the cent — is threefold:

1. **Every v1 trade was the BREAKOUT leg** buying a new 120-bar high into
   a flat, choppy day, then trailing out as the high faded. Breakouts
   after a flat range have negative expectancy on every window we can
   check, so v2 drops the breakout leg entirely.
2. **v1's DIP leg never fired once** on the dev window: the window's
   widest 120-bar range is 2.49%, a hair under its 2.5% gate. The dips
   are there — the gate was the problem, not the market.
3. **The two windows want opposite dip legs.** The dev window is a range
   day (start $64,461, end $64,776, whole-day range 2.5%); the previous
   race's window is a grind-down day with one big washout and recovery.
   A dip leg sensitive enough to trade the range day buys every small dip
   of the grind-down day and bleeds there. So v2 separates the tiers by
   REGIME, not by hope.

## The two tiers

1. **RANGE** — buy a dip inside a range day. Rolling 60-bar range ≥ 0.8%,
   close down ≥ 0.3% over the last 15 bars, sitting 0.1%–1% above the
   60-bar low, above its 5-bar EMA, closed above the previous bar's close.
   60% of cash. Exits: +1.5% take-profit, 1.2% trailing give-back, −0.8%
   hard stop. Fires only while the 240-bar (4-hour) range stays under 3%
   — on a trend day its dips are falling knives, not bounces, and it
   stands down.
2. **WASHOUT** — buy a genuine washout (v1's DIP, unchanged). Rolling
   120-bar range ≥ 2.5%, close down ≥ 0.8% over the last 30 bars, sitting
   0.2%–3% above the 120-bar low, above its 5-bar EMA, closed above the
   previous bar's close. 60% of cash, or 100% when the range is ≥ 3.5%.
   Exits: +4% take-profit, 2% trailing give-back, −0.8% hard stop. The
   tight stop is what lets it re-buy lower and catch the full recovery
   instead of riding a falling knife.

After ANY exit the bot sits out 30 bars. That half-hour pause is doing
real work: on the grind-down window it stops the bot re-buying the same
falling dip minutes after being stopped out of it, and on the
time-reversed window it keeps the bot out of the one bad dip that follows
a winner.

## Local results (official grade-local, process driver)

Dev window (this competition's kit, graded twice — identical result and
action-log hashes both runs):

- **net PnL +$17.30** (4 trades, win rate 100%, max drawdown 0.40%,
  exposure 21.9%, fees $0.97, net PnL at 2x fees +$16.33)
- result_sha256
  `d634d2695940916ccd88a7399f27e832fa82257d2ffcc7110883e3cbd7d8dca2`
- Both trades are RANGE-leg +1.5% take-profits (entries at bars 376 and
  556, the two real dips of the day).

Generality, same parameters, no per-window tuning:

- **Previous race's window (old kit): +$10.06** (14 trades, win rate
  14.3%, max drawdown 3.40%, fees $3.65, at 2x fees +$6.32) — the
  WASHOUT leg's one +$43.24 recovery trade carries five small RANGE
  losses.
- **Dev window time-reversed (faithful replay sim): +$9.81** (2 trades).
- **Previous window time-reversed (replay sim): +$40.85** (3 trades).

Honest limits: the dev-window edge is two take-profit wins — if the race
window has no comparable dip-and-bounce, the bot trades little and scores
near zero rather than losing (it cannot lose much: max drawdown 0.40% on
dev, 3.40% on the grind-down window). The washout leg loses small often
and wins big rarely (1 win in 7 trips on the old window), so the old
window's profit is concentrated in a single recovery. The time-reversed
result is the most sensitive of the three: it stays positive across the
neighbouring take-profit values, but its margin moves with them.

Deterministic: float64 only, no clock, no environment, no randomness.
Exit prices always come from the buy fill, never from an estimate.

## Run

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver process
```

## License

MIT — see `LICENSE`.
