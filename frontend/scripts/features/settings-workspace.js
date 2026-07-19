/* SentIQ Liquid Glass V4 — Phase 8.2 settings and billing workspace */

const SETTINGS_WORKSPACE_VERSION = "8.2";

const SECTION_META = Object.freeze({
  account: Object.freeze({
    eyebrow: "Account",
    title: "Account information",
    description: "Review the identity connected to this workspace and move into plan, privacy, or session controls.",
  }),
  billing: Object.freeze({
    eyebrow: "Plan & usage",
    title: "Plan, tokens, and upgrades",
    description: "See the active plan, understand remaining allowances, and compare upgrades without leaving the settings workspace.",
  }),
  memory: Object.freeze({
    eyebrow: "Personalization",
    title: "Memory Manager",
    description: "Review the details SentIQ Chat can use across conversations and remove anything that should no longer be remembered.",
  }),
  trust: Object.freeze({
    eyebrow: "Trust & support",
    title: "Privacy, data, and help",
    description: "Open the detailed controls for privacy, local data, terms, and support from one place.",
  }),
});

const NAV_META = Object.freeze({
  account: Object.freeze({ label: "Account", detail: "Identity and session", icon: "user" }),
  billing: Object.freeze({ label: "Plan & usage", detail: "Tokens and upgrades", icon: "spark" }),
  memory: Object.freeze({ label: "Memory", detail: "Personalization", icon: "memory" }),
  trust: Object.freeze({ label: "Trust & support", detail: "Privacy and help", icon: "shield" }),
});

const ICONS = Object.freeze({
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="8" r="4"></circle></svg>',
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8L12 3Z"></path><path d="m18.5 15 .9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z"></path></svg>',
  memory: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5a3.5 3.5 0 0 0-5 3.2c0 .7.2 1.4.6 2A3.5 3.5 0 0 0 5 16.3 3.5 3.5 0 0 0 9 20"></path><path d="M15 4.5a3.5 3.5 0 0 1 5 3.2c0 .7-.2 1.4-.6 2a3.5 3.5 0 0 1-.4 6.6 3.5 3.5 0 0 1-4 3.7"></path><path d="M9 4v16M15 4v16M9 8h2M13 12h2M9 16h2"></path></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path><path d="m9 12 2 2 4-4"></path></svg>',
});

function createNavButton(tabName) {
  const meta = NAV_META[tabName];
  const button = document.createElement("button");
  button.id = `settings-tab-button-${tabName}`;
  button.className = "settings-tab settings-workspace-nav-item";
  button.type = "button";
  button.dataset.tab = tabName;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", "false");
  button.setAttribute("aria-controls", `settings-tab-${tabName}`);
  button.tabIndex = -1;
  button.innerHTML = `
    <span class="settings-workspace-nav-icon" aria-hidden="true">${ICONS[meta.icon]}</span>
    <span class="settings-workspace-nav-copy">
      <span class="settings-workspace-nav-label">${meta.label}</span>
      <span class="settings-workspace-nav-detail">${meta.detail}</span>
    </span>
  `;
  return button;
}

function decorateNavButton(button) {
  const tabName = button.dataset.tab;
  const meta = NAV_META[tabName];
  if (!meta || button.dataset.settingsWorkspaceDecorated === "true") return;
  button.classList.add("settings-workspace-nav-item");
  button.dataset.settingsWorkspaceDecorated = "true";
  button.innerHTML = `
    <span class="settings-workspace-nav-icon" aria-hidden="true">${ICONS[meta.icon]}</span>
    <span class="settings-workspace-nav-copy">
      <span class="settings-workspace-nav-label">${meta.label}</span>
      <span class="settings-workspace-nav-detail">${meta.detail}</span>
    </span>
  `;
}

