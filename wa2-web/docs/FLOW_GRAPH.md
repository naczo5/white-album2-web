# FLOW_GRAPH — how the game flows (engine evidence + walkthrough join)

## Spine (numeric file order, chapter-aware)

Intro `1001→1013` (linear, 0 choices) —`1013→2001` auto-transition→
Closing common `2001→2019` → four file-lines:

- Chiaki: `2301→2322` (via 2019 work/stay opt2 + `play: 2301`)
- Mari: `2401→2413` (via router opt2, gated mari aff)
- Common/Koharu/Setsuna/Normal: `2501→2517`
- Setsuna: `2020→2033` (fall-through) —`2033→3001` bridge→ Coda

Coda common `3001→3016` → split at 3016 (`Turn my face away` → `3901`
Kazusa side `3901→3909`; fall-through → `3017→3024→3101→3111→3201→3211`).
Special Contents (`4000s/5200s/6000s/7000s`) = menu-gated extras.

## Choice semantics

- **Inline** (27 of 32): attitude/affection picks, shared linear
  continuation (proven: 2004 decline-then-accept reversal). Engine records
  the pick into the flag model and continues. No gotos.
- **Router** (2019 12/24, 3-way): bare-id gotos `2401`/`2501`/fall-through.
- **Work/stay** (2019, 2-way): the only CATCH-adjacent choice; opt2 jumps
  file (`play: 2301`), opt1 continues. Evidence: parallel Dec-25-morning
  openings of 2301 vs 2020.
- **Final** (3016 1/29): bare goto `3901` on opt2; opt1 skips to cheating.

## Flag model (walkthrough-derived, NEEDS_PLAYTEST thresholds)

CC: `aff.{setsuna,koharu,mari,chiaki}` + route flags + `chiaki_true`
unlock (12/1 opt1 locked until Chiaki Normal cleared). Coda:
`aff.{s,k}`, `uwaki`, `s_flag`, `s_honest`. Gating is ADVISORY in v1
(shown with lock reasons, never hard-locks) until in-game verification
fixes the numbers. 12/24 + 12/31 + 2/14 dummies documented per node.

Caveat: every effect map below (including `EXPERT_SOURCED` ones like
`2013 flag_off: mari`, `2016 clear: chiaki`, `2017 aff_if_mari`, all Coda
`uwaki` splits) is a walkthrough derivation — but it now has engine
vocabulary behind it: script.pak `Global.vrb` names the live affection,
cheat, route-kill, and per-choice pick flags (15/15 mapped to real
scripts, tools/build_flags.py), and `GFLAG.dat` holds the 62
ending/chapter/replay slots. What save-state diffing still owes us is the
numeric layer (pick→delta amounts, gate thresholds), not the flag
identities. Advisory gating stays until the numbers confirm.

## Variants (43 files: `2031_2`, `2312_2`, `3001_2`, …)

Flag/replay-gated alternates (H-scenes, Chiaki-true extras, route
versions). v1 plays base files; every variant is listed in sim reports
for play-test mapping. `selectVariant()` is the seam.

## Statuses

`EXPERT_SOURCED` (walkthrough consensus, 30 nodes) / `NEEDS_PLAYTEST`
(2019-1516 routing frame, 3013-805 mapping; event indices shift as the parser improves — always cite current flow.json ids) / `ENGINE_EVIDENCED`
(1013→2001, 2033→3001). Flowchart/guide render badges; nothing claims
in-game verification it doesn't have.
