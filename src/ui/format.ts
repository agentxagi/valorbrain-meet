/**
 * @fileoverview PT-BR formatting helpers shared by popup, side panel and
 * options. Pure functions (no Chrome APIs), unit-tested in node.
 */

import type { ConsolidationReport, RecordCounts } from "../types";

const pad = (n: number) => String(n).padStart(2, "0");

/** `75` → `01:15`; `3725` → `1:02:05`. */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** `45` → `45 s`; `720` → `12 min`; `3900` → `1 h 05 min`. */
export function formatDurationHuman(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} h ${pad(m)} min` : `${h} h`;
}

const DATE_TIME = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const DATE_ONLY = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "long",
  year: "numeric",
});
const TIME_ONLY = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** `29 de set. de 2026, 14:05` (pt-BR locale). */
export function formatDateTime(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? DATE_TIME.format(new Date(ms)) : "";
}

/** `29 de setembro de 2026`. */
export function formatDate(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? DATE_ONLY.format(new Date(ms)) : "";
}

/** `14:05`. */
export function formatTime(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? TIME_ONLY.format(new Date(ms)) : "";
}

/** `agora`, `há 3 min`, `há 2 h`, or the date for anything older than a day. */
export function formatRelative(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diff = Math.max(0, Math.round((now - ms) / 1000));
  if (diff < 45) return "agora";
  if (diff < 3600) return `há ${Math.max(1, Math.round(diff / 60))} min`;
  if (diff < 86_400) return `há ${Math.round(diff / 3600)} h`;
  return formatDateTime(ms);
}

const SENTIMENT_LABELS: Record<string, string> = {
  positive: "Positivo",
  neutral: "Neutro",
  negative: "Negativo",
  mixed: "Misto",
};

export function sentimentLabel(sentiment: string | null | undefined): string {
  return SENTIMENT_LABELS[String(sentiment || "").toLowerCase()] ?? "Neutro";
}

const TOPIC_STATUS_LABELS: Record<string, string> = {
  active: "Em discussão",
  completed: "Concluído",
  unresolved: "Sem conclusão",
};

export function topicStatusLabel(status: string | null | undefined): string {
  return TOPIC_STATUS_LABELS[String(status || "")] ?? "Em discussão";
}

const CONFIDENCE_LABELS: Record<string, string> = {
  high: "alta",
  medium: "média",
  low: "baixa",
};

export function confidenceLabel(confidence: string | null | undefined): string {
  return CONFIDENCE_LABELS[String(confidence || "")] ?? "média";
}

/** Internal speaker placeholders shown as a friendly label. */
export function speakerLabel(speaker: string | null | undefined): string {
  const value = String(speaker || "").trim();
  if (!value || value === "Audio" || value === "Participante") return "Participante";
  if (value === "You") return "Você";
  return value;
}

/** Up to two initials for an avatar. */
export function initials(name: string | null | undefined): string {
  const label = speakerLabel(name);
  const parts = label.split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : label.slice(0, 2);
  return letters.toUpperCase();
}

/** `1 trecho` / `3 trechos`. */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const RECORD_KINDS: Array<[keyof RecordCounts, string]> = [
  ["decisions", "decisões"],
  ["actionItems", "próximos passos"],
  ["topics", "assuntos"],
  ["openPoints", "pontos em aberto"],
];

/**
 * `Registro revisado ao encerrar: decisões 42 → 6 · próximos passos 55 → 14`,
 * only the kinds that changed; empty when nothing did.
 */
export function consolidationLabel(report: ConsolidationReport | null | undefined): string {
  if (report?.undone) return "Revisão do registro desfeita.";
  if (!report?.before || !report.after) return "";
  const changes = RECORD_KINDS.flatMap(([key, label]) => {
    const before = Number(report.before[key]) || 0;
    const after = Number(report.after[key]) || 0;
    return before === after ? [] : [`${label} ${before} → ${after}`];
  });
  if (changes.length === 0) return "";
  const local = report.mode === "local" ? " (revisão local)" : "";
  return `Registro revisado ao encerrar${local}: ${changes.join(" · ")}`;
}

/** Hides the middle of a secret: `vbm_ab…9f3c`. */
export function maskSecret(secret: string | null | undefined): string {
  const value = String(secret || "");
  if (value.length <= 10) return value ? "••••" : "";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Host of a URL for display (`valorbrain-api.valor.digital`). */
export function hostOf(url: string | null | undefined): string {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url || "");
  }
}
