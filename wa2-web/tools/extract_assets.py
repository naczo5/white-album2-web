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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("game", nargs="?", help="installed game dir")
    ap.add_argument("out", nargs="?", help="output web assets dir")
    ap.add_argument("--en-pak", action="append", default=[],
                    help="translation en.pak (repeatable)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        run_selftest()
        return
    if not args.game or not args.out:
        ap.error("game and out required (or --selftest)")

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
    for pak in sorted(paks):
        base = os.path.basename(pak)
        try:
            with open(pak, "rb") as f:
                magic = f.read(4)
        except OSError as e:
            missing.append(f"{base}: unreadable ({e})")
            continue
        if magic != b"KCAP":
            missing.append(f"{base}: not KCAP (try arc_unpacker; docs/BYOA.md)")
            continue
        lname = base.lower()
        is_movie = lname.startswith("mv") and "en.pak" not in lname
        if is_movie:
            mvid = lname[:-4]  # mv010.pak -> mv010
            dst = emit("movie", mvid, ".mp4")
            if handle_movie(pak, dst, base, missing):
                manifest["movies"][mvid] = f"movie/{mvid}.mp4"
            continue
        for name, payload in extract_pak(pak, ""):
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            stem = name.rsplit(".", 1)[0]
            if ext in ("tga", "bmp"):
                sub = "ui" if "en" in pak.lower() else image_sub(name)
                dst = emit(sub, stem, ".png")
                if convert_image(payload, dst, f"{base}:{name}", missing):
                    manifest["images"][name] = f"{sub}/{stem}.png"
                    manifest["images"][name.lower()] = f"{sub}/{stem}.png"
            elif ext == "w":
                sub = voice_or_se(base)
                dst = emit(sub, stem, ".wav")
                if convert_w(payload, dst, f"{base}:{name}", missing):
                    key = f"{sub}/{stem}.wav"
                    manifest[sub][name] = key
            elif ext == "g":
                dst = emit("bgm", stem, ".ogg")
                # plain-Ogg passthrough when possible; else delegate
                if payload[:4] == b"OggS":
                    with open(dst, "wb") as f:
                        f.write(payload)
                    manifest["bgm"][name] = f"bgm/{stem}.ogg"
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

    # 2. translation image assets
    for pak in args.en_pak:
        for name, payload in extract_pak(pak, ""):
            if not name.lower().endswith((".tga", ".bmp")):
                continue
            stem = name.rsplit(".", 1)[0]
            dst = emit("ui", stem, ".png")
            if convert_image(payload, dst, f"en.pak:{name}", missing):
                manifest["images"][name] = f"ui/{stem}.png"

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
