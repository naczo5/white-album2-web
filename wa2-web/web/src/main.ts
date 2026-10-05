import { loadManifest } from "./engine/assets";
import { Router } from "./engine/router";
import { AUTOSAVE_KEY, deserialize, newSave, writeAutosave } from "./engine/save";
import type { SaveData } from "./engine/types";
import { loadGameData, type GameData } from "./ui/data";
import { renderFlowchart } from "./ui/flowchart";
import { renderGuide, type GuideData } from "./ui/guide";
import { installLutFilters, pushLog, renderReader, setScenarioLookup, skipLatches } from "./ui/reader";
import { renderSaves } from "./ui/saves";
import "./style.css";

type Screen = "title" | "read" | "flow" | "guide" | "special" | "saves" | "log" | "settings";

interface Settings {
  spoiler: boolean;
  fontSize: number;
  textSpeed: number; // chars/sec, 0 = instant
  autoDelay: number; // ms, 0 = off
  voiceVol: number; // 0..1
}

const settings: Settings = {
  spoiler: localStorage.getItem("wa2web.spoiler") === "1",
  fontSize: clampFont(Number(localStorage.getItem("wa2web.fontSize") ?? 18)),
  textSpeed: Number(localStorage.getItem("wa2web.textSpeed") ?? 45),
  autoDelay: Number(localStorage.getItem("wa2web.autoDelay") ?? 0),
  voiceVol: Number(localStorage.getItem("wa2web.voiceVol") ?? 0.9),
};

let skipping = false;

function persistSettings(): void {
  localStorage.setItem("wa2web.spoiler", settings.spoiler ? "1" : "0");
  localStorage.setItem("wa2web.fontSize", String(settings.fontSize));
  localStorage.setItem("wa2web.textSpeed", String(settings.textSpeed));
  localStorage.setItem("wa2web.autoDelay", String(settings.autoDelay));
  localStorage.setItem("wa2web.voiceVol", String(settings.voiceVol));
}

function clampFont(n: number): number {
  if (!Number.isFinite(n)) return 18;
  return Math.max(14, Math.min(26, Math.round(n)));
}

let data: GameData;
let router: Router;
let save: SaveData;
let screen: Screen = "title";
const app = document.getElementById("app")!;

async function boot(): Promise<void> {
  applySettings();
  data = await loadGameData();
  router = new Router(data.scenarios, data.flow, data.links, data.terminals);
  setScenarioLookup((script) => router.scripts.get(script));
  await loadManifest("assets/manifest.json");
  try {
    const lutRes = await fetch("data/luts.json");
    if (lutRes.ok) {
      const lutData = (await lutRes.json()) as {
        luts: Record<string, { r: number[]; g: number[]; b: number[] }>;
      };
      installLutFilters(lutData.luts ?? {});
    }
  } catch {
    /* LUTs optional: CSS fallback covers named filters */
  }
  const auto = localStorage.getItem(AUTOSAVE_KEY);
  if (auto) {
    try {
      save = deserialize(auto);
      if (!router.scripts.has(save.position.script)) throw new Error("stale");
    } catch {
      save = freshStart();
    }
  } else {
    save = freshStart();
  }
  if (!save.visited.includes(save.position.script)) save.visited.push(save.position.script);
  // Normalize boot position past any directive/latch runs so the first
  // paint shows text, then log the arrival line for the backlog.
  save.position = skipLatches(router, save.position, save.flags);
  pushLog(router, save);
  render();
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && screen === "read") {
      const hint = document.getElementById("hint");
      if (hint && hint.style.display !== "none") {
        e.preventDefault();
        (document.getElementById("reader") as HTMLElement).click();
      }
    }
  });
}

function freshStart(): SaveData {
  const first = data.scenarios[0]?.script ?? "demo-1";
  return newSave("Haruki", { script: first, event: 0 });
}

function applySettings(): void {
  document.documentElement.style.setProperty("--fontsize", `${settings.fontSize}px`);
}

