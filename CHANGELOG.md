# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-09-18

### 🐛 Bug Fixes

- Popup first-run setup no longer nags forever when AI Providers are already configured — setup is considered done once any provider block is saved or a legacy OpenAI vault key exists ([#1](https://github.com/agentxagi/valorbrain-meet/pull/1))
- Popup setup view now leads with an **Open Settings — AI Providers** shortcut and describes the OpenAI vault key as optional/legacy

## [1.3.0] - 2026-09-18

### 🚀 Features

- Provider-agnostic AI pipeline: independent transcription and summary providers configured in a new **AI Providers** options section (profile dropdown + editable Base URL / API Key / Model, per-block connection test). Defaults: **Local Whisper (faster-whisper)** `http://127.0.0.1:8394/v1` + **Z.ai GLM** `https://api.z.ai/api/paas/v4` (`glm-5.3-flash`); OpenAI remains a first-class profile ([#1](https://github.com/agentxagi/valorbrain-meet/pull/1))
- URL validator now accepts plain HTTP for loopback (`localhost`, `127.0.0.0/8`, `::1`) and private LAN IPv4 addresses; all other hosts still require HTTPS ([#1](https://github.com/agentxagi/valorbrain-meet/pull/1))
- Manifest: `host_permissions` and CSP `connect-src` for `api.z.ai`, `localhost`, `127.0.0.1` (port wildcards) and `*.valor.digital`; renamed to **ValorBrain Meet** ([#1](https://github.com/agentxagi/valorbrain-meet/pull/1))

### ♻️ Refactors

- All AI endpoints in `background.ts` / `api.ts` read from provider settings — zero hardcoded provider URLs. Transcription no longer requires an API key ([#1](https://github.com/agentxagi/valorbrain-meet/pull/1))
- AI Providers UI and provider-agnostic connection validation; popup capture start no longer blocks without an OpenAI key ([#1](https://github.com/agentxagi/valorbrain-meet/pull/1))

### 📚 Documentation

- README provider setup guide + manifest CSP platform limitation; `CHANGES.md` with the manual **Load unpacked** step ([#1](https://github.com/agentxagi/valorbrain-meet/pull/1))

## [1.0.0] - 2025-05-13

### Added

- Native Google Meet integration via Chrome `tabCapture` API — no bot participants.
- Real-time audio capture using Offscreen Documents and `MediaRecorder` API.
- ElevenLabs Scribe v2 integration for high-fidelity, multilingual transcription.
- OpenAI Whisper fallback for transcription when ElevenLabs is unavailable.
- OpenAI GPT-powered summarization with rolling context window.
- Late-joiner detection with automated private briefing overlays.
- Host-first (1+N) participant tracking for accurate reporting.
- Side panel dashboard with live summary, topics, decisions, action items, and sentiment analysis.
- Premium monochrome UI with glassmorphism effects and smooth animations.
- BYOK (Bring Your Own Key) model — users provide their own API keys.
- Options page for API key configuration (ElevenLabs + OpenAI).
- Local-first storage using `chrome.storage.local` — no external databases.
- Session save/discard workflow — nothing persists without user consent.
- Manifest V3 compliant architecture with TypeScript and Vite 5 build system.

### Removed

- All Supabase/backend dependencies (migrated to fully local architecture).

### Security

- No telemetry, no analytics, no user tracking.
- API keys stored only in local browser storage.
- No data transmitted to any server other than user-configured API endpoints.
