const INVALID_TITLE_SHELL_PATTERNS = Object.freeze([
  /^`{1,3}\s*(?:json)?\s*$/i,
  /^`{1,3}\s*(?:json)?\s*[\[{]\s*$/i,
  /^\s*`{1,3}/i,
]);

function stripMarkdownFence(value) {
  return String(value ?? "")
    .trim()
    .replace(/^`{1,3}(?:json|text)?\s*/i, "")
    .replace(/\s*`{1,3}$/i, "")
    .trim();
}

export function extractSafeConversationTitle(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return "";

  const unfenced = stripMarkdownFence(raw);
  try {
    const parsed = JSON.parse(unfenced);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.title === "string") {
      const title = parsed.title.replace(/\s+/g, " ").trim();
      if (title && title.length <= 120) return title;
    }
  } catch {
    // Continue to tolerant extraction for incomplete model output.
  }

  const fieldMatch = raw.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  if (fieldMatch?.[1]) {
    const title = fieldMatch[1]
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\s+/g, " ")
      .trim();
    if (title && title.length <= 120) return title;
  }

  if (INVALID_TITLE_SHELL_PATTERNS.some((pattern) => pattern.test(raw))) return "";
  if (/^\s*[`{\[]/.test(raw)) return "";
  if (/[}\]]$/.test(raw)) return "";
  if (/"[a-zA-Z0-9_-]+"\s*:/.test(raw)) return "";

  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 120) return normalized.slice(0, 120).trim();
  return normalized;
}

function shouldRepairTitle(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return false;
  const safe = extractSafeConversationTitle(raw);
  return !safe || safe !== raw;
}

function repairChatListTitles(root = document) {
  const titleElements = root.querySelectorAll?.(
    "#chat-list .chat-list-item[data-id] .chat-list-item-title",
  ) ?? [];

  for (const titleElement of titleElements) {
    const raw = titleElement.textContent ?? "";
    if (!shouldRepairTitle(raw)) continue;
    const safe = extractSafeConversationTitle(raw);
    titleElement.textContent = safe || "New Chat";
  }
}

function installConversationTitleSanitizer() {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      repairChatListTitles(document);
    });
  };

  const start = () => {
    repairChatListTitles(document);
    const chatList = document.getElementById("chat-list");
    if (!chatList) return;
    const observer = new MutationObserver(schedule);
    observer.observe(chatList, { childList: true, subtree: true, characterData: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}

installConversationTitleSanitizer();