function notify(msg: string): void {
  const t = document.getElementById("toast")!;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}

const hooks = {
  onChange: () => render(),
  open: (s: string) => {
    if (s === "auto") {
      settings.autoDelay = settings.autoDelay > 0 ? 0 : 2500;
      persistSettings();
      render();
      return;
    }
    if (s === "skip") {
      skipping = !skipping;
      render();
      return;
    }
    screen = s as Screen;
    render();
  },
  notify,
};

function render(): void {
  if (screen === "title") {
    app.innerHTML = `
      <div class="title">
        <h1>WHITE ALBUM 2</h1>
        <div class="subtitle">Extended Edition — web port <span class="dim">(BYOA build${data.demo ? ", demo content" : ""})</span></div>
        ${data.demo ? `<div class="warn-box">No game data found. Copy built <code>data/</code> + <code>assets/</code> per docs/BYOA.md, or press Start to tour the engine demo.</div>` : ""}
        <div class="menu">
          <button data-m="read">Start / Continue <span class="dim">${save.position.script}:${save.position.event}</span></button>
          <button data-m="new">New game (reset progress)</button>
          <button data-m="flow">Flowchart</button>
          <button data-m="guide">Guide</button>
          <button data-m="special">Special</button>
          <button data-m="saves">Save / Load</button>
          <button data-m="settings">Settings</button>
        </div>
        <div class="foot dim">Fan-made web engine. Bring your own legally-owned assets. No game content is bundled.</div>
      </div>`;
    app.querySelectorAll("[data-m]").forEach((b) =>
      b.addEventListener("click", () => {
        const m = (b as HTMLElement).dataset.m!;
        if (m === "new") {
          if (confirm("Reset all progress and start over?")) {
            save = freshStart();
            writeAutosave(localStorage, save);
            screen = "read";
            render();
          }
          return;
        }
        screen = m as Screen;
        render();
      }),
    );
    return;
  }
  if (screen === "read") {
    app.innerHTML = `<div id="reader"></div>`;
    renderReader(app.querySelector("#reader") as HTMLElement, {
      router, save,
      settings: {
        textSpeed: settings.textSpeed,
        autoDelay: settings.autoDelay,
        voiceVol: settings.voiceVol,
      },
      skipping,
      ...hooks,
    });
    return;
  }
  if (screen === "flow") {
    app.innerHTML = `<div class="screen"></div>`;
    const s = app.querySelector(".screen") as HTMLElement;
    renderFlowchart(s, {
      flow: data.flow, save, spoiler: settings.spoiler,
      onBack: () => { screen = "read"; render(); },
    });
    return;
  }
  if (screen === "guide") {
    app.innerHTML = `<div class="screen"></div>`;
    renderGuide(
      app.querySelector(".screen") as HTMLElement,
      data.flow, data.endings as unknown as GuideData, save,
      settings.spoiler,
      () => { screen = "read"; render(); },
    );
    return;
  }
  if (screen === "special") {
    app.innerHTML = `<div class="screen"><div class="screen-head"><h2>Special Contents</h2>
      <div class="dim">Bonus novels and scenes. Novel PDFs open in a new tab.</div></div>
      <h3>Digital novels</h3>
      <ol class="chart">
        <li class="node"><a href="data/novels/The Idol Who Forgot How to Sing.pdf" target="_blank">The Idol Who Forgot How to Sing</a></li>
        <li class="node"><a href="data/novels/The Snow Melts, and Until the Snow Falls.pdf" target="_blank">The Snow Melts, and Until the Snow Falls</a></li>
      </ol>
      <h3>Extra scenarios</h3>
      <ol class="chart" id="spec-list"></ol>
      <button class="back" data-back>← Back</button></div>`;
    const list = app.querySelector("#spec-list") as HTMLElement;
    const specs = data.scenarios.map((s) => s.script).filter((id) =>
      /^(4|5[24]|6|7)/.test(id) && !/^(500[0-4]|510[0-4])$/.test(id)).sort();
    for (const id of specs) {
      const li = document.createElement("li");
      li.className = "node";
      const b = document.createElement("button");
      b.className = "choice-btn";
      b.textContent = `▶ ${id}`;
      b.onclick = () => {
        save = newSave(`special-${id}`, { script: id, event: 0 });
        writeAutosave(localStorage, save);
        screen = "read";
        render();
      };
      li.appendChild(b);
      list.appendChild(li);
    }
    app.querySelector("[data-back]")?.addEventListener("click", () => { screen = "title"; render(); });
    return;
  }
  if (screen === "saves") {
    app.innerHTML = `<div class="screen"></div>`;
    renderSaves(app.querySelector(".screen") as HTMLElement, {
      save,
      onLoad: (s) => {
        if (!router.scripts.has(s.position.script)) {
          notify(`Save points at unknown script ${s.position.script}; refusing.`);
          return;
        }
        save = s;
        save.position = skipLatches(router, save.position, save.flags);
        pushLog(router, save);
        writeAutosave(localStorage, save);
        screen = "read";
        render();
      },
      onBack: () => { screen = "read"; render(); },
      notify,
    });
    return;
  }
  if (screen === "log") {
    app.innerHTML = `<div class="screen"><div class="screen-head"><h2>Backlog</h2></div>
      <ol class="log">${save.log.map((l) =>
        `<li>${l.speaker ? `<b>${escapeHtml(l.speaker)}</b> ` : ""}${escapeHtml(l.text)}</li>`).join("")}
      </ol><button class="back" id="back">← Back</button></div>`;
    app.querySelector("#back")?.addEventListener("click", () => { screen = "read"; render(); });
    return;
  }
  if (screen === "settings") {
    app.innerHTML = `<div class="screen"><div class="screen-head"><h2>Settings</h2></div>
      <label><input type="checkbox" id="sp" ${settings.spoiler ? "checked" : ""}> Spoilers in flowchart/guide (show unvisited options)</label>
      <div><label>Text size <input type="range" id="fs" min="14" max="26" value="${settings.fontSize}"></label></div>
      <div><label>Text speed <input type="range" id="ts" min="0" max="120" step="5" value="${settings.textSpeed}"> <span class="dim">${settings.textSpeed === 0 ? "instant" : settings.textSpeed + "/s"}</span></label></div>
      <div><label>Auto-play delay <input type="range" id="ad" min="0" max="8000" step="500" value="${settings.autoDelay}"> <span class="dim">${settings.autoDelay === 0 ? "off" : (settings.autoDelay / 1000) + "s"}</span></label></div>
      <div><label>Voice volume <input type="range" id="vv" min="0" max="100" value="${Math.round(settings.voiceVol * 100)}"></label></div>
      <div><button class="back" id="back">← Back</button></div></div>`;
    const sp = app.querySelector("#sp") as HTMLInputElement;
    sp.onchange = () => {
      settings.spoiler = sp.checked;
      localStorage.setItem("wa2web.spoiler", sp.checked ? "1" : "0");
    };
    const fs = app.querySelector("#fs") as HTMLInputElement;
    fs.oninput = () => {
      settings.fontSize = clampFont(Number(fs.value));
      persistSettings();
      applySettings();
    };
    const ts = app.querySelector("#ts") as HTMLInputElement;
    ts.oninput = () => {
      settings.textSpeed = Number(ts.value);
      persistSettings();
      render();
    };
    const ad = app.querySelector("#ad") as HTMLInputElement;
    ad.oninput = () => {
      settings.autoDelay = Number(ad.value);
      persistSettings();
      render();
    };
    const vv = app.querySelector("#vv") as HTMLInputElement;
    vv.oninput = () => {
      settings.voiceVol = Number(vv.value) / 100;
      persistSettings();
    };
    app.querySelector("#back")?.addEventListener("click", () => { screen = "title"; render(); });
    return;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

boot();
