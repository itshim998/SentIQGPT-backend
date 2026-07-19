/* ============================================================
   SentIQ Liquid Glass V4 — Phase 4.2
   Contextual starter chips

   Reuses the established file, WebSurf, image-generation, and composer paths.
   No authentication, upload, search, or generation contract is duplicated here.
   ============================================================ */

const ACTIONS = Object.freeze([
  {
    source: "file",
    action: "attach",
    label: "Attach",
    icon: '<path d="M20.5 11.5 12 20a5.5 5.5 0 0 1-7.8-7.8l8.4-8.4a3.7 3.7 0 0 1 5.2 5.2l-8.4 8.4a1.9 1.9 0 0 1-2.7-2.7l7.7-7.7"/>',
  },
  {
    source: "math",
    action: "analyse",
    label: "Analyse",
    icon: '<path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19H2"/>',
  },
  {
    source: "code",
    action: "create",
    label: "Create",
    icon: '<path d="m12 3 1.35 4.15L17.5 8.5l-4.15 1.35L12 14l-1.35-4.15L6.5 8.5l4.15-1.35L12 3Z"/><path d="m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14Z"/>',
  },
  {
    source: "web",
    action: "research",
    label: "Research",
    icon: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/><path d="M4 11h14"/><path d="M11 4a11 11 0 0 1 0 14"/>',
  },
]);

function isElementVisible(element) {
  if (!element || element.hidden || element.style?.display === "none") return false;
  if (typeof window.getComputedStyle !== "function") return true;
  return window.getComputedStyle(element).display !== "none";
}

function setButtonDisabled(button, disabled) {
  if (!button) return;
  const next = Boolean(disabled);
  if (button.disabled !== next) button.disabled = next;
  const ariaDisabled = next ? "true" : "false";
  if (button.getAttribute("aria-disabled") !== ariaDisabled) {
    button.setAttribute("aria-disabled", ariaDisabled);
  }
}

function setComposerDraft(input, value) {
  if (!input || input.disabled) return;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  input.setSelectionRange(value.length, value.length);
}

function initializeContextualStarterActions() {
  const starterActions = document.getElementById("starter-actions");
  const chatInputWrapper = document.querySelector(".chat-input-wrapper");
  const chatInputArea = document.querySelector(".chat-input-area");
  const chatInput = document.getElementById("chat-input");
  const fileInput = document.getElementById("file-input");
  const fileAttachButton = document.getElementById("file-attach-btn");
  const imageGenerationButton = document.getElementById("image-gen-btn");
  const webSearchButton = document.getElementById("websurf-basic-btn");
  const accountButton = document.getElementById("account-btn");

  if (!starterActions || !chatInputWrapper || !chatInputArea || !chatInput) return;

  if (starterActions.parentElement !== chatInputWrapper || starterActions.previousElementSibling !== chatInputArea) {
    chatInputArea.insertAdjacentElement("afterend", starterActions);
  }

  starterActions.classList.add("contextual-starter-chips");
  starterActions.setAttribute("role", "toolbar");
  starterActions.setAttribute("aria-label", "Quick actions");

  const buttonsByAction = new Map();
  for (const config of ACTIONS) {
    const button = starterActions.querySelector(`[data-starter-action="${config.source}"]`);
    if (!button) continue;

    button.dataset.contextualAction = config.action;
    button.classList.add(`starter-action-${config.action}`);

    const icon = button.querySelector(".starter-action-icon");
    if (icon) {
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${config.icon}</svg>`;
    }

    const label = Array.from(button.children).find((child) => child !== icon);
    if (label && label.textContent !== config.label) label.textContent = config.label;
    buttonsByAction.set(config.action, button);
  }

  function getCapabilityState() {
    const signedIn = isElementVisible(accountButton);
    const imageAvailable = signedIn
      && isElementVisible(imageGenerationButton)
      && !imageGenerationButton?.disabled;
    const researchAvailable = Boolean(webSearchButton && !webSearchButton.disabled);
    const composerAvailable = !chatInput.disabled;
    const attachAvailable = Boolean(fileInput && !fileInput.disabled && !fileAttachButton?.disabled);
    return { signedIn, imageAvailable, researchAvailable, composerAvailable, attachAvailable };
  }

  function syncActionState() {
    const state = getCapabilityState();
    const attach = buttonsByAction.get("attach");
    const analyse = buttonsByAction.get("analyse");
    const create = buttonsByAction.get("create");
    const research = buttonsByAction.get("research");

    setButtonDisabled(attach, !state.attachAvailable);
    setButtonDisabled(analyse, !state.composerAvailable);
    setButtonDisabled(create, !state.imageAvailable && !state.composerAvailable);
    setButtonDisabled(research, !state.researchAvailable);

    if (attach) {
      attach.title = "Attach a file or image";
      attach.setAttribute("aria-label", "Attach a file or image");
    }
    if (analyse) {
      analyse.title = "Analyse text, a file, or an image";
      analyse.setAttribute("aria-label", "Analyse text, a file, or an image");
    }
    if (create) {
      const createLabel = state.imageAvailable
        ? "Create an image"
        : state.signedIn
          ? "Create with SentIQ Chat"
          : "Create with text; sign in for image generation";
      create.title = createLabel;
      create.setAttribute("aria-label", createLabel);
      create.dataset.capability = state.imageAvailable ? "image" : "text";
    }
    if (research) {
      research.title = state.researchAvailable
        ? "Research current information on the web"
        : "Research is unavailable right now";
      research.setAttribute("aria-label", research.title);
    }
  }

  starterActions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-contextual-action]");
    if (!button || button.disabled || !starterActions.contains(button)) return;

    const action = button.dataset.contextualAction;
    if (action === "attach" || action === "research") return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (action === "analyse") {
      setComposerDraft(chatInput, "Analyse this and explain the key findings:\n\n");
      return;
    }

    if (action === "create") {
      const { imageAvailable } = getCapabilityState();
      if (imageAvailable) {
        imageGenerationButton.click();
      } else {
        setComposerDraft(chatInput, "Help me create ");
      }
    }
  }, true);

  const observer = new MutationObserver(syncActionState);
  [chatInput, fileAttachButton, imageGenerationButton, webSearchButton, accountButton].forEach((element) => {
    if (!element) return;
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["class", "disabled", "hidden", "style", "aria-disabled"],
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncActionState();
  });
  window.addEventListener("focus", syncActionState);

  syncActionState();
}

if (typeof document !== "undefined") {
  const start = () => window.setTimeout(initializeContextualStarterActions, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
