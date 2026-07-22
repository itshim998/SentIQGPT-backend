/* SentIQ Liquid Glass V4 — Phase 7.2 Deep Research workspace */

import { enhanceDeepResearchReport } from "./deep-research-report-workspace.js";
import { enhanceDeepResearchProgress } from "./deep-research-progress-workspace.js";
import {
  DEEP_RESEARCH_STAGES,
  DEEP_RESEARCH_WORKSPACE_VERSION,
  clampDeepResearchPercent,
  cleanDeepResearchText,
  getDeepResearchStageStates,
  normalizeDeepResearchStage,
} from "./deep-research-workspace-state.js";

const CARD_SELECTOR = ".deep-research-card";

function initDeepResearchWorkspace() {
  const chatMessages = document.getElementById("chat-messages");
  if (!(chatMessages instanceof HTMLElement)) return;
  const pending = new Set();
  let frame = 0;

  const setText = (element, value) => {
    if (element && element.textContent !== value) element.textContent = value;
  };
  const setAttribute = (element, name, value) => {
    if (element && element.getAttribute(name) !== value) element.setAttribute(name, value);
  };
  const statusOf = (card) => ["completed", "cancelled", "failed"].find((status) => card.classList.contains(status)) || "running";

  function identity(card) {
    const reportId = cleanDeepResearchText(card.closest(".message")?.dataset.reportId || card.dataset.reportId);
    const title = cleanDeepResearchText(card.querySelector(".deep-research-report-title")?.textContent)
      .replace(/^Research(?:ing)?:\s*["“]?/i, "").replace(/["”]$/, "");
    return { reportId, title };
  }

  function percentOf(card, status) {
    if (status === "completed") return 100;
    const fill = card.querySelector(".deep-research-progress-fill");
    const legacyWidth = Number.parseFloat(fill?.style.width || "");
    if (Number.isFinite(legacyWidth)) return clampDeepResearchPercent(legacyWidth);
    const percentValue = Number.parseFloat(fill?.style.getPropertyValue("--deep-research-progress") || "");
    if (Number.isFinite(percentValue)) return clampDeepResearchPercent(percentValue);
    const scaleValue = Number.parseFloat(fill?.style.getPropertyValue("--deep-research-progress-scale") || "");
    if (Number.isFinite(scaleValue)) return clampDeepResearchPercent(scaleValue * 100);
    return clampDeepResearchPercent(card.querySelector(".deep-research-progress-bar")?.getAttribute("aria-valuenow"));
  }

  function phaseOf(card) {
    return card.querySelector(".deep-research-item.active[data-step-id], .deep-research-item.completed[data-step-id]:last-of-type")?.dataset.stepId || "";
  }

  function ensureHeader(card) {
    let header = card.querySelector(":scope > .deep-research-workspace-header");
    if (header) return header;
    header = document.createElement("header");
    header.className = "deep-research-workspace-header";
    header.innerHTML = '<span class="deep-research-workspace-identity"><span class="deep-research-workspace-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 19V9"></path><path d="M12 19V5"></path><path d="M19 19v-7"></path></svg></span><span class="deep-research-workspace-label">Deep Research</span></span><span class="deep-research-workspace-state"></span><span class="deep-research-workspace-percent"></span>';
    card.insertBefore(header, card.firstChild);
    return header;
  }

  function ensureNote(card, title, status, origin) {
    let note = card.querySelector(":scope > .deep-research-background-note");
    if (!note) {
      note = document.createElement("p");
      note.className = "deep-research-background-note";
      (title || card.firstElementChild)?.insertAdjacentElement("afterend", note);
    }
    const copy = status === "running"
      ? origin === "resumed"
        ? "Resumed from saved state. Updates reconnect automatically when this chat is open."
        : "Running in the background. You can switch chats and return to this saved workspace."
      : status === "completed"
        ? "The completed report is saved in this conversation."
        : status === "cancelled"
          ? "Research stopped. Any available draft remains saved below."
          : "Research could not finish. Available progress remains visible below.";
    setText(note, copy);
    return note;
  }

  function ensureStages(card, anchor, stage, status) {
    let rail = card.querySelector(":scope > .deep-research-stage-rail");
    if (!rail) {
      rail = document.createElement("ol");
      rail.className = "deep-research-stage-rail";
      rail.setAttribute("aria-label", "Deep Research stages");
      rail.innerHTML = DEEP_RESEARCH_STAGES.map(({ id, label }, index) => `<li class="deep-research-stage" data-stage="${id}"><span class="deep-research-stage-index" aria-hidden="true">${index + 1}</span><span class="deep-research-stage-label">${label}</span></li>`).join("");
      anchor.insertAdjacentElement("afterend", rail);
    }
    const states = getDeepResearchStageStates(stage, status);
    rail.querySelectorAll("[data-stage]").forEach((item) => {
      const state = states[item.dataset.stage] || "pending";
      ["complete", "active", "paused", "pending"].forEach((name) => item.classList.toggle(`is-${name}`, state === name));
      if (["active", "paused"].includes(state)) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
    return rail;
  }

  function enhance(card) {
    if (!(card instanceof HTMLElement) || !card.isConnected) return;
    const status = statusOf(card);
    const titleElement = card.querySelector(":scope > .deep-research-report-title");
    const { reportId, title } = identity(card);
    const origin = card.dataset.deepResearchOrigin || (status === "running" && card.querySelector(".deep-research-checklist") ? "live" : "resumed");
    const percent = percentOf(card, status);
    const stage = normalizeDeepResearchStage({ status, phase: phaseOf(card), statusText: card.querySelector(".deep-research-status-text")?.textContent, percent });
    Object.assign(card.dataset, { deepResearchOrigin: origin, deepResearchWorkspaceVersion: DEEP_RESEARCH_WORKSPACE_VERSION, deepResearchStatus: status, deepResearchStage: stage });
    setAttribute(card, "role", "region");
    setAttribute(card, "aria-label", status === "completed" ? "Completed Deep Research report" : "Deep Research workspace");
    setAttribute(card, "aria-busy", status === "running" ? "true" : "false");

    const header = ensureHeader(card);
    setText(header.querySelector(".deep-research-workspace-state"), status === "running" ? "Running in background" : status === "completed" ? "Complete" : status === "cancelled" ? "Cancelled" : "Needs attention");
    setText(header.querySelector(".deep-research-workspace-percent"), status === "running" ? `${Math.round(percent)}%` : "");
    const note = ensureNote(card, titleElement, status, origin);
    const rail = ensureStages(card, note, stage, status);
    enhanceDeepResearchProgress(card, rail, { reportId, title, status, stage, percent });
    if (status === "completed") enhanceDeepResearchReport(card, reportId);
  }

  function schedule(card) {
    if (!(card instanceof HTMLElement)) return;
    pending.add(card);
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      const cards = [...pending];
      pending.clear();
      cards.forEach(enhance);
    });
  }

  function collect(node) {
    if (!(node instanceof Node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!(element instanceof Element)) return;
    if (element.matches(CARD_SELECTOR)) schedule(element);
    schedule(element.closest(CARD_SELECTOR));
    element.querySelectorAll?.(CARD_SELECTOR).forEach(schedule);
  }

  new MutationObserver((records) => records.forEach((record) => {
    collect(record.target);
    record.addedNodes.forEach(collect);
  })).observe(chatMessages, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "data-report-id"] });

  chatMessages.querySelectorAll(CARD_SELECTOR).forEach(schedule);
}

if (typeof document !== "undefined") initDeepResearchWorkspace();
