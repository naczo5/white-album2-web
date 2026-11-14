"""Unit and corpus VM tests for tools/build_cfg.py (LSCR CFG compiler)."""

from __future__ import annotations

import json
import os
import struct
import sys

import pytest

HERE = os.path.dirname(__file__)
ROOT = os.path.join(HERE, "..")
DATA = os.path.join(ROOT, "data")
TOOLS = os.path.join(ROOT, "tools")
sys.path.insert(0, TOOLS)

import build_cfg  # noqa: E402

CACHE = os.path.join(ROOT, "..", ".cache")
SCRIPT_PAK = os.environ.get("WA2_SCRIPT_PAK") or os.path.join(
    CACHE, "game", "script.pak"
)
EN_MAIN_PAK = os.environ.get("WA2_EN_PAK") or os.path.join(CACHE, "en_main.pak")
EN_SPEC_PAK = os.environ.get("WA2_EN_SPECIAL_PAK") or os.path.join(
    CACHE, "en_special.pak"
)
BUILD_IR_DIR = os.path.join(ROOT, "build", "ir")
BUILD_DATA_DIR = os.path.join(ROOT, "build", "data")


def _pack_lsr(entries: list[tuple[int, bytes]]) -> bytes:
    """Build a minimal synthetic LSCR binary blob for unit tests."""
    hdr_size = 12 + len(entries) * 8
    chunks: list[bytes] = []
    table: list[tuple[int, int]] = []
    cur = hdr_size
    for eid, code in entries:
        table.append((eid, cur))
        chunks.append(code)
        cur += len(code)
    hdr = bytearray(b"LSCR\x00\x00\x00\x00" + struct.pack("<I", len(entries)))
    for eid, off in table:
        hdr += struct.pack("<II", eid, off)
    return bytes(hdr) + b"".join(chunks)


def _op(op: int, a: int) -> bytes:
    return struct.pack("<II", op, a)


def _push_int(v: int) -> bytes:
    return struct.pack("<IIi", 5, 3, v)


def _op_i1(sub: int, arg: int) -> bytes:
    return struct.pack("<III", 0, sub, arg)


def _op_if(else_off: int, end_off: int) -> bytes:
    return struct.pack("<IIII", 0, 2, else_off, end_off)


# ---------------------------------------------------- synthetic unit tests ---


def test_parse_bnr_header_and_invalid_magic():
    raw = _pack_lsr([(0, _op(0, 1))])
    secs, code_start = build_cfg.parse_bnr_header(raw)
    assert secs == [(0, 20)]
    assert code_start == 20
    with pytest.raises(ValueError):
        build_cfg.parse_bnr_header(b"NOPE12345678")


def test_decode_entry_insns_variable_widths():
    code = (
        _op_if(60, 80)  # 16B @0
        + _op_i1(3, 80)  # 12B @16 ELSEIF
        + _op(0, 4)  # 8B @28 ELSE
        + struct.pack("<6I", 0, 5, 90, 91, 92, 93)  # 24B @36 FOR
        + _op_i1(6, 100)  # 12B @60 WHILE
        + _op_i1(12, 120)  # 12B @72 GOTO
        + _push_int(-7)  # 12B @84 PUSH
        + _op(0, 1)  # 8B @96 END
    )
    insns = build_cfg.decode_entry_insns(code, 0, len(code))
    assert [ins[1][0] for ins in insns] == [
        "IF",
        "ELSEIF",
        "ELSE",
        "FOR",
        "WHILE",
        "GOTO",
        "PUSH",
        "OP0",
    ]
    assert insns[6][1] == ("PUSH", 3, -7)


