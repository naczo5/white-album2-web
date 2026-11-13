"""Unit tests for exact .bnr anchoring via the JP token spine.

Covers the (3,X)/(4,131|144) label forms proven corpus-wide
(docs/PARSING.md): a record executes when the script reaches the next
sync label at-or-after it, and (3,X) X is a JP naive comma-token index.
Synthetic payloads only — no game content.
"""

import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import parse_txt  # noqa: E402
from bnr_anchor import anchor_stmts, has_sync, jp_spine_events, next_event_map  # noqa: E402


def lscr_payload(words: list[int]) -> bytes:
    return b"LSCR" + struct.pack("<II", 0x14, 0) + b"\x00" * 16 + \
        struct.pack(f"<{len(words)}I", *[w & 0xFFFFFFFF for w in words])


def stmt(words: list[int]) -> list[int]:
    return words + [6, 30]


def test_next_event_map_resolves_to_first_event_at_or_after_token():
    events, _ = parse_txt.parse_tokens(
        parse_txt.split_tokens("Prose.,Haruki,\"No.\"".encode("cp932")))
    assert [(e["t"], e["tok"]) for e in events] == \
        [("narrate", 0), ("latch", 1), ("say", 2)]
    m = next_event_map(events)
    assert m == [0, 1, 2]
    # token past the last event clamps to the last event
    assert m[-1] == len(events) - 1


def test_next_event_map_empty_spine():
    assert next_event_map([]) == [0]


def test_anchor_stmts_label_pairs_records_to_line_event():
    # stmt0/1 = record, stmt2 = label (3,2)+(4,131), stmt3 = record.
    # The label means "sync with display token 2": stmt2 anchors to the
    # event owning token 2, and everything before it inherits that anchor.
    payload = lscr_payload(
        stmt([5, 3, 7, 5, 3, 255, 4, 158]) +          # BGM play (record)
        stmt([5, 3, 1001, 5, 3, 255, 4, 164]) +       # SE (record)
        stmt([3, 2, 4, 131]) +                        # line label -> tok 2
        stmt([5, 3, 0, 4, 100]))                      # record after label
    events, _ = parse_txt.parse_tokens(
        parse_txt.split_tokens("Prose.,Haruki,\"No.\"".encode("cp932")))
    m = next_event_map(events)
    anchors = anchor_stmts(payload, m)
    # records before the label ride the label's event (say at tok 2)
    assert anchors[:3] == [2, 2, 2]
    # the record after the last label executes at/after it -> rides the
    # last label's event (NOT 0: a 0 tail made evs non-monotonic and let
    # trailing sprClear/bak statements wipe scenes corpus-wide)
    assert anchors[3] == 2


def test_anchor_stmts_before_first_label_is_zero():
    payload = lscr_payload(
        stmt([5, 3, 7, 5, 3, 255, 4, 158]) +
        stmt([3, 0, 4, 131]))
    m = next_event_map([{"t": "say", "tok": 5}])
    anchors = anchor_stmts(payload, m)
    # label (3,0) with no event at tok 0 resolves to first event (0);
    # the leading record inherits it.
    assert anchors == [0, 0]


def test_anchor_stmts_label_144_and_double_131_form():
    events, _ = parse_txt.parse_tokens(
        parse_txt.split_tokens("Prose.,Haruki,\"No.\"".encode("cp932")))
    m = next_event_map(events)
    payload = lscr_payload(
        stmt([3, 1, 4, 144]) +   # variant label op -> tok 1 (latch event)
        stmt([3, 2, 4, 131, 4, 131]) +  # (131,131) double form -> tok 2
        stmt([5, 3, 9, 4, 100]))
    anchors = anchor_stmts(payload, m)
    assert anchors[0] == 1
    assert anchors[1] == 2
    # trailing record after the last label rides the last label's event
    # (monotonic stream order; never 0)
    assert anchors[2] == 2


def test_anchor_stmts_out_of_range_x_clamps_without_anchor():
    # An unresolvable label at the very end of the stream (EN tail overflow
    # past the last JP line) still clamps to the last event when nothing
    # below it established a real anchor.
    events, _ = parse_txt.parse_tokens(
        parse_txt.split_tokens("Prose.,Haruki,\"No.\"".encode("cp932")))
    m = next_event_map(events)
    payload = lscr_payload(stmt([3, 999, 4, 131]))
    assert anchor_stmts(payload, m) == [2]


def test_anchor_stmts_out_of_range_label_skipped_after_real_anchor():
    """1001 shape: an EN-only extra label past the JP spine must not reset
    earlier statements onto the last event.

    Stream (bottom-up): real labels for tokens 1 and 2, then an EN-only
    (3,80) label with only 3 events in the spine. Before the fix the
    out-of-range label set carry = next_ev[-1] (2/ev 80) and every earlier
    statement — including the airport/city backdrops at ev 1/4/7 — collapsed
    onto it.
    """
    events, _ = parse_txt.parse_tokens(
        parse_txt.split_tokens("A.,B.,C.".encode("cp932")))
    m = next_event_map(events)
    assert m == [0, 1, 2]
    payload = lscr_payload(
        stmt([3, 1, 4, 131]) +          # real label: tok 1 -> ev 1
        stmt([3, 80, 4, 131, 4, 131]) +  # EN tail-overflow label, out of range
        stmt([5, 3, 9, 4, 100]))         # trailing record
    anchors = anchor_stmts(payload, m)
    assert anchors[0] == 1        # rides the real label below it
    assert anchors[1] == 2        # the unresolvable label clamps (nothing below)
    assert anchors[2] == 2        # trailing record keeps stream order


def test_anchor_stmts_keeps_real_anchors_before_overflow_labels():
    """Two real labels under an overflow label keep their own anchors."""
    events, _ = parse_txt.parse_tokens(
        parse_txt.split_tokens("A.,B.,C.,D.".encode("cp932")))
    m = next_event_map(events)
    payload = lscr_payload(
        stmt([3, 1, 4, 131]) +   # ev 1
        stmt([3, 2, 4, 131]) +   # ev 2
        stmt([3, 99, 4, 144]) +  # out of range: skipped
        stmt([3, 3, 4, 131]))    # ev 3
    anchors = anchor_stmts(payload, m)
    assert anchors == [1, 2, 3, 3]


def test_has_sync_detects_labels():
    plain = lscr_payload(stmt([5, 3, 7, 5, 3, 255, 4, 158]))
    assert not has_sync(plain)
    labeled = lscr_payload(stmt([3, 1, 4, 131]))
    assert has_sync(labeled)


def test_jp_spine_events_uses_naive_split():
    ev = jp_spine_events('Haruki,"Ah…",Snow falls.'.encode("cp932"))
    assert [(e["t"], e["tok"]) for e in ev] == \
        [("latch", 0), ("say", 1), ("narrate", 2)]