// Visibility alone misses a visible tab in an unfocused browser window.
// Resume only after both conditions hold; callers reset their frame clock.
export function watchPageActivity({ window: win, document: doc, onPause, onResume }) {
  let focused = doc.hasFocus(), active;
  const sync = () => {
    const next = focused && !doc.hidden;
    if (next === active) return;
    active = next;
    (active ? onResume : onPause)();
  };
  const blur = () => { focused = false; sync(); };
  const focus = () => { focused = true; sync(); };
  const visibility = () => {
    if (!doc.hidden) focused = doc.hasFocus();
    sync();
  };
  win.addEventListener("blur", blur);
  win.addEventListener("focus", focus);
  doc.addEventListener("visibilitychange", visibility);
  sync();
  return {
    get active() { return active; },
    dispose() {
      win.removeEventListener("blur", blur);
      win.removeEventListener("focus", focus);
      doc.removeEventListener("visibilitychange", visibility);
    },
  };
}
