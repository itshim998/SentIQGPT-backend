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
    try {
      const config = await Storage.getAllConfig();
      if (chatLimitInput) chatLimitInput.value = config.chat_limit;
      if (memoryLimitInput) memoryLimitInput.value = config.memory_limit;
      if (fileLimitInput) fileLimitInput.value = config.file_storage_mb;
      await renderStats();
    } catch (error) {
      if (storageStats) storageStats.textContent = window.SentIQErrors?.getSafeErrorMessage?.(error) || "Storage details are unavailable.";
    }
  }

  async function renderStats() {
    if (!storageStats) return;
    const stats = await Storage.getStorageStats();
    const storageStatus = Storage.getStorageStatus?.();
    storageStats.innerHTML = `
      ${storageStatus?.persistent === false ? '<div class="stat-row"><span>Storage mode</span><span>Temporary session</span></div>' : ""}
      <div class="stat-row"><span>Conversations</span><span>${stats.chats.count} / ${stats.chats.limit}</span></div>
      <div class="stat-row"><span>Memories</span><span>${stats.memories.count} / ${stats.memories.limit}</span></div>
      <div class="stat-row"><span>Files</span><span>${stats.files.count} (limit: ${stats.files.limit_mb} MB)</span></div>
    `;
  }

  saveSettingsBtn?.addEventListener("click", async () => {
    try {
      const chatLimit = parseInt(chatLimitInput?.value, 10);
      const memoryLimit = parseInt(memoryLimitInput?.value, 10);
      const fileLimit = parseInt(fileLimitInput?.value, 10);
      if (chatLimit > 0) await Storage.setConfig("chat_limit", chatLimit);
      if (memoryLimit > 0) await Storage.setConfig("memory_limit", memoryLimit);
      if (fileLimit > 0) await Storage.setConfig("file_storage_mb", fileLimit);
      await renderStats();
      saveSettingsBtn.textContent = "Saved.";
      setTimeout(() => (saveSettingsBtn.textContent = "Save Settings"), 1500);
    } catch (error) {
      saveSettingsBtn.textContent = window.SentIQErrors?.getSafeErrorMessage?.(error) || "Unable to save.";
      setTimeout(() => (saveSettingsBtn.textContent = "Save Settings"), 2200);
    }
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
