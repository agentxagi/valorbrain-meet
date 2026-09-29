/**
 * Builds the meet.valorbra.in download page into site-dist/.
 *
 * 1. Zips dist/ (run `npm run build` first) reproducibly: entries sorted, no
 *    directory entries or extra attributes, UTC timestamps pinned to the last
 *    commit that touched the extension. The same sources always give the same
 *    bytes, so the published SHA-256 stays valid when only the page changes.
 * 2. Renders site/index.html, filling {{PLACEHOLDERS}} with the version, size,
 *    SHA-256 and date of that zip.
 * 3. Copies the brand tokens, the fonts (with their OFL license) and the page
 *    assets. Publish with scripts/deploy-site.sh.
 *
 * Run with: `npm run site:build`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SITE = join(ROOT, "site");
const OUT = join(ROOT, "site-dist");
const SITE_URL = "https://meet.valorbra.in";
const REPO_URL = "https://github.com/agentxagi/valorbrain-meet";
/** Inputs of the extension build: their last commit pins the zip timestamps. */
const EXTENSION_INPUTS = ["src", "package-lock.json", "vite.config.ts", "LICENSE"];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

const manifest = JSON.parse(readFileSync(join(ROOT, "src/manifest.json"), "utf8"));
const version: string = manifest.version;

const builtManifestPath = join(DIST, "manifest.json");
if (!existsSync(builtManifestPath)) {
  throw new Error("dist/ não encontrado: rode `npm run build` antes.");
}
const builtVersion = JSON.parse(readFileSync(builtManifestPath, "utf8")).version;
if (builtVersion !== version) {
  throw new Error(
    `dist/ é da versão ${builtVersion}, src/manifest.json é ${version}: rode \`npm run build\`.`,
  );
}
if (git(["status", "--porcelain", "--", ...EXTENSION_INPUTS])) {
  console.warn(
    "Aviso: há mudanças não commitadas no código da extensão; o zip não corresponde a um commit.",
  );
}

// ——— Reproducible zip ———
const epoch = Number(git(["log", "-1", "--format=%ct", "--", ...EXTENSION_INPUTS]));
if (!Number.isFinite(epoch) || epoch <= 0)
  throw new Error("Não achei o último commit da extensão.");
const entries = listFiles(DIST).map((file) => relative(DIST, file));
for (const entry of entries) utimesSync(join(DIST, entry), epoch, epoch);

const zipName = `valorbrain-meet-v${version}.zip`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "downloads"), { recursive: true });
const zipPath = join(OUT, "downloads", zipName);
execFileSync("zip", ["-q", "-X", "-D", zipPath, "-@"], {
  cwd: DIST,
  input: `${entries.join("\n")}\n`,
  // DOS timestamps inside a zip are local time: pin the zone.
  env: { ...process.env, TZ: "UTC" },
});

const zipBytes = readFileSync(zipPath);
const sha256 = createHash("sha256").update(zipBytes).digest("hex");
const sizeKb = Math.round(zipBytes.length / 1024);
const releasedAt = new Date(epoch * 1000);
const releaseDate = new Intl.DateTimeFormat("pt-BR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "America/Sao_Paulo",
}).format(releasedAt);

writeFileSync(join(OUT, "downloads", "SHA256SUMS"), `${sha256}  ${zipName}\n`);
writeFileSync(
  join(OUT, "latest.json"),
  `${JSON.stringify(
    {
      version,
      file: zipName,
      url: `${SITE_URL}/downloads/${zipName}`,
      sha256,
      size: zipBytes.length,
      released: releasedAt.toISOString(),
      notes: `${REPO_URL}/releases/tag/v${version}`,
    },
    null,
    2,
  )}\n`,
);

// ——— Page ———
const vars: Record<string, string> = {
  VERSION: version,
  ZIP_NAME: zipName,
  ZIP_URL: `downloads/${zipName}`,
  ZIP_SIZE: `${sizeKb} KB`,
  SHA256: sha256,
  RELEASE_DATE: releaseDate,
  RELEASE_URL: `${REPO_URL}/releases/tag/v${version}`,
  REPO_URL,
  CHROME_MIN: String(manifest.minimum_chrome_version ?? "116"),
  FOLDER_NAME: `valorbrain-meet-v${version}`,
};
const html = readFileSync(join(SITE, "index.html"), "utf8").replace(
  /\{\{([A-Z0-9_]+)\}\}/g,
  (_, key: string) => {
    if (!(key in vars)) throw new Error(`Variável desconhecida em site/index.html: {{${key}}}`);
    return escapeHtml(vars[key]);
  },
);
writeFileSync(join(OUT, "index.html"), html);

cpSync(join(SITE, "site.css"), join(OUT, "site.css"));
cpSync(join(SITE, "site.js"), join(OUT, "site.js"));
cpSync(join(SITE, "assets"), join(OUT, "assets"), { recursive: true });
mkdirSync(join(OUT, "brand"));
cpSync(join(ROOT, "src/brand/valorbrain-tokens.css"), join(OUT, "brand/valorbrain-tokens.css"));
mkdirSync(join(OUT, "fonts"));
for (const file of [
  "fonts.css",
  "hanken-grotesk-latin-var.woff2",
  "jetbrains-mono-latin-var.woff2",
  "OFL.txt",
]) {
  cpSync(join(ROOT, "src/fonts", file), join(OUT, "fonts", file));
}

const pageKb = Math.round(
  listFiles(OUT)
    .filter((file) => !file.endsWith(".zip"))
    .reduce((total, file) => total + statSync(file).size, 0) / 1024,
);
console.log(`site-dist/ pronto: v${version}`);
console.log(`  ${zipName}  ${sizeKb} KB  sha256 ${sha256}`);
console.log(`  zip datado do commit ${releasedAt.toISOString()} · página ${pageKb} KB`);
