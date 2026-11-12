// Native-save corpus check (BYOA-gated; no game/user saves are committed).
//   WA2_NATIVE_SAVES=/path/to/saves WA2_DATA_DIR=/path/to/build/data npx vitest run native-save.corpus
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { findNativePosition, parseNativeFile } from "./native-save";
import type { Scenario } from "./types";

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
  it("maps every slot save to a scenario line", () => {
    const sc = scenarios();
    let slots = 0;
    let systems = 0;
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
      const scenario = sc[parsed.save.script];
      expect(scenario, `${f}: missing script ${parsed.save.script}`).toBeTruthy();
      const pos = findNativePosition(parsed.save, scenario);
      expect(pos, `${f}: no line/choice match`).not.toBeNull();
      slots++;
    }
    expect(slots).toBeGreaterThan(0);
    expect(systems).toBeGreaterThan(0);
  });
});
