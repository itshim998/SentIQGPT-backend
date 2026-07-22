/* SentIQ Liquid Glass V4 — Phase 7.3 generated file results */

import {
  ASSET_RESULT_VERSION,
  estimateTextBytes,
  formatAssetBytes,
  getGeneratedFileFormat,
  getGeneratedFileTypeLabel,
  parseAssetSize,
} from "./asset-result-state.js";

function ensureMetadata(panel, titleWrap) {
  let metadata = titleWrap.querySelector(":scope > .asset-file-metadata");
  if (!metadata) {
    metadata = document.createElement("div");
    metadata.className = "asset-file-metadata";
    titleWrap.appendChild(metadata);
  }
  const format = getGeneratedFileFormat(panel);
  const explicitSize = parseAssetSize(panel.querySelector(".generated-preview-meta"));
  const text = panel.querySelector(".generated-html-code-pane code, .generated-text-preview")?.textContent || "";
  const inferredSize = text ? formatAssetBytes(estimateTextBytes(text)) : "";
  const size = explicitSize || inferredSize || "Size unavailable";
  const signature = `${format}|${size}`;
  if (metadata.dataset.signature !== signature) {
    metadata.dataset.signature = signature;
    metadata.replaceChildren();
    const type = document.createElement("span");
    type.textContent = getGeneratedFileTypeLabel(format);
    const divider = document.createElement("span");
    divider.className = "asset-file-metadata-divider";
    divider.textContent = "·";
    divider.setAttribute("aria-hidden", "true");
    const sizeNode = document.createElement("span");
    sizeNode.textContent = size;
    metadata.append(type, divider, sizeNode);
  }
}

function ensureSkeleton(panel, body, loading) {
  let skeleton = body.querySelector(":scope > .asset-file-skeleton");
  if (!loading) {
    skeleton?.remove();
    return;
  }
  if (skeleton) return;
  skeleton = document.createElement("div");
  skeleton.className = "asset-file-skeleton";
  skeleton.setAttribute("aria-hidden", "true");
  skeleton.innerHTML = '<span></span><span></span><span></span><span></span>';
  body.appendChild(skeleton);
}

export function enhanceGeneratedFileResult(panel) {
  if (!(panel instanceof HTMLElement)) return;
  const header = panel.querySelector(":scope > .generated-file-header");
  const titleWrap = header?.querySelector(".generated-file-title-wrap");
  const actions = header?.querySelector(".generated-file-actions");
  const body = panel.querySelector(":scope > .generated-file-body");
  if (!header || !titleWrap || !actions || !body) return;

  panel.dataset.assetResultVersion = ASSET_RESULT_VERSION;
  panel.dataset.assetResultKind = "file";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Generated file result");
  header.classList.add("asset-result-header");
  actions.setAttribute("role", "toolbar");
  actions.setAttribute("aria-label", "Generated file actions");
  ensureMetadata(panel, titleWrap);

  actions.querySelectorAll(".generated-file-action").forEach((button) => {
    const label = String(button.textContent || "").trim();
    if (!button.getAttribute("aria-label") && label) button.setAttribute("aria-label", label);
    button.classList.toggle("is-primary", /^download$/i.test(label));
  });

  const disabled = Array.from(actions.querySelectorAll("button")).some((button) => button.disabled);
  const meaningfulText = String(body.textContent || "").replace(/\s+/g, "").length > 18;
  const loading = disabled && !meaningfulText;
  panel.classList.toggle("is-loading", loading);
  panel.classList.toggle("is-ready", !loading);
  panel.setAttribute("aria-busy", loading ? "true" : "false");
  ensureSkeleton(panel, body, loading);

  const empty = body.querySelector(".generated-file-empty");
  if (empty) {
    empty.setAttribute("role", "status");
    if (!String(empty.textContent || "").trim()) {
      empty.textContent = "Preview unavailable. The file can still be downloaded.";
    }
  }
}
