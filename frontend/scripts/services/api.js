// ================================================================
// 3. API Client
// ================================================================
import { PRODUCT_NAME, STORAGE_KEYS, LEGACY_STORAGE_KEYS } from "../shared/brand.js";
import { PROFILE_NAME_REQUIRED_EVENT } from "../shared/events.js";
import { SENTIQ_API_BASE } from "../config.js";

const API_BASE = SENTIQ_API_BASE;
const ANONYMOUS_ID_KEY = STORAGE_KEYS.anonymousQuotaId;
const LEGACY_ANONYMOUS_ID_KEY = LEGACY_STORAGE_KEYS.anonymousQuotaId;

function createAnonymousId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function getAnonymousId() {
  try {
    const existing = localStorage.getItem(ANONYMOUS_ID_KEY);
    if (existing && existing.length <= 96) return existing;
    const legacy = localStorage.getItem(LEGACY_ANONYMOUS_ID_KEY);
    if (legacy && legacy.length <= 96) {
      localStorage.setItem(ANONYMOUS_ID_KEY, legacy);
      return legacy;
    }
    const created = createAnonymousId();
    localStorage.setItem(ANONYMOUS_ID_KEY, created);
    return created;
  } catch {
    return createAnonymousId();
  }
}

async function buildAuthHeaders(baseHeaders = {}) {
  const headers = { ...baseHeaders };
  headers["X-SentIQ-Anonymous-Id"] = getAnonymousId();
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
  const internalMessage = errorData?.error || fallbackMessage || `Request failed: ${response.status}`;
  const error = new Error(internalMessage);
  error.status = response.status;
  error.code = typeof errorData?.code === "string" ? errorData.code : "";
  error.requiresName = Boolean(errorData?.requires_name);
  error.requires_name = Boolean(errorData?.requires_name);
  error.response = response;
  error.details = errorData;
  error.internalMessage = internalMessage;
  error.message = (errorData?.type === "quota_exceeded" || errorData?.code === "quota_exceeded") && errorData?.error
    ? errorData.error
    : (window.SentIQErrors?.getSafeErrorMessage?.(error) || `${PRODUCT_NAME} could not finish that action. Please try again.`);
  if (error.code === "profile_name_required" || error.requiresName || error.requires_name) {
    dispatchProfileNameRequired({
      endpoint: response.url,
      status: response.status,
      message: error.message,
    });
  }
  return error;
}

async function apiRequest(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = await buildAuthHeaders({ "Content-Type": "application/json", ...(options.headers || {}) });
  const config = { ...options, headers };
  if (typeof fetch !== "function") {
    const error = new Error("Fetch is unavailable.");
    error.code = "browser_feature_blocked";
    throw error;
  }
  const response = await fetch(url, config);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw createApiError(response, errorData, `Request failed: ${response.status}`);
  }
  return response.json();
}

