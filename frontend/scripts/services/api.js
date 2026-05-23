// ================================================================
// 3. API Client
// ================================================================
import { PROFILE_NAME_REQUIRED_EVENT } from "../shared/events.js";

const API_BASE = window.SENTIQ_API_BASE ||
  (location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:3001"
    : "https://sentiqgpt-backend.ashygrass-913d190e.centralindia.azurecontainerapps.io");

async function buildAuthHeaders(baseHeaders = {}) {
  const headers = { ...baseHeaders };
  try {
    const token = await window.SentIQAuth?.getAccessToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch { /* auth header is optional for non-chat routes */ }
  return headers;
}

function dispatchProfileNameRequired(detail = {}) {
  window.dispatchEvent(new CustomEvent(PROFILE_NAME_REQUIRED_EVENT, { detail }));
}

function createApiError(response, errorData, fallbackMessage) {
  const message = errorData?.error || fallbackMessage || `Request failed: ${response.status}`;
  const error = new Error(message);
  error.status = response.status;
  error.code = typeof errorData?.code === "string" ? errorData.code : "";
  error.requiresName = Boolean(errorData?.requires_name);
  error.requires_name = Boolean(errorData?.requires_name);
  error.response = response;
  error.details = errorData;
  if (error.code === "profile_name_required" || error.requiresName || error.requires_name) {
    dispatchProfileNameRequired({
      endpoint: response.url,
      status: response.status,
      message,
    });
  }
  return error;
}

async function apiRequest(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = await buildAuthHeaders({ "Content-Type": "application/json", ...(options.headers || {}) });
  const config = { ...options, headers };
  const response = await fetch(url, config);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw createApiError(response, errorData, `Request failed: ${response.status}`);
  }
  return response.json();
}

function buildChatRequestContext(context = {}) {
    const requestContext = {
      recent_messages: context.recentMessages || [],
      memories: context.memories || [],
      file_references: context.fileReferences || [],
      image_attachments: context.imageAttachments || [],
    };
  if (context.webSearchMode === "basic" || context.webSearchMode === "advanced") {
    requestContext.web_search_mode = "basic";
  }
  const trustedDisplayName =
    typeof context.trustedProfile?.displayName === "string" && context.trustedProfile.displayName.trim()
      ? context.trustedProfile.displayName.trim()
      : typeof context.trustedProfile?.display_name === "string" && context.trustedProfile.display_name.trim()
        ? context.trustedProfile.display_name.trim()
        : "";
  if (trustedDisplayName) {
    requestContext.trusted_profile = { display_name: trustedDisplayName };
  }
  return requestContext;
}

function normalizeExecutionMode(mode) {
  return mode === "intuitive" ? "intuitive" : "fast";
}

