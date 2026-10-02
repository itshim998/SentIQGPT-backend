import { CdpClient, getSentIqTabDebuggerUrl } from "./cdpClient.mjs";

async function main() {
  const wsUrl = await getSentIqTabDebuggerUrl();
  const client = new CdpClient(wsUrl);
  await client.connect();
  const res = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.getElementById("chat-messages");
      const messages = Array.from(document.querySelectorAll("#chat-messages > *"));
      return {
        text: el ? el.innerText : "none",
        childrenCount: messages.length,
        classes: messages.map(m => m.className)
      };
    })()`,
    returnByValue: true
  });
  console.log("Chat Messages State:\n", JSON.stringify(res.result.value, null, 2));
  client.close();
}

main().catch(console.error);
