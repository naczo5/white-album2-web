// Sys.sav corpus check (BYOA-gated; no game/user saves are committed).
//   WA2_SYS_SAVES=/path/to/saves WA2_DATA_DIR=/path/to/build/data npx vitest run sys-save.corpus
//
// `WA2_DATA_DIR` must be the built data directory (`build/data`, i.e. what
// `tools/build.py` emits and what is copied into `web/public/data/`), not the
// hand-authored `data/` sources: the corpus needs `sys-slots.json` (the slot
// table written by `tools/build_sys_table.py`) alongside `flow.json` and the
// per-script JSON under `scripts/`.
//
// Pins the decode against the 2026-11-13 sample from the English-patched PC
// build: 103 read scripts, >30k read lines, four high-confidence endings and
// the gallery/music bands, while the system-reserved slot 99 stays unset.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Router } from "./router";
import { SYS_SIZE, buildSysProfile, countGalleryRows, parseSysSave } from "./sys-save";
import type { FlowData, Scenario, SysSlotsTable } from "./types";

const SAVES = process.env.WA2_SYS_SAVES;
const DATA = process.env.WA2_DATA_DIR;

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function scenarios(): Scenario[] {
  const dir = path.join(DATA!, "scripts");
  const out: Scenario[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    out.push(readJson<Scenario>(path.join(dir, f)));
  }
  return out;
}

describe.runIf(SAVES && DATA)("Sys.sav corpus", () => {
  it("decodes the sample into a global profile", () => {
    const file = path.join(SAVES!, "Sys.sav");
    expect(fs.existsSync(file), file).toBe(true);
    const raw = fs.readFileSync(file);
    expect(raw.byteLength).toBe(SYS_SIZE);
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;

    const table = readJson<SysSlotsTable>(path.join(DATA!, "sys-slots.json"));
    const flow = readJson<FlowData>(path.join(DATA!, "flow.json"));
    const router = new Router(scenarios(), flow);

    const sys = parseSysSave(ab, table);
    expect(sys).not.toBeNull();
    const { profile, readKeys } = buildSysProfile(sys!, table, router, flow, "Sys.sav");

    // Region A: 103 slots carry bits, minus the two image-only `catch*`
    // helper scripts that ship no scenario of their own (slot 0 is dropped).
    expect(profile.visited.length).toBe(101);
    expect(profile.visited).toContain("1002");
    expect(profile.visited).toContain("2023");
    expect(profile.visited).not.toContain("1001"); // slot 0 bucket, excluded
    expect(readKeys.length).toBeGreaterThan(30000);
    expect(readKeys.every((k) => /^\d{4}(?:_\d+)*:\d+$/.test(k))).toBe(true);
    expect(new Set(readKeys).size).toBe(readKeys.length);

    // Region C endings: only the `high` confidence slots of this save.
    // `ic-end` (slot 1, hypothesis) and `coda-setsuna-true` (slot 99,
    // reserved and force-zeroed by the engine) must never appear.
    expect(profile.endings.sort()).toEqual(
      ["cc-chiaki-normal", "cc-chiaki-true", "cc-koharu", "cc-setsuna"],
    );
    expect(profile.endings).not.toContain("coda-setsuna-true");
    expect(profile.endings).not.toContain("ic-end");

    // Choice bitmasks live in the 900+ band and map onto real flow nodes.
    const pickIds = Object.keys(profile.seenPicks);
    expect(pickIds.length).toBeGreaterThan(0);
    for (const id of pickIds) {
      const node = flow.nodes.find((n) => n.id === id);
      expect(node, id).toBeTruthy();
      expect(profile.seenPicks[id]!.length).toBeGreaterThan(0);
      for (const n of profile.seenPicks[id]!) {
        expect(node!.options.some((o) => o.n === n), `${id} option ${n}`).toBe(true);
      }
    }
    // 2019 holds two choice nodes; the sample's 7-bit mask = options 1..3.
    expect(profile.seenPicks["2019-1484"]).toEqual([1, 2, 3]);

    // Region B gallery: 142 unlocked CG bytes over the 168 thumbnail rows.
    expect(profile.cg.length).toBe(142);
    const gallery = countGalleryRows(new Set(profile.cg), table.cgRows);
    expect(gallery.total).toBe(168);
    expect(gallery.unlocked).toBe(81);
    expect(profile.cg).toContain(100100);

    // Music 101..199 -> 46 tracks in this save; movies 201..224 + slot 80.
    expect(profile.music.length).toBe(46);
    expect(profile.music).toContain(1);
    expect(profile.movies.length).toBeGreaterThan(0);
    expect(profile.movies).toContain(1); // mv01
    expect(profile.ero.length).toBeGreaterThan(0);
    // Gate flags from the sample: replay + cc-setsuna cleared.
    expect(profile.gates["replay"]).toBeGreaterThan(0);
    expect(profile.gates["setsunaCc"]).toBeGreaterThan(0);
  });

  it("rejects a truncated copy of the same save", () => {
    const raw = fs.readFileSync(path.join(SAVES!, "Sys.sav"));
    const table = readJson<SysSlotsTable>(path.join(DATA!, "sys-slots.json"));
    const short = raw.buffer.slice(raw.byteOffset, raw.byteOffset + 0x1000) as ArrayBuffer;
    expect(parseSysSave(short, table)).toBeNull();
  });
});
