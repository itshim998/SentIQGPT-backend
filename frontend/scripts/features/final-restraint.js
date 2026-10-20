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

function setParagraphs(sectionSelector, values) {
  const section = document.querySelector(sectionSelector);
  if (!section) return;
  const paragraphs = Array.from(section.querySelectorAll(":scope > p"));
  while (paragraphs.length < values.length) {
    const paragraph = document.createElement("p");
    section.appendChild(paragraph);
    paragraphs.push(paragraph);
  }
  paragraphs.forEach((paragraph, index) => {
    if (index >= values.length) {
      paragraph.remove();
      return;
    }
    const next = String(values[index] || "");
    if (paragraph.textContent !== next) paragraph.textContent = next;
  });
}

function hideElement(selector) {
  const element = document.querySelector(selector);
  if (!element) return;
  element.hidden = true;
  element.setAttribute("aria-hidden", "true");
}

function applyFinalRestraintCopy() {
  setText("#account-upgrade-btn span", "Upgrade");
  setText("#account-personalization-btn span", "Memory");
  setText("#auth-menu-billing-btn", "Plan & usage");
  setText("#auth-logout-btn", "Sign out");
  setText("#auth-menu-logout-btn", "Sign out");

  setText("#auth-welcome-note", "Guest chats aren't saved. Sign in to save chats and generate images.");
  setText("#auth-gate-message", "Sign in to start chatting.");
  setText(".selected-context-label", "Selected text");
  setText("#deep-research-mode-bar .composer-mode-pill-label", "Deep Research");

  setText("#auth-modal-title", "");
  setText("#auth-modal-subtitle", "");
  setText("#auth-forgot-btn", "Forgot password?");
  setText("#auth-switch-btn", "Create account");

  setText("#name-modal-title", "Your name");
  setText(".name-modal-container .auth-modal-copy p", "Used for greetings and your account.");
  hideElement(".name-modal-container .auth-modal-copy h2");

  setText("#settings-tab-button-billing", "Plan & usage");
  setText("#settings-tab-button-memory", "Memory");
  setText(".billing-panel-status", "Loading…");

  setText("#trust-modal-title", "Privacy & support");
  setText(".trust-tab[data-trust-tab='controls']", "Data");
  setText("#trust-tab-privacy h3", "Privacy");
  setParagraphs("#trust-tab-privacy", [
    "SentIQ Chat can be used for conversations, files, web search, deep research, and content creation. As with any AI-powered tool, we recommend reviewing important outputs before relying on them.",
    "Guest sessions are temporary by design. Conversations started without an account are not saved and will not persist once the session ends.",
    "Signing in to your account allows your conversations, messages, memories, and created files to be securely saved and accessible across sessions.",
    "Files you share with SentIQ Chat are used solely to fulfill your request.",
  ]);
  setText("#trust-tab-terms h3", "Terms of use");
  setParagraphs("#trust-tab-terms", [
    "By using SentIQ Chat, you agree to use the service lawfully and responsibly. You are responsible for ensuring that any material you upload or share is content you have the right to use.",
    "We recommend reviewing important outputs before relying on them, as SentIQ Chat, like any AI-powered tool, may occasionally produce inaccurate or incomplete results.",
  ]);
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
