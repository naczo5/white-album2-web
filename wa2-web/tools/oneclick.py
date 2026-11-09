#!/usr/bin/env python3
"""One-command BYOA bootstrap: images / installed game -> playable web port.

Examples
--------
Existing extracted game (fastest, no downloads):
    python3 tools/oneclick.py --game-dir /path/to/game

Local disc images:
    python3 tools/oneclick.py --image disc1.iso --image disc2.iso \
        --mao-zip /path/to/White_Album_2_Complete_English_Release_v2.1.0.zip \
        --i-own-the-game

Archive.org item (you must own the game; the script does not choose item IDs):
    python3 tools/oneclick.py \
        --archive-item https://archive.org/details/YOUR_ITEM \
        --mao-zip /path/to/mao-release.zip --i-own-the-game

After the first build, `--no-assets` gives a text-only package, and
`--no-serve` stops after `web/dist` is ready.

The script never runs the game, Wine, or an installer. It only extracts
archives and runs the repo's offline tools. Output contains copyrighted game
content: personal use only, never redistribute.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import webbrowser
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # wa2-web
REPO = ROOT.parent
CACHE = REPO / ".cache"
WEB = ROOT / "web"
TOOLS = ROOT / "tools"
PK_NAMES = ("script.pak", "bak.pak", "char.pak", "grp.pak", "fnt.pak",
            "voice.pak", "bgm.pak", "se.pak")


def log(msg: str) -> None:
    print(msg, flush=True)


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return f"{n:.1f} TB"


def run(cmd: list, cwd: Path | None = None, check: bool = True,
        env: dict | None = None) -> subprocess.CompletedProcess:
    printable = " ".join(str(x) if " " not in str(x) else repr(str(x)) for x in cmd)
    log(f"+ {printable}")
    r = subprocess.run([str(x) for x in cmd], cwd=str(cwd) if cwd else None,
                       env=env)
    if check and r.returncode != 0:
        raise SystemExit(f"command failed ({r.returncode}): {printable}")
    return r


def human_free() -> int:
    return shutil.disk_usage(str(ROOT)).free


def require_free(need: int, why: str) -> None:
    free = human_free()
    if free < need:
        raise SystemExit(
            f"not enough disk space for {why}: need {human(need)}, "
            f"have {human(free)}. Free space or pass --skip-space-check.")
    log(f"disk: {human(free)} free (need ~{human(need)} for {why})")


# --------------------------------------------------------------------------
# Config / arguments
# --------------------------------------------------------------------------

def config_args(cfg: dict) -> list[str]:
    out: list[str] = []
    for key, flag in (("images", "--image"), ("archive_items", "--archive-item")):
        vals = cfg.get(key) or []
        if isinstance(vals, str):
            vals = [vals]
        for v in vals:
            out += [flag, v]
    aliases = {
        "game_dir": "--game-dir", "mao_zip": "--mao-zip",
        "mao_dir": "--mao-dir", "workdir": "--workdir",
        "build_dir": "--build-dir", "host": "--host",
        "port": "--port", "jobs": "--jobs",
        "movie_crf": "--movie-crf", "movie_height": "--movie-height",
        "include": "--include", "min_file_mb": "--min-file-mb",
        "item_metadata": "--item-metadata", "hashes": "--hashes",
    }
    if cfg.get("no_hashes"):
        out += ["--hashes", ""]
    if cfg.get("strict_hashes"):
        out.append("--strict-hashes")
    for v in cfg.get("source_dir") or cfg.get("source_dirs") or []:
        out += ["--source-dir", v]
    if cfg.get("download_missing"):
        out.append("--download-missing")
    for key, flag in aliases.items():
        if cfg.get(key) is not None:
            out += [flag, str(cfg[key])]
    for key, yes, no in (
        ("assets", "--assets", "--no-assets"),
        ("serve", "--serve", "--no-serve"),
        ("open", "--open", "--no-open"),
        ("auto_deps", "--auto-deps", "--no-auto-deps"),
        ("force", "--force", None),
        ("only_serve", "--only-serve", None),
        ("verify_only", "--verify-only", None),
        ("i_own_the_game", "--i-own-the-game", None),
    ):
        if key not in cfg:
            continue
        if cfg[key] and yes:
            out.append(yes)
        elif not cfg[key] and no:
            out.append(no)
    return out


def parse_args(argv: list[str]) -> argparse.Namespace:
    cfg = {}
    for i, a in enumerate(argv):
        if a == "--config" and i + 1 < len(argv):
            try:
                cfg = json.loads(Path(argv[i + 1]).read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                raise SystemExit(f"bad --config: {e}")
        elif a.startswith("--config="):
            try:
                cfg = json.loads(Path(a.split("=", 1)[1]).read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                raise SystemExit(f"bad --config: {e}")
    ap = argparse.ArgumentParser(
        description="One-command asset extraction + data build + local web server.",
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--config", help="JSON file with images/archive_items/mao_zip/...")
    ap.add_argument("--game-dir", help="existing installed/extracted game directory")
    ap.add_argument("--image", action="append", default=[],
                    help="local image/archive/dir, or direct http(s) URL (repeatable)")
    ap.add_argument("--archive-item", action="append", default=[],
                    help="https://archive.org/details/<id> (repeatable)")
    ap.add_argument("--include", default="*.iso,*.mdf,*.bin,*.nrg,*.cdi,*.7z,*.zip,*.rar,*.001",
                    help="archive item file globs (comma-separated)")
    ap.add_argument("--min-file-mb", type=int, default=50,
                    help="ignore tiny archive item files (default 50)")
    ap.add_argument("--mao-zip", help="MAO English release zip (path or URL)")
    ap.add_argument("--mao-dir", help="MAO script-data directory or upstream clone")
    ap.add_argument("--workdir", default=str(CACHE))
    ap.add_argument("--build-dir", default=None)
    ap.add_argument("--assets", action=argparse.BooleanOptionalAction, default=True,
                    help="extract images/audio/movies (default: yes)")
    ap.add_argument("--serve", action=argparse.BooleanOptionalAction, default=True,
                    help="start the local web server (default: yes)")
    ap.add_argument("--open", action=argparse.BooleanOptionalAction, default=True,
                    help="open the browser (default: yes)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--jobs", type=int, default=8)
    ap.add_argument("--movie-crf", type=int, default=21)
    ap.add_argument("--movie-height", type=int, default=0)
    ap.add_argument("--auto-deps", action=argparse.BooleanOptionalAction, default=True,
                    help="install missing Python/ffmpeg deps into .cache/venv")
    ap.add_argument("--force", action="store_true",
                    help="re-download/re-extract/rebuild even if outputs exist")
    ap.add_argument("--only-serve", action="store_true",
                    help="skip extraction/build and serve an existing web/dist")
    ap.add_argument("--skip-space-check", action="store_true")
    ap.add_argument("--dry-run", action="store_true",
                    help="resolve inputs and print the plan without building")
    ap.add_argument("--i-own-the-game", action="store_true",
                    help="required for network image downloads; you must own the game")
    ap.add_argument("--source-dir", action="append", default=[],
                    help="dir with user-downloaded archive item files (repeatable)")
    ap.add_argument("--item-metadata", help="cached archive.org metadata JSON (no network)")
    ap.add_argument("--hashes", default=str(ROOT / "data" / "archive-checksums.json"),
                    help="archive.org item hash sheet (size+md5); empty disables")
    ap.add_argument("--strict-hashes", action="store_true",
                    help="fail the build when the hash sheet cannot be verified")
    ap.add_argument("--verify-only", action="store_true",
                    help="hash local files vs item metadata; build/serve nothing")
    ap.add_argument("--download-missing", action="store_true",
                    help="allow fetching missing archive item files (opt-in)")
    ap.add_argument("--python", help="Python interpreter for build/extract tools")
    args = ap.parse_args(config_args(cfg) + argv)
    args.workdir = Path(args.workdir).expanduser().resolve()
    args.build_dir = Path(args.build_dir).expanduser().resolve() if args.build_dir \
        else ROOT / "build"
    if args.movie_height < 0 or args.port < 1 or args.port > 65535:
        raise SystemExit("bad --movie-height/--port")
    return args


# --------------------------------------------------------------------------
# Dependency bootstrap
# --------------------------------------------------------------------------

def have_module(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


def venv_python(work: Path) -> Path:
    venv = work / "venv"
    py = venv / "bin" / "python"
    if not py.exists() and os.name == "nt":
        py = venv / "Scripts" / "python.exe"
    if py.exists():
        return py
    log(f"creating isolated Python env: {venv}")
    run([sys.executable, "-m", "venv", "--without-pip", str(venv)], check=False)
    if not py.exists():
        raise SystemExit("python venv module is unavailable; install python3-venv")
    # Debian often ships venv without ensurepip; bootstrap pip if needed.
    pip_ok = run([py, "-m", "pip", "--version"], check=False).returncode == 0
    if not pip_ok:
        get_pip = work / "get-pip.py"
        if not get_pip.exists():
            download_url("https://bootstrap.pypa.io/get-pip.py", get_pip)
        run([py, str(get_pip)], check=True)
    return py


def ensure_deps(args: argparse.Namespace) -> Path:
    """Ensure tools can decode images/audio. Re-exec under .cache/venv."""
    if args.python:
        py = Path(args.python).expanduser().resolve()
        if Path(sys.executable) != py:
            os.execve(str(py), [str(py), str(Path(__file__).resolve()), *sys.argv[1:]],
                      dict(os.environ))
        return py
    py = Path(sys.executable)

    needs: list[str] = []
    if args.assets and not have_module("PIL"):
        needs.append("pillow")
    if args.assets and not shutil.which("ffmpeg") and not have_module("imageio_ffmpeg"):
        needs.append("imageio-ffmpeg")
    if args.image or args.archive_item:
        if not shutil.which("7z") and not shutil.which("7za") \
                and not shutil.which("7zz") and not shutil.which("bsdtar"):
            if not have_module("pycdlib"):
                needs.append("pycdlib")
            if not have_module("py7zr"):
                needs.append("py7zr")
    if not needs:
        return py
    if not args.auto_deps:
        raise SystemExit(
            "missing Python/tool dependencies: " + ", ".join(needs) +
            "\nInstall them, or rerun with --auto-deps (default) to create "
            f"{args.workdir / 'venv'}.")

    vpy = venv_python(args.workdir)
    if Path(sys.executable) != vpy:
        env = dict(os.environ, WA2_ONECLICK_VENV="1")
        log(f"re-exec under {vpy}")
        os.execve(str(vpy), [str(vpy), str(Path(__file__).resolve()), *sys.argv[1:]], env)
    # Already in the venv: install anything still missing.
    pkgs = []
    for mod, pkg in (("PIL", "pillow"), ("pycdlib", "pycdlib"),
                     ("py7zr", "py7zr"), ("imageio_ffmpeg", "imageio-ffmpeg")):
        if pkg in needs and not have_module(mod) and pkg not in pkgs:
            pkgs.append(pkg)
    # Keep the venv complete for later reruns, but only when this run needs it.
    if pkgs:
        run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
             *pkgs], check=True)
    return Path(sys.executable)


def ensure_ffmpeg(args: argparse.Namespace) -> None:
    if not args.assets or shutil.which("ffmpeg"):
        return
    try:
        import imageio_ffmpeg  # type: ignore
        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        log("WARN no ffmpeg and no imageio-ffmpeg; movies will be reported missing")
        return
    bindir = args.workdir / "bin"
    bindir.mkdir(parents=True, exist_ok=True)
    dst = bindir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if not dst.exists():
        try:
            os.symlink(exe, dst)
        except OSError:
            shutil.copy2(exe, dst)
    os.environ["PATH"] = str(bindir) + os.pathsep + os.environ.get("PATH", "")
    log(f"using bundled ffmpeg: {exe}")


# --------------------------------------------------------------------------
# Download helpers
# --------------------------------------------------------------------------

def file_md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download_url(url: str, dest: Path, md5: str | None = None,
                 size: int | None = None) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    size = size or None
    if dest.exists() and (size is None or dest.stat().st_size == size):
        if md5 and file_md5(dest).lower() != md5.lower():
            log(f"checksum mismatch, removing {dest}")
            dest.unlink()
        else:
            log(f"cached: {dest} ({human(dest.stat().st_size)})")
            return dest
    if size:
        overhead = (1 << 30) if size > 100 * (1 << 20) else 0
        require_free(size + overhead, f"download {dest.name}")
    part = dest.with_name(dest.name + ".part")
    log(f"downloading {url}\n  -> {dest}")
    tries = 0
    while tries < 3:
        tries += 1
        if shutil.which("curl"):
            cmd = ["curl", "-L", "--fail", "--retry", "5", "--retry-delay", "3",
                   "--create-dirs", "-o", str(part)]
            if part.exists() and part.stat().st_size:
                cmd += ["-C", "-"]
            cmd.append(url)
            r = run(cmd, check=False)
        else:
            r = _urllib_download(url, part)
        if r.returncode == 0:
            break
        if part.exists():
            part.unlink()
        log(f"download failed (attempt {tries}/3)")
        if tries < 3:
            time.sleep(3)
    if not part.exists():
        raise SystemExit(f"download failed: {url}")
    part.replace(dest)
    if size and dest.stat().st_size != size:
        raise SystemExit(f"size mismatch for {dest.name}: {dest.stat().st_size} != {size}")
    if md5:
        got = file_md5(dest)
        if got.lower() != md5.lower():
            raise SystemExit(f"md5 mismatch for {dest.name}: {got} != {md5}")
    return dest


def _urllib_download(url: str, part: Path) -> subprocess.CompletedProcess:
    class Fake:
        returncode = 0

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "wa2-oneclick/1"})
        with urllib.request.urlopen(req, timeout=120) as r, open(part, "ab") as f:
            shutil.copyfileobj(r, f)
        return Fake()  # type: ignore[return-value]
    except Exception as e:
        log(f"urllib download failed: {e}")
        return __import__("subprocess").CompletedProcess([], 1)


def http_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "wa2-oneclick/1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def read_item_meta(args: argparse.Namespace) -> dict:
    """Item metadata: JSON cache in --item-metadata, then a local cache."""
    cache = args.workdir / "archive-meta.json"
    if args.item_metadata:
        p = Path(args.item_metadata).expanduser().resolve()
        if not p.is_file():
            raise SystemExit(f"--item-metadata not found: {p}")
        shutil.copy2(p, cache)
        log(f"using local item metadata: {p}")
        return json.loads(p.read_text(encoding="utf-8"))
    if cache.is_file():
        log(f"using cached item metadata: {cache}")
        return json.loads(cache.read_text(encoding="utf-8"))
    return {}


def archive_items(args: argparse.Namespace) -> list[tuple[str, str, int, str | None]]:
    """Return (name, download_url, size, md5) selected from archive items."""
    out: list[tuple[str, str, int, str | None]] = []
    patterns = [p.strip() for p in args.include.split(",") if p.strip()]
    for item in args.archive_item:
        m = re.search(r"/(?:details|download)/([^/?#]+)", item)
        item_id = m.group(1) if m else item.strip()
        log(f"archive.org item: {item_id}")
        cached = read_item_meta(args)
        meta = None
        if cached:
            ident = (cached.get("metadata") or {}).get("identifier")
            if ident == item_id:
                meta = cached
            elif args.item_metadata:
                raise SystemExit(
                    f"--item-metadata does not match item {item_id} "
                    f"(matches {ident}); pass the matching JSON.")
        if meta is None:
            # Local-only mode: never fetch an item live. The user saves the
            # metadata JSON once (curl https://archive.org/metadata/<id> >
            # meta.json) and passes it with --item-metadata; the script
            # caches it and hashes the downloaded files locally.
            raise SystemExit(
                "archive.org item metadata is not cached locally. The script"
                " does not fetch items by itself: download the item metadata"
                " JSON once"
                " (curl https://archive.org/metadata/"
                + item_id
                + " > meta.json) and pass --item-metadata meta.json. Then"
                " the script hashes your downloaded files and builds without"
                " any network.")

        files = []
        for f in meta.get("files", []):
            name = f.get("name") or ""
            size = int(f.get("size") or 0)
            low = name.lower()
            if not any(fnmatch.fnmatch(low, p.lower()) for p in patterns):
                continue
            if size and size < args.min_file_mb * 1024 * 1024:
                continue
            files.append((name, size, f.get("md5")))
        # Prefer original disc images over re-archived copies. If an item
        # has both, use the ISO set (no need to download a duplicate MDF set).
        isos = [f for f in files if f[0].lower().endswith(".iso")]
        mdfs = [f for f in files if f[0].lower().endswith(".mdf")]
        chosen = isos or mdfs or files
        if not chosen:
            exts = sorted({Path(f.get("name", "")).suffix.lower()
                           for f in meta.get("files", [])})
            raise SystemExit(
                f"no files matching {args.include} in {item_id}; item has {exts}")
        # Add .mds companions for .mdf and all split .7z.NNN parts.
        names = {f[0] for f in chosen}
        for f in meta.get("files", []):
            n = f.get("name") or ""
            if f.get("size") and int(f["size"]) > 0 and (
                    (n.lower().endswith(".mds") and any(
                        c[0].lower().endswith(".mdf") and
                        Path(c[0]).stem == Path(n).stem for c in chosen)) or
                    (re.search(r"\.7z\.\d+$", n, re.I) and any(
                        c[0].lower().endswith(".7z.001") and
                        n.split(".")[0] == c[0].split(".")[0] for c in chosen))):
                if n not in names:
                    chosen.append((n, int(f.get("size") or 0), f.get("md5")))
                    names.add(n)
        chosen.sort(key=lambda x: x[0])
        total = sum(c[1] for c in chosen)
        log(f"selected {len(chosen)} file(s), {human(total)}:")
        for n, s, _ in chosen:
            log(f"  {human(s):>10s}  {n}")
        if not args.skip_space_check and args.download_missing:
            require_free(total + 8 * (1 << 30), "download + extraction + assets")
        for n, s, md5 in chosen:
            url = f"https://archive.org/download/{urllib.parse.quote(item_id)}/" \
                  + urllib.parse.quote(n, safe="/")
            out.append((n, url, s, md5))
    return out



def verify_sheet(args: argparse.Namespace) -> str:
    """Optional: do you have the archive.org copy? (advisory by default).

    Loads the repo hash sheet (or --hashes FILE) and looks for matching
    files among user dirs + --game-dir. Returns "ok:<n>/<m>",
    "skipped", or "mismatch"; --strict-hashes makes mismatch fatal.
    """
    if not args.hashes:
        return "skipped"
    sheet, entries = builtin_hash_sheet(args)
    if sheet is None:
        return "skipped"
    roots: list[Path] = []
    if args.game_dir:
        roots.append(Path(args.game_dir).expanduser().resolve())
    roots += candidate_roots(args)
    ok = mismatch = missing = 0
    for e in entries:
        name = e.get("name") or ""
        size = int(e.get("size") or 0)
        md5 = (e.get("md5") or "")
        if not md5 or not size:
            continue  # hash sheets carry only MD5-able entries
        hit = find_local_match(name, size, md5, roots) if roots else None
        if hit is None:
            missing += 1
            continue
        if verify_entry(hit, size, md5) == "OK":
            ok += 1
        else:
            mismatch += 1
    total = ok + mismatch + missing
    if ok == total and total:
        msg = f"archive copy verified: {ok}/{total} files"
        if args.strict_hashes:
            return msg
        log(f"[wa2] {msg} (hash sheet {Path(args.hashes).name})")
        return msg
    state = "advisory: could not verify"
    if args.strict_hashes and mismatch:
        raise SystemExit(
            f"archive.org hash sheet did not verify locally ({ok}/{total} ok, "
            f"{mismatch} mismatch, {missing} missing); --strict-hashes refuses "
            "to continue. Pass --hashes '' to skip.")
    log(f"[wa2] {state} archive.org copy ({ok}/{total} ok, {mismatch} "
        f"mismatch, {missing} missing); continuing")
    return "mismatch"

# --------------------------------------------------------------------------
# Archive extraction
# --------------------------------------------------------------------------

def safe_name(name: str) -> str:
    name = name.replace("\\", "/")
    parts = [p for p in name.split("/") if p not in ("", ".", "..")]
    return os.path.join(*parts) if parts else "unnamed"


def extract_zip(path: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path) as z:
        for member in z.infolist():
            target = dest / safe_name(member.filename)
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(member) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)


def extract_7z(path: Path, dest: Path) -> bool:
    for tool in ("7z", "7za", "7zz"):
        if shutil.which(tool):
            run([tool, "x", "-y", f"-o{dest}", str(path)])
            return True
    if shutil.which("bsdtar"):
        dest.mkdir(parents=True, exist_ok=True)
        run(["bsdtar", "-xf", str(path), "-C", str(dest)])
        return True
    if path.suffix.lower() == ".7z" and have_module("py7zr"):
        import py7zr  # type: ignore
        dest.mkdir(parents=True, exist_ok=True)
        with py7zr.SevenZipFile(path, mode="r") as z:
            z.extractall(dest)
        return True
    return False


def extract_iso(path: Path, dest: Path) -> bool:
    if shutil.which("7z") or shutil.which("7za") or shutil.which("7zz") \
            or shutil.which("bsdtar"):
        try:
            return extract_7z(path, dest)
        except SystemExit:
            log("7z/bsdtar failed on ISO; trying pycdlib fallback")
    if have_module("pycdlib"):
        import pycdlib  # type: ignore
        dest.mkdir(parents=True, exist_ok=True)
        iso = pycdlib.PyCdlib()
        iso.open(str(path))
        try:
            # Prefer Joliet names (preserve case), then ISO9660, then UDF.
            walker = None
            kw = ""
            for candidate in ("joliet_path", "iso_path", "udf_path"):
                try:
                    rows = list(iso.walk(**{candidate: "/"}))
                except Exception:
                    continue
                if any(files for _d, _dirs, files in rows):
                    walker, kw = rows, candidate
                    break
            if walker is None:
                raise SystemExit(f"no readable file tree in ISO {path.name}")
            for dirname, _dirs, files in walker:
                for f in files:
                    iso_path = dirname.rstrip("/") + "/" + f
                    rel = iso_path.lstrip("/")
                    if kw == "iso_path":
                        rel = rel.split(";")[0]
                    target = dest / safe_name(rel)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    iso.get_file_from_iso(str(target), **{kw: iso_path})
        finally:
            iso.close()
        log(f"extracted ISO with pycdlib: {path.name}")
        return True

    return False


def extract_one(path: Path, dest: Path) -> None:
    low = path.suffix.lower()
    if path.is_dir():
        shutil.copytree(path, dest, dirs_exist_ok=True)
        return
    if low == ".zip":
        extract_zip(path, dest)
        return
    if low in (".iso", ".mdf", ".bin", ".nrg", ".cdi"):
        if not extract_iso(path, dest):
            raise SystemExit(
                f"cannot extract {path.name}: install p7zip-full, libarchive-tools, "
                "or rerun with --auto-deps (pycdlib only supports ISO9660/UDF .iso).")
        return
    if low in (".7z", ".rar", ".001"):
        if not extract_7z(path, dest):
            raise SystemExit(
                f"cannot extract {path.name}: install p7zip-full (7z) or unrar.")
        return
    if low == ".mds":
        return  # companion of .mdf
    raise SystemExit(f"unsupported image/archive type: {path}")


CANON_GAME = {
    "script.pak": "script.pak", "bak.pak": "bak.pak", "char.pak": "char.pak",
    "grp.pak": "grp.pak", "fnt.pak": "fnt.pak", "voice.pak": "VOICE.PAK",
    "bgm.pak": "BGM.PAK", "se.pak": "SE.PAK",
}


def canonicalize_tree(root: Path) -> None:
    """Normalize extracted disc case (ISO9660 is uppercase; 7z keeps it)."""
    # Directory first: build.py asks for IC/BGM.PAK explicitly.
    for d in [p for p in root.rglob("*") if p.is_dir()]:
        if d.name.lower() == "ic" and d.name != "IC":
            target = d.with_name("IC")
            if not target.exists():
                d.rename(target)
    files = [p for p in root.rglob("*") if p.is_file()]
    for p in files:
        low = p.name.lower()
        canon = CANON_GAME.get(low)
        if canon is None and re.fullmatch(r"mv\d+\.pak", low):
            canon = low
        if canon and p.name != canon:
            target = p.with_name(canon)
            if not target.exists():
                p.rename(target)


def nested_extract(root: Path, max_depth: int = 2) -> None:
    """Extract archives found inside extracted trees (disc -> installer cab)."""
    for _ in range(max_depth):
        found = []
        for p in root.rglob("*"):
            if p.is_file() and p.suffix.lower() in (
                    ".iso", ".7z", ".zip", ".rar", ".cab", ".msi"):
                found.append(p)
        if not found:
            return
        for p in found:
            out = p.parent / (p.stem + "_extracted")
            if out.exists():
                continue
            log(f"nested extract: {p.name}")
            if p.suffix.lower() in (".cab", ".msi") and not (
                    shutil.which("7z") or shutil.which("bsdtar")):
                log(f"WARN no 7z/bsdtar for {p.name}")
                continue
            if not extract_7z(p, out) and p.suffix.lower() == ".zip":
                extract_zip(p, out)
            elif p.suffix.lower() == ".iso" and not out.exists():
                extract_iso(p, out)


# --------------------------------------------------------------------------
# Locate game / MAO inputs
# --------------------------------------------------------------------------

def is_game_root(d: Path) -> bool:
    try:
        names = {p.name.lower() for p in d.iterdir() if p.is_file()}
    except OSError:
        return False
    return "script.pak" in names and "bak.pak" in names


def locate_game_root(root: Path) -> Path | None:
    if is_game_root(root):
        return root
    best = None
    best_score = -1
    for d in root.rglob("*"):
        if not d.is_dir():
            continue
        try:
            names = {p.name.lower() for p in d.iterdir() if p.is_file()}
        except OSError:
            continue
        if "script.pak" not in names:
            continue
        score = sum(1 for n in PK_NAMES if n in names)
        if score > best_score:
            best, best_score = d, score
    return best


def attach_ic_dir(main_root: Path, search_root: Path) -> None:
    """Give build.py/voice/BGM an IC/ subdir when it is a sibling on a disc."""
    if (main_root / "IC").exists():
        return
    cands = []
    for d in search_root.rglob("*"):
        if not d.is_dir() or d.name.lower() != "ic":
            continue
        if d.resolve() == main_root.resolve():
            continue
        # Prefer an IC next to the main root, then the one with most paks.
        has = sum(1 for p in d.iterdir() if p.is_file())
        cands.append((d.parent == main_root.parent, has, len(d.parts), d))
    if not cands:
        return
    cands.sort(key=lambda t: (t[0], t[1], t[2]), reverse=True)
    src = cands[0][3]
    dst = main_root / "IC"
    try:
        os.symlink(src.resolve(), dst, target_is_directory=True)
        log(f"linked IC assets: {dst} -> {src}")
    except OSError as e:
        log(f"WARN could not link IC dir ({e}); intro assets may be missing")


def find_mao_paks(root: Path) -> tuple[Path | None, Path | None]:
    main = special = None
    for p in root.rglob("en.pak"):
        low = str(p).lower()
        if "special" in low or "patch" in p.parts:
            special = special or p
        else:
            main = main or p
    if main is None and special is not None:
        main, special = special, None
    return main, special


def locate_script_data(path: Path | None) -> Path | None:
    if not path:
        return None
    if (path / "index.json").is_file():
        return path
    for candidate in (path / "public" / "script-data", path / "script-data"):
        if (candidate / "index.json").is_file():
            return candidate
    for p in path.rglob("script-data/index.json"):
        return p.parent
    return None


def clone_mao_script(work: Path) -> Path | None:
    dest = work / "upstream" / "mao-white-album-2"
    if (dest / "public" / "script-data" / "index.json").is_file():
        return dest / "public" / "script-data"
    if not shutil.which("git"):
        log("WARN git not installed; building without MAO manuscript text")
        return None
    log("cloning MAO script-data (translation text only)")
    r = run(["git", "clone", "--depth", "1",
             "https://github.com/MAO-TLs/white-album-2", str(dest)], check=False)
    if r.returncode != 0:
        log("WARN MAO clone failed; building without manuscript text")
        return None
    return dest / "public" / "script-data"


def resolve_mao(args: argparse.Namespace) -> tuple[Path, Path | None, Path | None]:
    roots: list[Path] = []
    if args.mao_zip:
        if args.mao_zip.startswith(("http://", "https://")):
            log("downloading MAO release archive")
            name = Path(urllib.parse.urlparse(args.mao_zip).path).name or "mao.zip"
            z = download_url(args.mao_zip, args.workdir / "downloads" / name)
        else:
            z = Path(args.mao_zip).expanduser()
        out = args.workdir / "mao"
        if not out.exists() or args.force:
            if z.suffix.lower() == ".zip":
                extract_zip(z, out)
            elif not extract_7z(z, out):
                raise SystemExit(f"cannot extract MAO zip: {z}")
        roots.append(out)
    for c in (args.workdir / "mao", CACHE / "mao_v210",
              CACHE / "mao_v210" / "White_Album_2_Complete_English_Release_v2.1.0"):
        if c.exists():
            roots.append(c)
    main = special = None
    for root in roots:
        m, s = find_mao_paks(root)
        main = main or m
        special = special or s
        if main and special:
            break
    if not main:
        raise SystemExit(
            "no MAO en.pak found. Pass --mao-zip (release zip) or --game-dir "
            "with an existing translation, or place the release under .cache/mao_v210.")
    script = locate_script_data(Path(args.mao_dir).expanduser() if args.mao_dir else None)
    if not script:
        script = locate_script_data(CACHE / "upstream" / "mao-white-album-2")
    if not script:
        script = clone_mao_script(args.workdir)
    return main, special, script


# --------------------------------------------------------------------------
# Main stages
# --------------------------------------------------------------------------

def archive_item_id(url: str) -> str:
    m = re.search(r"/(?:details|download)/([^/?#]+)", url)
    return m.group(1) if m else url.strip()


def candidate_roots(args: argparse.Namespace) -> list[Path]:
    """Dirs the user may have dropped downloaded files into."""
    out = [args.workdir / "downloads"]
    if args.source_dir:
        for raw in args.source_dir:
            p = Path(raw).expanduser().resolve()
            if p.is_dir() and p not in out:
                out.append(p)
    for raw in args.image:
        if not raw.startswith(("http://", "https://")):
            p = Path(raw).expanduser().resolve()
            if p.is_dir() and p not in out:
                out.append(p)
    return out


def find_local_match(name: str, size: int, md5: str | None,
                     roots: list[Path]) -> Path | None:
    """Locate a downloaded file by basename; size/md5 verify the match."""
    base = Path(name).name.lower()
    cands: list[Path] = []
    for root in roots:
        if not root.is_dir():
            continue
        for p in root.rglob("*"):
            if p.is_file() and p.name.lower() == base:
                cands.append(p)
    if not cands:
        return None
    if size:
        sized = [p for p in cands if p.stat().st_size == size]
        if sized:
            cands = sized
    if md5:
        for p in cands:
            if file_md5(p).lower() == md5.lower():
                return p
        return None
    return cands[0]


def verify_entry(hit: Path, size: int, md5: str) -> str:
    """OK / MISMATCH for a size+md5 pair."""
    if size and hit.stat().st_size != size:
        return "MISMATCH"
    if not md5 or file_md5(hit).lower() == md5.lower():
        return "OK"
    return "MISMATCH"


def builtin_hash_sheet(args: argparse.Namespace
                       ) -> tuple[dict | None, list[dict]]:
    """Optional archive.org copy check (users override or skip).

    data/archive-checksums.json holds public sizes + md5s for the item you
    verify against; `--hashes FILE` replaces it, `--hashes ''` disables it,
    and a non-verifying sheet is advisory unless --strict-hashes.
    """
    if not args.hashes:
        return None, []
    p = Path(args.hashes).expanduser()
    if not p.is_file():
        return None, []
    sheet = json.loads(p.read_text(encoding="utf-8"))
    return sheet, list(sheet.get("files") or [])


def run_item_verification(args: argparse.Namespace) -> None:
    """User-supplied archive item: verify sizes + hashes locally only."""
    roots = candidate_roots(args)
    sheet, sheet_files = builtin_hash_sheet(args)
    if args.item_metadata:
        meta = read_item_meta(args)
        items = (meta.get("files") or [])[:]
    elif sheet:
        items = sheet_files
        log(f"hash sheet: {args.hashes}")
    else:
        raise SystemExit(
            "--verify-only needs --item-metadata FILE (the archive.org "
            "metadata JSON) or the repo hash sheet "
            "(data/archive-checksums.json).")
    want: list[dict] = []
    for f in items:
        try:
            size = int(f.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        if not size or size < 1 << 20 or not f.get("md5"):
            continue
        want.append({"name": f.get("name") or "", "size": size,
                     "md5": (f.get("md5") or "")})
    ok = mismatch = missing = 0
    rows: list[str] = []
    import time as _t
    for f in want:
        hit = find_local_match(f["name"], f["size"], f["md5"], roots)
        if hit is None:
            missing += 1
            rows.append(f"MI  {f['name']}  (size {f['size']})")
            log(f"MISSING {f['name']} ({human(f['size'])})")
            continue
        t0 = _t.time()
        got = file_md5(hit)
        if got.lower() == f["md5"].lower():
            ok += 1
            rows.append(f"OK  {f['name']}  {got}")
            log(f"OK   {hit.name} ({human(f['size'])}) md5={got} "
                f"({_t.time() - t0:.1f}s)")
        else:
            mismatch += 1
            rows.append(f"BAD {f['name']}  {got} != {f['md5']}")
            log(f"MISMATCH {hit.name}: md5 {got} != {f['md5']}")
    out = args.workdir / "verify-report.txt"
    out.write_text("\n".join(rows), encoding="utf-8")
    log(f"verification: {ok} ok, {mismatch} mismatch, {missing} missing "
        f"-> {out}")
    if mismatch or missing:
        raise SystemExit(1)


def extract_dir_input(src: Path, discs: Path, name: str) -> None:
    """Extract a directory of user-supplied archives into one staging tree.

    Installer `.LAC` trees (Leaf/Extended Edition) merge their payloads so a
    single game root appears; other archives are copied and unpacked by the
    nested pass.
    """
    lacs = sorted(src.rglob("*.LAC")) + sorted(src.rglob("*.lac"))
    if lacs:
        dest = discs / (re.sub(r"[^A-Za-z0-9._-]+", "_", name) + "_installer")
        dest.mkdir(parents=True, exist_ok=True)
        for lac in lacs:
            try:
                from extract_lac import extract_stream  # type: ignore
            except ImportError:
                sys.path.insert(0, str(TOOLS))
                from extract_lac import extract_stream  # type: ignore
            log(f"extracting {lac.name} ({human(lac.stat().st_size)})")
            extract_stream(str(lac), str(dest))
        return
    shutil.copytree(src, discs / name, dirs_exist_ok=True)


# --------------------------------------------------------------------------
    if args.game_dir:
        g = Path(args.game_dir).expanduser().resolve()
        if not g.exists():
            raise SystemExit(f"--game-dir does not exist: {g}")
        root = locate_game_root(g)
        if not root:
            raise SystemExit(f"no script.pak/bak.pak found under {g}")
        return root, g
def prepare_game(args: argparse.Namespace) -> tuple[Path, Path]:
    if args.game_dir:
        g = Path(args.game_dir).expanduser().resolve()
        if not g.exists():
            raise SystemExit(f"--game-dir does not exist: {g}")
        root = locate_game_root(g)
        if not root:
            raise SystemExit(f"no script.pak/bak.pak found under {g}")
        return root, g
    auto = CACHE / "game"
    if not args.image and not args.archive_item and auto.exists() and is_game_root(auto):
        log(f"using existing installed game: {auto}")
        return auto, auto
    image_args = list(args.image)
    # Local-first mode: match archive item files against the user's own
    # source dirs; the user downloads, the script verifies + extracts.
    net_files = archive_items(args) if args.archive_item else []
    local_matches: list[Path] = []
    missing: list[tuple[str, int]] = []
    if net_files:
        roots = candidate_roots(args)
        for name, _url, size, md5 in net_files:
            hit = find_local_match(name, size, md5, roots)
            if hit:
                local_matches.append(hit)
            else:
                missing.append((name, size or 0))

    if missing and not args.download_missing:
        hint = "; ".join(n for n, _s in missing[:6])
        raise SystemExit(
            f"{len(missing)} archive item file(s) are not present locally "
            f"({hint}). Download them yourself into one of: "
            + ", ".join(str(r) for r in candidate_roots(args)) +
            " — then rerun. (Or pass --download-missing to fetch from the item.)")
    if not image_args and not local_matches:
        raise SystemExit(
            "no game input. Use --game-dir, --image disc.iso, --source-dir DIR "
            "with the user-downloaded files, or --archive-item URL.")
    if args.dry_run:
        for raw in image_args:
            log(f"image: {raw}")
        for hit in local_matches:
            log(f"local: {hit}")
        for name, _url, size, _md5 in missing:
            log(f"download: {name} ({human(size)})")
        return Path("(dry-run)"), Path("(dry-run)")
    discs = args.workdir / "discs"
    discs.mkdir(parents=True, exist_ok=True)
    inputs: list[Path] = []
    for raw in image_args:
        if raw.startswith(("http://", "https://")):
            if not args.i_own_the_game:
                raise SystemExit("network image download requires --i-own-the-game")
            url_path = Path(urllib.parse.urlparse(raw).path).name
            inputs.append(download_url(raw, args.workdir / "downloads" / url_path))
        else:
            p = Path(raw).expanduser()
            if not p.exists():
                raise SystemExit(f"image not found: {p}")
            inputs.append(p)
    inputs += local_matches
    for f in missing:
        name, size = f
        url = None
        for n, u, sz, _m in net_files:
            if n == name:
                url, size = u, sz
        assert url
        inputs.append(download_url(url, args.workdir / "downloads"
                                   / Path(name).name, size=size))
    local_size = sum(p.stat().st_size for p in inputs if p.is_file())
    if local_size and not args.skip_space_check:
        require_free(local_size * 2 + 8 * (1 << 30), "image extraction + assets")
    for img in inputs:
        if img.is_dir():
            extract_dir_input(img, discs, img.name)
        else:
            out = discs / re.sub(r"[^A-Za-z0-9._-]+", "_", img.stem)
            if args.force and out.exists():
                shutil.rmtree(out)
            if not out.exists() or args.force:
                log(f"extracting {img.name}")
                extract_one(img, out)
    nested_extract(discs)
    canonicalize_tree(discs)
    root = locate_game_root(discs)
    if not root:
        raise SystemExit(
            f"extracted images but found no script.pak/bak.pak under {discs}. "
            "The disc may be an installer-only image; list the extracted files "
            "and extract the data cab manually.")
    attach_ic_dir(root, discs)
    log(f"game root: {root}")
    return root, discs


def build_data(args: argparse.Namespace, game: Path,
               main_pak: Path, special_pak: Path | None,
               script_data: Path | None, py: Path) -> None:
    if not args.skip_space_check:
        require_free(4 * (1 << 30), "data build")
    for sub in ("ir", "data"):
        p = args.build_dir / sub
        if p.exists():
            shutil.rmtree(p)
    if special_pak:
        cmd = [py, TOOLS / "build.py", main_pak, special_pak, args.build_dir]
    else:
        cmd = [py, TOOLS / "build.py", main_pak, args.build_dir]
    cmd += ["--game", game]
    if script_data:
        cmd += ["--mao", script_data]
    run(cmd)


def build_assets(args: argparse.Namespace, asset_source: Path,
                 main_pak: Path, special_pak: Path | None, py: Path) -> bool:
    assets = args.build_dir / "assets"
    if assets.joinpath("manifest.json").is_file() and not args.force:
        log(f"assets already built: {assets} (use --force to refresh)")
        return True
    if not args.skip_space_check:
        require_free(12 * (1 << 30), "asset extraction + web staging")
    if assets.exists():
        shutil.rmtree(assets)
    cmd = [py, TOOLS / "extract_assets.py", asset_source, assets,
           "--en-pak", main_pak, "--jobs", str(args.jobs)]
    if special_pak:
        cmd += ["--en-pak", special_pak]
    if args.movie_crf != 21:
        cmd += ["--movie-crf", str(args.movie_crf)]
    if args.movie_height:
        cmd += ["--movie-height", str(args.movie_height)]
    run(cmd)
    return assets.joinpath("manifest.json").is_file()


def preserve_novels(args: argparse.Namespace) -> Path | None:
    """Keep manual PDFs placed under web/public/data/novels."""
    src = WEB / "public" / "data" / "novels"
    dst = args.workdir / "novels"
    if src.is_dir():
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dst, dirs_exist_ok=True)
        log(f"preserved digital-novel PDFs: {src} -> {dst}")
    return dst if dst.is_dir() else None


def inject_novels(novels: Path | None, build_dir: Path) -> None:
    if novels and novels.is_dir():
        shutil.copytree(novels, build_dir / "data" / "novels", dirs_exist_ok=True)


def clear_public_runtime() -> None:
    """Remove generated public runtime dirs before Vite build.

    The one-click path does not copy data/assets into public (that doubles
    multi-GB trees); runtime dirs are linked into dist after the build.
    """
    for name in ("data", "assets"):
        p = WEB / "public" / name
        if p.exists():
            shutil.rmtree(p)


def link_runtime(args: argparse.Namespace) -> None:
    """Expose build/data + build/assets from dist via symlinks (or copy)."""
    dist = WEB / "dist"
    pairs = [("data", args.build_dir / "data"),
             ("assets", args.build_dir / "assets")]
    for name, src in pairs:
        dst = dist / name
        if dst.exists() or dst.is_symlink():
            if dst.is_dir() and not dst.is_symlink():
                shutil.rmtree(dst)
            else:
                dst.unlink()
        if name == "assets" and (not args.assets or
                                 not (src / "manifest.json").is_file()):
            continue
        if not src.exists():
            continue
        try:
            os.symlink(src, dst, target_is_directory=True)
            log(f"linked dist/{name} -> {src}")
        except OSError:
            shutil.copytree(src, dst)
            log(f"copied dist/{name} <- {src}")


def build_web(args: argparse.Namespace) -> None:
    if not shutil.which("npm"):
        raise SystemExit("npm not found; install Node.js 20+")
    if not (WEB / "node_modules").exists():
        lock = WEB / "package-lock.json"
        run(["npm", "ci"] if lock.exists() else ["npm", "install"], cwd=WEB)
    run(["npm", "run", "build"], cwd=WEB)


def find_port(host: str, start: int) -> int:
    for port in range(start, start + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host if host != "0.0.0.0" else "", port))
                return port
            except OSError:
                continue
    raise SystemExit(f"no free port in {start}..{start + 29}")


def serve(args: argparse.Namespace) -> None:
    port = find_port(args.host, args.port)
    url = f"http://{'localhost' if args.host in ('0.0.0.0', '127.0.0.1') else args.host}:{port}/"
    log(f"serving {WEB / 'dist'} at {url}")
    cmd = ["npm", "run", "preview", "--", "--host", args.host,
           "--port", str(port), "--strictPort"]
    log("+ " + " ".join(cmd))
    proc = subprocess.Popen(cmd, cwd=str(WEB))
    try:
        time.sleep(1.2)
        if args.open:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        raise SystemExit(proc.wait())
    except KeyboardInterrupt:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        raise


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    args.workdir.mkdir(parents=True, exist_ok=True)
    if args.verify_only:
        run_item_verification(args)
        return 0
    if args.only_serve:
        if not (WEB / "dist" / "index.html").is_file():
            raise SystemExit("no web/dist build; run without --only-serve first")
        if args.serve:
            serve(args)
        else:
            log(f"serve with: cd {WEB} && npm run preview -- --host {args.host} --port {args.port}")
        return 0
    need_extract = bool(args.image or args.archive_item) and not args.dry_run
    py = ensure_deps(args) if (not args.dry_run or need_extract) else Path(sys.executable)
    if not args.dry_run:
        ensure_ffmpeg(args)
    game, asset_source = prepare_game(args)
    verify_sheet(args)
    main_pak, special_pak, script_data = resolve_mao(args)
    log(f"translation: {main_pak}" + (f" + {special_pak}" if special_pak else ""))
    log(f"script-data: {script_data or '(none; en-token text fallback)'}")
    if args.dry_run:
        log("DRY RUN: resolving inputs only")
        log(f"game: {game}")
        log(f"assets source: {asset_source}")
        log(f"build dir: {args.build_dir}")
        log(f"port: {args.port}")
        return 0
    if not args.skip_space_check:
        require_free(12 * (1 << 30), "build + web assets")
    novels = preserve_novels(args)
    build_data(args, game, main_pak, special_pak, script_data, py)
    inject_novels(novels, args.build_dir)
    if args.assets:
        build_assets(args, asset_source, main_pak, special_pak, py)
    else:
        log("text-only: skipping asset extraction")
    clear_public_runtime()
    build_web(args)
    link_runtime(args)
    if args.serve:
        serve(args)
    else:
        log(f"done. Serve with: cd {WEB} && npm run preview -- --host {args.host} --port {args.port}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        raise SystemExit(130)
