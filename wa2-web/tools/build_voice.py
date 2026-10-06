"""Build per-line voice map from .bnr voice records (static, no game run).

Voice clips are addressed by the .bnr voice index NNN from (4,138)
records `[2,256,0,0,NNN]`. Proven anchor chain (static analysis + 100%
corpus verification, see docs/PARSING.md):

  (4,138)[slot,256,0,0,NNN] -> next (4,131) statement carrying (3,X)
  where X == the JP comma-token of the voiced line (41464/41464 exact
  across the corpus; the (3,X) values are JP script.pak coordinates even
  in the MAO en.pak builds, which rebuild .bnr but keep the anchors).

With --jp (JP script.pak) + --mao (MAO script-data clone) + --voice-dir
(installed VOICE.PAK / IC/VOICE.PAK), the tool resolves each anchor
exactly:

  NNN -> (3,X) -> JP say/narrate line (tok X, 100% exact)
      -> MAO line (jp-normalized text containment + ordinal gap fill)
      -> EN IR event (fetch_mao normalization containment, monotonic)
      -> voice file key from the LAC names (family-base chain for
         variant scripts: 2031_3's clips live under base 2031).

Output (version 2): {"version": 2, "map": {script: {ev: key}}} where key
is a voice-archive line key ("1008_0199" or "ic/1002_0000") — the exact
manifest key the runtime should play. Also emits speakers.json beside it
when --mao is given: {"version": 1, "speakers": {script: {ev: name}}}
mapping JP-speaker say events to the manuscript's speakerEn (works even
where the official patch leaves line text in Japanese). Fallbacks (each
degrades one hop, never guesses louder):

  - scripts whose JP txt is absent from script.pak (special-disc
    variants) keep the fractional statement-position assignment but get
    resolved keys (fixes their previously silent lookup);
  - without --voice-dir, values fall back to bare NNN numbers (runtime
    tok fallback semantics);
  - without --mao/--jp, v1 fractional numeric output entirely.

Usage: python3 build_voice.py MAIN_EN_PAK [SPECIAL_EN_PAK] OUT_JSON
       --ir IR_DIR [--jp SCRIPT_PAK] [--mao MAO_SCRIPT_DATA_DIR]
       [--voice-dir GAME_DIR]
"""

from __future__ import annotations

import json
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import kcap  # noqa: E402
import lzss  # noqa: E402
import parse_txt  # noqa: E402
from extract_assets import decode_lac_name  # noqa: E402
from proto_bgm import iter_statements, load_bnr, s32  # noqa: E402

# ---------------------------------------------------------------------------
# Proven anchor extraction
# ---------------------------------------------------------------------------


def voice_anchors(data: bytes, script: str) -> list[int]:
    """nnn for every (4,138) voice record, in statement order.

    Each record is followed (within 3 statements) by a (4,131) display
    statement carrying (3,X) — X is the JP comma-token of the voiced
    line (100% corpus-verified). Returns the NNN values; the caller
    resolves X separately so it can also handle no-JP scripts.
    """
    payload, _ = load_bnr(data, script)
    stmts = list(iter_statements(payload))
    out = []
    for idx, _off, pushes, ops, _raw, _fl in stmts:
        if any(o == 4 and a == 138 for o, a in ops) and len(pushes) >= 5:
            nnn = s32(pushes[4])
            for j in range(idx + 1, min(idx + 4, len(stmts))):
                _p2, ops2 = stmts[j][2], stmts[j][3]
                x3 = [a for o, a in ops2 if o == 3]
                if (4, 131) in ops2 and x3:
                    out.append(nnn)
                    break
    return out


def anchor_toks(data: bytes, script: str) -> list[int]:
    """The (3,X) JP token of each (4,138) voice record (same order)."""
    payload, _ = load_bnr(data, script)
    stmts = list(iter_statements(payload))
    out = []
    for idx, _off, pushes, ops, _raw, _fl in stmts:
        if any(o == 4 and a == 138 for o, a in ops) and len(pushes) >= 5:
            for j in range(idx + 1, min(idx + 4, len(stmts))):
                _p2, ops2 = stmts[j][2], stmts[j][3]
                x3 = [a for o, a in ops2 if o == 3]
                if (4, 131) in ops2 and x3:
                    out.append(x3[0])
                    break
            else:
                out.append(None)
    return out


