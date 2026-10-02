import { CdpClient, getSentIqTabDebuggerUrl } from "./cdpClient.mjs";

async function main() {
  const wsUrl = await getSentIqTabDebuggerUrl();
  const client = new CdpClient(wsUrl);
  await client.connect();
  await client.send("Network.enable");

  let payload = null;
  client.on("Network.requestWillBeSent", (params) => {
    if (params.request.url.includes("/api/chat") && params.request.postData) {
      console.log("POST URL:", params.request.url);
      payload = params.request.postData;
      console.log("CHAT REQUEST PAYLOAD:\n", payload);
    }
  });

  // Let's ask: "Explain the XOR problem from this PDF."
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const chatInput = document.getElementById("chat-input");
      chatInput.value = "Explain the XOR problem from this PDF.";
      chatInput.dispatchEvent(new Event("input", { bubbles: true }));
      const sendBtn = document.getElementById("send-btn");
      sendBtn.click();
    })()`,
  });

  await new Promise((r) => setTimeout(r, 4000));
  client.close();
}

main().catch(console.error);