def test_eval_expr_ops_expressions_and_calls():
    ops = [
        (1, 5),
        ("PUSH", 3, 2),
        (6, 16),  # G[5] + 2
        (6, 30),
    ]
    expr, effects, smess, labels = build_cfg._eval_expr_ops(ops)
    assert expr == {"t": "bin", "op": "+", "l": {"t": "G", "idx": 5}, "r": 2}
    assert effects == [] and smess == [] and labels == []

    # G[7] += 1; SetGameFlag(23, 1); L[0] = SetSelect(4) + 1
    ops2 = [
        (1, 7),
        (6, 25),
        (6, 30),
        ("PUSH", 3, 23),
        ("PUSH", 3, 1),
        (4, 199),
        (6, 30),
        (2, 0),
        ("PUSH", 3, 0),
        (6, 27),
        ("PUSH", 3, 4),
        (4, 209),
        ("PUSH", 3, 1),
        (6, 16),
        (6, 0),
        (6, 30),
    ]
    _expr2, eff2, _sm2, _lbl2 = build_cfg._eval_expr_ops(ops2)
    assert eff2[0] == {"t": "setG", "idx": 7, "op": "+=", "val": 1}
    assert eff2[1] == {"t": "setGFlag", "id": 23, "val": 1}
    assert build_cfg._unwrap_select([eff2[2]]) == (4, {"t": "L", "idx": 0})


def test_compile_script_cfg_if_else_and_skip_9000():
    # Build entry 0 with:
    #   line tok 0
    #   IF (G[5] >= 6): line tok 2; SLoad("3101", 0)
    #   ELSE: line tok 4; GoTitle()
    # Header has 2 entries (0 and 9000): header = 12 + 2*8 = 28 bytes.
    base = 28
    # Block before IF: (3,0)(4,131)(6,30) = 24B -> offset base+24 = 52
    pre = _op(3, 0) + _op(4, 131) + _op(6, 30)
    # IF header (16B @52): cond (_op(1,5)[8]+_push_int(6)[12]+_op(6,12)[8]+_op(0,13)[8]+_op(6,30)[8] = 44B)
    # then body: (3,2)(4,131)(6,30) [24B] + (3,5)(PUSH 0)(4,0)(6,30) [36B] = 60B
    # ELSE (8B): else body: (3,4)(4,131)(6,30) [24B] + (4,197)(6,30) [16B] = 40B
    else_off = base + len(pre) + 16 + 44 + 60
    end_off = else_off + 8 + 40
    code0 = (
        pre
        + _op_if(else_off, end_off)
        + _op(1, 5)
        + _push_int(6)
        + _op(6, 12)
        + _op(0, 13)
        + _op(6, 30)
        + _op(3, 2)
        + _op(4, 131)
        + _op(6, 30)
        + _op(3, 5)
        + _push_int(0)
        + _op(4, 0)
        + _op(6, 30)
        + _op(0, 4)  # ELSE
        + _op(3, 4)
        + _op(4, 131)
        + _op(6, 30)
        + _op(4, 197)
        + _op(6, 30)
        + _op(0, 1)
    )
    code9000 = _op(4, 197) + _op(6, 30) + _op(0, 1)
    raw = _pack_lsr([(0, code0), (9000, code9000)])
    tokens = ["line0", "sfx", "then_line", "bg", "else_line", "3101"]
    events = [
        {"t": "say", "tok": 0},
        {"t": "narrate", "tok": 2},
        {"t": "narrate", "tok": 4},
    ]
    out = build_cfg.compile_script_cfg(raw, tokens, events)
    assert list(out.keys()) == ["0"]  # 9000 skipped
    ops = out["0"]
    assert ops[0] == {"t": "play", "from": 0, "to": 1}
    assert ops[1]["t"] == "if"
    br0, br1 = ops[1]["branches"]
    assert br0["cond"] == {"t": "bin", "op": ">=", "l": {"t": "G", "idx": 5}, "r": 6}
    assert br0["ops"] == [
        {"t": "play", "from": 1, "to": 2},
        {"t": "sload", "script": "3101", "entry": 0},
    ]
    assert br1["cond"] is None
    assert br1["ops"] == [
        {"t": "play", "from": 2, "to": 3},
        {"t": "gotitle"},
    ]


