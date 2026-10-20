/* SentIQ Liquid Glass V4 — Pass 8.4 SentIQ Live presentation */

const LIVE_SURFACE_VERSION = "8.4";
const LIVE_FAILURE_STATES = new Set([
  "error",
  "quota_denied",
  "mic_blocked",
  "websocket_failed",
  "audio_failed",
  "unavailable",
]);
const LIVE_RETRYABLE_STATES = new Set([
  "error",
  "mic_blocked",
  "websocket_failed",
  "audio_failed",
]);

function setHidden(element, hidden) {
  if (!(element instanceof HTMLElement)) return;
  const next = Boolean(hidden);
  if (element.hidden !== next) element.hidden = next;
}

function setText(element, value) {
  if (!(element instanceof HTMLElement)) return;
  const next = String(value ?? "");
  if (element.textContent !== next) element.textContent = next;
}

function initializeLiveSurface() {
  if (typeof document === "undefined") return;

  const panel = document.getElementById("live-beta-panel");
  const surface = panel?.querySelector(".live-beta-surface");
  const header = panel?.querySelector(".live-beta-header");
  const eyebrow = panel?.querySelector(".live-beta-eyebrow");
  const stateRow = panel?.querySelector(".live-beta-state-row");
  const stateLabel = document.getElementById("live-beta-state");
  const message = document.getElementById("live-beta-message");
  const remaining = document.getElementById("live-beta-remaining");
  const visual = panel?.querySelector(".live-beta-visual");
  const controls = panel?.querySelector(".live-beta-controls");
  const muteButton = document.getElementById("live-beta-mute");
  const closeButton = document.getElementById("live-beta-close-btn");
  const retryButton = document.getElementById("live-beta-retry");
  const transcriptWrap = document.getElementById("live-beta-transcript-wrap");
  const transcript = document.getElementById("live-beta-transcript");

  if (!(panel instanceof HTMLElement)
      || !(surface instanceof HTMLElement)
      || !(header instanceof HTMLElement)
      || !(stateRow instanceof HTMLElement)
      || !(message instanceof HTMLElement)
      || !(controls instanceof HTMLElement)
      || !(transcriptWrap instanceof HTMLDetailsElement)
      || !(transcript instanceof HTMLElement)) return;
  if (panel.dataset.liveSurfaceVersion === LIVE_SURFACE_VERSION) return;

  panel.dataset.liveSurfaceVersion = LIVE_SURFACE_VERSION;
  panel.classList.add("live-workspace-v84");
  surface.classList.add("live-workspace-surface");
  header.classList.add("live-workspace-header");
  visual?.classList.add("live-workspace-voice-object");
  controls.classList.add("live-workspace-controls");

  setText(eyebrow, "Live voice");
  surface.setAttribute("aria-describedby", "live-beta-message");
  stateLabel?.setAttribute("aria-atomic", "true");
  message.setAttribute("aria-live", "polite");
  message.setAttribute("aria-atomic", "true");
  remaining?.setAttribute("role", "status");
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Live voice controls");
  muteButton?.setAttribute("data-live-control", "mute");

  let connection = surface.querySelector(".live-workspace-connection");
  if (!connection) {
    connection = document.createElement("section");
    connection.className = "live-workspace-connection";
    connection.setAttribute("aria-label", "Connection state");
    stateRow.before(connection);
    connection.append(stateRow, message);
  }

  let transcriptSheet = transcriptWrap.querySelector(".live-workspace-transcript-sheet");
  let transcriptClose = document.getElementById("live-beta-transcript-close");
  let transcriptEmpty = document.getElementById("live-beta-transcript-empty");
  const transcriptToggle = document.getElementById("live-beta-transcript-toggle");
  if (!transcriptSheet) {
    transcriptSheet = document.createElement("div");
    transcriptSheet.className = "live-workspace-transcript-sheet";
    transcriptSheet.setAttribute("role", "region");
    transcriptSheet.setAttribute("aria-labelledby", "live-beta-transcript-title");

    const transcriptHeader = document.createElement("header");
    transcriptHeader.className = "live-workspace-transcript-header";
    transcriptHeader.innerHTML = `
      <div>
        <strong id="live-beta-transcript-title">Live transcript</strong>
        <span>Words appear here as the conversation continues.</span>
      </div>
    `;

    transcriptClose = document.createElement("button");
    transcriptClose.id = "live-beta-transcript-close";
    transcriptClose.className = "live-workspace-transcript-close";
    transcriptClose.type = "button";
    transcriptClose.setAttribute("aria-label", "Close transcript");
    transcriptClose.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"></path><path d="M6 6l12 12"></path></svg>';
    transcriptHeader.appendChild(transcriptClose);

    transcriptEmpty = document.createElement("p");
    transcriptEmpty.id = "live-beta-transcript-empty";
    transcriptEmpty.className = "live-workspace-transcript-empty";
    transcriptEmpty.textContent = "Transcript appears as you talk.";

    transcript.before(transcriptSheet);
    transcriptSheet.append(transcriptHeader, transcriptEmpty, transcript);
  }

  transcriptWrap.classList.add("live-workspace-transcript-host");
  transcriptWrap.setAttribute("aria-label", "Live transcript sheet");

  let fallbackActions = surface.querySelector(".live-workspace-fallback-actions");
  let fallbackNote = document.getElementById("live-beta-fallback-note");
  let chatFallback = document.getElementById("live-beta-chat-fallback");
  if (!fallbackActions) {
    fallbackActions = document.createElement("div");
    fallbackActions.className = "live-workspace-fallback-actions";

    fallbackNote = document.createElement("p");
    fallbackNote.id = "live-beta-fallback-note";
    fallbackNote.className = "live-workspace-fallback-note";

    chatFallback = document.createElement("button");
    chatFallback.id = "live-beta-chat-fallback";
    chatFallback.className = "live-workspace-chat-fallback";
    chatFallback.type = "button";
    chatFallback.textContent = "Continue in chat";

    if (retryButton instanceof HTMLElement) retryButton.before(fallbackActions);
    else controls.after(fallbackActions);
    fallbackActions.append(fallbackNote);
    if (retryButton instanceof HTMLElement) fallbackActions.append(retryButton);
    fallbackActions.append(chatFallback);
  }

  const transcriptBackgroundState = new Map();
  const transcriptBackgroundNodes = [header, visual, connection, controls, fallbackActions]
    .filter((node) => node instanceof HTMLElement);
  let pendingComposerFocus = false;

  function fallbackCopy(state) {
    if (state === "quota_denied") return "Live voice is unavailable. Continue in text.";
    if (state === "mic_blocked") return "Live voice needs microphone access.";
    if (state === "unavailable") return "Live voice isn't available on this device or account.";
    return "Live voice stopped. Continue in text.";
  }

  function syncTranscriptEmptyState() {
    if (!(transcriptEmpty instanceof HTMLElement)) return;
    const hasTranscript = transcript.querySelector(".live-beta-transcript-line") !== null
      || Boolean(transcript.textContent?.trim());
    setHidden(transcriptEmpty, hasTranscript);
    transcript.dataset.empty = hasTranscript ? "false" : "true";
  }

  function setTranscriptBackgroundInert(active) {
    transcriptBackgroundNodes.forEach((node) => {
      if (active) {
        if (!transcriptBackgroundState.has(node)) {
          transcriptBackgroundState.set(node, {
            inert: Boolean(node.inert),
            hadInert: node.hasAttribute("inert"),
            ariaHidden: node.getAttribute("aria-hidden"),
          });
        }
        node.inert = true;
        node.setAttribute("inert", "");
        node.setAttribute("aria-hidden", "true");
        return;
      }

      const previous = transcriptBackgroundState.get(node);
      if (!previous) return;
      node.inert = previous.inert;
      if (previous.hadInert) node.setAttribute("inert", "");
      else node.removeAttribute("inert");
      if (previous.ariaHidden === null) node.removeAttribute("aria-hidden");
      else node.setAttribute("aria-hidden", previous.ariaHidden);
      transcriptBackgroundState.delete(node);
    });
  }

  function syncTranscriptState(options = {}) {
    const open = transcriptWrap.open;
    panel.classList.toggle("live-transcript-open", open);
    transcriptToggle?.setAttribute("aria-expanded", open ? "true" : "false");
    transcriptToggle?.setAttribute("aria-label", open ? "Hide transcript" : "Show transcript");
    if (transcriptSheet instanceof HTMLElement) {
      transcriptSheet.inert = !open;
      transcriptSheet.toggleAttribute("inert", !open);
      transcriptSheet.setAttribute("aria-hidden", open ? "false" : "true");
    }
    setTranscriptBackgroundInert(open);
    syncTranscriptEmptyState();
    if (open && options.focusClose && transcriptClose instanceof HTMLElement) {
      window.requestAnimationFrame(() => transcriptClose.focus({ preventScroll: true }));
    }
  }

  function closeTranscript(options = {}) {
    if (transcriptWrap.open) transcriptWrap.open = false;
    syncTranscriptState();
    if (options.restoreFocus && transcriptToggle instanceof HTMLElement) {
      window.requestAnimationFrame(() => transcriptToggle.focus({ preventScroll: true }));
    }
  }

  function syncLiveState() {
    const state = panel.dataset.state || "connecting";
    const failure = LIVE_FAILURE_STATES.has(state);
    const panelClosed = panel.hidden || panel.getAttribute("aria-hidden") === "true";
    panel.dataset.liveConnectionTone = failure ? "fallback" : state;
    setHidden(fallbackActions, !failure);
    setText(fallbackNote, fallbackCopy(state));
    setHidden(chatFallback, !failure);
    if (retryButton instanceof HTMLElement && !LIVE_RETRYABLE_STATES.has(state)) {
      setHidden(retryButton, true);
    }
    if (failure || panelClosed) closeTranscript();
  }

  transcriptToggle?.addEventListener("click", () => {
    window.queueMicrotask(() => syncTranscriptState({ focusClose: transcriptWrap.open }));
  });
  transcriptClose?.addEventListener("click", () => closeTranscript({ restoreFocus: true }));
  transcriptWrap.addEventListener("toggle", () => syncTranscriptState());
  transcriptWrap.addEventListener("click", (event) => {
    if (event.target === transcriptWrap) closeTranscript({ restoreFocus: true });
  });

  document.addEventListener("keydown", (event) => {
    if (!transcriptWrap.open || panel.hidden || panel.getAttribute("aria-hidden") === "true") return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeTranscript({ restoreFocus: true });
      return;
    }
    if (event.key !== "Tab") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (transcriptClose instanceof HTMLElement) transcriptClose.focus({ preventScroll: true });
  }, true);

  chatFallback?.addEventListener("click", () => {
    pendingComposerFocus = true;
    closeTranscript();
    const closeBtn = document.getElementById("live-beta-close-btn");
    if (closeBtn) closeBtn.click();
    else window.SentIQLive?.terminate?.({ reason: "fallback_chat" });
    window.SentIQPanels?.sync?.();
  });

  panel.addEventListener("sentiq-panel-opened", () => {
    syncLiveState();
    syncTranscriptState();
  });
  panel.addEventListener("sentiq-panel-closed", () => {
    closeTranscript();
    document.body.classList.remove("live-beta-open");
    window.SentIQPanels?.sync?.();
    if (!pendingComposerFocus) return;
    pendingComposerFocus = false;
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        const composer = document.getElementById("chat-input");
        if (composer instanceof HTMLElement && !composer.matches(":disabled")) composer.focus({ preventScroll: true });
      }, 0);
    });
  });

  const stateObserver = new MutationObserver(() => syncLiveState());
  stateObserver.observe(panel, {
    attributes: true,
    attributeFilter: ["data-state", "hidden", "aria-hidden"],
  });
  const transcriptObserver = new MutationObserver(syncTranscriptEmptyState);
  transcriptObserver.observe(transcript, { childList: true, subtree: true, characterData: true });

  syncLiveState();
  syncTranscriptState();

  window.SentIQLiveSurface = Object.freeze({
    version: LIVE_SURFACE_VERSION,
    sync: () => {
      syncLiveState();
      syncTranscriptState();
    },
    closeTranscript,
  });
}

initializeLiveSurface();
