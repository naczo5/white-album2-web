import { loadManifest } from "./engine/assets";
import { Router } from "./engine/router";
import { AUTOSAVE_KEY, deserialize, newSave, writeAutosave } from "./engine/save";
import type { SaveData } from "./engine/types";
import { loadGameData, type GameData } from "./ui/data";
import { renderFlowchart } from "./ui/flowchart";
import { renderGuide, type GuideData } from "./ui/guide";
import { pushLog, renderReader, setScenarioLookup, skipLatches } from "./ui/reader";
import { renderSaves } from "./ui/saves";
import "./style.css";

type Screen = "title" | "read" | "flow" | "guide" | "saves" | "log" | "settings";

interface Settings {
  spoiler: boolean;
  fontSize: number;
}

const settings: Settings = {
  spoiler: localStorage.getItem("wa2web.spoiler") === "1",
  fontSize: clampFont(Number(localStorage.getItem("wa2web.fontSize") ?? 18)),
};

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
      router, save, ...hooks,
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
      <div><button class="back" id="back">← Back</button></div></div>`;
    const sp = app.querySelector("#sp") as HTMLInputElement;
    sp.onchange = () => {
      settings.spoiler = sp.checked;
      localStorage.setItem("wa2web.spoiler", sp.checked ? "1" : "0");
    };
    const fs = app.querySelector("#fs") as HTMLInputElement;
    fs.oninput = () => {
      settings.fontSize = clampFont(Number(fs.value));
      localStorage.setItem("wa2web.fontSize", String(settings.fontSize));
      applySettings();
    };
    app.querySelector("#back")?.addEventListener("click", () => { screen = "title"; render(); });
    return;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

boot();
