// Native-save corpus check (BYOA-gated; no game/user saves are committed).
//   WA2_NATIVE_SAVES=/path/to/saves WA2_DATA_DIR=/path/to/build/data npx vitest run native-save.corpus
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { findNativePosition, nativeToSave, parseNativeFile } from "./native-save";
import { Router } from "./router";
import type { CfgData, FlowData, Scenario, TerminalsData } from "./types";

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

describe.runIf(SAVES && DATA)("native save corpus", () => {
  it("maps every slot save to a scenario line and decodes all 29 Global.vrb vars", () => {
    const sc = scenarios();
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA!, "cfg.json"), "utf8")) as CfgData;
    const flow = JSON.parse(fs.readFileSync(path.join(DATA!, "flow.json"), "utf8")) as FlowData;
    const terminals = JSON.parse(fs.readFileSync(path.join(DATA!, "terminals.json"), "utf8")) as TerminalsData;
    const router = new Router(Object.values(sc), flow, undefined, terminals, { cfg });

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
      expect(parsed.save.globalVars, `${f}: Global.vrb`).toHaveLength(29);
      const scenario = sc[parsed.save.script];
      expect(scenario, `${f}: missing script ${parsed.save.script}`).toBeTruthy();
      const pos = findNativePosition(parsed.save, scenario);
      expect(pos, `${f}: no line/choice match`).not.toBeNull();
      byName[f] = nativeToSave(parsed.save, pos!, f, 1, 1, { router });
      slots++;
    }
    expect(slots).toBe(11);
    expect(systems).toBeGreaterThan(0);

    for (const name of ["save_04.sav", "save_05.sav", "save_18.sav", "save_19.sav", "save_Q.sav"]) {
      const s = byName[name];
      expect(s, name).toBeTruthy();
      expect(s!.flags.g).toHaveLength(29);
      expect(s!.flags.cfg?.script).toBe(s!.position.script);
    }

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
});

