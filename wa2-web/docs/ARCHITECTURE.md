# Architecture

## Data flow (all local, all user-supplied)

```
your en.pak (main) + special en.pak (v2.1.0 release zips)
  -> tools/kcap.py + lzss.py            KCAP archive + LZSS (.txt raw, .bnr/.tga packed)
  -> tools/parse_txt.py                 cp932 token streams -> event IR
     (two-pass: latch census, mega-token resplit, choice merge)
  -> tools/build_flow.py                engine choice skeleton (32 nodes)
  -> tools/annotate_flow.py             walkthrough join -> flow.json
  -> tools/build_links.py               bare-id runs -> links.json (HINT/SWITCH/DEAD)
  -> tools/check_flow.py                parity gate (coverage + wording + gotos)
  -> web/public/data/{scripts/*.json, flow.json, links.json, ...}

your installed game dir (*.pak, movies, todokanai/subtitles)
  -> tools/extract_assets.py            PNG/WAV/OGG/MP4 + assets/manifest.json
  -> web/public/assets/

MAO-TLs repo (clone or Pages, pinned EXPECTED = 2.1.0)
  -> tools/fetch_mao.py                 version pin + drift audit (0.986)
```

## Runtime (web/src)

- `engine/types.ts` — IR/flow/save/asset types (mirrors tools output).
- `engine/text.ts` — projection: `\n` breaks, `\k` page breaks, F16
  whispers, F/S strip, W-timing strip, `[Rbase^reading]`/`[Rbase|reading]`
  ruby, HTML escaping. Same rules as MAO's `web_text` + `whisper_text`.
- `engine/router.ts` — flow: sequential spine + choice gotos (`play`
  overrides) + terminals (ends/chains) + flag effects. Bare ids and
  CATCH* never move flow (preload/voice sync). Detour-once visited set.
- `engine/save.ts` — progress as a FILE (JSON download/upload) + 8
  localStorage slots + autosave. Round-trip tested.
- `engine/assets.ts` — manifest lookup with null fallback (text-first
  placeholders when assets are missing).
- `ui/` — title, reader (dialogue/choices/stage/backlog), flowchart
  (progress + spoiler modes + verification badges), guide (endings,
  recommended order, key choices), saves, settings.

## Key findings baked in (see docs/FLOW_GRAPH.md, docs/PARSING.md)

- 205 main + 49 special scenario files; 32 engine choices (5 recovered
  from mega-tokens); IC linear; CC 4 file-lines (Chiaki 23xx, Mari 24xx,
  common 25xx, Setsuna 20xx-tail); Coda splits at 3016 (Kazusa 39xx).
- Inline choices are attitude/affection picks with shared linear
  continuation (proven by 2004's decline-then-accept reversal scene);
  only the 12/24 router (bare gotos) and work/stay (CATCH-adjacent,
  `play: 2301`) move files.
- 43 suffixed variant files (`2031_2`, `2312_2`, …) are flag/replay
  gated alternates; v1 plays base files, variants listed for QA.
- Voice/BGM/movie wiring: BGM `.AMP` cues + movie `mvNN` cues are first
  class; voice-clip mapping (VOICE.PAK order vs CATCH ids) is the known
  gap, queued in docs/QA.md.