function createAccountPanel() {
  const panel = document.createElement("section");
  panel.id = "settings-tab-account";
  panel.className = "settings-tab-content settings-workspace-account";
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", "settings-tab-button-account");
  panel.hidden = true;
  panel.innerHTML = `
    <div class="settings-workspace-section settings-account-details">
      <div class="settings-workspace-section-heading">
        <div>
          <span class="settings-workspace-section-kicker">Connected identity</span>
          <h4>Your SentIQ Chat account</h4>
        </div>
        <span id="settings-account-state" class="settings-account-state">Checking session</span>
      </div>
      <dl class="settings-account-definition-list">
        <div>
          <dt>Display name</dt>
          <dd id="settings-account-name">Signed in</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd id="settings-account-email">—</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd id="settings-account-plan">Loading plan</dd>
        </div>
      </dl>
      <div class="settings-account-actions">
        <button id="settings-account-plan-action" class="btn btn-primary" type="button">Manage plan</button>
        <button id="settings-account-session-action" class="btn btn-secondary" type="button">Sign out</button>
      </div>
    </div>
    <div class="settings-workspace-section settings-account-shortcuts" aria-labelledby="settings-account-shortcuts-title">
      <div class="settings-workspace-section-heading">
        <div>
          <span class="settings-workspace-section-kicker">Workspace controls</span>
          <h4 id="settings-account-shortcuts-title">Related settings</h4>
        </div>
      </div>
      <div class="settings-workspace-link-list">
        <button type="button" class="settings-workspace-link-row" data-settings-target-tab="memory">
          <span><strong>Personalization</strong><small>Review memories used across chats.</small></span><span aria-hidden="true">→</span>
        </button>
        <button type="button" class="settings-workspace-link-row" data-settings-target-tab="trust">
          <span><strong>Privacy and support</strong><small>Open trust, local data, and help controls.</small></span><span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  `;
  return panel;
}

function createTrustPanel() {
  const panel = document.createElement("section");
  panel.id = "settings-tab-trust";
  panel.className = "settings-tab-content settings-workspace-trust";
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", "settings-tab-button-trust");
  panel.hidden = true;
  panel.innerHTML = `
    <div class="settings-workspace-section">
      <div class="settings-workspace-section-heading">
        <div>
          <span class="settings-workspace-section-kicker">Trust centre</span>
          <h4>Privacy, data, and support</h4>
          <p>Open a focused detail sheet while keeping Settings as the primary workspace.</p>
        </div>
      </div>
      <div class="settings-workspace-link-list settings-trust-link-list">
        <button type="button" class="settings-workspace-link-row" data-settings-trust-target="privacy">
          <span><strong>Privacy</strong><small>Understand how chats, files, memories, and generated work are handled.</small></span><span aria-hidden="true">→</span>
        </button>
        <button type="button" class="settings-workspace-link-row" data-settings-trust-target="controls">
          <span><strong>Data controls</strong><small>Clear temporary source context or browser-local SentIQ Chat data.</small></span><span aria-hidden="true">→</span>
        </button>
        <button type="button" class="settings-workspace-link-row" data-settings-trust-target="terms">
          <span><strong>Terms of use</strong><small>Review the expectations for responsible product use.</small></span><span aria-hidden="true">→</span>
        </button>
        <button type="button" class="settings-workspace-link-row" data-settings-trust-target="support">
          <span><strong>Support</strong><small>Get help with account, privacy, files, chats, or product issues.</small></span><span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  `;
  return panel;
}

function sectionHeading(kicker, title, description) {
  const wrapper = document.createElement("div");
  wrapper.className = "settings-workspace-section-heading settings-workspace-generated-heading";
  wrapper.innerHTML = `
    <div>
      <span class="settings-workspace-section-kicker">${kicker}</span>
      <h4>${title}</h4>
      ${description ? `<p>${description}</p>` : ""}
    </div>
  `;
  return wrapper;
}