# ---------------------------------------------------------------------------
# Legacy fractional assignment (fallback; pure; test-pinned)
# ---------------------------------------------------------------------------


def voice_records_legacy(data: bytes, script: str, jp_data: bytes | None = None):
    """(stmt_idx, n_stmts, nnn, is_dialog) for every (4,138) record."""
    payload, _ = load_bnr(data, script)
    stmts = list(iter_statements(payload))
    n = len(stmts)
    jt = None
    if jp_data is not None:
        try:
            jt = jp_tokens(jp_data, script)
        except KeyError:
            jt = None
    out = []
    for idx, _off, pushes, ops, _raw, _fl in stmts:
        if any(o == 4 and a == 138 for o, a in ops) and len(pushes) >= 5:
            is_dialog = None
            if jt is not None:
                xs = []
                for j in range(max(0, idx - 8), min(n, idx + 9)):
                    xs += [a for o, a in stmts[j][3] if o == 3]
                is_dialog = any(
                    0 <= x < len(jt) and jt[x].strip().startswith(('"', "「"))
                    for x in xs)
            out.append((idx, n, s32(pushes[4]), is_dialog))
    return out


def jp_tokens(jp_data: bytes, script: str) -> list[str]:
    for e in kcap.read_index(jp_data):
        if not e.is_folder and e.name == script + ".txt":
            s, e2 = kcap.data_range(e)
            blob = jp_data[s:e2]
            if e.is_compressed:
                orig, lz = lzss.split_datahdr(blob)
                blob = lzss.decompress(lz, orig)
            return parse_txt.split_tokens(blob)
    raise KeyError(script + ".txt")


