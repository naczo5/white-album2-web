"""Compile LSCR .bnr bytecode into engine-accurate control-flow graphs (cfg.json).

Static offline compiler (no game execution). Reads Global.vrb and *.bnr from
script.pak (story scripts) plus fallback EN .pak files (special scripts
4000..7300 absent from script.pak), aligns (4,130|131|133|144) + (3,tok)
line labels onto IR event spans [from, to), and emits structured CfgOp ASTs:

  - play(from, to)      IR event range for the taken basic block
  - setG / setL         Global.vrb / local L[idx] expression assignments
  - setGFlag(id, val)   Sys.sav Region C flag writes (SetGameFlag)
  - if(branches)        Nested IF / ELSEIF / ELSE blocks
  - choice(...)         SetSelectMess gates + SetSelect commit
  - sload(script,entry) Cross-script jump (SLoad)
  - scall(script,entry) Subroutine call into another script entry (SCall)
  - ret                 Subroutine return (4,5)
  - gotitle             Ending / return-to-title (GoTitle)

Usage:
  python3 build_cfg.py SCRIPT_PAK [EN_PAK ...] OUT_JSON [--ir IR_DIR]
"""

from __future__ import annotations

import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bnr_anchor  # noqa: E402
import build_flags  # noqa: E402
import kcap  # noqa: E402
import lzss  # noqa: E402
import parse_txt  # noqa: E402
from proto_bgm import s32  # noqa: E402

ENGINE_INTERNAL = {"catch", "catch2", "catch3", "9999", "LF3"}
LABEL_OPS = {130, 131, 133, 144}

ASSIGN_OPS = {
    0: "=",
    1: "+=",
    2: "-=",
    3: "*=",
    4: "/=",
    5: "%=",
    6: "&=",
    7: "|=",
}

BIN_OPS = {
    8: "==",
    9: "<",
    10: ">",
    11: "<=",
    12: ">=",
    13: "&&",
    14: "||",
    15: "!=",
    16: "+",
    17: "-",
    18: "*",
    19: "/",
    20: "%",
    21: "&",
    22: "|",
}


def _read_pak_entry(pak_data: bytes, entry: kcap.Entry) -> bytes:
    start, end = kcap.data_range(entry)
    blob = pak_data[start:end]
    if entry.is_compressed:
        orig, lz = lzss.split_datahdr(blob)
        return lzss.decompress(lz, orig)
    return blob


def parse_bnr_header(raw: bytes) -> tuple[list[tuple[int, int]], int]:
    """Return (entries [(entry_id, offset), ...], first_code_offset)."""
    if len(raw) < 12 or raw[:4] != b"LSCR":
        raise ValueError("not an LSCR .bnr blob")
    cnt = struct.unpack_from("<I", raw, 8)[0]
    if 12 + cnt * 8 > len(raw):
        raise ValueError("truncated LSCR entry table")
    secs = [struct.unpack_from("<II", raw, 12 + i * 8) for i in range(cnt)]
    code_start = secs[0][1] if secs else 12
    return secs, code_start


