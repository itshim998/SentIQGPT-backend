import { execSync } from "node:child_process";
import { CdpClient, getSentIqTabDebuggerUrl } from "./cdpClient.mjs";

export function getAzureLogs(tail = 100) {
  try {
    const raw = execSync(`az containerapp logs show -n sentiqgpt-backend -g rg-sentiqgpt-prod --tail ${tail} --format json --follow false`, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60000,
    });
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => (typeof item === "string" ? item : (item.Log || item.message || JSON.stringify(item)))).join("\n");
    }
    return raw;
  } catch (err) {
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => (typeof item === "string" ? item : (item.Log || item.message || JSON.stringify(item)))).join("\n");
        }
      } catch {}
      return String(err.stdout);
    }
    return `[Azure Log Fetch Error]: ${err.message}`;
  }
}

export class SentIqTestHarness {
  constructor() {
    this.client = null;
    this.networkEvents = [];
    this.sseEvents = [];
    this.consoleLogs = [];
    this.runtimeExceptions = [];
    this.lastUploadResponses = [];
    this.uploadPromise = null;
    this.uploadResolve = null;
  }

  async init() {
    const wsUrl = await getSentIqTabDebuggerUrl();
    this.client = new CdpClient(wsUrl);
    await this.client.connect();

    await this.client.send("DOM.enable");
    await this.client.send("Runtime.enable");
    await this.client.send("Network.enable");

    this.client.on("Runtime.consoleAPICalled", (params) => {
      const text = params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      const entry = { type: params.type, text, time: new Date().toISOString() };
      this.consoleLogs.push(entry);
      if (params.type === "error" || params.type === "warning" || text.includes("error") || text.includes("Error") || text.includes("[UI]")) {
        console.log(`[Browser Console ${params.type}]`, text.slice(0, 240));
      }
    });

    this.client.on("Runtime.exceptionThrown", (params) => {
      const desc = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text;
      const entry = { exception: desc, details: params.exceptionDetails, time: new Date().toISOString() };
      this.runtimeExceptions.push(entry);
      console.log(`[Browser Unhandled Exception]`, desc);
    });

    this.client.on("Network.requestWillBeSent", (params) => {
      if (params.request.url.includes("/api/")) {
        let postData = params.request.postData;
        const entry = {
          type: "request",
          requestId: params.requestId,
          url: params.request.url,
          method: params.request.method,
          postData,
          time: new Date().toISOString(),
        };
        this.networkEvents.push(entry);
        console.log(`[Browser Network ->] ${params.request.method} ${params.request.url}`);
        if (params.request.url.includes("/api/chat/stream") && postData) {
          try {
            const parsed = JSON.parse(postData);
            console.log(`  -> chat payload summary: message="${parsed.message?.slice(0, 60)}", mode=${parsed.execution_mode}, contextKeys=${Object.keys(parsed.context || {})}`);
            if (parsed.context?.visual_assets) {
              console.log(`  -> visual_assets in context:`, JSON.stringify(parsed.context.visual_assets));
            }
            if (parsed.context?.session_files) {
              console.log(`  -> session_files in context:`, JSON.stringify(parsed.context.session_files.map(f => ({ name: f.filename, id: f.id, visual_required: f.visual_required }))));
            }
          } catch {}
        }
      }
    });

    this.client.on("Network.responseReceived", (params) => {
      if (params.response.url.includes("/api/")) {
        const entry = {
          type: "response",
          requestId: params.requestId,
          url: params.response.url,
          status: params.response.status,
          mimeType: params.response.mimeType,
          time: new Date().toISOString(),
        };
        this.networkEvents.push(entry);
        console.log(`[Browser Network <-] ${params.response.status} ${params.response.url}`);
        if (params.response.url.includes("/api/files/upload")) {
          this.lastUploadResponses.push(entry);
          if (this.uploadResolve) this.uploadResolve(entry);
        }
      }
    });

    this.client.on("Network.eventSourceMessageReceived", (params) => {
      this.sseEvents.push({
        data: params.data,
        eventName: params.eventName,
        time: new Date().toISOString(),
      });
      if (
        params.data.includes("tool_") ||
        params.data.includes("image_input") ||
        params.data.includes("generation_") ||
        params.data.includes("structured_") ||
        params.data.includes("error")
      ) {
        console.log(`[Browser SSE Frame]`, params.data.slice(0, 200));
      }
    });

    console.log("[TestHarness] Initialized & attached to SentIQ Chat page.");
  }

  async startFreshChat() {
    console.log("\n[TestHarness] Starting fresh chat...");
    this.networkEvents = [];
    this.sseEvents = [];
    this.runtimeExceptions = [];
    this.lastUploadResponses = [];

    await this.client.send("Runtime.evaluate", {
      expression: `(() => {
        document.querySelectorAll(".composer-attachment-remove").forEach(b => b.click());
        const chatInput = document.getElementById("chat-input");
        if (chatInput) chatInput.value = "";
        const newChatBtn = document.getElementById("new-chat-btn") || Array.from(document.querySelectorAll("button")).find(b => b.innerText.includes("New Chat"));
        if (newChatBtn) newChatBtn.click();
      })()`,
    });

    await new Promise((r) => setTimeout(r, 1500));
  }

