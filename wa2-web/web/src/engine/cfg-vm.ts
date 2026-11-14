// Engine-exact 32-bit LSCR CFG VM (mirrors WA2.exe / tests/test_build_cfg.py).
// All runtime state lives inside `Flags` (`g`, `gflags`, `cfg`) as plain JSON
// so saves round-trip cleanly through localStorage and JSON export/import.

import type {
  CfgCallFrame,
  CfgChoiceOption,
  CfgData,
  CfgExpr,
  CfgOp,
  CfgRuntimeState,
  CfgStackFrame,
  CfgVarDef,
  Flags,
  Position,
  TerminalsData,
} from "./types";

export const STANDARD_GLOBAL_VARS: CfgVarDef[] = [
  { idx: 0, name: "FLG_00", init: 0 },
  { idx: 1, name: "SubWait_timer", init: 0 },
  { idx: 2, name: "SubWhiteIn_timer", init: 0 },
  { idx: 3, name: "SubWhiteOut_timer", init: 0 },
  { idx: 4, name: "FLG_章管理サブ", init: 0 },
  { idx: 5, name: "FLG_かずさ本気度", init: 0 },
  { idx: 6, name: "FLG_かずさ浮気度", init: 0 },
  { idx: 7, name: "FLG_雪菜好意度", init: 0 },
  { idx: 8, name: "FLG_小春好意度", init: 0 },
  { idx: 9, name: "FLG_千晶好意度", init: 0 },
  { idx: 10, name: "FLG_麻理好意度", init: 0 },
  { idx: 11, name: "FLG_小春ルート消滅", init: 0 },
  { idx: 12, name: "FLG_千晶ルート消滅", init: 0 },
  { idx: 13, name: "FLG_麻理ルート消滅", init: 0 },
  { idx: 14, name: "FLG_第２部03選択肢１", init: 0 },
  { idx: 15, name: "FLG_第２部03選択肢２", init: 0 },
  { idx: 16, name: "FLG_第２部13選択肢１", init: 0 },
  { idx: 17, name: "FLG_第２部14選択肢１", init: 0 },
  { idx: 18, name: "FLG_第２部15選択肢１", init: 0 },
  { idx: 19, name: "FLG_第２部18選択肢１", init: 0 },
  { idx: 20, name: "FLG_第３部05選択肢１", init: 0 },
  { idx: 21, name: "FLG_第３部09選択肢１", init: 0 },
  { idx: 22, name: "FLG_第３部13条件１", init: 0 },
  { idx: 23, name: "FLG_第３部13選択肢１", init: 0 },
  { idx: 24, name: "FLG_第３部13選択肢２", init: 0 },
  { idx: 25, name: "FLG_第３部14選択肢１", init: 0 },
  { idx: 26, name: "FLG_第３部15条件２", init: 0 },
  { idx: 27, name: "FLG_第３部16条件３", init: 0 },
  { idx: 28, name: "FLG_第３部16選択肢２", init: 0 },
];

export const DEFAULT_ENDING_SLOTS: Record<string, string> = {
  "0": "ic-end",
  "20": "cc-normal1",
  "21": "cc-setsuna",
  "22": "cc-koharu",
  "23": "cc-chiaki-true",
  "24": "cc-chiaki-normal",
  "25": "cc-mari",
  "30": "coda-normal",
  "31": "coda-kazusa-true",
  "32": "coda-cheating",
  "33": "coda-setsuna-true",
};

export const AFF_TO_G: Record<string, number> = {
  k: 5,
  uwaki: 6,
  s: 7,
  koharu: 8,
  chiaki: 9,
  mari: 10,
};

export const G_TO_AFF: Record<number, string> = {
  5: "k",
  6: "uwaki",
  7: "s",
  8: "koharu",
  9: "chiaki",
  10: "mari",
};

/** Known Global.vrb choice index -> flow node id (for native save pick sync). */
export const G_TO_PICK_NODE: Record<number, string> = {
  14: "2003-242",
  15: "2003-982",
  16: "2013-198",
  17: "2014-271",
  18: "2015-351",
  19: "2018-548",
  20: "3005-186",
  21: "3009-1347",
  23: "3013-747",
  24: "3013-801",
  25: "3014-376",
  28: "3016-859",
};

