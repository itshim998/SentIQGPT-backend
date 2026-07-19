/* SentIQ Liquid Glass V4 — Phase 7.2 completed report hierarchy */

import { cleanDeepResearchText, estimateDeepResearchReadMinutes } from "./deep-research-workspace-state.js";

let reportElementId = 0;

function setAttribute(element, name, value) {
  if (element && element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function countLinks(card) {
  const links = new Set();
  card.querySelectorAll(".deep-research-report-preview-text a[href]").forEach((link) => {
    const href = cleanDeepResearchText(link.getAttribute("href"));
    if (href && href !== "#") links.add(href);
  });
  return links.size;
}

function syncExpandButton(card, preview) {
  const button = card.querySelector(":scope > .deep-research-expand-btn");
  if (!button) return;
  if (!preview.id) {
    reportElementId += 1;
    preview.id = `deep-research-report-${reportElementId}`;
  }
  setAttribute(button, "aria-controls", preview.id);
  const sync = () => {
    const expanded = preview.classList.contains("expanded");
    setAttribute(button, "aria-expanded", expanded ? "true" : "false");
    setAttribute(button, "aria-label", expanded ? "Collapse report" : "Open full report");
  };
  if (button.dataset.workspaceBound !== "7.2") {
    button.dataset.workspaceBound = "7.2";
    button.addEventListener("click", () => requestAnimationFrame(sync));
  }
  sync();
}

export function enhanceDeepResearchReport(card, reportId = "") {
  const title = card.querySelector(":scope > .deep-research-report-title");
  if (title) {
    setAttribute(title, "role", "heading");
    setAttribute(title, "aria-level", "2");
  }

  let metadata = card.querySelector(":scope > .deep-research-report-metadata");
  if (!metadata) {
    metadata = document.createElement("div");
    metadata.className = "deep-research-report-metadata";
    title?.insertAdjacentElement("afterend", metadata);
  }
  const reportText = cleanDeepResearchText(card.querySelector(".deep-research-report-preview-text")?.textContent);
  const minutes = estimateDeepResearchReadMinutes(reportText);
  const sources = countLinks(card);
  const values = [
    minutes ? `${minutes} min read` : "Report ready",
    sources ? `${sources} linked ${sources === 1 ? "source" : "sources"}` : "Sources preserved in report",
    reportId ? "Saved report" : "Saved in this conversation",
  ];
  const signature = values.join("|");
  if (metadata.dataset.signature !== signature) {
    metadata.dataset.signature = signature;
    metadata.replaceChildren(...values.map((value) => {
      const item = document.createElement("span");
      item.textContent = value;
      return item;
    }));
  }

  const actions = card.querySelector(":scope > .deep-research-report-actions");
  if (actions) {
    setAttribute(actions, "role", "toolbar");
    setAttribute(actions, "aria-label", "Report actions");
    actions.querySelectorAll("button").forEach((button) => {
      if (!button.getAttribute("aria-label")) {
        setAttribute(button, "aria-label", button.title || cleanDeepResearchText(button.textContent) || "Report action");
      }
    });
  }

  const preview = card.querySelector(":scope > .deep-research-report-preview-container");
  if (!preview) return;
  setAttribute(preview, "role", "article");
  setAttribute(preview, "aria-label", "Deep Research report");
  if (!card.querySelector(":scope > .deep-research-report-section-label")) {
    const label = document.createElement("div");
    label.className = "deep-research-report-section-label";
    label.textContent = "Report";
    preview.insertAdjacentElement("beforebegin", label);
  }
  syncExpandButton(card, preview);
}
