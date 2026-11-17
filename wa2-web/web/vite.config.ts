import { defineConfig } from "vite";

const siteUrl = (process.env.VITE_SITE_URL || "https://setsuna.rocks").replace(/\/+$/, "");

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "wa2-site-url",
      transformIndexHtml(html) {
        return siteUrl === "https://setsuna.rocks"
          ? html
          : html.replaceAll("https://setsuna.rocks", siteUrl);
      },
    },
  ],
  // Keep the player bundle out of `assets/`: that directory is the BYOA game
  // asset root (manifest.json, bg/, voice/, ...), and pack_site.py copies
  // both trees into the same self-contained package.
  build: { outDir: "dist", target: "es2022", assetsDir: "static" },
  // BYOA asset/data trees can hold tens of thousands of files; watching them
  // exhausts the host's inotify budget and makes the dev server hang/ENOSPC.
  // They are build inputs served statically, not source to hot-reload.
  server: { watch: { ignored: ["**/public/assets/**", "**/public/data/**", "**/dist/**"] } },
});