def test_coalesce_spans_excludes_choices_and_handles_spikes():
    events = [
        {"t": "bg", "tok": 0},
        {"t": "say", "tok": 1},
        {"t": "choice", "tok": 2, "options": [{"n": 1, "text": "a"}]},
        {"t": "say", "tok": 3},
        {"t": "say", "tok": 9},  # normal tail
        {"t": "say", "tok": 12},  # early spike
    ]
    raw = [
        {"t": "_label", "ev": 1},
        {"t": "choice", "ev": 2, "nodeIdx": 0, "into": {"t": "L", "idx": 0}, "options": []},
        {"t": "_label", "ev": 5},  # forward spike before ev 3..4
        {"t": "_label", "ev": 3},
        {"t": "_label", "ev": 4},
        {"t": "gotitle"},
    ]
    ops = build_cfg._coalesce_spans(raw, events)
    assert ops == [
        {"t": "play", "from": 0, "to": 2},  # bg cue coalesced, stops before choice@2
        {"t": "choice", "ev": 2, "nodeIdx": 0, "into": {"t": "L", "idx": 0}, "options": []},
        {"t": "play", "from": 5, "to": 6},  # spike handled out-of-band without skipping 3..5
        {"t": "play", "from": 3, "to": 5},
        {"t": "gotitle"},
    ]


# ------------------------------------------------------- BYOA corpus gates ---


HAS_CORPUS = (
    os.path.isfile(SCRIPT_PAK)
    and os.path.isfile(EN_MAIN_PAK)
    and os.path.isfile(EN_SPEC_PAK)
)


@pytest.fixture(scope="module")
def corpus_env():
    if not HAS_CORPUS:
        pytest.skip("BYOA game/EN archives not present")
    cfg_path = os.path.join(BUILD_DATA_DIR, "cfg.json")
    scripts_dir = os.path.join(BUILD_DATA_DIR, "scripts")
    if os.path.isfile(cfg_path) and os.path.isdir(scripts_dir):
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
        ir_src = scripts_dir
    else:
        ir_src = BUILD_IR_DIR if os.path.isdir(BUILD_IR_DIR) else None
        cfg = build_cfg.build_cfg(
            SCRIPT_PAK, en_paks=[EN_MAIN_PAK, EN_SPEC_PAK], ir_dir=ir_src
        )
    events_by_script: dict[str, list[dict]] = {}
    if ir_src:
        for fn in os.listdir(ir_src):
            if fn.endswith(".json") and fn != "index.json":
                with open(os.path.join(ir_src, fn), encoding="utf-8") as f:
                    events_by_script[fn[:-5]] = json.load(f).get("events") or []
    return cfg, events_by_script


