// Core scenario IR types (mirror tools/parse_txt.py output + flow/ending data).

export type Layer = "bak" | "grp" | null;

export type ScenarioEvent =
  | { t: "say"; speaker: string; text: string; style?: "whisper"; tok?: number }
  | { t: "narrate"; text: string; style?: "whisper"; tok?: number }
  | { t: "latch"; name: string }
  | { t: "movie"; id: string }
  | { t: "image"; file: string; layer: Layer }
  | { t: "filter"; file: string }
  | { t: "bgm"; file: string }
  | { t: "anim"; file: string; layer: Layer }
  | { t: "layer"; layer: string }
  | { t: "choice"; options: ChoiceOption[] }
  | { t: "jump"; kind: string; targets: string[] };

export interface ChoiceOption {
  n: number;
  text: string;
  /** Engine-evidenced bare-id destination (option 1 = fall through). */
  goto: string | null;
}

export interface Scenario {
  script: string;
  tokens: number;
  events: ScenarioEvent[];
  warnings: string[];
}

export interface FlowOption {
  n: number;
  text: string;
  goto: string | null;
  /** Gameplay destination: script id, "END:<id>", or null = continue. */
  play?: string | null;
  effects?: Record<string, unknown>;
}

export interface FlowNode {
  id: string;
  engine: { script: string; event: number };
  options: FlowOption[];
  date: string | null;
  effects: Record<string, unknown>;
  gated: Record<string, string>;
  walkthrough: string | null;
  note?: string;
  status: "EXPERT_SOURCED" | "NEEDS_PLAYTEST" | "NEEDS_REVIEW";
}

export interface LinkSite {
  id: string;
  engine: { script: string; events: number[] };
  targets: string[];
  missing: string[];
  default: string | null;
  note?: string;
  status: "HINT" | "SWITCH" | "DEAD" | "BRIDGE";
}

export interface LinksData {
  version: number;
  counts?: Record<string, number>;
  links: LinkSite[];
}

export type TerminalAction = { action: "end"; ending: string | null } | { action: "chain"; to: string };

export interface TerminalsData {
  version: number;
  terminals: Record<string, TerminalAction & { guess?: string; note?: string; status?: string }>;
}

export interface FlowData {
  version: number;
  counts?: Record<string, number>;
  nodes: FlowNode[];
}

export interface Ending {
  id: string;
  chapter: string;
  name: string;
  files?: string[];
  choices?: number;
  unlock: string;
  epilogue?: boolean;
  gates?: string;
  status: string;
}

export interface Position {
  script: string;
  event: number;
}

/** BGM cue table (built by tools/build_bgm.py from .bnr opcode (4,158)).
 * Cues are timeline data: latest cue at/before the event wins; `stop`
 * silences; files with no cue inherit prior BGM. `missing` tracks have no
 * file in BGM.PAKs (player sustains previous BGM, never silence). */
export interface BgmCue {
  ev: number;
  track?: number;
  stop?: boolean;
  fade?: number | null;
  missing?: boolean;
}

export interface BgmData {
  version: number;
  cues: Record<string, BgmCue[]>;
}

/** Per-line voice map (built by tools/build_voice.py from .bnr (4,138)).
 * Keys are event indices; values are exact archive line keys (v2:
 * "1008_0199" / "ic/1002_0000", resolved via the family-base chain) or
 * legacy bare NNN numbers (runtime tok fallback). Events without an
 * entry are unvoiced. */
export interface VoiceMapData {
  version: number;
  map: Record<string, Record<string, string | number>>;
}

/** Display-name overrides (tools/build_voice.py from the MAO manuscript):
 * JP speaker labels -> EN names, keyed by event index. */
export interface SpeakersData {
  version: number;
  speakers: Record<string, Record<string, string>>;
}

/** Per-event presentation records (built by tools/decode_bnr.py).
 * Only `conf: "high"` records drive playback; anything weaker is
 * documented hypothesis the player deliberately ignores. */
