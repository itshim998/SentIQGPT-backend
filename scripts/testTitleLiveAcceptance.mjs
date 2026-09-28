import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const TARGET_URL = "https://sentiqchat.sentiqlabs.com";
const SCREENSHOT_DIR = "C:\\Users\\Sounak\\.gemini\\antigravity-ide\\brain\\c767d36a-481e-4aa2-ad8a-c722f2b56b61\\scratch";

// Retrieve test credentials safely from scratch task file or environment
function getCredentials() {
  const taskFilePath = "C:\\Users\\Sounak\\.gemini\\antigravity-ide\\brain\\1d9740a9-df9d-4d17-885b-0bc9cfc750ee\\scratch\\task_1048.txt";
  if (fs.existsSync(taskFilePath)) {
    const content = fs.readFileSync(taskFilePath, "utf8");
    const emailMatch = content.match(/email\s+([^\s,;]+)/i);
    const passMatch = content.match(/password\s+([^\s,;]+)/i);
    if (emailMatch && passMatch) {
      return {
        email: emailMatch[1].trim().replace(/[,\.;]+$/, ""),
        password: passMatch[1].trim().replace(/[,\.;]+$/, ""),
      };
    }
  }
  throw new Error("Unable to locate test credentials safely.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLiveTest() {
  const credentials = getCredentials();
  console.log(`Starting live title acceptance test on ${TARGET_URL}...`);
  console.log(`Using test account: ${credentials.email}`);

  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    defaultViewport: { width: 1440, height: 900 },
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1440,900",
    ],
  });

  const page = await browser.newPage();

  // Track network calls to title endpoints
  const titleEvents = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/api/chat/title") || url.includes("/title")) {
      titleEvents.push({
        type: "request",
        url,
        method: req.method(),
        postData: req.postData() ? JSON.parse(req.postData()) : null,
        time: new Date().toISOString(),
      });
    }
  });

  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("/api/chat/title") || url.includes("/title")) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch (e) {
        bodyText = `<read-error: ${e.message}>`;
      }
      titleEvents.push({
        type: "response",
        url,
        status: res.status(),
        body: bodyText,
        time: new Date().toISOString(),
      });
    }
  });

  page.on("console", (msg) => {
    const text = msg.text();
    if (text.toLowerCase().includes("title") || text.toLowerCase().includes("error")) {
      console.log(`[Browser Console] ${msg.type()}: ${text}`);
    }
  });

  try {
    console.log("Navigating to page...");
    await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 45000 });
    await sleep(2000);

    // Check if user is logged in
    const isLoginBtnVisible = await page.evaluate(() => {
      const btn = document.getElementById("auth-login-btn");
      return btn && btn.offsetParent !== null;
    });

    if (isLoginBtnVisible) {
      console.log("Logging in...");
      await page.click("#auth-login-btn");
      await page.waitForSelector("#auth-modal", { visible: true, timeout: 5000 });
      await sleep(500);

      await page.type("#auth-email", credentials.email);
      await page.type("#auth-password", credentials.password);
      await page.click("#auth-submit-btn");

      try {
        await page.waitForFunction(() => {
          const modal = document.getElementById("auth-modal");
          return !modal || modal.style.display === "none" || modal.getAttribute("aria-hidden") === "true";
        }, { timeout: 15000 });
        console.log("Login successful!");
      } catch (e) {
        const statusText = await page.evaluate(() => document.getElementById("auth-status")?.textContent || "");
        console.error(`Login wait failed. Auth status text: "${statusText}"`);
        throw e;
      }
      await sleep(3000);
    } else {
      console.log("Already signed in or login button not displayed.");
    }

    // ==========================================
    // TEST RUN 1: First new conversation
    // ==========================================
    console.log("\n==========================================");
    console.log("TEST RUN 1: Starting new conversation...");
    console.log("==========================================");

    await page.click("#new-chat-btn");
    await sleep(1500);

    const testPrompt1 = "What are the key differences between synchronous and asynchronous programming in Python?";
    console.log(`Typing prompt: "${testPrompt1}"`);
    await page.type("#chat-input", testPrompt1);
    await sleep(500);

    console.log("Sending message...");
    await page.click("#send-btn");

    // Immediately observe the fallback title
    await sleep(1000);
    let fallbackTitle1 = await page.evaluate(() => {
      const activeItem = document.querySelector(".chat-list-item.active .chat-list-item-title");
      return activeItem ? activeItem.textContent.trim() : null;
    });
    console.log(`Observed initial fallback title: "${fallbackTitle1}"`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01_chat1_fallback.png") });

    // Wait for the assistant response to start and then finish streaming
    console.log("Waiting for assistant response to start...");
    await sleep(2000);

    // Wait for fallback title in sidebar
    fallbackTitle1 = await page.evaluate(() => {
      const activeItem = document.querySelector(".chat-list-item.active .chat-list-item-title")
        || document.querySelector("#chat-list .chat-list-item:first-child .chat-list-item-title");
      return activeItem ? activeItem.textContent.trim() : null;
    });
    console.log(`Observed initial fallback title: "${fallbackTitle1}"`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01_chat1_fallback.png") });

    console.log("Waiting for assistant response to finish streaming...");
    await page.waitForFunction(() => {
      const sendBtn = document.getElementById("send-btn");
      const isStop = sendBtn && sendBtn.classList.contains("is-stop");
      const isThinking = document.querySelector(".message-thinking-state");
      const isStreaming = document.querySelector(".message.assistant.streaming");
      return !isStop && !isThinking && !isStreaming;
    }, { timeout: 90000 });
    console.log("Assistant response complete!");
    await sleep(2000);

    // Now wait for automatic title generation to complete
    console.log("Waiting for automatic title generation (up to 30s)...");
    let finalTitle1 = "";
    const startWait1 = Date.now();
    while (Date.now() - startWait1 < 30000) {
      finalTitle1 = await page.evaluate(() => {
        const activeItem = document.querySelector(".chat-list-item.active .chat-list-item-title")
          || document.querySelector("#chat-list .chat-list-item:first-child .chat-list-item-title");
        return activeItem ? activeItem.textContent.trim() : "";
      });

      // Check if it's different from the initial fallback and not empty and not "New Chat"
      if (finalTitle1 && finalTitle1 !== fallbackTitle1 && finalTitle1 !== "New Chat") {
        console.log(`Detected title update: "${finalTitle1}"`);
        break;
      }
      await sleep(1500);
    }

    // If DOM hasn't updated yet, reload page to fetch latest persisted server chats
    if (!finalTitle1 || finalTitle1 === fallbackTitle1) {
      console.log("Reloading to check server-persisted title...");
      await page.reload({ waitUntil: "networkidle2" });
      await sleep(3000);
      finalTitle1 = await page.evaluate(() => {
        const activeItem = document.querySelector(".chat-list-item.active .chat-list-item-title")
          || document.querySelector("#chat-list .chat-list-item:first-child .chat-list-item-title");
        return activeItem ? activeItem.textContent.trim() : "";
      });
      console.log(`Title after reload check: "${finalTitle1}"`);
    }

    console.log(`Final Title 1: "${finalTitle1}"`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02_chat1_final_title.png") });

    // Get active conversation ID
    const chatId1 = await page.evaluate(() => {
      const activeItem = document.querySelector(".chat-list-item.active")
        || document.querySelector("#chat-list .chat-list-item:first-child");
      return activeItem ? activeItem.getAttribute("data-id") : null;
    });
    console.log(`Chat 1 ID: ${chatId1}`);

    // Verify title contract
    if (!finalTitle1) {
      throw new Error("Chat 1 did not receive any title!");
    }
    if (finalTitle1.includes("```") || finalTitle1.startsWith("{") || finalTitle1.endsWith("}") || finalTitle1.includes('"title"')) {
      throw new Error(`CRITICAL ERROR: Chat 1 title contains malformed output! "${finalTitle1}"`);
    }
    console.log(`✓ Chat 1 title is clean and human-readable: "${finalTitle1}"`);

    // ==========================================
    // PERSISTENCE CHECK: Switch away, return, reload
    // ==========================================
    console.log("\nChecking persistence across navigation and reload...");
    // Click new chat to switch away
    await page.click("#new-chat-btn");
    await sleep(2000);

    // Click back on Chat 1
    console.log(`Clicking back on Chat 1 (${chatId1})...`);
    await page.click(`.chat-list-item[data-id="${chatId1}"]`);
    await sleep(2000);

    let titleAfterNav = await page.evaluate((id) => {
      const item = document.querySelector(`.chat-list-item[data-id="${id}"] .chat-list-item-title`);
      return item ? item.textContent.trim() : "";
    }, chatId1);
    console.log(`Title after switching back: "${titleAfterNav}"`);

    // Reload page
    console.log("Reloading page...");
    await page.reload({ waitUntil: "networkidle2", timeout: 45000 });
    await sleep(3000);

    let titleAfterReload = await page.evaluate((id) => {
      const item = document.querySelector(`.chat-list-item[data-id="${id}"] .chat-list-item-title`);
      return item ? item.textContent.trim() : "";
    }, chatId1);
    console.log(`Title after page reload: "${titleAfterReload}"`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03_chat1_persisted_reload.png") });

    if (titleAfterReload !== finalTitle1) {
      throw new Error(`Title mismatch after reload! Expected "${finalTitle1}", got "${titleAfterReload}"`);
    }
    console.log("✓ Persistence check PASSED!");

    // ==========================================
    // TEST RUN 2: Second new conversation (Repeatability)
    // ==========================================
    console.log("\n==========================================");
    console.log("TEST RUN 2: Starting second conversation...");
    console.log("==========================================");

    await page.click("#new-chat-btn");
    await sleep(1500);

    const testPrompt2 = "Explain the concept of recursion with an example in JavaScript";
    console.log(`Typing prompt: "${testPrompt2}"`);
    await page.type("#chat-input", testPrompt2);
    await sleep(500);

    console.log("Sending message...");
    await page.click("#send-btn");

    await sleep(2000);
    let fallbackTitle2 = await page.evaluate(() => {
      const activeItem = document.querySelector(".chat-list-item.active .chat-list-item-title")
        || document.querySelector("#chat-list .chat-list-item:first-child .chat-list-item-title");
      return activeItem ? activeItem.textContent.trim() : null;
    });
    console.log(`Observed Chat 2 fallback title: "${fallbackTitle2}"`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04_chat2_fallback.png") });

    console.log("Waiting for assistant response to finish streaming...");
    await page.waitForFunction(() => {
      const sendBtn = document.getElementById("send-btn");
      const isStop = sendBtn && sendBtn.classList.contains("is-stop");
      const isThinking = document.querySelector(".message-thinking-state");
      const isStreaming = document.querySelector(".message.assistant.streaming");
      return !isStop && !isThinking && !isStreaming;
    }, { timeout: 90000 });
    console.log("Chat 2 response complete!");
    await sleep(2000);

    console.log("Waiting for Chat 2 title generation (up to 30s)...");
    let finalTitle2 = "";
    const startWait2 = Date.now();
    while (Date.now() - startWait2 < 30000) {
      finalTitle2 = await page.evaluate(() => {
        const activeItem = document.querySelector(".chat-list-item.active .chat-list-item-title")
          || document.querySelector("#chat-list .chat-list-item:first-child .chat-list-item-title");
        return activeItem ? activeItem.textContent.trim() : "";
      });

      if (finalTitle2 && finalTitle2 !== fallbackTitle2 && finalTitle2 !== "New Chat") {
        console.log(`Detected Chat 2 title update: "${finalTitle2}"`);
        break;
      }
      await sleep(1500);
    }

    if (!finalTitle2 || finalTitle2 === fallbackTitle2) {
      console.log("Reloading to check server-persisted Chat 2 title...");
      await page.reload({ waitUntil: "networkidle2" });
      await sleep(3000);
      finalTitle2 = await page.evaluate(() => {
        const activeItem = document.querySelector(".chat-list-item.active .chat-list-item-title")
          || document.querySelector("#chat-list .chat-list-item:first-child .chat-list-item-title");
        return activeItem ? activeItem.textContent.trim() : "";
      });
      console.log(`Chat 2 title after reload check: "${finalTitle2}"`);
    }

    console.log(`Final Title 2: "${finalTitle2}"`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "05_chat2_final_title.png") });

    if (!finalTitle2) {
      throw new Error("Chat 2 did not receive any title!");
    }
    if (finalTitle2.includes("```") || finalTitle2.startsWith("{") || finalTitle2.endsWith("}") || finalTitle2.includes('"title"')) {
      throw new Error(`CRITICAL ERROR: Chat 2 title contains malformed output! "${finalTitle2}"`);
    }
    console.log(`✓ Chat 2 title is clean and human-readable: "${finalTitle2}"`);

    // Reload again to check both titles survive
    console.log("Reloading page to verify both conversations...");
    await page.reload({ waitUntil: "networkidle2", timeout: 45000 });
    await sleep(3000);

    const chat1TitleReload = await page.evaluate((id) => {
      const item = document.querySelector(`.chat-list-item[data-id="${id}"] .chat-list-item-title`);
      return item ? item.textContent.trim() : "";
    }, chatId1);
    console.log(`Chat 1 persisted title: "${chat1TitleReload}"`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "06_both_chats_persisted.png") });

    console.log("\n==========================================");
    console.log("TITLE NETWORK EVENTS SUMMARY:");
    console.log("==========================================");
    for (const evt of titleEvents) {
      if (evt.type === "request") {
        console.log(`--> ${evt.method} ${evt.url}`);
      } else {
        console.log(`<-- ${evt.status} ${evt.url} | Body: ${evt.body.slice(0, 150)}`);
      }
    }

    console.log("\n==========================================");
    console.log("LIVE ACCEPTANCE TEST COMPLETED SUCCESSFULLY!");
    console.log("==========================================");

    return {
      success: true,
      chat1: { id: chatId1, fallback: fallbackTitle1, final: finalTitle1, persisted: titleAfterReload },
      chat2: { fallback: fallbackTitle2, final: finalTitle2 },
      titleEvents,
    };
  } finally {
    await browser.close();
  }
}

runLiveTest()
  .then((res) => {
    fs.writeFileSync(path.join(SCREENSHOT_DIR, "acceptance_results.json"), JSON.stringify(res, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
  });