  async uploadFiles(filePaths) {
    console.log(`\n[TestHarness] Uploading ${filePaths.length} file(s):`, filePaths);
    this.lastUploadResponses = [];
    let resolveFn;
    this.uploadPromise = new Promise((resolve) => { resolveFn = resolve; });
    this.uploadResolve = resolveFn;

    const doc = await this.client.send("DOM.getDocument");
    const nodeRes = await this.client.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: "#file-input",
    });

    await this.client.send("DOM.setFileInputFiles", {
      nodeId: nodeRes.nodeId,
      files: filePaths,
    });

    await this.client.send("Runtime.evaluate", {
      expression: `document.getElementById("file-input").dispatchEvent(new Event("change", { bubbles: true }));`,
    });

    console.log("[TestHarness] Waiting for upload responses and chip ready state...");
    let allReady = false;
    let chipStates = [];

    const startTime = Date.now();
    while (Date.now() - startTime < 40000) {
      await new Promise((r) => setTimeout(r, 600));
      const evalRes = await this.client.send("Runtime.evaluate", {
        expression: `(() => {
          const items = Array.from(document.querySelectorAll(".composer-attachment"));
          return items.map(item => ({
            id: item.dataset.attachmentId || item.getAttribute("data-attachment-id"),
            state: item.dataset.attachmentState || item.getAttribute("data-attachment-state"),
            name: item.querySelector(".composer-attachment-name")?.innerText || "",
            statusText: item.querySelector(".composer-attachment-status")?.innerText || ""
          }));
        })()`,
        returnByValue: true,
      });

      chipStates = evalRes.result.value || [];
      if (chipStates.length >= filePaths.length && chipStates.every((c) => c.state === "ready")) {
        allReady = true;
        break;
      }
    }

    console.log("[TestHarness] Composer Attachment Chips:", JSON.stringify(chipStates, null, 2));
    if (!allReady) {
      throw new Error(`Upload failed or timed out: ${JSON.stringify(chipStates)}`);
    }
    return chipStates;
  }

  async askQuestion(questionText) {
    console.log(`\n[TestHarness] Asking: "${questionText}"`);
    this.sseEvents = []; // reset turn SSE
    this.runtimeExceptions = [];

    await this.client.send("Runtime.evaluate", {
      expression: `(() => {
        const chatInput = document.getElementById("chat-input");
        chatInput.value = ${JSON.stringify(questionText)};
        chatInput.dispatchEvent(new Event("input", { bubbles: true }));
      })()`,
    });

    await new Promise((r) => setTimeout(r, 400));

    await this.client.send("Runtime.evaluate", {
      expression: `(() => {
        const sendBtn = document.getElementById("send-btn");
        sendBtn.click();
      })()`,
    });
  }

  async waitForStreamingCompletion(timeoutSeconds = 90) {
    console.log(`[TestHarness] Waiting for streaming completion (max ${timeoutSeconds}s)...`);
    const start = Date.now();
    let completed = false;
    let lastMsgData = null;

    while (Date.now() - start < timeoutSeconds * 1000) {
      await new Promise((r) => setTimeout(r, 1000));

      const statusRes = await this.client.send("Runtime.evaluate", {
        expression: `(() => {
          const sendBtn = document.getElementById("send-btn");
          const isStreaming = sendBtn?.classList.contains("is-stop") || Boolean(document.querySelector(".is-streaming"));
          const messages = Array.from(document.querySelectorAll("#chat-messages .message"));
          const assistantMsgs = messages.filter(m => m.classList.contains("assistant") || m.getAttribute("data-role") === "assistant");
          const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
          const hasErrorWrap = Boolean(lastAssistant?.querySelector(".message-error-wrap, .message-error-text, .failure-recovery-panel"));
          const errorText = lastAssistant?.querySelector(".message-error-text")?.innerText || "";
          const thinkingEl = lastAssistant?.querySelector(".thinking-content, .thinking-block");
          const bodyEl = lastAssistant?.querySelector(".message-content, .message-body, .prose");

          return {
            isStreaming,
            totalMessages: messages.length,
            assistantCount: assistantMsgs.length,
            lastAssistantHeader: lastAssistant?.querySelector(".message-sender, .message-header")?.innerText || "",
            lastAssistantText: bodyEl ? bodyEl.innerText.trim() : (lastAssistant ? lastAssistant.innerText.trim() : ""),
            thinkingText: thinkingEl ? thinkingEl.innerText.trim() : "",
            hasErrorWrap,
            errorText,
            allAssistantMessages: assistantMsgs.map((m, idx) => ({
              idx,
              header: m.querySelector(".message-sender, .message-header")?.innerText || "",
              text: m.querySelector(".message-content, .message-body")?.innerText?.trim() || m.innerText?.trim() || "",
              hasError: Boolean(m.querySelector(".message-error-wrap, .message-error-text, .failure-recovery-panel"))
            }))
          };
        })()`,
        returnByValue: true,
      });

      lastMsgData = statusRes.result.value;
      if (!lastMsgData.isStreaming && lastMsgData.assistantCount > 0 && lastMsgData.lastAssistantText.length > 5) {
        completed = true;
        break;
      }
    }

    // Wait an extra 1.5s to see if post-stream error handlers (like the ReferenceError) fire!
    await new Promise((r) => setTimeout(r, 1500));

    const finalDomCheck = await this.client.send("Runtime.evaluate", {
      expression: `(() => {
        const messages = Array.from(document.querySelectorAll("#chat-messages .message"));
        return messages.map((m, idx) => ({
          idx,
          role: m.classList.contains("user") ? "user" : "assistant",
          header: m.querySelector(".message-sender, .message-header")?.innerText || "",
          text: m.querySelector(".message-content, .message-body")?.innerText?.trim() || m.innerText?.trim() || "",
          hasError: Boolean(m.querySelector(".message-error-wrap, .message-error-text, .failure-recovery-panel"))
        }));
      })()`,
      returnByValue: true,
    });

    return {
      completed,
      ...lastMsgData,
      finalDomMessages: finalDomCheck.result.value,
      runtimeExceptions: [...this.runtimeExceptions],
      sseCount: this.sseEvents.length,
    };
  }

  close() {
    if (this.client) this.client.close();
  }
}
