// Native-save corpus check (BYOA-gated; no game/user saves are committed).
//   WA2_NATIVE_SAVES=/path/to/saves WA2_DATA_DIR=/path/to/build/data npx vitest run native-save.corpus
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  findNativeCandidates,
  findNativePosition,
  nativeAnchorKey,
  nativeToSave,
  parseNativeFile,
  parseNativeSave,
} from "./native-save";
import { Router } from "./router";
import type { CfgData, FlowData, NativePosData, Scenario, TerminalsData } from "./types";

const SAVES = process.env.WA2_NATIVE_SAVES;
const DATA = process.env.WA2_DATA_DIR;

function scenarios(): Record<string, Scenario> {
  const dir = path.join(DATA!, "scripts");
  const out: Record<string, Scenario> = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Scenario;
    out[s.script] = s;
  }
  return out;
}

/** `.bnr` label anchors emitted by tools/build_native_pos.py; absent in packs
 * built before it existed (the importer then uses text matching only). */
function readNativePos(): NativePosData | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA!, "native-pos.json"), "utf8")) as NativePosData;
  } catch {
    return null;
  }
}

function readSave(name: string) {
  const buf = fs.readFileSync(path.join(SAVES!, name));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return parseNativeFile(ab as ArrayBuffer, name);
}

