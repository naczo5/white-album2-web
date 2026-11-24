// Script router: engine event flow + flag model + choice routing.
//
// Flow model (derived from en.pak evidence, see docs/FLOW_GRAPH.md):
//  - Events play in order; `latch` events only set the speaker context.
//  - `say`/`narrate` advance one step. Directives (image/bgm/movie/anim)
//    update stage state and advance.
//  - `choice`: the UI presents options; the pick is recorded (flags via
//    flow.json `effects`), then:
//      * option `play` (flow.json, deliberate override, build-gated by
//        check_flow.py) or engine `goto` (bare-id destination) jumps files;
//      * `END:<id>` records an ending and continues past the choice;
//      * otherwise play continues at the next event (shared continuation).
//  - `jump` events (bare preload hints, CATCH* voice/sync markers) NEVER
//    move flow. The single choice-adjacent case (2019 work/stay opt2 ->
//    2301) resolves in pick() via flow.json `goto`/`play`; cross-line
//    transitions (1013 -> 2001, 2033 -> 3001, 3023 -> 3201/3101) resolve at
//    end-of-script via terminals (conditional `branches` when the bytecode
//    gates the hop).
//  - End of script -> terminals (end/chain) or spine next (numeric order,
//    split chunks chained by CHUNK_CHAINS) or END. cfg.json is authoritative
//    whenever the pack ships it; the spine is the BYOA fallback.

import {
  type CfgChoiceOptionState,
  type CfgExecOptions,
  choiceOptionsAt,
  getGameFlag,
  pickCfg,
  seekCfg,
  stepCfg,
} from "./cfg-vm";
import type {
  CfgData,
  FlowData,
  FlowNode,
  Flags,
  LinksData,
  Position,
  Scenario,
  ScenarioEvent,
  TerminalRecord,
  TerminalsData,
} from "./types";

export interface Spine {
  order: string[];
  next: Record<string, string | null>;
  chapterOf: Record<string, string>;
}

/** Sequential continuation chunks: split scene files, NOT alternates.
 *
 * `cfg.json` proves the engine ends each of these with an unconditional
 * `SLoad` to the next id (`1008`: `... -> SLoad 1008_020`, `1008_020`:
 * `... -> SLoad 1008_030`, `1012_030` -> `1013`), so the cfg-less fallback
 * must step through them in order. Files that are `SCall` targets instead of
 * spine steps (`3014_2`, `3014_3`, `1012_030_2`) are deliberately absent.
 *
 * Replay/first-run extras are gated INSIDE those files by `if GFlag[1]/[0]`
 * branches (e.g. `1008_020` plays `0..33` only on a replay); the fallback
 * plays every event of a chunk because it has no cfg to skip with. */
export const CHUNK_CHAINS: readonly (readonly string[])[] = [
  ["1008", "1008_020", "1008_030", "1008_040", "1008_050"],
  ["1009", "1009_020", "1009_030"],
  ["1010", "1010_020", "1010_030", "1010_040", "1010_050", "1010_060", "1010_070"],
  ["1011", "1011_020", "1011_030"],
  ["1012", "1012_020", "1012_030"],
];

export function buildSpine(scripts: string[]): Spine {
  const order = [...scripts].sort();
  const next: Record<string, string | null> = {};
  const chapterOf: Record<string, string> = {};
  for (const s of order) chapterOf[s] = chapterOfScript(s);
  // Base files link to the next BASE file in the same chapter.
  const bases = order.filter((s) => !s.includes("_"));
  for (let i = 0; i < bases.length; i++) {
    const cur = bases[i];
    const nxt = bases[i + 1] ?? null;
    next[cur] = nxt && chapterOfScript(nxt) === chapterOfScript(cur) ? nxt : null;
  }
  // Chapter split files chain in numeric order; the last chunk inherits the
  // base's "next chapter file" link (1008_050 -> 1009). Only files present in
  // this pack participate, so a partial BYOA pack cannot self-link.
  const known = new Set(order);
  const chained = new Set(CHUNK_CHAINS.flat());
  for (const chain of CHUNK_CHAINS) {
    const present = chain.filter((id) => known.has(id));
    if (present.length < 2) continue;
    const baseNext = next[present[0]!] ?? null;
    for (let i = 0; i < present.length - 1; i++) next[present[i]!] = present[i + 1]!;
    next[present[present.length - 1]!] = baseNext;
  }
  for (const s of chained) {
    if (known.has(s) && !(s in next)) next[s] = null;
  }
  // Other suffixed files (SCall-only subroutine entries) follow their base.
  for (const s of order) {
    if (!s.includes("_") || s in next || chained.has(s)) continue;
    next[s] = next[s.split("_")[0]!] ?? null;
  }
  return { order, next, chapterOf };
}

export function chapterOfScript(script: string): string {
  const base = Number(script.split("_")[0]);
  if (base >= 1001 && base <= 1013) return "intro";
  if (base >= 2001 && base <= 2517) return "closing";
  if (base >= 3001 && base <= 3999) return "coda";
  return "special"; // 4000+ incl. the 5000-5104 digital novels (not the Coda)
}

