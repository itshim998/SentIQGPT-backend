// SentIQGPT — Chat UI
//
// Main chat interface controller.
// Renders messages, handles user input, renders chart and image responses,
// and wires up the text-selection "Ask SentIQGPT" feature.

/* global SentIQAPI, SentIQStorage, SentIQChartRenderer, SentIQTextSelection, marked */

// ─── State ──────────────────────────────────────────────────────────────────

let currentSessionId = _generateId();
let sessions = {};      // id → { id, title, messages: [], memories: [] }
let isLoading = false;

// ─── DOM refs ────────────────────────────────────────────────────────────────

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const sessionsList = document.getElementById("sessions-list");
const chatTitle = document.getElementById("chat-title");
const newChatBtn = document.getElementById("new-chat-btn");

// ─── Initialise ──────────────────────────────────────────────────────────────

async function init() {
  await _loadSessions();
  _renderSessionsList();

  if (Object.keys(sessions).length === 0) {
    _startNewSession();
  } else {
    const latest = Object.values(sessions).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    _switchSession(latest.id);
  }

  // Wire up text selection tool
  if (window.SentIQTextSelection) {
    SentIQTextSelection.init({
      scope: "#messages",
      onAsk: _handleSelectionAsk,
    });
  }

  // Input events
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      _handleSend();
    }
  });

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
    sendBtn.disabled = !inputEl.value.trim() || isLoading;
  });

  sendBtn.addEventListener("click", _handleSend);
  newChatBtn.addEventListener("click", _startNewSession);

  // Suggestion chips
  document.querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      inputEl.value = chip.dataset.prompt || chip.textContent.trim();
      inputEl.dispatchEvent(new Event("input"));
      inputEl.focus();
    });
  });
}

// ─── Session management ──────────────────────────────────────────────────────

function _generateId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function _startNewSession() {
  const id = _generateId();
  sessions[id] = { id, title: "New Chat", messages: [], memories: [], updatedAt: Date.now() };
  currentSessionId = id;
  _renderSessionsList();
  _renderMessages();
  chatTitle.textContent = "New Chat";
  _showEmptyState();
  SentIQStorage.saveSession(sessions[id]).catch(() => {});
}

function _switchSession(id) {
  currentSessionId = id;
  _renderSessionsList();
  _renderMessages();
  chatTitle.textContent = sessions[id]?.title ?? "Chat";
}

async function _loadSessions() {
  try {
    const stored = await SentIQStorage.getAllSessions();
    sessions = {};
    for (const s of stored) {
      sessions[s.id] = s;
    }
  } catch {
    sessions = {};
  }
}

function _renderSessionsList() {
  sessionsList.innerHTML = "";
  const sorted = Object.values(sessions).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  for (const s of sorted) {
    const el = document.createElement("div");
    el.className = `session-item${s.id === currentSessionId ? " active" : ""}`;
    el.innerHTML = `<span>💬</span><span class="session-title">${escapeHtml(s.title)}</span>`;
    el.addEventListener("click", () => _switchSession(s.id));
    sessionsList.appendChild(el);
  }
}

// ─── Message rendering ───────────────────────────────────────────────────────

function _renderMessages() {
  const session = sessions[currentSessionId];
  if (!session || session.messages.length === 0) {
    _showEmptyState();
    return;
  }

  messagesEl.innerHTML = "";
  for (const msg of session.messages) {
    _appendMessage(msg, false);
  }
  _scrollToBottom();
}

function _showEmptyState() {
  messagesEl.innerHTML = `
    <div class="empty-state">
      <div class="logo-big">✦</div>
      <h2>SentIQGPT</h2>
      <p>Your intelligent AI assistant. Ask anything — from general knowledge to data visualizations.</p>
      <div class="suggestion-chips">
        <div class="suggestion-chip" data-prompt="Generate a scatter plot with Gaussian distribution">📊 Scatter plot</div>
        <div class="suggestion-chip" data-prompt="Create a bar chart for categories A, B, C, D, E">📈 Bar chart</div>
        <div class="suggestion-chip" data-prompt="Show a histogram of normally distributed data">📉 Histogram</div>
        <div class="suggestion-chip" data-prompt="Explain how neural networks work">🧠 Neural networks</div>
        <div class="suggestion-chip" data-prompt="What is the difference between Python lists and tuples?">🐍 Python help</div>
      </div>
    </div>
  `;

  // Re-wire suggestion chips
  document.querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      inputEl.value = chip.dataset.prompt || chip.textContent.trim();
      inputEl.dispatchEvent(new Event("input"));
      inputEl.focus();
    });
  });
}

/**
 * Append a message object to the messages DOM.
 * @param {{ role: string, content: string, chart?: object, image?: object, timestamp: number }} msg
 * @param {boolean} animate - Whether to scroll into view after appending
 */
function _appendMessage(msg, animate = true) {
  // Remove empty state if present
  const emptyState = messagesEl.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  const row = document.createElement("div");
  row.className = `message-row ${msg.role}`;
  row.dataset.messageId = msg.id ?? "";

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = msg.role === "user" ? "👤" : "✦";

  const content = document.createElement("div");
  content.className = "message-content";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  if (msg.role === "assistant") {
    bubble.innerHTML = _renderMarkdown(msg.content ?? "");
  } else {
    bubble.textContent = msg.content ?? "";
  }

  content.appendChild(bubble);

  // Chart output
  if (msg.chart?.success) {
    const chartContainer = document.createElement("div");
    SentIQChartRenderer.renderChart(chartContainer, msg.chart);
    content.appendChild(chartContainer);
  }

  // Image output
  if (msg.image?.success && (msg.image.image_url || msg.image.image_base64)) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "image-container";
    const img = document.createElement("img");
    img.src = msg.image.image_url ||
      (msg.image.image_base64 ? `data:image/png;base64,${msg.image.image_base64}` : "");
    img.alt = msg.image.prompt ?? "Generated image";
    img.loading = "lazy";
    imgWrap.appendChild(img);
    content.appendChild(imgWrap);
  }

  // Disclaimer
  if (msg.disclaimer) {
    const disc = document.createElement("div");
    disc.className = "disclaimer";
    disc.textContent = msg.disclaimer;
    content.appendChild(disc);
  }

  // Meta
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = msg.timestamp ? _formatTime(msg.timestamp) : "";
  content.appendChild(meta);

  row.appendChild(avatar);
  row.appendChild(content);
  messagesEl.appendChild(row);

  if (animate) _scrollToBottom();
}