def _eval_expr(expr, g_vars: list[int], l_vars: list[int], gflags: dict[int, int], replay: int) -> int:
    if isinstance(expr, bool):
        return 1 if expr else 0
    if isinstance(expr, (int, float)):
        return int(expr)
    if not isinstance(expr, dict):
        return 0
    t = expr.get("t")
    if t == "G":
        idx = int(expr["idx"])
        return g_vars[idx] if 0 <= idx < len(g_vars) else 0
    if t == "L":
        idx = int(expr["idx"])
        return l_vars[idx] if 0 <= idx < len(l_vars) else 0
    if t == "gflag":
        fid = _eval_expr(expr["id"], g_vars, l_vars, gflags, replay)
        if fid == 99:
            return 0  # engine GetGameFlag(99) always returns 0
        return gflags.get(fid, 0)
    if t == "replay":
        return 1 if replay else 0
    if t == "un":
        v = _eval_expr(expr["x"], g_vars, l_vars, gflags, replay)
        return (0 if v else 1) if expr["op"] == "!" else -v
    if t == "bin":
        op = expr["op"]
        if op == "&&":
            return 1 if (_eval_expr(expr["l"], g_vars, l_vars, gflags, replay) and _eval_expr(expr["r"], g_vars, l_vars, gflags, replay)) else 0
        if op == "||":
            return 1 if (_eval_expr(expr["l"], g_vars, l_vars, gflags, replay) or _eval_expr(expr["r"], g_vars, l_vars, gflags, replay)) else 0
        lv = _eval_expr(expr["l"], g_vars, l_vars, gflags, replay)
        rv = _eval_expr(expr["r"], g_vars, l_vars, gflags, replay)
        if op == "==":
            return 1 if lv == rv else 0
        if op == "!=":
            return 1 if lv != rv else 0
        if op == "<":
            return 1 if lv < rv else 0
        if op == ">":
            return 1 if lv > rv else 0
        if op == "<=":
            return 1 if lv <= rv else 0
        if op == ">=":
            return 1 if lv >= rv else 0
        if op == "+":
            return lv + rv
        if op == "-":
            return lv - rv
        if op == "*":
            return lv * rv
        if op == "/":
            return int(lv / rv) if rv else 0
        if op == "%":
            return lv % rv if rv else 0
        if op == "&":
            return lv & rv
        if op == "|":
            return lv | rv
    return 0


def _apply_assign(cur: int, op: str, val: int) -> int:
    if op == "=":
        return val
    if op == "+=":
        return cur + val
    if op == "-=":
        return cur - val
    if op == "*=":
        return cur * val
    if op == "/=":
        return int(cur / val) if val else 0
    if op == "%=":
        return cur % val if val else 0
    if op == "&=":
        return cur & val
    if op == "|=":
        return cur | val
    return cur


