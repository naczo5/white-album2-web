---
name: parity-gate
description: Verify gameplay/path parity after any parser, router, flow-data, or decoder change. Use before committing anything that touches scenarios, choices, flags, or timelines.
---

# Parity gate skill

Parity is priority #1. Run the full table (`wa2-web/docs/QA.md`) — every
row must stay green:

```sh
cd wa2-web && python3 -m pytest tests/ -q          # tools unit
cd wa2-web/web && npx tsc --noEmit && npx vitest run  # web unit + types
python3 tools/check_flow.py IR_DIR wa2-web/data/flow.json      # 32/32 choices
python3 tools/check_bnr_choices.py IR_DIR script.pak           # 31/31 markers
python3 tools/simulate.py --all                                # 0 stalls
python3 tools/fetch_mao.py --check                             # v2.1.0 pin
```

## Adding a gate (the pattern)

1. Find engine ground truth first (a `.bnr` opcode, a flag table, an exe
   string) — never gate on translation text alone.
2. Put the extractor in `wa2-web/tools/` reading explicit paths, offline.
3. Add synthetic unit tests (`wa2-web/tests/`, no assets) plus a corpus
   case if it needs `WA2_EN_PAK` (skip gracefully without it).
4. Wire into `tools/build.py` where inputs exist; document the row in
   `docs/QA.md` with current numbers.
5. Player-side: pure DOM-free resolvers in `web/src/ui/reader.ts` with
   tests following `web/src/ui/bgm.test.ts` (stub `fetch` for manifest).

## Choices checklist (the usual breakage)

- `check_flow.py`: coverage of all 32 nodes, exact option wording, goto
  targets, `play`-override deliberateness, endings/terminal refs.
- `check_bnr_choices.py`: count-based (≥2×(4,208), ≥1×(4,209) per choice)
  — fractional proximity is drift-prone, report it, don't gate on it.
- Mega-token resplits must preserve CATCH voice targets
  (`parse_txt.resplit_mega` + latch census); router `pick()` effects must
  match `flow.json` node effects.
