// ================================================================
// 5. File Upload Handler (shim — logic in chat-ui)
// ================================================================
(function () {
  const Storage = window.SentIQStorage;
  async function getFileStats() {
    const files = await Storage.getAllFiles();
    return { count: files.length, totalSizeKb: files.reduce((sum, f) => sum + (f.size_bytes || 0), 0) / 1024 };
  }
  window.SentIQFilePanel = { getFileStats };
})();
