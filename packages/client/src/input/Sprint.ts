import { NetworkClient } from "../net/NetworkClient";

/**
 * Hold SPACE to sprint. We only send the edges (press → on, release → off); the
 * server owns the actual sprint (drains stamina, applies the +30% speed boost).
 * A blur force-releases so a held key can't get "stuck on" if the window loses
 * focus mid-sprint. Typing in a text field never triggers a sprint.
 */
export function setupSprint(net: NetworkClient) {
  let held = false;

  const inField = (t: EventTarget | null) => {
    const tag = (t as HTMLElement | null)?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA";
  };
  const isSpace = (e: KeyboardEvent) => e.code === "Space" || e.key === " ";
  const setHeld = (on: boolean) => {
    if (on === held) return;
    held = on;
    net.sendSprint(on);
  };

  window.addEventListener("keydown", (e) => {
    if (!isSpace(e) || inField(e.target)) return;
    e.preventDefault(); // SPACE would otherwise scroll the page / re-click a focused button
    if (e.repeat) return; // auto-repeat isn't a fresh press
    setHeld(true);
  });
  window.addEventListener("keyup", (e) => {
    if (!isSpace(e)) return;
    setHeld(false);
  });
  // Tab-out / lost focus → stop sprinting (we may never see the keyup).
  window.addEventListener("blur", () => setHeld(false));
}
