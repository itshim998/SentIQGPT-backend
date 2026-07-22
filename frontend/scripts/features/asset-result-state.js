/* SentIQ Liquid Glass V4 — Phase 7.3 asset result helpers */

export const ASSET_RESULT_VERSION = "7.3";
export const ASSET_RESULT_SELECTOR = [
  ".image-generation-card",
  ".message-chart-container",
  ".generated-file-panel",
].join(", ");

export function cleanAssetText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function formatAssetBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "Size unavailable";
  const units = ["B", "KB", "MB", "GB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const digits = amount >= 100 || unit === 0 ? 0 : amount >= 10 ? 1 : 2;
  const formatted = amount.toFixed(digits)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1");
  return `${formatted} ${units[unit]}`;
}

export function getGeneratedFileFormat(panel) {
  if (!(panel instanceof Element)) return "file";
  const formatClass = Array.from(panel.classList).find((name) => name.startsWith("format-"));
  const fromClass = formatClass?.slice(7);
  if (fromClass) return fromClass.toLowerCase();
  const icon = cleanAssetText(panel.querySelector(".generated-file-icon")?.textContent).toLowerCase();
  if (icon === "xls") return "xlsx";
  if (icon) return icon;
  const title = cleanAssetText(panel.querySelector(".generated-file-title")?.textContent);
  const extension = title.match(/\.([a-z0-9]{2,6})$/i)?.[1];
  return extension?.toLowerCase() || "file";
}

export function getGeneratedFileTypeLabel(format) {
  return ({
    html: "HTML document",
    txt: "Text document",
    xlsx: "Excel workbook",
    pptx: "PowerPoint presentation",
    docx: "Word document",
    pdf: "PDF document",
  })[String(format || "").toLowerCase()] || "Generated file";
}

export function parseAssetSize(root) {
  const text = cleanAssetText(root?.textContent);
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\b/i);
  if (!match) return "";
  return `${match[1]} ${match[2].toUpperCase()}`;
}

export function estimateTextBytes(value) {
  const text = String(value || "");
  if (!text) return 0;
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
  if (typeof Blob === "function") return new Blob([text]).size;
  return encodeURIComponent(text).replace(/%[0-9A-F]{2}|./gi, "x").length;
}

export function findMessageRetryControl(surface) {
  const message = surface?.closest?.(".message");
  if (!message) return null;
  return Array.from(message.querySelectorAll("button, [role='button']")).find((control) => {
    if (surface.contains(control)) return false;
    const label = [control.getAttribute("aria-label"), control.title, control.textContent]
      .filter(Boolean).join(" ");
    return /\b(retry|regenerate|try again)\b/i.test(label) && !control.disabled;
  }) || null;
}

export function isAssetFailureMessage(message) {
  const text = cleanAssetText(message?.textContent);
  return /(?:could(?:n'?t| not)|failed to|unable to).{0,48}\b(image|chart|file|document|spreadsheet|presentation|pdf)\b/i.test(text)
    || /\b(image|chart|file|document|spreadsheet|presentation|pdf).{0,48}(?:failed|unavailable|could(?:n'?t| not))/i.test(text);
}
