/* SentIQ Liquid Glass V4 — Pass 9.4 nested-control event bridge */

const CONTINUITY_CONTROL_SELECTOR = [
  "#new-chat-btn",
  "#auth-logout-btn",
  "#auth-menu-logout-btn",
  "#account-signout-btn",
  ".chat-delete-btn",
  ".chat-rename-btn",
  ".chat-list-item[data-id]",
].join(",");

function normalizeNestedContinuityClick(event) {
  if (event.target instanceof HTMLElement || !(event.target instanceof Element)) return;
  const control = event.target.closest(CONTINUITY_CONTROL_SELECTOR);
  if (!(control instanceof HTMLElement)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  control.click();
}

document.addEventListener("click", normalizeNestedContinuityClick, true);