class CfgVM:
    """Faithful Python simulator over cfg.json + scenario IR."""

    def __init__(
        self,
        cfg: dict,
        *,
        gflags: dict[int, int] | None = None,
        g_init: dict[int, int] | None = None,
        replay: int = 0,
        picks: dict[tuple[str, int], int] | None = None,
    ):
        self.cfg = cfg
        self.g = [int(v.get("init", 0)) for v in cfg["vars"]]
        for k, v in (g_init or {}).items():
            self.g[k] = v
        self.gflags: dict[int, int] = dict(gflags or {})
        self.gflags[99] = 0
        self.replay = replay
        self.picks = dict(picks or {})
        self.visited: list[tuple[str, str]] = []
        self.played: list[tuple[str, int, int]] = []
        self.choices_seen: list[tuple[str, int, int, list[bool]]] = []
        self.ended_title = False

    def run(self, start_script: str, start_entry: str = "0", max_steps: int = 500) -> None:
        script, entry = start_script, start_entry
        call_stack: list[tuple[str, str, list[int], list[tuple[list[dict], int]]]] = []
        l_vars = [0] * 64
        pc_stack: list[tuple[list[dict], int]] = [
            (self.cfg["scripts"][script][entry], 0)
        ]
        self.visited.append((script, entry))
        steps = 0

        while steps < max_steps:
            steps += 1
            while pc_stack and pc_stack[-1][1] >= len(pc_stack[-1][0]):
                pc_stack.pop()
            if not pc_stack:
                if call_stack:
                    script, entry, l_vars, pc_stack = call_stack.pop()
                    continue
                break
            ops, idx = pc_stack[-1]
            pc_stack[-1] = (ops, idx + 1)
            op = ops[idx]
            t = op["t"]

            if t == "play":
                self.played.append((script, op["from"], op["to"]))
            elif t == "setG":
                i = int(op["idx"])
                val = _eval_expr(op["val"], self.g, l_vars, self.gflags, self.replay)
                self.g[i] = _apply_assign(self.g[i], op["op"], val)
            elif t == "setL":
                i = int(op["idx"])
                val = _eval_expr(op["val"], self.g, l_vars, self.gflags, self.replay)
                l_vars[i] = _apply_assign(l_vars[i], op["op"], val)
            elif t == "setGFlag":
                fid = _eval_expr(op["id"], self.g, l_vars, self.gflags, self.replay)
                if fid != 99:
                    val = _eval_expr(op["val"], self.g, l_vars, self.gflags, self.replay)
                    self.gflags[fid] = val
            elif t == "if":
                for br in op["branches"]:
                    cond = br["cond"]
                    if cond is None or _eval_expr(cond, self.g, l_vars, self.gflags, self.replay):
                        if br["ops"]:
                            pc_stack.append((br["ops"], 0))
                        break
            elif t == "choice":
                locked = []
                for o in op["options"]:
                    fid = int(o["flagId"])
                    fv = 0 if fid == 99 else self.gflags.get(fid, 0)
                    cmp_v = _eval_expr(o["cmp"], self.g, l_vars, self.gflags, self.replay)
                    locked.append(fv != cmp_v)
                pick = self.picks.get((script, op["ev"]))
                if pick is None:
                    pick = next((o["n"] for o, lk in zip(op["options"], locked) if not lk), 1)
                assert 1 <= pick <= len(locked), f"invalid pick {pick} at {script}:{op['ev']}"
                assert not locked[pick - 1], f"picked locked option {pick} at {script}:{op['ev']} ({op['options'][pick - 1]})"
                self.choices_seen.append((script, op["ev"], pick, locked))
                into = op["into"]
                if isinstance(into, dict) and into.get("t") == "L":
                    l_vars[int(into["idx"])] = pick
            elif t == "sload":
                script = op["script"]
                entry = str(op["entry"])
                l_vars = [0] * 64
                pc_stack = [(self.cfg["scripts"][script][entry], 0)]
                self.visited.append((script, entry))
            elif t == "scall":
                call_stack.append((script, entry, l_vars, list(pc_stack)))
                script = op["script"]
                entry = str(op["entry"])
                l_vars = [0] * 64
                pc_stack = [(self.cfg["scripts"][script][entry], 0)]
                self.visited.append((script, entry))
            elif t == "ret":
                if call_stack:
                    script, entry, l_vars, pc_stack = call_stack.pop()
                else:
                    break
            elif t == "gotitle":
                self.ended_title = True
                return
        raise AssertionError(f"VM did not terminate within {max_steps} steps (at {script}:{entry})")


@pytest.mark.skipif(not HAS_CORPUS, reason="BYOA game/EN archives not present")
def test_corpus_cfg_schema_and_all_choices_present(corpus_env):
    cfg, events_by_script = corpus_env
    assert cfg["version"] == 1
    assert len(cfg["vars"]) == 29
    assert len(cfg["scripts"]) == 221

    with open(os.path.join(DATA, "flow.json"), encoding="utf-8") as f:
        flow = json.load(f)

    cfg_choices: dict[tuple[str, int], dict] = {}

    def walk(sid: str, ops: list[dict]) -> None:
        for op in ops:
            if op["t"] == "choice":
                cfg_choices[(sid, op["ev"])] = op
            elif op["t"] == "if":
                for br in op["branches"]:
                    walk(sid, br["ops"])

    for sid, entries in cfg["scripts"].items():
        for ops in entries.values():
            walk(sid, ops)

    assert len(cfg_choices) == len(flow["nodes"]) == 32
    for node in flow["nodes"]:
        eng = node["engine"]
        key = (eng["script"], eng["event"])
        assert key in cfg_choices
        assert len(cfg_choices[key]["options"]) == len(node["options"])
        if key[0] in events_by_script:
            evs = events_by_script[key[0]]
            assert evs[key[1]]["t"] == "choice"


