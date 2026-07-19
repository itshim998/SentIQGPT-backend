/* SentIQ Liquid Glass V4 — Phase 7.5 scroll preservation */

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function firstVisibleMessageAnchor(chatMessages) {
  const rootRect = chatMessages.getBoundingClientRect();
  const messages = Array.from(chatMessages.querySelectorAll(":scope > .message"));
  const anchor = messages.find((message) => message.getBoundingClientRect().bottom > rootRect.top + 8);
  if (!(anchor instanceof HTMLElement)) return null;
  return {
    requestId: anchor.dataset.requestId || "",
    signature: clean(anchor.textContent).slice(0, 180),
    offset: Math.round(anchor.getBoundingClientRect().top - rootRect.top),
  };
}

export function captureFailureRecoveryScroll(chatMessages) {
  const distanceFromBottom = chatMessages.scrollHeight - chatMessages.clientHeight - chatMessages.scrollTop;
  return {
    top: Math.round(chatMessages.scrollTop),
    nearBottom: distanceFromBottom <= 72,
    anchor: firstVisibleMessageAnchor(chatMessages),
  };
}

export function restoreFailureRecoveryScroll(chatMessages, snapshot) {
  const scroll = snapshot?.scroll;
  if (!scroll || scroll.nearBottom) return;
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    const anchor = scroll.anchor;
    let target = null;
    if (anchor?.requestId) {
      const escaped = window.CSS?.escape
        ? window.CSS.escape(anchor.requestId)
        : String(anchor.requestId).replace(/["\\]/g, "\\$&");
      target = chatMessages.querySelector(`:scope > .message[data-request-id="${escaped}"]`);
    }
    if (!target && anchor?.signature) {
      target = Array.from(chatMessages.querySelectorAll(":scope > .message")).find(
        (message) => clean(message.textContent).slice(0, 180) === anchor.signature,
      );
    }
    if (target instanceof HTMLElement && anchor) {
      const rootRect = chatMessages.getBoundingClientRect();
      const delta = target.getBoundingClientRect().top - rootRect.top - Number(anchor.offset || 0);
      chatMessages.scrollTop += delta;
    } else {
      chatMessages.scrollTop = Number(scroll.top || 0);
    }
  }));
}