def decode_entry_insns(raw: bytes, start: int, end: int) -> list[tuple[int, tuple]]:
    """Decode raw 32-bit LSCR instructions in byte range [start, end)."""
    insns: list[tuple[int, tuple]] = []
    off = start
    while off < end and off + 8 <= len(raw):
        op, a = struct.unpack_from("<II", raw, off)
        if op == 0:
            if a == 2:  # IF_BEGIN(else_off, end_off)
                if off + 16 > len(raw):
                    break
                else_off, end_off = struct.unpack_from("<II", raw, off + 8)
                insns.append((off, ("IF", else_off, end_off)))
                off += 16
            elif a == 3:  # ELSEIF(next_else_off)
                if off + 12 > len(raw):
                    break
                (next_else,) = struct.unpack_from("<I", raw, off + 8)
                insns.append((off, ("ELSEIF", next_else)))
                off += 12
            elif a == 4:  # ELSE
                insns.append((off, ("ELSE",)))
                off += 8
            elif a == 5:  # FOR_HDR(end_off, body_off, step_off, cond_off)
                if off + 24 > len(raw):
                    break
                end_off, body_off, step_off, cond_off = struct.unpack_from(
                    "<4I", raw, off + 8
                )
                insns.append((off, ("FOR", end_off, body_off, step_off, cond_off)))
                off += 24
            elif a == 6:  # WHILE_HDR(end_off)
                if off + 12 > len(raw):
                    break
                (end_off,) = struct.unpack_from("<I", raw, off + 8)
                insns.append((off, ("WHILE", end_off)))
                off += 12
            elif a == 7:  # SWITCH_HDR(ncases, [target, val]..., end_off)
                if off + 16 > len(raw):
                    break
                (nc,) = struct.unpack_from("<I", raw, off + 8)
                if off + 16 + nc * 8 > len(raw):
                    break
                cases = [
                    struct.unpack_from("<II", raw, off + 12 + i * 8)
                    for i in range(nc)
                ]
                (end_off,) = struct.unpack_from("<I", raw, off + 12 + nc * 8)
                insns.append((off, ("SWITCH", cases, end_off)))
                off += 16 + nc * 8
            elif a == 12:  # GOTO(target_off)
                if off + 12 > len(raw):
                    break
                (target,) = struct.unpack_from("<I", raw, off + 8)
                insns.append((off, ("GOTO", target)))
                off += 12
            else:
                insns.append((off, ("OP0", a)))
                off += 8
        elif op == 5:
            if off + 12 > len(raw):
                break
            (val,) = struct.unpack_from("<I", raw, off + 8)
            if a == 3:
                val = s32(val)
            elif a == 4:
                val = struct.unpack("<f", struct.pack("<I", val))[0]
            insns.append((off, ("PUSH", a, val)))
            off += 12
        else:
            insns.append((off, (op, a)))
            off += 8
    return insns