describe.runIf(SAVES && DATA)("native save corpus", () => {
  it("maps every slot save to a scenario line and decodes all 29 Global.vrb vars", () => {
    const sc = scenarios();
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA!, "cfg.json"), "utf8")) as CfgData;
    const flow = JSON.parse(fs.readFileSync(path.join(DATA!, "flow.json"), "utf8")) as FlowData;
    const terminals = JSON.parse(fs.readFileSync(path.join(DATA!, "terminals.json"), "utf8")) as TerminalsData;
    const router = new Router(Object.values(sc), flow, undefined, terminals, { cfg });
    const nativePos = readNativePos();

    let slots = 0;
    let systems = 0;
    const byName: Record<string, ReturnType<typeof nativeToSave>> = {};
    for (const f of fs.readdirSync(SAVES!)) {
      if (!f.toLowerCase().endsWith(".sav")) continue;
      const buf = fs.readFileSync(path.join(SAVES!, f));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const parsed = parseNativeFile(ab as ArrayBuffer, f);
      if (parsed.kind === "system") {
        systems++;
        continue;
      }
      expect(parsed.kind, f).toBe("slot");
      if (parsed.kind !== "slot") continue;
      // Every corpus file carries the exact PC v2 / VM 1.00 signature.
      expect(parsed.save.signature, `${f}: signature`).toBe("exact");
      expect(parsed.save.vmVersion, `${f}: VM version`).toBe("1.00");
      expect(parsed.save.layout, `${f}: layout`).toBe(4);
      expect([131, 209], `${f}: parse mode`).toContain(parsed.save.parseMode);
      expect(parsed.save.scriptPos, `${f}: ScriptPos`).toBeGreaterThan(0);
      expect(parsed.save.locals, `${f}: locals`).toHaveLength(52);
      expect(parsed.save.jumpCount, `${f}: jump count`).toBeLessThanOrEqual(15);
      expect(parsed.save.argCount, `${f}: arg count`).toBeLessThanOrEqual(256);
      expect(parsed.save.globalVars, `${f}: Global.vrb`).toHaveLength(29);
      const scenario = sc[parsed.save.script];
      expect(scenario, `${f}: missing script ${parsed.save.script}`).toBeTruthy();
      const pos = findNativePosition(parsed.save, scenario, nativePos);
      expect(pos, `${f}: no line/choice match`).not.toBeNull();
      byName[f] = nativeToSave(parsed.save, pos!, f, 1, 1, { router, nativePos });
      slots++;
    }
    expect(slots).toBe(11);
    expect(systems).toBeGreaterThan(0);

    for (const name of Object.keys(byName)) {
      const s = byName[name]!;
      expect(s.flags.g, name).toHaveLength(29);
      expect(s.flags.cfg?.script, name).toBe(s.position.script);
      // Exact-save metadata survives the import. Every corpus slot has a
      // unique ScriptPos-ranked text hit, so `exact` is the honest grade.
      expect(s.native?.scriptPos, name).toBeGreaterThan(0);
      expect(s.native?.anchor, name).toBe("exact");
    }

    // Frame 0 / stride 64 / float base 26 end-to-end: save_00 (IC 1007)
    // carries these VM locals, and 1007's CFG reads L[5,6,7,19].
    const s00 = byName["save_00.sav"]!;
    expect(s00.flags.cfg?.l.slice(5, 8)).toEqual([1, 1, 1]);
    expect(s00.flags.cfg?.l[19]).toBe(3200);
    expect(s00.flags.cfg?.l[49]).toBe(-960);

    const s18 = byName["save_18.sav"]!;
    expect(s18.flags.aff).toMatchObject({ s: 7, koharu: 3, chiaki: 1, mari: 1 });
    expect(s18.flags.g![12]).toBe(1);
    expect(s18.flags.g![13]).toBe(1);
    expect(s18.flags.g!.slice(14, 20)).toEqual([2, 1, 1, 2, 1, 2]);

    const s19 = byName["save_19.sav"]!;
    expect(s19.flags.aff).toMatchObject({ s: 3, koharu: 2, chiaki: 1, mari: 3 });
    expect(s19.flags.g![12]).toBe(1);
    expect(s19.flags.g!.slice(14, 20)).toEqual([2, 1, 2, 2, 2, 1]);
  });

  it("ranks the two 1007 line hits by ScriptPos and selects the IC anchors for route 2", (ctx) => {
    const nativePos = readNativePos();
    if (!nativePos) {
      console.warn(
        "[native-save.corpus] native-pos.json absent: skipping ScriptPos ranking assertions " +
        "(build with tools/build_native_pos.py to enable them)",
      );
      ctx.skip();
      return;
    }
    const sc = scenarios();
    const save00 = readSave("save_00.sav");
    expect(save00.kind).toBe("slot");
    if (save00.kind !== "slot") return;
    expect(save00.save.script).toBe("1007");
    expect(save00.save.route).toBe("2");
    // Route 2 is the IC variant: its own .bnr label table must exist.
    expect(nativePos.anchors["ic/1007"], "native-pos.json lacks ic/1007 anchors").toBeTruthy();
    expect(nativeAnchorKey(nativePos, "1007", save00.save.route)).toBe("ic/1007");

    const scenario = sc["1007"]!;
    const candidates = findNativeCandidates(save00.save, scenario, nativePos);
    expect(candidates.map((c) => c.event)).toEqual([1837, 1341]);
    expect(candidates[0]).toMatchObject({ confidence: "exact", anchor: "exact" });
    expect(findNativePosition(save00.save, scenario, nativePos)?.event).toBe(1837);

    // The main-script anchors still resolve the same two hits; only the
    // ranking key differs by route.
    expect(nativeAnchorKey(nativePos, "1007", "030")).toBe("1007");
    expect(nativePos.anchors["1007"]!.some(([, ev]) => ev === 1837)).toBe(true);
    expect(nativePos.anchors["1007"]!.some(([, ev]) => ev === 1341)).toBe(true);
  });

  it("rejects a save whose VM layout fields were altered", () => {
    const good = readSave("save_00.sav");
    expect(good.kind).toBe("slot");
    const buf = fs.readFileSync(path.join(SAVES!, "save_00.sav"));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const bytes = new Uint8Array(ab);
    const dv = new DataView(ab);
    // Layout signature 0x134d8 is the field the peer converter also refuses
    // to guess; the parser must fail closed instead of inventing a position.
    dv.setUint32(0x134d8, 9, true);
    expect(parseNativeSave(ab)).toBeNull();
    // Restoring the layout makes the same buffer parse again.
    dv.setUint32(0x134d8, 4, true);
    expect(parseNativeSave(ab)?.signature).toBe("exact");
    expect(bytes.length).toBe(0x54fd0);
  });
});

