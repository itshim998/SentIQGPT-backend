// ================================================================
// 4. Memory Panel
// ================================================================
import { normalizeMemoryScope } from "../services/storage.js";

(function () {
  const Storage = window.SentIQStorage;
  const API = window.SentIQAPI;
  const memoryList = document.getElementById("memory-list");
  const memoryCount = document.getElementById("memory-count");
  const compressBtn = document.getElementById("compress-memories-btn");
  const getSafeErrorMessage = window.SentIQGetSafeErrorMessage || ((error) => (
    error instanceof Error ? error.message : String(error || "Unknown error")
  ));
  const debugWarn = (...args) => {
    if (window.SentIQChat?.debugWarn) {
      window.SentIQChat.debugWarn(...args);
    } else if (window.SENTIQ_DEBUG) {
      console.warn(...args);
    }
  };
  const showToast = (...args) => {
    window.SentIQChat?.showToast?.(...args);
  };

  async function renderMemories() {
    if (!memoryList) return;
    const memories = await Storage.getAllMemories();
    memoryList.innerHTML = "";
    if (memoryCount) memoryCount.textContent = `${memories.length} memories`;

    if (memories.length === 0) {
      memoryList.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem; padding: 12px 0;">No memories stored yet. Memories appear when you explicitly ask SentIQGPT to remember something.</p>';
      return;
    }
    const groups = {};
    for (const mem of memories) { if (!groups[mem.type]) groups[mem.type] = []; groups[mem.type].push(mem); }

    for (const [type, items] of Object.entries(groups)) {
      const section = document.createElement("div");
      section.className = "memory-group";
      const header = document.createElement("h4");
      header.className = "memory-group-header";
      header.textContent = type.charAt(0).toUpperCase() + type.slice(1);
      section.appendChild(header);

      for (const mem of items.sort((a, b) => b.importance - a.importance)) {
        const item = document.createElement("div");
        item.className = "memory-item";
        const scope = normalizeMemoryScope(mem);
        const scopeLabel = scope === "chat" ? "Single chat" : "Across chats";
        item.innerHTML = `
          <div class="memory-summary">${escapeHtmlMem(mem.summary)}</div>
          <span class="memory-scope-badge ${scope}">${scopeLabel}</span>
          <div class="memory-meta">${mem.importance}/10 · ${new Date(mem.timestamp).toLocaleDateString()}</div>
        `;
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "memory-delete-btn";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", async () => { await Storage.deleteMemory(mem.id); await renderMemories(); });
        item.appendChild(deleteBtn);
        section.appendChild(item);
      }
      memoryList.appendChild(section);
    }
  }

  renderMemories = async function renderMemoriesWithCloudSync(options = {}) {
    const { refreshCloud = false } = options;
    if (refreshCloud && window.SentIQChat?.syncCloudMemoriesFromServer) {
      window.SentIQChat.syncCloudMemoriesFromServer({ force: true, silent: true })
        .then(() => renderMemories({ refreshCloud: false }))
        .catch((error) => debugWarn(`[UI] Memory refresh failed: ${getSafeErrorMessage(error)}`));
    }

    if (!memoryList) return;
    const memories = await Storage.getAllMemories();
    memoryList.innerHTML = "";
    if (memoryCount) memoryCount.textContent = `${memories.length} memories`;

    if (memories.length === 0) {
      memoryList.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem; padding: 12px 0;">No memories stored yet. Memories appear when you explicitly ask SentIQGPT to remember something.</p>';
      return;
    }

    const groups = {};
    for (const mem of memories) {
      if (!groups[mem.type]) groups[mem.type] = [];
      groups[mem.type].push(mem);
    }

    for (const [type, items] of Object.entries(groups)) {
      const section = document.createElement("div");
      section.className = "memory-group";
      const header = document.createElement("h4");
      header.className = "memory-group-header";
      header.textContent = type.charAt(0).toUpperCase() + type.slice(1);
      section.appendChild(header);

      for (const mem of items.sort((a, b) => b.importance - a.importance || new Date(b.timestamp) - new Date(a.timestamp))) {
        const item = document.createElement("div");
        item.className = "memory-item";
        const scope = normalizeMemoryScope(mem);
        const scopeLabel = scope === "chat" ? "Single chat" : "Across chats";
        item.innerHTML = `
          <div class="memory-summary">${escapeHtmlMem(mem.summary)}</div>
          <span class="memory-scope-badge ${scope}">${scopeLabel}</span>
          <div class="memory-meta">${mem.importance}/10 · ${new Date(mem.timestamp).toLocaleDateString()}</div>
        `;
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "memory-delete-btn";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", async () => {
          if (mem.source === "server" && !mem.pending_server_sync) {
            try {
              await API.deleteMemory(mem.id);
            } catch (error) {
              debugWarn(`[UI] Memory delete sync failed: ${getSafeErrorMessage(error)}`);
              showToast("Couldn't delete that memory from the cloud. Please try again.", "error", 3200);
              return;
            }
          }
          await Storage.deleteMemory(mem.id);
          await renderMemories({ refreshCloud: mem.source === "server" && !mem.pending_server_sync });
        });
        item.appendChild(deleteBtn);
        section.appendChild(item);
      }
      memoryList.appendChild(section);
    }
  };

  compressBtn?.addEventListener("click", async () => {
    const memories = await Storage.getAllMemories();
    if (memories.length < 5) { alert("Not enough memories to compress (need at least 5)."); return; }
    compressBtn.disabled = true;
    compressBtn.textContent = "Compressing...";
    const sorted = memories.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const toCompress = sorted.slice(0, Math.floor(sorted.length / 2));
    const groups = {};
    for (const mem of toCompress) {
      const scope = normalizeMemoryScope(mem);
      const chatId = scope === "chat" && typeof mem.chat_id === "string" && mem.chat_id.trim()
        ? mem.chat_id.trim()
        : null;
      const key = `${mem.type}::${scope}::${chatId || ""}`;
      if (!groups[key]) {
        groups[key] = { type: mem.type, scope, chat_id: chatId, items: [] };
      }
      groups[key].items.push(mem);
    }
    for (const group of Object.values(groups)) {
      const { type, scope, chat_id, items } = group;
      if (items.length < 2) continue;
      try {
        const result = await API.compressMemories(items);
        if (result.compressed_summary) {
          for (const item of items) await Storage.deleteMemory(item.id);
          await Storage.storeMemory({
            type,
            summary: result.compressed_summary,
            importance: result.importance || 5,
            scope,
            chat_id,
          });
        }
      } catch (err) { debugWarn(`[UI] Compression failed for type ${type} (${scope}): ${getSafeErrorMessage(err)}`); }
    }
    compressBtn.disabled = false;
    compressBtn.textContent = "Compress Memories";
    await renderMemories();
  });

  function escapeHtmlMem(str) { const div = document.createElement("div"); div.textContent = str; return div.innerHTML; }

  window.SentIQMemoryPanel = { renderMemories };
})();
