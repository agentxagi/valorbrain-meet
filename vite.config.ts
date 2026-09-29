import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.json";

/**
 * Ships the license notices inside the extension package. The MIT license
 * (this project, based on Late Meet) and the SIL OFL 1.1 (bundled Hanken
 * Grotesk and JetBrains Mono fonts) both require them in every distributed copy.
 */
function licenseNotices(): Plugin {
  return {
    name: "vbmeet-license-notices",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "LICENSE",
        source: readFileSync(new URL("./LICENSE", import.meta.url)),
      });
      this.emitFile({
        type: "asset",
        fileName: "OFL-fonts.txt",
        source: readFileSync(new URL("./src/fonts/OFL.txt", import.meta.url)),
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [crx({ manifest }), licenseNotices()],
  build: {
    rollupOptions: {
      input: {
        dashboard: "src/dashboard.html",
        options: "src/options.html",
        popup: "src/popup.html",
        offscreen: "src/offscreen.html",
      },
    },
  },
});
