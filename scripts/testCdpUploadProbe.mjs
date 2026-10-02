import { CdpClient, getSentIqTabDebuggerUrl } from "./cdpClient.mjs";

async function main() {
  const wsUrl = await getSentIqTabDebuggerUrl();
  const client = new CdpClient(wsUrl);
  await client.connect();

  await client.send("DOM.enable");
  await client.send("Runtime.enable");

  // Click "+ New Chat" to start clean
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const newChatBtn = document.getElementById("new-chat-btn") || Array.from(document.querySelectorAll("button")).find(b => b.innerText.includes("New Chat"));
      if (newChatBtn) newChatBtn.click();
    })()`
  });

  await new Promise(r => setTimeout(r, 500));

  // Locate #file-input
  const doc = await client.send("DOM.getDocument");
  const nodeRes = await client.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "#file-input"
  });

  const testFile = "C:\\Users\\Sounak\\Downloads\\Sounak_Poddar_Resume.pdf.pdf";
  console.log("Setting file:", testFile);

  await client.send("DOM.setFileInputFiles", {
    nodeId: nodeRes.nodeId,
    files: [testFile]
  });

  // Dispatch change event
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.getElementById("file-input");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    })()`
  });

  // Wait 1.5 seconds and inspect preview area
  await new Promise(r => setTimeout(r, 1500));

  const previewState = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const previewArea = document.getElementById("file-preview-area");
      const chips = Array.from(previewArea ? previewArea.querySelectorAll(".file-pill, .composer-attachment-item") : []);
      return {
        areaHidden: previewArea ? previewArea.hidden : true,
        chipCount: chips.length,
        chipTexts: chips.map(c => c.innerText.trim())
      };
    })()`,
    returnByValue: true
  });

  console.log("Preview state:", previewState.result.value);

  client.close();
}

main().catch(console.error);
