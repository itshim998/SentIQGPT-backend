import { CdpClient, getSentIqTabDebuggerUrl } from "./cdpClient.mjs";

async function main() {
  const wsUrl = await getSentIqTabDebuggerUrl();
  const client = new CdpClient(wsUrl);
  await client.connect();
  await client.send("DOM.enable");
  await client.send("Runtime.enable");
  await client.send("Network.enable");

  const donePromise = new Promise((resolve) => {
    client.on("Network.responseReceived", async (params) => {
      if (params.response.url.includes("/api/files/upload") && params.response.status === 200) {
        console.log("Upload HTTP status:", params.response.status);
        try {
          const bodyRes = await client.send("Network.getResponseBody", { requestId: params.requestId });
          console.log("Upload Response Body:\n", bodyRes.body);
          resolve(JSON.parse(bodyRes.body));
        } catch (e) {
          console.error("Failed to get response body:", e.message);
          resolve(null);
        }
      }
    });
  });

  const doc = await client.send("DOM.getDocument");
  const node = await client.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#file-input" });
  await client.send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: ["C:\\Users\\Sounak\\Downloads\\XOR_using_MLFFN.pdf"] });
  await client.send("Runtime.evaluate", {
    expression: `document.getElementById("file-input").dispatchEvent(new Event("change", { bubbles: true }));`,
  });

  const res = await donePromise;
  console.log("Parsed Upload Result:\n", JSON.stringify(res, null, 2));

  client.close();
}

main().catch(console.error);