export interface BnrRec {
  ev: number;
  se?: number[];
  /** Ambient channel cue (4,165): SE id, channel 0-3, volume 0-255,
   * loop flag. */
  amb?: { se: number; ch: number; vol: number; loop: boolean };
  /** Ambient channel stop (4,166) with non-positive volume. */
  ambStop?: number;
  cam?: { zoom: number; dur: number };
  fadeMs?: number;
  /** Standing sprite show (4,154)/(4,155): prefix id + full filename
   * stem ("kaz001101"), resolved char\{prefix}{base+face:06d}. */
  /** Standing sprite show (4,154)/(4,155): prefix id + full filename
   * stem + screen position index (exe table 0x4be0bc; null = unknown
   * form, render centred). Slot records are keyed by character id. */
  spr?: { id: number; stem: string; pos?: number | null };
  /** Sprite slot hide (same ops, face sentinel 4000). */
  sprHide?: number;
  /** Backdrop show/clear wipes all standing sprites (exe 0x4167e0 -> 0x402680). */
  sprClear?: boolean;
  /** Backdrop/event-art cue: filename stems (prefix resolved at lookup). */
  layer?: "bak" | "grp";
  stems?: string[];
  /** Transition duration ms for an image cue. */
  fade?: number | null;
  /** Stage clear (engine wipe): barrier for older cues. */
  clear?: boolean;
  conf: "high" | "hypothesis";
}

export interface BnrData {
  version: number;
  recs: Record<string, BnrRec[]>;
}

/** Speaker -> standing-sprite filename prefix (superseded: sprite
 * identity is now decoded from .bnr (4,154)/(4,155) recs; data/sprites.json
 * remains only as build-copied reference data). */
export interface SpriteData {
  version: number;
  speakers: Record<string, { prefix: string }>;
}

export type CfgExpr =
  | number
  | { t: "G"; idx: number }
  | { t: "L"; idx: number; off?: CfgExpr }
  | { t: "Lbase"; idx: number }
  | { t: "gflag"; id: CfgExpr }
  | { t: "replay" }
  | { t: "un"; op: string; x: CfgExpr }
  | { t: "bin"; op: string; l: CfgExpr; r: CfgExpr }
  | { t: "tok"; tok: number }
  | { t: "call"; id: number; args: CfgExpr[] };

export interface CfgChoiceOption {
  n: number;
  tok?: number;
  flagId: CfgExpr;
  cmp: CfgExpr;
  showWhenLocked: boolean;
}

export type CfgOp =
  | { t: "play"; from: number; to: number }
  | { t: "setG"; idx: number; op: string; val: CfgExpr }
  | { t: "setL"; idx: number; op: string; val: CfgExpr }
  | { t: "setGFlag"; id: CfgExpr; val: CfgExpr }
  | { t: "if"; branches: { cond: CfgExpr | null; ops: CfgOp[] }[] }
  | { t: "choice"; ev: number; nodeIdx: number; into?: { t: "L"; idx: number } | null; options: CfgChoiceOption[] }
  | { t: "sload"; script: string; entry: number }
  | { t: "scall"; script: string; entry: number }
  | { t: "ret" }
  | { t: "gotitle" };

export interface CfgVarDef {
  idx: number;
  name: string;
  init: number;
}

export interface CfgData {
  version: number;
  vars: CfgVarDef[];
  scripts: Record<string, Record<string, CfgOp[]>>;
}

export interface CfgStackFrame {
  path: number[];
  idx: number;
}

export interface CfgCallFrame {
  script: string;
  entry: string;
  l: number[];
  pcStack: CfgStackFrame[];
  event: number;
  executedRanges: [number, number][];
  spanEnd?: number;
}

export interface CfgRuntimeState {
  script: string;
  entry: string;
  l: number[];
  pcStack: CfgStackFrame[];
  callStack: CfgCallFrame[];
  executedRanges: [number, number][];
  spanEnd?: number;
}

export interface Flags {
  aff: Record<string, number>;
  set: Record<string, boolean>;
  g?: number[];
  gflags?: Record<string, number>;
  cfg?: CfgRuntimeState;
}

