import test from "node:test";
import assert from "node:assert/strict";

import {
  microphoneErrorCode,
  microphoneNotice,
  SYSTEM_DENIED,
  systemMicrophoneHelp,
} from "./microphoneErrors.ts";

test("an operating-system block is told apart from a Chrome block", () => {
  assert.equal(
    microphoneErrorCode({ name: "NotAllowedError", message: "Permission denied by system" }),
    SYSTEM_DENIED,
  );
  assert.equal(
    microphoneErrorCode({ name: "NotAllowedError", message: "Permission denied" }),
    "NotAllowedError",
  );
  assert.equal(
    microphoneErrorCode({ name: "NotFoundError", message: "Requested device not found" }),
    "NotFoundError",
  );
  assert.equal(microphoneErrorCode(null), "Error");
  assert.equal(microphoneErrorCode({ message: "no name" }), "Error");
});

test("system block help points to the settings of each operating system", () => {
  assert.match(
    systemMicrophoneHelp("mac"),
    /Ajustes do Sistema → Privacidade e Segurança → Microfone/,
  );
  assert.match(systemMicrophoneHelp("mac"), /Google Chrome/);
  assert.match(systemMicrophoneHelp("win"), /Configurações → Privacidade e segurança → Microfone/);
  assert.match(systemMicrophoneHelp("linux"), /configurações de privacidade do sistema/);
  assert.match(systemMicrophoneHelp(undefined), /configurações de privacidade do sistema/);
});

test("recording notice explains each microphone failure", () => {
  const macBlock = microphoneNotice(true, SYSTEM_DENIED, "mac");
  assert.match(macBlock, /macOS está bloqueando/);
  assert.match(macBlock, /reinicie a gravação/);
  assert.match(macBlock, /sem a sua voz/);

  assert.match(microphoneNotice(true, "NotAllowedError"), /Configurações → Microfone/);
  assert.match(microphoneNotice(false, null), /ainda não foi liberado/);
  assert.match(microphoneNotice(true, "NotFoundError"), /Nenhum microfone/);
  assert.match(microphoneNotice(true, "NotReadableError"), /ocupado/);
  assert.match(microphoneNotice(true, "Weird"), /não entrou na gravação/);
});
