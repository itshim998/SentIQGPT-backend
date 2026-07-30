/* SentIQ Liquid Glass V4 — Phase 7.3 generated file results */

import {
  ASSET_RESULT_VERSION,
  estimateTextBytes,
  formatAssetBytes,
  getGeneratedFileFormat,
  getGeneratedFileTypeLabel,
  parseAssetSize,
} from "./asset-result-state.js";
import {
  CONTROLLED_RESPONSE_POLISH_VERSION,
  resolveArtifactBatchDelay,
} from "./controlled-response-polish-state.mjs";

const htmlBatchStates = new WeakMap();

function ensureMetadata(panel, titleWrap) {
  let metadata = titleWrap.querySelector(":scope > .asset-file-metadata");
  if (!metadata) {
    metadata = document.createElement("div");
    metadata.className = "asset-file-metadata";
    titleWrap.appendChild(metadata);
  }
  const format = getGeneratedFileFormat(panel);
  const explicitSize = parseAssetSize(panel.querySelector(".generated-preview-meta"));
  const text = panel.querySelector(".sentiq-batched-html-code, .generated-html-code-pane code, .generated-text-preview")?.textContent || "";
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

function createDocumentWireframe() {
  const wireframe = document.createElement("div");
  wireframe.className = "asset-file-wireframe is-document";
  const page = document.createElement("div");
  page.className = "asset-document-wire-page";
  for (let index = 0; index < 9; index += 1) page.appendChild(document.createElement("span"));
  wireframe.appendChild(page);
  return wireframe;
}

function createSheetWireframe() {
  const wireframe = document.createElement("div");
  wireframe.className = "asset-file-wireframe is-sheet";
  const tabs = document.createElement("div");
  tabs.className = "asset-sheet-wire-tabs";
  tabs.append(document.createElement("span"), document.createElement("span"));
  const grid = document.createElement("div");
  grid.className = "asset-sheet-wire-grid";
  for (let index = 0; index < 36; index += 1) grid.appendChild(document.createElement("span"));
  wireframe.append(tabs, grid);
  return wireframe;
}

function createHtmlWireframe() {
  const wireframe = document.createElement("div");
  wireframe.className = "asset-file-wireframe is-html";
  const code = document.createElement("div");
  code.className = "asset-code-wire-lines";
  for (let index = 0; index < 8; index += 1) code.appendChild(document.createElement("span"));
  const preview = document.createElement("div");
  preview.className = "asset-preview-wire-pane";
  wireframe.append(code, preview);
  return wireframe;
}

function ensureWireframe(panel, body, loading, format) {
  body.querySelector(":scope > .asset-file-skeleton")?.remove();
  let wireframe = body.querySelector(":scope > .asset-file-wireframe");
  if (!loading) {
    wireframe?.remove();
    return;
  }
  const kind = format === "xlsx" ? "sheet" : format === "html" ? "html" : "document";
  if (wireframe?.classList.contains(`is-${kind}`)) return;
  wireframe?.remove();
  wireframe = kind === "sheet"
    ? createSheetWireframe()
    : kind === "html"
      ? createHtmlWireframe()
      : createDocumentWireframe();
  wireframe.setAttribute("aria-hidden", "true");
  panel.dataset.sentiqWireframeKind = kind;
  body.appendChild(wireframe);
}

function cloneCodeMirror(source) {
  const mirror = source.cloneNode(true);
  mirror.removeAttribute("id");
  mirror.classList.remove("sentiq-html-code-source");
  mirror.classList.add("sentiq-batched-html-code");
  mirror.removeAttribute("aria-hidden");
  return mirror;
}

function clonePreviewMirror(source) {
  const mirror = source.cloneNode(false);
  mirror.removeAttribute("id");
  mirror.classList.remove("sentiq-html-preview-source");
  mirror.classList.add("sentiq-batched-html-preview");
  mirror.removeAttribute("aria-hidden");
  mirror.title = source.title || "HTML preview";
  const sandbox = source.getAttribute("sandbox");
  if (sandbox) mirror.setAttribute("sandbox", sandbox);
  return mirror;
}

function ensureBatchedHtmlPresentation(panel, actions) {
  if (!panel.classList.contains("format-html")) return null;
  const existing = htmlBatchStates.get(panel);
  if (existing) {
    if (Array.from(actions.querySelectorAll("button")).every((button) => !button.disabled)) {
      existing.flushCode(true);
      existing.flushPreview(true);
    }
    return existing;
  }

  const codePane = panel.querySelector(".generated-html-code-pane");
  const previewPane = panel.querySelector(".generated-html-preview-pane");
  const sourceCode = codePane?.querySelector("code:not(.sentiq-batched-html-code)");
  const sourcePreview = previewPane?.querySelector("iframe:not(.sentiq-batched-html-preview)");
  if (!(sourceCode instanceof HTMLElement) || !(sourcePreview instanceof HTMLIFrameElement)) return null;

  const codeMirror = cloneCodeMirror(sourceCode);
  const previewMirror = clonePreviewMirror(sourcePreview);
  sourceCode.classList.add("sentiq-html-code-source");
  sourceCode.setAttribute("aria-hidden", "true");
  sourcePreview.classList.add("sentiq-html-preview-source");
  sourcePreview.setAttribute("aria-hidden", "true");
  sourceCode.insertAdjacentElement("beforebegin", codeMirror);
  sourcePreview.insertAdjacentElement("beforebegin", previewMirror);
  sourceCode.remove();
  sourcePreview.remove();

  let codeTimer = 0;
  let previewTimer = 0;
  let codeDirty = true;
  let previewDirty = true;

  function flushCode(force = false) {
    if (codeTimer) window.clearTimeout(codeTimer);
    codeTimer = 0;
    if (!codeDirty && !force) return;
    codeDirty = false;
    if (codeMirror.innerHTML !== sourceCode.innerHTML) codeMirror.innerHTML = sourceCode.innerHTML;
  }

  function flushPreview(force = false) {
    if (previewTimer) window.clearTimeout(previewTimer);
    previewTimer = 0;
    if (!previewDirty && !force) return;
    if (!force && !panel.classList.contains("show-preview")) return;
    previewDirty = false;
    const nextSrcdoc = sourcePreview.srcdoc || sourcePreview.getAttribute("srcdoc") || "";
    if (previewMirror.srcdoc !== nextSrcdoc) previewMirror.srcdoc = nextSrcdoc;
  }

  function scheduleCode() {
    codeDirty = true;
    if (codeTimer) return;
    codeTimer = window.setTimeout(() => flushCode(false), resolveArtifactBatchDelay("code"));
  }

  function schedulePreview() {
    previewDirty = true;
    if (previewTimer) return;
    previewTimer = window.setTimeout(() => flushPreview(false), resolveArtifactBatchDelay("preview"));
  }

  const codeObserver = new MutationObserver(scheduleCode);
  codeObserver.observe(sourceCode, { childList: true, subtree: true, characterData: true });
  const previewObserver = new MutationObserver(schedulePreview);
  previewObserver.observe(sourcePreview, { attributes: true, attributeFilter: ["srcdoc"] });
  const panelObserver = new MutationObserver(() => {
    if (panel.classList.contains("show-preview")) schedulePreview();
  });
  panelObserver.observe(panel, { attributes: true, attributeFilter: ["class"] });
  const actionObserver = new MutationObserver(() => {
    const finalized = Array.from(actions.querySelectorAll("button")).every((button) => !button.disabled);
    if (finalized) {
      flushCode(true);
      flushPreview(true);
    }
  });
  actionObserver.observe(actions, { subtree: true, attributes: true, attributeFilter: ["disabled"] });

  const state = {
    sourceCode,
    sourcePreview,
    codeMirror,
    previewMirror,
    flushCode,
    flushPreview,
  };
  htmlBatchStates.set(panel, state);
  panel.dataset.sentiqArtifactBatch = CONTROLLED_RESPONSE_POLISH_VERSION;
  flushCode(true);
  if (panel.classList.contains("show-preview")) flushPreview(true);
  return state;
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
  ensureBatchedHtmlPresentation(panel, actions);
  ensureMetadata(panel, titleWrap);

  actions.querySelectorAll(".generated-file-action").forEach((button) => {
    const label = String(button.textContent || "").trim();
    if (!button.getAttribute("aria-label") && label) button.setAttribute("aria-label", label);
    button.classList.toggle("is-primary", /^download$/i.test(label));
  });

  const disabled = Array.from(actions.querySelectorAll("button")).some((button) => button.disabled);
  const meaningfulText = String(
    body.querySelector(".sentiq-batched-html-code, .generated-text-preview, .generated-sheet-preview, .generated-slide-list")?.textContent
      || body.textContent
      || "",
  ).replace(/\s+/g, "").length > 18;
  const loading = disabled && !meaningfulText;
  panel.classList.toggle("is-loading", loading);
  panel.classList.toggle("is-ready", !loading);
  panel.setAttribute("aria-busy", loading ? "true" : "false");
  ensureWireframe(panel, body, loading, getGeneratedFileFormat(panel));

  const empty = body.querySelector(".generated-file-empty");
  if (empty) {
    empty.setAttribute("role", "status");
    if (!String(empty.textContent || "").trim()) {
      empty.textContent = "Preview unavailable. The file can still be downloaded.";
    }
  }
}
