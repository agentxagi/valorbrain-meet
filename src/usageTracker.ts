// ——— API Cost & Token Usage Tracker ———
// Persists daily stats in chrome.storage.local under the key "usageStats".

import { DayStats } from "./types";

/** Pricing per 1,000 tokens in USD (input / output). */
const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "gpt-4o": { input: 0.005, output: 0.015 },
  "gpt-4-turbo": { input: 0.01, output: 0.03 },
  "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
  // Whisper is billed per minute of audio, tracked separately
  "whisper-1": { input: 0, output: 0 },
};

/** Whisper is billed at $0.006 per minute of audio. */
const WHISPER_PRICE_PER_SECOND = 0.006 / 60;

/** Returns today's date string key in local YYYY-MM-DD format. */
export function getTodayKey(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Reads the entire usageStats map from local storage. */
export async function getUsageStats(): Promise<Record<string, DayStats>> {
  const result = await chrome.storage.local.get("usageStats");
  return (result.usageStats as Record<string, DayStats>) || {};
}

export interface UsageDelta {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Seconds of audio processed by OpenAI Whisper. */
  whisperSeconds?: number;
  /** Seconds of audio processed by a local/self-hosted STT server (zero cost). */
  localSeconds?: number;
  /** The model used for this chat completion (for pricing lookup). */
  model?: string;
}

/**
 * Resolves the per-token pricing for a chat model. Only OpenAI models have a
 * published price table; unknown models (e.g. Z.ai GLM or custom deployments)
 * are treated as free until a provider price list is added.
 */
function pricingForModel(model: string | undefined): { input: number; output: number } | null {
  if (!model) return null;
  return OPENAI_PRICING[model] ?? null;
}

function chatCostFor(
  promptTokens: number,
  completionTokens: number,
  model: string | undefined,
): number {
  const pricing = pricingForModel(model);
  if (!pricing) return 0;
  return (promptTokens / 1000) * pricing.input + (completionTokens / 1000) * pricing.output;
}

export function calculateDeltaCost(delta: UsageDelta): {
  tokens: number;
  cost: number;
  audioSeconds: number;
} {
  const pt = delta.promptTokens ?? 0;
  const ct = delta.completionTokens ?? 0;
  const tt = delta.totalTokens ?? pt + ct;
  const ws = delta.whisperSeconds ?? 0;
  const ls = delta.localSeconds ?? 0;

  const cost = chatCostFor(pt, ct, delta.model) + ws * WHISPER_PRICE_PER_SECOND;

  return {
    tokens: tt,
    cost,
    audioSeconds: ws + ls,
  };
}

// Module-level queue to serialize local storage writes and prevent race conditions
let writeQueue = Promise.resolve();

/**
 * Atomically increments today's stats in chrome.storage.local.
 * All fields are optional — only supplied deltas are applied.
 */
export function updateUsageStats(delta: UsageDelta): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  writeQueue = writeQueue.then(async () => {
    try {
      const key = getTodayKey();
      const stats = await getUsageStats();
      const today = stats[key] ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        audioSeconds: 0,
        estimatedCost: 0,
      };

      const pt = delta.promptTokens ?? 0;
      const ct = delta.completionTokens ?? 0;
      const tt = delta.totalTokens ?? pt + ct;
      const ws = delta.whisperSeconds ?? 0;
      const ls = delta.localSeconds ?? 0;

      today.promptTokens += pt;
      today.completionTokens += ct;
      today.totalTokens += tt;
      today.audioSeconds += ws + ls;
      today.estimatedCost += chatCostFor(pt, ct, delta.model) + ws * WHISPER_PRICE_PER_SECOND;

      stats[key] = today;
      await chrome.storage.local.set({ usageStats: stats });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
  return promise;
}
