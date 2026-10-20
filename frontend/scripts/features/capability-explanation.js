/* SentIQ Liquid Glass V4 — Phase 9.3 capability explanation surface */

export function createCapabilityExplainer({ onAction } = {}) {
  let root = null;
  let title = null;
  let reason = null;
  let meta = null;
  let action = null;
  let anchor = null;
  let current = null;

  function ensure() {
    if (root) return;
    root = document.createElement("aside");
    root.id = "sentiq-capability-explanation";
    root.className = "sentiq-capability-explanation";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "false");
    root.setAttribute("aria-labelledby", "sentiq-capability-explanation-title");
    root.setAttribute("aria-describedby", "sentiq-capability-explanation-reason");
    root.tabIndex = -1;
    root.innerHTML = [
      '<div class="sentiq-capability-explanation-copy">',
      '<strong id="sentiq-capability-explanation-title"></strong>',
      '<p id="sentiq-capability-explanation-reason"></p>',
      '<small id="sentiq-capability-explanation-meta"></small>',
      '</div>',
      '<div class="sentiq-capability-explanation-actions">',
      '<button class="sentiq-capability-explanation-action" type="button" hidden></button>',
      '<button class="sentiq-capability-explanation-close" type="button" aria-label="Close availability explanation">Close</button>',
      '</div>',
    ].join("");
    document.body.appendChild(root);
    title = root.querySelector("#sentiq-capability-explanation-title");
    reason = root.querySelector("#sentiq-capability-explanation-reason");
    meta = root.querySelector("#sentiq-capability-explanation-meta");
    action = root.querySelector(".sentiq-capability-explanation-action");
    root.querySelector(".sentiq-capability-explanation-close")?.addEventListener("click", () => close());
    action?.addEventListener("click", () => {
      const cta = current?.cta;
      close();
      if (cta) onAction?.(cta);
    });
  }

  function metaText(capability) {
    const parts = [];
    if (capability.remaining !== null && capability.limit !== null) {
      parts.push(`${capability.remaining} of ${capability.limit} left`);
    }
    if (capability.planName) parts.push(`${capability.planName} plan`);
    if (capability.resetAt) {
      const reset = new Date(capability.resetAt);
      if (Number.isFinite(reset.getTime())) {
        parts.push(`Resets ${reset.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`);
      }
    }
    return parts.join(" · ");
  }

  function render(capability) {
    ensure();
    current = capability;
    root.dataset.capabilityState = capability.state;
    title.textContent = capability.label;
    reason.textContent = capability.reason;
    const details = metaText(capability);
    meta.textContent = details;
    meta.hidden = !details;
    if (capability.cta === "sign-in") {
      action.textContent = "Sign in";
      action.hidden = false;
    } else if (capability.cta === "upgrade") {
      action.textContent = "View plans";
      action.hidden = false;
    } else {
      action.textContent = "";
      action.hidden = true;
    }
  }

  function position() {
    if (!root || root.hidden || !(anchor instanceof HTMLElement)) return;
    if (window.matchMedia?.("(max-width: 640px), (pointer: coarse)")?.matches) {
      root.style.removeProperty("left");
      root.style.removeProperty("top");
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const margin = 12;
    const left = Math.min(window.innerWidth - box.width - margin, Math.max(margin, rect.right - box.width));
    const above = rect.top - box.height - 10;
    const top = above >= margin ? above : Math.min(window.innerHeight - box.height - margin, rect.bottom + 10);
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(Math.max(margin, top))}px`;
  }

  function open(capability, nextAnchor, options = {}) {
    render(capability);
    anchor = nextAnchor instanceof HTMLElement ? nextAnchor : null;
    root.hidden = false;
    root.dataset.open = "true";
    document.body.classList.add("sentiq-capability-explanation-open");
    window.requestAnimationFrame(() => {
      position();
      if (options.focus) root.focus({ preventScroll: true });
    });
    return true;
  }

  function close({ restore = false } = {}) {
    if (!root || root.hidden) return;
    const focusTarget = anchor;
    root.dataset.open = "false";
    root.hidden = true;
    root.style.removeProperty("left");
    root.style.removeProperty("top");
    document.body.classList.remove("sentiq-capability-explanation-open");
    anchor = null;
    current = null;
    if (restore && focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !root || root.hidden) return;
    event.preventDefault();
    close({ restore: true });
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (!root || root.hidden || !(event.target instanceof Node)) return;
    if (root.contains(event.target) || anchor?.contains?.(event.target)) return;
    close();
  }, true);
  window.addEventListener("resize", position, { passive: true });
  window.addEventListener("scroll", position, { passive: true, capture: true });

  return Object.freeze({
    open,
    close,
    update(capability) {
      if (!root || root.hidden) return;
      if (capability?.available) close();
      else if (capability) render(capability);
    },
    getCurrent: () => current,
  });
}
