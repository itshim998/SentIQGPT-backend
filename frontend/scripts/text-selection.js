// SentIQGPT — "Ask SentIQGPT" Text Selection Tool
//
// Implements a ChatGPT-style text selection feature for desktop users.
// When the user selects text inside the chat interface, a floating button
// appears near the selection allowing them to ask the assistant about
// the selected text with up to 3 lines of surrounding context.
//
// DESKTOP ONLY — disabled on:
//   • screen width ≤ 768 px
//   • touch-primary devices (coarse pointer / no mouse)
//   • user agents matching known mobile browsers

// ─── Mobile detection ─────────────────────────────────────────────────────

function isMobileEnvironment() {
  // Screen width check
  if (window.innerWidth <= 768) return true;

  // Touch-primary device (no mouse, coarse pointer)
  if (window.matchMedia("(pointer: coarse)").matches) return true;
  if (!window.matchMedia("(hover: hover)").matches) return true;

  // User agent check for common mobile browsers
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;

  return false;
}

// ─── Constants ────────────────────────────────────────────────────────────

const MAX_SELECTED_LINES = 3;
const CONTEXT_LINES = 3;
const BTN_ID = "ask-sentiqgpt-btn";

// ─── State ─────────────────────────────────────────────────────────────────

let _floatingBtn = null;
let _hideTimeout = null;
let _pendingSelection = null;

// ─── Init ──────────────────────────────────────────────────────────────────

/**
 * Initialise the text selection tool.
 * Call once after DOM is ready.
 *
 * @param {object} options
 *   onAsk(payload) — callback when the user clicks "Ask SentIQGPT"
 *   scope          — CSS selector for the element to watch (default: ".messages-container")
 */
function initTextSelectionTool(options = {}) {
  if (isMobileEnvironment()) {
    console.log("[TextSelection] disabled on mobile");
    return;
  }

  const { onAsk, scope = ".messages-container" } = options;

  _floatingBtn = document.getElementById(BTN_ID);
  if (!_floatingBtn) {
    _floatingBtn = _createButton();
    document.body.appendChild(_floatingBtn);
  }

  _floatingBtn.addEventListener("mousedown", (e) => {
    e.preventDefault(); // prevent selection loss on button click
  });

  _floatingBtn.addEventListener("click", () => {
    if (_pendingSelection && typeof onAsk === "function") {
      onAsk(_pendingSelection);
    }
    _hideButton();
    _pendingSelection = null;
  });

  // Listen for selection changes
  document.addEventListener("selectionchange", () => {
    _onSelectionChange(scope);
  });

  // Hide button when clicking elsewhere
  document.addEventListener("mousedown", (e) => {
    if (e.target !== _floatingBtn) {
      _scheduleHide();
    }
  });

  // Re-check on resize (mobile breakpoint might be crossed)
  window.addEventListener("resize", () => {
    if (isMobileEnvironment()) _hideButton();
  });

  console.log("[TextSelection] text selection tool initialised");
}

// ─── Selection logic ──────────────────────────────────────────────────────

function _onSelectionChange(scope) {
  clearTimeout(_hideTimeout);

  const selection = window.getSelection();

  // No selection or collapsed
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    _scheduleHide();
    return;
  }

  const selectedText = selection.toString().trim();
  if (!selectedText) {
    _scheduleHide();
    return;
  }

  // Verify selection is within the scoped element
  const scopeEl = document.querySelector(scope);
  if (!scopeEl) {
    _scheduleHide();
    return;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  if (!scopeEl.contains(commonAncestor)) {
    _scheduleHide();
    return;
  }

  // Build payload
  const payload = _buildPayload(selectedText, range, scopeEl);
  _pendingSelection = payload;

  // Position and show button
  const rect = range.getBoundingClientRect();
  _positionButton(rect);
  _showButton();
}

// ─── Payload builder ──────────────────────────────────────────────────────

/**
 * Build the selection context payload.
 * Truncates selection to MAX_SELECTED_LINES and includes up to CONTEXT_LINES
 * above and below within the same message bubble.
 *
 * @param {string} selectedText
 * @param {Range} range
 * @param {HTMLElement} scopeEl
 * @returns {{ selected_text: string, context_before: string, context_after: string }}
 */
function _buildPayload(selectedText, range, scopeEl) {
  // Truncate selection to 3 lines
  const selLines = selectedText.split("\n");
  const truncatedSelection = selLines.slice(0, MAX_SELECTED_LINES).join("\n");

  // Find the closest message bubble containing the selection
  let bubbleEl = range.startContainer;
  while (bubbleEl && bubbleEl !== scopeEl) {
    if (
      bubbleEl.nodeType === Node.ELEMENT_NODE &&
      bubbleEl.classList &&
      bubbleEl.classList.contains("message-bubble")
    ) {
      break;
    }
    bubbleEl = bubbleEl.parentNode;
  }

  let contextBefore = "";
  let contextAfter = "";

  if (bubbleEl && bubbleEl !== scopeEl) {
    const fullText = bubbleEl.innerText || bubbleEl.textContent || "";
    const allLines = fullText.split("\n").filter((l) => l.trim());

    // Find the line index of the first selected line
    const firstSelLine = selLines[0].trim();
    let selLineIdx = allLines.findIndex((l) => l.includes(firstSelLine));
    if (selLineIdx < 0) selLineIdx = 0;

    const beforeLines = allLines.slice(
      Math.max(0, selLineIdx - CONTEXT_LINES),
      selLineIdx,
    );
    const afterLines = allLines.slice(
      selLineIdx + selLines.length,
      selLineIdx + selLines.length + CONTEXT_LINES,
    );

    contextBefore = beforeLines.join("\n");
    contextAfter = afterLines.join("\n");
  }

  return {
    selected_text: truncatedSelection,
    context_before: contextBefore,
    context_after: contextAfter,
  };
}

// ─── Button helpers ───────────────────────────────────────────────────────

function _createButton() {
  const btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.setAttribute("aria-label", "Ask SentIQGPT about selected text");
  btn.innerHTML = `<span>✦</span> Ask SentIQGPT`;
  return btn;
}

function _positionButton(rect) {
  if (!_floatingBtn) return;

  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;

  // Position above the selection, centred horizontally
  const btnWidth = 160; // approximate
  let left = rect.left + scrollX + rect.width / 2 - btnWidth / 2;
  let top = rect.top + scrollY - 44; // 44px above selection

  // Clamp to viewport
  left = Math.max(8, Math.min(left, window.innerWidth - btnWidth - 8));
  if (top < scrollY + 8) {
    top = rect.bottom + scrollY + 8; // flip below if too close to top
  }

  _floatingBtn.style.left = `${left}px`;
  _floatingBtn.style.top = `${top}px`;
}

function _showButton() {
  if (!_floatingBtn) return;
  _floatingBtn.classList.add("visible");
}

function _hideButton() {
  if (!_floatingBtn) return;
  _floatingBtn.classList.remove("visible");
}

function _scheduleHide(delay = 200) {
  clearTimeout(_hideTimeout);
  _hideTimeout = setTimeout(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      _hideButton();
      _pendingSelection = null;
    }
  }, delay);
}

// ─── Exports ──────────────────────────────────────────────────────────────

window.SentIQTextSelection = {
  init: initTextSelectionTool,
  isMobile: isMobileEnvironment,
};