@pytest.mark.skipif(not HAS_CORPUS, reason="BYOA game/EN archives not present")
def test_corpus_cfg_play_spans_disjoint_and_no_choices(corpus_env):
    cfg, events_by_script = corpus_env
    if not events_by_script:
        pytest.skip("IR events directory not present")

    def check_ops(sid: str, eid: str, ops: list[dict], seen: list[tuple[int, int]]) -> None:
        evs = events_by_script[sid]
        for op in ops:
            if op["t"] == "play":
                lo, hi = op["from"], op["to"]
                assert 0 <= lo < hi <= len(evs), (sid, eid, lo, hi)
                for k in range(lo, hi):
                    assert evs[k]["t"] != "choice", (sid, eid, k)
                    if evs[k]["t"] == "jump":
                        assert evs[k].get("kind", "").startswith("CATCH"), (sid, eid, k, evs[k])
                for plo, phi in seen:
                    assert hi <= plo or lo >= phi, f"overlap in {sid}:{eid}: {(lo, hi)} vs {(plo, phi)}"
                seen.append((lo, hi))
            elif op["t"] == "if":
                for br in op["branches"]:
                    check_ops(sid, eid, br["ops"], list(seen))

    for sid, entries in cfg["scripts"].items():
        for eid, ops in entries.items():
            check_ops(sid, eid, ops, [])


@pytest.mark.skipif(not HAS_CORPUS, reason="BYOA game/EN archives not present")
def test_corpus_vm_choice_gating_and_ic_replay(corpus_env):
    cfg, _ = corpus_env

    # Reserve GFlag 99 always reads as 0 even when SetGameFlag(99, 1) was stored.
    vm_res = CfgVM(cfg, gflags={99: 1})
    assert _eval_expr({"t": "gflag", "id": 99}, vm_res.g, [0], vm_res.gflags, 0) == 0

    # 2003:242 opt1 ("I want to know her better") requires GFlag[1] == 1.
    vm_first = CfgVM(cfg, gflags={0: 1, 1: 0}, picks={("2003", 242): 2})
    vm_first.run("2003")
    c_2003_first = next(c for c in vm_first.choices_seen if c[0] == "2003")
    assert c_2003_first[3] == [True, False]

    vm_second = CfgVM(cfg, gflags={0: 1, 1: 1}, picks={("2003", 242): 1})
    vm_second.run("2003")
    c_2003_second = next(c for c in vm_second.choices_seen if c[0] == "2003")
    assert c_2003_second[3] == [False, False]

    # IC replay variants (1008_020..1012_030): GFlag[1]==0 vs GFlag[1]==1, plus replay==1.
    vm_ic_0 = CfgVM(cfg, gflags={}, replay=0)
    vm_ic_0.run("1001")
    assert ("1008", 482, 483) in vm_ic_0.played
    assert not any(s == "1008_020" for s, _, _ in vm_ic_0.played)

    vm_ic_1 = CfgVM(cfg, gflags={0: 1, 1: 1}, replay=0)
    vm_ic_1.run("1001")
    assert ("1008", 482, 483) not in vm_ic_1.played
    for rep in ("1008_020", "1008_030", "1009_030", "1010_030", "1011_030", "1012_030"):
        assert any(s == rep for s, _, _ in vm_ic_1.played), f"missed {rep}"
    assert vm_ic_1.gflags.get(0) == 1

    vm_replay = CfgVM(cfg, gflags={0: 1, 1: 1}, replay=1)
    vm_replay.run("1012_030")
    assert vm_replay.ended_title
    assert ("1013", "0") not in vm_replay.visited


