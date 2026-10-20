const GENERATED_IMAGE_LABEL = "generated image";
const PNG_MIME_TYPE = "image/png";
const IMAGE_CARD_SELECTOR = ".image-generation-card, .message-image-container";
const GENERATED_IMAGE_SELECTOR = [
  ".image-generation-card img.message-image",
  ".message-image-container img.message-image",
].join(",");
const STATIC_LABEL_SELECTORS = [
  ".image-gen-label",
  ".generated-image-label",
  ".image-generation-label",
  ".image-generation-eyebrow",
  ".image-generation-kicker",
  "[data-generated-image-label]",
  "[data-image-generation-label]",
].join(",");

function getBrowserNavigator() {
  return typeof navigator !== "undefined" ? navigator : null;
}

function getBrowserWindow() {
  return typeof window !== "undefined" ? window : null;
}

function createClipboardError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function normalizeGeneratedImageLabelText(value) {
  return String(value || "")
    .replace(/^[\s\u2022\u00b7\u25cf\u25aa\u25e6]+/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isGeneratedImageLabelText(value) {
  return normalizeGeneratedImageLabelText(value) === GENERATED_IMAGE_LABEL;
}

export function isImageCopyControlLabel(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  return /^copy(?:\s+(?:image|generated image|response|message))?$/.test(normalized);
}

function getCopyControlLabel(button) {
  if (!button) return "";
  return button.querySelector?.(".message-action-label")?.textContent
    || button.getAttribute?.("aria-label")
    || button.getAttribute?.("title")
    || button.textContent
    || "";
}

function setCopyControlLabel(button, label) {
  if (!button) return;
  const labelElement = button.querySelector?.(".message-action-label");
  if (labelElement) labelElement.textContent = label;
  button.setAttribute?.("aria-label", label);
}

function showToast(message, type = "info", durationMs = 3200) {
  const app = getBrowserWindow()?.SentIQChat;
  if (typeof app?.showToast === "function") {
    app.showToast(message, type, durationMs);
  }
}

async function fetchImageBlob(imageUrl, fetchImpl) {
  const url = String(imageUrl || "").trim();
  if (!url) throw createClipboardError("missing_image_url", "Image unavailable.");
  if (typeof fetchImpl !== "function") {
    throw createClipboardError("image_fetch_unsupported", "Can't load images in this browser.");
  }

  const isDataUrl = url.startsWith("data:");
  const response = await fetchImpl(url, isDataUrl
    ? {}
    : { mode: "cors", credentials: "omit", cache: "force-cache" });
  if (!response?.ok && !isDataUrl) {
    throw createClipboardError("image_fetch_failed", "Couldn't load the image.");
  }
  const blob = await response.blob();
  if (!blob || !String(blob.type || "").toLowerCase().startsWith("image/")) {
    throw createClipboardError("invalid_image_blob", "Couldn't open the image.");
  }
  return blob;
}

async function loadImageSource(blob, options = {}) {
  const createImageBitmapImpl = options.createImageBitmapImpl
    || (typeof createImageBitmap === "function" ? createImageBitmap : null);
  if (typeof createImageBitmapImpl === "function") {
    const bitmap = await createImageBitmapImpl(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close?.(),
    };
  }

  const documentRef = options.documentRef || (typeof document !== "undefined" ? document : null);
  const ImageCtor = options.ImageCtor || getBrowserWindow()?.Image;
  const URLRef = options.URLRef || getBrowserWindow()?.URL;
  if (!documentRef || typeof ImageCtor !== "function" || !URLRef?.createObjectURL) {
    throw createClipboardError("image_decode_unsupported", "Can't open images in this browser.");
  }

  const objectUrl = URLRef.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const image = new ImageCtor();
    image.decoding = "async";
    image.onload = () => resolve({
      source: image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      cleanup: () => URLRef.revokeObjectURL?.(objectUrl),
    });
    image.onerror = () => {
      URLRef.revokeObjectURL?.(objectUrl);
      reject(createClipboardError("image_decode_failed", "Couldn't open the image."));
    };
    image.src = objectUrl;
  });
}

