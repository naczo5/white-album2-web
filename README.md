# white-album2-web

Fan-made web port of **WHITE ALBUM 2 Extended Edition** — engine + tooling
only, no game content. Gameplay/path parity with the PC original is the
top priority.

**Engine, quickstart, verification:** see
[`wa2-web/README.md`](wa2-web/README.md) and [`wa2-web/docs/`](wa2-web/docs/).

**Fastest local play:** `cd wa2-web && ./play.sh --game-dir /path/to/game`
(or `--image disc1.iso ...`); it extracts, builds, and serves the web app.
See [`wa2-web/docs/ONECLICK.md`](wa2-web/docs/ONECLICK.md).

## Source build

The reference install this port is built and tested against is the
Extended Edition + tokuten disc image.

## Translation

English scenario data comes from the
[MAO-TLs WHITE ALBUM 2 v2.1.0](https://github.com/MAO-TLs/white-album-2)
release (used as build input via `tools/build.py --mao` / `fetch_mao.py`
drift pin — never redistributed here).

## Status

Experimental. Voices, BGM/SE, backdrops, event art, sprites, LUT color
grades, flowchart/guide/saves work. Full gate matrix and open parity items:
`wa2-web/docs/QA.md`; self-packaging and size tiers:
`wa2-web/docs/PACKAGING.md`.

## Hosting

I am currently not able to host it to the public.
If you are interested in doing it yourself it would be welcome. 
But if you still want to discuss anything before that, write to me at naczo5@proton.me