def _eval_expr_ops(ops: list[tuple], tokens: list[str] | None = None):
    """Evaluate an RPN stack slice into a CfgExpr (or AST side-effect list)."""
    stack: list = []
    effects: list[dict] = []
    select_mess: list[dict] = []
    labels: list[int] = []

    i = 0
    while i < len(ops):
        ins = ops[i]
        kind = ins[0]
        if kind == "PUSH":
            _ptyp, pval = ins[1], ins[2]
            stack.append(pval)
        elif kind == 1:  # Global var G[idx]
            stack.append({"t": "G", "idx": ins[1]})
        elif kind == 2:  # Local var base L[base]
            stack.append({"t": "Lbase", "idx": ins[1]})
        elif kind == 3:  # TXT token
            stack.append({"t": "tok", "tok": ins[1]})
        elif kind == 5:
            pass
        elif kind == 6:
            sub = ins[1]
            if sub == 27:  # array index / L[idx]
                idx = stack.pop() if stack else 0
                base = stack.pop() if stack else {"t": "Lbase", "idx": 0}
                if isinstance(base, dict) and base.get("t") == "Lbase":
                    if isinstance(idx, int) and idx == 0:
                        stack.append({"t": "L", "idx": base["idx"]})
                    else:
                        stack.append({"t": "L", "idx": base["idx"], "off": idx})
                else:
                    stack.append({"t": "idx", "base": base, "off": idx})
            elif sub in ASSIGN_OPS:
                rhs = stack.pop() if stack else 0
                lhs = stack.pop() if stack else None
                op_str = ASSIGN_OPS[sub]
                if isinstance(lhs, dict) and lhs.get("t") == "G":
                    effects.append({"t": "setG", "idx": lhs["idx"], "op": op_str, "val": rhs})
                elif isinstance(lhs, dict) and lhs.get("t") == "L":
                    effects.append({"t": "setL", "idx": lhs["idx"], "op": op_str, "val": rhs})
                stack.append(rhs)
            elif sub in BIN_OPS:
                rhs = stack.pop() if stack else 0
                lhs = stack.pop() if stack else 0
                stack.append({"t": "bin", "op": BIN_OPS[sub], "l": lhs, "r": rhs})
            elif sub == 23:  # unary -
                x = stack.pop() if stack else 0
                if isinstance(x, (int, float)) and not isinstance(x, bool):
                    stack.append(-x)
                else:
                    stack.append({"t": "un", "op": "-", "x": x})
            elif sub == 24:  # unary !
                x = stack.pop() if stack else 0
                stack.append({"t": "un", "op": "!", "x": x})
            elif sub in (25, 26):  # ++ / --
                lhs = stack.pop() if stack else None
                op_str = "+=" if sub == 25 else "-="
                if isinstance(lhs, dict) and lhs.get("t") == "G":
                    effects.append({"t": "setG", "idx": lhs["idx"], "op": op_str, "val": 1})
                elif isinstance(lhs, dict) and lhs.get("t") == "L":
                    effects.append({"t": "setL", "idx": lhs["idx"], "op": op_str, "val": 1})
                stack.append(lhs)
            elif sub in (28, 29, 30):
                pass
        elif kind == 4:
            fn = ins[1]
            if fn in LABEL_OPS:
                tok_ref = next((x["tok"] for x in stack if isinstance(x, dict) and x.get("t") == "tok"), None)
                if tok_ref is None:
                    # fallback: scan earlier ops in statement for first (3, tok)
                    for o2 in ops[:i]:
                        if o2[0] == 3:
                            tok_ref = o2[1]
                            break
                if tok_ref is not None:
                    labels.append(tok_ref)
                stack.clear()
            elif fn == 0:  # SLoad(tok, entry)
                entry = stack.pop() if stack else 0
                target = stack.pop() if stack else None
                sname = _resolve_tok_name(target, tokens)
                if sname and sname.lower() not in ENGINE_INTERNAL:
                    effects.append({"t": "sload", "script": sname, "entry": int(entry) if isinstance(entry, int) else 0})
            elif fn == 1:  # SCall(tok, entry)
                entry = stack.pop() if stack else 0
                target = stack.pop() if stack else None
                sname = _resolve_tok_name(target, tokens)
                if sname and sname.lower() not in ENGINE_INTERNAL:
                    effects.append({"t": "scall", "script": sname, "entry": int(entry) if isinstance(entry, int) else 0})
            elif fn == 5:  # ret (only when standalone statement without downstream consumers)
                if not stack and i == len(ops) - 1 or (i + 1 < len(ops) and ops[i + 1] == (6, 30) and not stack):
                    effects.append({"t": "ret"})
                # Otherwise (4, 5) appears inside engine multimedia args as a no-op separator.
            elif fn == 197:  # GoTitle()
                effects.append({"t": "gotitle"})
                stack.clear()
            elif fn == 198:  # GetGameFlag(id)
                fid = stack.pop() if stack else 0
                stack.append({"t": "gflag", "id": fid})
            elif fn == 199:  # SetGameFlag(id, val)
                val = stack.pop() if stack else 0
                fid = stack.pop() if stack else 0
                effects.append({"t": "setGFlag", "id": fid, "val": val})
                stack.clear()
            elif fn == 208:  # SetSelectMess(tok, flagId, cmpVal, showWhenLocked)
                show = stack.pop() if stack else 0
                cmp_val = stack.pop() if stack else 0
                flag_id = stack.pop() if stack else 99
                tok_node = stack.pop() if stack else None
                tok_id = tok_node["tok"] if isinstance(tok_node, dict) and tok_node.get("t") == "tok" else 0
                select_mess.append({
                    "tok": tok_id,
                    "flagId": flag_id,
                    "cmp": cmp_val,
                    "showWhenLocked": bool(show),
                })
                stack.clear()
            elif fn == 209:  # SetSelect(nodeIdx) -> pushes 0-based selection
                node_idx = stack.pop() if stack else 0
                stack.append({"t": "select", "nodeIdx": node_idx})
            elif fn == 222:  # GetReplayMode()
                stack.append({"t": "replay"})
            else:
                # Unknown/visual engine call inside expression (e.g. (4,205) / (4,238))
                args = list(stack)
                stack.clear()
                stack.append({"t": "call", "id": fn, "args": args})
        i += 1

    expr = stack[-1] if stack else 0
    return expr, effects, select_mess, labels


