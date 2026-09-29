/**
 * @fileoverview PT-BR exports of a meeting (Markdown, plain text, JSON).
 * Pure module: no Chrome APIs, unit-tested in node.
 */

import type { State } from "./types";
import {
  confidenceLabel,
  formatClock,
  formatDateTime,
  formatDurationHuman,
  sentimentLabel,
  speakerLabel,
  topicStatusLabel,
} from "./ui/format";

export interface ExportOptions {
  /** Whether an action item was ticked in the side panel. */
  isActionDone?: (task: string) => boolean;
}

/** Best human title: first topic, then the Meet code, then a generic label. */
export function meetingTitle(session: Pick<State, "topics" | "meetingId">): string {
  const topic = session.topics?.find((t) => t?.name?.trim())?.name?.trim();
  if (topic) return topic;
  if (session.meetingId && session.meetingId !== "unknown") return session.meetingId;
  return "Reunião no Google Meet";
}

function meetingWhen(session: State): number {
  return session.startTime || session.savedAt || 0;
}

function meetingDuration(session: State): number {
  if (typeof session.duration === "number" && session.duration > 0) return session.duration;
  if (session.startTime && session.savedAt && session.savedAt > session.startTime) {
    return Math.round((session.savedAt - session.startTime) / 1000);
  }
  return 0;
}

function people(session: State): string[] {
  return Array.from(
    new Set(
      (session.participants ?? [])
        .map((name) => String(name || "").trim())
        .filter((name) => name && name !== "You"),
    ),
  );
}

function transcriptLabel(entry: { timestampLabel?: string; timestamp?: number }): string {
  return entry.timestampLabel || formatClock(entry.timestamp || 0);
}

/** Filename-safe slug: `reuniao-2026-09-29-lancamento-da-versao-2`. */
export function exportFilename(session: State, extension: string): string {
  const when = meetingWhen(session) || Date.now();
  const d = new Date(when);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const slug = meetingTitle(session)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `reuniao-${date}${slug ? `-${slug}` : ""}.${extension}`;
}

export function buildMeetingMarkdown(session: State, options: ExportOptions = {}): string {
  const lines: string[] = [];
  const isDone = options.isActionDone ?? (() => false);

  lines.push(`# ${meetingTitle(session)}`, "");
  const when = meetingWhen(session);
  if (when) lines.push(`- **Data:** ${formatDateTime(when)}`);
  const duration = meetingDuration(session);
  if (duration) lines.push(`- **Duração:** ${formatDurationHuman(duration)}`);
  const participants = people(session);
  if (participants.length) lines.push(`- **Participantes:** ${participants.join(", ")}`);
  if (session.meetingUrl) lines.push(`- **Reunião:** ${session.meetingUrl}`);
  lines.push(`- **Clima:** ${sentimentLabel(session.sentiment)}`, "");

  lines.push("## Resumo", session.summary?.trim() || "_Sem resumo._", "");

  lines.push("## Decisões");
  const decisions = (session.decisions ?? []).filter((d) => d?.text);
  if (decisions.length) {
    for (const d of decisions) {
      const extra = [d.by, d.classification === "tentative" ? "a confirmar" : ""]
        .filter(Boolean)
        .join(", ");
      lines.push(`- ${d.text}${extra ? ` _(${extra})_` : ""}`);
    }
  } else {
    lines.push("_Nenhuma decisão registrada._");
  }
  lines.push("");

  lines.push("## Próximos passos");
  const actions = (session.actionItems ?? []).filter((a) => a?.task);
  if (actions.length) {
    for (const a of actions) {
      let line = `- [${isDone(a.task) ? "x" : " "}] ${a.task}`;
      if (a.owner) line += ` — ${a.owner}`;
      if (a.deadline) line += ` (prazo: ${a.deadline})`;
      if (a.isSpeculative) line += " _(ideia, não confirmada)_";
      lines.push(line);
    }
  } else {
    lines.push("_Nenhum próximo passo registrado._");
  }
  lines.push("");

  const topics = (session.topics ?? []).filter((t) => t?.name);
  if (topics.length) {
    lines.push("## Assuntos");
    for (const t of topics) lines.push(`- ${t.name} (${topicStatusLabel(t.status).toLowerCase()})`);
    lines.push("");
  }

  const open = [
    ...(session.unresolvedDiscussions ?? []),
    ...(session.questionsRaised ?? []),
  ].filter(Boolean);
  if (open.length) {
    lines.push("## Pontos em aberto");
    for (const item of open) lines.push(`- ${item}`);
    lines.push("");
  }

  const insights = (session.keyInsights ?? []).filter((i) => i?.text);
  if (insights.length) {
    lines.push("## Destaques");
    for (const i of insights) lines.push(`- ${i.text}`);
    lines.push("");
  }

  lines.push("## Transcrição");
  const transcript = (session.transcript ?? []).filter((e) => e?.text);
  if (transcript.length) {
    for (const e of transcript) {
      lines.push(`**[${transcriptLabel(e)}] ${speakerLabel(e.speaker)}:** ${e.text}`, "");
    }
  } else {
    lines.push("_Sem transcrição._", "");
  }

  lines.push("---", "_Gerado pelo ValorBrain Meet. Transcrição automática, pode conter erros._");
  return lines.join("\n");
}

