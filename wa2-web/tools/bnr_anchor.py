"""Exact .bnr statement anchoring via the JP token spine.

Every .bnr statement stream is punctuated by (3,X) sync ops: X is the JP
naive comma-token index the record belongs to (the same coordinates the
(4,138) voice chain maps — build_voice.py, 41464/41464 exact). A record
executes when the script reaches the next sync at-or-after it, so its
event anchor = the IR event owning that token.

The IR is built on the JP spine (build_ir.py) with shape-identical events
(spine replay), so anchors computed from the JP parse are the IR indices
the player navigates by.

`next_ev[j]` = index of the first event whose token index is >= j (token
coordinates that fall on empty/name tokens resolve to the next display
event; coordinates past the last event clamp to the last event).
"""

from __future__ import annotations

import sys

HERE = __import__("os").path.dirname(__import__("os").path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import parse_txt  # noqa: E402
from proto_bgm import iter_statements  # noqa: E402


def jp_spine_events(jp_txt: bytes) -> list[dict]:
    """JP spine events (naive comma split — the engine's real split)."""
    toks = [t.decode("cp932", "replace") for t in jp_txt.split(b",")]
    events, _ = parse_txt.parse_tokens(toks)
    return events


def next_event_map(events: list[dict]) -> list[int]:
    """token index -> event index of the first event whose tok >= j.

    Tokens before the first event resolve to the first event; tokens past
    the last event's tok clamp to the last event.
    """
    pairs = [(e["tok"], i) for i, e in enumerate(events) if "tok" in e]
    if not pairs:
        return [0]
    out = [0] * (pairs[-1][0] + 1)
    k = 0
    for j in range(len(out)):
        while k < len(pairs) and pairs[k][0] < j:
            k += 1
        out[j] = pairs[k][1] if k < len(pairs) else len(events) - 1
    return out


_LABEL_OPS = (131, 144)


def anchor_stmts(payload, next_ev: list[int]) -> list[int]:
    """Per-statement event anchor: the next line-label sync at-or-after
    each statement resolves X through `next_ev`.

    A label statement carries (3,X) plus opcode (4,131) or (4,144) — the
    corpus label forms (21577 + 15288 occurrences). The (131,131) double
    form (941x) syncs an EN tail-overflow fragment right after its source
    line; the FIRST (3,X) is the display line. Statements before the
    first label anchor to event 0; statements after the LAST label
    anchor to that last label's event (they execute at/after the final
    labeled line in stream order — anchoring them to 0 made event numbers
    non-monotonic and let a trailing sprClear/bak wipe scenes corpus-wide,
    e.g. 1004 showed no sprites at any event).
    """
    stmts = list(iter_statements(payload))
    n = len(stmts)
    anchors: list[int | None] = [None] * n
    carry: int | None = None
    last_label_i: int | None = None
    for i in range(n - 1, -1, -1):
        ops = stmts[i][3]
        xs = [a for o, a in ops if o == 3]
        if xs and any(a in _LABEL_OPS for o, a in ops if o == 4):
            x = xs[0]
            if last_label_i is None:
                last_label_i = i
            if x < 0:
                carry = 0
            elif x < len(next_ev):
                carry = next_ev[x]
            else:
                carry = next_ev[-1] if next_ev else 0
        anchors[i] = carry
    if last_label_i is None:
        return [0] * n
    tail_ev = anchors[last_label_i]
    return [
        a if a is not None
        else (tail_ev if i > last_label_i else 0)
        for i, a in enumerate(anchors)
    ]


def has_sync(payload) -> bool:
    """True when the stream carries any line label (exact-anchor
    eligible); label-less streams fall back to fractional placement."""
    for _o, _f, _p, ops, _r, _fl in iter_statements(payload):
        xs = [a for o, a in ops if o == 3]
        if xs and any(a in _LABEL_OPS for o, a in ops if o == 4):
            return True
    return False