def assign_nnn(fracs: list[tuple[float, int, bool | None]],
               voiced: list[tuple[int, str]], m: int) -> dict[int, int]:
    """Monotonic greedy: records in statement order take the nearest
    still-unassigned voiced event. Kind affinity first: a dialogue-shaped
    record prefers say events (narration-shaped prefers narrate) with a
    2%-of-file distance penalty for mismatches, so voiced thoughts still
    map when nothing else is near. Pure; tested."""
    penalty = max(1, m // 50)
    used: set[int] = set()
    rows: dict[int, int] = {}
    for frac, nnn, is_dialog in fracs:
        target = frac * m
        want = "say" if is_dialog else ("narrate" if is_dialog is False else None)
        best: int | None = None
        best_key = None
        for ev, kind in voiced:
            if ev in used:
                continue
            key = (abs(ev - target) + (0 if want is None or kind == want else penalty), ev)
            if best_key is None or key < best_key:
                best_key = key
                best = ev
        # monotonicity: never assign behind the previous assignment
        if best is None:
            continue
        if rows:
            prev_max = max(rows)
            if best < prev_max:
                later = [ev for ev, _k in voiced
                         if ev not in used and ev >= prev_max]
                if not later:
                    continue
                best = min(later, key=lambda ev: (abs(ev - target), ev))
        used.add(best)
        rows[best] = nnn
    return rows


# ---------------------------------------------------------------------------
# Exact chain: JP line -> MAO line -> EN event
# ---------------------------------------------------------------------------

_JP_KEEP = re.compile(r"[^\u4e00-\u9fff\u3041-\u3096\u30a1-\u30fa"
                      r"\u30fc-\u30fc\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]+")
_RUBY = re.compile(r"<R([^<>|]+)\|[^<>]*>")
_JP = re.compile(r"[\u3040-\u30ff\u4e00-\u9fff]")


def jp_norm(s: str) -> str:
    """Ruby-aware JP normalization: keep kana/kanji/full-width alnum only.

    Engine JP lines carry <R surface|reading> ruby; the manuscript (MAO
    japanese) keeps the surface only, so readings must be dropped before
    containment comparison.
    """
    return _JP_KEEP.sub("", _RUBY.sub(r"\1", s or ""))


def _norm_en(s: str) -> str:
    from fetch_mao import norm  # deferred: keeps import optional
    return norm(s or "")


def match_jp_to_mao(jp_texts: list[str], mao_jp: list[str],
                    window: int = 40) -> dict[int, int]:
    """Map JP line ordinal -> MAO line ordinal by normalized containment.

    Monotonic windowed matcher (JP fragment contained in the manuscript
    row or vice versa), then linear gap-fill between matched pairs whose
    ordinal deltas agree (handles engine ellipsis rows and merged/split
    manuscript rows). Pure; tested.
    """
    o2j: dict[int, int] = {}
    cur = 0
    for o, text in enumerate(jp_texts):
        nj = jp_norm(text)
        if not nj:
            continue
        hit = None
        for j in range(cur, min(cur + window, len(mao_jp))):
            if nj in mao_jp[j]:
                hit = j
                break
            mj = mao_jp[j]
            if mj and mj in nj and len(mj) >= 6:
                hit = j
                break
        if hit is not None:
            o2j[o] = hit
            cur = hit
    _fill_runs(o2j, len(jp_texts), len(mao_jp))
    return o2j


def _fill_runs(o2j: dict[int, int], n_jp: int, n_mao: int) -> None:
    """Linear gap-fill: unmatched ordinals inside runs whose JP/MAO delta
    is constant (== 1) interpolate; boundary runs extrapolate inward."""
    ks = sorted(o2j)
    if not ks:
        return
    # boundary extrapolation with unit delta, bounded (JP ordinals and
    # MAO lines usually start/end in lockstep, but drift is real)
    first, last = ks[0], ks[-1]
    for _ in range(24):
        if first > 0 and o2j[first] > 0 and first - 1 not in o2j:
            o2j[first - 1] = o2j[first] - 1
            first -= 1
        else:
            break
    for _ in range(24):
        if last < n_jp - 1 and o2j[last] < n_mao - 1 and last + 1 not in o2j:
            o2j[last + 1] = o2j[last] + 1
            last += 1
        else:
            break
    # interior interpolation: runs whose ordinal deltas agree
    for a, b in zip(ks, ks[1:]):
        if b - a == o2j[b] - o2j[a] and b - a <= 12:
            for k in range(a + 1, b):
                o2j[k] = o2j[a] + (k - a)


def match_mao_to_en(mao_en: list[str], mao_jp: list[str],
                    events: list[tuple[str, str]]) -> tuple[dict[int, int], dict[int, int]]:
    """Map MAO line ordinal -> first EN IR event index claiming it, and
    event ordinal -> claimed MAO line (for speaker overrides).

    Event-driven monotonic matcher: an event claims the first MAO line
    (within a forward window) whose manuscript matches it — by English
    containment (fetch_mao normalization) or, for untranslated JP-text
    events, by JP containment against the manuscript Japanese. Pure;
    tested."""
    j2e: dict[int, int] = {}
    e2j: dict[int, int] = {}
    cur = 0
    for i, (ne, nj) in enumerate(events):
        for j in range(cur, min(cur + 40, len(mao_en))):
            if (ne and ne in mao_en[j]) or (nj and nj in mao_jp[j]):
                if j not in j2e:
                    j2e[j] = i
                e2j[i] = j
                cur = j
                break
    return j2e, e2j


# ---------------------------------------------------------------------------
# Voice archive line keys (LAC names)
# ---------------------------------------------------------------------------


def voice_keys_from_pak(pak_path: str) -> set[str]:
    """Set of `{base}_{line:04d}` keys present in a voice LAC."""
    with open(pak_path, "rb") as f:
        data = f.read()
    if data[:4] != b"LAC\x00":
        return set()
    (count,) = struct.unpack_from("<I", data, 4)
    out = set()
    for i in range(count):
        m = re.match(r"^(.+)_[0-9]+\.[A-Za-z0-9]+$",
                     decode_lac_name(data[8 + i * 40:8 + i * 40 + 24]))
        if m:
            out.add(m.group(1))
    return out


def resolve_voice_key(sc: str, nnn: int,
                      main_keys: set[str], ic_keys: set[str]) -> str | None:
    """Resolve the archive key for script `sc` voice NNN.

    Variant scripts share the family voice pool (2031_3 -> base 2031),
    so the base is found by stripping the last _NN suffix repeatedly.
    Main-game keys win over IC keys; IC keys are emitted ic/-prefixed to
    match the asset manifest. Pure; tested.
    """
    b = sc
    while True:
        k = f"{b}_{nnn:04d}"
        if k in main_keys:
            return k
        if k in ic_keys:
            return f"ic/{k}"
        if "_" not in b:
            return None
        b = b.rsplit("_", 1)[0]


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def load_mao_index(mao_dir: str) -> dict[str, str]:
    idx = json.load(open(os.path.join(mao_dir, "index.json"), encoding="utf-8"))
    out = {}
    for r in idx["routes"]:
        for s in r["scripts"]:
            out[s["id"]] = os.path.join(mao_dir, s["file"])
    return out


def main() -> None:
    argv = sys.argv[1:]
    ir_dir = jp_path = mao_dir = voice_dir = None
    i = 0
    while i < len(argv):
        if argv[i] == "--ir":
            ir_dir = argv[i + 1]
            del argv[i:i + 2]
        elif argv[i] == "--jp":
            jp_path = argv[i + 1]
            del argv[i:i + 2]
        elif argv[i] == "--mao":
            mao_dir = argv[i + 1]
            del argv[i:i + 2]
        elif argv[i] == "--voice-dir":
            voice_dir = argv[i + 1]
            del argv[i:i + 2]
        else:
            i += 1
    *paks, out_path = argv
    if ir_dir is None:
        print("need --ir IR_DIR")
        sys.exit(2)
    jp_data = open(jp_path, "rb").read() if jp_path else None

    src: dict[str, bytes] = {}
    for pak_path in paks:
        with open(pak_path, "rb") as f:
            data = f.read()
        for e in kcap.read_index(data):
            if e.is_folder or not e.name.endswith(".bnr"):
                continue
            src[e.name[:-4]] = data

    main_keys: set[str] = set()
    ic_keys: set[str] = set()
    if voice_dir:
        for sub, keys in (("", main_keys), ("IC", ic_keys)):
            p = os.path.join(voice_dir, sub, "VOICE.PAK") if sub else \
                os.path.join(voice_dir, "VOICE.PAK")
            if os.path.isfile(p):
                keys |= voice_keys_from_pak(p)
        print(f"voice keys: {len(main_keys)} main + {len(ic_keys)} ic")
    else:
        print("voice: no --voice-dir; emitting bare NNN values")

    mao_files: dict[str, str] = {}
    if mao_dir and os.path.isdir(mao_dir):
        try:
            mao_files = load_mao_index(mao_dir)
            print(f"mao: {len(mao_files)} scripts from {mao_dir}")
        except (OSError, KeyError, ValueError):
            print("mao: unreadable index; falling back to fractional maps")

    vmap: dict[str, dict[str, object]] = {}
    smap: dict[str, dict[str, str]] = {}
    n_exact = n_frac = n_rec = n_spk = 0
    for script in sorted(src):
        fn = os.path.join(ir_dir, script + ".json")
        if not os.path.isfile(fn):
            continue
        ir = json.load(open(fn, encoding="utf-8"))
        if not isinstance(ir, dict):
            continue
        events = ir.get("events", [])
        voiced = [(i, e.get("t")) for i, e in enumerate(events)
                  if isinstance(e, dict) and e.get("t") in ("say", "narrate")]
        try:
            recs = voice_records_legacy(src[script], script, jp_data)
        except KeyError:
            continue
        if not recs:
            continue
        n_rec += len(recs)
        rows: dict[str, object] = {}

        # ---- exact chain (JP txt + MAO + voice keys) ----
        atoks = anchor_toks(src[script], script)
        jtok2ord: dict[int, int] = {}
        if jp_data is not None:
            try:
                jev = [e for e in _jp_events(jp_data, script)
                       if e.get("t") in ("say", "narrate")]
                for o, e in enumerate(jev):
                    jtok2ord.setdefault(e.get("tok"), o)
            except KeyError:
                jev = []
        else:
            jev = []
        mao = None
        if script in mao_files:
            try:
                mao = json.load(open(mao_files[script], encoding="utf-8"))
            except OSError:
                mao = None
        placed_frac: dict[int, int] | None = None
        if mao:
            mao_lines = mao["lines"]
            ev_pairs = [(_norm_en(events[i].get("text") or ""),
                         jp_norm(events[i].get("text") or ""))
                        for i, _t in voiced]
            m2e: dict[int, int] = {}
            e2m: dict[int, int] = {}
            if (main_keys or ic_keys) and jev:
                # exact voice chain needs JP txt + voice keys
                j2m = match_jp_to_mao(
                    [e.get("text") or "" for e in jev],
                    [jp_norm(l.get("japanese") or "") for l in mao_lines])
                m2e, e2m = match_mao_to_en(
                    [_norm_en(l.get("english") or "") for l in mao_lines],
                    [jp_norm(l.get("japanese") or "") for l in mao_lines],
                    ev_pairs)
                chained = 0
                for (_idx, _n, nnn, _d), X in zip(recs, atoks):
                    if X is None:
                        continue
                    o = jtok2ord.get(X)
                    jj = j2m.get(o) if o is not None else None
                    ev = m2e.get(jj) if jj is not None else None
                    if ev is None:
                        continue
                    ev = voiced[ev][0]  # voiced position -> event index
                    key = resolve_voice_key(script, nnn, main_keys, ic_keys)
                    if key is None:
                        continue
                    if str(ev) not in rows:
                        rows[str(ev)] = key
                        chained += 1
                n_exact += chained
                if chained:
                    vmap[script] = rows
            else:
                # no voice chain (no JP txt / no keys); voice fallbacks
                # below still run
                pass
            # speaker overrides by NAME: MAO lines carry (speakerJa,
            # speakerEn) pairs; a JP name maps to the manuscript's EN
            # name via majority vote (script-scoped, no text matching —
            # a wrong displayed name is worse than a JP one)
            votes: dict[str, dict[str, int]] = {}
            for l in mao_lines:
                ja, en = l.get("speakerJa"), l.get("speakerEn")
                if ja and en and en != ja:
                    votes.setdefault(ja, {})
                    votes[ja][en] = votes[ja].get(en, 0) + 1
            name_map = {}
            for ja, tally in votes.items():
                en, n = max(tally.items(), key=lambda kv: kv[1])
                total = sum(tally.values())
                if n >= 3 and n >= 0.9 * total:
                    name_map[ja] = en
            for i, _t in voiced:
                sp = events[i].get("speaker")
                if isinstance(sp, str) and sp in name_map:
                    smap.setdefault(script, {})[str(i)] = name_map[sp]
                    n_spk += 1
            if vmap.get(script):
                continue
        # ---- fallbacks ----
        m = len(events)
        fracs = [(idx / max(1, n), nnn, is_dialog)
                 for idx, n, nnn, is_dialog in recs]
        if placed_frac is None:
            placed_frac = assign_nnn(fracs, voiced, m)
        for ev, nnn in placed_frac.items():
            if main_keys or ic_keys:
                key = resolve_voice_key(script, nnn, main_keys, ic_keys)
                if key is not None:
                    rows[str(ev)] = key
                    n_frac += 1
                    continue
            rows[str(ev)] = nnn
            n_frac += 1
        if rows:
            vmap[script] = rows

    out_dir = os.path.dirname(os.path.abspath(out_path))
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"version": 2, "map": vmap}, f)
    sp_path = os.path.join(out_dir, "speakers.json")
    with open(sp_path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "speakers": smap}, f)
    print(f"voice: {len(vmap)} scripts, {n_exact} exact + {n_frac} fractional "
          f"of {n_rec} records -> {out_path}")
    print(f"speakers: {len(smap)} scripts, {n_spk} overrides -> {sp_path}")


def _jp_events(jp_data: bytes, script: str) -> list[dict]:
    for e in kcap.read_index(jp_data):
        if not e.is_folder and e.name == script + ".txt":
            s, e2 = kcap.data_range(e)
            blob = jp_data[s:e2]
            if e.is_compressed:
                orig, lz = lzss.split_datahdr(blob)
                blob = lzss.decompress(lz, orig)
            return parse_txt.parse_tokens(parse_txt.split_tokens(blob))[0]
    raise KeyError(script + ".txt")


if __name__ == "__main__":
    main()