/* ============================================================
   SentIQ Liquid Glass V4 — Phase 4.1
   Intelligent welcome composition

   Enhances the existing empty-chat surface without replacing authentication,
   chat loading, conversation persistence, or starter-action behaviour.
   ============================================================ */

const WELCOME_COMPOSITION_ID = "sentiq-welcome-continuation";
const EMPTY_CHAT_CLASS = "is-empty-chat";
const GENERIC_ACCOUNT_LABELS = new Set([
  "",
  "account",
  "signed in",
  "add your name",
]);

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function setHidden(element, hidden) {
  if (!element) return;
  const nextHidden = Boolean(hidden);
  if (element.hidden !== nextHidden) element.hidden = nextHidden;
  const ariaHidden = nextHidden ? "true" : "false";
  if (element.getAttribute("aria-hidden") !== ariaHidden) {
    element.setAttribute("aria-hidden", ariaHidden);
  }
}

function isElementVisible(element) {
  if (!element || element.hidden) return false;
  const inlineDisplay = element.style?.display;
  if (inlineDisplay === "none") return false;
  if (typeof window.getComputedStyle !== "function") return true;
  return window.getComputedStyle(element).display !== "none";
}

function getSignedInState(accountButton, loginButton) {
  if (accountButton) return isElementVisible(accountButton);
  return Boolean(loginButton && !isElementVisible(loginButton));
}

function getGreetingName(accountButtonName, accountPanelName) {
  const candidates = [accountButtonName?.textContent, accountPanelName?.textContent];
  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    if (!normalized || GENERIC_ACCOUNT_LABELS.has(normalized.toLowerCase()) || normalized.includes("@")) continue;
    return normalized.split(" ")[0] || "";
  }
  return "";
}

function getHistoryRecencyLabel(item) {
  const group = item?.dataset?.historyGroup;
  if (group === "today") return "From today";
  if (group === "yesterday") return "From yesterday";
  if (group === "previous7") return "From the previous 7 days";
  return "Recent conversation";
}

function getRecentConversation(chatList) {
  if (!chatList) return null;
  const items = Array.from(chatList.querySelectorAll(".chat-list-item"));
  for (const item of items) {
    if (item.classList.contains("active")) continue;
    const title = normalizeText(item.querySelector(".chat-list-item-title")?.textContent);
    if (!title || /^(new chat|untitled conversation)$/i.test(title)) continue;
    return { item, title, recency: getHistoryRecencyLabel(item) };
  }
  return null;
}

function createContinuationSurface(starterActions) {
  const section = document.createElement("section");
  section.id = WELCOME_COMPOSITION_ID;
  section.className = "welcome-continuation";
  section.hidden = true;
  section.setAttribute("aria-label", "Continue recent work");

  const button = document.createElement("button");
  button.className = "welcome-continuation-btn";
  button.type = "button";

  const copy = document.createElement("span");
  copy.className = "welcome-continuation-copy";

  const label = document.createElement("span");
  label.className = "welcome-continuation-label";
  label.textContent = "Continue recent work";

  const title = document.createElement("span");
  title.className = "welcome-continuation-title";

  const meta = document.createElement("span");
  meta.className = "welcome-continuation-meta";

  const arrow = document.createElement("span");
  arrow.className = "welcome-continuation-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "→";

  copy.append(label, title, meta);
  button.append(copy, arrow);
  section.appendChild(button);
  starterActions?.parentElement?.insertBefore(section, starterActions);

  return { section, button, title, meta };
}

