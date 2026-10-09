// AI usage (tokens, audio seconds, estimated cost) from chrome.storage.local.
import { getUsageStats } from "./usageTracker";
import { DayStats } from "./types";
import { escapeHtml } from "./utils/domHelpers";

export async function renderApiUsageDashboard(container: HTMLElement): Promise<void> {
  container.innerHTML = '<p class="ud-muted">Carregando o uso…</p>';
  try {
    const stats = await getUsageStats();
    container.innerHTML = buildDashboardHTML(stats);
    attachEventListeners(container);
  } catch (err) {
    console.error("[ValorBrainMeet] Failed to load usage dashboard:", err);
    container.innerHTML = '<p class="ud-error">Não foi possível ler o histórico de uso.</p>';
  }
}

interface WindowStats {
  tokens: number;
  cost: number;
  audioSeconds: number;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function windowStats(stats: Record<string, DayStats>, days: number | "month"): WindowStats {
  const total: WindowStats = { tokens: 0, cost: 0, audioSeconds: 0 };
  const now = new Date();
  const add = (day?: DayStats) => {
    if (!day) return;
    total.tokens += day.totalTokens || 0;
    total.cost += day.estimatedCost || 0;
    total.audioSeconds += day.audioSeconds || 0;
  };
  if (days === "month") {
    const prefix = dateKey(now).slice(0, 7);
    for (const [key, day] of Object.entries(stats)) if (key.startsWith(prefix)) add(day);
  } else {
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      add(stats[dateKey(d)]);
    }
  }
  return total;
}

function formatAudio(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

function formatCost(cost: number): string {
  return cost > 0 ? `US$ ${cost.toFixed(cost < 0.01 ? 4 : 2).replace(".", ",")}` : "—";
}

function card(label: string, data: WindowStats): string {
  return `<div class="ud-card">
      <div class="ud-card-label">${escapeHtml(label)}</div>
      <dl class="ud-rows">
        <div><dt>Tokens</dt><dd>${data.tokens.toLocaleString("pt-BR")}</dd></div>
        <div><dt>Áudio transcrito</dt><dd>${formatAudio(data.audioSeconds)}</dd></div>
        <div><dt>Custo estimado</dt><dd>${formatCost(data.cost)}</dd></div>
      </dl>
    </div>`;
}

function buildDashboardHTML(stats: Record<string, DayStats>): string {
  const footnote =
    '<p class="ud-muted">O custo só é estimado para modelos da OpenAI e do Claude (tabelas públicas). Whisper local e Z.ai GLM aparecem sem custo.</p>';
  if (Object.keys(stats).length === 0) {
    return `<div class="ud">
        <p class="ud-muted">Nenhum uso registrado ainda. Os números aparecem depois da primeira reunião gravada.</p>
        ${footnote}
      </div>`;
  }

  const days = Object.entries(stats)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 14);

  return `<div class="ud">
      <div class="ud-grid">
        ${card("Últimos 7 dias", windowStats(stats, 7))}
        ${card("Este mês", windowStats(stats, "month"))}
      </div>
      <details class="ud-details">
        <summary>Por dia (últimos 14 dias)</summary>
        <div class="ud-table-wrap">
          <table class="ud-table">
            <thead><tr><th scope="col">Dia</th><th scope="col">Tokens</th><th scope="col">Áudio</th><th scope="col">Custo</th></tr></thead>
            <tbody>
              ${days
                .map(
                  ([date, day]) => `<tr>
                    <td class="vb-mono">${escapeHtml(date.split("-").reverse().join("/"))}</td>
                    <td>${(day.totalTokens || 0).toLocaleString("pt-BR")}</td>
                    <td>${formatAudio(day.audioSeconds || 0)}</td>
                    <td>${formatCost(day.estimatedCost || 0)}</td>
                  </tr>`,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </details>
      <div class="ud-actions">
        <button class="vb-btn vb-btn--sm" id="usage-refresh" type="button">Atualizar</button>
        <button class="vb-btn vb-btn--sm vb-btn--danger-outline" id="usage-clear" type="button">Zerar histórico de uso</button>
      </div>
      ${footnote}
    </div>`;
}

function attachEventListeners(container: HTMLElement): void {
  container.querySelector("#usage-refresh")?.addEventListener("click", () => {
    void renderApiUsageDashboard(container);
  });
  container.querySelector("#usage-clear")?.addEventListener("click", async () => {
    if (!confirm("Zerar o histórico de uso de IA deste navegador?")) return;
    await chrome.storage.local.remove("usageStats");
    void renderApiUsageDashboard(container);
  });
}
