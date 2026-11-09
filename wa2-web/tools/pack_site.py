"""Build a self-contained, offline-friendly web package.

    python3 pack_site.py --web ../web --data ../build/data \
        --assets ../build/assets --out ../../wa2-package [--zip] [--build]

Inputs:
  --web     web/ directory (uses web/dist; --build runs `npm run build`)
  --data    build/data (tools/build.py output: scripts/, flow.json, bnr.json, ...)
  --assets  build/assets (tools/extract_assets.py output: manifest.json + media)
  --out     destination directory (created/replaced)
  --zip     also write <out>.zip (text deflated, media stored)
  --build   run `npm run build` in --web first

The result is a plain static folder, `base: "./"` in vite.config.ts means it
works from any URL path. Browsers refuse fetch() over file://, so the package
includes start.sh / start.bat launchers that run Python's http.server.

Game content is user-supplied. The output is for personal use: never publish
or redistribute it (docs/LEGAL.md).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import time
import zipfile
from pathlib import Path

# Media formats are already entropy-coded: deflating them burns CPU for <1%.
STORE_EXT = {
    ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".ico",
    ".ogg", ".opus", ".mp3", ".m4a", ".aac", ".flac",
    ".mp4", ".webm", ".mkv", ".ogv",
}
# Text/JSON/code and uncompressed PCM benefit from deflate.
DEFLATE_EXT = {".json", ".js", ".css", ".html", ".txt", ".svg", ".map",
               ".wav", ".xml", ".md"}

README = """WHITE ALBUM 2 — web port (self-contained package)

This folder contains the fan-made engine plus assets converted from a
legally-owned copy of the game. It is for personal use only; do not
publish or redistribute it.

Start:
  Linux/macOS:  ./start.sh
  Windows:      start.bat

Both launch Python's static server on http://localhost:8080 and you then
open that URL. (A plain file:// open cannot work: browsers block fetch()
for local JSON.)