export function buildMeetingText(session: State, options: ExportOptions = {}): string {
  const isDone = options.isActionDone ?? (() => false);
  const out: string[] = [meetingTitle(session).toUpperCase(), ""];
  const when = meetingWhen(session);
  if (when) out.push(`Data: ${formatDateTime(when)}`);
  const duration = meetingDuration(session);
  if (duration) out.push(`Duração: ${formatDurationHuman(duration)}`);
  const participants = people(session);
  if (participants.length) out.push(`Participantes: ${participants.join(", ")}`);
  out.push("", "RESUMO", session.summary?.trim() || "(sem resumo)", "");

  out.push("DECISÕES");
  const decisions = (session.decisions ?? []).filter((d) => d?.text);
  out.push(
    ...(decisions.length
      ? decisions.map((d) => `  • ${d.text}${d.by ? ` (${d.by})` : ""}`)
      : ["  (nenhuma)"]),
  );
  out.push("", "PRÓXIMOS PASSOS");
  const actions = (session.actionItems ?? []).filter((a) => a?.task);
  out.push(
    ...(actions.length
      ? actions.map((a) => {
          let line = `  [${isDone(a.task) ? "x" : " "}] ${a.task}`;
          if (a.owner) line += ` — ${a.owner}`;
          if (a.deadline) line += ` (prazo: ${a.deadline})`;
          if (a.confidence && a.confidence !== "high")
            line += ` [confiança ${confidenceLabel(a.confidence)}]`;
          return line;
        })
      : ["  (nenhum)"]),
  );
  out.push("", "TRANSCRIÇÃO");
  const transcript = (session.transcript ?? []).filter((e) => e?.text);
  out.push(
    ...(transcript.length
      ? transcript.map((e) => `  [${transcriptLabel(e)}] ${speakerLabel(e.speaker)}: ${e.text}`)
      : ["  (sem transcrição)"]),
  );
  return out.join("\n");
}

export function buildMeetingJson(session: State): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      generator: "ValorBrain Meet",
      title: meetingTitle(session),
      meetingId: session.meetingId,
      meetingUrl: session.meetingUrl,
      startTime: session.startTime,
      savedAt: session.savedAt,
      durationSeconds: meetingDuration(session),
      participants: people(session),
      summary: session.summary,
      summaryItems: session.summaryItems ?? [],
      topics: session.topics ?? [],
      decisions: session.decisions ?? [],
      actionItems: session.actionItems ?? [],
      keyInsights: session.keyInsights ?? [],
      unresolvedDiscussions: session.unresolvedDiscussions ?? [],
      questionsRaised: session.questionsRaised ?? [],
      contradictions: session.contradictions ?? [],
      sentiment: session.sentiment,
      timeline: session.timeline ?? [],
      transcript: session.transcript ?? [],
    },
    null,
    2,
  );
}
