"""One-command build: user-supplied en.pak files (v2.1.0) -> playable web data.

    python3 build.py MAIN_EN_PAK [SPECIAL_EN_PAK] [OUT_DIR=../build] [--game GAMEDIR]
                     [--mao MAO_SCRIPT_DATA] [--alt ID=MAIN_PAK[,SPECIAL_PAK]]...

`--alt` (repeatable, needs --game) builds an extra translation into
`data/translations/<ID>/` (scripts + flow; display text = the alt en.pak's
own tokens with .bnr-anchored tail fragments rejoined — no manuscript) and
publishes `data/translations/index.json` (metadata from
`data/translations.json`).

Steps:
  1. extract .txt scenario sources (KCAP) from each en.pak
  2. parse to event IR JSON (two-pass corpus census for mega resolution)
  3. emit web data dir: build/data/{scripts/*.json, flow.json, endings.json,
     links.json, terminals.json, sprites.json, sys-slots.json, bgm.json,
     bnr.json, luts.json, native-pos.json} (flow/links from IR; endings/
     terminals/sprites/sys-slots from data/; bgm/bnr/voicemap from .bnr
     bytecode; luts from grp.pak with --game; flags.json flag reference +
     .bnr choice gate + native-pos.json ScriptPos anchors need script.pak)
  4. run parity gates (all engine choices covered, option text exact)

Install: cp -r build/data/* web/public/data/  (see docs/BYOA.md)
Verify translation pin: tools/fetch_mao.py (needs upstream clone/network)
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from extract_kcap import extract  # noqa: E402
import parse_txt  # noqa: E402


def parse_corpus(txt_dirs: list[str], ir_dir: str) -> list[str]:
    """Two-pass parse over all txt dirs (shared latch census)."""
    files: list[tuple[str, str]] = []
    for txt_dir in txt_dirs:
        for fn in sorted(os.listdir(txt_dir)):
            if fn.endswith(".txt"):
                files.append((txt_dir, fn))
    census: set[str] = set()
    cache: dict[tuple[str, str], tuple[list[str], list[dict]]] = {}
    seen: dict[str, str] = {}  # script -> txt_dir (later paks override)
    for txt_dir, fn in files:
        with open(os.path.join(txt_dir, fn), "rb") as f:
            toks = parse_txt.split_tokens(f.read())
        events, _ = parse_txt.parse_tokens(toks)
        census.update(e["name"] for e in events if e["t"] == "latch"
                             and parse_txt.census_name(e["name"]))
        cache[(txt_dir, fn)] = (toks, events)
        if fn[:-4] in seen:
            print(f"override: {fn[:-4]} from {txt_dir} wins over {seen[fn[:-4]]}")
        seen[fn[:-4]] = txt_dir
    print(f"census: {len(census)} speaker names over {len(files)} files")
    index = []
    done: set[str] = set()
    for txt_dir, fn in files:
        if fn[:-4] in done or seen[fn[:-4]] != txt_dir:
            continue  # shadowed by a later pak (special EN beats main stub)
        done.add(fn[:-4])
        toks, events = cache[(txt_dir, fn)]
        warnings: list = []
        events, warnings = parse_txt.resplit_mega(events, census, warnings)
        events, warnings = parse_txt.merge_adjacent_choices(events, warnings)
        ir = {"script": fn[:-4], "tokens": len(toks),
              "events": events, "warnings": warnings}
        with open(os.path.join(ir_dir, fn[:-4] + ".json"), "w",
                  encoding="utf-8") as f:
            json.dump(ir, f, ensure_ascii=False, indent=1)
        index.append(ir["script"])
        for w in warnings:
            print(f"      WARN {ir['script']}: {w}")
    return index


def parse_alt(spec: str) -> tuple[str, list[str]]:
    """--alt ID=PAK[,SPECIAL_PAK] -> (id, [paks])."""
    if "=" not in spec:
        raise SystemExit(f"ERROR: --alt wants ID=PAK[,SPECIAL_PAK], got {spec!r}")
    alt_id, pak_list = spec.split("=", 1)
    paks = [p for p in pak_list.split(",") if p.strip()]
    if not alt_id.replace("-", "").replace("_", "").isalnum() or not alt_id:
        raise SystemExit(f"ERROR: --alt id must be alphanumeric: {alt_id!r}")
    if not paks or not all(p.endswith(".pak") for p in paks):
        raise SystemExit(f"ERROR: --alt {alt_id}: paks must end in .pak: {pak_list!r}")
    return alt_id, paks


def alt_flow_from_base(base_flow_path: str, alt_ir_dir: str, out_path: str) -> int:
    """Per-translation flow: base (hand-annotated) routing with the alt
    translation's option text and engine goto association.

    The node set, dates, effects and notes are translation facts; the
    option wording and the option->goto assignment come from the alt IR
    (its association is the cfg-verified one; see the 2019/3016 notes).
    Choice nodes whose alt event is not a choice (bonus-content parse
    drift) keep the base values and are counted.
    """
    with open(base_flow_path, encoding="utf-8") as f:
        flow = json.load(f)
    ir_cache: dict[str, list[dict]] = {}
    swaps = kept = 0
    for node in flow.get("nodes", []):
        sid = node.get("engine", {}).get("script")
        if not sid:
            continue
        if sid not in ir_cache:
            p = os.path.join(alt_ir_dir, sid + ".json")
            ir_cache[sid] = json.load(open(p, encoding="utf-8")).get(
                "events", []) if os.path.exists(p) else []
        events = ir_cache[sid]
        idx = node["engine"].get("event", -1)
        e = events[idx] if 0 <= idx < len(events) else None
        if not e or e.get("t") != "choice" or not isinstance(e.get("options"), list):
            kept += 1
            continue
        alt_opts = {o.get("n"): o for o in e["options"] if isinstance(o, dict)}
        for o in node.get("options", []):
            ao = alt_opts.get(o.get("n"))
            if not ao:
                continue
            if ao.get("text") is not None:
                o["text"] = ao["text"]
            o["goto"] = ao.get("goto")
            swaps += 1
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(flow, f, ensure_ascii=False, indent=1)
    return swaps


def write_translations_index(data_dir: str, alt_ids: list[str]) -> None:
    """Published catalog: the default (always present) + alts with data."""
    cat_path = os.path.join(HERE, "..", "data", "translations.json")
    catalog = []
    if os.path.exists(cat_path):
        with open(cat_path, encoding="utf-8") as f:
            catalog = json.load(f).get("translations", [])
    entries: list[dict] = []
    default = next((e for e in catalog if e.get("default")), None)
    if default:
        entries.append({k: v for k, v in default.items() if k != "default"})
    for alt_id in alt_ids:
        if any(e.get("id") == alt_id for e in entries):
            continue
        meta = next((e for e in catalog if e.get("id") == alt_id), None)
        entries.append(meta if meta else {"id": alt_id, "name": alt_id})
    with open(os.path.join(data_dir, "translations", "index.json"), "w",
              encoding="utf-8") as f:
        json.dump({"version": 1, "translations": entries}, f,
                  ensure_ascii=False, indent=1)


def filter_voicemap(vm: dict, alt_ir_dir: str, base_ir_dir: str,
                    scripts: list[str]) -> tuple[dict, list[str]]:
    """Shared voice map minus scripts whose alt event stream misaligns.

    Keys are (script, event) anchors; an alt script with a different event
    count parses to its own stream, so its voice keys would play the wrong
    clip. Drop them (a wrong sound is worse than a missing one).
    """
    def n_events(path: str) -> int | None:
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as f:
            return len(json.load(f).get("events", []))

    dropped: list[str] = []
    for sid in scripts:
        na = n_events(os.path.join(alt_ir_dir, sid + ".json"))
        nb = n_events(os.path.join(base_ir_dir, sid + ".json"))
        if na is not None and nb is not None and na != nb:
            dropped.append(sid)
    out = {"version": vm.get("version", 2),
           "map": {k: v for k, v in vm.get("map", {}).items()
                   if k not in dropped},
           "chars": {k: v for k, v in vm.get("chars", {}).items()
                     if k not in dropped}}
    return out, dropped


def build_translation(alt_id: str, alt_paks: list[str], jp_pak: str,
                      out: str, data_dir: str) -> None:
    """Alt translation: IR (no manuscript; tail fragments rejoined) +
    scripts + per-translation flow, gated against the shared terminals."""
    print(f"[alt:{alt_id}] scenario IR (no manuscript; fragments rejoined)")
    alt_ir = os.path.join(out, f"ir_{alt_id}")
    os.makedirs(alt_ir, exist_ok=True)
    subprocess.run([sys.executable, os.path.join(HERE, "build_ir.py"),
                    jp_pak, *alt_paks, "", alt_ir], check=True)
    scripts_out = os.path.join(data_dir, "translations", alt_id, "scripts")
    os.makedirs(scripts_out, exist_ok=True)
    with open(os.path.join(alt_ir, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    for s in index:
        shutil.copy(os.path.join(alt_ir, s + ".json"),
                    os.path.join(scripts_out, s + ".json"))
    with open(os.path.join(scripts_out, "index.json"), "w") as f:
        json.dump(index, f)
    print(f"[alt:{alt_id}] flow (base routing, alt option text)")
    swaps = alt_flow_from_base(os.path.join(data_dir, "flow.json"), alt_ir,
                               os.path.join(data_dir, "translations", alt_id,
                                            "flow.json"))
    print(f"[alt:{alt_id}] {swaps} option texts swapped")
    # Voice map is keyed by (script, event) anchors — shared, EXCEPT scripts
    # whose alt event stream does not align with the base build (bonus
    # content parses to its own stream). Drop those keys so a scene plays
    # silent instead of the wrong clip (docs/QA.md rule: a wrong sound is
    # worse than a missing one).
    base_vm_path = os.path.join(data_dir, "voicemap.json")
    base_ir = os.path.join(out, "ir")
    if os.path.exists(base_vm_path):
        with open(base_vm_path, encoding="utf-8") as f:
            vm = json.load(f)
        vm, dropped = filter_voicemap(vm, alt_ir, base_ir, index)
        if dropped:
            print(f"[alt:{alt_id}] voicemap: {len(dropped)} misaligned "
                  f"scripts silenced: {', '.join(dropped[:6])}"
                  f"{'…' if len(dropped) > 6 else ''}")
        with open(os.path.join(data_dir, "translations", alt_id,
                               "voicemap.json"), "w", encoding="utf-8") as f:
            json.dump(vm, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[alt:{alt_id}] flow parity gate")
    r = subprocess.run([sys.executable, os.path.join(HERE, "check_flow.py"),
                        alt_ir,
                        os.path.join(data_dir, "translations", alt_id,
                                     "flow.json"),
                        data_dir])
    if r.returncode != 0:
        print(f"BUILD FAILED: alt:{alt_id} flow parity gate")
        sys.exit(1)


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    paks = []
    game = None
    mao = None
    alts: list[tuple[str, list[str]]] = []
    out = os.path.join(HERE, "..", "build")
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--game":
            game = args[i + 1]
            i += 2
        elif args[i] == "--mao":
            mao = args[i + 1]
            i += 2
        elif args[i] == "--alt":
            alts.append(parse_alt(args[i + 1]))
            i += 2
        elif args[i].endswith(".pak"):
            paks.append(args[i])
            i += 1
        else:
            out = args[i]
            i += 1
    txt_dirs, ir_dir = [], os.path.join(out, "ir")
    data_dir = os.path.join(out, "data")
    os.makedirs(ir_dir, exist_ok=True)

    spak = os.path.join(game, "script.pak") if game else None
    print("[1/4] parsing scenario IR")
    if spak and os.path.isfile(spak):
        # JP-spine IR (build_ir): JP script.pak structure + MAO en.pak
        # payload + manuscript text. Requires --mao for full EN text.
        ir_cmd = [sys.executable, os.path.join(HERE, "build_ir.py"), spak,
                  *paks, mao or "", ir_dir]
        if not mao:
            print("      WARNING: no --mao; display text falls back to "
                  "truncated MAO en.pak tokens")
        subprocess.run(ir_cmd, check=True)
    else:
        # legacy EN-only IR (degraded: MAO en.pak tail-fragment layout)
        print("[1/4] extracting scenario sources")
        for i, pak in enumerate(paks):
            stem = os.path.splitext(os.path.basename(pak))[0] or "pak"
            txt_dir = os.path.join(out, f"txt_{i}_{stem}")
            os.makedirs(txt_dir, exist_ok=True)
            m = extract(pak, txt_dir, {"txt"})
            files = [f for f in m["files"] if not f.get("folder")]
            print(f"      {pak}: {len(files)} scenario files")
            txt_dirs.append(txt_dir)
        print("[1/4] parsing scenario IR (two-pass)")
        parse_corpus(txt_dirs, ir_dir)

    print("[2/4] deriving flow + links (into build/data; data/ keeps only"
          " hand-authored sources + annotation rules)")
    subprocess.run([sys.executable, os.path.join(HERE, "build_flow.py"),
                    ir_dir, os.path.join(out, "flow.skel.json")], check=True)
    flow_out = os.path.join(data_dir, "flow.json")
    os.makedirs(data_dir, exist_ok=True)
    subprocess.run([sys.executable, os.path.join(HERE, "annotate_flow.py"),
                    os.path.join(out, "flow.skel.json"), flow_out], check=True)
    links_out = os.path.join(data_dir, "links.json")
    subprocess.run([sys.executable, os.path.join(HERE, "build_links.py"),
                    ir_dir, links_out], check=True)

    print("[3/4] staging web data + parity gates")
    scripts_out = os.path.join(data_dir, "scripts")
    os.makedirs(scripts_out, exist_ok=True)
    with open(os.path.join(ir_dir, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    for s in index:
        shutil.copy(os.path.join(ir_dir, s + ".json"),
                    os.path.join(scripts_out, s + ".json"))
    with open(os.path.join(scripts_out, "index.json"), "w") as f:
        json.dump(index, f)
    for name in ("endings.json", "terminals.json", "sprites.json",
                 "sys-slots.json"):
        shutil.copy(os.path.join(HERE, "..", "data", name),
                    os.path.join(data_dir, name))
    # BGM timeline + presentation records from .bnr bytecode (static).
    bgm_cmd = [sys.executable, os.path.join(HERE, "build_bgm.py"), *paks,
               os.path.join(data_dir, "bgm.json")]
    if game:
        bgm_cmd += ["--game", game]
    if spak and os.path.isfile(spak):
        bgm_cmd += ["--jp", spak]
    subprocess.run(bgm_cmd, check=True)
    bnr_cmd = [sys.executable, os.path.join(HERE, "decode_bnr.py"),
               *paks, os.path.join(data_dir, "bnr.json")]
    if spak and os.path.isfile(spak):
        bnr_cmd += ["--jp", spak]
    subprocess.run(bnr_cmd, check=True)
    # Per-line voice map from .bnr (4,138). With --mao (MAO script-data
    # clone, e.g. the fetch_mao.py upstream checkout) + --voice-dir, the
    # exact anchor chain resolves each (4,138) NNN to a real archive key;
    # otherwise the legacy fractional map is emitted.
    voice_cmd = [sys.executable, os.path.join(HERE, "build_voice.py"),
                 *paks, os.path.join(data_dir, "voicemap.json"),
                 "--ir", ir_dir]
    if game:
        vspak = os.path.join(game, "script.pak")
        if os.path.isfile(vspak):
            voice_cmd += ["--jp", vspak]
        voice_cmd += ["--voice-dir", game]
    if mao:
        voice_cmd += ["--mao", mao]
    subprocess.run(voice_cmd, check=True)
    if game:
        grp = os.path.join(game, "grp.pak")
        if os.path.isfile(grp):
            subprocess.run([sys.executable, os.path.join(HERE, "build_luts.py"),
                            grp, os.path.join(data_dir, "luts.json")],
                           check=True)
        # Native-save ScriptPos -> IR event anchors (JP spine labels; the
        # IC variant pack adds `ic/<id>` keys when present).
        spak = os.path.join(game, "script.pak")
        if os.path.isfile(spak):
            np_cmd = [sys.executable,
                      os.path.join(HERE, "build_native_pos.py"),
                      spak, os.path.join(data_dir, "native-pos.json")]
            ic_spak = os.path.join(game, "IC", "script.pak")
            if os.path.isfile(ic_spak):
                np_cmd += ["--ic", ic_spak]
            subprocess.run(np_cmd, check=True)
        # Engine flag reference + .bnr choice-marker parity gate
        # (both need the installed script.pak; skipped without --game).
        if os.path.isfile(spak):
            ir_for_flags = ir_dir
            subprocess.run([sys.executable,
                            os.path.join(HERE, "build_flags.py"),
                            spak, os.path.join(data_dir, "flags.json"),
                            "--ir", ir_for_flags], check=True)
            subprocess.run([sys.executable,
                            os.path.join(HERE, "build_cfg.py"),
                            spak, *paks, os.path.join(data_dir, "cfg.json"),
                            "--ir", ir_dir], check=True)
            r = subprocess.run([sys.executable,
                                os.path.join(HERE, "check_bnr_choices.py"),
                                ir_dir, spak])
            if r.returncode != 0:
                print("BUILD FAILED: bnr choice-marker gate")
                sys.exit(1)
    r = subprocess.run([sys.executable, os.path.join(HERE, "check_flow.py"),
                        ir_dir, os.path.join(data_dir, "flow.json")])
    if r.returncode != 0:
        print("BUILD FAILED: flow parity gate")
        sys.exit(1)
    if alts:
        if not (spak and os.path.isfile(spak)):
            print("WARNING: --alt needs --game (JP spine); skipping alt translations")
        else:
            for alt_id, alt_paks in alts:
                build_translation(alt_id, alt_paks, spak, out, data_dir)
            write_translations_index(data_dir, [a for a, _ in alts])
    print("build ok")


if __name__ == "__main__":
    main()
