/* SentIQ Liquid Glass V4 — Phase 9.4 unsent-content confirmation */

export function createContinuityConfirmationDialog() {
  let root = null;
  let title = null;
  let message = null;
  let cancelButton = null;
  let continueButton = null;
  let pendingResolve = null;
  let previousFocus = null;

  function ensure() {
    if (root) return;
    root = document.createElement("div");
    root.id = "sentiq-continuity-confirmation";
    root.className = "sentiq-continuity-confirmation";
    root.hidden = true;
    root.setAttribute("role", "presentation");
    root.innerHTML = [
      '<div class="sentiq-continuity-confirmation-backdrop" data-continuity-cancel></div>',
      '<section class="sentiq-continuity-confirmation-panel" role="alertdialog" aria-modal="true" aria-labelledby="sentiq-continuity-confirmation-title" aria-describedby="sentiq-continuity-confirmation-message" tabindex="-1">',
      '<div class="sentiq-continuity-confirmation-copy">',
      '<span class="sentiq-continuity-confirmation-kicker">Unsent content</span>',
      '<h2 id="sentiq-continuity-confirmation-title"></h2>',
      '<p id="sentiq-continuity-confirmation-message"></p>',
      '</div>',
      '<div class="sentiq-continuity-confirmation-actions">',
      '<button type="button" class="sentiq-continuity-confirmation-cancel" data-continuity-cancel>Stay here</button>',
      '<button type="button" class="sentiq-continuity-confirmation-continue"></button>',
      '</div>',
      '</section>',
    ].join("");
    document.body.appendChild(root);
    title = root.querySelector("#sentiq-continuity-confirmation-title");
    message = root.querySelector("#sentiq-continuity-confirmation-message");
    cancelButton = root.querySelector(".sentiq-continuity-confirmation-cancel");
    continueButton = root.querySelector(".sentiq-continuity-confirmation-continue");
    root.querySelectorAll("[data-continuity-cancel]").forEach((control) => {
      control.addEventListener("click", () => settle(false));
    });
    continueButton?.addEventListener("click", () => settle(true));
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(false);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [cancelButton, continueButton].filter((control) => control && !control.hidden && !control.disabled);
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function settle(confirmed) {
    if (!root || root.hidden) return;
    const resolve = pendingResolve;
    pendingResolve = null;
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    document.body.classList.remove("sentiq-continuity-confirmation-open");
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
    resolve?.(Boolean(confirmed));
  }

  function confirm(options = {}) {
    ensure();
    if (pendingResolve) settle(false);
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    title.textContent = options.title || "Discard unsent message?";
    message.textContent = options.message || "Unsent content will be lost.";
    continueButton.textContent = options.confirmLabel || "Continue";
    continueButton.dataset.intent = options.intent === "danger" ? "danger" : "default";
    root.hidden = false;
    root.setAttribute("aria-hidden", "false");
    document.body.classList.add("sentiq-continuity-confirmation-open");
    const panel = root.querySelector(".sentiq-continuity-confirmation-panel");
    window.requestAnimationFrame(() => (options.preferCancel === false ? continueButton : cancelButton)?.focus());
    return new Promise((resolve) => {
      pendingResolve = resolve;
      panel?.scrollTo?.({ top: 0 });
    });
  }

  return Object.freeze({
    confirm,
    close: () => settle(false),
    isOpen: () => Boolean(root && !root.hidden),
  });
}
