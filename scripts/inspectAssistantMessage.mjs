import { CdpClient, getSentIqTabDebuggerUrl } from "./cdpClient.mjs";

async function main() {
  const wsUrl = await getSentIqTabDebuggerUrl();
  const client = new CdpClient(wsUrl);
  await client.connect();

  const res = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const msgs = Array.from(document.querySelectorAll("#chat-messages .message"));
      return msgs.map((m, idx) => ({
        index: idx,
        className: m.className,
        role: m.getAttribute("data-role") || (m.classList.contains("user") ? "user" : m.classList.contains("assistant") ? "assistant" : "unknown"),
        innerHTML: m.innerHTML.slice(0, 500),
        innerText: m.innerText
      }));
    })()`,
    returnByValue: true
  });

  console.log("Messages in DOM:\n", JSON.stringify(res.result.value, null, 2));

  client.close();
}

main().catch(console.error);
