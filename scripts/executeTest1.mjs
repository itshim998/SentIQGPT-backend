import { execSync } from "node:child_process";
import { CdpClient, getSentIqTabDebuggerUrl } from "./cdpClient.mjs";

const RESUME_FILE = "C:\\Users\\Sounak\\Downloads\\Sounak_Poddar_Resume.pdf.pdf";

export function getAzureLogs(tail = 60) {
  try {
    const cmd = `az containerapp logs show -n sentiqgpt-backend -g rg-sentiqgpt-prod --tail ${tail} --format text --follow false`;
    return execSync(cmd, {
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      timeout: 45000,
    });
  } catch (err) {
    return `Failed to fetch Azure logs: ${err.message}`;
  }
}

async function main() {
  console.log("================================================================================");
  console.log("EXECUTING TEST 1: Selectable PDF Baseline");
  console.log("Target File:", RESUME_FILE);
  console.log("Question: What is my GPA?");
  console.log("================================================================================");

  const wsUrl = await getSentIqTabDebuggerUrl();
  const client = new CdpClient(wsUrl);
  await client.connect();

  await client.send("DOM.enable");
  await client.send("Runtime.enable");
  await client.send("Network.enable");

  const networkEvents = [];
  const sseEvents = [];
  let uploadCompletedPromise = null;
  let uploadResolve = null;

  client.on("Runtime.consoleAPICalled", (params) => {
    const text = params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (text.includes("[Upload]") || text.includes("[File") || text.includes("[Chat]") || text.includes("error") || text.includes("Error") || text.includes("GPA")) {
      console.log(`[Browser Console ${params.type}]`, text.slice(0, 200));
    }
  });

  client.on("Network.requestWillBeSent", (params) => {
    if (params.request.url.includes("/api/")) {
      networkEvents.push({ type: "request", url: params.request.url, method: params.request.method, time: new Date().toISOString() });
      console.log(`[Browser Network] -> ${params.request.method} ${params.request.url}`);
    }
  });

  client.on("Network.responseReceived", (params) => {
    if (params.response.url.includes("/api/")) {
      networkEvents.push({ type: "response", url: params.response.url, status: params.response.status, time: new Date().toISOString() });
      console.log(`[Browser Network] <- ${params.response.status} ${params.response.url}`);
      if (params.response.url.includes("/api/files/upload") && uploadResolve) {
        uploadResolve(params.response);
      }
    }
  });

  client.on("Network.eventSourceMessageReceived", (params) => {
    try {
      sseEvents.push({ data: params.data, eventName: params.eventName, time: new Date().toISOString() });
      if (params.data.includes("generation_") || params.data.includes("tool_") || params.data.includes("structured_") || params.data.includes("token")) {
        console.log(`[Browser SSE Frame]`, params.data.slice(0, 180));
      }
    } catch {}
  });

  // 1. Clean previous composer state & Click New Chat
  console.log("\n[Step 1] Cleaning previous attachments and starting fresh chat...");
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      document.querySelectorAll(".composer-attachment-remove").forEach(b => b.click());
      const chatInput = document.getElementById("chat-input");
      if (chatInput) chatInput.value = "";
      const newChatBtn = document.getElementById("new-chat-btn") || Array.from(document.querySelectorAll("button")).find(b => b.innerText.includes("New Chat"));
      if (newChatBtn) newChatBtn.click();
    })()`,
  });
  await new Promise((r) => setTimeout(r, 1000));

  // 2. Prepare upload promise and attach file
  uploadCompletedPromise = new Promise((resolve) => { uploadResolve = resolve; });

  console.log("\n[Step 2] Attaching Resume PDF to composer...");
  const doc = await client.send("DOM.getDocument");
  const nodeRes = await client.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "#file-input",
  });

  await client.send("DOM.setFileInputFiles", {
    nodeId: nodeRes.nodeId,
    files: [RESUME_FILE],
  });

  await client.send("Runtime.evaluate", {
    expression: `document.getElementById("file-input").dispatchEvent(new Event("change", { bubbles: true }));`,
  });

  // 3. Wait for the upload network response AND ready state
  console.log("[Step 3] Waiting for upload HTTP response and Ready chip...");
  await uploadCompletedPromise;
  console.log("Upload HTTP response received!");

  let attachmentReady = false;
  let attachmentState = {};
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const check = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const item = document.querySelector(".composer-attachment");
        return {
          exists: Boolean(item),
          state: item?.getAttribute("data-attachment-state"),
          name: item?.querySelector(".composer-attachment-name")?.innerText,
          statusText: item?.querySelector(".composer-attachment-status")?.innerText
        };
      })()`,
      returnByValue: true,
    });
    attachmentState = check.result.value;
    if (attachmentState.state === "ready") {
      attachmentReady = true;
      break;
    }
  }

  console.log("Attachment status:", attachmentState);
  if (!attachmentReady) {
    throw new Error(`Attachment did not reach ready: ${JSON.stringify(attachmentState)}`);
  }

  // 4. Type Question
  console.log("\n[Step 4] Typing question: 'What is my GPA?'");
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const chatInput = document.getElementById("chat-input");
      chatInput.value = "What is my GPA?";
      chatInput.dispatchEvent(new Event("input", { bubbles: true }));
    })()`,
  });

  await new Promise((r) => setTimeout(r, 500));

  // 5. Send Question
  console.log("\n[Step 5] Clicking Send button...");
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const sendBtn = document.getElementById("send-btn");
      sendBtn.click();
    })()`,
  });

  // 6. Wait for Generation to Complete
  console.log("[Step 6] Streaming generation in progress...");
  let completed = false;
  let finalAnswer = "";
  let thinkingContent = "";

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const genCheck = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const sendBtn = document.getElementById("send-btn");
        const isStreaming = sendBtn?.classList.contains("is-stop") || Boolean(document.querySelector(".is-streaming"));
        const messages = Array.from(document.querySelectorAll("#chat-messages .message-bubble.message-assistant, #chat-messages [data-message-role='assistant']"));
        const lastMsg = messages[messages.length - 1];
        const thinkingEl = lastMsg?.querySelector(".thinking-content, .thinking-block");
        const bodyEl = lastMsg?.querySelector(".message-content, .message-body, .prose");
        return {
          isStreaming,
          messageCount: messages.length,
          lastMsgText: lastMsg ? lastMsg.innerText.trim() : "",
          thinkingText: thinkingEl ? thinkingEl.innerText.trim() : "",
          bodyText: bodyEl ? bodyEl.innerText.trim() : (lastMsg ? lastMsg.innerText.trim() : "")
        };
      })()`,
      returnByValue: true,
    });

    const val = genCheck.result.value;
    if (!val.isStreaming && val.messageCount > 0 && val.bodyText.length > 5) {
      completed = true;
      finalAnswer = val.bodyText;
      thinkingContent = val.thinkingText;
      break;
    }
  }

  console.log("\n================================================================================");
  console.log("TEST 1 BROWSER RESULT:");
  console.log("Streaming completed normally:", completed);
  console.log("Thinking Content:", thinkingContent ? thinkingContent.slice(0, 300) : "None");
  console.log("Final Answer:\n", finalAnswer);
  console.log("================================================================================");

  // 7. Verify Answer Correctness
  const hasGpa804 = /8\.04/i.test(finalAnswer);
  const mentionsRcc = /RCCIIT|RCC|College|University|Technology/i.test(finalAnswer);
  console.log(`Contains 8.04 CGPA: ${hasGpa804}`);
  console.log(`Contains Institute/College context: ${mentionsRcc}`);

  // 8. Correlate with Azure Backend Logs
  console.log("\n[Step 7] Correlating with Azure Container Apps backend logs...");
  const azureLogs = getAzureLogs(80);
  console.log("\n--- AZURE CONTAINER BACKEND LOGS (LATEST) ---");
  const relevantLines = azureLogs
    .split("\n")
    .filter((l) => l.includes("sentiq") || l.includes("image_input") || l.includes("source_retrieval") || l.includes("context_budget") || l.includes("model") || l.includes("generation"))
    .slice(-30);
  console.log(relevantLines.join("\n") || "No filtered lines; full snippet:\n" + azureLogs.slice(-1500));

  const imageInputInvoked = azureLogs.includes("image_input") || sseEvents.some((e) => e.data.includes("image_input"));
  console.log(`\nVisual tool 'image_input' invoked in Test 1: ${imageInputInvoked} (Expected: FALSE)`);

  const passed = completed && hasGpa804 && !imageInputInvoked;
  console.log("\n>>> TEST 1 RESULT:", passed ? "PASS" : "FAIL");
  console.log("================================================================================");

  client.close();
}

main().catch(console.error);