def _resolve_tok_name(target, tokens: list[str] | None) -> str:
    if isinstance(target, dict) and target.get("t") == "tok" and tokens is not None:
        idx = target["tok"]
        if 0 <= idx < len(tokens):
            return tokens[idx].strip()
    if isinstance(target, str):
        return target.strip()
    return ""


def _unwrap_select(effects: list[dict]) -> tuple[int, dict] | None:
    """Detect `L[0] = SetSelect(nodeIdx) + 1` and return (nodeIdx, {"t": "L", "idx": 0})."""
    if len(effects) != 1:
        return None
    eff = effects[0]
    if eff.get("t") != "setL" or eff.get("op") != "=":
        return None
    val = eff.get("val")
    if isinstance(val, dict) and val.get("t") == "bin" and val.get("op") == "+":
        l, r = val.get("l"), val.get("r")
        if isinstance(l, dict) and l.get("t") == "select" and r == 1:
            return int(l["nodeIdx"]), {"t": "L", "idx": eff["idx"]}
    if isinstance(val, dict) and val.get("t") == "select":
        return int(val["nodeIdx"]), {"t": "L", "idx": eff["idx"]}
    return None


def _is_always_false(cond) -> bool:
    return cond == 0 or cond is False


def _compile_block(
    insns: list[tuple[int, tuple]],
    idx: int,
    stop_offs: set[int],
    tokens: list[str] | None,
    events: list[dict],
    next_ev: list[int],
    choice_by_tok: dict[int, int],
) -> tuple[list[dict], int]:
    """Compile insns starting at idx until an offset in stop_offs or block end.

    Returns (raw_ast_items, next_idx), where items are:
      - {"t": "_label", "ev": int}
      - {"t": "_choice_raw", ...}
      - {"t": "if", "branches": [{"cond": ..., "items": [...]}, ...]}
      - concrete CfgOp (setG, setL, setGFlag, sload, scall, ret, gotitle)
    """
    items: list[dict] = []
    stmt_buf: list[tuple] = []
    pending_mess: list[dict] = []

    def flush_stmt() -> None:
        nonlocal stmt_buf
        if not stmt_buf:
            return
        _expr, effects, smess, labels = _eval_expr_ops(stmt_buf, tokens)
        stmt_buf = []
        for ev_tok in labels:
            if 0 <= ev_tok < len(next_ev):
                items.append({"t": "_label", "ev": next_ev[ev_tok]})
        for m in smess:
            pending_mess.append(m)
        sel = _unwrap_select(effects)
        if sel is not None:
            node_idx, into = sel
            opts = []
            for k, m in enumerate(pending_mess, 1):
                opts.append({
                    "n": k,
                    "tok": m["tok"],
                    "flagId": m["flagId"],
                    "cmp": m["cmp"],
                    "showWhenLocked": m["showWhenLocked"],
                })
            ev_idx = choice_by_tok.get(opts[0]["tok"]) if opts else None
            if ev_idx is None and opts and 0 <= opts[0]["tok"] < len(next_ev):
                ev_idx = next_ev[opts[0]["tok"]]
            items.append({
                "t": "choice",
                "ev": ev_idx if ev_idx is not None else -1,
                "nodeIdx": node_idx,
                "into": into,
                "options": opts,
            })
            pending_mess.clear()
            return
        for eff in effects:
            items.append(eff)

    while idx < len(insns):
        off, ins = insns[idx]
        if off in stop_offs:
            flush_stmt()
            break
        kind = ins[0]
        if kind == "OP0":
            sub = ins[1]
            if sub == 1:  # END_ENTRY / HALT
                flush_stmt()
                idx += 1
                break
            stmt_buf.append(ins)
            idx += 1
        elif kind == "FOR":
            flush_stmt()
            end_off = ins[1]
            idx += 1
            while idx < len(insns) and insns[idx][0] < end_off:
                idx += 1
        elif kind == "WHILE":
            flush_stmt()
            end_off = ins[1]
            idx += 1
            while idx < len(insns) and insns[idx][0] < end_off:
                idx += 1
        elif kind == "SWITCH":
            # In WA2, SWITCH is used solely for GetReplayMode() Omake replay dispatch.
            # Normal story flow skips the replay-jump table and proceeds at end_off.
            flush_stmt()
            end_off = ins[2]
            idx += 1
            while idx < len(insns) and insns[idx][0] < end_off:
                idx += 1
        elif kind == "GOTO":
            flush_stmt()
            target = ins[1]
            idx += 1
            # Forward GOTO to timer-polling skip / end: advance if strictly forward inside same block
            # unless next insn is a backward GOTO polling loop (handled by skipping backward GOTOs).
            if target > off:
                # Only skip forward if it doesn't cross past our enclosing stop_offs
                min_stop = min((s for s in stop_offs if s > off), default=None)
                if min_stop is None or target <= min_stop:
                    # Wait: check if the skipped range contains labels or calls!
                    # (e.g. 1012_030_2@4592 jumps 20 bytes over (6,30); polling GOTO skips 1 GOTO)
                    has_content = False
                    j = idx
                    while j < len(insns) and insns[j][0] < target:
                        op_j = insns[j][1]
                        if op_j[0] == 4 and op_j[1] in (*LABEL_OPS, 0, 1, 197, 199, 208, 209):
                            has_content = True
                            break
                        j += 1
                    if not has_content:
                        idx = j
        elif kind == "IF":
            flush_stmt()
            else_off, end_off = ins[1], ins[2]
            idx += 1
            branches: list[dict] = []
            # Read condition up to OP0(13) + (6,30)
            cond_ops: list[tuple] = []
            while idx < len(insns):
                _coff, cins = insns[idx]
                idx += 1
                if cins == ("OP0", 13):
                    if idx < len(insns) and insns[idx][1] == (6, 30):
                        idx += 1
                    break
                cond_ops.append(cins)
            cond_expr, _ceff, _cm, _cl = _eval_expr_ops(cond_ops, tokens)
            branch_stop = else_off if else_off else end_off
            b_items, idx = _compile_block(
                insns, idx, stop_offs | {branch_stop, end_off},
                tokens, events, next_ev, choice_by_tok,
            )
            branches.append({"cond": cond_expr, "items": b_items})

            cur_else = else_off
            while cur_else and idx < len(insns) and insns[idx][0] == cur_else:
                _eoff, eins = insns[idx]
                idx += 1
                if eins[0] == "ELSEIF":
                    next_else = eins[1]
                    c_ops2: list[tuple] = []
                    while idx < len(insns):
                        _coff2, cins2 = insns[idx]
                        idx += 1
                        if cins2 == ("OP0", 13):
                            if idx < len(insns) and insns[idx][1] == (6, 30):
                                idx += 1
                            break
                        c_ops2.append(cins2)
                    cond2, _, _, _ = _eval_expr_ops(c_ops2, tokens)
                    b2_stop = next_else if next_else else end_off
                    b2_items, idx = _compile_block(
                        insns, idx, stop_offs | {b2_stop, end_off},
                        tokens, events, next_ev, choice_by_tok,
                    )
                    branches.append({"cond": cond2, "items": b2_items})
                    cur_else = next_else
                elif eins[0] == "ELSE":
                    b2_items, idx = _compile_block(
                        insns, idx, stop_offs | {end_off},
                        tokens, events, next_ev, choice_by_tok,
                    )
                    branches.append({"cond": None, "items": b2_items})
                    cur_else = 0
                else:
                    break

            # Advance idx to end_off if still inside (should already be at end_off)
            while idx < len(insns) and insns[idx][0] < end_off:
                idx += 1
            items.append({"t": "if", "branches": branches})
        else:
            stmt_buf.append(ins)
            idx += 1
            if ins == (6, 30):
                flush_stmt()

    flush_stmt()
    return items, idx


