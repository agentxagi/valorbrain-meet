<div align="center">

<img src="src/icons/icon128.png" width="72" height="72" alt="ValorBrain Meet" />

# ValorBrain Meet

Grava reuniões do Google Meet direto no navegador (Zoom e Microsoft Teams pelo
navegador também, em teste), transcreve, resume em português e guarda tudo na
memória do ValorBrain. Sem bot na chamada.

**Download e instruções: [meet.valorbra.in](https://meet.valorbra.in)**

</div>

---

## O que a extensão faz

- **Grava sem bot**: capta o áudio da aba do Meet (as outras pessoas) e o seu microfone (a sua voz), cada um transcrito separado. Tudo o que vem do microfone sai com o seu nome; com o microfone mudo no Meet, nada é gravado.
- **Transcreve em português** com Whisper local, Whisper remoto ou OpenAI, cortando nas pausas da fala, e identifica quem falou na aba pelo indicador de fala do Meet (numa reunião a dois, a outra pessoa).
- **Usa o vocabulário da sua empresa**: ao começar a gravar, busca no ValorBrain os nomes de pessoas, clientes, projetos e produtos que a empresa mais cita (quem está na reunião primeiro) e as correções já aprendidas, e a transcrição acerta esses nomes sem você digitar nada.
- **Revisa os termos no fim**: nomes, marcas e termos em inglês que o reconhecimento errou são corrigidos na transcrição antes do resumo final (no painel, as trocas ficam em Detalhes; no ValorBrain vai só a grafia certa). As correções voltam para o ValorBrain, e a próxima reunião da empresa já sai certa.
- **Avisa no chat que está gravando** (opcional): ao começar, publica no chat da reunião que ela está sendo gravada e transcrita pelo ValorBrain Meet, uma vez por reunião.
- **Resume enquanto a reunião acontece**: resumo, decisões, próximos passos com responsável e prazo, assuntos, pontos em aberto e clima da reunião.
- **Fecha sozinha**: ao encerrar (ou ao sair da chamada), transcreve o último trecho, gera o resumo final, salva a reunião neste navegador e envia para o ValorBrain. Uma notificação confirma.
- **Histórico**: reabra reuniões salvas, reenvie ao ValorBrain e exporte em Markdown, texto ou JSON.
- **Para quem chega atrasado**: mostra um resumo privado na sua tela quando alguém entra depois (e, se você ativar, envia no chat).

## Instalar

Requisito: Google Chrome 116 ou mais recente, no macOS ou no Windows.

1. Baixe o zip em [meet.valorbra.in](https://meet.valorbra.in) (ou gere a pasta `dist/` com `npm ci && npm run build`).
2. Descompacte e mova a pasta para um lugar fixo, sem a versão no nome: `~/ValorBrain/valorbrain-meet` no Mac, `C:\ValorBrain\valorbrain-meet` no Windows. O Chrome lê a extensão dessa pasta; não apague depois.
3. Abra `chrome://extensions`, ligue o **Modo do desenvolvedor** e clique em **Carregar sem compactação**.
4. Selecione a pasta que contém o `manifest.json`.
5. Fixe o ícone do ValorBrain Meet na barra do Chrome (ícone de quebra-cabeça → alfinete).

Na primeira instalação, a página de configurações abre sozinha.

**Atualizar:** substitua a pasta pela versão nova (mesmo lugar, mesmo nome) e clique em ↻ no cartão da extensão em `chrome://extensions`. O histórico e as configurações continuam. Carregar de outra pasta cria outra extensão, com o histórico vazio.

**Aviso de versão nova:** o Chrome não atualiza sozinho uma extensão instalada pelo zip. Por isso, uma vez por dia, a extensão lê `https://meet.valorbra.in/latest.json` (um GET simples, sem nada da reunião) e, quando há versão nova, o ícone mostra **Versão X disponível** com o link **Como atualizar**. Desligue em **Configurações → Atualizações**; detalhes em [`docs/PRIVACY.md`](docs/PRIVACY.md#aviso-de-versão-nova).

## Primeira configuração

Em **Configurações → Primeiros passos**, a lista mostra o que falta. Cada item leva ao ajuste certo.

| Item              | O que fazer                                                                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transcrição**   | Escolha o provedor. Veja a tabela abaixo.                                                                                                                                                                                                                |
| **Resumo com IA** | Cole a chave do provedor de resumo. O padrão é o Z.ai GLM (GLM Coding Plan). Sem chave, só a transcrição funciona.                                                                                                                                       |
| **Microfone**     | Clique em **Permitir microfone** e aceite o aviso do Chrome. É uma vez só. Depois, **Testar microfone** confirma que o sistema (macOS/Windows) também liberou. Sem microfone, a sua voz não entra na gravação: o áudio da aba só traz as outras pessoas. |
| **ValorBrain**    | Clique em **Conectar com ValorBrain**, entre na sua conta e aprove. Para usar um token de API, abra **Configuração manual**.                                                                                                                             |

Use **Testar transcrição**, **Testar resumo** e **Testar conexão** para confirmar cada parte antes da primeira reunião.

### Provedores

| Perfil                                 | Uso                  | Endereço                                                 | Chave                    |
| -------------------------------------- | -------------------- | -------------------------------------------------------- | ------------------------ |
| Whisper local (neste computador)       | Transcrição          | `http://127.0.0.1:8394/v1`                               | Não precisa              |
| Whisper remoto (whisper.valor.digital) | Transcrição          | `https://whisper.valor.digital/v1`                       | Chave Bearer do servidor |
| OpenAI                                 | Transcrição e resumo | `https://api.openai.com/v1` (`whisper-1`, `gpt-4o-mini`) | Chave da OpenAI          |
| Z.ai GLM (GLM Coding Plan)             | Resumo               | `https://api.z.ai/api/coding/paas/v4` (`glm-5.3-flash`)  | Chave do GLM Coding Plan |
| Z.ai GLM (API pré-paga)                | Resumo               | `https://api.z.ai/api/paas/v4`                           | Chave com saldo pré-pago |
| Personalizado                          | Qualquer um          | Qualquer API compatível com a OpenAI                     | Opcional                 |

O **Whisper local** só funciona quando o servidor roda no mesmo computador que o Chrome. No Mac e no Windows, use o **Whisper remoto** (a chave Bearer é fornecida pela Valor) ou a OpenAI.

O **Vocabulário da empresa** (nomes próprios, produtos, siglas, termos em inglês) ajuda a transcrição, a revisão final de termos e o resumo a escrever certo. ValorBrain e ValorBrain Meet entram sempre. Conectado ao ValorBrain, a extensão completa essa lista com o vocabulário que o ValorBrain conhece da sua empresa (a sua lista vem primeiro). Em **Configurações → Microfone**, preencha **Seu nome nas transcrições**.

## Usar numa reunião

1. Entre na reunião em `meet.google.com` (ou no Zoom e no Teams pelo navegador, veja abaixo). No canto inferior esquerdo aparece o aviso com o atalho de gravação.
2. **Comece** clicando no ícone do ValorBrain Meet → **Iniciar gravação**, ou pressione **⌥⇧G** no Mac (**Alt+Shift+G** no Windows). O Chrome exige esse clique ou atalho para liberar a captura da aba.
3. **Durante**: o ícone mostra **REC** e o aviso na tela mostra o tempo de gravação. O painel lateral (**⌥⇧L** / **Alt+Shift+L**) mostra o resumo, a transcrição, as decisões e as pessoas ao vivo. **⌥⇧U** / **Alt+Shift+U** atualiza o resumo na hora.
4. **Encerre** em **Encerrar** no aviso, **Encerrar e salvar** no ícone, com o atalho de novo ou simplesmente saindo da chamada. A extensão termina o trabalho e avisa quando a reunião estiver salva e enviada.

Avise os participantes de que a reunião está sendo gravada. No Google Meet, **Configurações → Recursos → Avisar no chat que a reunião está sendo gravada** faz isso por você: ao começar a gravar, a mensagem vai para o chat da reunião (uma vez por reunião; o texto é editável). Vem desligado. No Zoom e no Teams, a extensão só lembra você de avisar.

### Zoom e Microsoft Teams (em teste)

Funcionam pelo navegador: o **cliente web do Zoom** (`app.zoom.us/wc/…`, "Entrar pelo navegador") e o **Teams na web** (`teams.microsoft.com`, `teams.live.com`). A gravação, a transcrição, o resumo e o envio ao ValorBrain são os mesmos do Meet. Nomes dos participantes, quem está falando, microfone mudo e detecção de saída da chamada usam leituras da página que ainda não foram conferidas numa chamada real do Zoom ou do Teams: se algo não aparecer, a gravação continua (as falas saem como "Participante") e vale reportar. O aviso automático no chat fica só no Meet por enquanto: as páginas do Zoom e do Teams também têm conversas privadas, e uma leitura errada publicaria no lugar errado. Os aplicativos de desktop do Zoom e do Teams não são gravados.

### Atalhos

| Ação                           | Mac   | Windows       |
| ------------------------------ | ----- | ------------- |
| Iniciar ou encerrar a gravação | `⌥⇧G` | `Alt+Shift+G` |
| Abrir o painel da reunião      | `⌥⇧L` | `Alt+Shift+L` |
| Atualizar o resumo agora       | `⌥⇧U` | `Alt+Shift+U` |

Os atalhos podem ser trocados em `chrome://extensions/shortcuts`. O rodapé do ícone mostra o atalho que está valendo; se o Chrome não conseguir reservar a combinação, aparece o botão **Definir atalho de gravação**.

## O que vai para o ValorBrain

Cada reunião vira uma memória do tipo `observation` na coleção `meetings`, com as seções Resumo, Decisões, Próximos passos, Assuntos, Pontos em aberto, Participantes, Detalhes e Transcrição. O envio é automático ao encerrar (pode ser desligado em **Configurações → ValorBrain**). Se falhar, a reunião continua salva no navegador: no **Histórico**, clique em **Enviar ao ValorBrain** nela.

Junto com a reunião, as correções que a revisão final aceitou ("Rapplet" → "Replit") viram apelidos no ValorBrain, e o vocabulário das próximas reuniões já traz a grafia certa. O ValorBrain nunca junta pessoas nem troca um nome que já conhece por causa de uma correção. As duas coisas podem ser desligadas em **Configurações → ValorBrain**.

Contrato da API e roteiro de teste manual: [`docs/VB-INGEST.md`](docs/VB-INGEST.md).

## Privacidade

- O áudio vai só para o provedor de transcrição que você escolheu. O texto vai só para o provedor de resumo. A reunião vai para o seu tenant do ValorBrain. A extensão não tem servidor próprio.
- Ao começar a gravar, os nomes dos participantes vão para o seu ValorBrain para buscar o vocabulário da empresa. O ValorBrain só devolve o que a sua conta pode ver.
- Uma vez por dia, a extensão pergunta a meet.valorbra.in qual é a versão mais recente, sem enviar nada da reunião. Dá para desligar.
- Reuniões, chaves e configurações ficam no armazenamento local do Chrome deste perfil. Nada sincroniza entre computadores.
- **Configurações → Dados e uso** mostra o espaço usado, apaga reuniões e zera tudo. Apagar aqui não apaga o que já está no ValorBrain.

Detalhes: [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Problemas comuns

| Sintoma                               | Causa provável e solução                                                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Whisper local não respondeu"         | O servidor está desligado ou roda em outra máquina/no WSL. Use **Whisper remoto** ou outro provedor.                                                                                                                                            |
| A sua voz não aparece na transcrição  | Microfone não liberado. **Configurações → Microfone → Permitir microfone**. Se o Chrome bloqueou, clique no ícone à esquerda do endereço da página de configurações, permita o microfone e recarregue.                                          |
| "O macOS está bloqueando o microfone" | O Chrome não tem acesso ao microfone no sistema. **Ajustes do Sistema → Privacidade e Segurança → Microfone** → ative o Google Chrome e reinicie a gravação.                                                                                    |
| A gravação não começa                 | Comece pelo ícone ou pelo atalho com a aba do Meet em primeiro plano.                                                                                                                                                                           |
| Sem resumo                            | Falta a chave do provedor de resumo. No Z.ai, o erro 1113 significa "sem saldo": chaves do GLM Coding Plan usam o perfil **Z.ai GLM (GLM Coding Plan)**. O erro 1308 é a cota de 5 horas do Coding Plan esgotada: o aviso mostra quando renova. |
| Envio ao ValorBrain falhou            | No **Histórico**, clique em **Enviar ao ValorBrain** na reunião. Confira em **Configurações → ValorBrain → Testar conexão**; 401/403 indicam token expirado: clique em **Reconectar**.                                                          |
| Preciso ver os logs                   | `chrome://extensions` → ValorBrain Meet → **service worker** → aba Console.                                                                                                                                                                     |

## Desenvolvimento

```bash
npm ci
npm run build       # gera dist/ (carregue essa pasta no Chrome)
npm test            # testes (node:test via tsx)
npm run lint
npx tsc --noEmit
npm run size-check  # orçamento de tamanho do bundle
```

### Site meet.valorbra.in

A página de download fica em `site/` (HTML e CSS no estilo do brand kit V. 2.1, sem framework).

```bash
npm run site:build   # build da extensão + zip reproduzível + página em site-dist/
npm run site:deploy  # publica no nginx local (releases/<data> + symlink current)
```

O zip sai sempre com os mesmos bytes para o mesmo código, e o SHA-256 publicado na página é o desse zip. O deploy recusa republicar uma versão com conteúdo diferente: aumente a versão antes. A origem é o nginx em `127.0.0.1:8140`, exposto pelo túnel do cloudflared.

| Arquivo                                           | Papel                                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/background.ts`                               | Service worker: estado da sessão, filas de transcrição e resumo, encerramento, salvamento e envio ao ValorBrain |
| `src/offscreen.ts`                                | Captura de áudio (aba + microfone), detecção de fala, segmentos enviados à transcrição                          |
| `src/content.ts`                                  | Aviso na página do Meet, falante ativo, participantes e detecção de saída da chamada                            |
| `src/popup.*`, `src/dashboard.*`, `src/options.*` | Ícone, painel lateral e configurações                                                                           |
| `src/meetingSummary.ts`, `src/providerClient.ts`  | Prompts em PT-BR e chamadas aos provedores compatíveis com a OpenAI                                             |
| `src/vbClient.ts`, `src/vbConnect.ts`             | Envio ao ValorBrain e conexão OAuth 2.1 (PKCE)                                                                  |
| `src/brand/`                                      | Tokens da marca ValorBrain V. 2.1                                                                               |

Commits seguem [Conventional Commits](https://www.conventionalcommits.org/); o release-please gera versões e changelog. Veja também [`CONTRIBUTING.md`](CONTRIBUTING.md) e [`CHANGELOG.md`](CHANGELOG.md).

## Licença

MIT, veja [`LICENSE`](LICENSE). Baseado no projeto open source [Late Meet](https://github.com/shouri123/Late-Meet). As fontes Hanken Grotesk e JetBrains Mono são distribuídas sob a SIL Open Font License 1.1 ([`src/fonts/OFL.txt`](src/fonts/OFL.txt)).