/** Metadata for a save imported from the original PC build. The native
 * file is not stored; only the display/position fields needed by the port. */
export interface NativeSaveMeta {
  file?: string;
  script: string;
  route?: string;
  preview?: string;
  speaker?: string;
  options?: string[];
  timestamp?: string;
  playtime?: number;
  version?: number;
  /** More than one scenario line normalized to the same text. */
  ambiguous?: boolean;
  confidence?: "exact" | "fuzzy" | "choice";
  /** 1-based candidate index when a native line is ambiguous. */
  candidate?: number;
  candidateCount?: number;
}

/** Engine-side slot map for the native PC global save (`Sys.sav`), emitted by
 * tools/build_sys_table.py from WA2.exe's static .data tables (see
 * docs/PARSING.md). Committed functional metadata only: script ids, numeric
 * flag slots and CG ids — never game text. */
export interface SysSlotsTable {
  version: number;
  source?: Record<string, string>;
  sysSav?: {
    size?: number;
    regions?: {
      A?: {
        start: number;
        end: number;
        slotBytes?: number;
        slotBits?: number;
        slotCount?: number;
        format?: string;
        excludedSlots?: number[];
      };
      B?: { start: number; end: number; format?: string };
      C?: { start: number; end: number; format?: string };
    };
  };
  /** 185 script ids: index i is the Region A read-bitmap slot. */
  scripts: string[];
  /** 23 choice scripts in the engine's choice order (== flow.json order). */
  choiceTable: { scriptIds: string[]; base: number; stride: number; format?: string };
  /** 168 gallery rows x 10 u32 CG ids (`part * 1_000_000 + cgId`). */
  cgRows: number[][];
  /** Region C flag slot (string key) -> endings.json id. */
  endingSlots: Record<string, string>;
  /** Per-slot decode confidence: only `high` may auto-unlock an ending. */
  endingSlotsConfidence: Record<string, "high" | "hypothesis" | "reserved">;
  gateSlots: Record<string, number>;
  gflagAliasSlots?: number[];
  openItems?: string[];
}

/** Global progress imported from `Sys.sav`, kept apart from a run save: it
 * accumulates read lines, visited scripts, endings and unlock bands across
 * every playthrough and every imported system save. */
export interface SysProfile {
  version: 1;
  /** Original file name of the last imported system save. */
  fileName?: string;
  importedAt: string;
  /** Read message lines as `script:event` keys (sequential say/narrate
   * index within the scenario, never a raw token id). */
  readKeys: string[];
  /** Scripts with at least one read line. */
  visited: string[];
  /** Ending ids from `high`-confidence Region C slots only. */
  endings: string[];
  /** Flow node id -> 1-based option numbers ever seen (choice bitmasks). */
  seenPicks: Record<string, number[]>;
  /** Region B CG ids (`part * 1_000_000 + cgId`) unlocked in the gallery. */
  cg: number[];
  /** Music track ids (`slot - 100`). */
  music: number[];
  /** Movie ids (`slot - 200`). Id `0` is the slot-80 all-movies sentinel,
   * not a real film, so display it as "+all" rather than a count. */
  movies: number[];
  /** Ero-scene flag ids (`slot - 300`). */
  ero: number[];
  /** Named gate flags (see `GATE_NAMES` in engine/sys-save.ts). */
  gates: Record<string, number>;
  /** Nonzero Region C slots `0..899` (GetGameFlag / SetGameFlag). */
  gameFlags?: Record<string, number>;
}

export interface SaveData {
  version: 1;
  name: string;
  updatedAt: string;
  position: Position;
  flags: Flags;
  picks: Record<string, number>; // flow node id -> chosen option n
  visited: string[]; // script ids
  endings: string[];
  log: { speaker: string; text: string }[];
  lastLogged?: string; // position key of the last logged line
  /** Last BGM cue state for mid-scene restore: engine track number, or
   * null after an explicit stop. Absent in legacy saves. */
  bgm?: { track: number } | null;
  /** Present on saves imported from the PC build. */
  native?: NativeSaveMeta;
}