async function sendMessageStream(message, context = {}, callbacks = {}, signal = null) {
  const url = `${API_BASE}/api/chat/stream`;
  const headers = await buildAuthHeaders({ "Content-Type": "application/json" });
  const conversationId =
    typeof context.conversationId === "string" && context.conversationId.trim()
      ? context.conversationId.trim()
      : undefined;
  const clientRequestId =
    typeof context.clientRequestId === "string" && context.clientRequestId.trim()
      ? context.clientRequestId.trim()
      : undefined;
  const clarificationResponse = context.clarificationResponse && typeof context.clarificationResponse === "object"
    ? context.clarificationResponse
    : undefined;
  const executionMode = normalizeExecutionMode(context.executionMode || context.execution_mode);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message,
      ...(conversationId ? { conversationId } : {}),
      ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
      execution_mode: executionMode,
      ...(clarificationResponse ? { clarification_response: clarificationResponse } : {}),
      context: buildChatRequestContext(context),
    }),
    signal,
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw createApiError(response, errorData, `Stream request failed: ${response.status}`);
  }
  // If the backend redirected a chart/tool request through the orchestrator,
  // it returns JSON instead of SSE. Detect this and signal the caller.
  const contentType = response.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    const jsonResult = await response.json();
    if (callbacks.onStructuredResponse) {
      callbacks.onStructuredResponse(jsonResult);
    }
    return { structured: true, tokensReceived: false, interrupted: false, error: null };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let tokensReceived = false;
  let interrupted = false;
  let terminalError = null;
  let structuredReceived = false;

  function processSseLines(lines) {
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") {
        return true;
      }
      try {
        const parsed = JSON.parse(payload);
        if (parsed.type === "token" && parsed.text) {
          tokensReceived = true;
          if (callbacks.onToken) callbacks.onToken(parsed.text);
        }
        else if (parsed.type === "file_token" && parsed.text) {
          tokensReceived = true;
          if (callbacks.onFileToken) callbacks.onFileToken(parsed.text, parsed);
        }
        else if (parsed.type === "file_artifact") {
          tokensReceived = true;
          if (callbacks.onFileArtifact) callbacks.onFileArtifact(parsed);
        }
        else if (parsed.type === "thinking" && parsed.text) {
          if (callbacks.onThinking) callbacks.onThinking(parsed.text);
        }
        else if (parsed.type === "structured_response" && parsed.response) {
          structuredReceived = true;
          if (callbacks.onStructuredResponse) callbacks.onStructuredResponse(parsed.response);
          return true;
        }
        else if (parsed.type === "route" && parsed.route) { if (callbacks.onRoute) callbacks.onRoute(parsed.route, parsed); }
        else if (parsed.type === "memory" && parsed.memory) { if (callbacks.onMemory) callbacks.onMemory(parsed.memory); }
        else if (parsed.type === "sync" && parsed.sync) { if (callbacks.onSync) callbacks.onSync(parsed.sync, parsed.degraded || null); }
        else if (parsed.type === "error") {
          terminalError = new Error(parsed.error);
          interrupted = tokensReceived;
          if (callbacks.onError) callbacks.onError(terminalError, { tokensReceived, interrupted });
          return true;
        }
      } catch { /* ignore malformed SSE */ }
    }
    return false;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer) {
        const flushed = buffer.split("\n");
        buffer = "";
        if (processSseLines(flushed)) break;
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    if (processSseLines(lines)) break;
  }
  if (!tokensReceived && !structuredReceived && !terminalError) {
    terminalError = new Error("The response did not complete. Please retry.");
    if (callbacks.onError) callbacks.onError(terminalError, { tokensReceived: false, interrupted: false });
    throw terminalError;
  }
  if (terminalError && !tokensReceived) {
    throw terminalError;
  }
  if (!interrupted && callbacks.onDone) callbacks.onDone();
  return { structured: structuredReceived, tokensReceived, interrupted, error: terminalError };
}

async function sendMessage(message, context = {}) {
  const conversationId =
    typeof context.conversationId === "string" && context.conversationId.trim()
      ? context.conversationId.trim()
      : undefined;
  const clientRequestId =
    typeof context.clientRequestId === "string" && context.clientRequestId.trim()
      ? context.clientRequestId.trim()
      : undefined;
  const clarificationResponse = context.clarificationResponse && typeof context.clarificationResponse === "object"
    ? context.clarificationResponse
    : undefined;
  const executionMode = normalizeExecutionMode(context.executionMode || context.execution_mode);
  return apiRequest("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      message,
      ...(conversationId ? { conversationId } : {}),
      ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
      execution_mode: executionMode,
      ...(clarificationResponse ? { clarification_response: clarificationResponse } : {}),
      context: buildChatRequestContext(context),
    }),
    signal: context.signal || null,
  });
}

async function getChatIntent(message, context = {}) {
  const conversationId =
    typeof context.conversationId === "string" && context.conversationId.trim()
      ? context.conversationId.trim()
      : undefined;
  const clientRequestId =
    typeof context.clientRequestId === "string" && context.clientRequestId.trim()
      ? context.clientRequestId.trim()
      : undefined;
  const clarificationResponse = context.clarificationResponse && typeof context.clarificationResponse === "object"
    ? context.clarificationResponse
    : undefined;
  const executionMode = normalizeExecutionMode(context.executionMode || context.execution_mode);
  return apiRequest("/api/chat/intent", {
    method: "POST",
    body: JSON.stringify({
      message,
      ...(conversationId ? { conversationId } : {}),
      ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
      execution_mode: executionMode,
      ...(clarificationResponse ? { clarification_response: clarificationResponse } : {}),
      context: buildChatRequestContext(context),
    }),
    signal: context.signal || null,
  });
}

async function getConversations() {
  return apiRequest("/api/conversations", { method: "GET" });
}

async function createConversation(title = "New Chat", conversationId = null) {
  const requestedConversationId =
    typeof conversationId === "string" && conversationId.trim()
      ? conversationId.trim()
      : undefined;
  return apiRequest("/api/conversations", {
    method: "POST",
    body: JSON.stringify({
      title,
      ...(requestedConversationId ? { conversationId: requestedConversationId } : {}),
    }),
  });
}

async function getConversationMessages(conversationId) {
  return apiRequest(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "GET",
  });
}

async function deleteConversation(conversationId) {
  return apiRequest(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
  });
}