def _has_semantic_ops(items: list[dict]) -> bool:
    for it in items:
        t = it["t"]
        if t == "if":
            if any(_has_semantic_ops(b["items"]) for b in it["branches"]):
                return True
        else:
            return True
    return False


def _coalesce_spans(items: list[dict], events: list[dict]) -> list[dict]:
    """Turn `_label` items into contiguous `play` spans [from, to), respecting
    branch and choice boundaries so no choice/jump leaks and leading visual
    cues (image/filter/anim/layer/movie) before the first label or after a
    choice/sibling branch are captured once in stream order.
    """
    n_evs = len(events)
    cursor = 0

    # Identify out-of-order forward-spike labels (e.g. EN-patched special scripts
    # that splice continuation lines appended at the end of .txt mid-script).
    flat_labels: list[int] = []

    def _collect(nodes: list[dict]) -> None:
        for it in nodes:
            if it["t"] == "_label":
                if n_evs:
                    flat_labels.append(max(0, min(n_evs - 1, it["ev"])))
            elif it["t"] == "if":
                for br in it["branches"]:
                    _collect(br["items"])

    _collect(items)
    n_lbl = len(flat_labels)
    suffix_min = [n_evs] * n_lbl
    cur_min = n_evs
    for k in range(n_lbl - 1, -1, -1):
        suffix_min[k] = cur_min
        if flat_labels[k] < cur_min:
            cur_min = flat_labels[k]
    is_spike_pos = [flat_labels[k] > suffix_min[k] for k in range(n_lbl)]
    spike_evs = {flat_labels[k] for k in range(n_lbl) if is_spike_pos[k]}
    lbl_pos = 0

    def non_control(i: int) -> bool:
        return (
            0 <= i < n_evs
            and i not in spike_evs
            and events[i].get("t") not in ("choice", "jump")
        )

    def walk(raw_items: list[dict], is_root_tail: bool) -> list[dict]:
        nonlocal cursor, lbl_pos
        out: list[dict] = []
        run_lo: int | None = None
        run_hi: int | None = None

        def flush_run(up_to_limit: int | None = None) -> None:
            nonlocal run_lo, run_hi, cursor
            if run_lo is None:
                return
            lo, hi = run_lo, run_hi + 1
            # Extend backward to cursor if [cursor, lo) holds only visual/latch setup cues
            if cursor < lo and all(non_control(k) for k in range(cursor, lo)):
                lo = cursor
            # Extend forward to up_to_limit (e.g. right up to a choice or EOF) if non-control
            if up_to_limit is not None and hi < up_to_limit:
                while hi < up_to_limit and non_control(hi):
                    hi += 1
            if lo < hi:
                out.append({"t": "play", "from": lo, "to": hi})
            cursor = max(cursor, hi)
            # Advance cursor past any trailing jump events
            while cursor < n_evs and events[cursor].get("t") == "jump":
                cursor += 1
            run_lo = run_hi = None

        for it in raw_items:
            t = it["t"]
            if t == "_label":
                if n_evs == 0:
                    continue
                ev_i = max(0, min(n_evs - 1, it["ev"]))
                spike = is_spike_pos[lbl_pos]
                lbl_pos += 1
                # Skip labels landing on a choice event (shouldn't happen) or jump
                if events[ev_i].get("t") == "choice":
                    continue
                if spike:
                    flush_run()
                    if out and out[-1].get("t") == "play" and out[-1]["to"] == ev_i:
                        out[-1]["to"] = ev_i + 1
                    else:
                        out.append({"t": "play", "from": ev_i, "to": ev_i + 1})
                    continue
                if run_lo is None:
                    run_lo = ev_i
                    run_hi = ev_i
                else:
                    # If there's a choice or spike strictly between run_hi and ev_i, split
                    if any(
                        events[k].get("t") == "choice" or k in spike_evs
                        for k in range(run_hi + 1, ev_i)
                    ):
                        flush_run()
                        run_lo = ev_i
                        run_hi = ev_i
                    else:
                        run_lo = min(run_lo, ev_i)
                        run_hi = max(run_hi, ev_i)
            elif t == "choice":
                ev_c = it["ev"]
                flush_run(up_to_limit=ev_c if isinstance(ev_c, int) and ev_c >= 0 else None)
                if isinstance(ev_c, int) and ev_c >= cursor:
                    cursor = ev_c + 1
                    while cursor < n_evs and events[cursor].get("t") == "jump":
                        cursor += 1
                out.append(it)
            elif t == "if":
                flush_run()
                compiled_branches: list[dict] = []
                any_nonempty = False
                for br in it["branches"]:
                    if _is_always_false(br["cond"]):
                        # Advance lbl_pos over skipped branch labels
                        _skip_cnt = 0
                        def _count_lbls(ns: list[dict]) -> None:
                            nonlocal _skip_cnt
                            for x in ns:
                                if x["t"] == "_label" and n_evs:
                                    _skip_cnt += 1
                                elif x["t"] == "if":
                                    for b2 in x["branches"]:
                                        _count_lbls(b2["items"])
                        _count_lbls(br["items"])
                        lbl_pos += _skip_cnt
                        continue
                    b_ops = walk(br["items"], is_root_tail=False)
                    if b_ops:
                        any_nonempty = True
                    compiled_branches.append({"cond": br["cond"], "ops": b_ops})
                # Empty visual-only `if`s (e.g. skip-mode/animation checks) are pruned.
                if any_nonempty:
                    out.append({"t": "if", "branches": compiled_branches})
            else:
                # Flush span before state mutations (`setG`, `setL`, `setGFlag`,
                # `sload`, `scall`, `gotitle`) so execution order is exact.
                flush_run()
                out.append(it)

        flush_run(up_to_limit=n_evs if is_root_tail else None)
        # If root has trailing visual-only events after the last op (no labels at all in script)
        if is_root_tail and cursor < n_evs and all(non_control(k) for k in range(cursor, n_evs)):
            if not any(op.get("t") in ("sload", "gotitle") for op in out[-1:]):
                lo = cursor
                hi = n_evs
                while hi > lo and events[hi - 1].get("t") == "jump":
                    hi -= 1
                if lo < hi:
                    out.append({"t": "play", "from": lo, "to": hi})
                    cursor = n_evs
        return out

    return walk(items, is_root_tail=True)


