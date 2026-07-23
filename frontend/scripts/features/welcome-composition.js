/* ============================================================
   SentIQ Liquid Glass V4 — Phase 4.1 / Pass 12.6.2
   Intelligent welcome composition

   Personalizes the existing empty-chat greeting without duplicating chat
   history navigation or replacing authentication and starter behaviour.
   ============================================================ */

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

function initializeWelcomeComposition() {
  const welcomeScreen = document.getElementById("welcome-screen");
  const welcomeHeading = document.getElementById("welcome-heading");
  const welcomeSubtitle = document.getElementById("welcome-subtitle");
  const welcomeEyebrow = welcomeScreen?.querySelector(".welcome-eyebrow");
  const authWelcomeNote = document.getElementById("auth-welcome-note");
  const accountButton = document.getElementById("account-btn");
  const accountButtonName = document.getElementById("account-btn-name");
  const accountPanelName = document.getElementById("account-panel-name");
  const loginButton = document.getElementById("auth-login-btn");

  if (!welcomeScreen || !welcomeHeading || !welcomeSubtitle) return;

  let renderQueued = false;

  function render() {
    renderQueued = false;
    const signedIn = getSignedInState(accountButton, loginButton);
    const greetingName = signedIn ? getGreetingName(accountButtonName, accountPanelName) : "";

    welcomeScreen.dataset.welcomeAudience = signedIn ? "member" : "guest";

    if (signedIn) {
      setText(welcomeEyebrow, "Welcome back");
      setText(welcomeHeading, greetingName ? `Welcome back, ${greetingName}.` : "Welcome back.");
      setText(
        welcomeSubtitle,
        "Start with a question, a file, or something you want to work through.",
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
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(render);
  }

  const observer = new MutationObserver(scheduleRender);
  observer.observe(welcomeScreen, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden", "style"] });
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
