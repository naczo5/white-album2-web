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

export interface Flags {
  aff: Record<string, number>;
  set: Record<string, boolean>;
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
}
