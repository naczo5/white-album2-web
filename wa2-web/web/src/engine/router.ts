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
//    2301) resolves in pick() via flow.json `play`; cross-line transitions
//    (1013 -> 2001, 2033 -> 3001) resolve at end-of-script via terminals.
//  - End of script -> terminals (end/chain) or spine next (numeric order,
//    variant-aware) or END.

import type {
  FlowData,
  FlowNode,
  Flags,
  LinksData,
  Position,
  Scenario,
  ScenarioEvent,
  TerminalsData,
} from "./types";

export interface Spine {
  order: string[];
  next: Record<string, string | null>;
  chapterOf: Record<string, string>;
  variants: Record<string, string[]>;
}

export function buildSpine(scripts: string[]): Spine {
  const order = [...scripts].sort();
  const next: Record<string, string | null> = {};
  const chapterOf: Record<string, string> = {};
  const variants: Record<string, string[]> = {};
  for (const s of order) chapterOf[s] = chapterOfScript(s);
  // Base files link to the next BASE file in the same chapter; suffixed
  // variants (1008_020, 2031_2) are alternates resolved by selectVariant().
  const bases = order.filter((s) => !s.includes("_"));
  for (let i = 0; i < bases.length; i++) {
    const cur = bases[i];
    const nxt = bases[i + 1] ?? null;
    next[cur] = nxt && chapterOfScript(nxt) === chapterOfScript(cur) ? nxt : null;
  }
  for (const s of order) {
    if (s.includes("_")) {
      const base = s.split("_")[0];
      (variants[base] ??= []).push(s);
      next[s] = next[base] ?? null;
    }
  }
  return { order, next, chapterOf, variants };
}

export function chapterOfScript(script: string): string {
  const base = Number(script.split("_")[0]);
  if (base >= 1001 && base <= 1013) return "intro";
  if (base >= 2001 && base <= 2517) return "closing";
  if ((base >= 3001 && base <= 3999) || (base >= 5000 && base <= 5104)) return "coda";
  return "special";
}

/** Variant selection: which physical file plays for a base id + flags. */
export function selectVariant(
  base: string,
  available: Set<string>,
  _flags: Flags,
): string {
  // v1: variant rules (replay extras, H-scene alternates) await play-test
  // mapping (docs/QA.md); until then the base file always plays so the
  // spine never breaks. The seam is live: spineAdvance consults it.
  void available;
  return base;
}

export interface StepResult {
  pos: Position;
  ended: boolean;
  ending?: string;
}

export interface PickResult {
  next: Position;
  node: FlowNode | null;
  ending?: string;
}

export class Router {
  scripts = new Map<string, Scenario>();
  flow = new Map<string, FlowNode>(); // key: `${script}:${event}`
  terminals: TerminalsData["terminals"] = {};
  spine: Spine;

  constructor(
    scenarios: Scenario[],
    flowData: FlowData,
    _linksData?: LinksData,
    terminalsData?: TerminalsData,
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
  }

  at(pos: Position): ScenarioEvent | null {
    const sc = this.scripts.get(pos.script);
    if (!sc || pos.event < 0 || pos.event >= sc.events.length) return null;
    return sc.events[pos.event];
  }

  /** Advance one event; returns new position (same pos if choice blocks). */
  advance(pos: Position, flags: Flags): StepResult {
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
      if (this.scripts.has(term.to)) {
        return { pos: { script: term.to, event: 0 }, ended: false };
      }
      return { pos, ended: true };
    }
    // Variant seam: base files with alternates consult selectVariant().
    const base = pos.script.includes("_") ? pos.script.split("_")[0] : pos.script;
    if (!pos.script.includes("_") && this.spine.variants[base]?.length) {
      const picked = selectVariant(
        base,
        new Set([base, ...this.spine.variants[base]]),
        flags,
      );
      if (picked !== base && this.scripts.has(picked)) {
        return { pos: { script: picked, event: 0 }, ended: false };
      }
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
    const flowOpt = node?.options.find((o) => o.n === n);
    applyEffects(flags, node, n);
    const dest = flowOpt?.play ?? opt.goto;
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
