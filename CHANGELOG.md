# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.1] - 2026-09-30

### 🐛 Bug Fixes

- **As formas erradas não vão mais para o ValorBrain.** Em **Detalhes**, a reunião traz só a grafia certa dos termos corrigidos (`Grafia revisada na transcrição: gbrain (4), Replit`). Antes, a linha "D-Brain → gbrain, Draga → Braga" fazia o ValorBrain extrair "D-Brain" e "Draga" como entidades a cada reunião. As formas erradas continuam no painel da extensão e viram apelidos no ValorBrain

## [2.2.0] - 2026-09-30

A transcrição passa a usar o que o ValorBrain já sabe da sua empresa, e aprende com cada reunião.

### 🚀 Features

- **Vocabulário da empresa vindo do ValorBrain.** Ao começar a gravar, a extensão pede ao ValorBrain os nomes de pessoas, clientes, projetos e produtos que a empresa mais cita (quem está na reunião primeiro, depois quem costuma aparecer com essas pessoas e em reuniões) e completa o **Vocabulário da empresa** no prompt do Whisper, na revisão final e no resumo. A sua lista das configurações vem sempre primeiro. Pede de novo quando entra alguém. Os nomes dos participantes vão no corpo do pedido, nunca na URL, e o ValorBrain só conta o que a sua conta pode ver. Desligável em **Configurações → ValorBrain**
- **Correções aprendidas.** O que a revisão final corrigiu numa reunião ("Rapplet" → "Replit") volta para o ValorBrain como apelido quando a reunião é enviada, e as próximas reuniões da empresa já chegam com a correção: ela é aplicada a cada fala assim que é transcrita, sem diferenciar maiúsculas. A extensão confere cada correção antes de usar: termo curto, grafia parecida, um dos lados com cara de nome, nunca uma parte do nome de alguém da reunião ("Diego" de "Diego Braga") e nunca um par que trocaria dois nomes de lugar. O ValorBrain nunca junta pessoas nem troca um nome que já conhece. Desligável em **Configurações → ValorBrain**
- **Aviso de gravação no chat (opcional).** Em **Configurações → Recursos**, **Avisar no chat que a reunião está sendo gravada** publica no chat do Google Meet, ao começar a gravar, que a reunião está sendo gravada e transcrita pelo ValorBrain Meet, com o link [meet.valorbra.in](https://meet.valorbra.in). Uma vez por reunião; o texto é editável. A extensão só considera enviado quando a caixa de mensagem esvazia; se o chat não aparecer, avisa para você informar os participantes. No Zoom e no Teams, ainda não publica (as páginas deles também têm conversas privadas): só lembra você de avisar. Vem desligado
- **Zoom e Microsoft Teams pelo navegador (em teste).** O cliente web do Zoom (`app.zoom.us/wc/…`) e o Teams na web (`teams.microsoft.com`, `teams.live.com`) são reconhecidos como reuniões: o atalho, o ícone e o aviso na página funcionam, e a reunião é salva e enviada ao ValorBrain como no Meet. Nomes, quem fala, microfone mudo e saída da chamada (no Teams, também quando os controles da chamada somem) usam leituras da página que ainda não foram conferidas numa chamada real do Zoom ou do Teams: se falharem, a gravação continua com as falas como "Participante"

### 🐛 Bug Fixes

- O aviso no chat e o resumo para quem chega atrasado só usam a caixa de mensagem visível, nunca uma escondida, e só na sala que está sendo gravada
- A tela de "você saiu da reunião" só conta quando está visível

### 🔧 Interno

- Teste ponta a ponta no navegador (`npm run test:e2e`, ver TESTING.md): Chrome for Testing, páginas falsas de Meet, Zoom e Teams, captura real da aba e do microfone, atalho pelo servidor X e mocks de transcrição, IA e ValorBrain

## [2.1.0] - 2026-09-29

A partir das duas primeiras reuniões reais gravadas com a 2.0 ("D-Brain" em vez de gbrain, todas as falas como "Participante", cortes a cada 25 s).

### 🚀 Features

- **Sua voz e a dos outros transcritas separadas.** O microfone (você) e a aba (as outras pessoas) são gravados e cortados cada um no seu ritmo. Toda fala do microfone sai com o seu nome (novo campo **Seu nome nas transcrições**, em Configurações → Microfone). Fala sobreposta dos dois lados não se perde mais
- **Quem falou na aba**: a pessoa que o Meet mostrou falando durante o trecho; numa reunião a dois, a outra pessoa. Os nomes vêm também dos botões "Mais opções para …" e da conta Google do Meet
- **Revisão final de termos**: antes do resumo final, a transcrição inteira passa por uma revisão de grafia de nomes, marcas e termos em inglês (D-Brain → gbrain, Rapplet → Replit, SuperBase → Supabase). O modelo só propõe; a extensão aceita a troca só quando o texto errado está na transcrição e se parece com o certo, e nunca troca uma pessoa por outra. As trocas aparecem em **Detalhes** no ValorBrain
- **Cortes nas pausas**: um trecho termina na próxima pausa, e a pausa exigida diminui conforme o trecho cresce (limite de 28 s). O limiar se ajusta ao ruído de fundo, então palavras não são mais cortadas ao meio a cada 25 s
- **Vocabulário**: ValorBrain e ValorBrain Meet entram sempre, mesmo com o campo vazio; o prompt do Whisper tem orçamento para o vocabulário nunca ser cortado
- **Microfone mudo no Meet não é gravado**: nada do que você diz com o microfone desligado na reunião entra na transcrição
- Servidor whisper-local com **large-v3-turbo na GPU** (queda automática para a CPU). No benchmark com frases das reuniões reais: erro por palavra de 12,6% para 7,8% e termos certos de 17/30 para 24/30

### 🐛 Bug Fixes

- Loops do Whisper ("Ah, entendi. Ah, entendi. …") ficam uma vez só
- Eco do alto-falante no microfone (sem fone) é descartado em vez de duplicar a fala
- Cota de 5 horas do GLM Coding Plan esgotada (erro 1308): aviso com a hora de renovação e sem novas tentativas até lá; a transcrição continua
- Nomes de participantes com texto de ícone do Meet ("Ana Souza ⋮", "more_vert")

## [2.0.0] - 2026-09-29

### ⚠️ Mudanças que quebram compatibilidade

- **Atalho de gravação agora é Alt+Shift+G.** O Chrome não reserva Alt+Shift+R (colide com um atalho do próprio navegador) e deixava o comando sem tecla. O popup e o aviso no Meet leem o atalho que o Chrome realmente atribuiu; sem atalho, o popup oferece **Definir atalho de gravação**
- **A reunião é salva e enviada ao ValorBrain automaticamente ao encerrar.** O modal "Salvar sessão" saiu: a sessão se perdia quando o popup não estava aberto
- **Resumo padrão: Z.ai GLM (GLM Coding Plan)**, em `https://api.z.ai/api/coding/paas/v4`. Chaves do Coding Plan recebiam erro 1113 (sem saldo) no endpoint pré-pago
- O assistente de boas-vindas separado e o seletor de cor de destaque foram removidos. Os primeiros passos ficam nas Configurações, e as cores seguem a marca

### 🚀 Features

- **Encerramento completo**: pelo botão, pelo atalho ou ao sair da chamada. A extensão espera o último trecho ser transcrito, gera o resumo final da reunião inteira, salva, envia ao ValorBrain e confirma com uma notificação. Também encerra quando a aba sai da reunião
- **Captura mais confiável**: segmentos sem lacuna entre si, trechos de silêncio descartados no navegador, fila com contenção quando a transcrição atrasa, e falhas da aba ou do microfone avisadas em português
- **Transcrição e resumo**: filas separadas com novas tentativas, idioma fixo (português por padrão), temperatura 0, filtro das alucinações típicas do Whisper, vocabulário da empresa no prompt, prompts em PT-BR, leitura robusta do JSON e GLM com raciocínio desligado
- **Perfis de provedor**: Whisper local, Whisper remoto (whisper.valor.digital), OpenAI (`whisper-1`, `gpt-4o-mini`), Z.ai Coding Plan, Z.ai pré-paga e personalizado, cada um com teste real de conexão
- **Primeiros passos**: checklist no popup e nas Configurações (transcrição, resumo, microfone, ValorBrain). O ícone mostra REC durante a gravação
- **Painel** com Resumo, Transcrição, Decisões, Pessoas e Histórico; reuniões salvas podem ser reabertas, reenviadas e exportadas em .md, .txt ou .json
- **Conteúdo no ValorBrain em PT-BR**: Resumo, Decisões, Próximos passos (com responsável e prazo), Assuntos, Pontos em aberto, Participantes, Detalhes e Transcrição. O título usa o primeiro assunto da reunião
- **Marca ValorBrain V. 2.1** em todas as telas: tokens oficiais, Hanken Grotesk e JetBrains Mono (SIL OFL), ícones 16/32/48/128 e temas claro e escuro
- **Aviso no Meet** (dica para gravar, gravando com tempo, salvando, concluído), com estilos isolados da página do Meet
- Endereços fora da lista padrão (ValorBrain próprio, provedor na rede local) pedem permissão de host ao salvar as configurações
- **macOS**: quando o sistema bloqueia o microfone do Chrome, o aviso mostra o caminho em Ajustes do Sistema (e no Windows, em Configurações). **Testar microfone** nas Configurações pega esse caso antes da reunião, e os atalhos aparecem com os símbolos do Mac (⌥⇧G)
- **Página de download em [meet.valorbra.in](https://meet.valorbra.in)**, no estilo do brand kit, com instruções para Mac e Windows e o SHA-256 do pacote

### 🐛 Bug Fixes

- O buffer de análise da detecção de fala não era alocado
- O último trecho da reunião se perdia ao encerrar
- Marcadores de "em andamento" gravados no storage travavam as filas depois que o service worker reiniciava
- O clique automático no painel de participantes fazia a interface do Meet piscar
- Classes CSS duplicadas ou sem definição (modal, esqueleto de carregamento, busca, estados vazios)
- O pacote da extensão passa a incluir os avisos de licença (MIT e SIL OFL das fontes)

### 📚 Documentation

- README, `docs/VB-INGEST.md` e `docs/PRIVACY.md` reescritos em PT-BR, com instalação, primeira configuração, uso e problemas comuns

## [1.9.0] - 2026-09-21

### 🚀 Features

- **Brand system aplicado ao dashboard e popup**: Verde Valor (#047857) no CTA principal (Iniciar áudio), aba ativa, barra de sentimento, botão Enviar para o ValorBrain e logos (ícone brain nos headers); badge AO VIVO em vermelho (convenção de "ao vivo")
- Tokens de marca no tema (`--vb-brand`, `--vb-brand-hover`, `--vb-brand-tint`, `--vb-brand-border`) reutilizados por todas as telas

## [1.8.0] - 2026-09-21

### 🐛 Bug Fixes

- **"Testar conexão" deixou de ser falso positivo**: o probe agora usa o endpoint autenticado `GET /api/v1/memory/working-context` (antes batia no `/health` público, que respondia 200 até com token inválido)
- **Mensagens de erro do ingest em PT-BR** (auth/rate limit/timeout/rede/config) — aparecem no badge de sync e nos toasts
- **CSP compliance total**: removidos os ~50 `style="…"` inline e o bloco `<style>` do dashboard (bloqueados por `style-src 'self'` desde a introdução do CSP — barras de progresso, botões de export, badges e colunas de custo voltaram a renderizar); removido o `@import` do Google Fonts (a fonte Inter já é empacotada localmente)
- **Save valida a Base URL do ValorBrain** com o mesmo validador dos AI Providers

### 🚀 Features

- Botão **Desconectar** na seção ValorBrain (limpa Base URL, token e Tenant ID)
- Testar conexão não exige mais Tenant ID (tokens OAuth resolvem o tenant no servidor)
- Traduções finais: botões do onboarding, modal de fim de reunião, estados vazios e fallback do briefing

## [1.7.1] - 2026-09-21

### 🐛 Bug Fixes

- Painel de **Storage** deixou de mostrar a cota hardcoded de 10 MB: com `unlimitedStorage` ativo no manifest (já é o nosso caso), o card exibe o uso real e marca **ilimitado**, sem barra de porcentagem enganosa ([#1](https://github.com/agentxagi/valorbrain-meet/pull/1))

## [1.7.0] - 2026-09-21

### 🚀 Features

- **"Conectar com ValorBrain"** — OAuth 2.1 authorization-code + PKCE contra o authorization server do engine (que já estava em produção): registro dinâmico de cliente, `chrome.identity.launchWebAuthFlow` sobre `/oauth/authorize` com consentimento no navegador, troca de código por token `vbm_` — e a conexão fica salva (Base URL + token), sem colar nada nas configurações ([#1](https://github.com/agentxagi/valorbrain-meet/pull/1))
- Novo escopo `identity` no manifest para o fluxo de autorização

### 🔧 Engine (valorbrain-saas)

- `resolveShadowAuth` agora aceita tokens OAuth-emitidos `vbm_*` nas rotas REST (resolvidos a tenant via `mcp_tokens`), ponte necessária para o ingest funcionar com o token do fluxo OAuth

## [1.6.0] - 2026-09-21

### 🚀 Features

- **Identidade ValorBrain em toda a extensão**: copy 100% em PT-BR no popup, dashboard, configurações e onboarding; verde Valor (#047857) como cor de destaque padrão (ainda ajustável no seletor de accent); naming "ValorBrain Meet" em todos os títulos, menus e notificações ([#1](https://github.com/agentxagi/valorbrain-meet/pull/1))

## [1.5.0] - 2026-09-21

### 🚀 Features

- **Auto-send to ValorBrain is ON by default once the connection is configured** (Base URL + API token + Tenant ID). An explicit opt-out in Settings always wins; without configuration nothing is sent ([#1](https://github.com/agentxagi/valorbrain-meet/pull/1))
- Settings toggle now reflects the effective value and its hint explains the default-on behavior

## [1.4.0] - 2026-09-21

### 🚀 Features

- **ValorBrain ingest** — send saved meeting sessions straight into your ValorBrain tenant as memory documents (`POST {baseUrl}/api/v1/memory/store`, collection `meetings`)
  - Settings → **ValorBrain**: Base URL, API token, Tenant ID, connection test; auto-send is **opt-in** (default OFF) — local export stays the source of truth
  - Dashboard: **Send to ValorBrain** button per saved session with sending/sent/error + retry and local sync badge
- Provider-agnostic pipeline + popup setup gate fixes from v1.3.x now ship together with ingest ([#1](https://github.com/agentxagi/valorbrain-meet/pull/1))

Setup: Settings → ValorBrain → Base URL `https://valorbrain-api.valor.digital` + your tenant API token (`vb_agent_…`). Full contract and manual test recipe in [`docs/VB-INGEST.md`](docs/VB-INGEST.md).

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
