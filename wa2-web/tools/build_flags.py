"""Extract engine flag/variable reference from script.pak (static, no game run).

script.pak ships the engine's own flag tables:
- Global.vrb: Shift-JIS CSV `type,name,init` — 29 live vars including the
  affection/cheat/route-kill/pick flags (FLG_雪菜好意度, FLG_かずさ浮気度,
  FLG_*ルート消滅, FLG_第Ｎ部MM選択肢Ｋ, ...).
- GFLAG.dat: 62 slots x 260 bytes, `_GFLAG_EV_*` names (endings, chapter
  clears, replay state).
- LFScriptFunc{,Ex}.fnc: opcode vocabulary (SetGameFlag/GetGameFlag,
  SetSelect/SetSelectMess, LoadBmp/SetBmp*, GetReplayMode, ...).

Output (committed reference, functional metadata like flow.json labels):
  {version, vars, gflags, funcs, affection, choiceFlags}
choiceFlags maps engine pick flags (第２部03選択肢１) to {script, option}
via the 部N+MM rule, verified against built scenario IR when --ir is given.

Usage: python3 build_flags.py SCRIPT_PAK OUT_JSON [--ir IR_DIR]
"""

from __future__ import annotations

import json
import os
import re
import struct
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import kcap  # noqa: E402
import lzss  # noqa: E402


def get_entry(pak_data: bytes, name: str) -> bytes:
    for e in kcap.read_index(pak_data):
        if not e.is_folder and e.name == name:
            s, e2 = kcap.data_range(e)
            blob = pak_data[s:e2]
            if e.is_compressed:
                orig, lz = lzss.split_datahdr(blob)
                return lzss.decompress(lz, orig)
            return blob
    raise KeyError(name)


def parse_vrb(blob: bytes) -> list[dict]:
    out = []
    for line in blob.decode("cp932").splitlines():
        line = line.strip()
        if not line:
            continue
        typ, name, init = line.split(",", 2)
        out.append({"type": int(typ), "name": name, "init": int(init)})
    return out


def parse_gflag(blob: bytes) -> list[str]:
    (count,) = struct.unpack_from("<I", blob, 0)
    names = []
    # Slots are 260 bytes apart (verified via name offsets); the first
    # name sits at offset 8. Reads clamp at EOF.
    for i in range(count):
        base = 8 + i * 260
        raw = blob[base:base + 120].split(b"\x00")[0]
        try:
            names.append(raw.decode("cp932"))
        except Exception:
            names.append("")
    return names


def parse_fnc(blob: bytes) -> list[str]:
    (count,) = struct.unpack_from("<I", blob, 0)
    parts = re.split(rb"[\x00,]+", blob[4:])
    names = [p.decode() for p in parts
             if re.fullmatch(rb"[A-Za-z_][A-Za-z0-9_]*", p)]
    # The table claims `count` entries; return names in order (some slots
    # may be unnamed — length can be < count).
    _ = count
    return names


AFFECTION = {
    "s": "FLG_雪菜好意度",
    "koharu": "FLG_小春好意度",
    "chiaki": "FLG_千晶好意度",
    "mari": "FLG_麻理好意度",
    "k": "FLG_かずさ本気度",
    "uwaki": "FLG_かずさ浮気度",
}

ROUTE_KILL = {
    "koharu": "FLG_小春ルート消滅",
    "chiaki": "FLG_千晶ルート消滅",
    "mari": "FLG_麻理ルート消滅",
}


def choice_flag_targets(vars_: list[dict], ir_dir: str | None) -> dict:
    """Map 第Ｎ部MM選択肢Ｋ/条件Ｊ pick flags to {script, option}.

    Rule: 部2 -> 20MM, 部3 -> 30MM (coda chapters). Verified against IR
    choices when --ir is given; unverified entries carry verified:false.
    """
    ir_choices: dict[str, int] = {}
    ir_scripts: set[str] = set()
    if ir_dir and os.path.isdir(ir_dir):
        for fn in os.listdir(ir_dir):
            if not fn.endswith(".json"):
                continue
            try:
                ir = json.load(open(os.path.join(ir_dir, fn),
                                   encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(ir, dict):
                continue
            ir_scripts.add(fn[:-5])
            n = sum(1 for e in ir.get("events", [])
                    if isinstance(e, dict) and e.get("t") == "choice")
            if n:
                ir_choices[fn[:-5]] = n
    out = {}
    for v in vars_:
        # Engine digits are full-width (２, １); NFKC-normalize first.
        norm = unicodedata.normalize("NFKC", v["name"])
        m = re.fullmatch(r"FLG_第([23])部(\d+)(選択肢|条件)([123])", norm)
        if not m:
            continue
        part, mm, kind, opt = m.groups()
        script = f"{'20' if part == '2' else '30'}{mm}"
        key = v["name"]
        if ir_dir:
            # 選択肢 = choice UI (script must contain a choice);
            # 条件 = flag-gated branch condition (script must exist).
            ok = (script in ir_choices if kind == "選択肢"
                  else script in ir_scripts)
            out[key] = {"script": script, "option": int(opt),
                        "kind": ("choice" if kind == "選択肢"
                                 else "condition"),
                        "verified": ok}
        else:
            out[key] = {"script": script, "option": int(opt),
                        "kind": ("choice" if kind == "選択肢"
                                 else "condition"),
                        "verified": False}
    return out


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    pak_path, out_path = sys.argv[1], sys.argv[2]
    ir_dir = None
    if "--ir" in sys.argv:
        ir_dir = sys.argv[sys.argv.index("--ir") + 1]
    data = open(pak_path, "rb").read()
    vars_ = parse_vrb(get_entry(data, "Global.vrb"))
    gflags = parse_gflag(get_entry(data, "GFLAG.dat"))
    funcs = {"ex": parse_fnc(get_entry(data, "LFScriptFuncEx.fnc")),
             "base": parse_fnc(get_entry(data, "LFScriptFunc.fnc"))}
    table = {"version": 1, "vars": vars_, "gflags": gflags, "funcs": funcs,
             "affection": AFFECTION, "routeKill": ROUTE_KILL,
             "choiceFlags": choice_flag_targets(vars_, ir_dir)}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(table, f, ensure_ascii=False, indent=1)
    n_ver = sum(1 for v in table["choiceFlags"].values() if v["verified"])
    print(f"flags: {len(vars_)} vars, {len(gflags)} gflags, "
          f"ex {len(funcs['ex'])} + base {len(funcs['base'])} funcs, "
          f"{n_ver}/{len(table['choiceFlags'])} pick flags IR-verified "
          f"-> {out_path}")


if __name__ == "__main__":
    main()