export interface EvalContext {
  g: number[];
  l: number[];
  gflags?: Record<string, number>;
  profileGameFlags?: Record<string, number>;
  replay?: number;
}

export interface CfgExecOptions {
  profileGameFlags?: Record<string, number>;
  endingSlots?: Record<string, string>;
  terminals?: TerminalsData["terminals"];
  replay?: number;
  unlockAll?: boolean;
  onGameFlag?: (id: number, val: number) => void;
  picks?: Record<string, number>;
  preserveG?: boolean;
}

export interface CfgStepResult {
  pos: Position;
  ended: boolean;
  ending?: string;
  unlockedEndings: string[];
}

export interface CfgPickResult {
  next: Position;
  ended: boolean;
  ending?: string;
  unlockedEndings: string[];
}

export interface CfgChoiceOptionState {
  n: number;
  unlocked: boolean;
  visible: boolean;
  rawUnlocked: boolean;
}

export function isEventInExecutedRanges(
  ranges: readonly [number, number][] | undefined,
  ev: number,
): boolean {
  if (!ranges) return true;
  for (const [from, to] of ranges) {
    if (ev >= from && ev < to) return true;
  }
  return false;
}

export function getGameFlag(
  id: number,
  saveGflags?: Record<string, number>,
  profileGameFlags?: Record<string, number>,
): number {
  if (id === 99) return 0; // WA2.exe GetGameFlag(99) always returns 0
  return saveGflags?.[String(id)] ?? profileGameFlags?.[String(id)] ?? 0;
}

export function setGameFlag(id: number, val: number, flags: Flags): void {
  if (id === 99) return;
  if (!flags.gflags) flags.gflags = {};
  flags.gflags[String(id)] = val;
}

export function evalExpr(expr: CfgExpr, ctx: EvalContext): number {
  if (typeof expr === "number") return Number.isFinite(expr) ? expr : 0;
  if (!expr || typeof expr !== "object") return 0;
  switch (expr.t) {
    case "G":
      return ctx.g[expr.idx] ?? 0;
    case "L": {
      const idx = expr.off !== undefined ? expr.idx + evalExpr(expr.off, ctx) : expr.idx;
      return ctx.l[idx] ?? 0;
    }
    case "Lbase":
      return expr.idx;
    case "gflag": {
      const fid = evalExpr(expr.id, ctx);
      return getGameFlag(fid, ctx.gflags, ctx.profileGameFlags);
    }
    case "replay":
      return ctx.replay ? 1 : 0;
    case "un": {
      const v = evalExpr(expr.x, ctx);
      if (expr.op === "!") return v ? 0 : 1;
      if (expr.op === "-") return -v;
      return v;
    }
    case "bin": {
      if (expr.op === "&&") {
        return evalExpr(expr.l, ctx) && evalExpr(expr.r, ctx) ? 1 : 0;
      }
      if (expr.op === "||") {
        return evalExpr(expr.l, ctx) || evalExpr(expr.r, ctx) ? 1 : 0;
      }
      const lv = evalExpr(expr.l, ctx);
      const rv = evalExpr(expr.r, ctx);
      switch (expr.op) {
        case "==": return lv === rv ? 1 : 0;
        case "!=": return lv !== rv ? 1 : 0;
        case "<": return lv < rv ? 1 : 0;
        case ">": return lv > rv ? 1 : 0;
        case "<=": return lv <= rv ? 1 : 0;
        case ">=": return lv >= rv ? 1 : 0;
        case "+": return lv + rv;
        case "-": return lv - rv;
        case "*": return lv * rv;
        case "/": return rv ? Math.trunc(lv / rv) : 0;
        case "%": return rv ? lv % rv : 0;
        case "&": return lv & rv;
        case "|": return lv | rv;
        default: return 0;
      }
    }
    case "tok":
    case "call":
    default:
      return 0;
  }
}

export function applyAssign(cur: number, op: string, val: number): number {
  switch (op) {
    case "=": return val;
    case "+=": return cur + val;
    case "-=": return cur - val;
    case "*=": return cur * val;
    case "/=": return val ? Math.trunc(cur / val) : 0;
    case "%=": return val ? cur % val : 0;
    case "&=": return cur & val;
    case "|=": return cur | val;
    default: return cur;
  }
}

