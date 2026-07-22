/* ============================================================
   SentIQ Liquid Glass V4 — Phase 5.5
   Attachments and selected-context presentation

   The chat controller remains authoritative for attachment lifecycle,
   retry, removal, upload concurrency, and selected-text state. This layer
   enriches the existing DOM with stable identity, status, overflow, and
   accessibility presentation only.
   ============================================================ */

const ATTACHMENT_CONTEXT_VERSION = "5.5";
let attachmentEnhancementId = 0;

const MIME_FAMILY_RULES = Object.freeze([
  { family: "image", test: ({ mime }) => mime.startsWith("image/") },
  { family: "pdf", test: ({ ext, mime }) => ext === "pdf" || mime === "application/pdf" },
  { family: "code", test: ({ ext }) => ["js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "h", "hpp", "rs", "go", "html", "css", "xml", "sh"].includes(ext) },
  { family: "data", test: ({ ext, mime }) => ["json", "csv", "xlsx", "xls"].includes(ext) || /json|csv|spreadsheet|excel/.test(mime) },
  { family: "document", test: ({ ext, mime }) => ["doc", "docx", "ppt", "pptx", "rtf"].includes(ext) || /word|presentation|powerpoint|rtf/.test(mime) },
  { family: "text", test: ({ ext, mime }) => ["txt", "md"].includes(ext) || mime.startsWith("text/") },
]);

function setClass(element, className, enabled) {
  if (!element) return;
  const next = Boolean(enabled);
  if (element.classList.contains(className) !== next) element.classList.toggle(className, next);
}

function setData(element, key, value) {
  if (!element) return;
  const next = String(value ?? "");
  if (element.dataset[key] !== next) element.dataset[key] = next;
}

function setText(element, value) {
  const next = String(value ?? "");
  if (element && element.textContent !== next) element.textContent = next;
}

function setAttribute(element, name, value) {
  if (!element) return;
  const next = String(value ?? "");
  if (element.getAttribute(name) !== next) element.setAttribute(name, next);
}

function setHidden(element, hidden) {
  if (!element) return;
  const next = Boolean(hidden);
  if (element.hidden !== next) element.hidden = next;
}

function setTitle(element, value) {
  if (!element) return;
  const next = String(value ?? "");
  if (element.title !== next) element.title = next;
}

function resolveAttachmentStatus(card) {
  if (card.classList.contains("is-failed") || card.querySelector(".composer-attachment-error")) return "failed";
  if (card.classList.contains("is-processing") || card.getAttribute("aria-busy") === "true" || card.querySelector(".composer-attachment-spinner")) return "processing";
  return "ready";
}

function readAttachmentIdentity(card) {
  const nameNode = card.querySelector(".composer-attachment-name");
  const typeNode = card.querySelector(".composer-attachment-type");
  const filename = String(nameNode?.textContent || nameNode?.getAttribute("title") || "File").trim();
  const mimeLabel = String(typeNode?.textContent || "").trim();
  const rawExtension = filename.includes(".") ? filename.split(".").pop() : "";
  const ext = String(rawExtension || "").toLowerCase().replace(/[^a-z0-9+]/g, "").slice(0, 5);
  const mime = mimeLabel.toLowerCase();
  const context = { ext, mime, filename };
  const matched = MIME_FAMILY_RULES.find((rule) => rule.test(context));
  const family = matched?.family || (card.querySelector(".composer-attachment-thumbnail") ? "image" : "file");
  const identity = ext || ({ image: "IMG", pdf: "PDF", code: "CODE", data: "DATA", document: "DOC", text: "TEXT" }[family] || "FILE");
  return { filename, family, identity: identity.toUpperCase().slice(0, 5) };
}

function ensureElementId(element, prefix) {
  if (!element) return "";
  if (!element.id) {
    attachmentEnhancementId += 1;
    element.id = `${prefix}-${attachmentEnhancementId}`;
  }
  return element.id;
}

function ensureStatusNode(card) {
  let status = card.querySelector(":scope > .composer-attachment-status");
  if (status) return status;
  status = document.createElement("span");
  status.className = "composer-attachment-status";
  status.setAttribute("aria-hidden", "true");
  card.appendChild(status);
  return status;
}

function ensureProgressNode(card) {
  let progress = card.querySelector(":scope > .composer-attachment-progress");
  if (progress) return progress;
  progress = document.createElement("span");
  progress.className = "composer-attachment-progress";
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Preparing attachment");
  progress.setAttribute("aria-valuetext", "Preparing attachment");
  const track = document.createElement("span");
  track.className = "composer-attachment-progress-track";
  progress.appendChild(track);
  card.appendChild(progress);
  return progress;
}

function enrichAttachment(card) {
  const status = resolveAttachmentStatus(card);
  const identity = readAttachmentIdentity(card);
  const visual = card.querySelector(".composer-attachment-visual");
  const name = card.querySelector(".composer-attachment-name");
  const type = card.querySelector(".composer-attachment-type");
  const remove = card.querySelector(".composer-attachment-remove");
  const retry = card.querySelector(".composer-attachment-retry");
  const errorCopy = card.querySelector(".composer-attachment-error-copy");
  const statusNode = ensureStatusNode(card);
  const progress = ensureProgressNode(card);

  setData(card, "attachmentState", status);
  setData(card, "fileFamily", identity.family);
  setData(card, "fileIdentity", identity.identity);
  if (visual) {
    setData(visual, "fileFamily", identity.family);
    setData(visual, "fileIdentity", identity.identity);
  }

  setText(statusNode, status === "processing" ? "Preparing" : status === "failed" ? "Needs attention" : "Ready");
  setHidden(progress, status !== "processing");
  setAttribute(progress, "aria-hidden", status === "processing" ? "false" : "true");

  setTitle(name, identity.filename);
  ensureElementId(name, "attachment-name");
  ensureElementId(type, "attachment-type");
  ensureElementId(errorCopy, "attachment-error");

  const describedBy = [name?.id, type?.id, errorCopy?.id].filter(Boolean).join(" ");
  if (describedBy) setAttribute(card, "aria-describedby", describedBy);

  if (remove) {
    setTitle(remove, `Remove ${identity.filename}`);
    setAttribute(remove, "aria-label", `Remove ${identity.filename}`);
  }
  if (retry) {
    setTitle(retry, `Retry ${identity.filename}`);
    setAttribute(retry, "aria-label", `Retry ${identity.filename}`);
    if (errorCopy?.id) setAttribute(retry, "aria-describedby", errorCopy.id);
  }
}

function initializeAttachmentContextSurface() {
  const wrapper = document.querySelector(".chat-input-wrapper");
  const surface = wrapper?.querySelector(":scope > .chat-input-area");
  const shelf = surface?.querySelector("#file-preview-area");
  const selectedBar = wrapper?.querySelector("#selected-context-bar");
  const selectedText = selectedBar?.querySelector("#selected-context-text");
  const selectedCopy = selectedBar?.querySelector(".selected-context-copy");

  if (!wrapper || !surface || !shelf || !selectedBar || !selectedText || !selectedCopy) return;
  if (wrapper.dataset.attachmentContextVersion === ATTACHMENT_CONTEXT_VERSION) return;

  wrapper.dataset.attachmentContextVersion = ATTACHMENT_CONTEXT_VERSION;
  setAttribute(shelf, "role", "region");
  setAttribute(shelf, "aria-roledescription", "attachment shelf");

  let expandButton = selectedCopy.querySelector(".selected-context-expand");
  if (!expandButton) {
    expandButton = document.createElement("button");
    expandButton.type = "button";
    expandButton.className = "selected-context-expand";
    expandButton.hidden = true;
    selectedCopy.appendChild(expandButton);
  }

  let lastSelectedText = "";
  let syncFrame = 0;
  let measureFrame = 0;

  function measureSelectedOverflow() {
    measureFrame = 0;
    const currentText = String(selectedText.textContent || "").trim();
    const active = !selectedBar.hidden && selectedBar.getAttribute("aria-hidden") !== "true" && currentText.length > 0;

    if (!active) {
      lastSelectedText = "";
      setClass(selectedBar, "has-preview-overflow", false);
      setClass(selectedBar, "is-preview-expanded", false);
      setData(selectedBar, "previewOverflow", "false");
      setHidden(expandButton, true);
      setAttribute(expandButton, "aria-expanded", "false");
      return;
    }

    if (currentText !== lastSelectedText) {
      lastSelectedText = currentText;
      setClass(selectedBar, "is-preview-expanded", false);
    }
    setTitle(selectedText, currentText);

    const wasExpanded = selectedBar.classList.contains("is-preview-expanded");
    const overflows = wasExpanded
      ? selectedBar.dataset.previewOverflow === "true"
      : selectedText.scrollHeight > selectedText.clientHeight + 1;

    setData(selectedBar, "previewOverflow", overflows ? "true" : "false");
    setClass(selectedBar, "has-preview-overflow", overflows);
    setHidden(expandButton, !overflows);
    setAttribute(expandButton, "aria-expanded", wasExpanded ? "true" : "false");
    setAttribute(expandButton, "aria-label", wasExpanded ? "Collapse selected text preview" : "Expand selected text preview");
    setText(expandButton, wasExpanded ? "Show less" : "Show more");
  }

  function scheduleMeasureSelectedOverflow() {
    if (measureFrame) return;
    measureFrame = window.requestAnimationFrame(() => {
      measureSelectedOverflow();
    });
  }

  function sync() {
    syncFrame = 0;
    const cards = Array.from(shelf.querySelectorAll(":scope > .composer-attachment"));
    cards.forEach(enrichAttachment);
    setData(shelf, "attachmentCount", cards.length);
    setAttribute(shelf, "aria-label", `${cards.length} ${cards.length === 1 ? "attachment" : "attachments"}`);
    setClass(shelf, "has-multiple-attachments", cards.length > 1);
    scheduleMeasureSelectedOverflow();
  }

  function scheduleSync() {
    if (syncFrame) return;
    syncFrame = window.requestAnimationFrame(sync);
  }

  expandButton.addEventListener("click", () => {
    const expanded = !selectedBar.classList.contains("is-preview-expanded");
    setClass(selectedBar, "is-preview-expanded", expanded);
    setAttribute(expandButton, "aria-expanded", expanded ? "true" : "false");
    setAttribute(expandButton, "aria-label", expanded ? "Collapse selected text preview" : "Expand selected text preview");
    setText(expandButton, expanded ? "Show less" : "Show more");
  });

  const observer = new MutationObserver(scheduleSync);
  observer.observe(shelf, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "aria-busy", "aria-hidden", "data-status", "data-state"],
  });
  observer.observe(selectedBar, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "aria-hidden", "style"],
  });

  if (typeof ResizeObserver === "function") {
    const resizeObserver = new ResizeObserver(scheduleSync);
    resizeObserver.observe(wrapper);
    resizeObserver.observe(shelf);
    resizeObserver.observe(selectedText);
  } else {
    window.addEventListener("resize", scheduleSync, { passive: true });
  }

  sync();
}

if (typeof document !== "undefined") {
  const start = () => window.setTimeout(initializeAttachmentContextSurface, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
