"""Alternative-translation build tests (synthetic data only).

Covers the manuscript-less tail-fragment rejoin (pure fold + anchor
scanning), the `--alt` spec parser, and the per-translation flow
derivation (base routing, alt option text/goto). A single optional
corpus test runs against the user's own TodokanaiTL paks when
`WA2_TD_EN_PAK` + `WA2_GAME` are set (skipped otherwise).
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import build as B  # noqa: E402
import build_ir as IR  # noqa: E402


class TestFoldFragments:
    def test_folds_direct_fragment(self):
        toks = ["hello", "wor", "ld"]
        warnings: list[str] = []
        out, folded, orphans = IR.fold_fragments(toks, {2: 1}, warnings)
        assert out[:2] == ["hello", "world"]
        assert out[2] == ""
        assert (folded, orphans) == (1, 0)
        assert warnings == []

    def test_folds_chain_in_reverse_order(self):
        # The line token is "The snow"; fragment 1 continues it and
        # fragment 2 continues fragment 1. The full line must come back
        # as one string (not "The snow" + a half-folded fragment).
        toks = ["The snow", " melts", " at dusk."]
        out, folded, _ = IR.fold_fragments(toks, {1: 0, 2: 1}, [])
        assert out[0] == "The snow melts at dusk."
        assert out[1] == out[2] == ""
        assert folded == 2

    def test_counts_unlabeled_orphans(self):
        toks = ["abcdefgh", "ij", "orphan"]
        warnings: list[str] = []
        out, folded, orphans = IR.fold_fragments(toks, {1: 0}, warnings)
        assert out[0] == "abcdefghij"
        assert orphans == 1
        assert "1 unlabeled tail fragments" in warnings[0]

    def test_shape_preserved(self):
        toks = ["a", "b", "c", "d"]
        out, _, _ = IR.fold_fragments(toks, {3: 2}, [])
        assert len(out) == len(toks)


class TestRejoinGuards:
    def test_none_bnr_is_passthrough(self):
        toks = ["a", "b"]
        out, folded, orphans = IR.rejoin_tail_fragments(toks, None, [])
        assert out is toks and folded == 0 and orphans == 0

    def test_empty_bnr_is_passthrough(self):
        toks = ["a", "b"]
        out, folded, _ = IR.rejoin_tail_fragments(toks, b"", [])
        assert out is toks and folded == 0


class TestParseAlt:
    def test_parses_id_and_paks(self):
        assert B.parse_alt("todokanai=/a/en.pak,/b/sc.pak") == (
            "todokanai", ["/a/en.pak", "/b/sc.pak"])
        assert B.parse_alt("td=/a/en.pak") == ("td", ["/a/en.pak"])

    def test_rejects_bad_specs(self):
        with pytest.raises(SystemExit):
            B.parse_alt("nopaks")
        with pytest.raises(SystemExit):
            B.parse_alt("bad id=/a/en.pak")
        with pytest.raises(SystemExit):
            B.parse_alt("id=/a/en.txt")


class TestAltFlowFromBase:
    @staticmethod
    def _write(tmp_path, flow, alt_events):
        ir_dir = tmp_path / "ir"
        ir_dir.mkdir()
        (ir_dir / "2003.json").write_text(json.dumps({"events": alt_events}))
        base = tmp_path / "flow.json"
        base.write_text(json.dumps(flow))
        out = tmp_path / "alt-flow.json"
        B.alt_flow_from_base(str(base), str(ir_dir), str(out))
        return json.loads(out.read_text())

    def test_swaps_text_and_goto_keeps_hand_fields(self, tmp_path):
        flow = {
            "version": 1,
            "nodes": [{
                "id": "2003-242",
                "engine": {"script": "2003", "event": 0},
                "options": [
                    {"n": 1, "text": "base one", "goto": None},
                    {"n": 2, "text": "base two", "goto": "2401"},
                ],
                "date": "12/1",
                "status": "EXPERT_SOURCED",
            }],
        }
        alt_events = [{"t": "choice", "options": [
            {"n": 1, "text": "alt one", "goto": None},
            {"n": 2, "text": "alt two", "goto": "2401"},
        ]}]
        out = self._write(tmp_path, flow, alt_events)
        node = out["nodes"][0]
        assert [o["text"] for o in node["options"]] == ["alt one", "alt two"]
        assert [o["goto"] for o in node["options"]] == [None, "2401"]
        assert node["date"] == "12/1"
        assert node["status"] == "EXPERT_SOURCED"

    def test_adopts_engine_goto_association(self, tmp_path):
        # The two nodes where the alt IR's association is the cfg-verified
        # one: opt1 carries the goto, the last option falls through.
        flow = {
            "version": 1,
            "nodes": [{
                "id": "2019-1484",
                "engine": {"script": "2003", "event": 0},
                "options": [
                    {"n": 1, "text": "base one", "goto": None},
                    {"n": 2, "text": "base two", "goto": "2401"},
                    {"n": 3, "text": "base three", "goto": "2501"},
                ],
                "date": "12/24 ROUTER",
                "status": "EXPERT_SOURCED",
            }],
        }
        alt_events = [{"t": "choice", "options": [
            {"n": 1, "text": "alt one", "goto": "2401"},
            {"n": 2, "text": "alt two", "goto": "2501"},
            {"n": 3, "text": "alt three", "goto": None},
        ]}]
        out = self._write(tmp_path, flow, alt_events)
        assert [o["goto"] for o in out["nodes"][0]["options"]] == [
            "2401", "2501", None]

    def test_keeps_base_node_when_alt_event_is_not_a_choice(self, tmp_path):
        flow = {
            "version": 1,
            "nodes": [{
                "id": "2003-242",
                "engine": {"script": "2003", "event": 0},
                "options": [{"n": 1, "text": "base one", "goto": None}],
                "date": "12/1",
            }],
        }
        out = self._write(tmp_path, flow, [{"t": "narrate", "text": "drift"}])
        assert out["nodes"][0]["options"][0]["text"] == "base one"


class TestFilterVoicemap:
    @staticmethod
    def _irs(tmp_path, base_events, alt_events):
        base, alt = tmp_path / "ir", tmp_path / "ir_alt"
        base.mkdir()
        alt.mkdir()
        (base / "2001.json").write_text(json.dumps({"events": [{}] * base_events}))
        (alt / "2001.json").write_text(json.dumps({"events": [{}] * alt_events}))
        (base / "1002.json").write_text(json.dumps({"events": [{}] * 3}))
        (alt / "1002.json").write_text(json.dumps({"events": [{}] * 3}))
        return str(base), str(alt)

    def test_drops_misaligned_scripts_only(self, tmp_path):
        base, alt = self._irs(tmp_path, 5, 4)
        vm = {"version": 2,
              "map": {"2001": {"1": "k"}, "1002": {"2": "k"}},
              "chars": {"2001": {"1": 3}, "1002": {"2": 4}}}
        out, dropped = B.filter_voicemap(vm, alt, base, ["2001", "1002"])
        assert dropped == ["2001"]
        assert "2001" not in out["map"] and "2001" not in out["chars"]
        assert out["map"]["1002"] == {"2": "k"}

    def test_missing_ir_keeps_script(self, tmp_path):
        base, alt = self._irs(tmp_path, 5, 5)
        os.unlink(os.path.join(alt, "1002.json"))
        vm = {"version": 2, "map": {"1002": {"2": "k"}}, "chars": {}}
        out, dropped = B.filter_voicemap(vm, alt, base, ["1002"])
        assert dropped == [] and out["map"]["1002"] == {"2": "k"}


class TestWriteTranslationsIndex:
    def test_publishes_default_then_alt_metadata(self, tmp_path):
        data_dir = tmp_path / "data"
        (data_dir / "translations").mkdir(parents=True)
        B.write_translations_index(str(data_dir), ["todokanai"])
        idx = json.loads((data_dir / "translations" / "index.json").read_text())
        ids = [t["id"] for t in idx["translations"]]
        assert ids[0] == "mao"  # catalog default always first
        assert "todokanai" in ids
        alt = next(t for t in idx["translations"] if t["id"] == "todokanai")
        assert alt["repo"].endswith("WA2EnglishPatch")
        assert "default" not in idx["translations"][0]


TD_EN = os.environ.get("WA2_TD_EN_PAK")
GAME = os.environ.get("WA2_GAME")


@pytest.mark.skipif(not (TD_EN and GAME), reason="set WA2_TD_EN_PAK + WA2_GAME")
def test_corpus_rejoin_2411(tmp_path):
    """One real script: previously truncated lines come back complete."""
    import subprocess
    jp_pak = os.path.join(GAME, "script.pak")
    out = tmp_path / "ir"
    subprocess.run([sys.executable, os.path.join(
        os.path.dirname(__file__), "..", "tools", "build_ir.py"),
        jp_pak, TD_EN, "", str(out)], check=True, capture_output=True)
    events = json.loads((out / "2411.json").read_text())["events"]
    texts = [e.get("text") or "" for e in events if e.get("t") in ("say", "narrate")]
    joined = [t for t in texts if "edge of collapsing" in t]
    assert joined, "2411 narrative line missing"
    assert "made an impression" in joined[0]
