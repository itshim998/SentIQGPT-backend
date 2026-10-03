import { CdpClient, getSentIqTabDebuggerUrl } from "./cdpClient.mjs";

async function main() {
  const ws = await getSentIqTabDebuggerUrl();
  const c = new CdpClient(ws);
  await c.connect();
  const res = await c.send("Runtime.evaluate", {
    expression: `(() => {
      const messages = Array.from(document.querySelectorAll("#chat-messages .message"));
      return messages.map((m, idx) => ({
        idx,
        role: m.classList.contains("user") ? "user" : "assistant",
        text: (m.querySelector(".message-content, .message-body")?.innerText || m.innerText || "").slice(0, 200)
      }));
    })()`,
    returnByValue: true,
  });
  console.log("Current DOM messages count:", res.result.value?.length);
  console.log(JSON.stringify(res.result.value, null, 2));
  c.close();
}

main().catch(console.error);
