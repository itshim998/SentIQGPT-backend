// ================================================================
// Privacy, support, and local data controls
// ================================================================
import { PRODUCT_NAME } from "../shared/brand.js";

(function initializeTrustPanel() {
  const modal = document.getElementById("trust-modal");
  const closeButton = document.getElementById("close-trust-btn");
  const clearButton = document.getElementById("clear-local-data-btn");
  const clearSourceFilesButton = document.getElementById("clear-source-files-btn");
  const status = document.getElementById("data-controls-status");
  const supportLink = document.getElementById("support-email-link");
  const supportEmail = String(window.SENTIQ_SUPPORT_EMAIL || "support@sentiqlabs.com");

  if (!modal) return;

  function selectTab(tabName = "privacy") {
    modal.querySelectorAll(".trust-tab").forEach((tab) => {
      const isActive = tab.dataset.trustTab === tabName;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });
    modal.querySelectorAll(".trust-tab-content").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `trust-tab-${tabName}`);
    });
  }

  function open(tabName = "privacy") {
    selectTab(tabName);
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    closeButton?.focus();
  }

  function close() {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }

  function isOpen() {
    return modal.style.display !== "none";
  }

  if (supportLink) {
    supportLink.href = `mailto:${supportEmail}`;
    supportLink.textContent = `Email ${supportEmail}`;
  }

  document.querySelectorAll("[data-trust-tab]").forEach((element) => {
    element.addEventListener("click", () => {
      const tabName = element.dataset.trustTab || "privacy";
      if (!modal.contains(element)) open(tabName);
      else selectTab(tabName);
    });
  });
  closeButton?.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.addEventListener("keydown", (event) => {
    if (modal.style.display === "none") return;
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(modal.querySelectorAll("a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  clearButton?.addEventListener("click", async () => {
    if (!window.confirm(`Clear ${PRODUCT_NAME} data stored in this browser? Your sign-in session will remain active.`)) return;
    clearButton.disabled = true;
    if (status) status.textContent = "Clearing local data...";
    try {
      await window.SentIQAPI?.clearFileSession?.().catch(() => null);
      await window.SentIQStorage?.clearLocalData?.();
      if (status) status.textContent = `Local ${PRODUCT_NAME} data was cleared. Reloading...`;
      window.setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      if (status) status.textContent = window.SentIQErrors?.getSafeErrorMessage?.(error) || "Local data could not be cleared.";
      clearButton.disabled = false;
    }
  });

  clearSourceFilesButton?.addEventListener("click", async () => {
    clearSourceFilesButton.disabled = true;
    if (status) status.textContent = "Clearing temporary source files...";
    try {
      await window.SentIQChat?.clearUploadedSourceContext?.();
      if (status) status.textContent = "Temporary source files were cleared from this workspace.";
    } catch (error) {
      if (status) status.textContent = window.SentIQErrors?.getSafeErrorMessage?.(error, { area: "file" }) || "Temporary source files could not be cleared.";
    } finally {
      clearSourceFilesButton.disabled = false;
    }
  });

  window.SentIQTrustPanel = {
    open,
    close,
    isOpen,
  };
})();
