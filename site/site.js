// Theme of meet.valorbra.in: the saved choice, otherwise the system preference
// (Paper is the brand default). Loaded in <head> so the page never flashes.
// Also opens the update steps for the extension's #atualizar link.
(() => {
  const KEY = "vbmeet-site-theme";
  const THEMES = ["paper", "light", "dark"];
  const root = document.documentElement;

  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // Storage blocked (private mode): fall back to the system preference.
  }
  const initial = THEMES.includes(saved)
    ? saved
    : matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "paper";
  root.dataset.theme = initial;

  // meet.valorbra.in/#atualizar (the extension's "Como atualizar" link) opens
  // the update steps, which sit in a closed <details>.
  const openUpdateSteps = () => {
    if (location.hash !== "#atualizar") return;
    const details = document.getElementById("atualizar");
    if (!details) return;
    details.open = true;
    details.scrollIntoView();
  };
  document.addEventListener("DOMContentLoaded", openUpdateSteps);
  window.addEventListener("hashchange", openUpdateSteps);

  document.addEventListener("DOMContentLoaded", () => {
    const select = document.getElementById("theme");
    if (!select) return;
    select.value = initial;
    select.addEventListener("change", () => {
      root.dataset.theme = select.value;
      try {
        localStorage.setItem(KEY, select.value);
      } catch {
        // Not persisted; the choice still applies to this visit.
      }
    });
  });
})();
