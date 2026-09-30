#!/usr/bin/env node
// End-to-end run of the built extension (dist/) in Chrome for Testing:
// fake Meet / Zoom / Teams pages, real tab capture + offscreen recorder +
// segmenter, and local mocks for the transcription server, the LLM and the
// ValorBrain API. Not part of `npm test` (needs a browser and a display).
//
//   npm run build
//   CHROME_PATH=/path/to/chrome-for-testing/chrome \
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   xvfb-run -a node tests/e2e/run.mjs
//
// Requires espeak-ng and ffmpeg (the meeting audio is synthesized).
//
// The Meet recording starts the way a person starts it: the Alt+Shift+G
// shortcut, pressed through the X server (tests/e2e/xkey.py, python-xlib).
// Chrome only lets an extension capture a tab it was invoked on, and a stream
// id obtained any other way (e.g. --allowlisted-extension-id) is refused by the
// recorder with "Requested device not found". Set XKEY_PYTHON to a Python
// with python-xlib. Zoom and Teams start the same way.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { meetPage, teamsPage, zoomPage } from "./pages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = resolve(here, "../../dist");
const CHROME_PATH = process.env.CHROME_PATH;
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE || "playwright-core";
const XKEY_PYTHON = process.env.XKEY_PYTHON || "python3";
if (!CHROME_PATH) {
  console.error(
    "CHROME_PATH is required (Chrome for Testing: branded Chrome ignores --load-extension).",
  );
  process.exit(2);
}

