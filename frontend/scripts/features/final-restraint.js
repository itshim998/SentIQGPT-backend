/* ============================================================
   SentIQ Liquid Glass V4 — Pass 12.4
   Final restraint presentation hook
   ============================================================ */

const FINAL_RESTRAINT_VERSION = "12.4";
const FINAL_RESTRAINT_STYLE_ID = "sentiq-final-restraint-styles";

function ensureFinalRestraintStylesheet() {
  if (document.getElementById(FINAL_RESTRAINT_STYLE_ID)) return;
  const link = document.createElement("link");
  link.id = FINAL_RESTRAINT_STYLE_ID;
  link.rel = "stylesheet";
  link.href = new URL("../../styles/modules/17-final-restraint.css", import.meta.url).href;
  link.dataset.uiPass = FINAL_RESTRAINT_VERSION;
  document.head.appendChild(link);
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (!element) return;
  const next = String(value || "");
  if (element.textContent !== next) element.textContent = next;
}

function setTexts(selector, values) {
  const elements = Array.from(document.querySelectorAll(selector));
  values.forEach((value, index) => {
    const element = elements[index];
    if (!element) return;
    const next = String(value || "");
    if (element.textContent !== next) element.textContent = next;
  });
}

function hideElement(selector) {
  const element = document.querySelector(selector);
  if (!element) return;
  element.hidden = true;
  element.setAttribute("aria-hidden", "true");
}

function applyFinalRestraintCopy() {
  setText("#account-upgrade-btn span", "Plan");
  setText("#account-personalization-btn span", "Preferences");
  setText("#auth-menu-billing-btn", "Plan");
  setText("#auth-logout-btn", "Sign out");
  setText("#auth-menu-logout-btn", "Sign out");

  setText("#auth-welcome-note", "Guest chats are temporary. Sign in to keep conversations across devices.");
  setText("#auth-gate-message", "Log in to chat.");
  setText(".selected-context-label", "Selection");
  setText("#deep-research-mode-bar .composer-mode-pill-label", "Deep Research");

  setText("#auth-modal-title", "Account");
  setText("#auth-modal-subtitle", "Continue with Google or your email.");
  setText("#auth-forgot-btn", "Forgot password?");
  setText("#auth-switch-btn", "Create account");

  setText("#name-modal-title", "Your name");
  setText(".name-modal-container .auth-modal-copy p", "Used for greetings and your account.");
  hideElement(".name-modal-container .auth-modal-copy h2");

  setText("#settings-tab-button-memory", "Memory");
  setText(".billing-panel-status", "Loading plan details…");

  setText("#trust-modal-title", "Privacy & support");
  setText(".trust-tab[data-trust-tab='controls']", "Data");
  setText("#trust-tab-privacy h3", "Privacy");
  setTexts("#trust-tab-privacy p", [
    "Use SentIQ Chat for conversations, files, web research, and created content. Check important results before relying on them.",
    "Guest chats are temporary and are not saved to an account. An interrupted draft may remain in this tab.",
    "When you sign in, conversations, messages, memories, and created files can be saved to your account. Recent work may also be cached on this device.",
    "Files are processed only to complete your request. Temporary extracted content may be retained for up to about one hour.",
  ]);
  setText("#trust-tab-terms p", "Use SentIQ Chat lawfully. Check important results, and only upload material you are allowed to process.");
  setText("#trust-tab-controls p:first-of-type", "Clearing local data removes this device's cache and temporary upload session. It does not remove cloud conversations or memories.");
  setText("#clear-source-files-btn", "Clear temporary files");
  setText("#clear-local-data-btn", "Clear data on this device");
  setText("#trust-tab-controls .data-controls-note", "Delete conversations from the sidebar and memories from Memory.");
  setText("#trust-tab-support p", "For account, privacy, file, or chat help, email our team.");
  setText("#support-email-link", "Email support");

  setText("#live-beta-message", "Connecting…");
}

function initializeFinalRestraint() {
  if (document.documentElement.dataset.finalRestraintVersion === FINAL_RESTRAINT_VERSION) return;
  document.documentElement.dataset.finalRestraintVersion = FINAL_RESTRAINT_VERSION;
  ensureFinalRestraintStylesheet();
  applyFinalRestraintCopy();
}

if (typeof document !== "undefined") initializeFinalRestraint();