function initializeSettingsWorkspace() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("settings-modal");
  const modalBody = modal?.querySelector(":scope > .modal-container > .modal-body");
  const tabList = modalBody?.querySelector(".settings-tabs");
  const billingPanel = document.getElementById("billing-panel");
  const billingContent = document.getElementById("settings-tab-billing");
  const memoryContent = document.getElementById("settings-tab-memory");
  if (!(modal instanceof HTMLElement) || !(modalBody instanceof HTMLElement) || !(tabList instanceof HTMLElement)) return;
  if (modal.dataset.settingsWorkspaceVersion === SETTINGS_WORKSPACE_VERSION) return;

  modal.dataset.settingsWorkspaceVersion = SETTINGS_WORKSPACE_VERSION;
  modal.classList.add("settings-workspace-root");

  const accountTab = createNavButton("account");
  const trustTab = createNavButton("trust");
  tabList.prepend(accountTab);
  tabList.append(trustTab);
  tabList.querySelectorAll(".settings-tab[data-tab]").forEach(decorateNavButton);

  const accountContent = createAccountPanel();
  const trustContent = createTrustPanel();
  const workspace = document.createElement("div");
  workspace.className = "settings-workspace";
  workspace.dataset.settingsWorkspace = SETTINGS_WORKSPACE_VERSION;

  const rail = document.createElement("aside");
  rail.className = "settings-workspace-rail";
  rail.setAttribute("aria-label", "Settings navigation and account summary");
  rail.innerHTML = `
    <div class="settings-workspace-identity">
      <span id="settings-workspace-avatar" class="settings-workspace-avatar" aria-hidden="true">S</span>
      <span class="settings-workspace-identity-copy">
        <strong id="settings-workspace-name">SentIQ Chat</strong>
        <small id="settings-workspace-email">Guest workspace</small>
      </span>
      <span id="settings-workspace-plan" class="settings-workspace-plan">Guest</span>
    </div>
  `;
  rail.appendChild(tabList);

  const main = document.createElement("div");
  main.className = "settings-workspace-main";
  main.innerHTML = `
    <header class="settings-workspace-context-header">
      <span id="settings-workspace-eyebrow" class="settings-workspace-eyebrow">${SECTION_META.billing.eyebrow}</span>
      <h3 id="settings-workspace-title">${SECTION_META.billing.title}</h3>
      <p id="settings-workspace-description">${SECTION_META.billing.description}</p>
    </header>
    <div class="settings-workspace-content" aria-live="off"></div>
  `;
  const contentHost = main.querySelector(".settings-workspace-content");
  contentHost.append(accountContent, billingContent, memoryContent, trustContent);
  workspace.append(rail, main);
  modalBody.replaceChildren(workspace);

  const eyebrow = document.getElementById("settings-workspace-eyebrow");
  const title = document.getElementById("settings-workspace-title");
  const description = document.getElementById("settings-workspace-description");
  const workspaceName = document.getElementById("settings-workspace-name");
  const workspaceEmail = document.getElementById("settings-workspace-email");
  const workspaceAvatar = document.getElementById("settings-workspace-avatar");
  const workspacePlan = document.getElementById("settings-workspace-plan");
  const accountName = document.getElementById("settings-account-name");
  const accountEmail = document.getElementById("settings-account-email");
  const accountPlan = document.getElementById("settings-account-plan");
  const accountState = document.getElementById("settings-account-state");
  const accountPlanAction = document.getElementById("settings-account-plan-action");
  const accountSessionAction = document.getElementById("settings-account-session-action");

  let activeSession = null;
  let decorateFrame = 0;

  function visibleTabs() {
    return Array.from(tabList.querySelectorAll(".settings-tab[data-tab]")).filter((tab) => {
      if (!(tab instanceof HTMLElement) || tab.hidden || tab.style.display === "none") return false;
      return window.getComputedStyle(tab).display !== "none";
    });
  }

  function activateTab(tabName, options = {}) {
    const tabs = visibleTabs();
    const requested = tabs.find((tab) => tab.dataset.tab === tabName);
    const active = requested || tabs.find((tab) => tab.classList.contains("active")) || tabs[0] || null;
    if (!active) return;
    const nextName = active.dataset.tab || "billing";
    tabList.querySelectorAll(".settings-tab[data-tab]").forEach((tab) => {
      const selected = tab === active;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    contentHost.querySelectorAll(":scope > .settings-tab-content").forEach((panel) => {
      const selected = panel.id === `settings-tab-${nextName}`;
      panel.classList.toggle("active", selected);
      panel.toggleAttribute("hidden", !selected);
    });
    const meta = SECTION_META[nextName] || SECTION_META.billing;
    eyebrow.textContent = meta.eyebrow;
    title.textContent = meta.title;
    description.textContent = meta.description;
    modal.dataset.settingsWorkspaceSection = nextName;
    if (options.focus) active.focus({ preventScroll: true });
  }

  function currentIdentity() {
    const profileName = document.getElementById("account-panel-name")?.textContent?.trim()
      || document.getElementById("auth-menu-name")?.textContent?.trim()
      || "";
    const sessionEmail = activeSession?.user?.email?.trim() || "";
    const profileEmail = document.getElementById("account-panel-email")?.textContent?.trim()
      || document.getElementById("auth-menu-email")?.textContent?.trim()
      || sessionEmail;
    const signedIn = Boolean(activeSession || profileEmail);
    const fallbackName = signedIn ? "Signed in" : "Guest workspace";
    const name = profileName && profileName !== "Signed in" ? profileName : fallbackName;
    return { signedIn, name, email: profileEmail || "Not signed in" };
  }

  function syncIdentity() {
    const identity = currentIdentity();
    const initialSource = identity.name !== "Signed in" && identity.name !== "Guest workspace"
      ? identity.name
      : identity.email;
    const initial = initialSource?.trim()?.charAt(0)?.toUpperCase() || "S";
    workspaceName.textContent = identity.name;
    workspaceEmail.textContent = identity.email;
    workspaceAvatar.textContent = initial;
    accountName.textContent = identity.name;
    accountEmail.textContent = identity.email;
    accountState.textContent = identity.signedIn ? "Signed in" : "Guest session";
    accountState.classList.toggle("is-signed-in", identity.signedIn);
    accountPlanAction.textContent = identity.signedIn ? "Manage plan" : "Log in to view plans";
    accountSessionAction.textContent = identity.signedIn ? "Sign out" : "Log in";
  }

  function readPlan() {
    const current = billingPanel?.querySelector(".billing-current h3")?.textContent?.trim();
    const status = billingPanel?.querySelector(".billing-current p")?.textContent?.trim();
    const plan = current || (currentIdentity().signedIn ? "Plan unavailable" : "Guest");
    workspacePlan.textContent = plan;
    accountPlan.textContent = status ? `${plan} · ${status}` : plan;
  }

  function decorateBilling() {
    if (!(billingPanel instanceof HTMLElement)) return;
    const current = billingPanel.querySelector(".billing-current");
    const usage = billingPanel.querySelector(".billing-usage-grid");
    const plans = billingPanel.querySelector(".billing-plan-grid");
    if (!current || !usage || !plans) {
      readPlan();
      return;
    }
    billingPanel.dataset.settingsBillingWorkspace = SETTINGS_WORKSPACE_VERSION;
    current.classList.add("settings-workspace-section", "billing-current-workspace");
    usage.classList.add("settings-workspace-section", "billing-usage-workspace");
    plans.classList.add("settings-workspace-section", "billing-plans-workspace");
    if (!usage.previousElementSibling?.matches("[data-settings-generated-heading='usage']")) {
      const heading = sectionHeading(
        "Rolling allowances",
        "Token and feature usage",
        "Standard and Lite track model input plus generated output. Other feature allowances remain separate.",
      );
      heading.dataset.settingsGeneratedHeading = "usage";
      usage.before(heading);
    }
    if (!plans.previousElementSibling?.matches("[data-settings-generated-heading='plans']")) {
      const heading = sectionHeading(
        "Available plans",
        "Compare and upgrade",
        "Choose the allowance level that best fits how often you use SentIQ Chat.",
      );
      heading.dataset.settingsGeneratedHeading = "plans";
      plans.before(heading);
    }
    billingPanel.querySelectorAll(".billing-plan-card").forEach((card) => {
      card.classList.add("billing-plan-row");
    });
    readPlan();
  }

  function decorateMemory() {
    if (!(memoryContent instanceof HTMLElement)) return;
    memoryContent.dataset.settingsMemoryWorkspace = SETTINGS_WORKSPACE_VERSION;
    const header = memoryContent.querySelector(".memory-manager-header");
    if (header && !header.querySelector(".memory-manager-heading-copy")) {
      const copy = document.createElement("div");
      copy.className = "memory-manager-heading-copy";
      copy.innerHTML = `
        <span class="settings-workspace-section-kicker">Stored context</span>
        <h4>Saved memories</h4>
        <p>Memories are grouped by type and ordered by importance. Delete any item that should no longer shape future chats.</p>
      `;
      header.prepend(copy);
    }
  }

  function scheduleDecoration() {
    if (decorateFrame) return;
    decorateFrame = window.requestAnimationFrame(() => {
      decorateFrame = 0;
      decorateBilling();
      decorateMemory();
      syncIdentity();
    });
  }

  tabList.addEventListener("click", (event) => {
    const tab = event.target.closest(".settings-tab[data-tab]");
    if (!tab) return;
    activateTab(tab.dataset.tab, { focus: false });
  });
  tabList.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = visibleTabs();
    if (!tabs.length) return;
    const currentIndex = Math.max(0, tabs.indexOf(document.activeElement));
    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    event.preventDefault();
    activateTab(tabs[nextIndex].dataset.tab, { focus: true });
  });

  modal.addEventListener("click", (event) => {
    const settingsTarget = event.target.closest("[data-settings-target-tab]");
    if (settingsTarget) {
      activateTab(settingsTarget.dataset.settingsTargetTab, { focus: true });
      return;
    }
    const trustTarget = event.target.closest("[data-settings-trust-target]");
    if (trustTarget) {
      window.SentIQTrustPanel?.open?.(trustTarget.dataset.settingsTrustTarget || "privacy");
    }
  });

  accountPlanAction?.addEventListener("click", () => {
    if (currentIdentity().signedIn) activateTab("billing", { focus: true });
    else document.getElementById("auth-login-btn")?.click();
  });
  accountSessionAction?.addEventListener("click", () => {
    const identity = currentIdentity();
    const target = identity.signedIn
      ? document.getElementById("account-signout-btn") || document.getElementById("auth-menu-logout-btn")
      : document.getElementById("auth-login-btn");
    target?.click();
  });

  document.addEventListener("sentiq-auth-changed", (event) => {
    activeSession = event?.detail?.session || null;
    scheduleDecoration();
  });

  const identityObserver = new MutationObserver(scheduleDecoration);
  [
    document.getElementById("account-panel-name"),
    document.getElementById("account-panel-email"),
    document.getElementById("auth-menu-name"),
    document.getElementById("auth-menu-email"),
  ].filter(Boolean).forEach((node) => identityObserver.observe(node, { childList: true, characterData: true, subtree: true }));

  if (billingPanel) {
    const billingObserver = new MutationObserver(scheduleDecoration);
    billingObserver.observe(billingPanel, { childList: true, subtree: true });
  }

  window.SentIQAuth?.getSession?.()
    .then((session) => { activeSession = session || null; })
    .catch(() => { activeSession = null; })
    .finally(scheduleDecoration);

  const initialActive = tabList.querySelector(".settings-tab.active[data-tab]")?.dataset.tab || "billing";
  activateTab(initialActive);
  scheduleDecoration();

  window.SentIQSettingsWorkspace = Object.freeze({
    version: SETTINGS_WORKSPACE_VERSION,
    activate: (tabName) => activateTab(tabName, { focus: false }),
    refresh: scheduleDecoration,
  });
}

initializeSettingsWorkspace();
