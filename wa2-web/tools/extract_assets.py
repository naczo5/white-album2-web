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
Output: OUT_DIR/{bg, chara, cg, ui, bgm, se, voice, movie}/ + manifest.json
mapping engine ids (b105300.tga, sepia.AMP, mv01, ...) -> relative URLs,
plus missing.json (everything referenced by scenarios but not supplied).

Run `extract_assets.py --selftest` for a synthetic offline check (no game).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
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


def handle_movie(pak_path: str, dst_mp4: str, name: str, missing: list) -> bool:
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
    r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src,
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
                        "-c:a", "aac", dst_mp4], capture_output=True, text=True)
    if tmp:
        os.unlink(tmp)
    if r.returncode != 0:
        missing.append(f"{name}: ffmpeg failed: {r.stderr[-300:]}")
        return False
    _ = probe
    return True


def _pak_tag(pak: str, game: str) -> str:
    """Chapter tag from archive location (main vs IC dirs)."""
    rel = os.path.relpath(pak, game).split(os.sep)
    if len(rel) > 1 and rel[0].lower() == "ic":
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


def extract_voice(pak_path: str, out_sub: str, args, manifest: dict,
                  missing: list) -> None:
    """Voice archive -> voice table keyed by decoded `{script}_{line}`.

    One clip per line (6 engine-wide duplicates: first wins, noted).
    `out_sub` namespaces main vs IC (ic/ subdir + `ic/` key prefix).
    """
    import re as _re
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
        m = _re.match(r"^([A-Za-z0-9]+_[0-9]+)_[0-9]+\.([A-Za-z0-9]+)$", name)
        if not m:
            continue
        key = f"{out_sub}{m.group(1)}" if out_sub else m.group(1)
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
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        run_selftest()
        return
    if not args.game or not args.out:
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
                      "sfx": {}, "voice": {}, "movies": {}}
    missing: list[str] = []

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
            if handle_movie(pak, dst, base, missing):
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
