import {
  getStorageStats,
  formatBytes,
  deleteSavedMeetingSession,
  deleteMultipleSavedMeetingSessions,
  deleteAllSavedMeetingSessions,
} from "./utils/storageUtils";
import { StorageStats } from "./types";
import { escapeHtml } from "./utils/domHelpers";

export async function renderStorageDashboard(container: HTMLElement): Promise<void> {
  container.innerHTML = '<p class="sd-loading">Carregando o uso do armazenamento…</p>';
  try {
    const stats = await getStorageStats();
    container.innerHTML = buildDashboardHTML(stats);
    applyStorageStyles(container, stats);
    attachEventListeners(container);
  } catch (err) {
    console.error("[ValorBrainMeet] Failed to load storage dashboard:", err);
    container.innerHTML = '<p class="sd-error">Não foi possível ler o armazenamento local.</p>';
  }
}

/** CSP-safe: dynamic widths/colours are applied through the style API. */
function applyStorageStyles(container: HTMLElement, stats: StorageStats): void {
  const bar = container.querySelector<HTMLElement>(".sd-bar-fill");
  if (bar) {
    bar.style.width = `${Math.min(100, Math.max(0, stats.percentUsed))}%`;
  }
  container.querySelectorAll<HTMLElement>(".sd-dot").forEach((dot) => {
    if (dot.dataset.color) dot.style.background = dot.dataset.color;
  });
}

function buildDashboardHTML(stats: StorageStats): string {
  const isWarning = !stats.unlimited && stats.percentUsed >= stats.warningThreshold;
  const usage = stats.unlimited
    ? `${formatBytes(stats.totalBytes)} usados · sem limite`
    : `${formatBytes(stats.totalBytes)} de ${formatBytes(stats.quotaBytes)} (${stats.percentUsed}%)`;

  return `
    <div class="sd">
      ${isWarning ? `<p class="sd-warning">O armazenamento passou de ${stats.warningThreshold}%. Exclua reuniões antigas.</p>` : ""}
      <div class="sd-summary">
        <div class="sd-summary-row">
          <span class="vb-label">${stats.meetingCount} ${stats.meetingCount === 1 ? "reunião salva" : "reuniões salvas"}</span>
          <span class="vb-muted">${usage}</span>
        </div>
        ${stats.unlimited ? "" : '<div class="sd-bar"><div class="sd-bar-fill"></div></div>'}
      </div>
      <div class="sd-breakdown">
        ${breakdown("Transcrições", stats.transcriptBytes, stats.totalBytes, "var(--vb-chart-3)")}
        ${breakdown("Resumos", stats.summaryBytes, stats.totalBytes, "var(--vb-green)")}
        ${breakdown("Próximos passos", stats.actionItemBytes, stats.totalBytes, "var(--vb-chart-1)")}
        ${breakdown("Configurações", stats.settingsBytes, stats.totalBytes, "var(--vb-slate)")}
      </div>
      ${
        stats.largestMeetings.length > 0
          ? `<div class="sd-list-head">
              <span class="vb-label">Maiores reuniões</span>
              <div class="sd-actions">
                <button id="storage-select-all" class="vb-btn vb-btn--sm" type="button" aria-pressed="false">Selecionar todas</button>
                <button id="storage-delete-selected" class="vb-btn vb-btn--sm vb-btn--danger-outline" type="button" disabled>Excluir selecionadas</button>
                <button id="storage-clear-all" class="vb-btn vb-btn--sm vb-btn--danger-outline" type="button">Excluir todas</button>
              </div>
            </div>
            <ul class="sd-list">
              ${stats.largestMeetings
                .map(
                  (m) => `<li class="sd-item">
                    <input type="checkbox" class="sd-check" data-id="${escapeHtml(m.id)}" aria-label="Selecionar ${escapeHtml(m.title)}" />
                    <div class="sd-item-body">
                      <span class="sd-item-title">${escapeHtml(m.title)}</span>
                      <span class="vb-hint">${escapeHtml(m.date)} · ${formatBytes(m.totalBytes)}</span>
                    </div>
                    <button class="vb-btn vb-btn--sm vb-btn--ghost sd-delete" type="button" data-id="${escapeHtml(m.id)}" aria-label="Excluir ${escapeHtml(m.title)}">Excluir</button>
                  </li>`,
                )
                .join("")}
            </ul>`
          : `<p class="vb-hint">Nenhuma reunião salva ainda.</p>`
      }
      <button id="storage-refresh" class="vb-btn vb-btn--sm" type="button">Atualizar</button>
    </div>`;
}

function breakdown(label: string, bytes: number, total: number, color: string): string {
  const pct = total > 0 ? Math.round((bytes / total) * 100) : 0;
  return `<div class="sd-part">
      <span class="sd-dot" data-color="${color}"></span>
      <span class="sd-part-label">${label}</span>
      <span class="vb-hint">${formatBytes(bytes)} · ${pct}%</span>
    </div>`;
}

function attachEventListeners(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>(".sd-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id!;
      const title = btn.closest(".sd-item")?.querySelector(".sd-item-title")?.textContent || id;
      if (
        !confirm(`Excluir “${title}” deste navegador? O que já está no ValorBrain não é afetado.`)
      )
        return;
      await deleteSavedMeetingSession(chrome.storage.local, id);
      await renderStorageDashboard(container);
    });
  });

  const boxes = container.querySelectorAll<HTMLInputElement>(".sd-check");
  const deleteSelected = container.querySelector<HTMLButtonElement>("#storage-delete-selected");
  const selectAll = container.querySelector<HTMLButtonElement>("#storage-select-all");
  const selected = () =>
    Array.from(boxes)
      .filter((b) => b.checked)
      .map((b) => b.dataset.id!);
  const sync = () => {
    if (deleteSelected) deleteSelected.disabled = selected().length === 0;
  };
  boxes.forEach((box) => box.addEventListener("change", sync));

  deleteSelected?.addEventListener("click", async () => {
    const ids = selected();
    if (!ids.length || !confirm(`Excluir ${ids.length} reunião(ões) deste navegador?`)) return;
    await deleteMultipleSavedMeetingSessions(chrome.storage.local, ids);
    await renderStorageDashboard(container);
  });

  container.querySelector("#storage-clear-all")?.addEventListener("click", async () => {
    if (!confirm("Excluir todas as reuniões salvas neste navegador?")) return;
    await deleteAllSavedMeetingSessions(chrome.storage.local);
    await renderStorageDashboard(container);
  });

  selectAll?.addEventListener("click", () => {
    const all = Array.from(boxes).every((b) => b.checked);
    boxes.forEach((b) => (b.checked = !all));
    selectAll.setAttribute("aria-pressed", String(!all));
    selectAll.textContent = all ? "Selecionar todas" : "Limpar seleção";
    sync();
  });

  container.querySelector("#storage-refresh")?.addEventListener("click", () => {
    void renderStorageDashboard(container);
  });
}
