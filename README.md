# white-album2-web

Fan-made web port of **WHITE ALBUM 2 Extended Edition** — engine + tooling
only, no game content. Gameplay/path parity with the PC original is the
top priority.

**Engine, quickstart, verification:** see
[`wa2-web/README.md`](wa2-web/README.md) and [`wa2-web/docs/`](wa2-web/docs/).

## Source build

The reference install this port is built and tested against is the
Extended Edition + tokuten disc image available at:
<https://archive.org/details/white-album-2-extended-edition-tokuten>

You must supply your own legally-owned copy (BYOA — bring your own
assets); see `wa2-web/docs/BYOA.md` and `wa2-web/docs/LEGAL.md`.

## Translation

English scenario data comes from the
[MAO-TLs WHITE ALBUM 2 v2.1.0](https://github.com/MAO-TLs/white-album-2)
release (used as build input via `tools/build.py --mao` / `fetch_mao.py`
drift pin — never redistributed here).

## Status

Experimental. Voices, BGM/SE, backdrops, event art, LUT color grades,
flowchart/guide/saves work; per-line character sprite identity is still
undecoded (an explicitly experimental stand-in layer exists). Full gate
matrix: `wa2-web/docs/QA.md`.