function initializeWelcomeComposition() {
  const welcomeScreen = document.getElementById("welcome-screen");
  const welcomeHeading = document.getElementById("welcome-heading");
  const welcomeSubtitle = document.getElementById("welcome-subtitle");
  const welcomeEyebrow = welcomeScreen?.querySelector(".welcome-eyebrow");
  const authWelcomeNote = document.getElementById("auth-welcome-note");
  const starterActions = document.getElementById("starter-actions");
  const mainContent = document.querySelector(".main-content");
  const chatList = document.getElementById("chat-list");
  const accountButton = document.getElementById("account-btn");
  const accountButtonName = document.getElementById("account-btn-name");
  const accountPanelName = document.getElementById("account-panel-name");
  const loginButton = document.getElementById("auth-login-btn");

  if (!welcomeScreen || !welcomeHeading || !welcomeSubtitle || !starterActions || !mainContent) return;

  let continuation = document.getElementById(WELCOME_COMPOSITION_ID);
  let continuationParts;
  if (continuation) {
    continuationParts = {
      section: continuation,
      button: continuation.querySelector(".welcome-continuation-btn"),
      title: continuation.querySelector(".welcome-continuation-title"),
      meta: continuation.querySelector(".welcome-continuation-meta"),
    };
  } else {
    continuationParts = createContinuationSurface(starterActions);
  }

  let selectedConversation = null;
  let renderQueued = false;

  function activateRecentConversation() {
    const item = selectedConversation?.item;
    if (!item?.isConnected) return;
    item.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
  }

  continuationParts.button?.addEventListener("click", activateRecentConversation);

  function render() {
    renderQueued = false;
    const signedIn = getSignedInState(accountButton, loginButton);
    const greetingName = signedIn ? getGreetingName(accountButtonName, accountPanelName) : "";
    const recentConversation = signedIn ? getRecentConversation(chatList) : null;
    const emptyChatVisible = mainContent.classList.contains(EMPTY_CHAT_CLASS)
      && isElementVisible(welcomeScreen);

    welcomeScreen.dataset.welcomeAudience = signedIn ? "member" : "guest";
    welcomeScreen.classList.toggle("has-recent-work", Boolean(recentConversation));

    if (signedIn) {
      setText(welcomeEyebrow, recentConversation ? "Welcome back" : "Your workspace");
      setText(welcomeHeading, greetingName ? `Welcome back, ${greetingName}.` : "Welcome back.");
      setText(
        welcomeSubtitle,
        recentConversation
          ? "Continue where you left off, or start something new."
          : "Start with a question, a file, or something you want to work through.",
      );
      setHidden(authWelcomeNote, true);
    } else {
      setText(welcomeEyebrow, "SentIQ Chat");
      setText(welcomeHeading, "Think, research, and build in one place.");
      setText(
        welcomeSubtitle,
        "Ask questions, work with files, search the web, and turn ideas into clearer next steps.",
      );
      if (authWelcomeNote) {
        setText(authWelcomeNote, "Guest conversations are temporary and stay in this browser tab. Sign in to save and sync your work.");
        setHidden(authWelcomeNote, false);
      }
    }

    selectedConversation = recentConversation;
    const showContinuation = Boolean(signedIn && recentConversation && emptyChatVisible);
    setHidden(continuationParts.section, !showContinuation);
    if (showContinuation) {
      setText(continuationParts.title, recentConversation.title);
      setText(continuationParts.meta, recentConversation.recency);
      continuationParts.button?.setAttribute("aria-label", `Continue recent conversation: ${recentConversation.title}`);
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(render);
  }

  const observer = new MutationObserver(scheduleRender);
  observer.observe(welcomeScreen, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden", "style"] });
  observer.observe(mainContent, { attributes: true, attributeFilter: ["class"] });
  if (chatList) observer.observe(chatList, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "data-history-group"] });
  if (accountButton) observer.observe(accountButton, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden", "style", "aria-expanded"] });
  if (accountPanelName) observer.observe(accountPanelName, { childList: true, characterData: true, subtree: true });
  if (loginButton) observer.observe(loginButton, { attributes: true, attributeFilter: ["class", "hidden", "style"] });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleRender();
  });
  window.addEventListener("focus", scheduleRender);

  scheduleRender();
}

if (typeof document !== "undefined") {
  const start = () => window.setTimeout(initializeWelcomeComposition, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
