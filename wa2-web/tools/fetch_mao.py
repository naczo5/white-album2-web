"""Pin + verify the MAO-TLs translation release (default v2.1.0).

The web engine reads scenario text from the user's en.pak, but the
flowchart/guide annotations and text-projection rules track MAO's public
script-data. This tool guarantees both come from the SAME translation
revision, so gameplay wording can never silently drift:

  1. locate script-data (local --clone dir or --url base, default the
     pinned GitHub Pages URL) and assert index.json version == EXPECTED.
  2. drift audit: every engine line (say/narrate, normalized) must appear
     in the same script's manuscript English (normalized). Normalization
     erases systematic engine-vs-manuscript delivery differences
     (`~`/`, `/`...`/punctuation, quotes, F-wrappers, ruby, line breaks)
     but preserves word sequences, so changed/added/dropped wording fails.
     Prints containment; exits 1 if mean < --mean-under (0.90) or any
     script < --fail-under (0.50).

Usage:
  python3 fetch_mao.py IR_DIR [--clone DIR] [--url BASE] [--out OUT]
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import urllib.request

EXPECTED = "2.1.0"
PAGES_BASE = "https://mao-tls.github.io/white-album-2/script-data"
MIN_LEN = 24


def norm(s: str) -> string:
    # Aggressive delivery normalization: engine `~`/punctuation and
    # manuscript punctuation differ systematically (`,`, `...`, `--`
    # vs `~`), so compare alphanumeric sequences only. This still
    # catches real wording drift (changed/added/dropped words).
    s = s.replace("“", '"').replace("”", '"')
    s = s.replace("‘", "'").replace("’", "'")
    s = re.sub(r"<F16\s*([\s\S]*?)>", r"\1", s, flags=re.I)
    s = re.sub(r"\[F16([\s\S]*?)\]", r"\1", s, flags=re.I)
    s = re.sub(r"<\/?[FS]\d*[^>]*>", "", s)
    s = re.sub(r"[\[<][Ww][0-9]+[\]>]", "", s)  # per-char timing tags
    s = re.sub(r"\[R([^\]|^]+)(?:\^|\|)([^\]]*)\]", r"\1", s)
    s = s.replace("\\n", " ")
    s = s.replace("\\k", " ")  # engine page-break marker (special contents)
    s = re.sub(r"[^a-zA-Z0-9']+", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip().lower()


# Engine-only chrome (credits/notices with no manuscript counterpart).
# Audit-skipped by prefix; each entry documents WHY (docs/QA.md).
CHROME_SKIP = (
    "english translations of the digital novels are available as pdf files",
)


def load_index(clone: string | None, url: string) -> tuple[dict, string]:
    if clone:
        with open(os.path.join(clone, "public", "script-data", "index.json")) as f:
            return json.load(f), "clone"
    with urllib.request.urlopen(url + "/index.json") as r:
        return json.load(r), "pages"


def load_script_json(clone: string | None, url: string, route: string,
                     sid: string) -> dict | None:
    name = f"{route}-{sid}.json"
    if clone:
        p = os.path.join(clone, "public", "script-data", name)
        if not os.path.exists(p):
            return None
        with open(p) as f:
            return json.load(f)
    try:
        with urllib.request.urlopen(url + "/" + name) as r:
            return json.load(r)
    except Exception:
        return None


def route_of(sid: string, index: dict) -> str | None:
    for r in index["routes"]:
        if any(s["id"] == sid for s in r["scripts"]):
            return r["id"]
    # special-chapter ids live under route 'special' with odd prefixes
    for r in index["routes"]:
        if r["id"] == "special":
            return "special"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ir_dir", nargs="+", help="one IR dir per en.pak (main, special)")
    ap.add_argument("--clone", default=None)
    ap.add_argument("--url", default=PAGES_BASE)
    ap.add_argument("--out", default=None)
    ap.add_argument("--mean-under", type=float, default=0.90)
    ap.add_argument("--fail-under", type=float, default=0.50)
    args = ap.parse_args()

    index, src = load_index(args.clone, args.url)
    version = index.get("version")
    print(f"MAO script-data version: {version} (via {src}), expected {EXPECTED}")
    if version != EXPECTED:
        print("REFUSED: translation revision mismatch (see docs/LEGAL.md)")
        return 1

    total = hits = 0
    per: list[tuple[str, float, int]] = []
    adapt: list[tuple[str, float, int]] = []
    missing = 0
    untranslated: list[str] = []
    ir_files: list[str] = []
    for d in args.ir_dir:
        ir_files.extend(sorted(glob.glob(os.path.join(d, "*.json"))))
    audited_ids: set[str] = set()
    for fn in ir_files:
        if fn.endswith("index.json"):
            continue
        with open(fn, encoding="utf-8") as f:
            ir = json.load(f)
        sid = ir["script"]
        sj = load_script_json(args.clone, args.url, route_of(sid, index) or "special", sid)
        if sj is None and args.clone:
            cands = glob.glob(os.path.join(args.clone, "public",
                                           "script-data", f"*-{sid}.json"))
            # prefer game-scenario refs (wa2:) over adaptations (wa2mas:)
            def ns(p):
                try:
                    return json.load(open(p))["lines"][0].get("ref", "")
                except Exception:
                    return ""
            cands.sort(key=lambda p: (ns(p).startswith("wa2mas:"), p))
            sj = json.load(open(cands[0])) if cands else None
        if sj is None:
            missing += 1
            continue
        blob = norm(" ".join(l.get("english", "") for l in sj.get("lines", [])))
        lines = [norm(e.get("text", "")) for e in ir["events"]
                 if e["t"] in ("say", "narrate")]
        lines = [t for t in lines
                 if len(t) >= MIN_LEN
                 and not any(t.startswith(c) for c in CHROME_SKIP)]
        if len(lines) < 3:
            # JP-only stub in this en.pak (e.g. special scenes inside the
            # MAIN archive; the Special Contents en.pak carries the EN).
            if sid not in audited_ids:
                untranslated.append(sid)
            continue
        audited_ids.add(sid)
        n = h = 0
        for t in lines:
            n += 1
            if t in blob:
                h += 1
        # Digital-novel scripts (5000-5004, 5100-5104) and other Mini-After-
        # Story adaptations (wa2mas: refs) legitimately reword/restructure
        # vs the engine text; gate only verbatim game scenario, report rest.
        ref0 = (sj.get("lines", [{}])[0] or {}).get("ref", "")
        novel = sid.split("_")[0] in ("5000", "5001", "5002", "5003",
                                      "5004", "5100", "5101", "5102",
                                      "5103", "5104")
        if novel or ref0.startswith("wa2mas:"):
            adapt.append((sid, h / max(1, n), n))
        else:
            total += n
            hits += h
            per.append((sid, h / max(1, n), n))

    mean = hits / max(1, total)
    per.sort(key=lambda x: x[1])
    adapt.sort(key=lambda x: x[1])
    bad = [(s, r) for s, r, _ in per if r < args.fail_under]
    print(f"audited {len(per)} game scripts ({total} lines, missing ref: {missing}, "
          f"untranslated stubs: {len(untranslated)}), mean containment {mean:.3f}")
    if untranslated:
        print("untranslated (JP-only in this en.pak):",
              ", ".join(sorted(set(untranslated))))
    if adapt:
        amean = sum(r for _, r, _ in adapt) / len(adapt)
        print(f"adaptations (report-only, {len(adapt)} scripts): mean {amean:.3f}, "
              "lowest: " + ", ".join(f"{s}={r:.2f}" for s, r, _ in adapt[:5]))
    print("lowest:", ", ".join(f"{s}={r:.2f}" for s, r, _ in per[:8]))
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "mao-ref.json"), "w") as f:
            json.dump({"version": version, "mean": mean,
                       "scripts": len(per), "missing": missing,
                       "untranslated": sorted(set(untranslated)),
                       "adaptations": adapt,
                       "worst": per[:8]}, f, indent=1)
    if bad or mean < args.mean_under:
        print(f"DRIFT: {len(bad)} scripts under {args.fail_under} "
              f"or mean < {args.mean_under}")
        return 1
    print("drift audit passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