def compile_script_cfg(
    bnr_raw: bytes,
    tokens: list[str] | None,
    events: list[dict],
) -> dict[str, list[dict]]:
    """Compile all story entries of one `.bnr` file into `{entry_str: CfgOp[]}`."""
    secs, code_start = parse_bnr_header(bnr_raw)
    next_ev = bnr_anchor.next_event_map(events)
    choice_by_tok = {
        e["tok"]: i
        for i, e in enumerate(events)
        if e.get("t") == "choice" and "tok" in e
    }
    if not secs:
        secs = [(0, code_start)]

    # Sort sections by offset to bound each entry's bytecode range
    ordered = sorted(secs, key=lambda x: x[1])
    ranges: list[tuple[int, int, int]] = []
    for pos, (eid, start) in enumerate(ordered):
        end = ordered[pos + 1][1] if pos + 1 < len(ordered) else len(bnr_raw)
        if eid >= 9000:
            continue
        ranges.append((eid, start, end))

    entries_out: dict[str, list[dict]] = {}
    for eid, start, end in ranges:
        insns = decode_entry_insns(bnr_raw, start, end)
        raw_items, _ = _compile_block(
            insns, 0, set(), tokens, events, next_ev, choice_by_tok
        )
        entries_out[str(eid)] = _coalesce_spans(raw_items, events)
    return entries_out