/** Special-contents scenarios offered as individual "Extra scenario" entries.
 * 5000-5004 / 5100-5104 are the Kazusa / Setsuna novels (PDF links instead). */
export function isExtraScenario(id: string): boolean {
  return /^(4|5[234]|6|7)/.test(id) && !/^(500[0-4]|510[0-4])$/.test(id);
}

/** Resolve a chain terminal to its destination file.
 *
 * Conditional terminals mirror the bytecode's `if` on the way out of a file
 * (`3023`: `G[27]==1 -> 3201`, else `3101`). Branches are evaluated in
 * order; the first match wins; `to` is the unconditional fallback. */
export function resolveTerminalChain(
  term: TerminalRecord,
  flags: Flags,
  profileGameFlags?: Record<string, number>,
): string | null {
  if (term.action !== "chain") return null;
  for (const br of term.branches ?? []) {
    let value = 0;
    if (typeof br.g === "number") value = flags.g?.[br.g] ?? 0;
    else if (typeof br.gflag === "number") {
      value = getGameFlag(br.gflag, flags.gflags, profileGameFlags);
    }
    if (value === br.eq) return br.to;
  }
  return term.to ?? null;
}

export interface StepResult {
  pos: Position;
  ended: boolean;
  ending?: string;
  unlockedEndings?: string[];
}

export interface PickResult {
  next: Position;
  node: FlowNode | null;
  ended?: boolean;
  ending?: string;
  unlockedEndings?: string[];
}

export interface RouterOptions {
  cfg?: CfgData | null;
  profileGameFlags?: Record<string, number>;
  endingSlots?: Record<string, string>;
  replay?: number;
  unlockAllChoices?: boolean;
  onGameFlag?: (id: number, val: number) => void;
}

export class Router {
  scripts = new Map<string, Scenario>();
  flow = new Map<string, FlowNode>(); // key: `${script}:${event}`
  terminals: TerminalsData["terminals"] = {};
  spine: Spine;
  cfg: CfgData | null = null;
  profileGameFlags?: Record<string, number>;
  endingSlots?: Record<string, string>;
  replay?: number;
  unlockAllChoices = false;
  onGameFlag?: (id: number, val: number) => void;

  constructor(
    scenarios: Scenario[],
    flowData: FlowData,
    _linksData?: LinksData,
    terminalsData?: TerminalsData,
    options?: RouterOptions,
  ) {
    for (const s of scenarios) this.scripts.set(s.script, s);
    for (const n of flowData.nodes) {
      this.flow.set(`${n.engine.script}:${n.engine.event}`, n);
    }
    // links.json (HINT/SWITCH/DEAD preload map) is informational in v1:
    // jumps never move flow, so the router does not consult it. It feeds
    // QA reports and future flowchart conditional-branch display.
    this.terminals = terminalsData?.terminals ?? {};
    this.spine = buildSpine([...this.scripts.keys()]);
    this.cfg = options?.cfg ?? null;
    this.profileGameFlags = options?.profileGameFlags;
    this.endingSlots = options?.endingSlots;
    this.replay = options?.replay;
    this.unlockAllChoices = options?.unlockAllChoices ?? false;
    this.onGameFlag = options?.onGameFlag;
  }

  setProfileGameFlags(flags?: Record<string, number>): void {
    this.profileGameFlags = flags;
  }

  setUnlockAllChoices(unlock: boolean): void {
    this.unlockAllChoices = unlock;
  }

  setOnGameFlag(cb?: (id: number, val: number) => void): void {
    this.onGameFlag = cb;
  }

  setReplay(replay?: number): void {
    this.replay = replay;
  }

  private cfgExecOpts(picks?: Record<string, number>, preserveG?: boolean): CfgExecOptions {
    return {
      profileGameFlags: this.profileGameFlags,
      endingSlots: this.endingSlots,
      terminals: this.terminals,
      replay: this.replay,
      unlockAll: this.unlockAllChoices,
      onGameFlag: this.onGameFlag,
      picks,
      preserveG,
    };
  }

  private hasCfg(script: string): boolean {
    const entries = this.cfg?.scripts[script];
    return Boolean(entries && Object.keys(entries).length > 0);
  }

  at(pos: Position): ScenarioEvent | null {
    const sc = this.scripts.get(pos.script);
    if (!sc || pos.event < 0 || pos.event >= sc.events.length) return null;
    return sc.events[pos.event];
  }

  /** Synchronize CFG VM runtime state (`flags.cfg`) to a loaded/jumped position. */
  seek(pos: Position, flags: Flags, picks?: Record<string, number>): Position {
    if (this.cfg && this.hasCfg(pos.script)) {
      return seekCfg(this.cfg, pos, flags, this.cfgExecOpts(picks));
    }
    if (flags.cfg) delete flags.cfg;
    return pos;
  }

