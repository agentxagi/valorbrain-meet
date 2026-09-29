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
  "content": "## Resumo\n…\n\n## Decisões\n- …\n\n## Próximos passos\n- [ ] … — Responsável (prazo: …)\n\n## Assuntos\n…\n\n## Pontos em aberto\n…\n\n## Participantes\n…\n\n## Detalhes\n…\n\n## Transcrição\n[00:00] Nome: …",
  "collection": "meetings",
  "tags": ["reuniao", "meet", "valorbrain-meet"],
  "confidence": 0.85
}
```

O título usa o primeiro assunto identificado pelo resumo; sem assunto, o código da reunião.
Seções sem conteúdo (Assuntos, Pontos em aberto, Participantes) são omitidas.

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
