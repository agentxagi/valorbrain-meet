# Envio ao ValorBrain

Cada reunião encerrada vira uma memória no tenant do ValorBrain, por REST (nunca MCP).
A extensão é um cliente por tenant: nenhuma URL de tenant, token ou ID fica no código.
Tudo vem de **Configurações → ValorBrain**.

## Conexão

**Conectar com ValorBrain** (recomendado) roda o fluxo OAuth 2.1 com PKCE (S256) contra o
servidor de autorização do engine (`src/vbConnect.ts`):

1. `POST {base}/oauth/register`: registro dinâmico do cliente desta instalação.
2. `chrome.identity.launchWebAuthFlow` em `{base}/oauth/authorize`: a pessoa entra e aprova.
3. `POST {base}/oauth/token`: devolve um token `vbm_…` ligado ao tenant que aprovou.

A base padrão é `https://valorbrain-api.valor.digital`. O token `vbm_` resolve o tenant no
servidor, então o Tenant ID não é necessário.

**Configuração manual** aceita Base URL, token de API e Tenant ID (opcional, enviado como
`X-Tenant-ID` só quando preenchido).

## Chaves de configuração (`settings` em `chrome.storage.local`)

| Chave         | Padrão | Uso                                                 |
| ------------- | ------ | --------------------------------------------------- |
| `vb.baseUrl`  | `""`   | Base da API do engine. Vazio = não conectado.       |
| `vb.apiToken` | `""`   | Token Bearer (`vbm_…` do OAuth ou token do tenant). |
| `vb.tenantId` | `""`   | Opcional.                                           |
| `vb.autoSend` | ligado | Só um `false` explícito desliga o envio automático. |

Fora do prefixo `vb.`, no mesmo objeto:

| Chave              | Padrão | Uso                                                                |
| ------------------ | ------ | ------------------------------------------------------------------ |
| `graphVocabulary`  | ligado | Buscar o vocabulário da empresa no ValorBrain ao começar a gravar. |
| `learnCorrections` | ligado | Ensinar ao ValorBrain as correções aceitas na revisão final.       |

## Quando o envio acontece

Ao encerrar a gravação (botão, atalho ou saída da chamada), o service worker:

1. espera o último trecho ser transcrito;
2. gera o resumo final da reunião inteira;
3. salva a reunião em `chrome.storage.local` (a cópia local é a fonte da verdade);
4. envia ao ValorBrain, se conectado e com envio automático ligado;
5. mostra uma notificação com o resultado.

Uma falha no envio nunca apaga nem bloqueia a cópia local. No **Histórico**, o botão
**Enviar ao ValorBrain** (ou **Reenviar**, se já foi enviada) manda de novo
(`VB_SEND_SESSION` com o `sessionId`).

O resultado fica em `lastSessionResult.vb` (`pending`, `sent`, `failed` ou `skipped`, com
`docRef` quando enviado) e em `vbLastSync`, que alimentam o ícone e o painel.

## Requisição

`POST {baseUrl}/api/v1/memory/store`

```http
Authorization: Bearer <token>
Content-Type: application/json
X-Tenant-ID: <tenant>        (só se configurado)
```

```json
{
  "type": "observation",
  "title": "Reunião: Planejamento do lançamento da versão 2 (2026-09-29 09:23)",
  "content": "## Resumo\n…\n\n## Decisões\n- …\n\n## Próximos passos\n- [ ] … — Responsável (prazo: …)\n\n## Assuntos\n…\n\n## Pontos em aberto\n…\n\n## Participantes\n…\n\n## Detalhes\n…\n- Registrado pelo ValorBrain Meet 2.4.0 (transcrição automática, pode conter erros)\n\n## Transcrição\n[00:00] Nome: …",
  "collection": "meetings",
  "tags": ["reuniao", "meet", "valorbrain-meet"],
  "confidence": 0.85
}
```

O título usa o primeiro assunto identificado pelo resumo; sem assunto, o código da reunião.
Seções sem conteúdo (Assuntos, Pontos em aberto, Participantes) são omitidas. **Participantes**
lista todo mundo que apareceu na chamada durante a gravação, mesmo quem saiu antes do fim.

Em **Detalhes**, `Grafia revisada na transcrição: gbrain (4), Replit` lista só a grafia certa dos
termos corrigidos. As formas erradas ("D-Brain") não vão para a memória: o ValorBrain extrai
entidades desse texto e elas voltariam como entidades próprias. Elas ficam no grafo como apelidos
(ensinados depois do envio) e na linha do tempo do painel da extensão.

A última linha de **Detalhes** diz qual versão da extensão gravou a reunião
(`Registrado pelo ValorBrain Meet 2.4.0 …`), para entender um problema a partir do registro.
Reuniões salvas por versões anteriores à 2.4 saem sem o número.

A resposta deve trazer `path` ou `docid`; esse valor aparece como referência do documento.

### Erros

| Situação             | Tratamento                                              |
| -------------------- | ------------------------------------------------------- |
| 401 / 403            | `auth`: token inválido ou expirado. Reconecte.          |
| 429                  | Uma nova tentativa após 2 s; se persistir, `rateLimit`. |
| Sem resposta em 30 s | `timeout`                                               |
| Falha de rede        | `network`                                               |
| 5xx                  | `server`                                                |

As mensagens aparecem em português na notificação, no histórico e no painel.

### Testar conexão

`GET {baseUrl}/api/v1/memory/working-context` com os mesmos cabeçalhos. A rota é autenticada:
token inválido responde 401/403. O `/health` é público e respondia 200 até com token errado,
por isso não serve como teste.

## Vocabulário da empresa (2.2)