async function renderBlobAsPng(blob, options = {}) {
  if (String(blob?.type || "").toLowerCase() === PNG_MIME_TYPE) return blob;

  const documentRef = options.documentRef || (typeof document !== "undefined" ? document : null);
  if (!documentRef?.createElement) {
    throw createClipboardError("canvas_unsupported", "Can't copy images in this browser.");
  }

  const decoded = await loadImageSource(blob, options);
  try {
    const width = Number(decoded.width) || 0;
    const height = Number(decoded.height) || 0;
    if (width <= 0 || height <= 0) {
      throw createClipboardError("invalid_image_dimensions", "Couldn't copy the image.");
    }

    const canvas = documentRef.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext?.("2d", { alpha: true });
    if (!context) {
      throw createClipboardError("canvas_context_unavailable", "Can't copy images in this browser.");
    }
    context.drawImage(decoded.source, 0, 0, width, height);

    return await new Promise((resolve, reject) => {
      canvas.toBlob?.((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(createClipboardError("png_conversion_failed", "Couldn't copy the image."));
      }, PNG_MIME_TYPE);
    });
  } finally {
    decoded.cleanup?.();
  }
}

export async function resolveImageAsPngBlob(imageUrl, options = {}) {
  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const sourceBlob = await fetchImageBlob(imageUrl, fetchImpl);
  return renderBlobAsPng(sourceBlob, options);
}

export async function writeImageToClipboard(imageUrl, options = {}) {
  const browserNavigator = getBrowserNavigator();
  const clipboard = options.clipboard || browserNavigator?.clipboard;
  const ClipboardItemCtor = options.ClipboardItemCtor
    || (typeof ClipboardItem !== "undefined" ? ClipboardItem : null);

  if (typeof clipboard?.write !== "function" || typeof ClipboardItemCtor !== "function") {
    throw createClipboardError(
      "image_clipboard_unsupported",
      "Copying images isn't supported in this browser.",
    );
  }
  if (typeof ClipboardItemCtor.supports === "function" && !ClipboardItemCtor.supports(PNG_MIME_TYPE)) {
    throw createClipboardError(
      "image_clipboard_unsupported",
      "Copying images isn't supported in this browser.",
    );
  }

  const resolvePngBlob = typeof options.resolvePngBlob === "function"
    ? options.resolvePngBlob
    : (url) => resolveImageAsPngBlob(url, options);
  const pngBlobPromise = Promise.resolve()
    .then(() => resolvePngBlob(imageUrl))
    .then((blob) => {
      if (!blob || String(blob.type || "").toLowerCase() !== PNG_MIME_TYPE) {
        throw createClipboardError("invalid_png_blob", "Couldn't copy the image.");
      }
      return blob;
    });

  let clipboardItem;
  try {
    // Passing a Blob promise lets Chromium keep the clipboard write inside the
    // original user gesture while the remote WebP/JPEG is converted to PNG.
    clipboardItem = new ClipboardItemCtor({ [PNG_MIME_TYPE]: pngBlobPromise });
  } catch {
    clipboardItem = new ClipboardItemCtor({ [PNG_MIME_TYPE]: await pngBlobPromise });
  }

  await clipboard.write([clipboardItem]);
  return { mode: "image", mimeType: PNG_MIME_TYPE };
}

function findGeneratedImageForCopyButton(button) {
  const message = button?.closest?.(".message.assistant");
  if (!message) return null;
  const image = message.querySelector(GENERATED_IMAGE_SELECTOR);
  if (!image) return null;
  const imageUrl = String(image.currentSrc || image.src || "").trim();
  return imageUrl ? { image, imageUrl, message } : null;
}

