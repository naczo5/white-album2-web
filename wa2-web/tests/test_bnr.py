"""Unit tests for .bnr decoding + nested-LAC audio names (synthetic, no assets)."""

import os
import struct
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

HERE = os.path.dirname(__file__)
SCRIPT_PAK = os.environ.get("WA2_SCRIPT_PAK") or os.path.join(
    HERE, "..", "..", ".cache", "game", "script.pak")

from extract_assets import _pak_tag, decode_lac_name, voice_line_key  # noqa: E402
from proto_bgm import find_bgm, find_se, iter_statements  # noqa: E402


def xor_name(s: str) -> bytes:
    return bytes(b ^ 0xFF for b in s.encode()) + b"\x00" * (24 - len(s))


def lscr_payload(words: list[int]) -> bytes:
    return b"LSCR" + struct.pack("<II", 0x14, 0) + b"\x00" * 16 + \
        struct.pack(f"<{len(words)}I", *[w & 0xFFFFFFFF for w in words])


def stmt(words: list[int]) -> list[int]:
    return words + [6, 30]


def pushes(*vals: int) -> list[int]:
    out: list[int] = []
    for v in vals:
        out.extend([5, 3, v & 0xFFFFFFFF])
    return out


def test_decode_lac_name_accepts_bgm_se_voice():
    assert decode_lac_name(xor_name("BGM_001_A.OGG")) == "BGM_001_A.OGG"
    assert decode_lac_name(xor_name("BGM_074.OGG")) == "BGM_074.OGG"
    assert decode_lac_name(xor_name("SE_0000.WAV")) == "SE_0000.WAV"
    assert decode_lac_name(xor_name("1008_199_04.OGG")) == "1008_199_04.OGG"


def test_decode_lac_name_rejects_garbage():
    assert decode_lac_name(b"\x01\x02\x03" + b"\x00" * 21) == ""
    assert decode_lac_name(b"noext" + b"\x00" * 19) == ""


def test_voice_line_key_accepts_variant_script_suffix():
    assert voice_line_key("1008_0199_04.OGG") == ("1008_0199", "OGG")
    # variant scripts can carry their own suffix before the line number
    assert voice_line_key("1008_020_0199_04.OGG") == ("1008_020_0199", "OGG")
    assert voice_line_key("not-a-voice.OGG") is None
    assert voice_line_key("1008_0199.OGG") is None


def test_find_bgm_play_shape():
    payload = lscr_payload(
        stmt([5, 3, 1]) +
        stmt([5, 3, 7, 5, 3, -2, 5, 3, 1, 5, 3, 255, 4, 158]))
    plays, stops, n = find_bgm(payload)
    assert n == 2
    assert len(plays) == 1 and plays[0]["track"] == 7
    assert plays[0]["fade"] == -2
    assert stops == []


def test_find_bgm_stop_shape_is_ops_based():
    # (4,5),(3,X),(4,158): stop even though pushes[0]=120 looks like a track
    payload = lscr_payload(
        stmt([5, 3, 120, 5, 3, 1, 5, 3, 255, 4, 5, 3, 10, 4, 158]))
    plays, stops, _ = find_bgm(payload)
    assert plays == []
    assert len(stops) == 1


def test_find_bgm_channel_variant_is_play():
    payload = lscr_payload(
        stmt([5, 3, 20, 5, 3, 2, 5, 3, 0, 5, 3, 0, 6, 23, 4, 158]))
    plays, stops, _ = find_bgm(payload)
    assert len(plays) == 1 and plays[0]["track"] == 20
    assert stops == []


def test_find_se_shape():
    payload = lscr_payload(
        stmt([5, 3, 1001, 5, 3, 255, 4, 164]) +
        stmt([5, 3, 7, 5, 3, -2, 5, 3, 1, 5, 3, 255, 4, 158]))
    out = find_se(payload)
    assert len(out) == 1 and out[0]["se"] == 1001
    # BGM statement is not an SE statement
    assert out[0]["stmt"] == 0


def test_iter_statements_captures_float_pushes():
    zoom_bits = struct.unpack("<I", struct.pack("<f", 2.0))[0]
    payload = lscr_payload(
        stmt([6, 27, 5, 4, zoom_bits, 5, 3, 1000, 6, 18]))
    rows = list(iter_statements(payload))
    assert len(rows) == 1
    _idx, _off, _pushes, ops, _raw, floats = rows[0]
    assert (6, 27) in ops and (6, 18) in ops
    assert floats == [2.0]


