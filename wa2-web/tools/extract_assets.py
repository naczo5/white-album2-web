"""BYOA asset pipeline: installed game dir -> web assets + manifest.

The game (images, voice, BGM, movies) is NEVER committed. This tool converts
a user's legally-owned install into browser-playable files:

    python3 extract_assets.py /path/to/game OUT_DIR [--en-pak ...] [--special-pak ...]

Inputs (any subset; missing inputs just limit what the web build can show):
  GAME/*.pak, GAME/IC/*.pak   installed archives (KCAP; bak/char/grp/fnt/
                              BGM/SE/VOICE/mv*.pak, script.pak)
  en.pak / special en.pak     translation image assets (.tga UI/text images)
  GAME/todokanai/subtitles    voice-cue timing source (copied through)

Per .pak: KCAP-extract (tools/kcap.py + lzss.py). Non-KCAP archives fall
back to `arc_unpacker --dec=leaf/...` when installed, else are reported.
Post-process per inner type:
  .tga/.bmp  -> .png (Pillow if available, else ImageMagick `convert`,
                else copied as-is + manifest warns; browsers need PNG/WebP)
  .w         -> .wav (Leaf 0x12-byte header parsed, PCM rewritten with a
                RIFF header; loop metadata preserved alongside as .loop)
  .g         -> .ogg (Ogg page repair per arc_unpacker g_audio_decoder;
                needs arc_unpacker unless already plain Ogg)
  .px        -> .png (needs arc_unpacker leaf/px; else reported missing)
  mv*.pak    -> .mp4 (ffmpeg transcode H.264+AAC when available; ASF/WMV
                sources are NOT browser-playable, so without ffmpeg the
                movie is reported missing, never copied raw)
  *.ass      -> subs/<mvNNN>.vtt (MAO Movie Patcher subtitle sources;
                auto-discovered as `<release>/Main Game/Movie Patcher/
                assets/ass` beside --en-pak, or given with --ass-dir).
                Style-level + inline \\i/\\b become <i>/<b>;
                PlayRes + \\pos drive `line:` (top/bottom band) and
                `position:` (off-centre columns); stale tracks pruned.
Output: OUT_DIR/{bg, chara, cg, ui, bgm, se, voice, movie, subs}/ +
manifest.json mapping engine ids (b105300.tga, sepia.AMP, mv01, ...) ->
relative URLs, plus missing.json (everything referenced by scenarios but
not supplied). `subtitles` maps movie ids (mv010) -> subs/mv010.vtt.

Re-running only the subtitles: `extract_assets.py OUT --ass-dir DIR
--subs-only` updates OUT/manifest.json + OUT/subs without touching the
extracted paks or MP4s. It requires an existing OUT/manifest.json (a
full extract must have run first): inventing one would blank the asset
tables.

Run `extract_assets.py --selftest` for a synthetic offline check (no game).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import kcap  # noqa: E402
import lzss  # noqa: E402

MANIFEST_VERSION = 1


def log(msg: str) -> None:
    print(msg, flush=True)


def convert_image(src: bytes, dst_png: str, name: str, missing: list) -> bool:
    try:
        from PIL import Image  # type: ignore
        import io
        img = Image.open(io.BytesIO(src))
        img.save(dst_png, "PNG")
        return True
    except ImportError:
        pass
    except Exception as e:
        missing.append(f"{name}: Pillow failed ({e})")
        return False
    if shutil.which("convert"):
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=os.path.splitext(name)[1],
                                         delete=False) as t:
            t.write(src)
            tmp = t.name
        r = subprocess.run(["convert", tmp, dst_png],
                           capture_output=True)
        os.unlink(tmp)
        if r.returncode == 0:
            return True
    missing.append(f"{name}: no Pillow/convert; install one (docs/BYOA.md)")
    return False


def convert_w(src: bytes, dst_wav: str, name: str, missing: list) -> bool:
    """Leaf .w (0x12-byte header + PCM) -> RIFF WAV. Plain WAV passes thru."""
    if src[:4] == b"RIFF":
        with open(dst_wav, "wb") as f:
            f.write(src)
        return True
    if len(src) < 0x12:
        missing.append(f"{name}: too short for .w header")
        return False
    (ch, block_align, rate, bits, byte_rate, pcm_size,
     loop_pos) = struct.unpack_from("<BBHHIII", src, 0)
    pcm = src[0x12:0x12 + pcm_size]
    if len(pcm) != pcm_size:
        missing.append(f"{name}: .w pcm size mismatch")
        return False
    import wave
    with wave.open(dst_wav, "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(bits // 8)
        w.setframerate(rate)
        w.writeframes(pcm)
    if loop_pos:
        with open(dst_wav + ".loop", "w") as f:
            f.write(str(loop_pos))
    return True


def handle_movie(pak_path: str, dst_mp4: str, name: str, missing: list,
                 args=None) -> bool:
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                            "format=format_name", "-of", "csv=p=0", pak_path],
                           capture_output=True, text=True) \
        if shutil.which("ffprobe") else None
    if not shutil.which("ffmpeg"):
        missing.append(f"{name}: no ffmpeg; movies need transcode (docs/BYOA.md)")
        return False
    # find ASF offset: movies may sit behind a thin PAK shell
    with open(pak_path, "rb") as f:
        head = f.read(1 << 20)
    guid = bytes([0x30, 0x26, 0xB2, 0x75])
    off = head.find(guid)
    src = pak_path
    tmp = None
    if off > 0:
        import tempfile
        tmp = tempfile.NamedTemporaryFile(suffix=".asf", delete=False).name
        with open(pak_path, "rb") as fin, open(tmp, "wb") as fout:
            fin.seek(off)
            shutil.copyfileobj(fin, fout)
        src = tmp
    crf = getattr(args, "movie_crf", 21)
    preset = getattr(args, "movie_preset", "veryfast")
    height = getattr(args, "movie_height", 0)
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", src,
           "-c:v", "libx264", "-preset", preset, "-crf", str(crf)]
    if height:
        cmd += ["-vf", f"scale=-2:{height}"]
    # faststart moves the moov atom to the head of the file so browsers can
    # begin playback before the whole MP4 is fetched (essential for the
    # 20-60 MB movie files served from a static host).
    cmd += ["-c:a", "aac", "-movflags", "+faststart", dst_mp4]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if tmp:
        os.unlink(tmp)
    if r.returncode != 0:
        missing.append(f"{name}: ffmpeg failed: {r.stderr[-300:]}")
        return False
    _ = probe
    return True


# ---------------------------------------------------------------------------
# Movie subtitles: MAO Movie Patcher `.ass` -> WebVTT
# ---------------------------------------------------------------------------

_ASS_OVERRIDE = re.compile(r"\{([^}]*)\}")
_ASS_AN = re.compile(r"\\an([1-9])")
_ASS_POS = re.compile(r"\\pos\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)")
_ASS_DRAWING = re.compile(r"\\p\d+")
_ASS_TIME = re.compile(r"^\s*(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})\s*$")
# All three switches in one pass so the emitted tag stream follows source
# order (`\i0\b1` closes italic before opening bold). `\i`/`\b` take an
# optional 0/1 (bare = on, the v4+ "last value" shorthand); `\r` resets to
# the row's style, `\rOther` switches to another style row.
_ASS_TOGGLE = re.compile(r"\\i(?P<i>[01]?)(?![\w.])|\\b(?P<b>[01]?)(?![\w.])"
                         r"|\\r(?P<r>[^\\}]*)")
# Rendered inline tags, stripped when measuring a cue's visible width.
_ASS_TAG = re.compile(r"<[^>]*>")
# Standard ASS v4+ Dialogue column order, used when a file omits `Format:`
# inside `[Events]` (the spec default).
_ASS_DEFAULT_FORMAT = ("layer", "start", "end", "style", "name", "marginl",
                       "marginr", "marginv", "effect", "text")
# Style rows (v4+) are comma-separated with the trailing Encoding field.
_ASS_STYLE_KEYS = ("name", "fontname", "fontsize", "primarycolour",
                   "secondarycolour", "outlinecolour", "backcolour", "bold",
                   "italic", "underline", "strikeout", "scalex", "scaley",
                   "spacing", "angle", "borderstyle", "outline", "shadow",
                   "alignment", "marginl", "marginr", "marginv", "encoding")
# Default frame size when a script omits PlayResX/PlayResY (ASS v4+ default
# is 384x288; MAO's files always carry 1280x720 or 704x480).
_ASS_DEFAULT_RES = (384, 288)
# A cue whose anchor y (as a fraction of PlayResY) is above this line sits
# in the upper band. 0.45 keeps mv010's `\an8\pos(640,410)` narrative at
# 57% and mv240's `\an7\pos(90,562)` credits at 78% on the bottom, where
# the actual text renders in the film.
_ASS_TOP_FRACTION = 0.45
# Horizontal anchor this far from the frame centre = a column caption
# (profile side-by-side: mv081 x=67/387 of 704 = 10%/55%).
_ASS_OFFCENTER = 0.08


def ass_time_ms(stamp: str) -> int | None:
    """`H:MM:SS.cc` (ASS centiseconds) -> milliseconds. None if malformed."""
    m = _ASS_TIME.match(stamp or "")
    if not m:
        return None
    h, mm, ss, frac = (int(m.group(1)), int(m.group(2)), int(m.group(3)),
                       m.group(4))
    # 2-digit fraction = centiseconds, 3-digit = milliseconds
    ms = int(frac) * 10 if len(frac) == 2 else int(frac.ljust(3, "0")[:3])
    return ((h * 60 + mm) * 60 + ss) * 1000 + ms


def vtt_time(ms: int) -> str:
    """Milliseconds -> `HH:MM:SS.mmm` (WebVTT timestamp)."""
    ms = max(0, int(ms))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{milli:03d}"


def _ass_style(styles: dict[str, dict] | None, name: str) -> dict | None:
    """Case-insensitive style row lookup (`\\rProfile` / `Style: profile`)."""
    if not styles:
        return None
    key = (name or "").strip()
    if not key:
        return None
    if key in styles:
        return styles[key]
    low = key.lower()
    for k, v in styles.items():
        if k.lower() == low:
            return v
    return None


def _ass_flag(value: str) -> bool:
    """ASS v4+ boolean: `-1` or `1` (any nonzero) means enabled."""
    try:
        return int((value or "0").strip() or 0) != 0
    except ValueError:
        return False


def ass_header(ass_text: str) -> tuple[tuple[int, int], dict[str, dict]]:
    """`[Script Info]` PlayRes + `[V4+ Styles]` rows, parsed before Events.

    Returns ((PlayResX, PlayResY), {Name: {italic, bold, alignment,
    fontsize}}). Missing PlayRes falls back to the ASS v4+ default 384x288;
    a missing `[V4+ Styles]` section yields an empty table (cues then rely
    on inline tags alone).
    """
    res_x, res_y = _ASS_DEFAULT_RES
    styles: dict[str, dict] = {}
    section = ""
    fmt: list[str] | None = None
    for raw in ass_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().lower()
            fmt = None
            continue
        if section == "script info":
            key, sep, val = line.partition(":")
            if not sep:
                continue
            k = key.strip().lower()
            try:
                if k == "playresx":
                    res_x = int(val.strip())
                elif k == "playresy":
                    res_y = int(val.strip())
            except ValueError:
                pass
            continue
        if section not in ("v4+ styles", "v4 styles", "v4 styles+"):
            continue
        if line.lower().startswith("format:"):
            fmt = [f.strip().lower() for f in line.split(":", 1)[1].split(",")]
            continue
        if not line.lower().startswith("style:"):
            continue
        cols = fmt or list(_ASS_STYLE_KEYS)
        vals = line.split(":", 1)[1].split(",", len(cols) - 1)
        row = {c: (vals[i].strip() if i < len(vals) else "")
               for i, c in enumerate(cols)}
        name = row.get("name") or ""
        if not name:
            continue
        try:
            alignment = int(row.get("alignment") or 2)
        except ValueError:
            alignment = 2
        try:
            fontsize = float(row.get("fontsize") or 40)
        except ValueError:
            fontsize = 40.0
        styles[name] = {"italic": _ass_flag(row.get("italic", "")),
                        "bold": _ass_flag(row.get("bold", "")),
                        "alignment": alignment,
                        "fontsize": fontsize}
    if res_x <= 0 or res_y <= 0:
        res_x, res_y = _ASS_DEFAULT_RES
    return ((res_x, res_y), styles)


def ass_text_to_vtt(text: str, style: dict | None = None,
                    styles: dict[str, dict] | None = None) -> tuple[str, bool]:
    """ASS dialogue body -> (WebVTT cue text, is_drawing).

    `\\N`/`\\n` become newlines; `\\i`/`\\b` switches map to WebVTT
    `<i>`/`<b>`; every other `{...}` override block is dropped. The style
    row's own `Italic`/`Bold` flags (MAO marks whole tracks: `Narrative`
    and `Spoken` are italic, `Profile`/`Credit` bold) seed the state, so
    an inline `\\i0` inside an italic style correctly closes the tag, and
    `\\r` / `\\rStyleName` resets it. Tags are balanced and closed at the
    end of the cue. Drawing blocks (`\\p1`) are reported through the second
    element of the return: their body is vector art, not text.
    """
    base = style or {}
    base_i, base_b = bool(base.get("italic")), bool(base.get("bold"))
    cur_i, cur_b = base_i, base_b
    open_tags: list[str] = []
    out: list[str] = []

    def sync() -> None:
        # canonical nesting order (`<b><i>…</i></b>`) keeps the stream
        # well-formed no matter which switch order the source used.
        desired = (["b"] if cur_b else []) + (["i"] if cur_i else [])
        while open_tags and open_tags != desired[:len(open_tags)]:
            out.append(f"</{open_tags.pop()}>")
        for tag in desired[len(open_tags):]:
            out.append(f"<{tag}>")
            open_tags.append(tag)

    def emit(s: str) -> None:
        """Append literal text, first flushing any pending tag change.

        Deferring means a switch that governs no characters (`{\\i0}` at
        the very start of an italic cue) never produces an empty `<i></i>`
        pair — the tag stream only ever wraps real text.
        """
        if not s:
            return
        sync()
        out.append(s)

    def reset(name: str) -> None:
        nonlocal cur_i, cur_b
        target = _ass_style(styles, name) if name else None
        if target:
            cur_i, cur_b = bool(target.get("italic")), bool(target.get("bold"))
        else:
            cur_i, cur_b = base_i, base_b

    pos = 0
    for m in _ASS_OVERRIDE.finditer(text):
        emit(text[pos:m.start()])
        block = m.group(1)
        if _ASS_DRAWING.search(block):
            return ("", True)  # vector drawing, never a caption
        for t in _ASS_TOGGLE.finditer(block):
            if t.group("r") is not None:
                reset(t.group("r").strip())
                continue
            if t.group("i") is not None:
                cur_i = t.group("i") != "0"
            else:
                cur_b = t.group("b") != "0"
        pos = m.end()
    emit(text[pos:])
    while open_tags:
        out.append(f"</{open_tags.pop()}>")
    body = "".join(out)
    body = body.replace("\\N", "\n").replace("\\n", "\n")
    body = body.replace("\r", "")
    # ASS escapes: \h is a hard space, \{ \} are literal braces
    body = body.replace("\\h", " ")
    body = body.replace("\\{", "{").replace("\\}", "}")
    lines = [ln.rstrip() for ln in body.split("\n")]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return ("\n".join(lines), False)


def _ass_block_center(alignment: int, x: float, res_x: int, body: str,
                      fontsize: float) -> float:
    """Approximate horizontal centre (px) of the block anchored at `x`.

    ASS `\\an1/4/7` anchor a block's LEFT edge at x and `\\an3/6/9` its
    RIGHT edge, so the profile columns (`\\an7\\pos(387,134)` in a 704-wide
    frame = 55%) occupy the right half even though the anchor itself is
    only 5% past centre. The width estimate is 0.5 em per character of the
    longest line — enough to classify a column, and the emitted
    `position:` uses the raw anchor so the browser renders the same edge
    ASS would.
    """
    longest = max((len(ln) for ln in _ASS_TAG.sub("", body or "").split("\n")),
                  default=0)
    half = min(res_x, longest * max(fontsize, 1.0) * 0.5) / 2.0
    if alignment in (1, 4, 7):
        return x + half
    if alignment in (3, 6, 9):
        return x - half
    return x


def _ass_cue_layout(style_name: str, style: dict, tag: str, res_x: int,
                    res_y: int, body: str) -> tuple[bool, int | None]:
    """(top, position%) placement for one cue.

    Vertical: `[Script Info]` `PlayResY` turns `\\pos(x,y)` into a real
    frame fraction. `< 45%` is the upper band; everything below is a
    bottom cue — mv010's narrative block at y=410/720 (57%) and mv240's
    credits at y=562/720 (78%) are bottom text even though they carry
    `\\an8`/`\\an7`. `\\an` and the style's Alignment only decide the band
    when there is no `\\pos` (WebVTT cannot express a pixel anchor).

    Horizontal: an off-centre `\\pos` yields `position:<x>%` so the
    side-by-side profile columns (mv020 122/704 of 1280, mv081 67/704 vs
    387/704) stay in their own column instead of collapsing onto centre.
    """
    alignment = int(style.get("alignment") or 2)
    for m in _ASS_AN.finditer(tag):
        alignment = int(m.group(1))
    x = y = None
    for m in _ASS_POS.finditer(tag):
        x, y = int(m.group(1)), int(m.group(2))
    position: int | None = None
    if x is not None and res_x > 0:
        centre = _ass_block_center(alignment, x, res_x, body,
                                   float(style.get("fontsize") or 40))
        if abs(centre / res_x - 0.5) >= _ASS_OFFCENTER:
            position = max(0, min(100, round(x / res_x * 100)))
    if y is not None and res_y > 0:
        top = (y / res_y) < _ASS_TOP_FRACTION
    else:
        top = alignment in (7, 8, 9) or style_name.strip().lower() == "songtop"
    return (top, position)


def ass_to_vtt(ass_text: str) -> str:
    """One MAO `.ass` track -> a WebVTT document (pure, no I/O).

    Parses `[Script Info]` (`PlayResX`/`PlayResY`) and `[V4+ Styles]`
    (`Name`, `Bold`, `Italic`, `Alignment`) before `[Events]`, so cue
    styling and placement survive the conversion. Cues are sorted
    chronologically by (start, end) because the profile-caption tracks
    interleave characters that are on screen at the same time. Placement
    becomes WebVTT cue settings (`line:` band + `position:` column) instead
    of pixel placement, so the player's own `<track>` styling decides the
    look.
    """
    (res_x, res_y), styles = ass_header(ass_text)
    fmt: list[str] | None = None
    in_events = False
    cues: list[tuple[int, int, str, str]] = []
    for raw in ass_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            in_events = line.lower() == "[events]"
            fmt = None
            continue
        if not in_events:
            continue
        if line.lower().startswith("format:"):
            fmt = [f.strip().lower() for f in line.split(":", 1)[1].split(",")]
            continue
        if not line.lower().startswith("dialogue:"):
            continue
        # `Text` (last field) may itself contain commas: split with maxsplit
        cols = fmt or list(_ASS_DEFAULT_FORMAT)
        fields = line.split(":", 1)[1].split(",", len(cols) - 1)
        if len(fields) < len(cols):
            continue

        def field(name: str, default: str = "") -> str:
            if name not in cols:
                return default
            k = cols.index(name)
            return fields[k].strip() if k < len(fields) else default

        start = ass_time_ms(field("start"))
        end = ass_time_ms(field("end"))
        if start is None or end is None or end <= start:
            continue
        style_name = field("style")
        style = _ass_style(styles, style_name) or {}
        text_field = fields[len(cols) - 1]
        tag = " ".join(_ASS_OVERRIDE.findall(text_field))
        body, is_drawing = ass_text_to_vtt(text_field, style, styles)
        if is_drawing or not body.strip():
            continue
        top, position = _ass_cue_layout(style_name, style, tag, res_x, res_y,
                                        body)
        settings = ["line:8%"] if top else []
        if position is None:
            settings.append("align:center")
        else:
            settings.append(f"position:{position}%")
            settings.append("align:start")
        cues.append((start, end, body, " ".join(settings)))
    cues.sort(key=lambda c: (c[0], c[1]))

    out = ["WEBVTT", ""]
    for start, end, body, settings in cues:
        out.append(f"{vtt_time(start)} --> {vtt_time(end)} {settings}")
        out.append(body)
        out.append("")
    return "\n".join(out)


def discover_ass_dir(en_paks: list[str]) -> str | None:
    """Find MAO's `Movie Patcher/assets/ass` next to a supplied en.pak.

    The v2.1.0 release ships
    `<release>/Main Game/Windows/game files/en.pak` and the subtitle
    sources at `<release>/Main Game/Movie Patcher/assets/ass`. Walk up
    from each en.pak (and its ancestors' siblings) looking for that
    shape; returns the first hit or None.
    """
    seen: set[str] = set()
    for pak in en_paks:
        here = os.path.dirname(os.path.abspath(pak))
        for _ in range(5):
            if not here or here in seen:
                break
            seen.add(here)
            for cand in (
                os.path.join(here, "Movie Patcher", "assets", "ass"),
                os.path.join(os.path.dirname(here), "Movie Patcher",
                             "assets", "ass"),
            ):
                if os.path.isdir(cand):
                    return cand
            parent = os.path.dirname(here)
            if parent == here:
                break
            here = parent
    return None


def convert_subtitles(ass_dir: str, out_dir: str, manifest: dict,
                      missing: list) -> int:
    """`*.ass` in ass_dir -> `<out>/subs/<mvNNN>.vtt`, recorded in manifest.

    Returns the number of tracks written. Existing manifest entries are
    updated in place (the `--subs-only` path reuses a previous extract).
    """
    if not os.path.isdir(ass_dir):
        missing.append(f"{ass_dir}: subtitle dir not found")
        return 0
    subs = os.path.join(out_dir, "subs")
    os.makedirs(subs, exist_ok=True)
    table = manifest.setdefault("subtitles", {})
    written = 0
    sources: set[str] = set()
    for fn in sorted(os.listdir(ass_dir)):
        if not fn.lower().endswith((".ass", ".ssa")):
            continue
        mvid = os.path.splitext(fn)[0].lower()
        sources.add(mvid + ".vtt")
        try:
            with open(os.path.join(ass_dir, fn), "r", encoding="utf-8-sig",
                      errors="replace") as f:
                src = f.read()
        except OSError as e:
            missing.append(f"{fn}: unreadable ({e})")
            continue
        vtt = ass_to_vtt(src)
        if vtt.strip() == "WEBVTT":
            missing.append(f"{fn}: no dialogue cues")
            continue
        dst = os.path.join(subs, mvid + ".vtt")
        with open(dst, "w", encoding="utf-8", newline="\n") as f:
            f.write(vtt)
        table[mvid] = f"subs/{mvid}.vtt"
        written += 1
    # Stale entries: a track the previous extract mapped must not outlive
    # its `.ass` source (movies renumbered/dropped between releases), or
    # the player asks for a caption file that is no longer produced.
    for mvid in [k for k in table if k + ".vtt" not in sources]:
        del table[mvid]
    for fn in os.listdir(subs):
        if fn.lower().endswith(".vtt") and fn not in sources:
            try:
                os.unlink(os.path.join(subs, fn))
            except OSError as e:
                missing.append(f"{fn}: stale .vtt not removed ({e})")
    log(f"  subtitles: {written} .vtt tracks -> {subs}")
    return written


def _pak_tag(pak: str, game: str) -> str:
    """Chapter tag from archive location (main vs IC dirs).

    Accepts IC at any depth: multi-disc staging puts it under
    `disc1/IC/...` rather than directly under the --game root.
    """
    rel = os.path.relpath(pak, game).split(os.sep)
    if any(part.lower() == "ic" for part in rel[:-1]):
        return "ic"
    return ""


def decode_lac_name(raw: bytes) -> str:
    """XOR-0xFF filename cipher -> audio name, or ''.

    Nested BGM/SE/VOICE LAC names are obfuscated with single-byte XOR 0xFF.
    Unlike decode_voice_name (voice-line shaped `{script}_{line}_{take}`),
    this accepts any audio filename (`BGM_001_A.OGG`, `SE_0000.WAV`, ...).
    """
    try:
        s = bytes(b ^ 0xFF for b in raw.split(b"\x00")[0]).decode("ascii")
    except Exception:
        return ""
    import re as _re
    if _re.match(r"^[\w\-]+\.(ogg|wav|w|g)$", s, _re.IGNORECASE):
        return s
    return ""


def voice_line_key(name: str) -> tuple[str, str] | None:
    """Voice LAC name -> (archive line key, take extension).

    Engine names are `{script}_{NNN}_{take}.OGG`. Variant scripts may carry
    their own suffix (`1008_020_0199_04`), so the script part is any run of
    numeric groups; the last `_NN` is the take and is dropped.
    """
    import re as _re
    m = _re.match(r"^([A-Za-z0-9]+(?:_[0-9]+)+)_[0-9]+\.([A-Za-z0-9]+)$",
                  name)
    return (m.group(1), m.group(2)) if m else None


def extract_voice(pak_path: str, out_sub: str, args, manifest: dict,
                  missing: list) -> None:
    """Voice archive -> voice table keyed by decoded `{script}_{line}`.

    One clip per line (6 engine-wide duplicates: first wins, noted).
    `out_sub` namespaces main vs IC (ic/ subdir + `ic/` key prefix).
    """
    with open(pak_path, "rb") as f:
        data = f.read()
    if data[:4] != b"LAC\x00":
        missing.append(f"{pak_path}: not a voice LAC")
        return
    (count,) = struct.unpack_from("<I", data, 4)
    by_line: dict[str, str] = {}
    dupes = 0
    for i in range(count):
        off = 8 + i * 40
        name = decode_lac_name(data[off:off + 24])
        if not name:
            continue
        (_a, _b, size, doff) = struct.unpack_from("<IIII", data, off + 24)
        if doff + size > len(data) or size <= 0:
            missing.append(f"{pak_path}: entry {i} out of range")
            continue
        lk = voice_line_key(name)
        if not lk:
            continue
        key = f"{out_sub}{lk[0]}" if out_sub else lk[0]
        if key in by_line:
            dupes += 1
            continue
        dst_dir = os.path.join(args.out, "voice", out_sub) if out_sub else \
            os.path.join(args.out, "voice")
        os.makedirs(dst_dir, exist_ok=True)
        dst = os.path.join(dst_dir, name)
        with open(dst, "wb") as f:
            f.write(data[doff:doff + size])
        by_line[key] = os.path.relpath(dst, args.out)
    for key, rel in by_line.items():
        manifest.setdefault("voice", {})[key] = rel
    log(f"  voice: {len(by_line)} lines ({dupes} duplicate takes skipped)")


def sniff_audio_ext(payload: bytes) -> str:
    """Identify nameless voice payloads: RIFF WAV, Ogg, or Leaf .w."""
    if payload[:4] == b"RIFF":
        return "wav"
    if payload[:4] == b"OggS":
        return "ogg"
    if len(payload) >= 0x12:
        try:
            (ch, _ba, rate, bits, _br, pcm_size,
             _loop) = struct.unpack_from("<BBHHIII", payload, 0)
            if (ch in (1, 2) and bits in (8, 16, 24, 32)
                    and 8000 <= rate <= 96000
                    and pcm_size == len(payload) - 0x12):
                return "w"
        except struct.error:
            pass
    return ""


def extract_lac_nested(lac_path: str, out_dir: str) -> list[tuple[str, int]]:
    """Extract a nested audio LAC (BGM/SE/VOICE): 40-byte entries.

    Layout differs from installer LACs: name[24] (XOR-0xFF obfuscated like
    voice archives, e.g. `BGM_001_A.OGG`, `SE_0000.WAV`) + u32 + u32 + u32
    size + u32 offset (absolute). Files are contiguous
    (offset[i+1] == offset[i] + size[i]). Only genuinely nameless entries
    get synthesized voice-%05d ids; extensions are sniffed from payload
    magic by the caller.
    """
    from extract_lac import decode_name
    with open(lac_path, "rb") as f:
        data = f.read()
    if data[:4] != b"LAC\x00":
        raise ValueError("not a LAC file")
    (count,) = struct.unpack_from("<I", data, 4)
    if 8 + count * 40 > len(data):
        raise ValueError(f"40B layout impossible for count {count}")
    entries = []
    pos = 8
    for i in range(count):
        raw = data[pos:pos + 24]
        (_a, _b, size, off) = struct.unpack_from("<IIII", data, pos + 24)
        name = ""
        # XOR-0xFF first (BGM/SE/VOICE real names); cp932 fallback for
        # any plain entries.
        xord = decode_lac_name(raw)
        if xord:
            name = xord
        else:
            try:
                cand = raw.split(b"\x00")[0].decode("cp932")
            except Exception:
                cand = ""
            ext = cand.rsplit(".", 1)[-1].lower() if "." in cand else ""
            if ext in ("w", "wav", "ogg", "g", "tga", "bmp", "txt", "px", "ani",
                       "amp", "bnr", "scc", "dat", "fnc", "psh"):
                name = cand
        entries.append((name or f"voice-{i:05d}", size, off))
        pos += 40
    # sanity: entries must tile inside the file
    for name, size, off in entries:
        if off + size > len(data) or size <= 0:
            raise ValueError(f"entry {name} out of range")
    os.makedirs(out_dir, exist_ok=True)
    done = []
    for name, size, off in entries:
        with open(os.path.join(out_dir, name), "wb") as f:
            f.write(data[off:off + size])
        done.append((name, size))
    return done


def extract_pak(pak_path: str, work: str) -> list[tuple[str, bytes]]:
    with open(pak_path, "rb") as f:
        data = f.read()
    if data[:4] != b"KCAP":
        return []  # caller tries arc_unpacker fallback / reports
    out = []
    for e in kcap.read_index(data):
        if e.is_folder:
            continue
        start, end = kcap.data_range(e)
        payload = data[start:end]
        if e.is_compressed:
            orig, lz = lzss.split_datahdr(payload)
            payload = lzss.decompress(lz, orig)
        out.append((e.name, payload))
    _ = work
    return out


def scan_pak(pak_path: str) -> list[tuple[str, int, bytes]]:
    """Fast scan: (name, flag, stored bytes) without decompressing."""
    with open(pak_path, "rb") as f:
        data = f.read()
    if data[:4] != b"KCAP":
        return []
    out = []
    for e in kcap.read_index(data):
        if e.is_folder:
            continue
        start, end = kcap.data_range(e)
        out.append((e.name, e.flag, data[start:end]))
    return out


def decode_entry(name: str, flag: int, stored: bytes) -> tuple[str, bytes]:
    if flag == 1:
        orig, lz = lzss.split_datahdr(stored)
        return (name, lzss.decompress(lz, orig))
    return (name, stored)


def convert_job(args: tuple) -> tuple[str, str, bytes | None, str | None]:
    """Top-level pool worker: (kind, name, payload) -> (name, kind, web_bytes, missing).

    Returns converted bytes (PNG/WAV) for the main process to place;
    movies and exotic codecs stay in-process (ffmpeg/arc_unpacker).
    """
    kind, name, flag, stored = args
    if flag == 1:
        try:
            _o, _lz = lzss.split_datahdr(stored)
            payload = lzss.decompress(_lz, _o)
        except Exception as e:
            return (name, kind, None, f"{name}: decompress failed ({e})")
    else:
        payload = stored
    if kind == "image":
        try:
            from PIL import Image  # type: ignore
            import io
            img = Image.open(io.BytesIO(payload))
            buf = io.BytesIO()
            img.save(buf, "PNG")
            return (name, kind, buf.getvalue(), None)
        except Exception as e:
            return (name, kind, None, f"{name}: image convert failed ({e})")
    if kind == "audio-w":
        import wave
        import io as _io
        if payload[:4] == b"RIFF":
            return (name, kind, payload, None)
        if len(payload) < 0x12:
            return (name, kind, None, f"{name}: too short for .w header")
        (ch, _ba, rate, bits, _br, pcm_size,
         _loop) = struct.unpack_from("<BBHHIII", payload, 0)
        pcm = payload[0x12:0x12 + pcm_size]
        if len(pcm) != pcm_size:
            return (name, kind, None, f"{name}: .w pcm size mismatch")
        buf = _io.BytesIO()
        with wave.open(buf, "wb") as wv:
            wv.setnchannels(ch)
            wv.setsampwidth(bits // 8)
            wv.setframerate(rate)
            wv.writeframes(pcm)
        return (name, kind, buf.getvalue(), None)
    return (name, kind, None, f"{name}: unsupported in worker")


def run_pool(jobs: list[tuple], manifest: dict, missing: list,
             args, emit) -> None:
    """Run (kind, name, flag, stored, sub, stem, table) jobs in a process
    pool, place outputs, fill the manifest. Prints progress."""
    from concurrent.futures import ProcessPoolExecutor
    total = len(jobs)
    if total == 0:
        return
    log(f"converting {total} files ({args.jobs} workers)...")
    payloads = [(j[0], j[1], j[2], j[3]) for j in jobs]
    done = 0
    with ProcessPoolExecutor(max_workers=max(1, args.jobs)) as ex:
        for (kind, name, flag, stored, sub, stem,
             table), (rname, _k, web, miss) in zip(
                 jobs, ex.map(convert_job, payloads)):
            assert rname == name
            done += 1
            if done % 25 == 0 or done == total:
                log(f"  {done}/{total}")
            if miss or web is None:
                missing.append(miss or f"{name}: convert failed")
                continue
            if kind == "image":
                dst = emit(sub, stem, ".png")
                with open(dst, "wb") as f:
                    f.write(web)
                rel = os.path.relpath(dst, args.out)
                table = manifest["images"]
                table[name] = rel
                table[name.lower()] = rel
                if "/" in sub:  # chapter-namespaced (ic/...): extra key
                    ns = sub.split("/")[0]
                    table[f"{ns}/{name}"] = rel
                    table[f"{ns}/{name.lower()}"] = rel
            elif kind == "audio-w":
                dst = emit(sub, stem, ".wav")
                with open(dst, "wb") as f:
                    f.write(web)
                table = manifest.setdefault(sub.split("/")[-1], {})
                table[name] = os.path.relpath(dst, args.out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("game", nargs="?", help="installed game dir")
    ap.add_argument("out", nargs="?", help="output web assets dir")
    ap.add_argument("--en-pak", action="append", default=[],
                    help="translation en.pak (repeatable)")
    ap.add_argument("--jobs", type=int, default=8,
                    help="parallel convert workers (default 8)")
    ap.add_argument("--movie-crf", type=int, default=21,
                    help="x264 CRF (lower = bigger/better; 23 is a good web tier)")
    ap.add_argument("--movie-preset", default="veryfast",
                    help="x264 preset (slow/slower = smaller at one CRF)")
    ap.add_argument("--movie-height", type=int, default=0,
                    help="downscale movies to this height (0 = keep; 720 web tier)")
    ap.add_argument("--ass-dir",
                    help="MAO Movie Patcher assets/ass dir (movie subtitles). "
                         "Default: auto-discovered as '<release>/Main Game/"
                         "Movie Patcher/assets/ass' relative to --en-pak.")
    ap.add_argument("--subs-only", action="store_true",
                    help="only (re)generate subs/*.vtt + update an existing "
                         "OUT/manifest.json; skips pak/MP4 extraction")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        run_selftest()
        return
    if args.subs_only:
        # `extract_assets.py OUT --subs-only` (single positional = the pack
        # dir to update) or `... GAME OUT --subs-only`.
        if args.out is None and args.game is not None:
            args.out, args.game = args.game, None
        if not args.out:
            ap.error("--subs-only needs OUT_DIR")
    elif not args.game or not args.out:
        ap.error("game and out required (or --selftest)")

    # ffmpeg/python temp can exceed constrained /tmp quotas; keep temp on
    # the same (big) disk as the output unless the user overrode TMPDIR.
    if os.environ.get("TMPDIR", "/tmp") in ("/tmp", "/var/tmp"):
        tmpdir = os.path.join(os.path.abspath(args.out), ".tmp")
        os.makedirs(tmpdir, exist_ok=True)
        os.environ["TMPDIR"] = tmpdir
        import tempfile
        tempfile.tempdir = tmpdir

    os.makedirs(args.out, exist_ok=True)
    manifest: dict = {"version": MANIFEST_VERSION, "images": {}, "bgm": {},
                      "sfx": {}, "voice": {}, "movies": {}, "subtitles": {}}
    missing: list[str] = []

    # Subtitle directories: an explicit --ass-dir wins; otherwise look for
    # MAO's `Movie Patcher/assets/ass` beside any supplied en.pak.
    ass_dir = args.ass_dir or discover_ass_dir(list(args.en_pak))
    if ass_dir:
        log(f"subtitles: {ass_dir}")

    if args.subs_only:
        mpath = os.path.join(args.out, "manifest.json")
        compact = False
        if not os.path.isfile(mpath):
            # A subs-only run cannot invent an asset manifest: writing one
            # with empty images/audio/bgm/movies tables would shadow the
            # real extract and every asset in the game would look missing.
            ap.error(f"--subs-only needs an existing {mpath}; run a full "
                     "extract first")
        try:
            with open(mpath, encoding="utf-8") as f:
                raw = f.read()
            manifest = json.loads(raw)
            # pack_bundle.py writes a compact manifest; keep it compact
            # so a subs-only refresh does not bloat the packed file.
            compact = "\n" not in raw
        except (OSError, ValueError) as e:
            ap.error(f"cannot read {mpath}: {e}")
        if not isinstance(manifest, dict):
            ap.error(f"{mpath}: not an object")
        if not ass_dir:
            ap.error("--subs-only needs --ass-dir (or an en.pak beside the "
                     "MAO Movie Patcher dir)")
        n = convert_subtitles(ass_dir, args.out, manifest, missing)
        with open(mpath, "w", encoding="utf-8") as f:
            if compact:
                json.dump(manifest, f, separators=(",", ":"),
                          ensure_ascii=False)
            else:
                json.dump(manifest, f, indent=1)
        log(f"subs: {n} tracks, {len(manifest.get('subtitles') or {})} "
            f"mapped -> {args.out}/subs")
        return

    def emit(sub: str, stem: str, ext: str) -> str:
        d = os.path.join(args.out, sub)
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, stem + ext)

    # 1. game .pak archives
    paks: list[str] = []
    for root, _, files in os.walk(args.game):
        for fn in files:
            if fn.lower().endswith(".pak"):
                paks.append(os.path.join(root, fn))
    log(f"found {len(paks)} .pak archives")
    lac_jobs: list[tuple] = []  # jobs from nested LACs, pooled at the end
    for pak in sorted(paks):
        base = os.path.basename(pak)
        try:
            with open(pak, "rb") as f:
                magic = f.read(4)
        except OSError as e:
            missing.append(f"{base}: unreadable ({e})")
            continue
        if magic == b"LAC\x00":
            # Voice archives carry XOR-obfuscated line addresses; decode
            # straight into the voice table (see decode_voice_name).
            if base.upper() == "VOICE.PAK":
                tag = _pak_tag(pak, args.game)
                extract_voice(pak, f"{tag}/" if tag else "", args,
                              manifest, missing)
                continue
            # Other nested archives (BGM/SE): unpack to a temp dir and
            # queue the inner files (raw payloads).
            import tempfile
            from extract_lac import extract as extract_lac
            tmp = tempfile.mkdtemp(prefix="wa2lac-")
            try:
                try:
                    inner = extract_lac_nested(pak, tmp)
                except ValueError:
                    inner = extract_lac(pak, tmp)
            except Exception as e:
                missing.append(f"{base}: nested LAC failed ({e})")
                continue
            log(f"  {base}: nested LAC, {len(inner)} files")
            for name, _size in inner:
                ipath = os.path.join(tmp, *name.split("\\"))
                if not os.path.isfile(ipath):
                    continue
                with open(ipath, "rb") as f:
                    stored = f.read()
                ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                if not ext or "/" in ext or len(ext) > 5:
                    # synthesized voice ids: sniff payload magic
                    ext = sniff_audio_ext(stored)
                    if not ext:
                        missing.append(f"{base}:{name}: unknown payload")
                        continue
                    name = f"{name}.{ext}"
                iname = os.path.basename(name)
                if ext in ("w", "wav"):
                    sub = voice_or_se(base)
                    tag = _pak_tag(pak, args.game)
                    key = f"{tag}-{iname}" if tag else iname
                    lac_jobs.append(("audio-w", key, 0, stored, sub,
                                     key.rsplit(".", 1)[0], sub))
                elif ext == "g":
                    stem = iname.rsplit(".", 1)[0]
                    tag = _pak_tag(pak, args.game)
                    key = f"{tag}-{iname}" if tag else iname
                    sub = f"{tag}/bgm" if tag else "bgm"
                    dst = emit(sub, stem, ".ogg")
                    if stored[:4] == b"OggS":
                        with open(dst, "wb") as f:
                            f.write(stored)
                        manifest["bgm"][key] = os.path.relpath(dst, args.out)
                    else:
                        missing.append(f"{base}:{iname}: .g needs arc_unpacker")
                elif ext in ("tga", "bmp"):
                    tag = _pak_tag(pak, args.game)
                    stem = iname.rsplit(".", 1)[0]
                    sub = image_sub(iname)
                    if tag:
                        sub = f"{tag}/{sub}"
                    lac_jobs.append(("image", iname, 0, stored,
                                     sub, stem, "images"))
                elif ext == "px":
                    missing.append(f"{base}:{iname}: .px needs arc_unpacker")
                elif ext == "ogg":
                    sub = voice_or_se(base)
                    tag = _pak_tag(pak, args.game)
                    key = f"{tag}-{iname}" if tag else iname
                    if tag:
                        sub = f"{tag}/{sub}"
                    dst = emit(sub, key.rsplit(".", 1)[0], ".ogg")
                    with open(dst, "wb") as f:
                        f.write(stored)
                    table = manifest.setdefault(sub.split("/")[-1], {})
                    table[key] = os.path.relpath(dst, args.out)
                # ignore the rest (txt/bnr/cues handled elsewhere)
            continue
        lname = base.lower()
        is_movie = lname.startswith("mv") and "en.pak" not in lname
        if is_movie:
            mvid = lname[:-4]  # mv010.pak -> mv010
            dst = emit("movie", mvid, ".mp4")
            if handle_movie(pak, dst, base, missing, args):
                manifest["movies"][mvid] = f"movie/{mvid}.mp4"
            continue
        if magic != b"KCAP":
            missing.append(f"{base}: not KCAP (try arc_unpacker; docs/BYOA.md)")
            continue
        jobs = []  # (kind, name, flag, stored, sub, stem, table)
        for name, flag, stored in scan_pak(pak):
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            stem = name.rsplit(".", 1)[0]
            if ext in ("tga", "bmp"):
                is_en = os.path.basename(pak).lower().startswith("en") or \
                    "en.pak" in os.path.basename(pak).lower()
                sub = "ui" if is_en else image_sub(name)
                tag = _pak_tag(pak, args.game)
                if tag and not is_en:
                    sub = f"{tag}/{sub}"
                jobs.append(("image", name, flag, stored, sub, stem,
                             "images"))
            elif ext == "w":
                sub = voice_or_se(base)
                tag = _pak_tag(pak, args.game)
                key = f"{tag}-{name}" if tag else name
                if tag:
                    sub = f"{tag}/{sub}"
                jobs.append(("audio-w", key, flag, stored, sub,
                             key.rsplit(".", 1)[0], sub))
            elif ext == "g":
                tag = _pak_tag(pak, args.game)
                key = f"{tag}-{name}" if tag else name
                sub = f"{tag}/bgm" if tag else "bgm"
                dst = emit(sub, stem, ".ogg")
                # plain-Ogg passthrough when possible; else delegate
                _k, payload = decode_entry(name, flag, stored)
                if payload[:4] == b"OggS":
                    with open(dst, "wb") as f:
                        f.write(payload)
                    manifest["bgm"][key] = os.path.relpath(dst, args.out)
                else:
                    missing.append(f"{base}:{name}: .g needs arc_unpacker leaf/g")
            elif ext == "px":
                missing.append(f"{base}:{name}: .px needs arc_unpacker leaf/px")
            elif ext == "txt":
                pass  # scenario sources handled by build.py, not assets
            elif ext == "bnr":
                pass
            else:
                missing.append(f"{base}:{name}: unhandled .{ext}")
        run_pool(jobs, manifest, missing, args, emit)

    # 2. translation image assets (same pool path)
    for pak in args.en_pak:
        jobs = []
        for name, flag, stored in scan_pak(pak):
            if not name.lower().endswith((".tga", ".bmp")):
                continue
            stem = name.rsplit(".", 1)[0]
            jobs.append(("image", name, flag, stored, "ui", stem, "images"))
        run_pool(jobs, manifest, missing, args, emit)

    # 3. nested-LAC jobs pooled last (voice/BGM bulk)
    if lac_jobs:
        log(f"nested archives queued {len(lac_jobs)} converts")
    run_pool(lac_jobs, manifest, missing, args, emit)

    # 3. voice-cue timings ride along for the player
    subs = os.path.join(args.game, "todokanai", "subtitles")
    if os.path.exists(subs):
        d = os.path.join(args.out, "cues")
        os.makedirs(d, exist_ok=True)
        shutil.copy(subs, os.path.join(d, "subtitles"))
        manifest["cues"] = "cues/subtitles"

    # 4. movie subtitles (.ass -> subs/*.vtt)
    if ass_dir:
        convert_subtitles(ass_dir, args.out, manifest, missing)
    else:
        log("subtitles: no --ass-dir and no Movie Patcher found; skipped")

    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    with open(os.path.join(args.out, "missing.json"), "w") as f:
        json.dump(sorted(set(missing)), f, indent=1)
    n = sum(len(v) for k, v in manifest.items()
            if isinstance(v, dict))
    log(f"assets: {n} mapped, {len(set(missing))} missing -> {args.out}")


def image_sub(name: str) -> str:
    n = name.lower()
    if n.startswith("b") or "bg" in n or "bak" in n:
        return "bg"
    if n.startswith("c") or "chr" in n or "char" in n:
        return "chara"
    return "cg"


def voice_or_se(pak_base: str) -> str:
    b = pak_base.lower()
    if "voice" in b:
        return "voice"
    if "se" in b:
        return "sfx"
    return "bgm"


def run_selftest() -> None:
    import tempfile
    import io
    try:
        from PIL import Image  # type: ignore
        have_pil = True
    except ImportError:
        have_pil = False
    with tempfile.TemporaryDirectory() as tmp:
        # synthetic KCAP: 1 tiny TGA + 1 minimal .w + non-KCAP movie probe
        tga = make_tga(4, 4)
        w = struct.pack("<BBHHIII", 1, 1, 8000, 16, 16000, 8,
                        0) + b"\x00" * 8
        pak = build_kcap({"a.tga": (0, tga), "v.w": (0, w)})
        pp = os.path.join(tmp, "t.pak")
        open(pp, "wb").write(pak)
        got = {n: p for n, p in extract_pak(pp, "")}
        assert set(got) == {"a.tga", "v.w"}, got.keys()
        assert got["a.tga"] == tga and got["v.w"] == w
        out = os.path.join(tmp, "o")
        os.makedirs(out)
        if have_pil:
            assert convert_image(tga, os.path.join(out, "a.png"), "a.tga", [])
            back = Image.open(os.path.join(out, "a.png"))
            assert back.size == (4, 4)
        assert convert_w(w, os.path.join(out, "v.wav"), "v.w", [])
        import wave
        with wave.open(os.path.join(out, "v.wav"), "rb") as r:
            assert (r.getnchannels(), r.getframerate()) == (1, 8000)
    print(f"selftest ok (Pillow: {have_pil})")


def make_tga(w: int, h: int) -> bytes:
    hdr = struct.pack("<BBBHHBHHHHBB", 0, 0, 2, 0, 0, 0, 0, 0, w, h, 24, 0)
    return hdr + bytes([255, 0, 0] * w * h)


def build_kcap(files: dict[str, tuple[int, bytes]]) -> bytes:
    blob = b"KCAP" + struct.pack("<III", 0xFFFFFFFF, 0x0000FFFF, len(files))
    off = 16 + 44 * len(files)
    for name, (flag, payload) in files.items():
        blob += struct.pack("<I", flag) + name.encode() + b"\x00" * (24 - len(name))
        blob += struct.pack("<IIII", 0xFFFFFFFF, 0x0000FFFF, off, len(payload))
        off += len(payload)
    for _, (_, payload) in files.items():
        blob += payload
    return blob


if __name__ == "__main__":
    main()