@pytest.mark.skipif(not HAS_CORPUS, reason="BYOA game/EN archives not present")
def test_corpus_vm_reaches_all_11_endings(corpus_env):
    cfg, _ = corpus_env
    with open(os.path.join(DATA, "sys-slots.json"), encoding="utf-8") as f:
        ending_slots = json.load(f)["endingSlots"]

    base_neutral_cc = {
        ("2003", 242): 2,
        ("2003", 982): 2,
        ("2004", 66): 1,
        ("2005", 389): 2,
        ("2007", 231): 2,
        ("2009", 1618): 2,
        ("2011", 182): 1,
        ("2013", 198): 1,
        ("2014", 271): 2,
        ("2015", 351): 2,
        ("2016", 467): 1,
        ("2017", 239): 1,
        ("2018", 548): 1,
        ("2019", 1484): 3,
        ("2019", 1512): 2,
    }

    # Map each ending_id -> (start_script, initial_gflags, picks, expected_gflag_slot)
    routes = [
        ("ic-end", "1001", {}, {}, 0),
        # Avoid all CC heroines -> 2019:1484 opt3 -> 2019:1512 opt2 -> 2025 short exit
        (
            "cc-normal1",
            "2001",
            {0: 1},
            {**base_neutral_cc},
            20,
        ),
        # Setsuna CC -> 2020..2024 (G[10]>=1, G[9]>=1, G[12]==1, G[8]>=1, G[7]>=5) -> 2026..2033 -> Coda
        (
            "cc-setsuna",
            "2001",
            {0: 1},
            {
                **base_neutral_cc,
                ("2003", 982): 1,   # G[7]+=1
                ("2004", 66): 2,    # G[10]+=1
                ("2005", 389): 1,   # G[8]+=1
                ("2015", 351): 1,   # G[8]+=1, G[7]+=1
                ("2024", 84): 2,    # GFlag[5]==0 -> opt2 unlocked
                ("3003", 1006): 1,
                ("3005", 186): 1,
                ("3009", 1347): 1,
                ("3012", 605): 1,
                ("3012", 950): 2,
                ("3013", 747): 1,
                ("3013", 1843): 1,
                ("3014", 376): 1,
                ("3016", 822): 2,
                ("3016", 859): 1,
            },
            21,
        ),
        # Koharu CC (2005/2009 opt1, 2018 opt2 -> 2019:1512 opt1)
        (
            "cc-koharu",
            "2001",
            {0: 1},
            {
                **base_neutral_cc,
                ("2005", 389): 1,
                ("2009", 1618): 1,
                ("2018", 548): 2,
                ("2019", 1484): 3,
                ("2019", 1512): 1,
            },
            22,
        ),
        # Chiaki Normal CC (2003:242 opt2 -> Chiaki chain G[9]>=3, G[12]==0 -> 2019:1484 opt1 -> 2402 -> 2413)
        (
            "cc-chiaki-normal",
            "2001",
            {0: 1},
            {
                **base_neutral_cc,
                ("2003", 242): 2,
                ("2007", 231): 1,
                ("2014", 271): 1,
                ("2016", 467): 2,
                ("2019", 1484): 1,
            },
            24,
        ),
        # Chiaki True CC (GFlag[1]=1 unlocks 2003:242 opt1 -> 2402 -> 2403..2412)
        (
            "cc-chiaki-true",
            "2001",
            {0: 1, 1: 1},
            {
                **base_neutral_cc,
                ("2003", 242): 1,
                ("2007", 231): 1,
                ("2014", 271): 1,
                ("2016", 467): 2,
                ("2019", 1484): 1,
            },
            23,
        ),
        # Mari CC (2004/2011/2017 opt2, 2013 opt2 -> 2019:1484 opt2 -> 2503:126 opt2)
        (
            "cc-mari",
            "2001",
            {0: 1},
            {
                **base_neutral_cc,
                ("2004", 66): 2,
                ("2011", 182): 2,
                ("2013", 198): 2,
                ("2017", 239): 2,
                ("2019", 1484): 2,
                ("2503", 126): 2,
            },
            25,
        ),
        # Coda Normal (from 3001, s_flag off -> 3016:822 opt2 -> 3016:859 opt1 -> 3024)
        (
            "coda-normal",
            "3001",
            {0: 1, 3: 1, 21: 1},
            {
                ("3003", 1006): 1,
                ("3005", 186): 1,
                ("3009", 1347): 1,
                ("3012", 605): 1,
                ("3012", 950): 2,
                ("3013", 747): 1,
                ("3013", 1843): 1,
                ("3014", 376): 1,
                ("3016", 822): 2,
                ("3016", 859): 1,
            },
            30,
        ),
        # Coda Kazusa True (Kazusa choices -> G[5]>=6 -> 3016:822 opt2 -> 3016:859 opt2 -> 3111)
        (
            "coda-kazusa-true",
            "3001",
            {0: 1, 3: 1, 21: 1},
            {
                ("3003", 1006): 2,
                ("3005", 186): 2,
                ("3005", 256): 1,
                ("3005", 265): 2,
                ("3009", 1347): 2,
                ("3009", 1474): 1,
                ("3012", 605): 2,
                ("3012", 950): 1,
                ("3013", 747): 2,
                ("3013", 801): 1,
                ("3013", 1843): 2,
                ("3014", 376): 1,
                ("3016", 822): 2,
                ("3016", 859): 2,
            },
            31,
        ),
        # Coda Cheating / Kazusa Normal (s_flag off -> 3016:822 opt1 -> 3901..3909)
        (
            "coda-cheating",
            "3001",
            {0: 1, 3: 1, 21: 1},
            {
                ("3003", 1006): 2,
                ("3005", 186): 2,
                ("3005", 256): 1,
                ("3005", 265): 2,
                ("3009", 1347): 2,
                ("3009", 1474): 1,
                ("3012", 605): 2,
                ("3012", 950): 1,
                ("3013", 747): 2,
                ("3013", 801): 1,
                ("3013", 1843): 2,
                ("3014", 376): 1,
                ("3016", 822): 1,
                ("3904", 386): 1,
            },
            32,
        ),
        # Coda Setsuna True (3005:186=2 so G[22]==0 reaches 3014:376 opt2 -> s_flag=1 -> 3211)
        (
            "coda-setsuna-true",
            "3001",
            {0: 1, 3: 1, 21: 1},
            {
                ("3003", 1006): 1,
                ("3005", 186): 2,
                ("3005", 256): 2,
                ("3009", 1347): 1,
                ("3012", 605): 1,
                ("3012", 950): 2,
                ("3013", 747): 1,
                ("3013", 1843): 1,
                ("3014", 376): 2,
                ("3016", 822): 2,
                ("3016", 859): 1,
            },
            33,
        ),
    ]

    assert len(routes) == len(ending_slots) == 11
    for eid, start_s, gflags, picks, slot in routes:
        assert ending_slots[str(slot)] == eid
        vm = CfgVM(cfg, gflags=gflags, picks=picks)
        vm.run(start_s)
        assert vm.ended_title, f"{eid} did not terminate with gotitle"
        assert vm.gflags.get(slot) == 1, f"{eid} did not set GFlag[{slot}] (visited={vm.visited})"


@pytest.mark.skipif(not HAS_CORPUS, reason="BYOA game/EN archives not present")
def test_corpus_vm_special_scripts_reach_gotitle(corpus_env):
    cfg, _ = corpus_env
    special_chains = [
        ("4000", "4009", 15),
        ("5000", "5004", 10),
        ("5100", "5104", 11),
        ("5200", "5209", 12),
        ("5300", "5303", 13),
        ("5400", "5401", 14),
        ("6001", "6005", None),
        ("6101", "6104", None),
        ("7000", "7000", None),
        ("7100", "7100", None),
        ("7200", "7200", None),
        ("7300", "7300", None),
    ]
    for start_s, end_s, gflag_id in special_chains:
        vm = CfgVM(cfg)
        vm.run(start_s)
        assert vm.ended_title
        assert (end_s, "0") in vm.visited
        if gflag_id is not None:
            assert vm.gflags.get(gflag_id) == 1