def test_pak_tag_finds_nested_ic_disc_layout():
    assert _pak_tag("/g/IC/BGM.PAK", "/g") == "ic"
    assert _pak_tag("/g/disc1/IC/BGM.PAK", "/g") == "ic"
    assert _pak_tag("/g/disc1/BGM.PAK", "/g") == ""


def _decode_syn(*stmts: list[int]):
    from unittest.mock import patch
    import decode_bnr
    payload = lscr_payload(sum((stmt(s) for s in stmts), []))
    with patch.object(decode_bnr.kcap, "read_index", return_value=[]), patch.object(
        decode_bnr, "load_bnr", return_value=(payload, None),
    ):
        return decode_bnr.decode_script(b"", "syn")


def _img_row(recs, **kw):
    rows = [r for r in recs if r.get("layer") in ("bak", "grp") and "stems" in r]
    assert len(rows) == 1, recs
    for k, v in kw.items():
        assert rows[0][k] == v, rows[0]
    return rows[0]


def test_decode_img_op146_bak_sprclear_tod_default():
    recs = _decode_syn(pushes(1, 1001, 0, 60, 0, 0, 0) + [4, 146])
    _img_row(recs, layer="bak", sprClear=True, stems=["100100"])


def test_decode_img_op146_x0_fade_still_wipes_sprites():
    # (4,146) passes arg2=0 to 0x4167e0 regardless of X; a fade cue must
    # still clear sprites. This is the 2503 ev230/272 transition that left
    # a previous-scene character on stage.
    recs = _decode_syn(pushes(1, 0, 0, 120, 0, 0, 0) + [4, 146])
    fade = [r for r in recs if "fadeMs" in r]
    assert len(fade) == 1
    assert fade[0]["sprClear"] is True


def test_decode_img_op147_x0_fade_keeps_sprites():
    recs = _decode_syn(pushes(1, 0, 0, 120, 0, 0, 0) + [4, 147])
    fade = [r for r in recs if "fadeMs" in r]
    assert len(fade) == 1
    assert not fade[0].get("sprClear")


def test_decode_img_op148_x0_fade_wipes_sprites():
    recs = _decode_syn(pushes(1, 0, 0, 120, 0, 0, 0) + [4, 148])
    fade = [r for r in recs if "fadeMs" in r]
    assert len(fade) == 1
    assert fade[0]["sprClear"] is True


def test_decode_img_op147_bak_keeps_sprites():
    recs = _decode_syn(pushes(1, 1001, 0, 60, 0, 0, 0) + [4, 147])
    _img_row(recs, layer="bak", sprClear=False, stems=["100100"])


def test_decode_img_op148_grp_sprclear():
    recs = _decode_syn(pushes(1, 10010, 0, 60, 0, 0, 0) + [4, 148])
    row = _img_row(recs, layer="grp", sprClear=True)
    assert "100100" in row["stems"]


def test_decode_tod170_push_list_sets_evening_stem():
    recs = _decode_syn(
        pushes(1) + [4, 170],
        pushes(1, 1001, 0, 60, 0, 0, 0) + [4, 146],
    )
    _img_row(recs, stems=["100101"])


def test_decode_tod170_via_bgm_stop_push():
    recs = _decode_syn(
        [4, 5, 3, 2, 4, 170],
        pushes(1, 1033, 0, 30, 0, 0, 0) + [4, 146],
    )
    _img_row(recs, stems=["103302"])


def test_decode_tod170_multiop_trailing_zero():
    recs = _decode_syn(
        pushes(447, 1600, 10, 0) + [6, 18, 6, 19, 4, 196, 4, 170, 6, 21],
        pushes(1, 1001, 0, 60, 0, 0, 0) + [4, 146],
    )
    _img_row(recs, stems=["100100"])


def test_decode_img_multiop_trailing_6_slice():
    recs = _decode_syn(
        pushes(9, 8, 1, 2001, 1, 45, 0, 0, 0)
        + [6, 18, 6, 19, 4, 196, 4, 148, 6, 21],
    )
    row = _img_row(recs, layer="grp")
    assert row["fade"] == 45
    assert "200101" in row["stems"]


