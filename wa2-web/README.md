# wa2-web — WHITE ALBUM 2 Extended Edition, web port (BYOA)

A fan-made web engine + QoL shell (flowchart, guide, file saves) for
WHITE ALBUM 2 Extended Edition. Gameplay and path parity is the top
priority; everything structural comes from the game's own scenario data.

**Bring your own assets.** This repo contains no game content: no images,
audio, movies, scenario text, or translation. You supply a legally-owned
Japanese copy plus the MAO-TLs v2.1.0 English release; `tools/build.py`
turns them into playable web data on your machine. See `docs/BYOA.md`.

## Layout

```
wa2-web/
  tools/      offline pipeline (KCAP extract, scenario parser, flow/links
              derivation, MAO pin + drift audit, asset converter, simulator)
  tests/      pytest suite (unit + BYOA corpus conformance, env-gated)
  data/       hand-authored sources: endings, terminals, annotation RULES
              (annotate_flow.py); generated flow.json/links.json are
              reproducible build outputs kept in sync by tools/build.py
  web/        Vite+TypeScript player (engine + title/flowchart/guide/saves)
  docs/       ARCHITECTURE, BYOA, PARSING, FLOW_GRAPH, QA, LEGAL
```

## Quickstart (empty checkout -> playable)

```sh
# 1. scenario text (needs your en.pak files, v2.1.0)
python3 tools/build.py /path/to/en.pak /path/to/special-en.pak ./build
cp -r build/data/* web/public/data/

# 2. assets (needs your installed game dir)
python3 tools/extract_assets.py /path/to/game build/assets \
  --en-pak /path/to/en.pak --en-pak /path/to/special-en.pak
cp -r build/assets web/public/assets

# 3. play
cd web && npm install && npm run dev
```

Without steps 1-2 the player boots a tiny original demo so the UI is
testable with zero assets.

## Verification

```sh
python3 -m pytest tests/ -q                          # unit (no assets)
WA2_EN_PAK=/path/to/en.pak python3 -m pytest tests/  # + corpus parity
python3 tools/simulate.py IR FLOW LINKS TERMINALS routers
python3 tools/fetch_mao.py IR_MAIN IR_SPECIAL --clone /path/to/mao-clone
cd web && npx vitest run && npx tsc --noEmit && npm run build
```

Current status: 26 pytest + 35 vitest green; full-game sim walks 202/245
scripts stall-free (43 unvisited = flag-gated scene variants awaiting
in-game verification); MAO v2.1.0 drift audit 0.986 containment over
193 game scripts; voices wired (46k clips via XOR-decoded line addresses);
movies resolve; exact .AMP color LUTs; sprite overlays with .bnr fades;
typewriter/auto/skip/volumes (voice + BGM); novels + Special menu.
Music: BGM scene→track map solved statically (.bnr opcode (4,158), 1288
plays across 242 scripts, loop pairs preferred; only bonus-disc tracks
78/79 sustain). Choices cross-checked against engine (4,208) markers
(31/31); flag identities engine-evidenced (Global.vrb/GFLAG.dat).
Sound effects solved too (.bnr opcode (4,164), 12 cues firing).
Open residuals: dynamic sprite slots, numeric flag thresholds/deltas.
Details in `docs/QA.md`.
