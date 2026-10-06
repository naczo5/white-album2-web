# AGENTS.md — working on the WHITE ALBUM 2 web port

Fan-made, bring-your-own-assets (BYOA) web engine for WHITE ALBUM 2
Extended Edition. Gameplay/path parity is priority #1. No game content is
ever committed — the repo ships engine + tooling + short functional labels
only; all art/audio/movies/text come from the user's legally-owned install
at build time.

## Golden rules

1. **Never commit game content.** No scenario text, images, audio, movies,
   fonts, executables, archives, PDFs. Covered paths: `wa2-web/web/public/
   data/`, `wa2-web/web/public/assets/`, `.cache/`, `*.pak`, `*.zip`,
   `*.pdf/.ogg/.mp3/.mp4/.png/.wav/.ogv`, discs. Verify with
   `git ls-files | grep -E "public/data|public/assets|\.pak$|\.ogg$"`.
   Committed JSON (`wa2-web/data/`, `docs/`) holds only short functional
   labels (choice options), flag/opcode names, and our annotations.
2. **Static analysis only for RE.** Never launch the game, Wine, windows,
   screenshots, or input automation on the user's machine. Disassemble and
   parse; do not execute. Evidence standard: file offsets, statement dumps,
   corpus counts — never vibes.
3. **Confidence-gated behavior.** Proven opcodes drive playback; hypotheses
   stay reference data. Mark every decode `high`/`hypothesis` and gate the
   player on `high` only. A wrong sound/image is worse than a missing one.
4. **Parity gates must stay green.** Any parser/router/data change must pass
   the full gate table in `docs/QA.md` (pytest, vitest, tsc, check_flow,
   check_bnr_choices, simulate, MAO pin).

## Layout

- `wa2-web/tools/` — pipeline: `kcap.py`, `lzss.py`, `extract_kcap.py`
  (archives), `parse_txt.py` (scenario IR), `build_flow.py` /
  `annotate_flow.py` / `build_links.py` (flow), `proto_bgm.py` (LSCR
  splitter + BGM/SE finders), `build_bgm.py` / `decode_bnr.py` /
  `build_voice.py` / `build_flags.py` / `build_luts.py` (presentation
  timelines), `check_flow.py` / `check_bnr_choices.py` (parity gates),
  `simulate.py` (full-game walk), `fetch_mao.py` (translation pin),
  `extract_assets.py` / `fix_audio_names.py` (BYOA assets), `build.py`
  (orchestrator).
- `wa2-web/data/` — hand-authored sources copied into builds: `flow.json`
  (choice routing + effects), `endings.json`, `terminals.json`,
  `sprites.json` (speaker→asset prefix).
- `wa2-web/web/src/` — player: `engine/router.ts` (flow), `engine/assets.ts`
  (manifest lookup — the single URL choke point), `engine/text.ts`
  (projection), `ui/reader.ts` (stage/voice/choices), `ui/data.ts`
  (loaders), `main.ts` (screens/settings).
- `wa2-web/docs/` — `ARCHITECTURE.md`, `PARSING.md` (token + opcode tables),
  `FLOW_GRAPH.md` (flag model), `QA.md` (gates + open items + log),
  `BYOA.md` (asset setup), `LEGAL.md`.
- `skills/` — agent skills (repo-local, harness-agnostic markdown).

## Commands

```sh
cd wa2-web && python3 -m pytest tests/ -q   # 35 passed + 7 BYOA-skipped
cd wa2-web/web && npx tsc --noEmit && npx vitest run   # 50 passed
python3 tools/build.py MAIN_EN_PAK [SPECIAL_EN_PAK] OUT [--game GAMEDIR] [--mao MAO_SCRIPT_DATA]
```

`--game` unlocks the asset-dependent steps (luts, flags, bnr choice gate).
Copy `OUT/data/*` → `web/public/data/`; assets via `extract_assets.py`
(see `docs/BYOA.md`). `web/public/` is gitignored build output — never stage
it (a stale copy there is the usual "missing asset" false alarm; the loader
warns on partial loads).

## Working agreements

- Read `docs/QA.md` + `docs/PARSING.md` before touching decoders; update
  both when opcodes change (table rows carry confidence + evidence).
- Prefer editing over new files; keep tools offline-capable and reading
  from explicit paths (no network in gates except the MAO pin).
- web: pure resolvers in `reader.ts` stay DOM-free and test-pinned
  (`bgm.test.ts` pattern); manifest URL logic lives only in `assets.ts`.
- Log subagent/research passes in `docs/QA.md` verification log.
