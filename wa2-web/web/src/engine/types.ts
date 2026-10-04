// Core scenario IR types (mirror tools/parse_txt.py output + flow/ending data).

export type Layer = "bak" | "grp" | null;

export type ScenarioEvent =
  | { t: "say"; speaker: string; text: string; style?: "whisper" }
  | { t: "narrate"; text: string; style?: "whisper" }
  | { t: "latch"; name: string }
  | { t: "movie"; id: string }
  | { t: "image"; file: string; layer: Layer }
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