function canStreamResponses() {
  return typeof fetch === "function" &&
    typeof ReadableStream === "function" &&
    typeof TextDecoder === "function";
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
  const generationSessionId =
    typeof context.generation_session_id === "string" && context.generation_session_id.trim()
      ? context.generation_session_id.trim()
      : typeof context.generationSessionId === "string" && context.generationSessionId.trim()
        ? context.generationSessionId.trim()
        : undefined;
  const executionMode = normalizeExecutionMode(context.executionMode || context.execution_mode);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message,
      ...(conversationId ? { conversationId } : {}),
      ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
      ...(generationSessionId ? { generation_session_id: generationSessionId } : {}),
      execution_mode: executionMode,
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
  if (!response.body?.getReader || typeof TextDecoder !== "function") {
    const error = new Error("Streaming response support is unavailable.");
    error.code = "browser_feature_blocked";
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let tokensReceived = false;
  let interrupted = false;
  let terminalError = null;
  let structuredReceived = false;
  let doneReceived = false;

  function processSseLines(lines) {
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") {
        doneReceived = true;
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
        else if (["tool_selected", "tool_started", "tool_result", "tool_error"].includes(parsed.type) && parsed.tool) {
          if (callbacks.onToolLifecycle) callbacks.onToolLifecycle(parsed);
          if (parsed.type === "tool_result" && parsed.tool === "image_input") {
            if (callbacks.onImageInput) callbacks.onImageInput(parsed.result || parsed);
          }
        }
        else if (parsed.type === "image_input") {
          if (callbacks.onImageInput) callbacks.onImageInput(parsed.image_input || parsed);
        }
        else if (parsed.type === "websurf_sources" && parsed.web_search) {
          if (callbacks.onWebSurfSources) callbacks.onWebSurfSources(parsed.web_search, parsed);
        }
        else if (parsed.type === "websurf_complete" && parsed.web_search) {
          if (callbacks.onWebSurfComplete) callbacks.onWebSurfComplete(parsed, parsed.web_search);
        }
        else if (parsed.type === "memory" && parsed.memory) { if (callbacks.onMemory) callbacks.onMemory(parsed.memory); }
        else if (parsed.type === "sync" && parsed.sync) { if (callbacks.onSync) callbacks.onSync(parsed.sync, parsed.degraded || null); }
        else if (parsed.type === "error") {
          terminalError = new Error(parsed.error);
          terminalError.code = typeof parsed.code === "string" ? parsed.code : "";
          terminalError.details = parsed;
          interrupted = tokensReceived;
          if (callbacks.onError) callbacks.onError(terminalError, { tokensReceived, interrupted });
          return true;
        }
      } catch { /* ignore malformed SSE */ }
    }
    return false;
  }

  try {
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
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (!tokensReceived) throw error;
    terminalError = error instanceof Error ? error : new Error("Response interrupted.");
    terminalError.code = "response_interrupted";
    interrupted = true;
    callbacks.onError?.(terminalError, { tokensReceived: true, interrupted: true });
  }
  if (!tokensReceived && !structuredReceived && !terminalError) {
    terminalError = new Error("The response did not complete. Please retry.");
    if (callbacks.onError) callbacks.onError(terminalError, { tokensReceived: false, interrupted: false });
    throw terminalError;
  }
  if (!doneReceived && !structuredReceived && !terminalError) {
    terminalError = new Error("Response interrupted before completion.");
    terminalError.code = "response_interrupted";
    interrupted = tokensReceived;
    if (callbacks.onError) callbacks.onError(terminalError, { tokensReceived, interrupted });
  }
  if (terminalError && !tokensReceived) {
    throw terminalError;
  }
  if (!interrupted && (doneReceived || structuredReceived)) {
    if (callbacks.onDone) callbacks.onDone();
    window.dispatchEvent(new CustomEvent("sentiq-billing-refresh"));
  }
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
  const generationSessionId =
    typeof context.generation_session_id === "string" && context.generation_session_id.trim()
      ? context.generation_session_id.trim()
      : typeof context.generationSessionId === "string" && context.generationSessionId.trim()
        ? context.generationSessionId.trim()
        : undefined;
  const executionMode = normalizeExecutionMode(context.executionMode || context.execution_mode);
  const result = await apiRequest("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      message,
      ...(conversationId ? { conversationId } : {}),
      ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
      ...(generationSessionId ? { generation_session_id: generationSessionId } : {}),
      execution_mode: executionMode,
      context: buildChatRequestContext(context),
    }),
    signal: context.signal || null,
  });
  window.dispatchEvent(new CustomEvent("sentiq-billing-refresh"));
  return result;
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