export function syncAffFromG(flags: Flags): void {
  if (!flags.g) return;
  for (const [idxStr, key] of Object.entries(G_TO_AFF)) {
    const v = flags.g[Number(idxStr)] ?? 0;
    if (v !== 0 || key in flags.aff) {
      flags.aff[key] = v;
    }
  }
}

export function syncGFromAff(flags: Flags, vars: CfgVarDef[] = STANDARD_GLOBAL_VARS): void {
  if (!flags.g) {
    flags.g = new Array(Math.max(29, vars.length)).fill(0);
    for (const v of vars) flags.g[v.idx] = v.init ?? 0;
  }
  for (const [key, idx] of Object.entries(AFF_TO_G)) {
    const v = flags.aff[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      flags.g[idx] = v;
    }
  }
}

export function initCfgFlags(cfg: CfgData | null | undefined, flags: Flags): number[] {
  const vars = cfg?.vars ?? STANDARD_GLOBAL_VARS;
  if (!flags.g) {
    flags.g = new Array(Math.max(29, vars.length)).fill(0);
    for (const v of vars) flags.g[v.idx] = v.init ?? 0;
    syncGFromAff(flags, vars);
  } else if (flags.g.length < vars.length) {
    const start = flags.g.length;
    for (let i = start; i < vars.length; i++) {
      flags.g[i] = vars[i]?.init ?? 0;
    }
  }
  if (!flags.gflags) flags.gflags = {};
  return flags.g;
}

function resolveOps(cfg: CfgData, script: string, entry: string, path: number[]): CfgOp[] | null {
  let ops = cfg.scripts[script]?.[entry];
  if (!ops) return null;
  for (let i = 0; i + 1 < path.length; i += 2) {
    const op = ops[path[i]!];
    if (!op || op.t !== "if") return null;
    const br = op.branches[path[i + 1]!];
    if (!br) return null;
    ops = br.ops;
  }
  return ops;
}

function currentOp(cfg: CfgData, state: CfgRuntimeState): CfgOp | null {
  const top = state.pcStack[state.pcStack.length - 1];
  if (!top) return null;
  const ops = resolveOps(cfg, state.script, state.entry, top.path);
  if (!ops || top.idx < 0 || top.idx >= ops.length) return null;
  return ops[top.idx] ?? null;
}

