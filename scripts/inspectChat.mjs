import { SentIqTestHarness } from "./testHarness.mjs";

async function main() {
  const harness = new SentIqTestHarness();
  await harness.init();
  const res = await harness.client.send("Runtime.evaluate", {
    expression: `(() => {
      const messages = Array.from(document.querySelectorAll("#chat-messages .message"));
      return {
        url: window.location.href,
        chatId: window.localStorage.getItem("sentiq_active_chat_id") || "unknown",
        messageCount: messages.length,
        isStreaming: Boolean(document.querySelector(".is-streaming")),
        sendBtnClass: document.getElementById("send-btn")?.className,
        sendBtnDisabled: document.getElementById("send-btn")?.disabled,
        chatInputValue: document.getElementById("chat-input")?.value,
        recoveryPanel: Boolean(document.querySelector(".failure-recovery-panel")),
        messages: messages.map(m => ({
          role: m.getAttribute("data-role") || (m.classList.contains("user") ? "user" : "assistant"),
          text: m.innerText
        }))
      };
    })()`,
    returnByValue: true
  });
  console.log("INSPECT RESULT:", JSON.stringify(res.result.value, null, 2));
  harness.close();
}

main().catch(console.error);