function _appendTypingIndicator() {
  const row = document.createElement("div");
  row.className = "message-row assistant";
  row.id = "typing-indicator";
  row.innerHTML = `
    <div class="message-avatar">✦</div>
    <div class="message-content">
      <div class="message-bubble">
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      </div>
    </div>
  `;
  messagesEl.appendChild(row);
  _scrollToBottom();
}

function _removeTypingIndicator() {
  const el = document.getElementById("typing-indicator");
  if (el) el.remove();
}

// ─── Send message ────────────────────────────────────────────────────────────

async function _handleSend() {
  const text = inputEl.value.trim();
  if (!text || isLoading) return;

  inputEl.value = "";
  inputEl.style.height = "auto";
  sendBtn.disabled = true;
  isLoading = true;

  const session = sessions[currentSessionId];

  const userMsg = {
    id: _generateId(),
    role: "user",
    content: text,
    timestamp: Date.now(),
  };

  session.messages.push(userMsg);
  _appendMessage(userMsg);

  _appendTypingIndicator();

  try {
    const context = {
      recent_messages: session.messages.slice(-20).map((m) => ({
        role: m.role,
        content: m.content ?? "",
      })),
      memories: session.memories ?? [],
    };

    const response = await SentIQAPI.sendChat(text, context);

    _removeTypingIndicator();

    const assistantMsg = {
      id: _generateId(),
      role: "assistant",
      content: response.reply ?? "",
      chart: response.chart ?? null,
      image: response.image ?? null,
      disclaimer: response.disclaimer ?? null,
      timestamp: Date.now(),
    };

    session.messages.push(assistantMsg);
    _appendMessage(assistantMsg);

    // Store memory if returned
    if (response.memory?.stored) {
      session.memories = session.memories ?? [];
      session.memories.push({
        id: _generateId(),
        type: response.memory.type ?? "general",
        summary: response.memory.summary ?? "",
        importance: response.memory.importance ?? 5,
        timestamp: new Date().toISOString(),
      });
    }

    // Generate title on first exchange
    if (session.messages.length === 2 && session.title === "New Chat") {
      SentIQAPI.generateTitle(text, response.reply ?? "").then(({ title }) => {
        session.title = title ?? text.slice(0, 50);
        chatTitle.textContent = session.title;
        _renderSessionsList();
        SentIQStorage.saveSession(session).catch(() => {});
      });
    }

    session.updatedAt = Date.now();
    SentIQStorage.saveSession(session).catch(() => {});

  } catch (err) {
    _removeTypingIndicator();
    _appendMessage({
      id: _generateId(),
      role: "assistant",
      content: `⚠ Error: ${err.message}`,
      timestamp: Date.now(),
    });
  } finally {
    isLoading = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

// ─── "Ask SentIQGPT" selection handler ──────────────────────────────────────

async function _handleSelectionAsk(payload) {
  if (!payload?.selected_text) return;

  const session = sessions[currentSessionId];

  // Display user message summarising what was selected
  const preview = payload.selected_text.slice(0, 80);
  const userMsg = {
    id: _generateId(),
    role: "user",
    content: `[Selected text]: "${preview}${payload.selected_text.length > 80 ? "…" : ""}"`,
    timestamp: Date.now(),
  };
  session.messages.push(userMsg);
  _appendMessage(userMsg);
  _appendTypingIndicator();

  isLoading = true;
  sendBtn.disabled = true;

  try {
    const response = await SentIQAPI.sendSelectionChat({
      ...payload,
      context: {
        recent_messages: session.messages.slice(-20).map((m) => ({
          role: m.role,
          content: m.content ?? "",
        })),
        memories: session.memories ?? [],
      },
    });

    _removeTypingIndicator();

    const assistantMsg = {
      id: _generateId(),
      role: "assistant",
      content: response.reply ?? "",
      chart: response.chart ?? null,
      image: response.image ?? null,
      disclaimer: response.disclaimer ?? null,
      timestamp: Date.now(),
    };

    session.messages.push(assistantMsg);
    _appendMessage(assistantMsg);

    session.updatedAt = Date.now();
    SentIQStorage.saveSession(session).catch(() => {});

  } catch (err) {
    _removeTypingIndicator();
    _appendMessage({
      id: _generateId(),
      role: "assistant",
      content: `⚠ Error: ${err.message}`,
      timestamp: Date.now(),
    });
  } finally {
    isLoading = false;
    sendBtn.disabled = false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _scrollToBottom() {
  setTimeout(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }, 50);
}

function _formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert Markdown text to safe HTML.
 * Uses the `marked` library if available, otherwise falls back to a simple
 * converter that handles the most common patterns.
 */
function _renderMarkdown(text) {
  if (typeof marked !== "undefined") {
    try {
      return marked.parse(text);
    } catch {
      // fall through to simple renderer
    }
  }
  // Simple fallback renderer
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\n/g, "<br>");
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);

window.SentIQChat = { init };