def build_cfg(
    spak_path: str,
    en_paks: list[str] | None = None,
    ir_dir: str | None = None,
) -> dict:
    spak = open(spak_path, "rb").read()
    jp_entries = {e.name: e for e in kcap.read_index(spak) if not e.is_folder}

    vars_raw = build_flags.parse_vrb(_read_pak_entry(spak, jp_entries["Global.vrb"]))
    vars_out = [
        {"idx": i, "name": v["name"], "init": v["init"]}
        for i, v in enumerate(vars_raw)
    ]

    bnr_sources: dict[str, tuple[bytes, kcap.Entry]] = {}
    txt_sources: dict[str, tuple[bytes, kcap.Entry]] = {}

    for name, ent in jp_entries.items():
        if name.endswith(".bnr"):
            bnr_sources[name[:-4]] = (spak, ent)
        elif name.endswith(".txt"):
            txt_sources[name[:-4]] = (spak, ent)

    # Later EN paks override earlier EN paks for special scripts absent from script.pak
    en_bnrs: dict[str, tuple[bytes, kcap.Entry]] = {}
    en_txts: dict[str, tuple[bytes, kcap.Entry]] = {}
    for p in en_paks or []:
        d = open(p, "rb").read()
        for e in kcap.read_index(d):
            if e.is_folder:
                continue
            if e.name.endswith(".bnr"):
                en_bnrs[e.name[:-4]] = (d, e)
            elif e.name.endswith(".txt"):
                en_txts[e.name[:-4]] = (d, e)

    for sid, src in en_bnrs.items():
        if sid not in bnr_sources and not sid.endswith(("_2", "_3", "_4")):
            bnr_sources[sid] = src
    for sid, src in en_txts.items():
        if sid not in txt_sources and not sid.endswith(("_2", "_3", "_4")):
            txt_sources[sid] = src

    scripts_out: dict[str, dict[str, list[dict]]] = {}
    for sid in sorted(bnr_sources):
        if sid in ENGINE_INTERNAL:
            continue
        bpak, bent = bnr_sources[sid]
        bnr_raw = _read_pak_entry(bpak, bent)

        # Prefer JP spine tokens for SLoad/SCall target names (or winning txt)
        tokens: list[str] | None = None
        if sid in txt_sources:
            tpak, tent = txt_sources[sid]
            tb = _read_pak_entry(tpak, tent)
            tokens = [t.decode("cp932", "replace") for t in tb.split(b",")]

        # Prefer built IR events when available (aligns choice/play indices 1:1)
        events: list[dict] = []
        if ir_dir:
            ir_path = os.path.join(ir_dir, f"{sid}.json")
            if os.path.isfile(ir_path):
                with open(ir_path, encoding="utf-8") as f:
                    events = json.load(f).get("events") or []
        if not events and tokens is not None:
            events, _ = parse_txt.parse_tokens(tokens)

        scripts_out[sid] = compile_script_cfg(bnr_raw, tokens, events)

    return {"version": 1, "vars": vars_out, "scripts": scripts_out}


def main() -> None:
    argv = sys.argv[1:]
    ir_dir = None
    if "--ir" in argv:
        idx = argv.index("--ir")
        ir_dir = argv[idx + 1]
        del argv[idx:idx + 2]
    if len(argv) < 2:
        print(__doc__)
        sys.exit(2)
    spak_path = argv[0]
    out_path = argv[-1]
    en_paks = argv[1:-1]

    cfg = build_cfg(spak_path, en_paks=en_paks, ir_dir=ir_dir)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, separators=(",", ":"))
    n_ops = sum(len(ops) for entries in cfg["scripts"].values() for ops in entries.values())
    print(f"cfg: {len(cfg['scripts'])} scripts, {len(cfg['vars'])} vars, {n_ops} top-level ops -> {out_path}")


if __name__ == "__main__":
    main()
