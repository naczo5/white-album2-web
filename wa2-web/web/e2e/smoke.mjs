#!/usr/bin/env node
// Repeatable browser smoke test for the player (no game assets required).
//
// Boots the Vite dev server on a free port (or uses WA2_SMOKE_URL), launches
// the locally cached Chromium through playwright-core, blocks `data/**` so
// the built-in asset-free demo is always used, then exercises the title,
// reader, save and load paths. Exits nonzero on the first failure.
//
//   npm run smoke
//   WA2_SMOKE_URL=http://127.0.0.1:5173 npm run smoke
//   WA2_CHROME=/path/to/chrome npm run smoke
//
// The browser is never downloaded by this script: playwright-core needs an
// existing executable (WA2_CHROME, or the Playwright cache path below).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.WA2_CHROME || chromium.executablePath();
const EXTERNAL_URL = process.env.WA2_SMOKE_URL || "";
const STEP_TIMEOUT = 15_000;
const BOOT_TIMEOUT = 60_000;

const report = [];
/** Tail of the Vite output; printed only when the run fails. */
let viteLog = "";
function pass(step, detail = "") {
  report.push(`ok   ${step}${detail ? ` — ${detail}` : ""}`);
}
function fail(step, err) {
  const msg = err instanceof Error ? err.message : String(err);
  report.push(`FAIL ${step} — ${msg}`);
}
function printReport() {
  for (const line of report) console.log(line);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill(); } catch { /* already gone */ }
  }
}

/** Remove ANSI SGR escape sequences (colour/bold) from terminal output. */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Spawn `vite` from web/ on a free port and resolve once it prints its URL. */
async function startVite() {
  const viteBin = path.join(WEB_ROOT, "node_modules", ".bin",
    process.platform === "win32" ? "vite.cmd" : "vite");
  if (!existsSync(viteBin)) {
    throw new Error(`vite not installed at ${viteBin}; run npm install in wa2-web/web`);
  }
  const port = await freePort();
  // The smoke config is the normal dev app minus watchers for the huge,
  // gitignored public/assets and public/data BYOA trees (see that file).
  const child = spawn(viteBin, [
    "--config", "e2e/vite.smoke.config.mjs",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--strictPort",
  ], {
    cwd: WEB_ROOT,
    detached: process.platform !== "win32",
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`vite did not print a URL within ${BOOT_TIMEOUT / 1000}s:\n${output}`));
      }, BOOT_TIMEOUT);
      const onData = (chunk) => {
        output += chunk.toString();
        viteLog = output;
        // Vite colours its banner when FORCE_COLOR/CI is set, splitting the
        // port with SGR escapes (`127.0.0.1:\x1b[1m5173\x1b[22m/`); strip them.
        const m = stripAnsi(output).match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/?/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0].replace(/\/?$/, "/"));
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`vite exited before it was ready (code ${code}):\n${output}`));
      });
    });
    return { url, child };
  } catch (err) {
    killTree(child);
    throw err;
  }
}

/** Wait until the reader displays a real line and return its text. */
async function readLine(page) {
  const line = page.locator("#textbox .narrate, #textbox .say").first();
  await line.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  const text = (await line.innerText()).replace(/\s+/g, " ").trim();
  if (!text) throw new Error("dialogue line is empty");
  return text;
}

/** Vite's dependency optimizer reloads the page once on the first browser
 * visit. Absorb that reload in a throwaway context so the scenario below
 * never races a navigation or collects its aborted module requests. */
async function warmUp(browser, url) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route((u) => !u.pathname.startsWith("/@fs/") && u.pathname.includes("/data/"),
      (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: BOOT_TIMEOUT });
    await page.locator(".title-logo h1").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await page.waitForLoadState("networkidle");
    // The optimize reload lands shortly after the first paint.
    await page.waitForTimeout(1500);
  } catch {
    // Warm-up is best-effort: the scenario reports real failures.
  } finally {
    await context.close().catch(() => {});
  }
}

