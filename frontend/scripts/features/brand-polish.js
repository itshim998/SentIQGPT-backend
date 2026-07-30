const ORIGINAL_SENTIQ_LOGO = "https://i.ibb.co/TxPHCpDf/download.png?v=original-20260730";

function applyOriginalBrandMark() {
  document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach((link) => {
    link.href = ORIGINAL_SENTIQ_LOGO;
  });

  const historyButton = document.getElementById("sidebar-collapse-btn");
  if (!(historyButton instanceof HTMLButtonElement)) return;
  if (historyButton.querySelector(".sidebar-history-logo")) return;

  const logo = document.createElement("img");
  logo.className = "sidebar-history-logo";
  logo.src = ORIGINAL_SENTIQ_LOGO;
  logo.alt = "";
  logo.setAttribute("aria-hidden", "true");
  logo.decoding = "async";
  logo.draggable = false;
  historyButton.appendChild(logo);
  historyButton.dataset.sentiqOriginalLogo = "true";
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyOriginalBrandMark, { once: true });
} else {
  applyOriginalBrandMark();
}