def test_decode_img_trailing_4_132_drop():
    recs = _decode_syn(
        pushes(1, 1001, 0, 60, 0, 0, 0, 99) + [4, 146, 4, 132],
    )
    _img_row(recs, stems=["100100"])


def test_decode_img_6_27_variant_slice():
    recs = _decode_syn(
        [2, 0, 6, 27, 6, 16]
        + pushes(1, 2, 3, 9, 8, 4, 7, 0, 0, 0)
        + [4, 148],
    )
    row = _img_row(recs, layer="grp")
    assert row["fade"] == 7
    assert "908" in row["stems"]


def test_decode_img_3907_resolution_pushes():
    zoom = struct.unpack("<I", struct.pack("<f", 1.0))[0]
    recs = _decode_syn(
        pushes(1, 5010, 2, 90, 0, 0, 0)
        + [6, 23, 6, 18, 5, 4, zoom]
        + pushes(1280, 720)
        + [4, 146],
    )
    _img_row(recs, layer="bak", stems=["501020"], fade=90)


def test_decode_amb_channel_is_not_clamped_to_three():
    # 0x40f400 indexes 16 channel records (0x5e7360 stride 0x34, update loop
    # ends at 0x5e76ac); the corpus uses channels 0-6. Folding ch 5 onto ch 3
    # made unrelated sounds share one slot.
    recs = _decode_syn(pushes(5, 2210, 0, 0, 255, 0) + [4, 165])
    amb = [r for r in recs if "amb" in r]
    assert len(amb) == 1
    assert amb[0]["amb"] == {"se": 2210, "ch": 5, "vol": 255, "loop": False}
    stop = _decode_syn(pushes(6, 0) + [4, 166])
    assert [r for r in stop if "ambStop" in r][0]["ambStop"] == 6


def test_decode_amb_loop_volume_and_fade_args():
    # [ch, se, fade, loop, volume, mode]: loop=1 persists, volume is s[4].
    recs = _decode_syn(pushes(2, 3019, 30, 1, 80, 0) + [4, 165])
    amb = [r for r in recs if "amb" in r][0]["amb"]
    assert amb == {"se": 3019, "ch": 2, "vol": 80, "loop": True}


def test_decode_amb_166_fade_out_stops_channel():    # (4,166) [ch, V] ends the channel. V is a fade-out duration (V>0,
    # often 300/360/420/480 in the corpus); V<=0 is an immediate stop.
    # 0x40f590 -> 0x4067a0(ch, target_volume=0, duration=V).
    for v in (0, 120, 360):
        recs = _decode_syn(pushes(5, v) + [4, 166])
        stops = [r for r in recs if "ambStop" in r]
        assert len(stops) == 1 and stops[0]["ambStop"] == 5, (v, recs)
        assert not [r for r in recs if "ambVol" in r]


def test_decode_rejects_multi_op_165_with_short_pushes():
    # Intro variant shape (4,5),(3,1),(4,165) has only 5 pushes; the pushes
    # belong to the earlier ops. Reading them as [ch,se,...] produced a fake
    # ch15 loop (SE 3019) in 1008_020/1009_020/etc.
    recs = _decode_syn(pushes(3019, 20, 1, 60, 0) + [4, 5, 3, 1, 4, 165])
    assert not [r for r in recs if "amb" in r]


def test_decode_165_mode2_is_not_a_play():
    # Mode 2 only adjusts an already-active channel; it must not be emitted
    # as a new play (there is no handle to start).
    recs = _decode_syn(pushes(0, 2210, 0, 0, 255, 2) + [4, 165])
    assert not [r for r in recs if "amb" in r]


def test_decode_rejects_out_of_range_channels():
    # (4,166)[120,0] is a duration/other shape, not channel 120. Clamping
    # would inject a fake ch15 stop.
    recs = _decode_syn(pushes(120, 0) + [4, 166])
    assert not [r for r in recs if "ambStop" in r]
    recs = _decode_syn(pushes(20, 2210, 0, 0, 255, 0) + [4, 165])
    assert not [r for r in recs if "amb" in r]