Saves live in your browser (localStorage) and can be exported as files
from Save / Load.
"""

START_SH = """#!/bin/sh
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8080}"
echo "WHITE ALBUM 2 web port: http://localhost:$PORT"
exec python3 -m http.server "$PORT"
"""

START_BAT = """@echo off
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8080
echo WHITE ALBUM 2 web port: http://localhost:%PORT%
where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server %PORT%
) else (
  py -m http.server %PORT%
)
"""


def human(n: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    v = float(n)
    for u in units:
        if v < 1024 or u == units[-1]:
            return f"{v:.1f} {u}" if u != "B" else f"{int(v)} B"
        v /= 1024
    return f"{n} B"


def tree_stats(root: str, exclude_top: set[str] | None = None) -> dict:
    total = 0
    files = 0
    by_ext: dict[str, int] = {}
    if not os.path.isdir(root):
        return {"bytes": 0, "files": 0, "by_ext": by_ext}
    for dirpath, dirs, names in os.walk(root):
        if exclude_top and os.path.abspath(dirpath) == os.path.abspath(root):
            dirs[:] = [d for d in dirs if d not in exclude_top]
            names = [n for n in names if n not in exclude_top]
        for name in names:
            p = os.path.join(dirpath, name)
            try:
                size = os.path.getsize(p)
            except OSError:
                continue
            total += size
            files += 1
            ext = os.path.splitext(name)[1].lower() or "(none)"
            by_ext[ext] = by_ext.get(ext, 0) + size
    return {"bytes": total, "files": files, "by_ext": by_ext}


def validate(web: str, data: str, assets: str) -> list[str]:
    warn = []
    index = os.path.join(data, "scripts", "index.json")
    if not os.path.isfile(index):
        raise SystemExit(f"missing {index}: run tools/build.py first")
    with open(index, encoding="utf-8") as f:
        scripts = json.load(f)
    if not scripts:
        raise SystemExit("data/scripts/index.json is empty")
    if not os.path.isfile(os.path.join(data, "flow.json")):
        warn.append("no data/flow.json: player will boot the demo instead")
    manifest = os.path.join(assets, "manifest.json")
    if not os.path.isfile(manifest):
        warn.append(f"no {manifest}: text-only package (assets will be placeholders)")
    else:
        with open(manifest, encoding="utf-8") as f:
            m = json.load(f)
        n = sum(len(v) for v in m.values() if isinstance(v, dict))
        if n == 0:
            warn.append("asset manifest has no entries")
    if not os.path.isfile(os.path.join(web, "dist", "index.html")):
        raise SystemExit(f"missing {web}/dist/index.html: build the web app "
                         "(npm run build) or pass --build")
    return warn


def build_web(web: str) -> None:
    print(f"building web app in {web} ...", flush=True)
    r = subprocess.run(["npm", "run", "build"], cwd=web)
    if r.returncode != 0:
        raise SystemExit("npm run build failed")


def copy_tree(src: str, dst: str) -> None:
    if not os.path.isdir(src):
        return
    shutil.copytree(src, dst, dirs_exist_ok=True)


def copy_engine(dist: str, out: str) -> list[str]:
    """Copy the built player, excluding public data/assets.

    Vite copies web/public/* into dist. A developer copy of build/data and
    build/assets often sits there (docs/BYOA step 4); copying dist wholesale
    would smuggle that stale copy into the package and inflate the engine
    section. The packer takes data/assets from explicit inputs instead.
    """
    skipped: list[str] = []
    if not os.path.isdir(dist):
        return skipped
    for name in os.listdir(dist):
        if name in ("data", "assets"):
            skipped.append(name)
            continue
        src = os.path.join(dist, name)
        dst = os.path.join(out, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)
    return skipped


def write_launchers(out: str) -> None:
    sh = os.path.join(out, "start.sh")
    bat = os.path.join(out, "start.bat")
    with open(sh, "w", encoding="utf-8", newline="\n") as f:
        f.write(START_SH)
    os.chmod(sh, 0o755)
    with open(bat, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(START_BAT)
    with open(os.path.join(out, "README.txt"), "w", encoding="utf-8") as f:
        f.write(README)


def make_zip(out: str, zip_path: str) -> dict:
    counts = {"stored": 0, "deflated": 0, "bytes_in": 0, "bytes_out": 0}
    if os.path.exists(zip_path):
        os.unlink(zip_path)
    with zipfile.ZipFile(zip_path, "w", allowZip64=True) as z:
        for dirpath, _dirs, names in os.walk(out):
            for name in names:
                p = os.path.join(dirpath, name)
                arc = os.path.relpath(p, out).replace(os.sep, "/")
                ext = os.path.splitext(name)[1].lower()
                if ext in DEFLATE_EXT:
                    ct = zipfile.ZIP_DEFLATED
                    counts["deflated"] += 1
                else:
                    ct = zipfile.ZIP_STORED
                    counts["stored"] += 1
                counts["bytes_in"] += os.path.getsize(p)
                z.write(p, arc, compress_type=ct,
                        compresslevel=9 if ct == zipfile.ZIP_DEFLATED else None)
    counts["bytes_out"] = os.path.getsize(zip_path)
    return counts


def compact_json(root: str) -> int:
    """Re-serialize shipped JSON without indentation (semantics unchanged)."""
    n = 0
    for dirpath, _dirs, names in os.walk(root):
        for name in names:
            if not name.endswith(".json"):
                continue
            p = os.path.join(dirpath, name)
            try:
                with open(p, encoding="utf-8") as f:
                    data = json.load(f)
                with open(p, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
                n += 1
            except (OSError, ValueError):
                continue
    return n


REPO = Path(__file__).resolve().parents[2]


def pack(web: str, data: str, assets: str, out: str, zip_out: str | None,
         do_build: bool, force: bool = False, compact: bool = False) -> dict:
    if do_build:
        build_web(web)
    warns = validate(web, data, assets)
    out_abs = os.path.abspath(out)
    if out_abs in (os.path.abspath(os.sep), os.path.expanduser("~")):
        raise SystemExit(f"refusing to replace {out_abs}")
    if os.path.isdir(out):
        safe = (not os.listdir(out) or
                os.path.isfile(os.path.join(out, "package-info.json")) or
                (os.path.isfile(os.path.join(out, "start.sh")) and
                 os.path.isfile(os.path.join(out, "index.html"))))
        if not safe and not force:
            raise SystemExit(
                f"{out} is a non-empty directory that does not look like a "
                "package; pass --force to replace it")
        guarded_rmtree(out, "pack output")
    os.makedirs(out, exist_ok=True)
    skipped = copy_engine(os.path.join(web, "dist"), out)
    if skipped:
        warns.append("ignored web/dist " + "/".join(skipped) +
                     " (using explicit --data/--assets inputs)")
    copy_tree(data, os.path.join(out, "data"))
    copy_tree(assets, os.path.join(out, "assets"))
    if compact:
        n = compact_json(os.path.join(out, "data"))
        print(f"compacted {n} JSON files")
    # Optional manual extras (digital-novel PDFs) live under web/public/data
    # but are not part of tools/build.py output; carry them if present.
    novels = os.path.join(web, "public", "data", "novels")
    if os.path.isdir(novels):
        copy_tree(novels, os.path.join(out, "data", "novels"))
    write_launchers(out)
    for w in warns:
        print(f"WARN {w}")

    engine = tree_stats(os.path.join(web, "dist"),
                        exclude_top={"data", "assets"})
    data_s = tree_stats(os.path.join(out, "data"))
    assets_s = tree_stats(os.path.join(out, "assets"))
    total = engine["bytes"] + data_s["bytes"] + assets_s["bytes"]
    info = {
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "engine": engine,
        "data": data_s,
        "assets": assets_s,
        "totalBytes": total,
        "zip": None,
        "warnings": warns,
        "note": "game assets are user-supplied; do not redistribute",
    }
    # Write before zipping so the archive carries its own size report; the
    # folder copy is rewritten with zip stats afterwards.
    with open(os.path.join(out, "package-info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, indent=1)
    if zip_out:
        try:
            inside = os.path.commonpath([os.path.abspath(out), os.path.abspath(zip_out)]) == os.path.abspath(out)
        except ValueError:
            inside = False
        if inside:
            raise SystemExit("--zip must be outside --out (self-inclusion)")
        print(f"zipping {zip_out} ...", flush=True)
        info["zip"] = make_zip(out, zip_out)
    with open(os.path.join(out, "package-info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, indent=1)
    return info


def print_report(info: dict) -> None:
    print()
    print(f"{'section':10s} {'files':>8s} {'size':>12s}")
    for key in ("engine", "data", "assets"):
        s = info[key]
        print(f"{key:10s} {s['files']:8d} {human(s['bytes']):>12s}")
    print(f"{'total':10s} {'':8s} {human(info['totalBytes']):>12s}")
    if info.get("zip"):
        z = info["zip"]
        print(f"{'zip':10s} {'':8s} {human(z['bytes_out']):>12s} "
              f"({z['deflated']} deflated / {z['stored']} stored)")
    media = (info["assets"].get("by_ext") or {})
    top = sorted(media.items(), key=lambda kv: -kv[1])[:8]
    if top:
        print("\nlargest asset groups:")
        for ext, size in top:
            print(f"  {ext:8s} {human(size):>10s}")
    for w in info.get("warnings") or []:
        print(f"WARN {w}")


def selftest() -> None:
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        web = os.path.join(tmp, "web")
        data = os.path.join(tmp, "data")
        assets = os.path.join(tmp, "assets")
        os.makedirs(os.path.join(web, "dist"))
        os.makedirs(os.path.join(data, "scripts"))
        os.makedirs(assets)
        with open(os.path.join(web, "dist", "index.html"), "w") as f:
            f.write("<html></html>")
        # stale public copies must not leak into the package
        os.makedirs(os.path.join(web, "dist", "data"))
        os.makedirs(os.path.join(web, "dist", "assets"))
        with open(os.path.join(web, "dist", "data", "stale.json"), "w") as f:
            f.write("{}")
        with open(os.path.join(web, "dist", "assets", "stale.js"), "w") as f:
            f.write("x")
        with open(os.path.join(data, "scripts", "index.json"), "w") as f:
            json.dump(["1001"], f)
        with open(os.path.join(data, "scripts", "1001.json"), "w") as f:
            json.dump({"script": "1001", "events": []}, f)
        with open(os.path.join(assets, "manifest.json"), "w") as f:
            json.dump({"version": 1, "images": {"a.tga": "a.png"}}, f)
        with open(os.path.join(assets, "a.png"), "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + b"x" * 100)
        out = os.path.join(tmp, "pkg")
        info = pack(web, data, assets, out, os.path.join(tmp, "pkg.zip"), False)
        assert info["data"]["files"] == 2, info
        assert info["assets"]["files"] == 2, info
        assert not os.path.exists(os.path.join(out, "data", "stale.json"))
        assert not os.path.exists(os.path.join(out, "assets", "stale.js"))
        assert os.path.isfile(os.path.join(out, "start.sh"))
        assert os.path.isfile(os.path.join(out, "start.bat"))
        assert os.path.isfile(os.path.join(out, "package-info.json"))
        assert os.path.getsize(os.path.join(tmp, "pkg.zip")) > 0
        info2 = pack(web, data, assets, out, None, False)
        assert info2["zip"] is None
    print("pack_site selftest ok")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--web", default=os.path.join(os.path.dirname(__file__), "..", "web"))
    ap.add_argument("--data", default=os.path.join(os.path.dirname(__file__), "..", "build", "data"))
    ap.add_argument("--assets", default=os.path.join(os.path.dirname(__file__), "..", "build", "assets"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "package"))
    ap.add_argument("--zip", nargs="?", const="", default=None,
                    help="write <out>.zip (or the given path)")
    ap.add_argument("--build", action="store_true", help="run npm run build first")
    ap.add_argument("--force", action="store_true",
                    help="replace a non-empty --out that is not a prior package")
    ap.add_argument("--compact-json", action="store_true",
                    help="minify shipped data/*.json (smaller text/zip; same bytes parsed)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return
    out = os.path.abspath(args.out)
    zip_out = None
    if args.zip is not None:
        zip_out = args.zip or (out + ".zip")
    info = pack(os.path.abspath(args.web), os.path.abspath(args.data),
                os.path.abspath(args.assets), out, zip_out, args.build,
                args.force, args.compact_json)
    print_report(info)
    print(f"\npackage: {out}")
    print("personal use only; do not redistribute game assets.")


def guarded_rmtree(p: Path | str, why: str) -> None:
    """Delete only real package output dirs; never repo/source/content dirs."""
    p = Path(p)
    if p in (Path("/"), Path.home(), Path(os.getcwd()).resolve(),
             Path(__file__).resolve().parents[2], REPO):
        raise SystemExit(f"{why}: refusing to delete protected root {p}")
    if ((p / ".git").exists() or (p / "package.json").exists()
            or (p / "play.sh").exists() or (p / "tools").exists()):
        raise SystemExit(f"{why}: refusing to delete project directory {p}")
    shutil.rmtree(p)


if __name__ == "__main__":
    main()
