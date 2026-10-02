import { CdpClient, getSentIqTabDebuggerUrl } from "./cdpClient.mjs";

async function main() {
  const wsUrl = await getSentIqTabDebuggerUrl();
  const client = new CdpClient(wsUrl);
  await client.connect();
  const res = await client.send("Runtime.evaluate", {
    expression: "document.getElementById('file-preview-area').innerHTML",
    returnByValue: true
  });
  console.log("Preview area innerHTML:\n", res.result.value);
  client.close();
}

main().catch(console.error);