Ao começar a gravar (e de novo quando entram participantes novos, no máximo 4 vezes por
gravação, com 30 s de intervalo), a extensão pede ao ValorBrain o vocabulário da reunião:

`POST {baseUrl}/api/v1/meet/vocabulary` com `{ "participants": ["Gustavo", "Ana Souza"], "limit": 40 }`

Os nomes vão no corpo, nunca na URL (proxies e CDNs guardam URLs em log). Engine sem essa rota
(404/405): a extensão pede `GET …/api/v1/meet/vocabulary?limit=40`, sem os nomes.

```json
{
  "terms": [{ "term": "gbrain", "kind": "tool", "reason": "meeting" }],
  "corrections": [{ "from": "D-Brain", "to": "gbrain" }],
  "participants": [{ "name": "Ana Souza", "entityId": "…" }],
  "generatedAt": "2026-09-30T10:00:00.000Z"
}
```

- `terms` completam o **Vocabulário da empresa** no prompt do Whisper, na revisão final e no
  resumo (a lista das configurações vem primeiro; participantes já estão no prompt e não se
  repetem). O engine só conta documentos que a conta conectada pode ver.
- `corrections` são aplicadas a cada fala transcrita, sem diferenciar maiúsculas e só em
  palavras inteiras. A extensão confere cada uma antes de usar: termo curto, grafia parecida
  (a mesma régua de 0,5 do engine), um dos lados com cara de nome (maiúscula, dígito ou hífen)
  ou `to` entre os termos servidos, nunca uma parte do nome de alguém da reunião, e nenhum par
  que se alimenta (A → B com B → A trocaria os nomes). Entram em **Grafia revisada na
  transcrição** com as da revisão, contadas só nas falas que ficaram (eco descartado não conta).
- Espera no máximo 8 s (cabeçalhos e corpo) e nunca atrasa a gravação. Token sem permissão ou
  rede fora: a reunião segue só com o vocabulário das configurações.
- No máximo 4 pedidos por gravação, com 30 s entre eles; gente que entra durante um pedido
  gera um novo pedido quando ele termina.

A revisão final não ensina uma correção que desfaz uma aprendida (o ValorBrain recusa também:
`to` que já é apelido).

Depois que a reunião chega ao ValorBrain, as correções que a revisão final aceitou (não as que
vieram do ValorBrain) vão como apelidos:

`POST {baseUrl}/api/v1/meet/aliases`

```json
{ "aliases": [{ "from": "Rapplet", "to": "Replit" }] }
```

O engine decide cada uma e responde `{ "recorded": [...], "skipped": [...] }`: grava como
apelido da entidade certa, nunca junta entidades e recusa `from` que já é um nome estabelecido,
grafia distante e termo genérico. Só acontece para reuniões enviadas (a escolha de envio do
usuário vale também aqui).

## Aviso de gravação no chat (2.2)

Com **Configurações → Recursos → Avisar no chat que a reunião está sendo gravada** ligado
(`recordingChatNotice`, desligado por padrão), a extensão publica a mensagem de
`recordingChatNoticeText` (ou o texto padrão) no chat do Google Meet ao começar a gravar.

- Uma vez por reunião: gravar de novo na mesma chamada em até 3 h não repete. A reunião é
  lembrada pelo código da URL da chamada, nunca pelo título da aba.
- Só na sala gravada (o content script confere o código da reunião na URL) e só enquanto a
  gravação continua; enviado = a caixa de mensagem esvaziou.
- Se o chat não aparecer em ~30 s, a pessoa é avisada para informar os participantes.
- Zoom e Teams: não publica (as páginas também têm conversas privadas; a leitura do chat da
  reunião ainda não foi conferida numa chamada real). A pessoa é avisada na hora.

Nada vai ao ValorBrain.

## Permissões

- `host_permissions` já cobre `https://*.valor.digital/*`.
- Outro endereço (ValorBrain próprio, provedor de IA na rede local) é pedido ao salvar as
  configurações, via `optional_host_permissions`.
- A CSP das páginas da extensão permite `connect-src 'self' https: http:`; o que decide o
  acesso é a permissão de host.

## Teste manual contra um ValorBrain real

Substitua pelos seus valores (nenhuma chave real fica neste repositório):

```bash
BASE_URL="https://valorbrain-api.valor.digital"
TOKEN="<token do tenant>"

# 1. Conexão (o mesmo pedido do botão "Testar conexão")
curl -sS -o /dev/null -w "working-context: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/v1/memory/working-context"

# 2. Gravar uma memória no formato que a extensão envia
curl -sS -w "\nstore: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "observation",
    "title": "Reunião: teste de integração (2026-01-15 12:00)",
    "content": "## Resumo\nTeste de integração do ValorBrain Meet.\n\n## Decisões\n_(nenhuma)_\n\n## Próximos passos\n_(nenhum)_\n\n## Transcrição\n[00:10] Pessoa: Olá.",
    "collection": "meetings",
    "tags": ["reuniao", "meet", "valorbrain-meet"],
    "confidence": 0.85
  }' \
  "$BASE_URL/api/v1/memory/store"

# 3. Token errado (espera 401/403)
curl -sS -o /dev/null -w "token errado: %{http_code}\n" \
  -H "Authorization: Bearer errado" \
  "$BASE_URL/api/v1/memory/working-context"
```

Esperado: `working-context: 200`, `store: 200` (ou `201`) com `path` ou `docid` no corpo, e
`401`/`403` para o token errado.

No navegador: conecte em **Configurações → ValorBrain**, clique em **Testar conexão**, grave
uma reunião curta e encerre. A notificação "Reunião salva no ValorBrain" confirma o envio, e o
**Histórico** mostra o selo **No ValorBrain**.
