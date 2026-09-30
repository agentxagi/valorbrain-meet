# Privacidade

O ValorBrain Meet roda inteiro no seu Chrome. Não há bot na chamada, servidor próprio da
extensão, telemetria nem analytics. Os dados só saem do navegador para os três destinos que
você configurou.

## Para onde vão os dados

| Dado                                                              | Destino                           | Quando                                                                                                                 |
| ----------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Áudio da reunião (aba + seu microfone)                            | Provedor de transcrição escolhido | Durante a gravação, em trechos. Trechos sem fala são descartados no próprio navegador.                                 |
| Texto da transcrição e vocabulário da empresa                     | Provedor de resumo escolhido      | Durante a gravação (resumo parcial) e ao encerrar (resumo final)                                                       |
| Reunião completa (resumo, decisões, próximos passos, transcrição) | Seu tenant do ValorBrain          | Ao encerrar, se conectado e com envio automático ligado, ou quando você clica em **Enviar ao ValorBrain** no Histórico |
| Nomes dos participantes (para buscar o vocabulário da empresa)    | Seu tenant do ValorBrain          | Ao começar a gravar e quando entra alguém, se conectado (desligável em **Configurações → ValorBrain**)                 |
| Correções aceitas na revisão final ("Rapplet" → "Replit")         | Seu tenant do ValorBrain          | Depois que a reunião é enviada, se **Ensinar ao ValorBrain as correções** estiver ligado                               |
| Aviso de gravação (texto das configurações)                       | Chat da própria reunião           | Ao começar a gravar, só se você ligou **Avisar no chat que a reunião está sendo gravada**                              |

Com o **Whisper local**, o áudio não sai do computador. Com o **Whisper remoto** ou a
**OpenAI**, o áudio vai para esse servidor. Leia a política do provedor que usar.

A captura só começa depois de um clique no ícone ou do atalho de gravação: o Chrome não
deixa uma extensão gravar uma aba por conta própria. Enquanto grava, o ícone mostra **REC**
e a página do Meet mostra o aviso "Gravando" do ValorBrain Meet.

## O que fica no navegador

Tudo fica em `chrome.storage.local` do perfil do Chrome, sem sincronizar entre computadores:

- reuniões salvas (transcrição, resumo, decisões, próximos passos);
- configurações e chaves de API dos provedores e o token do ValorBrain.

As chaves ficam no armazenamento local do Chrome sem criptografia própria: quem tem acesso ao
seu perfil do Chrome consegue lê-las. Use um perfil só seu.

**Configurações → Dados e uso** mostra o espaço usado, apaga reuniões uma a uma e zera tudo.
Apagar no navegador não apaga o que já foi para o ValorBrain.

## Permissões do Chrome

| Permissão                                                                             | Para quê                                                         |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `tabCapture`, `offscreen`                                                             | Capturar e processar o áudio da aba da reunião                   |
| Microfone (pedido uma vez, na página de configurações)                                | Incluir a sua voz na gravação                                    |
| `tabs`                                                                                | Encontrar a aba da reunião e perceber quando você sai dela       |
| `storage`, `unlimitedStorage`                                                         | Guardar reuniões e configurações neste navegador                 |
| `sidePanel`                                                                           | Painel da reunião                                                |
| `notifications`                                                                       | Avisar quando a reunião foi salva, enviada ou deu erro           |
| `contextMenus`                                                                        | "Gravar esta aba com o ValorBrain Meet" no menu do botão direito |
| `identity`                                                                            | Login do "Conectar com ValorBrain" (OAuth)                       |
| Hosts `meet.google.com`, `api.openai.com`, `api.z.ai`, `*.valor.digital`, `localhost` | Página do Meet e provedores padrão                               |
| Hosts `*.zoom.us`, `teams.microsoft.com`, `teams.live.com`, `teams.cloud.microsoft`   | Ler nomes e publicar o aviso nas reuniões do Zoom e do Teams web |
| Outros hosts (opcional)                                                               | Pedidos ao salvar, só se você configurar outro endereço          |

## Consentimento

Avise os participantes de que a reunião está sendo gravada. **Avisar no chat que a reunião
está sendo gravada** (Configurações → Recursos, desligado por padrão) publica esse aviso no
chat da reunião ao começar a gravar, uma vez por reunião; o texto é editável. O resumo para
quem chega atrasado aparece só na sua tela; enviá-lo no chat é opcional e vem desligado.

O vocabulário que o ValorBrain devolve respeita as permissões da sua conta: documentos que
você não pode ver não entram na contagem.

## Problemas de segurança

Não abra issue pública. Veja [`SECURITY.md`](../SECURITY.md).
