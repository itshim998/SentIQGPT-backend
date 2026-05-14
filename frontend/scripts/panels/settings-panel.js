// ================================================================
// 6. Settings Panel
// ================================================================
(function () {
  const Storage = window.SentIQStorage;
  const chatLimitInput = document.getElementById("setting-chat-limit");
  const memoryLimitInput = document.getElementById("setting-memory-limit");
  const fileLimitInput = document.getElementById("setting-file-limit");
  const saveSettingsBtn = document.getElementById("save-settings-btn");
  const storageStats = document.getElementById("storage-stats");

  async function loadSettings() {
    const config = await Storage.getAllConfig();
    if (chatLimitInput) chatLimitInput.value = config.chat_limit;
    if (memoryLimitInput) memoryLimitInput.value = config.memory_limit;
    if (fileLimitInput) fileLimitInput.value = config.file_storage_mb;
    await renderStats();
  }

  async function renderStats() {
    if (!storageStats) return;
    const stats = await Storage.getStorageStats();
    storageStats.innerHTML = `
      <div class="stat-row"><span>Conversations</span><span>${stats.chats.count} / ${stats.chats.limit}</span></div>
      <div class="stat-row"><span>Memories</span><span>${stats.memories.count} / ${stats.memories.limit}</span></div>
      <div class="stat-row"><span>Files</span><span>${stats.files.count} (limit: ${stats.files.limit_mb} MB)</span></div>
    `;
  }

  saveSettingsBtn?.addEventListener("click", async () => {
    const chatLimit = parseInt(chatLimitInput?.value, 10);
    const memoryLimit = parseInt(memoryLimitInput?.value, 10);
    const fileLimit = parseInt(fileLimitInput?.value, 10);
    if (chatLimit > 0) await Storage.setConfig("chat_limit", chatLimit);
    if (memoryLimit > 0) await Storage.setConfig("memory_limit", memoryLimit);
    if (fileLimit > 0) await Storage.setConfig("file_storage_mb", fileLimit);
    await renderStats();
    saveSettingsBtn.textContent = "Saved.";
    setTimeout(() => (saveSettingsBtn.textContent = "Save Settings"), 1500);
  });

  const observer = new MutationObserver(() => {
    const modal = document.getElementById("settings-modal");
    if (modal && modal.style.display !== "none") loadSettings();
  });
  const modal = document.getElementById("settings-modal");
  if (modal) observer.observe(modal, { attributes: true, attributeFilter: ["style"] });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", loadSettings);
  else loadSettings();
})();