/** Presses the recording shortcut on the real X display. */
function pressRecordShortcut() {
  execFileSync(XKEY_PYTHON, [join(here, "xkey.py"), "Alt_L+Shift_L+g"]);
}
const { chromium } = await import(
  PLAYWRIGHT_CORE.startsWith("/")
    ? pathToFileURL(join(PLAYWRIGHT_CORE, "index.mjs")).href
    : PLAYWRIGHT_CORE
);

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Chrome's id for an unpacked extension: sha256(absolute path) → a..p. */
function extensionIdForPath(path) {
  const hex = createHash("sha256").update(path).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

// ——— Audio ———

const work = mkdtempSync(join(tmpdir(), "vbmeet-e2e-"));
const tabWav = join(work, "tab.wav");
const micWav = join(work, "mic.wav");
{
  const sentences = [
    "Bom dia pessoal. Na Resend eles usam o gbrain para os agentes.",
    "O Replit e o Supabase também entram nessa conta.",
    "Vamos marcar a próxima conversa com a Ana na semana que vem.",
  ];
  const parts = [];
  sentences.forEach((text, i) => {
    const file = join(work, `s${i}.wav`);
    execFileSync("espeak-ng", ["-v", "pt-br", "-s", "150", "-w", file, text]);
    parts.push(file);
  });
  const silence = (seconds, name) => {
    const file = join(work, name);
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=22050:cl=mono`,
      "-t",
      String(seconds),
      file,
    ]);
    return file;
  };
  const gap = silence(2.5, "gap.wav");
  const lead = silence(1, "lead.wav");
  const list = [lead, ...parts.flatMap((p) => [p, gap]), gap].map((f) => `file '${f}'`).join("\n");
  const listFile = join(work, "list.txt");
  execFileSync("bash", ["-c", `printf '%s\\n' "$1" > "$2"`, "_", list, listFile]);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-ar",
    "48000",
    "-ac",
    "1",
    tabWav,
  ]);
  // The fake microphone is silent: the tab is the only voice, so the mocked
  // transcription answers line up with the tab segments.
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    "120",
    micWav,
  ]);
}

// ——— Mocks: transcription, LLM, ValorBrain ———

const STT_LINES = [
  "Bom dia pessoal. Na Resend eles usam o D-Brain para os agentes.",
  "O Rapplet e o Supabase também entram nessa conta.",
  "Vamos marcar a próxima conversa com a Ana na semana que vem.",
];
const seen = { sttPrompts: [], vocabulary: [], aliases: [], stores: [] };

function readBody(req) {
  return new Promise((resolveBody) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
  });
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const SUMMARY = {
  summary:
    "A Resend usa o gbrain e o Replit com os agentes; a próxima conversa fica para a semana que vem.",
  summaryItems: [],
  topics: [{ name: "Parceria com a Resend", status: "active" }],
  currentTopic: "Parceria com a Resend",
  decisions: [],
  actionItems: [{ task: "Marcar a próxima conversa", owner: "Ana" }],
  sentiment: "positive",
  keyInsights: [],
  contradictions: [],
  questionsRaised: [],
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const body = await readBody(req);
  if (url.pathname === "/v1/audio/transcriptions") {
    const raw = body.toString("latin1");
    const prompt = /name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)?.[1] ?? "";
    seen.sttPrompts.push(Buffer.from(prompt, "latin1").toString("utf8"));
    const text = STT_LINES[seen.sttPrompts.length - 1] ?? "";
    return send(res, 200, {
      text,
      duration: 4,
      segments: text
        ? [{ text: ` ${text}`, no_speech_prob: 0.02, avg_logprob: -0.2, start: 0 }]
        : [],
    });
  }
  if (url.pathname === "/v1/chat/completions") {
    const request = JSON.parse(body.toString("utf8") || "{}");
    const system = String(request.messages?.[0]?.content ?? "");
    const content = /revisa a grafia/.test(system)
      ? { correcoes: [{ de: "Rapplet", para: "Replit" }] }
      : SUMMARY;
    return send(res, 200, {
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
  }
  if (url.pathname === "/api/v1/meet/vocabulary") {
    seen.vocabulary.push(Object.fromEntries(url.searchParams));
    return send(res, 200, {
      terms: [
        { term: "gbrain", kind: "tool", reason: "meeting" },
        { term: "Supabase", kind: "service", reason: "related" },
        { term: "Resend", kind: "service", reason: "related" },
      ],
      corrections: [{ from: "D-Brain", to: "gbrain" }],
      participants: [],
    });
  }
  if (url.pathname === "/api/v1/meet/aliases") {
    const payload = JSON.parse(body.toString("utf8"));
    seen.aliases.push(payload);
    return send(res, 201, { recorded: payload.aliases, skipped: [] });
  }
  if (url.pathname === "/api/v1/memory/store") {
    seen.stores.push(JSON.parse(body.toString("utf8")));
    return send(res, 200, { ok: true, docid: "#e2e001", path: "meetings/observations/e2e.md" });
  }
  if (url.pathname === "/api/v1/memory/working-context" || url.pathname === "/health") {
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: `unexpected ${req.method} ${url.pathname}` });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const MOCK = `http://127.0.0.1:${server.address().port}`;

// ——— Browser ———

const extensionId = extensionIdForPath(EXTENSION_DIR);
const profile = mkdtempSync(join(tmpdir(), "vbmeet-e2e-profile-"));
// The microphone permission the user grants once (Settings → Microfone),
// written as Chrome stores it. CDP cannot grant it to an extension origin.
{
  const allow = { last_modified: "13370000000000000", setting: 1 };
  const origin = `chrome-extension://${extensionId}`;
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(
    join(profile, "Default", "Preferences"),
    JSON.stringify({
      profile: {
        content_settings: {
          exceptions: {
            media_stream_mic: { [`${origin},*`]: allow, [`${origin}/,*`]: allow },
          },
        },
      },
    }),
  );
}
// Chrome is launched directly and driven over CDP: Playwright's own launch
// flags break tab capture ("Requested device not found" in the recorder).
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  CHROME_PATH,
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    // No --use-fake-ui-for-media-stream: its auto-approver breaks the tab
    // stream ("Requested device not found"); the microphone permission is
    // granted to the extension origin below, as the user's click would.
    ...(process.env.E2E_NO_FAKE_DEVICE
      ? []
      : ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${micWav}`]),
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-component-extensions-with-background-pages",
    "--password-store=basic",
    // Only for a root shell (CI containers); a normal user keeps the sandbox.
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "--window-position=0,0",
    "--window-size=1200,850",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", process.env.E2E_DEBUG ? "inherit" : "ignore"] },
);
let browser;
for (let i = 0; i < 60 && !browser; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`).catch(() => undefined);
}
if (!browser) {
  chrome.kill("SIGTERM");
  throw new Error("Chrome did not open the debugging port");
}
const context = browser.contexts()[0];

const pages = {
  "meet.google.com": meetPage(),
  "app.zoom.us": zoomPage(),
  "teams.microsoft.com": teamsPage(),
};
await context.route(
  /^https:\/\/(meet\.google\.com|app\.zoom\.us|teams\.microsoft\.com)\//,
  (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/e2e-audio/tab.wav") {
      return route.fulfill({ status: 200, contentType: "audio/wav", body: readFileSync(tabWav) });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: pages[url.hostname],
    });
  },
);

