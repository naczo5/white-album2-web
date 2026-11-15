// Vite config used only by e2e/smoke.mjs (passed with --config).
//
// The app's normal dev server watches everything under `public/`, including
// the gitignored BYOA `assets/` tree. On a full local build that tree holds
// tens of thousands of user-supplied files; watching it burns the kernel's
// inotify budget (ENOSPC) and makes startup slow and flaky. None of it is
// source, nothing there needs HMR, and the smoke test never loads it (data
// requests are blocked, the demo needs no external assets).
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    watch: {
      ignored: [
        "**/public/assets/**",
        "**/public/data/**",
        "**/build/assets/**",
        "**/build/data/**",
      ],
    },
  },
});