def test_split_image_records_anchor_to_base_token():
    # A MAO `_N` split's (3,X) label maps through the base JP spine's
    # next_event_map. 2504_2's grp CGs must land on base 2504 ev 730 etc.
    from decode_bnr import split_image_records
    payload = lscr_payload(
        stmt(pushes(1, 20490, 0, 90, 0, 0, 0) + [4, 148])
        + stmt([3, 730, 4, 144]),
    )
    recs = split_image_records(payload, [{"tok": 730}])
    grp = [r for r in recs if r.get("layer") == "grp"]
    assert len(grp) == 1
    assert grp[0]["ev"] == 0
    assert "204900" in grp[0]["stems"]


# ------------------------------------- weather / shake / calendar ops ---


def test_decode_weather_set_173():
    recs = _decode_syn(pushes(3, 10, 10, 128, 2, 0) + [4, 173])
    weather = [r for r in recs if "weather" in r]
    assert len(weather) == 1
    assert weather[0]["weather"] == {
        "mode": 3, "sx": 10, "sy": 10, "count": 128,
        "flag2": 2, "index": 0,
    }
    assert weather[0]["conf"] == "high"


def test_decode_weather_set_173_has_no_seven_arg_turbulence_path():
    # Turbulence is arg 3 of SetWeather2 (0xe5), not (4,173). A leading
    # extra value is ignored by taking the last six; the test pins that the
    # old invented `turb = vals[6]` shape cannot reappear.
    recs = _decode_syn(pushes(99, 6, 10, 20, 30, 2, 0) + [4, 173])
    w = [r for r in recs if "weather" in r][0]["weather"]
    assert "turb" not in w
    assert (w["mode"], w["sx"], w["sy"], w["count"]) == (6, 10, 20, 30)


def test_decode_weather_set_173_expression_fused_args():
    # (6,22) OR and (6,23) negate sit between pushes; the stack evaluator
    # must fold them instead of dropping the expression words.
    recs = _decode_syn(
        [5, 3, 3, 5, 3, 256, 6, 22] + pushes(10, 10, 128, 2, 0) + [4, 173],
    )
    w = [r for r in recs if "weather" in r][0]["weather"]
    assert (w["mode"], w["sx"]) == (259, 10)

    recs = _decode_syn(
        [5, 3, 3, 5, 3, 2, 6, 23] + pushes(20, 256, 2, 0) + [4, 173],
    )
    w = [r for r in recs if "weather" in r][0]["weather"]
    assert (w["mode"], w["sx"], w["sy"]) == (3, -2, 20)


def test_decode_weather_change_174_changed_fields_only():
    recs = _decode_syn(pushes(30, 30, 128, -1000, 1) + [4, 174])
    weather = [r for r in recs if "weather" in r]
    assert len(weather) == 1
    assert weather[0]["weather"] == {"sx": 30, "sy": 30, "count": 128,
                                     "index": 1}


def test_decode_weather_change_174_all_unchanged_is_noop():
    recs = _decode_syn(
        pushes(-1000, -1000, -1000, -1000, -1000) + [4, 174])
    assert not [r for r in recs if "weather" in r]


def test_decode_weather_reset_175():
    recs = _decode_syn([4, 175])
    assert [r for r in recs if "weatherStop" in r] == [
        {"ev": 0, "weatherStop": True, "conf": "high"}
    ]


def test_decode_shake_150_types_1_and_9_only():
    recs = _decode_syn(pushes(9, 32, 30, 2, 32) + [4, 150])
    shake = [r for r in recs if "shake" in r]
    assert len(shake) == 1
    assert shake[0]["shake"] == {"type": 9, "strength": 32, "frames": 30}

    recs = _decode_syn(pushes(1, 16, 20, 2, 32) + [4, 150])
    assert [r for r in recs if "shake" in r][0]["shake"]["type"] == 1

    # 0/12/13 share (4,150) but are not the proven shake shape.
    for typ in (0, 12, 13):
        recs = _decode_syn(pushes(typ, 32, 30, 2, 32) + [4, 150])
        assert not [r for r in recs if "shake" in r]