  /** Choice option visibility & lock states (SetSelectMess flag gating). */
  choiceOptions(pos: Position, flags: Flags): CfgChoiceOptionState[] {
    if (this.cfg && this.hasCfg(pos.script)) {
      const res = choiceOptionsAt(this.cfg, pos, flags, this.cfgExecOpts());
      if (res.length > 0) return res;
    }
    const ev = this.at(pos);
    if (!ev || ev.t !== "choice") return [];
    return ev.options.map((o) => ({
      n: o.n,
      unlocked: true,
      visible: true,
      rawUnlocked: true,
    }));
  }

  /** Advance one event; returns new position (same pos if choice blocks). */
  advance(pos: Position, flags: Flags): StepResult {
    if (this.cfg && this.hasCfg(pos.script)) {
      return stepCfg(this.cfg, pos, flags, this.cfgExecOpts());
    }
    const ev = this.at(pos);
    if (!ev) return this.spineAdvance(pos, flags);
    if (ev.t === "choice") return { pos, ended: false }; // UI must pick
    // jumps never move flow (see header): step over.
    return { pos: { script: pos.script, event: pos.event + 1 }, ended: false };
  }

  private spineAdvance(pos: Position, flags: Flags): StepResult {
    const term = this.terminals[pos.script];
    if (term) {
      if (term.action === "end") {
        return { pos, ended: true, ending: term.ending ?? undefined };
      }
      const to = resolveTerminalChain(term, flags, this.profileGameFlags);
      if (to && this.scripts.has(to)) {
        return { pos: { script: to, event: 0 }, ended: false };
      }
      return { pos, ended: true };
    }
    const nxt = this.spine.next[pos.script];
    if (!nxt) return { pos, ended: true };
    return { pos: { script: nxt, event: 0 }, ended: false };
  }

  /** Resolve a choice pick to the next position + flag updates. */
  pick(pos: Position, n: number, flags: Flags): PickResult {
    const ev = this.at(pos);
    if (!ev || ev.t !== "choice") throw new Error("pick() outside a choice");
    const key = `${pos.script}:${pos.event}`;
    const node = this.flow.get(key) ?? null;
    const opt = ev.options.find((o) => o.n === n);
    if (!opt) throw new Error(`option ${n} not present`);
    if (this.cfg && this.hasCfg(pos.script)) {
      const res = pickCfg(this.cfg, pos, n, flags, this.cfgExecOpts());
      return {
        next: res.next,
        node,
        ended: res.ended,
        ending: res.ending,
        unlockedEndings: res.unlockedEndings,
      };
    }
    const flowOpt = node?.options.find((o) => o.n === n);
    applyEffects(flags, node, n);
    // flow.json is curated against the bytecode (option n -> L[0]==n); a flow
    // option's goto (null = fall through) wins over the parsed event's goto.
    const dest = flowOpt ? (flowOpt.play ?? flowOpt.goto) : opt.goto;
    if (dest?.startsWith("END:")) {
      const ending = dest.slice(4);
      return {
        next: { script: pos.script, event: pos.event + 1 },
        node,
        ending,
      };
    }
    if (dest && this.scripts.has(dest)) {
      return { next: { script: dest, event: 0 }, node };
    }
    return { next: { script: pos.script, event: pos.event + 1 }, node };
  }

  flowNode(pos: Position): FlowNode | null {
    return this.flow.get(`${pos.script}:${pos.event}`) ?? null;
  }
}

export function applyEffects(flags: Flags, node: FlowNode | null, n: number): void {
  if (!node) return;
  // Node-level effects keyed by option number live in node.effects[n] when
  // the annotator used that shape; flow.json options may also carry effects.
  const opt = node.options.find((o) => o.n === n);
  const eff = (node.effects?.[n] as Record<string, unknown> | undefined) ??
    (opt?.effects as Record<string, unknown> | undefined) ?? {};
  const aff = (eff["aff"] ?? {}) as Record<string, number>;
  for (const [k, v] of Object.entries(aff)) {
    flags.aff[k] = (flags.aff[k] ?? 0) + v;
  }
  // Conditional affection (aff_if_<flag>) and flag set/clear.
  for (const [k, v] of Object.entries(eff)) {
    if (k.startsWith("aff_if_") && typeof v === "object" && v !== null) {
      const flag = k.slice("aff_if_".length);
      if (flags.set[flag]) {
        for (const [ak, av] of Object.entries(v as Record<string, number>)) {
          flags.aff[ak] = (flags.aff[ak] ?? 0) + av;
        }
      }
    }
  }
  if (typeof eff["uwaki"] === "number") {
    flags.aff["uwaki"] = (flags.aff["uwaki"] ?? 0) + (eff["uwaki"] as number);
  }
  if (typeof eff["flag"] === "string") {
    flags.set[eff["flag"] as string] = true;
  }
  if (typeof eff["flag_off"] === "string") {
    delete flags.set[eff["flag_off"] as string];
  }
  if (typeof eff["clear"] === "string") {
    delete flags.set[eff["clear"] as string];
  }
}