let exitCode = 0;
try {
  const ours = (w) => w.url().startsWith(`chrome-extension://${extensionId}/`);
  const worker =
    context.serviceWorkers().find(ours) ??
    (await context.waitForEvent("serviceworker", { predicate: ours, timeout: 15_000 }));
  check("extension loaded with the computed id", worker.url().includes(extensionId), worker.url());
  if (process.env.E2E_DEBUG) {
    worker.on("console", (msg) => console.log(`[sw:${msg.type()}] ${msg.text()}`));
  }

  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/src/options.html`);
  await ext.evaluate(async (mock) => {
    await chrome.storage.local.set({
      onboardingCompleted: true,
      settings: {
        onboardingCompleted: true,
        selfName: "Gus Teste",
        transcriptionLanguage: "pt",
        recordingChatNotice: true,
        "vb.baseUrl": mock,
        "vb.apiToken": "vbm_e2e_token",
      },
      "provider.transcription": {
        profile: "custom",
        baseUrl: `${mock}/v1`,
        apiKey: "",
        model: "whisper-1",
      },
      "provider.summary": {
        profile: "custom",
        baseUrl: `${mock}/v1`,
        apiKey: "",
        model: "mock-llm",
      },
    });
  }, MOCK);

  const sw = (message) => ext.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const waitUntil = async (probe, label, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  // ——— Google Meet: the whole path ———
  const meet = await context.newPage();
  await meet.goto("https://meet.google.com/abc-defg-hij");
  await meet.waitForSelector("#vbm-pill", { timeout: 15_000 });
  await meet.bringToFront();
  if (process.env.E2E_DEBUG) {
    const commands = await ext.evaluate(() => chrome.commands.getAll());
    console.log("commands:", JSON.stringify(commands));
    await meet.evaluate(() => {
      window.__keys = [];
      window.addEventListener("keydown", (e) =>
        window.__keys.push(`${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${e.key}`),
      );
    });
  }
  pressRecordShortcut();
  if (process.env.E2E_DEBUG) {
    await new Promise((r) => setTimeout(r, 1500));
    console.log("page saw keys:", JSON.stringify(await meet.evaluate(() => window.__keys)));
  }
  const start = await waitUntil(
    async () => {
      const s = await sw({ type: "GET_STATE" });
      return s?.audioActive ? s : null;
    },
    "recording started by the shortcut",
    20_000,
  ).catch((err) => ({ error: String(err) }));
  check(
    "Meet: Alt+Shift+G started the recording from the real tab stream",
    start?.audioActive === true,
    start?.error ?? start?.meetingId,
  );
  check("Meet: microphone joined the capture", start?.micActive === true);
  const played = await meet.evaluate(() => window.__e2ePlay());
  check("Meet: meeting audio playing in the tab", played === true, String(played));

  const notice = await waitUntil(
    () => meet.evaluate(() => window.__chatMessages?.[0] ?? null),
    "recording notice in the Meet chat",
  );
  check(
    "Meet: recording notice posted in the call chat",
    /ValorBrain Meet/.test(notice),
    notice.slice(0, 80),
  );

  await waitUntil(() => seen.vocabulary.length > 0, "graph vocabulary request");
  const participantsAsked = seen.vocabulary.map((v) => v.participants ?? "").join(" | ");
  check(
    "Meet: graph vocabulary asked with the call's participants",
    /Gus Teste/.test(participantsAsked) && /Ana Souza/.test(participantsAsked),
    participantsAsked,
  );

  const state = await waitUntil(
    async () => {
      const s = await sw({ type: "GET_FULL_STATE" });
      return (s?.transcript?.length ?? 0) >= 2 ? s : null;
    },
    "two transcript lines",
    60_000,
  );
  check(
    "Meet: learned correction applied as the line arrived",
    state.transcript.some((e) => /usam o gbrain/.test(e.text)) &&
      !state.transcript.some((e) => /D-Brain/.test(e.text)),
    state.transcript.map((e) => `${e.speaker}: ${e.text}`).join(" / "),
  );
  check(
    "Meet: graph terms in the Whisper prompt",
    seen.sttPrompts.some((p) => /gbrain/.test(p) && /Supabase/.test(p)),
    seen.sttPrompts[0]?.slice(0, 120),
  );

  await meet.evaluate(() => window.__e2eLeave());
  await waitUntil(() => seen.stores.length > 0, "meeting delivered to ValorBrain", 90_000);
  const stored = seen.stores[0].content;
  const transcriptPart = stored.split("## Transcrição")[1] ?? "";
  check(
    "Meet: delivered transcript has the right spellings",
    /gbrain/.test(transcriptPart) &&
      /Replit/.test(transcriptPart) &&
      !/Rapplet|D-Brain/.test(transcriptPart),
    /Termos corrigidos[^\n]*/.exec(stored)?.[0] ?? "",
  );
  await waitUntil(() => seen.aliases.length > 0, "aliases taught", 20_000);
  check(
    "Meet: only the review's fix taught back to the graph",
    JSON.stringify(seen.aliases[0]) ===
      JSON.stringify({ aliases: [{ from: "Rapplet", to: "Replit" }] }),
    JSON.stringify(seen.aliases[0]),
  );
  await meet.close();

  // ——— Zoom and Teams: adapters (fake DOM) ———
  for (const [label, url, expectedName] of [
    ["Zoom", "https://app.zoom.us/wc/85012345678/join", "Carla Dias"],
    [
      "Teams",
      "https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_NjA4YzE4ZmQtYWJjZC00ZWY@thread.v2/0",
      "Diego Braga",
    ],
  ]) {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector("#vbm-pill", { timeout: 15_000 });
    await page.bringToFront();
    pressRecordShortcut();
    const started = await waitUntil(
      async () => {
        const s = await sw({ type: "GET_STATE" });
        return s?.audioActive ? s : null;
      },
      `${label} recording started`,
      20_000,
    ).catch((err) => ({ error: String(err) }));
    check(
      `${label}: the shortcut started the recording`,
      started?.audioActive === true,
      started?.error ?? started?.meetingId,
    );
    const posted = await waitUntil(
      () => page.evaluate(() => window.__chatMessages?.[0] ?? null),
      `${label} chat notice`,
    );
    check(`${label}: recording notice posted in the (fake) chat`, /ValorBrain Meet/.test(posted));
    const names = await waitUntil(async () => {
      const s = await sw({ type: "GET_FULL_STATE" });
      return s?.participants?.includes(expectedName) ? s.participants : null;
    }, `${label} participants`);
    check(
      `${label}: participants read, own name marker removed`,
      !names.some((n) => /\(/.test(n)),
      names.join(", "),
    );
    await sw({ type: "MANUAL_STOP_AUDIO" });
    await waitUntil(
      async () => (await sw({ type: "GET_STATE" }))?.audioActive === false,
      `${label} stop`,
    );
    await page.close();
  }
} catch (err) {
  check("run completed", false, err?.stack || String(err));
} finally {
  await browser.close().catch(() => {});
  chrome.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  server.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) exitCode = 1;
  process.exit(exitCode);
}