def test_decode_calendar_203_computes_dow_and_handles_variants():
    recs = _decode_syn(pushes(2010, 11, 24, -1, 1) + [4, 203])
    cal = [r for r in recs if "cal" in r]
    assert len(cal) == 1
    assert cal[0]["cal"] == {"year": 2010, "month": 11, "day": 24,
                             "dow": 3}

    # Explicit dow is preserved.
    recs = _decode_syn(pushes(2010, 11, 24, 7, 0) + [4, 203])
    assert [r for r in recs if "cal" in r][0]["cal"]["dow"] == 7

    # 6-push variant: one trailing unproven word is ignored, not emitted.
    recs = _decode_syn(pushes(2015, 12, 25, -1, 1, 0) + [4, 203])
    assert [r for r in recs if "cal" in r][0]["cal"] == {
        "year": 2015, "month": 12, "day": 25, "dow": 5,
    }


def test_decode_calendar_op0_else_header():
    # 3016.bnr @2148 starts `0,4` (OP0 ELSE), then push 2013, 1, 28, -1, 1.
    # The generic statement iterator misreads this as (4,5) + (3,2013) and
    # drops the year push; the local body evaluator must consume the OP0
    # header instead of treating its operand as a call opcode.
    recs = _decode_syn(
        [0, 4] + pushes(2013, 1, 28, -1, 1) + [4, 203],
    )
    assert [r for r in recs if "cal" in r][0]["cal"] == {
        "year": 2013, "month": 1, "day": 28, "dow": 1,
    }

    # 2014.bnr @55748 has the same shape with 2010-12-18.
    recs = _decode_syn(
        [0, 4] + pushes(2010, 12, 18, -1, 0) + [4, 203],
    )
    assert [r for r in recs if "cal" in r][0]["cal"] == {
        "year": 2010, "month": 12, "day": 18, "dow": 6,
    }


def test_decode_calendar_does_not_use_line_label_as_year():
    # (3,X) is a line-sync label, not the year. Without a year push the
    # 4-argument calendar must stay undecoded.
    recs = _decode_syn(
        pushes(12, 18, -1, 0) + [3, 2010, 4, 5, 4, 203],
    )
    assert not [r for r in recs if "cal" in r]


@pytest.mark.skipif(not os.path.isfile(SCRIPT_PAK),
                    reason="BYOA JP script.pak not present")
def test_corpus_calendar_op0_else_years_2014_3016():
    import decode_bnr

    with open(SCRIPT_PAK, "rb") as f:
        data = f.read()
    cals_2014 = [r["cal"] for r in decode_bnr.decode_script(data, "2014")
                 if "cal" in r]
    assert {"year": 2010, "month": 12, "day": 18,
            "dow": 6} in cals_2014

    cals_3016 = [r["cal"] for r in decode_bnr.decode_script(data, "3016")
                 if "cal" in r]
    assert {"year": 2013, "month": 1, "day": 28,
            "dow": 1} in cals_3016


def test_dedupe_preserves_presentation_only_records():
    from decode_bnr import dedupe_recs
    shake = {"type": 9, "strength": 32, "frames": 30}
    cal = {"year": 2010, "month": 11, "day": 24, "dow": 3}
    rows = [
        {"ev": 1, "weather": {"sx": 30}, "conf": "high"},
        {"ev": 1, "weather": {"sx": 30}, "conf": "high"},  # duplicate
        {"ev": 1, "weatherStop": True, "conf": "high"},
        {"ev": 1, "shake": shake, "conf": "high"},
        {"ev": 1, "cal": cal, "conf": "high"},
    ]
    out = dedupe_recs(rows)
    assert len(out) == 4
    assert out[0]["weather"] == {"sx": 30}
    assert out[1]["weatherStop"] is True
    assert out[2]["shake"] == shake
    assert out[3]["cal"] == cal


def test_presentation_decoder_bails_on_unmodelled_value_producers():
    # (2,N) is a global-variable read, not a no-op: it pushes a value, so a
    # weather statement that consumes it must not emit a guessed high record.
    recs = _decode_syn([2, 0] + pushes(3, 10, 10, 128, 2, 0) + [4, 173])
    assert not [r for r in recs if "weather" in r]
    # GetClick/GetSkip/GetTimer etc. are value-returning engine calls.
    recs = _decode_syn(pushes(3, 10, 10, 128, 2, 0) + [4, 206, 4, 173])
    assert not [r for r in recs if "weather" in r]


# ------------------------------------------------ BMP overlays + modes ---


