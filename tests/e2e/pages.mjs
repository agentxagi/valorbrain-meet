// Fake meeting pages for the end-to-end run (tests/e2e/run.mjs).
//
// Google Meet: the structure the content script reads (tiles with
// data-participant-id / data-self-name, the chat panel, the leave screen).
// Zoom and Teams: built from the selectors in src/platformDom.ts. They prove
// the wiring (the adapter finds names, the recording runs, and nothing is
// typed into their chats while that stays disabled), NOT that the real
// Zoom/Teams DOM looks like this.

const CHAT_SCRIPT = `
  window.__chatMessages = [];
  function __recordMessage(text) {
    window.__chatMessages.push(text);
    const li = document.createElement("li");
    li.className = "e2e-chat-message";
    li.textContent = text;
    document.getElementById("e2e-messages").appendChild(li);
  }
`;

const PLAY_SCRIPT = `
  window.__e2ePlay = () => {
    const audio = new Audio("/e2e-audio/tab.wav");
    window.__audio = audio;
    return audio.play().then(() => true, (err) => String(err));
  };
`;

export function meetPage() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Meet – abc-defg-hij</title></head>
<body>
  <header><button aria-label="Conta do Google: Gus Teste (gus@example.com)">G</button></header>
  <main id="room">
    <div data-participant-id="p-self"><div data-self-name="Gus Teste"></div><span class="notranslate">Gus Teste</span>
      <button aria-label="Mais opções para Gus Teste (você)">⋮</button></div>
    <div data-participant-id="p-ana"><span class="notranslate">Ana Souza</span>
      <button aria-label="Mais opções para Ana Souza">⋮</button></div>
    <div data-participant-id="p-bruno"><span class="notranslate">Bruno Lima</span>
      <button aria-label="Mais opções para Bruno Lima">⋮</button></div>
    <button data-is-muted="false" aria-label="Desativar microfone (ctrl + d)">mic</button>
    <button id="chat-toggle" aria-label="Chat com todos">chat</button>
    <aside id="chat-panel"></aside>
    <ul id="e2e-messages"></ul>
    <button id="leave" aria-label="Sair da chamada">sair</button>
  </main>
  <script>
    ${CHAT_SCRIPT}
    ${PLAY_SCRIPT}
    document.getElementById("chat-toggle").addEventListener("click", () => {
      const panel = document.getElementById("chat-panel");
      if (panel.querySelector("textarea")) return;
      panel.innerHTML = '<textarea aria-label="Enviar uma mensagem para todos"></textarea>' +
        '<button aria-label="Enviar mensagem">enviar</button>';
      const box = panel.querySelector("textarea");
      panel.querySelector("button").addEventListener("click", () => {
        if (!box.value.trim()) return;
        __recordMessage(box.value);
        box.value = "";
      });
    });
    window.__e2eLeave = () => {
      window.__audio?.pause();
      document.body.innerHTML = '<h1>Você saiu da reunião</h1><button>Participar novamente</button>';
    };
  </script>
</body></html>`;
}

export function zoomPage() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Zoom</title></head>
<body>
  <div class="video-avatar__avatar"><span class="video-avatar__avatar-name">Carla Dias</span></div>
  <div class="video-avatar__avatar"><span class="video-avatar__avatar-name">Gus Teste (Host, me)</span></div>
  <div id="wc-footer">
    <button aria-label="mute my microphone">audio</button>
    <button aria-label="open the chat panel" id="zoom-chat">chat</button>
    <button class="footer__leave-btn" aria-label="Leave">leave</button>
  </div>
  <div id="zoom-chat-panel"></div>
  <ul id="e2e-messages"></ul>
  <script>
    ${CHAT_SCRIPT}
    document.getElementById("zoom-chat").addEventListener("click", () => {
      const panel = document.getElementById("zoom-chat-panel");
      if (panel.querySelector("[contenteditable]")) return;
      panel.innerHTML = '<div class="chat-rtf-box__editor-outer"><div contenteditable="true" class="tiptap" aria-label="Type message here..."></div></div>' +
        '<button class="chat-rtf-box__send" aria-label="send">send</button>';
      const editor = panel.querySelector("[contenteditable]");
      panel.querySelector("button").addEventListener("click", () => {
        if (!editor.textContent.trim()) return;
        __recordMessage(editor.textContent);
        editor.textContent = "";
      });
    });
  </script>
</body></html>`;
}

export function teamsPage() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Microsoft Teams</title></head>
<body>
  <div data-tid="calling-toolbar">
    <button id="microphone-button" aria-label="Ativar mudo (Ctrl+Shift+M)">mic</button>
    <button id="chat-button" aria-label="Mostrar conversa">chat</button>
    <button id="hangup-button" aria-label="Sair">sair</button>
  </div>
  <div data-cid="calling-participant-stream"><span data-tid="calling-participant-name">Diego Braga</span></div>
  <div data-cid="calling-participant-stream"><span data-tid="calling-participant-name">Gus Teste (Você)</span></div>
  <div id="teams-chat-panel"></div>
  <ul id="e2e-messages"></ul>
  <script>
    ${CHAT_SCRIPT}
    document.getElementById("chat-button").addEventListener("click", () => {
      const panel = document.getElementById("teams-chat-panel");
      if (panel.querySelector("[contenteditable]")) return;
      panel.innerHTML = '<div data-tid="ckeditor" contenteditable="true" role="textbox" aria-label="Digite uma mensagem"></div>' +
        '<button data-tid="newMessageCommands-send" aria-label="Enviar">enviar</button>';
      const editor = panel.querySelector("[contenteditable]");
      panel.querySelector("button").addEventListener("click", () => {
        if (!editor.textContent.trim()) return;
        __recordMessage(editor.textContent);
        editor.textContent = "";
      });
    });
  </script>
</body></html>`;
}
