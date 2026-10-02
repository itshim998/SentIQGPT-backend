import { CdpClient, getSentIqTabDebuggerUrl } from "./cdpClient.mjs";

async function main() {
  const wsUrl = await getSentIqTabDebuggerUrl();
  console.log("Connecting to live tab ws:", wsUrl);
  const client = new CdpClient(wsUrl);
  await client.connect();

  await client.send("DOM.enable");
  await client.send("Runtime.enable");

  const evalRes = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const emailEl = document.querySelector("#account-btn") || document.querySelector(".auth-account-trigger");
      const fileInput = document.getElementById("file-input");
      const chatInput = document.getElementById("chat-input");
      return {
        title: document.title,
        url: window.location.href,
        accountText: emailEl ? emailEl.innerText.trim() : null,
        hasFileInput: Boolean(fileInput),
        hasChatInput: Boolean(chatInput)
      };
    })()`,
    returnByValue: true
  });

  console.log("Tab State:", evalRes.result.value);

  // Test DOM node resolution for #file-input
  const doc = await client.send("DOM.getDocument");
  const nodeRes = await client.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "#file-input"
  });
  console.log("File input nodeId:", nodeRes.nodeId);

  client.close();
  console.log("Probe complete!");
}

main().catch(console.error);