async function run(url) {
  if (!existsSync(CHROME)) {
    throw new Error(
      `Chromium not found at ${CHROME}. Set WA2_CHROME to a compatible chrome/headless_shell binary.`,
    );
  }

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  await warmUp(browser, url);
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  let blockedData = 0;

  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // The intentionally blocked data routes produce a browser 404 line;
    // everything else is a real console error.
    const text = msg.text();
    if (/Failed to load resource/i.test(text) && /\b404\b/.test(text)) return;
    consoleErrors.push(text);
  });
  page.on("requestfailed", (req) => {
    const reason = req.failure()?.errorText ?? "unknown";
    failedRequests.push(`${req.method()} ${req.url()} (${reason})`);
  });

  // Deterministically use the built-in demo: no game data from a stale
  // web/public/data copy and no external pack. The app falls back to the
  // demo when data is unavailable, which is the path under test.
  // `/@fs/` is Vite's dev-server source path: the committed
  // data/sys-slots.json import must still load or the app cannot boot.
  const isRuntimeData = (url) =>
    !url.pathname.startsWith("/@fs/") && url.pathname.includes("/data/");
  await page.route(isRuntimeData, (route) => {
    blockedData += 1;
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });

  // Instant text and no auto-advance make line stepping deterministic.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("wa2web.textSpeed", "0");
      localStorage.setItem("wa2web.autoDelay", "0");
    } catch {
      /* about:blank has no storage; the app origin gets a fresh document */
    }
  });

  try {
    // --- title -----------------------------------------------------------
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: BOOT_TIMEOUT });
    const title = await page.title();
    if (!/WHITE ALBUM 2/i.test(title)) throw new Error(`unexpected document.title: ${title}`);
    await page.locator(".title-logo h1").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    pass("title screen", title);

    // --- extras (galleries are locked without a profile, but must render) -
    await page.getByRole("button", { name: "Extras" }).click();
    await page.locator(".extras-tabs").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    for (const tab of [/CG gallery/, /Music/, /Scenes/]) {
      await page.getByRole("tab", { name: tab }).click();
      await page.locator("#extras-panel").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    }
    await page.getByRole("button", { name: /Back/ }).click();
    await page.locator(".title-logo h1").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    pass("extras screen", "CG / Music / Scenes tabs render");

    // --- start the demo --------------------------------------------------
    await page.getByRole("button", { name: /Start demo/ }).click();
    await page.locator("#reader").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    const first = await readLine(page);
    if (/Loading voice/.test(first)) throw new Error("demo line is stuck loading voice");
    pass("demo reader", first);

    // --- advance 3 lines (line 1 -> line 4) ------------------------------
    const seen = [first];
    for (let i = 0; i < 3; i++) {
      await page.locator("#stage").click();
      await page.waitForTimeout(120);
      const next = await readLine(page);
      if (next === seen[seen.length - 1]) {
        throw new Error(`click ${i + 1} did not advance past: ${next}`);
      }
      seen.push(next);
    }
    const savedLine = seen[seen.length - 1];
    pass("advance", `${seen.length} lines stepped; at "${savedLine}"`);

    // --- save a named slot ----------------------------------------------
    await page.locator('.reader [data-act="saves"]').click();
    await page.getByRole("heading", { name: "Save / Load" }).waitFor({ timeout: STEP_TIMEOUT });
    await page.locator('[data-save="0"]').click();
    await page.getByText("Saved to slot.").waitFor({ timeout: STEP_TIMEOUT });
    const slotRow = page.locator(".slots > li").filter({ hasText: "Haruki" }).first();
    await slotRow.waitFor({ timeout: STEP_TIMEOUT });
    pass("save slot", (await slotRow.innerText()).replace(/\s+/g, " ").trim());

    // --- reload from disk, then load the slot ---------------------------
    await page.reload({ waitUntil: "domcontentloaded", timeout: BOOT_TIMEOUT });
    await page.locator(".title-logo h1").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Save / Load" }).click();
    await page.getByRole("heading", { name: "Save / Load" }).waitFor({ timeout: STEP_TIMEOUT });
    await slotRow.waitFor({ timeout: STEP_TIMEOUT });
    await page.locator('[data-load="0"]').click();
    await page.locator("#reader").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    const restored = await readLine(page);
    if (restored !== savedLine) {
      throw new Error(`loaded line differs\n  saved:    ${savedLine}\n  restored: ${restored}`);
    }
    pass("load slot", restored);

    // --- diagnostics -----------------------------------------------------
    if (pageErrors.length > 0) {
      throw new Error(`page errors:\n  ${pageErrors.join("\n  ")}`);
    }
    pass("no page errors");
    if (consoleErrors.length > 0) {
      throw new Error(`console errors:\n  ${consoleErrors.join("\n  ")}`);
    }
    pass("no console errors");
    if (blockedData === 0) {
      throw new Error("demo path was not exercised: no data request was blocked");
    }
    // The blocked data routes are answered with 404, so they are not
    // request failures; any genuinely failed request is a real failure.
    if (failedRequests.length > 0) {
      throw new Error(`failed requests:\n  ${failedRequests.join("\n  ")}`);
    }
    pass("no failed requests", `${blockedData} data request(s) intentionally 404`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

let vite = null;
let failure = null;
try {
  if (!EXTERNAL_URL) {
    const started = await startVite();
    vite = started.child;
    pass("vite ready", started.url);
    await run(started.url);
  } else {
    pass("using WA2_SMOKE_URL", EXTERNAL_URL);
    await run(EXTERNAL_URL);
  }
} catch (err) {
  failure = err;
  fail("smoke", err);
} finally {
  killTree(vite);
  printReport();
  if (failure && viteLog) {
    console.error(`\n--- vite output (tail) ---\n${viteLog.slice(-3000)}`);
  }
}
if (failure) {
  console.error("\nSmoke test failed.");
  process.exitCode = 1;
} else {
  console.log("\nSmoke test passed.");
}