function findChoiceInOps(ops: CfgOp[], ev: number): Extract<CfgOp, { t: "choice" }> | null {
  for (const op of ops) {
    if (op.t === "choice" && op.ev === ev) return op;
    if (op.t === "if") {
      for (const br of op.branches) {
        const hit = findChoiceInOps(br.ops, ev);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function findChoiceOp(cfg: CfgData, script: string, ev: number): Extract<CfgOp, { t: "choice" }> | null {
  const entries = cfg.scripts[script];
  if (!entries) return null;
  for (const ops of Object.values(entries)) {
    const hit = findChoiceInOps(ops, ev);
    if (hit) return hit;
  }
  return null;
}

function makeCallFrame(state: CfgRuntimeState): CfgCallFrame {
  return {
    script: state.script,
    entry: state.entry,
    l: state.l.slice(),
    pcStack: state.pcStack.map((f) => ({ path: [...f.path], idx: f.idx })),
    event: state.spanEnd ?? 0,
    executedRanges: state.executedRanges.map((r) => [r[0], r[1]] as [number, number]),
    ...(state.spanEnd !== undefined ? { spanEnd: state.spanEnd } : {}),
  };
}

function restoreCallFrame(state: CfgRuntimeState, frame: CfgCallFrame): void {
  state.script = frame.script;
  state.entry = frame.entry;
  state.l = frame.l;
  state.pcStack = frame.pcStack;
  state.executedRanges = frame.executedRanges;
  state.spanEnd = frame.spanEnd;
}

function containsTargetEvent(ops: CfgOp[], targetEvent: number): boolean {
  for (const op of ops) {
    if (op.t === "play") {
      if (targetEvent >= op.from && targetEvent < op.to) return true;
    } else if (op.t === "choice") {
      if (op.ev === targetEvent) return true;
    } else if (op.t === "if") {
      for (const br of op.branches) {
        if (containsTargetEvent(br.ops, targetEvent)) return true;
      }
    }
  }
  return false;
}

function unconditionallyExitsScript(ops: CfgOp[]): boolean {
  for (const op of ops) {
    if (op.t === "sload" || op.t === "gotitle") return true;
    if (op.t === "play" || op.t === "choice") return false;
  }
  return false;
}

function inferChoiceValue(
  ops: CfgOp[],
  choiceIdxInOps: number,
  choiceOp: Extract<CfgOp, { t: "choice" }>,
  script: string,
  targetEvent: number,
  g: number[],
  picks?: Record<string, number>,
): number | null {
  const keyColon = `${script}:${choiceOp.ev}`;
  const keyDash = `${script}-${choiceOp.ev}`;
  const fromPicks = picks?.[keyDash] ?? picks?.[keyColon];
  if (typeof fromPicks === "number" && fromPicks >= 1) return fromPicks;

  if (choiceOp.into?.t === "L") {
    const lIdx = choiceOp.into.idx;
    const nextOp = ops[choiceIdxInOps + 1];
    if (nextOp && nextOp.t === "setG" && nextOp.op === "=" &&
      typeof nextOp.val === "object" && nextOp.val !== null &&
      nextOp.val.t === "L" && nextOp.val.idx === lIdx &&
      (g[nextOp.idx] ?? 0) > 0) {
      return g[nextOp.idx]!;
    }
    for (let k = choiceIdxInOps + 1; k < ops.length; k++) {
      const sibling = ops[k]!;
      if (sibling.t === "if") {
        for (const br of sibling.branches) {
          if (containsTargetEvent(br.ops, targetEvent) && br.cond && typeof br.cond === "object" &&
            br.cond.t === "bin" && br.cond.op === "==" &&
            typeof br.cond.l === "object" && br.cond.l !== null &&
            br.cond.l.t === "L" && br.cond.l.idx === lIdx &&
            typeof br.cond.r === "number") {
            return br.cond.r;
          }
        }
      }
    }
  }
  return null;
}

function runUntilPause(
  cfg: CfgData,
  state: CfgRuntimeState,
  flags: Flags,
  opts: CfgExecOptions,
  fireFlagHooks: boolean,
): CfgStepResult {
  const g = initCfgFlags(cfg, flags);
  const endingSlots = opts.endingSlots ?? DEFAULT_ENDING_SLOTS;
  const unlockedEndings: string[] = [];
  const recordEnding = (id: string | undefined | null) => {
    if (id && !unlockedEndings.includes(id)) unlockedEndings.push(id);
  };

  for (let steps = 0; steps < 4000; steps++) {
    while (state.pcStack.length > 0) {
      const top = state.pcStack[state.pcStack.length - 1]!;
      const ops = resolveOps(cfg, state.script, state.entry, top.path);
      if (!ops || top.idx >= ops.length) {
        state.pcStack.pop();
      } else {
        break;
      }
    }
    if (state.pcStack.length === 0) {
      if (state.callStack.length > 0) {
        restoreCallFrame(state, state.callStack.pop()!);
        continue;
      }
      const term = opts.terminals?.[state.script];
      if (term?.action === "end") recordEnding(term.ending);
      return {
        pos: { script: state.script, event: state.spanEnd ?? 0 },
        ended: true,
        ending: unlockedEndings[0],
        unlockedEndings,
      };
    }

    const top = state.pcStack[state.pcStack.length - 1]!;
    const ops = resolveOps(cfg, state.script, state.entry, top.path)!;
    const op = ops[top.idx]!;

    if (op.t === "play") {
      top.idx += 1;
      state.executedRanges.push([op.from, op.to]);
      state.spanEnd = op.to;
      return {
        pos: { script: state.script, event: op.from },
        ended: false,
        ending: unlockedEndings[0],
        unlockedEndings,
      };
    }

    if (op.t === "choice") {
      // Leave pcStack pointing AT the choice op so pickCfg() consumes it.
      state.spanEnd = op.ev;
      return {
        pos: { script: state.script, event: op.ev },
        ended: false,
        ending: unlockedEndings[0],
        unlockedEndings,
      };
    }

    const opIdx = top.idx;
    top.idx += 1;

    const ctx: EvalContext = {
      g,
      l: state.l,
      gflags: flags.gflags,
      profileGameFlags: opts.profileGameFlags,
      replay: opts.replay ?? 0,
    };

    switch (op.t) {
      case "setG": {
        const val = evalExpr(op.val, ctx);
        g[op.idx] = applyAssign(g[op.idx] ?? 0, op.op, val);
        const affKey = G_TO_AFF[op.idx];
        if (affKey) flags.aff[affKey] = g[op.idx]!;
        break;
      }
      case "setL": {
        const val = evalExpr(op.val, ctx);
        state.l[op.idx] = applyAssign(state.l[op.idx] ?? 0, op.op, val);
        break;
      }
      case "setGFlag": {
        const fid = evalExpr(op.id, ctx);
        if (fid !== 99) {
          const val = evalExpr(op.val, ctx);
          setGameFlag(fid, val, flags);
          if (fireFlagHooks) {
            opts.onGameFlag?.(fid, val);
          }
          if (val !== 0 && endingSlots[String(fid)]) {
            recordEnding(endingSlots[String(fid)]);
          }
        }
        break;
      }
      case "if": {
        for (let b = 0; b < op.branches.length; b++) {
          const br = op.branches[b]!;
          if (br.cond === null || evalExpr(br.cond, ctx) !== 0) {
            if (br.ops.length > 0) {
              state.pcStack.push({ path: [...top.path, opIdx, b], idx: 0 });
            }
            break;
          }
        }
        break;
      }
      case "sload": {
        const nextScript = op.script;
        const nextEntry = String(op.entry);
        if (!cfg.scripts[nextScript]?.[nextEntry]) {
          return {
            pos: { script: nextScript, event: 0 },
            ended: false,
            ending: unlockedEndings[0],
            unlockedEndings,
          };
        }
        state.script = nextScript;
        state.entry = nextEntry;
        state.l = new Array(64).fill(0);
        state.pcStack = [{ path: [], idx: 0 }];
        state.executedRanges = [];
        state.spanEnd = undefined;
        break;
      }
      case "scall": {
        const nextScript = op.script;
        const nextEntry = String(op.entry);
        if (!cfg.scripts[nextScript]?.[nextEntry]) break;
        state.callStack.push(makeCallFrame(state));
        state.script = nextScript;
        state.entry = nextEntry;
        state.l = new Array(64).fill(0);
        state.pcStack = [{ path: [], idx: 0 }];
        state.executedRanges = [];
        state.spanEnd = undefined;
        break;
      }
      case "ret": {
        if (state.callStack.length > 0) {
          restoreCallFrame(state, state.callStack.pop()!);
        } else {
          return {
            pos: { script: state.script, event: state.spanEnd ?? 0 },
            ended: true,
            ending: unlockedEndings[0],
            unlockedEndings,
          };
        }
        break;
      }
      case "gotitle": {
        const term = opts.terminals?.[state.script];
        if (term?.action === "end") recordEnding(term.ending);
        return {
          pos: { script: state.script, event: state.spanEnd ?? 0 },
          ended: true,
          ending: unlockedEndings[0],
          unlockedEndings,
        };
      }
    }
  }
  throw new Error(`CFG VM step limit exceeded at ${state.script}:${state.entry}`);
}

/** Position the CFG VM cleanly at `targetPos` (event 0 runs leading ops so
 * empty NG+ gates or SCall prologues resolve; event > 0 seeks within the script
 * while preserving restored `flags.g` / `flags.gflags` and collecting executedRanges). */
export function seekCfg(
  cfg: CfgData,
  targetPos: Position,
  flags: Flags,
  opts: CfgExecOptions = {},
): Position {
  const preserveVars = opts.preserveG ?? (Array.isArray(flags.g) && targetPos.event > 0);
  const g = initCfgFlags(cfg, flags);
  const entries = cfg.scripts[targetPos.script];
  const entryKey = entries?.["0"] ? "0" : entries ? Object.keys(entries)[0] : undefined;
  if (!entryKey) {
    delete flags.cfg;
    return targetPos;
  }

  const state: CfgRuntimeState = {
    script: targetPos.script,
    entry: entryKey,
    l: new Array(64).fill(0),
    pcStack: [{ path: [], idx: 0 }],
    callStack: [],
    executedRanges: [],
  };
  flags.cfg = state;

  if (targetPos.event <= 0) {
    const res = runUntilPause(cfg, state, flags, opts, false);
    return res.pos;
  }

  const simG = g.slice();
  const simGflags = { ...(flags.gflags ?? {}) };
  const targetEvent = targetPos.event;

  for (let steps = 0; steps < 4000; steps++) {
    while (state.pcStack.length > 0) {
      const top = state.pcStack[state.pcStack.length - 1]!;
      const ops = resolveOps(cfg, state.script, state.entry, top.path);
      if (!ops || top.idx >= ops.length) {
        state.pcStack.pop();
      } else {
        break;
      }
    }
    if (state.pcStack.length === 0) {
      state.spanEnd = undefined;
      return { script: targetPos.script, event: targetEvent };
    }

    const top = state.pcStack[state.pcStack.length - 1]!;
    const ops = resolveOps(cfg, state.script, state.entry, top.path)!;
    const op = ops[top.idx]!;

    if (op.t === "play") {
      top.idx += 1;
      state.executedRanges.push([op.from, op.to]);
      if (targetEvent >= op.from && targetEvent < op.to) {
        state.spanEnd = op.to;
        return { script: targetPos.script, event: targetEvent };
      }
      continue;
    }

    if (op.t === "choice") {
      if (op.ev === targetEvent) {
        state.spanEnd = op.ev;
        return { script: targetPos.script, event: targetEvent };
      }
      const inferred = inferChoiceValue(ops, top.idx, op, state.script, targetEvent, simG, opts.picks);
      if (inferred !== null && op.into?.t === "L") {
        state.l[op.into.idx] = inferred;
      }
      top.idx += 1;
      continue;
    }

    const opIdx = top.idx;
    top.idx += 1;
    const ctx: EvalContext = {
      g: simG,
      l: state.l,
      gflags: simGflags,
      profileGameFlags: opts.profileGameFlags,
      replay: opts.replay ?? 0,
    };

    switch (op.t) {
      case "setG": {
        const val = evalExpr(op.val, ctx);
        // If `preserveVars` is true and this copies an unresolved local L[k] == 0
        // right after a choice, do not zero out the restored Global.vrb choice var.
        const isUnknownLocalCopy = preserveVars && op.op === "=" &&
          typeof op.val === "object" && op.val !== null && op.val.t === "L" &&
          (state.l[op.val.idx] ?? 0) === 0 && (simG[op.idx] ?? 0) !== 0;
        if (!isUnknownLocalCopy) {
          simG[op.idx] = applyAssign(simG[op.idx] ?? 0, op.op, val);
        }
        if (!preserveVars) {
          g[op.idx] = simG[op.idx]!;
          const affKey = G_TO_AFF[op.idx];
          if (affKey) flags.aff[affKey] = g[op.idx]!;
        }
        break;
      }
      case "setL": {
        const val = evalExpr(op.val, ctx);
        state.l[op.idx] = applyAssign(state.l[op.idx] ?? 0, op.op, val);
        break;
      }
      case "setGFlag": {
        const fid = evalExpr(op.id, ctx);
        if (fid !== 99) {
          simGflags[String(fid)] = evalExpr(op.val, ctx);
        }
        break;
      }
      case "if": {
        let matched = -1;
        for (let b = 0; b < op.branches.length; b++) {
          if (containsTargetEvent(op.branches[b]!.ops, targetEvent)) {
            matched = b;
            break;
          }
        }
        if (matched < 0) {
          for (let b = 0; b < op.branches.length; b++) {
            const br = op.branches[b]!;
            if (br.cond === null || evalExpr(br.cond, ctx) !== 0) {
              if (!unconditionallyExitsScript(br.ops)) {
                matched = b;
              }
              break;
            }
          }
        }
        if (matched >= 0 && op.branches[matched]!.ops.length > 0) {
          state.pcStack.push({ path: [...top.path, opIdx, matched], idx: 0 });
        }
        break;
      }
      case "sload":
      case "scall":
      case "ret":
      case "gotitle":
        // Seeking within targetPos.script past earlier ops: stay inside this script.
        break;
    }
  }

  return { script: targetPos.script, event: targetEvent };
}

export function choiceOptionsAt(
  cfg: CfgData,
  pos: Position,
  flags: Flags,
  opts: CfgExecOptions = {},
): CfgChoiceOptionState[] {
  const g = initCfgFlags(cfg, flags);
  const state = flags.cfg;
  const activeOp = state && state.script === pos.script ? currentOp(cfg, state) : null;
  const choiceOp = activeOp && activeOp.t === "choice" && activeOp.ev === pos.event
    ? activeOp
    : findChoiceOp(cfg, pos.script, pos.event);
  if (!choiceOp) return [];

  const ctx: EvalContext = {
    g,
    l: state && state.script === pos.script ? state.l : [],
    gflags: flags.gflags,
    profileGameFlags: opts.profileGameFlags,
    replay: opts.replay ?? 0,
  };

  return choiceOp.options.map((o: CfgChoiceOption) => {
    const fid = evalExpr(o.flagId, ctx);
    const fv = getGameFlag(fid, flags.gflags, opts.profileGameFlags);
    const cmpVal = evalExpr(o.cmp, ctx);
    const rawUnlocked = fv === cmpVal;
    const unlocked = opts.unlockAll ? true : rawUnlocked;
    const visible = unlocked || o.showWhenLocked;
    return { n: o.n, unlocked, visible, rawUnlocked };
  });
}

export function stepCfg(
  cfg: CfgData,
  pos: Position,
  flags: Flags,
  opts: CfgExecOptions = {},
): CfgStepResult {
  if (!flags.cfg || flags.cfg.script !== pos.script) {
    const landed = seekCfg(cfg, pos, flags, opts);
    if (landed.script !== pos.script || landed.event !== pos.event) {
      return { pos: landed, ended: false, unlockedEndings: [] };
    }
  }
  const state = flags.cfg!;
  const cur = currentOp(cfg, state);
  if (cur && cur.t === "choice" && cur.ev === pos.event) {
    return { pos, ended: false, unlockedEndings: [] };
  }
  if (state.spanEnd !== undefined && pos.event + 1 < state.spanEnd) {
    return {
      pos: { script: pos.script, event: pos.event + 1 },
      ended: false,
      unlockedEndings: [],
    };
  }
  return runUntilPause(cfg, state, flags, opts, true);
}

export function pickCfg(
  cfg: CfgData,
  pos: Position,
  n: number,
  flags: Flags,
  opts: CfgExecOptions = {},
): CfgPickResult {
  let state = flags.cfg;
  let cur = state && state.script === pos.script ? currentOp(cfg, state) : null;
  if (!cur || cur.t !== "choice" || cur.ev !== pos.event) {
    seekCfg(cfg, pos, flags, opts);
    state = flags.cfg;
    cur = state && state.script === pos.script ? currentOp(cfg, state) : null;
  }
  if (!state || !cur || cur.t !== "choice" || cur.ev !== pos.event) {
    throw new Error(`pick() outside a CFG choice at ${pos.script}:${pos.event}`);
  }
  const optionStates = choiceOptionsAt(cfg, pos, flags, opts);
  const optState = optionStates.find((o) => o.n === n);
  if (!optState) throw new Error(`option ${n} not present at ${pos.script}:${pos.event}`);
  if (!optState.unlocked) {
    throw new Error(`option ${n} is locked at ${pos.script}:${pos.event}`);
  }

  // Consume the choice op and store the 1-based pick into its target L variable.
  state.pcStack[state.pcStack.length - 1]!.idx += 1;
  if (cur.into?.t === "L") {
    state.l[cur.into.idx] = n;
  }

  const res = runUntilPause(cfg, state, flags, opts, true);
  return {
    next: res.pos,
    ended: res.ended,
    ending: res.ending,
    unlockedEndings: res.unlockedEndings,
  };
}