async function updateConversationTitle(conversationId, title) {
  return apiRequest(`/api/conversations/${encodeURIComponent(conversationId)}/title`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

async function syncChatMessages(payload = {}) {
  return apiRequest("/api/chat/sync", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function getMemories() {
  return apiRequest("/api/memories", { method: "GET" });
}

async function deleteMemoryAPI(memoryId) {
  return apiRequest(`/api/memories/${encodeURIComponent(memoryId)}`, {
    method: "DELETE",
  });
}

async function sendSelectionMessage(payload, signal = null) {
  return apiRequest("/api/chat/selection", {
    method: "POST",
    body: JSON.stringify(payload),
    signal,
  });
}

async function classifyMemory(message, recentMessages = []) {
  return apiRequest("/api/memory/classify", {
    method: "POST",
    body: JSON.stringify({ message, recent_messages: recentMessages }),
  });
}

async function compressMemories(memories) {
  return apiRequest("/api/memory/compress", {
    method: "POST",
    body: JSON.stringify({ memories }),
  });
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append("file", file);
  const url = `${API_BASE}/api/files/upload`;
  const headers = await buildAuthHeaders();
  const response = await fetch(url, { method: "POST", body: formData, headers });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw createApiError(response, errorData, `Upload failed: ${response.status}`);
  }
  return response.json();
}

async function subscribeFileUpdates(callbacks = {}, signal = null) {
  const url = `${API_BASE}/api/files/updates`;
  const headers = await buildAuthHeaders();
  const response = await fetch(url, { method: "GET", headers, signal });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw createApiError(response, errorData, `File update stream failed: ${response.status}`);
  }
  if (!response.body) {
    throw new Error("File update stream missing response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function processLines(lines) {
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed?.type === "file_analysis") {
          callbacks.onEvent?.(parsed);
        }
      } catch {
        // ignore malformed SSE frames
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer) {
        const flushed = buffer.split("\n");
        buffer = "";
        processLines(flushed);
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    processLines(lines);
  }
  callbacks.onClose?.();
}

  async function generateImage(prompt, options = {}) {
    const conversationId =
      typeof options.conversationId === "string" && options.conversationId.trim()
        ? options.conversationId.trim()
        : undefined;
    const clientRequestId =
      typeof options.clientRequestId === "string" && options.clientRequestId.trim()
        ? options.clientRequestId.trim()
        : undefined;
    const executionMode = normalizeExecutionMode(options.executionMode || options.execution_mode);
    return apiRequest("/api/images/generate", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        style: options.style,
        size: options.size,
        execution_mode: executionMode,
        ...(conversationId ? { conversationId } : {}),
        ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
        context: buildChatRequestContext(options.context || {}),
      }),
    });
  }

async function storeImage(chatId, imageData, prompt, provider) {
  return apiRequest("/api/images/store", {
    method: "POST",
    body: JSON.stringify({ chat_id: chatId, image_data: imageData, prompt, provider }),
  });
}

async function getChatImages(chatId) {
  return apiRequest(`/api/images/chat/${encodeURIComponent(chatId)}`);
}

async function getImageQuota() {
  return apiRequest("/api/images/quota");
}

async function getGeneratedFileAccessUrl(fileId, mode = "download") {
  const endpoint = mode === "preview" ? "preview-url" : "download";
  return apiRequest(`/api/generated-files/${encodeURIComponent(fileId)}/${endpoint}`, { method: "GET" });
}

async function updateGeneratedHtmlFile(fileId, html, version) {
  return apiRequest(`/api/generated-files/${encodeURIComponent(fileId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      html,
      ...(version ? { version } : {}),
    }),
  });
}

async function getProfile() {
  return apiRequest("/api/profile", { method: "GET" });
}

async function updateProfile(displayName) {
  return apiRequest("/api/profile", {
    method: "PATCH",
    body: JSON.stringify({ display_name: displayName }),
  });
}

async function generateTitle(userMessage, assistantReply, conversationId) {
  return apiRequest("/api/chat/title", {
    method: "POST",
    body: JSON.stringify({ userMessage, assistantReply, conversationId }),
  });
}

async function getHealth() { return apiRequest("/api/health"); }
async function getConfigAPI() { return apiRequest("/api/config"); }

window.SentIQAPI = {
  sendMessage, sendMessageStream, getChatIntent, classifyMemory, compressMemories,
  sendSelectionMessage, uploadFile, subscribeFileUpdates, generateImage, storeImage, getChatImages, getImageQuota, generateTitle,
  getGeneratedFileAccessUrl, updateGeneratedHtmlFile,
  getConversations, createConversation, getConversationMessages, deleteConversation, updateConversationTitle, syncChatMessages,
  getMemories, deleteMemory: deleteMemoryAPI, getProfile, updateProfile,
  getHealth, getConfig: getConfigAPI,
};
