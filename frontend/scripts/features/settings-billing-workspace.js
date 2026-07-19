/* SentIQ Liquid Glass V4 — Phase 8.2 settings and billing workspace */

const SETTINGS_WORKSPACE_VERSION = "8.2";

const TAB_PRESENTATION = Object.freeze({
  billing: Object.freeze({
    label: "Plan & usage",
    description: "Allowances and upgrades",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M7 3v4"/><path d="M17 3v4"/><rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 12h3"/><path d="M8 16h8"/></svg>',
  }),
  memory: Object.freeze({
    label: "Memory",
    description: "What SentIQ keeps in mind",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4.5a3.5 3.5 0 0 1 6 2.45A3.5 3.5 0 0 1 18.5 10a3.5 3.5 0 0 1-1.55 2.91A3.5 3.5 0 0 1 13.5 17H13v3"/><path d="M11 20v-3h-.5a3.5 3.5 0 0 1-3.45-4.09A3.5 3.5 0 0 1 5.5 10 3.5 3.5 0 0 1 9 6.5"/><path d="M9 9h6"/><path d="M9 13h6"/></svg>',
  }),
  support: Object.freeze({
    label: "Support & trust",
    description: "Privacy, data and help",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>',
  }),
});

function createElement(tagName, className, html = "") {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (html) element.innerHTML = html;
  return element;
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function initialsFor(name, email) {
  const source = firstText(name, email?.split("@")[0], "S");
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length > 1) return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function initializeSettingsWorkspace() {
  const modal = document.getElementById("settings-modal");
  const surface = modal?.querySelector(".modal-container");
  const header = surface?.querySelector(".modal-header");
  const body = surface?.querySelector(".modal-body");
  const tabs = body?.querySelector(".settings-tabs");
  const billingContent = document.getElementById("settings-tab-billing");
  const memoryContent = document.getElementById("settings-tab-memory");

  if (!modal || !surface || !header || !body || !tabs || !billingContent || !memoryContent) return;
  if (modal.dataset.settingsWorkspaceVersion === SETTINGS_WORKSPACE_VERSION) return;
  modal.dataset.settingsWorkspaceVersion = SETTINGS_WORKSPACE_VERSION;
  surface.classList.add("settings-workspace-surface");
  header.classList.add("settings-workspace-header");
  body.classList.add("settings-workspace-body");

  const title = header.querySelector("h2");
  if (title && !header.querySelector(".settings-workspace-heading")) {
    const heading = createElement("div", "settings-workspace-heading");
    const eyebrow = createElement("span", "settings-workspace-eyebrow");
    eyebrow.textContent = "Workspace settings";
    const subtitle = createElement("p", "settings-workspace-subtitle");
    subtitle.textContent = "Manage your plan, usage, memory and account trust controls.";
    heading.append(eyebrow, title, subtitle);
    header.prepend(heading);
  }

  tabs.classList.add("settings-workspace-tabs");
  const billingTab = tabs.querySelector('[data-tab="billing"]');
  const memoryTab = tabs.querySelector('[data-tab="memory"]');

  function decorateTab(button, key) {
    if (!(button instanceof HTMLButtonElement)) return;
    const presentation = TAB_PRESENTATION[key];
    if (!presentation) return;
    button.classList.add("settings-workspace-tab");
    button.dataset.settingsWorkspaceTab = key;
    button.innerHTML = `
      <span class="settings-workspace-tab-icon">${presentation.icon}</span>
      <span class="settings-workspace-tab-copy">
        <span class="settings-workspace-tab-label">${presentation.label}</span>
        <span class="settings-workspace-tab-description">${presentation.description}</span>
      </span>
      <svg class="settings-workspace-tab-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
    `;
  }

  decorateTab(billingTab, "billing");
  decorateTab(memoryTab, "memory");

  let supportTab = tabs.querySelector('[data-tab="support"]');
  if (!supportTab) {
    supportTab = document.createElement("button");
    supportTab.id = "settings-tab-button-support";
    supportTab.className = "settings-tab";
    supportTab.type = "button";
    supportTab.dataset.tab = "support";
    supportTab.setAttribute("role", "tab");
    supportTab.setAttribute("aria-selected", "false");
    supportTab.setAttribute("aria-controls", "settings-tab-support");
    supportTab.tabIndex = -1;
    tabs.appendChild(supportTab);
  }
  decorateTab(supportTab, "support");

  const identity = createElement("section", "settings-account-summary");
  identity.setAttribute("aria-label", "Account information");
  identity.innerHTML = `
    <div id="settings-account-avatar" class="settings-account-avatar" aria-hidden="true">S</div>
    <div class="settings-account-copy">
      <strong id="settings-account-name" class="settings-account-name">Loading account…</strong>
      <span id="settings-account-email" class="settings-account-email"></span>
      <span id="settings-account-plan" class="settings-account-plan">Checking plan…</span>
    </div>
  `;

  const rail = createElement("aside", "settings-workspace-rail");
  rail.append(identity, tabs);

  let supportContent = document.getElementById("settings-tab-support");
  if (!supportContent) {
    supportContent = createElement("section", "settings-tab-content settings-support-content");
    supportContent.id = "settings-tab-support";
    supportContent.setAttribute("role", "tabpanel");
    supportContent.setAttribute("aria-labelledby", "settings-tab-button-support");
    supportContent.hidden = true;
    supportContent.innerHTML = `
      <div class="settings-section-heading">
        <span class="settings-section-eyebrow">Support &amp; trust</span>
        <h3>Privacy, data and account help</h3>
        <p>Review how SentIQ Chat handles your data, manage local controls, or contact support.</p>
      </div>
      <div class="settings-action-list" aria-label="Support and trust destinations">
        <button class="settings-action-row" type="button" data-trust-tab="privacy">
          <span class="settings-action-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg></span>
          <span class="settings-action-copy"><strong>Privacy</strong><span>Understand what is stored and when external services are used.</span></span>
          <svg class="settings-action-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </button>
        <button class="settings-action-row" type="button" data-trust-tab="controls">
          <span class="settings-action-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></svg></span>
          <span class="settings-action-copy"><strong>Data controls</strong><span>Clear temporary source files or this browser's local SentIQ cache.</span></span>
          <svg class="settings-action-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </button>
        <button class="settings-action-row" type="button" data-trust-tab="terms">
          <span class="settings-action-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/><path d="M9 13h8"/><path d="M9 17h6"/></svg></span>
          <span class="settings-action-copy"><strong>Terms of use</strong><span>Review the expectations that apply when using SentIQ Chat.</span></span>
          <svg class="settings-action-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </button>
        <button class="settings-action-row" type="button" data-trust-tab="support">
          <span class="settings-action-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.4 9a2.8 2.8 0 0 1 5.4 1c0 1.8-2.8 2.4-2.8 4"/><path d="M12 17h.01"/></svg></span>
          <span class="settings-action-copy"><strong>Contact support</strong><span>Get help with account, billing, files, privacy or product issues.</span></span>
          <svg class="settings-action-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      </div>
      <div class="settings-trust-note" role="note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>
        <span>Billing actions use the existing secure checkout flow. SentIQ Chat never asks for card details inside this panel.</span>
      </div>
    `;
  }

  billingContent.classList.add("settings-workspace-content-panel");
  memoryContent.classList.add("settings-workspace-content-panel", "settings-memory-content");
  supportContent.classList.add("settings-workspace-content-panel");

  if (!memoryContent.querySelector(".settings-section-heading")) {
    const memoryHeading = createElement("div", "settings-section-heading");
    memoryHeading.innerHTML = `
      <span class="settings-section-eyebrow">Memory manager</span>
      <h3>What SentIQ Chat remembers</h3>
      <p>Review explicit memories, understand their scope, and remove anything you no longer want used across conversations.</p>
    `;
    memoryContent.prepend(memoryHeading);
  }

  const memoryHeader = memoryContent.querySelector(".memory-manager-header");
  const memoryCount = document.getElementById("memory-count");
  if (memoryHeader && !memoryHeader.querySelector(".settings-memory-refresh")) {
    memoryHeader.classList.add("settings-memory-toolbar");
    const toolbarCopy = createElement("div", "settings-memory-toolbar-copy");
    toolbarCopy.innerHTML = '<strong>Saved memories</strong><span>Only items you explicitly asked SentIQ Chat to remember appear here.</span>';
    const actions = createElement("div", "settings-memory-toolbar-actions");
    if (memoryCount) actions.appendChild(memoryCount);
    const refreshButton = createElement("button", "btn btn-secondary settings-memory-refresh");
    refreshButton.type = "button";
    refreshButton.textContent = "Refresh";
    refreshButton.addEventListener("click", async () => {
      refreshButton.disabled = true;
      refreshButton.textContent = "Refreshing…";
      try {
        await window.SentIQMemoryPanel?.renderMemories?.({ refreshCloud: true });
      } finally {
        refreshButton.disabled = false;
        refreshButton.textContent = "Refresh";
      }
    });
    actions.appendChild(refreshButton);
    memoryHeader.replaceChildren(toolbarCopy, actions);
  }

  const content = createElement("div", "settings-workspace-content");
  content.append(billingContent, memoryContent, supportContent);
  const shell = createElement("div", "settings-workspace-shell");
  shell.append(rail, content);
  body.replaceChildren(shell);

  function visibleTabs() {
    return Array.from(tabs.querySelectorAll(".settings-tab[data-tab]")).filter((tab) => tab.style.display !== "none" && !tab.hidden);
  }

  function activateTab(tabName, { focus = false } = {}) {
    const available = visibleTabs();
    const selected = available.find((tab) => tab.dataset.tab === tabName) || available[0] || null;
    const selectedName = selected?.dataset.tab || "";

    tabs.querySelectorAll(".settings-tab[data-tab]").forEach((tab) => {
      const active = tab === selected;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    content.querySelectorAll(".settings-tab-content").forEach((panel) => {
      const active = panel.id === `settings-tab-${selectedName}`;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    });
    if (focus) selected?.focus({ preventScroll: true });
    content.scrollTop = 0;
  }

  tabs.addEventListener("click", (event) => {
    const tab = event.target.closest(".settings-tab[data-tab]");
    if (tab) activateTab(tab.dataset.tab || "");
  });

  tabs.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const available = visibleTabs();
    if (!available.length) return;
    const current = available.indexOf(document.activeElement);
    let next = current >= 0 ? current : 0;
    if (["ArrowDown", "ArrowRight"].includes(event.key)) next = (next + 1) % available.length;
    else if (["ArrowUp", "ArrowLeft"].includes(event.key)) next = (next - 1 + available.length) % available.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = available.length - 1;
    event.preventDefault();
    activateTab(available[next].dataset.tab || "", { focus: true });
  });

  let currentPlanLabel = "Checking plan…";

  function updatePlanLabel(label) {
    currentPlanLabel = firstText(label, currentPlanLabel, "Free");
    const plan = document.getElementById("settings-account-plan");
    if (plan) plan.textContent = currentPlanLabel;
  }

  async function refreshIdentity() {
    const nameNode = document.getElementById("settings-account-name");
    const emailNode = document.getElementById("settings-account-email");
    const avatarNode = document.getElementById("settings-account-avatar");
    if (!nameNode || !emailNode || !avatarNode) return;

    let session = null;
    try { session = await window.SentIQAuth?.getSession?.(); } catch { /* guest or unavailable auth */ }
    if (!session?.user) {
      nameNode.textContent = "Guest workspace";
      emailNode.textContent = "Sign in to sync settings and memory";
      avatarNode.textContent = "G";
      updatePlanLabel("Free");
      return;
    }

    let profile = null;
    try { profile = await window.SentIQAPI?.getProfile?.(); } catch { /* profile copy is optional */ }
    const metadata = session.user.user_metadata || {};
    const displayName = firstText(
      profile?.display_name,
      profile?.profile?.display_name,
      metadata.display_name,
      metadata.full_name,
      metadata.name,
      document.getElementById("account-panel-name")?.textContent,
      "Signed in",
    );
    const email = firstText(session.user.email, document.getElementById("account-panel-email")?.textContent);
    nameNode.textContent = displayName;
    emailNode.textContent = email;
    emailNode.title = email;
    avatarNode.textContent = initialsFor(displayName, email);
    updatePlanLabel(currentPlanLabel);
  }

  window.addEventListener("sentiq-billing-summary", (event) => {
    updatePlanLabel(firstText(event.detail?.planName, event.detail?.plan_code, "Free"));
  });
  document.addEventListener("sentiq-auth-changed", () => { void refreshIdentity(); });
  modal.addEventListener("sentiq-panel-opened", (event) => {
    if (event.detail?.panelId !== "settings-modal") return;
    const active = tabs.querySelector(".settings-tab.active[data-tab]");
    activateTab(active?.dataset.tab || "billing");
    void refreshIdentity();
  });
  window.addEventListener("sentiq-settings-select-tab", (event) => activateTab(event.detail?.tab || "billing"));

  activateTab(tabs.querySelector(".settings-tab.active")?.dataset.tab || "billing");
  void refreshIdentity();

  window.SentIQSettingsWorkspace = Object.freeze({
    version: SETTINGS_WORKSPACE_VERSION,
    activateTab,
    refreshIdentity,
  });
}

initializeSettingsWorkspace();