def test_bmp_load_resolves_string_tokens_and_order():
    import decode_bnr
    body = ([5, 3, 0, 3, 0, 5, 3, 14, 5, 3, 2, 3, 1, 5, 3, 256,
             3, 2, 5, 3, 1, 4, 176])
    rows = decode_bnr.bmp_records(body, ["guitar.tga", "", "grp"], 7)
    assert rows == [{"ev": 7,
                     "bmp": {"id": 0, "file": "guitar.tga", "z": 14,
                             "folder": "grp"},
                     "conf": "high"}]


def test_bmp_alpha_move_and_zoom_shapes():
    import decode_bnr
    alpha = decode_bnr.bmp_records(
        pushes(0, 1, 128, 60) + [4, 185], None, 2)
    assert alpha[0]["bmpAlpha"] == {"id": 0, "mode": 1, "alpha": 128,
                                   "frames": 60}
    move = decode_bnr.bmp_records(pushes(0, 641, 361) + [4, 188], None, 2)
    assert move[0]["bmpMove"] == {"id": 0, "x": 641, "y": 361}
    rect = decode_bnr.bmp_records(
        pushes(3, 129, 243, 283, 199) + [4, 190], None, 2)
    assert rect[0]["bmpRect"] == {"id": 3, "x": 129, "y": 243,
                                  "w": 283, "h": 199}
    scale = decode_bnr.bmp_records(pushes(0, 640, 360, 8) + [4, 191], None, 2)
    assert scale[0]["bmpScale"] == {"id": 0, "x": 640, "y": 360, "scale": 8}
    rel = decode_bnr.bmp_records(pushes(0) + [4, 180], None, 2)
    assert rel[0]["bmpRelease"] == 0


def test_novel_ero_and_wait_records():
    import decode_bnr
    assert decode_bnr.mode_records(pushes(1) + [4, 220], 3) == [
        {"ev": 3, "novel": True, "conf": "high"}]
    assert decode_bnr.mode_records(pushes(0) + [4, 220], 3) == [
        {"ev": 3, "novel": False, "conf": "high"}]
    assert decode_bnr.mode_records(pushes(1) + [4, 221], 4) == [
        {"ev": 4, "ero": True, "conf": "high"}]
    assert decode_bnr.mode_records(pushes(30, 0, 0) + [4, 194], 5) == [
        {"ev": 5, "wait": 30, "conf": "high"}]


@pytest.mark.skipif(not os.path.isfile(SCRIPT_PAK),
                    reason="BYOA JP script.pak not present")
def test_corpus_bmp_samples_1002_1003_1007():
    import decode_bnr
    with open(SCRIPT_PAK, "rb") as f:
        data = f.read()
    rows = decode_bnr.decode_script(data, "1002")
    loads = [r["bmp"] for r in rows if "bmp" in r]
    assert {"id": 0, "file": "ギター.tga", "z": 14, "folder": "grp"} in loads
    assert any(r.get("bmpAlpha", {}).get("alpha") == 128 for r in rows)
    assert any(r.get("bmpRelease") == 0 for r in rows)
    rows = decode_bnr.decode_script(data, "1003")
    assert any("bmpScale" in r for r in rows)
    rows = decode_bnr.decode_script(data, "1007")
    assert any(r.get("bmp", {}).get("folder") == "bak" for r in rows)


def test_bmp_unary_operator_does_not_shift_arguments():
    # push -128; (6,23) negate -> 128; SetBmpParam [0,1,128,60].
    import decode_bnr
    body = ([5, 3, 0, 5, 3, 1, 5, 3, -128, 6, 23,
             5, 3, 60, 4, 185])
    rows = decode_bnr.bmp_records(body, None, 1)
    assert rows[0]["bmpAlpha"] == {"id": 0, "mode": 1, "alpha": 128,
                                   "frames": 60}


def test_dedupe_keeps_duplicate_waits():
    import decode_bnr
    rows = [{"ev": 1, "wait": 120, "conf": "high"}] * 3
    assert len(decode_bnr.dedupe_recs(rows)) == 3
    assert len(decode_bnr.dedupe_recs(
        [{"ev": 1, "bmp": {"id": 0, "file": "a.tga", "z": 1},
          "conf": "high"}] * 2)) == 1