async function clearFileSession(analysisId = "") {
  return apiRequest("/api/files/session", {
    method: "DELETE",
    body: JSON.stringify(analysisId ? { analysis_id: analysisId } : {}),
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

async function editImage(request) {
  return apiRequest("/api/images/edit", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

async function saveImageAnnotation(request) {
  return apiRequest("/api/images/annotations", { method: "POST", body: JSON.stringify(request) });
}

async function getImageEditorCapabilities() {
  return apiRequest("/api/images/editor-capabilities");
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

async function getBillingPlans() {
  return apiRequest("/api/billing/plans", { method: "GET" });
}

async function getBillingMe() {
  return apiRequest("/api/billing/me", { method: "GET" });
}

async function getBillingUsage() {
  return apiRequest("/api/billing/usage", { method: "GET" });
}

async function startBillingCheckout(planCode) {
  return apiRequest("/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ plan_code: planCode }),
  });
}

async function verifyBillingCheckout(payload) {
  return apiRequest("/api/billing/verify", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

async function cancelBillingSubscription() {
  return apiRequest("/api/billing/cancel", { method: "POST", body: JSON.stringify({}) });
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

async function deleteGeneratedFile(fileId) {
  return apiRequest(`/api/generated-files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
}

async function deleteImage(imageId) {
  return apiRequest(`/api/images/${encodeURIComponent(imageId)}`, { method: "DELETE" });
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

async function consumeDeepResearchEventStream(response, callbacks = {}) {
  if (!response.body?.getReader || typeof TextDecoder !== "function") {
    const error = new Error("Streaming response support is unavailable.");
    error.code = "browser_feature_blocked";
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines = [];
  let terminalReceived = false;
  let streamEnded = false;

  function dispatchSseRecord() {
    if (terminalReceived || (!eventName && dataLines.length === 0)) return terminalReceived;
    const currentEvent = eventName || "message";
    const payload = dataLines.join("\n").trim();
    eventName = "";
    dataLines = [];

    if (currentEvent === "done" || payload === "[DONE]") {
      terminalReceived = true;
      callbacks.onDone?.();
      return true;
    }
    if (!payload) return false;

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      const error = new Error("Deep Research returned malformed stream data.");
      error.code = "stream_protocol_error";
      throw error;
    }

    callbacks.onEvent?.(parsed);
    if (parsed.type === "init") {
      callbacks.onInit?.(parsed);
    } else if (parsed.type === "snapshot") {
      callbacks.onSnapshot?.(parsed.report || null);
    } else if (parsed.type === "progress") {
      callbacks.onProgress?.(parsed);
    } else if (parsed.type === "sources") {
      callbacks.onSources?.(Array.isArray(parsed.sources) ? parsed.sources : []);
    } else if (parsed.type === "content") {
      callbacks.onContent?.(typeof parsed.text === "string" ? parsed.text : "");
    } else if (parsed.type === "done") {
      terminalReceived = true;
      callbacks.onDone?.(parsed.report || null);
    } else if (parsed.type === "cancelled") {
      terminalReceived = true;
      callbacks.onCancelled?.(parsed.report || null);
    } else if (parsed.type === "error") {
      terminalReceived = true;
      const error = new Error(parsed.error || "Deep Research failed");
      error.code = parsed.code || "research_failed";
      if (callbacks.onFailed) callbacks.onFailed(error, parsed.report || null);
      else callbacks.onError?.(error);
    }
    return terminalReceived;
  }

  function processSseLine(rawLine) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") return dispatchSseRecord();
    if (line.startsWith(":")) return false;
    const colonIndex = line.indexOf(":");
    const field = colonIndex >= 0 ? line.slice(0, colonIndex) : line;
    let value = colonIndex >= 0 ? line.slice(colonIndex + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    return false;
  }

  function processBufferedLines(flush = false) {
    const lines = buffer.split("\n");
    const tail = lines.pop() || "";
    buffer = flush ? "" : tail;
    for (const line of lines) {
      if (processSseLine(line)) return true;
    }
    if (flush && tail) {
      if (processSseLine(tail)) return true;
    }
    return flush ? dispatchSseRecord() : false;
  }

  try {
    while (!terminalReceived) {
      const { done, value } = await reader.read();
      if (done) {
        streamEnded = true;
        buffer += decoder.decode();
        processBufferedLines(true);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      processBufferedLines(false);
    }
    if (!terminalReceived) {
      const error = new Error("Deep Research update connection ended before the task completed.");
      error.code = "stream_incomplete";
      throw error;
    }
    return { terminalReceived: true };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    callbacks.onError?.(error);
    throw error;
  } finally {
    if (terminalReceived && !streamEnded) await reader.cancel().catch(() => null);
    reader.releaseLock();
  }
}

async function sendDeepResearchStream(input, context = {}, callbacks = {}, signal = null) {
  const url = `${API_BASE}/api/deep-research/stream`;
  const headers = await buildAuthHeaders({ "Content-Type": "application/json" });
  const conversationId = typeof context.conversationId === "string" && context.conversationId.trim()
    ? context.conversationId.trim()
    : undefined;
  const clientRequestId = typeof context.clientRequestId === "string" && context.clientRequestId.trim()
    ? context.clientRequestId.trim()
    : undefined;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: input,
      conversationId,
      clientRequestId,
    }),
    signal,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw createApiError(response, errorData, `Deep Research request failed: ${response.status}`);
  }

  return consumeDeepResearchEventStream(response, callbacks);
}

async function startDeepResearch(input, context = {}) {
  return apiRequest("/api/deep-research/start", {
    method: "POST",
    body: JSON.stringify({
      prompt: input,
      conversationId: typeof context.conversationId === "string" ? context.conversationId : undefined,
      clientRequestId: typeof context.clientRequestId === "string" ? context.clientRequestId : undefined,
    }),
  });
}

async function getDeepResearchStatus(reportId) {
  return apiRequest(`/api/deep-research/${encodeURIComponent(reportId)}/status`, { method: "GET" });
}

async function subscribeDeepResearchEvents(reportId, callbacks = {}, signal = null) {
  const headers = await buildAuthHeaders();
  const response = await fetch(`${API_BASE}/api/deep-research/${encodeURIComponent(reportId)}/events`, {
    method: "GET",
    headers,
    signal,
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw createApiError(response, errorData, `Deep Research subscription failed: ${response.status}`);
  }
  return consumeDeepResearchEventStream(response, callbacks);
}

async function cancelDeepResearchReport(reportId) {
  return apiRequest(`/api/deep-research/${encodeURIComponent(reportId)}/cancel`, { method: "POST" });
}

async function getDeepResearchQuota() {
  return apiRequest("/api/deep-research/quota", { method: "GET" });
}

async function getDeepResearchReport(reportId) {
  return apiRequest(`/api/deep-research/${encodeURIComponent(reportId)}`, { method: "GET" });
}

async function exportDeepResearchReport(reportId, format) {
  const url = `${API_BASE}/api/deep-research/${encodeURIComponent(reportId)}/export?format=${encodeURIComponent(format)}`;
  const headers = await buildAuthHeaders();
  const response = await fetch(url, {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw createApiError(response, errorData, `Export failed: ${response.status}`);
  }
  return response.blob();
}

async function getLiveStatus() {
  return apiRequest("/api/live/status", { method: "GET" });
}

async function createLiveSessionToken(optionsOrId) {
  let body = {};
  if (typeof optionsOrId === "string") {
    body = { sourceConversationId: optionsOrId, conversationId: optionsOrId };
  } else if (optionsOrId && typeof optionsOrId === "object") {
    body = {
      sourceConversationId: optionsOrId.sourceConversationId || optionsOrId.conversationId,
      conversationId: optionsOrId.conversationId || optionsOrId.sourceConversationId,
    };
  }
  return apiRequest("/api/live/session-token", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function markLiveSessionStarted(sessionId) {
  return apiRequest(`/api/live/session/${encodeURIComponent(sessionId)}/started`, {
    method: "POST",
    body: "{}",
  });
}

async function commitLiveSession(sessionId, payload, options = {}) {
  return apiRequest(`/api/live/session/${encodeURIComponent(sessionId)}/commit`, {
    method: "POST",
    body: JSON.stringify(payload || { transcript: [] }),
    keepalive: Boolean(options.keepalive),
  });
}

async function endLiveSession(sessionId, reason = "client_end", options = {}) {
  return apiRequest(`/api/live/session/${encodeURIComponent(sessionId)}/end`, {
    method: "POST",
    body: JSON.stringify({ reason }),
    keepalive: Boolean(options.keepalive),
  });
}

async function reportLiveSessionError(sessionId, payload = {}) {
  return apiRequest(`/api/live/session/${encodeURIComponent(sessionId)}/report-error`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function getLiveResumeToken(sessionId) {
  return apiRequest(`/api/live/session/${encodeURIComponent(sessionId)}/resume-token`, {
    method: "POST",
    body: "{}",
  });
}

window.SentIQAPI = {
  sendMessage, sendMessageStream, canStreamResponses, buildChatRequestContext, classifyMemory, compressMemories,
  sendSelectionMessage, uploadFile, subscribeFileUpdates, clearFileSession, generateImage, storeImage, getChatImages, getImageQuota, editImage, deleteImage, saveImageAnnotation, getImageEditorCapabilities, generateTitle,
  getBillingPlans, getBillingMe, getBillingUsage, startBillingCheckout, verifyBillingCheckout, cancelBillingSubscription,
  getGeneratedFileAccessUrl, updateGeneratedHtmlFile, deleteGeneratedFile,
  getConversations, createConversation, getConversationMessages, deleteConversation, updateConversationTitle, syncChatMessages,
  getMemories, deleteMemory: deleteMemoryAPI, getProfile, updateProfile,
  getHealth, getConfig: getConfigAPI,
  sendDeepResearchStream, startDeepResearch, getDeepResearchStatus, subscribeDeepResearchEvents,
  cancelDeepResearchReport, getDeepResearchQuota, getDeepResearchReport, exportDeepResearchReport,
  getLiveStatus, createLiveSessionToken, getLiveResumeToken, markLiveSessionStarted, commitLiveSession, endLiveSession, reportLiveSessionError,
};
