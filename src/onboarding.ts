import {
  getApiCredentials,
  saveApiCredentials,
  isUnlocked,
  unlockCredentials,
} from "./utils/credentials";
import { validateProviderConnection } from "./utils/api";
import { providerConfigFromProfile } from "./utils/providerSettings";

export async function renderOnboarding(container: HTMLElement) {
  container.hidden = false;
  container.innerHTML = `
    <div class="onboard">
      <div class="onboard-card" role="dialog" aria-modal="true" aria-label="Onboarding do ValorBrain Meet">
        <div id="onboard-content"></div>
        <div class="onboard-footer">
          <button id="onboard-skip" class="btn">Skip</button>
          <div class="onboard-nav">
            <button id="onboard-back" class="btn" disabled>Back</button>
            <button id="onboard-next" class="btn btn-primary">Next</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const content = container.querySelector<HTMLDivElement>("#onboard-content")!;
  const backBtn = container.querySelector<HTMLButtonElement>("#onboard-back")!;
  const nextBtn = container.querySelector<HTMLButtonElement>("#onboard-next")!;
  const skipBtn = container.querySelector<HTMLButtonElement>("#onboard-skip")!;

  const steps = [
    {
      id: "welcome",
      title: "Bem-vindo ao ValorBrain Meet",
      html: `
        <h2>Bem-vindo ao ValorBrain Meet</h2>
        <p>Para quem entra atrasado: local-first, focado em privacidade e simples de usar.</p>
      `,
    },
    {
      id: "how-it-works",
      title: "Como funciona",
      html: `
        <h2>Como funciona</h2>
        <ol>
          <li>Entre no Google Meet</li>
          <li>Inicie o Copilot para capturar o áudio</li>
          <li>Receba transcrição e resumos em tempo real</li>
          <li>Use o "Catch Me Up" para um briefing rápido</li>
        </ol>
      `,
    },
    {
      id: "api-keys",
      title: "Chaves e providers",
      html: `
        <h2>Chaves e providers</h2>
        <p>Configure seus AI Providers em Configurações (Whisper local, Z.ai GLM, OpenAI ou custom). A chave OpenAI abaixo é opcional e fica no cofre criptografado.</p>
        <div class="form-group">
          <label for="onb-passphrase">Frase de criptografia</label>
          <input id="onb-passphrase" type="password" class="form-input" placeholder="Crie ou digite sua frase..." />
        </div>
        <div class="form-group">
          <label for="onb-openai">Chave de API da OpenAI (opcional)</label>
          <input id="onb-openai" class="form-input" placeholder="sk-xxxx" />
          <button id="onb-validate-openai" class="btn">Validate</button>
          <div id="onb-openai-status" class="form-note"></div>
        </div>
      `,
    },
    {
      id: "permissions",
      title: "Permissões",
      html: `
        <h2>Permissões</h2>
        <p>O ValorBrain Meet captura o áudio da aba e guarda tudo localmente. Nenhum dado sai do seu dispositivo sem um provider configurado.</p>
        <ul>
          <li>Tab capture: available</li>
          <li>Local storage: available</li>
        </ul>
      `,
    },
    {
      id: "quick-start",
      title: "Começo rápido",
      html: `
        <h2>Começo rápido</h2>
        <ol>
          <li>Entre em um Google Meet</li>
          <li>Abra o popup do ValorBrain Meet e inicie o Copilot</li>
          <li>Use o "Catch Me Up" para resumos rápidos</li>
        </ol>
      `,
    },
    {
      id: "complete",
      title: "Tudo pronto!",
      html: `
        <h2>Tudo pronto</h2>
        <p>Configuração concluída. Abra o dashboard para começar.</p>
        <div class="onboard-actions">
          <button id="onb-open-dashboard" class="btn btn-primary">Open Dashboard</button>
          <button id="onb-finish" class="btn">Finish</button>
        </div>
      `,
    },
  ];

  let index = 0;

  function renderStep() {
    const step = steps[index];
    content.innerHTML = step.html;
    backBtn.disabled = index === 0;
    nextBtn.textContent = index === steps.length - 1 ? "Finish" : "Next";

    // Wire validate/save controls if API step
    if (step.id === "api-keys") {
      const passInput = container.querySelector<HTMLInputElement>("#onb-passphrase")!;
      const openaiInput = container.querySelector<HTMLInputElement>("#onb-openai")!;
      const openaiStatus = container.querySelector<HTMLDivElement>("#onb-openai-status")!;
      const valOpenBtn = container.querySelector<HTMLButtonElement>("#onb-validate-openai")!;

      (async () => {
        const creds = await getApiCredentials();
        if (creds.openai_api_key) openaiInput.value = creds.openai_api_key;
      })();

      type UnlockResult = { unlocked: true } | { unlocked: false; reason: "missing" | "wrong" };

      async function ensureUnlocked(): Promise<UnlockResult> {
        if (isUnlocked()) return { unlocked: true };
        const pass = passInput.value;
        if (!pass) return { unlocked: false, reason: "missing" };
        const ok = await unlockCredentials(pass);
        return ok ? { unlocked: true } : { unlocked: false, reason: "wrong" };
      }

      function unlockFailureMessage(reason: "missing" | "wrong"): string {
        return reason === "missing"
          ? "Digite a frase de criptografia para salvar esta chave."
          : "Frase incorreta — tente novamente.";
      }

      valOpenBtn.addEventListener("click", async () => {
        openaiStatus.textContent = "Validando...";
        const key = openaiInput.value.trim();
        try {
          const ok = await validateProviderConnection(providerConfigFromProfile("openai", key));
          if (ok) {
            const result = await ensureUnlocked();
            if (!result.unlocked) {
              openaiStatus.textContent = unlockFailureMessage(result.reason);
              return;
            }
            await saveApiCredentials({ openai_api_key: key });
            openaiStatus.textContent = "Chave OpenAI válida — salva.";
          } else {
            openaiStatus.textContent = "Chave OpenAI inválida.";
          }
        } catch {
          openaiStatus.textContent = "Erro de validação.";
        }
      });
    }

    if (step.id === "complete") {
      const openBtn = container.querySelector<HTMLButtonElement>("#onb-open-dashboard");
      const finishBtn = container.querySelector<HTMLButtonElement>("#onb-finish");
      openBtn?.addEventListener("click", () => {
        chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
      });
      finishBtn?.addEventListener("click", async () => {
        await chrome.storage.local.set({ onboardingCompleted: true });
        container.hidden = true;
        location.href = "options.html";
      });
    }
  }

  backBtn.addEventListener("click", () => {
    if (index > 0) {
      index -= 1;
      renderStep();
    }
  });

  nextBtn.addEventListener("click", async () => {
    if (index < steps.length - 1) {
      index += 1;
      renderStep();
    } else {
      // Finish
      await chrome.storage.local.set({ onboardingCompleted: true });
      container.hidden = true;
      location.href = "options.html";
    }
  });

  skipBtn.addEventListener("click", async () => {
    if (confirm("Pular o onboarding? Você pode vê-lo depois em Configurações.")) {
      await chrome.storage.local.set({ onboardingCompleted: true });
      container.hidden = true;
      location.href = "options.html";
    }
  });

  renderStep();
}
