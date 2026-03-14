// SentIQGPT — API Client
// All HTTP communication with the backend.

const API_BASE = (() => {
  if (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  ) {
    return "http://localhost:3001";
  }
  return "https://sentiqgpt-backend.onrender.com";
})();

// ─── Chat ───────────────────────────────────────────────────────────────────

/**
 * Send a chat message to the orchestrator.
 * @param {string} message
 * @param {object} context - { recent_messages, memories, file_references }
 * @returns {Promise<object>}
 */
async function sendChat(message, context = {}) {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, context }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Send a text-selection context request ("Ask SentIQGPT").
 * @param {object} payload - { selected_text, context_before, context_after, context }
 * @returns {Promise<object>}
 */
async function sendSelectionChat(payload) {
  const res = await fetch(`${API_BASE}/api/chat/selection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Generate chart code / preview from a natural-language message.
 * @param {string} message
 * @param {boolean} fetchPreview - Request a base64 PNG preview
 * @returns {Promise<object>}
 */
async function generateChart(message, fetchPreview = true) {
  const res = await fetch(`${API_BASE}/api/charts/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, fetch_preview: fetchPreview }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Generate a session title from the first exchange.
 * @param {string} userMessage
 * @param {string} assistantReply
 * @returns {Promise<{ title: string }>}
 */
async function generateTitle(userMessage, assistantReply) {
  const res = await fetch(`${API_BASE}/api/chat/title`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userMessage, assistantReply }),
  });

  if (!res.ok) return { title: userMessage.slice(0, 50) };
  return res.json();
}

/**
 * Upload a file and return extracted text.
 * @param {File} file
 * @returns {Promise<object>}
 */
async function uploadFile(file) {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_BASE}/api/files/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Fetch server health.
 * @returns {Promise<object>}
 */
async function fetchHealth() {
  const res = await fetch(`${API_BASE}/api/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

window.SentIQAPI = {
  sendChat,
  sendSelectionChat,
  generateChart,
  generateTitle,
  uploadFile,
  fetchHealth,
  API_BASE,
};