function removeExactGeneratedImageLabels(scope) {
  if (!scope?.querySelectorAll) return;
  const cards = [];
  if (scope.matches?.(IMAGE_CARD_SELECTOR)) cards.push(scope);
  cards.push(...scope.querySelectorAll(IMAGE_CARD_SELECTOR));

  for (const card of cards) {
    const message = card.closest?.(".message.assistant") || card.closest?.(".message") || card.parentElement;
    if (!message?.querySelectorAll) continue;

    message.querySelectorAll(STATIC_LABEL_SELECTORS).forEach((label) => {
      if (isGeneratedImageLabelText(label.textContent)) label.remove();
    });

    message.querySelectorAll("div, span, p, small, strong").forEach((candidate) => {
      if (!candidate?.isConnected || candidate === card || candidate.contains(card)) return;
      if (!isGeneratedImageLabelText(candidate.textContent)) return;
      if (candidate.matches?.("button, a, input, textarea, select")) return;
      if (candidate.querySelector?.("img, video, canvas, button, a, input, textarea, select")) return;

      const followingFlag = typeof Node !== "undefined" ? Node.DOCUMENT_POSITION_FOLLOWING : 4;
      const appearsBeforeCard = Boolean(candidate.compareDocumentPosition?.(card) & followingFlag);
      if (!appearsBeforeCard) return;

      let removable = candidate;
      while (
        removable.parentElement
        && removable.parentElement !== message
        && !removable.parentElement.contains(card)
        && isGeneratedImageLabelText(removable.parentElement.textContent)
      ) {
        removable = removable.parentElement;
      }
      removable.remove();
    });
  }
}

function injectImageOutputPolishStyle(documentRef) {
  if (!documentRef?.head || documentRef.getElementById("sentiq-image-output-polish-style")) return;
  const style = documentRef.createElement("style");
  style.id = "sentiq-image-output-polish-style";
  style.textContent = `
.image-gen-label,
.generated-image-label,
.image-generation-label,
.image-generation-eyebrow,
.image-generation-kicker,
[data-generated-image-label],
[data-image-generation-label] {
  display: none !important;
}
`;
  documentRef.head.appendChild(style);
}

function initializeImageOutputPolish(documentRef = document) {
  injectImageOutputPolishStyle(documentRef);

  let cleanupScheduled = false;
  const scheduleCleanup = (scope = documentRef) => {
    if (cleanupScheduled) return;
    cleanupScheduled = true;
    const run = () => {
      cleanupScheduled = false;
      removeExactGeneratedImageLabels(scope?.isConnected === false ? documentRef : scope);
    };
    const windowRef = getBrowserWindow();
    if (typeof windowRef?.requestAnimationFrame === "function") windowRef.requestAnimationFrame(run);
    else setTimeout(run, 0);
  };

  scheduleCleanup(documentRef);
  const observerTarget = documentRef.getElementById("chat-messages") || documentRef.body;
  if (observerTarget && typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes || []) {
          if (node?.nodeType === 1) scheduleCleanup(node);
        }
      }
    });
    observer.observe(observerTarget, { childList: true, subtree: true });
  }

  documentRef.addEventListener("click", (event) => {
    const target = event.target;
    const button = target?.closest?.(".message-action-btn");
    if (!button || !isImageCopyControlLabel(getCopyControlLabel(button))) return;

    const imageContext = findGeneratedImageForCopyButton(button);
    if (!imageContext) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    if (button.dataset.sentiqImageCopyPending === "true") return;

    const originalLabel = getCopyControlLabel(button) || "Copy";
    const originalAriaLabel = button.getAttribute("aria-label");
    const originalTitle = button.getAttribute("title");
    button.dataset.sentiqImageCopyPending = "true";
    button.disabled = true;
    setCopyControlLabel(button, "Copying…");

    writeImageToClipboard(imageContext.imageUrl)
      .then(() => {
        button.classList.add("copied");
        setCopyControlLabel(button, "Copied");
        showToast("Image copied.", "success", 2400);
      })
      .catch((error) => {
        button.classList.remove("copied");
        setCopyControlLabel(button, "Couldn't copy");
        const unsupported = error?.code === "image_clipboard_unsupported";
        showToast(
          unsupported
            ? "Copying images isn't supported in this browser."
            : "Couldn't copy the image. Check clipboard permission and try again.",
          "error",
          3800,
        );
      })
      .finally(() => {
        setTimeout(() => {
          delete button.dataset.sentiqImageCopyPending;
          button.disabled = false;
          button.classList.remove("copied");
          setCopyControlLabel(button, originalLabel);
          if (originalAriaLabel === null) button.removeAttribute("aria-label");
          else button.setAttribute("aria-label", originalAriaLabel);
          if (originalTitle === null) button.removeAttribute("title");
          else button.setAttribute("title", originalTitle);
        }, 1800);
      });
  }, true);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initializeImageOutputPolish(document), { once: true });
  } else {
    initializeImageOutputPolish(document);
  }
}
