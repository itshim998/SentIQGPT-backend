from pathlib import Path

path = Path("frontend/scripts/features/chat-controller.js")
source = path.read_text(encoding="utf-8")

if "function consumePromptHandoff()" in source:
    raise SystemExit("Prompt handoff is already installed.")

old = '''  function startChatUi() {
    init()
      .then(() => window.SentIQBootstrap?.markReady?.())
      .catch((error) => {
'''

new = '''  function readPromptHandoff() {
    const rawHash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : "";
    if (!rawHash) return null;

    const params = new URLSearchParams(rawHash);
    const prompt = String(params.get("prompt") || "").trim();
    if (!prompt) return null;

    return {
      prompt: prompt.slice(0, 12000),
      shouldSubmit: params.get("submit") !== "0",
    };
  }

  async function consumePromptHandoff() {
    const handoff = readPromptHandoff();
    if (!handoff || !chatInput) return;

    // Remove the prompt from browser history before it is rendered or sent.
    const cleanUrl = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(window.history.state, "", cleanUrl);

    chatInput.value = handoff.prompt;
    chatInput.dispatchEvent(new Event("input", { bubbles: true }));
    autoResizeInput();
    syncComposerInteractivity();

    if (!handoff.shouldSubmit) {
      chatInput.focus();
      return;
    }

    // Let guest/auth state and the composer settle before using the normal
    // send path. This preserves all existing validation, quotas and streaming.
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    try {
      await handleSend();
    } catch (error) {
      debugWarn("[UI] Labs prompt handoff could not be submitted:", getSafeErrorMessage(error));
      chatInput.focus();
    }
  }

  function startChatUi() {
    init()
      .then(async () => {
        await consumePromptHandoff();
        window.SentIQBootstrap?.markReady?.();
      })
      .catch((error) => {
'''

count = source.count(old)
if count != 1:
    raise SystemExit(f"Expected one startChatUi bootstrap marker, found {count}.")

source = source.replace(old, new)

required = [
    "function readPromptHandoff()",
    "function consumePromptHandoff()",
    "await handleSend();",
    "window.history.replaceState",
    "prompt.slice(0, 12000)",
]
missing = [token for token in required if token not in source]
if missing:
    raise SystemExit(f"Handoff transform is incomplete: {missing}")

path.write_text(source, encoding="utf-8")
print("Installed SentIQ Labs prompt handoff in SentIQ Chat.")
