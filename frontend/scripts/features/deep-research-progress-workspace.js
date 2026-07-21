/* SentIQ Liquid Glass V4 — Phase 7.2 progress disclosure */

import { toCompositorProgressScale } from "./compositor-safety-state.mjs";
import {
  DEEP_RESEARCH_STAGES,
  buildDeepResearchDisclosureKey,
  cleanDeepResearchText,
} from "./deep-research-workspace-state.js";

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function setAttribute(element, name, value) {
  if (element && element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function readDisclosure(key) {
  try { return window.sessionStorage?.getItem(key); } catch { return null; }
}

function writeDisclosure(key, open) {
  try { window.sessionStorage?.setItem(key, open ? "1" : "0"); } catch { /* optional preference */ }
}

function ensureFacts(body) {
  let facts = body.querySelector(".deep-research-progress-facts");
  if (facts) return facts;
  facts = document.createElement("div");
  facts.className = "deep-research-progress-facts";
  facts.innerHTML = '<div><span>Workspace</span><strong data-fact="workspace"></strong></div><div><span>Updates</span><strong data-fact="updates"></strong></div><div><span>Draft</span><strong data-fact="draft"></strong></div>';
  body.appendChild(facts);
  return facts;
}

function ensureDetails(card, rail, context) {
  let details = card.querySelector(":scope > .deep-research-progress-details");
  const progress = card.querySelector(":scope > .deep-research-progress-container");
  if (!details) {
    details = document.createElement("details");
    details.className = "deep-research-progress-details";
    details.innerHTML = '<summary><span>Progress details</span><span class="deep-research-progress-summary-stage"></span><span class="deep-research-progress-summary-chevron" aria-hidden="true">⌄</span></summary><div class="deep-research-progress-details-body"></div>';
    (progress || rail).insertAdjacentElement("afterend", details);
    details.addEventListener("toggle", () => writeDisclosure(details.dataset.disclosureKey, details.open));
  }

  const key = buildDeepResearchDisclosureKey(context.reportId, context.title);
  if (details.dataset.disclosureKey !== key) {
    details.dataset.disclosureKey = key;
    const stored = readDisclosure(key);
    if (stored !== null) details.open = stored === "1";
  }
  const stageLabel = context.stage === "complete"
    ? "Complete"
    : DEEP_RESEARCH_STAGES.find(({ id }) => id === context.stage)?.label || "Scope";
  setText(details.querySelector(".deep-research-progress-summary-stage"), stageLabel);

  const body = details.querySelector(".deep-research-progress-details-body");
  const checklist = card.querySelector(":scope > .deep-research-checklist");
  if (checklist && checklist.parentElement !== body) body.appendChild(checklist);
  if (!checklist) {
    const facts = ensureFacts(body);
    const draft = cleanDeepResearchText(card.querySelector(".deep-research-report-preview-text")?.textContent);
    setText(facts.querySelector('[data-fact="workspace"]'), context.reportId ? "Saved report" : "Saved conversation state");
    setText(facts.querySelector('[data-fact="updates"]'), context.status === "running" ? "Reconnect automatically" : "State preserved");
    setText(facts.querySelector('[data-fact="draft"]'), draft ? "Draft available" : context.status === "completed" ? "Report complete" : "Waiting for content");
  }
}

function enhanceProgress(card, percent, status) {
  const bar = card.querySelector(".deep-research-progress-bar");
  if (bar) {
    setAttribute(bar, "role", "progressbar");
    setAttribute(bar, "aria-valuemin", "0");
    setAttribute(bar, "aria-valuemax", "100");
    setAttribute(bar, "aria-valuenow", String(Math.round(percent)));
    setAttribute(bar, "aria-label", status === "completed" ? "Research complete" : "Deep Research progress");
  }
  const fill = card.querySelector(".deep-research-progress-fill");
  if (fill) {
    const percentValue = `${percent}%`;
    const scaleValue = String(toCompositorProgressScale(percent));
    if (fill.style.getPropertyValue("--deep-research-progress") !== percentValue) {
      fill.style.setProperty("--deep-research-progress", percentValue);
    }
    if (fill.style.getPropertyValue("--deep-research-progress-scale") !== scaleValue) {
      fill.style.setProperty("--deep-research-progress-scale", scaleValue);
    }
  }
  const text = card.querySelector(".deep-research-status-text");
  if (text) {
    setAttribute(text, "role", "status");
    setAttribute(text, "aria-live", "polite");
    setAttribute(text, "aria-atomic", "true");
  }
}

export function enhanceDeepResearchProgress(card, rail, context) {
  enhanceProgress(card, context.percent, context.status);
  ensureDetails(card, rail, context);
  const preview = card.querySelector(":scope > .deep-research-report-preview-container:not([hidden])");
  if (context.status === "running" && preview && !card.querySelector(":scope > .deep-research-draft-label")) {
    const label = document.createElement("div");
    label.className = "deep-research-draft-label";
    label.textContent = "Draft so far";
    preview.insertAdjacentElement("beforebegin", label);
  }
}
