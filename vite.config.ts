import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.json";

/** The npm package a bundled module comes from, and its folder (null for our own code). */
function bundledPackage(id: string): { name: string; dir: string } | null {
  const path = id.replace(/^\0/, "").split("?")[0].replace(/\\/g, "/");
  const marker = path.lastIndexOf("/node_modules/");
  if (marker < 0) return null;
  const at = marker + "/node_modules/".length;
  const [first, second] = path.slice(at).split("/");
  const name = first.startsWith("@") ? `${first}/${second}` : first;
  return { name, dir: path.slice(0, at) + name };
}

/** Name, version and license text of each package, as its own files have them. */
function packageNotice(name: string, dir: string): string {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const file = readdirSync(dir).find((entry) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(entry));
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const text = file
    ? readFileSync(join(dir, file), "utf8").trim()
    : `The package ships no license file; its package.json declares ${pkg.license}.${
        repository ? ` Source: ${repository}` : ""
      }`;
  return `${name} ${pkg.version} (${pkg.license})\n\n${text}`;
}

/**
 * Ships the license notices inside the extension package. The MIT license
 * (this project, based on Late Meet) and the SIL OFL 1.1 (bundled Hanken
 * Grotesk and JetBrains Mono fonts) both require them in every distributed
 * copy, as do the licenses of the npm packages in the bundle (the Anthropic
 * SDK and what it brings): THIRD_PARTY_NOTICES.txt, read from node_modules.
 */
function licenseNotices(): Plugin {
  return {
    name: "vbmeet-license-notices",
    apply: "build",
    generateBundle(_options, bundle) {
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
      // Only code that made it into a chunk: a module tree-shaken away renders nothing.
      const packages = new Map<string, string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const [id, module] of Object.entries(output.modules)) {
          const found = module.renderedLength > 0 ? bundledPackage(id) : null;
          if (found) packages.set(found.name, found.dir);
        }
      }
      const notices = [...packages]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, dir]) => packageNotice(name, dir));
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.txt",
        source: `${[
          "ValorBrain Meet includes the npm packages below, each with the license it ships with.",
          ...notices,
        ].join(`\n\n${"-".repeat(72)}\n\n`)}\n`,
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
