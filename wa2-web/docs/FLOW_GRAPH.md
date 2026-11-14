# FLOW_GRAPH — how the game flows (engine evidence + walkthrough join)

## Authoritative CFG (`cfg.json`, compiled by `tools/build_cfg.py`)

`tools/build_cfg.py` compiles every `.bnr` LSCR bytecode stream into structured
control-flow ASTs (`play`, `setG`, `setL`, `setGFlag`, `if`, `choice`, `sload`,
`scall`, `ret`, `gotitle`) backed by `Global.vrb` (29 variables) and `GFLAG.dat`.
This supersedes linear `terminals.json` guesses whenever `cfg.json` is loaded.

## Spine (`.bnr` SLoad + conditional branches)

Intro `1001→1013` (linear, 0 choices; IC replay variants `1008_020..1012_030`
entered via `scall`/`sload` when `GFlag 0` or `GFlag 1` is set) —`1013` sets
`GFlag 0` (`ic-end`) and `SLoad 2001`→

Closing common `2001→2019` → four file-lines:

- **Chiaki**: `2401→2402→2413` (Chiaki Normal, sets `GFlag 1` + `GFlag 24`) /
  `2401→2412` (Chiaki True, gated `GFlag 1` at `2003-242` opt1, sets `GFlag 23`) —
  via `2019-1484` opt1 (`Call Chiaki`, gated `G[9]>=3 && !G[12]`).
- **Mari**: `2501→2517` (sets `GFlag 25`) — via `2019-1484` opt2 (`Stop by the
  editorial office`, gated `G[10]>=3`).
- **Koharu**: `2301→2322` (sets `GFlag 22`) — via `2019-1484` opt3 fall-through
  to `2019-1512` opt1 (`Go to work`, gated `G[8]>=3 && !G[11]`).
- **Setsuna / CC Normal**: `2019-1512` opt2 (`Stay alone`) falls through to
  `2020`. `2020..2023` exit early to `2025` (`cc-normal1`, `GFlag 20`) if Setsuna
  requirements fail; otherwise `2020→2024→2026→2033` (`cc-setsuna`, `GFlag 21`)
  —`2033` loads `3001`→ Coda.

Coda common `3001→3016`:
- `3016-822` opt1 (`Let go of her hands`, gated `G[27]==0`) → `SLoad 3901→3909`
  (`coda-cheating`, `GFlag 32`).
- `3016-822` opt2 (`Turn my face away`) falls through to `3016-859`:
  - opt1 (`I love Setsuna`): if `s_flag` (`G[27]==0`) → `3024` (`coda-normal`,
    `GFlag 30`); if `G[27]==1` → `3017→3023→3201→3211` (`coda-setsuna-true`,
    `GFlag 33`).
  - opt2 (`I can't lie to Kazusa`, gated `G[5]>=6`) → `3017→3023→3101→3111`
    (`coda-kazusa-true`, `GFlag 31`).

Special Contents (`4000..4009`, `5000..5004`, `5100..5104`, `5200..5209`,
`5300..5303`, `5400..5401`, `6001..6005`, `6101..6104`, `7000..7300`) =
menu-gated extras, each ending at `GoTitle` (`terminals.json`).

## Choice semantics

- **Inline** (28 of 32): attitude/affection/route-flag picks; `.bnr` `IF` blocks
  branch directly inside the script (`2003`, `3014`, `3016-859`, etc.).
- **12/24 Router** (`2019-1484`, 3-way): opt1 → `2401` (Chiaki), opt2 → `2501`
  (Mari), opt3 → fall-through to `2019-1512`.
- **Work/stay** (`2019-1512`, 2-way): opt1 (`Go to work`) → `2301` (Koharu),
  opt2 (`Stay alone`) → fall-through to `2020`.
- **1/29 Final** (`3016-822`, 2-way): opt1 (`Let go of her hands`) → `3901`
  (Kazusa Cheating), opt2 (`Turn my face away`) → fall-through to `3016-859`.

## Statuses

`VERIFIED_IN_GAME` (2 nodes with `.bnr`-verified `goto` overrides: `2019-1484`,
`3016-822`) / `EXPERT_SOURCED` (29 nodes) / `NEEDS_PLAYTEST` (`3013-801` label
assignment) / `ENGINE_EVIDENCED` (`endings.json` & `terminals.json` backed by
`.bnr` `SLoad`/`GoTitle`/`SetGameFlag`).

