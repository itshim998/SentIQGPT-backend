import { CdpClient, getSentIqTabDebuggerUrl } from "./cdpClient.mjs";

async function main() {
  const wsUrl = await getSentIqTabDebuggerUrl();
  const client = new CdpClient(wsUrl);
  await client.connect();

  const evalRes = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const userEl = document.querySelector(".user-name, .user-profile-name, .profile-name, .nav-user-name, [data-user-name]");
      const chatInput = document.getElementById("chat-input");
      const sendBtn = document.getElementById("send-btn");
      const fileInput = document.getElementById("file-input");
      const newChatBtn = document.getElementById("new-chat-btn");
      const messages = Array.from(document.querySelectorAll("#chat-messages .message"));
      return {
        url: window.location.href,
        title: document.title,
        userName: userEl ? userEl.innerText : null,
        hasChatInput: Boolean(chatInput),
        hasSendBtn: Boolean(sendBtn),
        hasFileInput: Boolean(fileInput),
        hasNewChatBtn: Boolean(newChatBtn),
        messageCount: messages.length,
        first200Chars: document.body.innerText.slice(0, 300)
      };
    })()`,
    returnByValue: true,
  });

  console.log("Browser Status:", JSON.stringify(evalRes.result.value, null, 2));
  client.close();
}

main().catch(console.error);
