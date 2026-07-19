// ================================================================
// Billing Panel
// ================================================================
import { PRODUCT_NAME } from "../shared/brand.js";
import { calculateUsagePercent, formatCompactTokenNumber } from "./billing-usage-format.js";

(function () {
  const API = window.SentIQAPI;
  const panel = document.getElementById("billing-panel");
  const accountBillingBtn = document.getElementById("auth-menu-billing-btn");
  const settingsModal = document.getElementById("settings-modal");

  let plansState = null;
  let billingState = null;
  let loadingPromise = null;
  let billingVisible = false;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatPrice(plan) {
    const price = Number(plan?.price_paise || 0);
    if (!price) return "Free";
    const amount = price / 100;
    return `${plan.currency || "INR"} ${amount.toLocaleString("en-IN", { maximumFractionDigits: 0 })}/${plan.interval || "month"}`;
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(date);
  }

  function quotaLabel(feature, fallback) {
    if (feature === "premium_text") return "Standard";
    if (feature === "lite_text") return "Lite";
    if (feature === "image_generation") return "Image generation";
    if (feature === "advanced_reasoning") return "Advanced reasoning";
    if (feature === "deep_research") return "Deep Research";
    return fallback || feature.replace(/_/g, " ");
  }

  function normalizeQuota(summary, feature) {
    const quota = summary?.quotas?.[feature] || {};
    return {
      label: quotaLabel(feature, quota.label),
      used: Number(quota.used || 0),
      reserved: Number(quota.reserved || 0),
      remaining: Number(quota.remaining || 0),
      limit: Number(quota.limit || 0),
      resetAt: quota.reset_at || null,
      windowStart: quota.window_start || null,
      available: quota.available !== false,
      isTokenPool: feature === "premium_text" || feature === "lite_text",
    };
  }

  function planForCode(planCode) {
    return plansState?.plans?.find((item) => item.code === planCode) || null;
  }

  function planName(planCode) {
    return planForCode(planCode)?.name || "Free";
  }

  function formatStatus(summary) {
    if (summary.status === "active") return "Active";
    if (summary.status === "canceling") return "Cancels at renewal";
    if (summary.status === "past_due") return "Payment attention needed";
    return "Available";
  }

  function formatReset(quota) {
    const date = formatDate(quota.resetAt);
    return date ? `Resets ${date}` : "Rolling allowance";
  }

  function renderTokenAllowance(feature, quota) {
    const percent = calculateUsagePercent(quota.limit, quota.remaining);
    const remaining = Math.max(0, quota.remaining);
    const used = Math.max(0, quota.limit - remaining);
    const unavailable = !quota.available || !quota.limit;
    return `
      <article class="billing-token-allowance ${unavailable ? "is-unavailable" : ""}" data-feature="${feature}">
        <div class="billing-token-heading">
          <div>
            <span class="billing-token-name">${escapeHtml(quota.label)}</span>
            <span class="billing-token-description">${feature === "premium_text" ? "Higher-intelligence responses and tool-backed work" : "Faster everyday responses and lighter tasks"}</span>
          </div>
          <div class="billing-token-value">
            <strong>${unavailable ? "Unavailable" : `${formatCompactTokenNumber(remaining)} left`}</strong>
            <span>${unavailable ? "Not included in this plan" : `of ${formatCompactTokenNumber(quota.limit)}`}</span>
          </div>
        </div>
        <div class="billing-token-track" role="progressbar" aria-label="${escapeHtml(quota.label)} usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${unavailable ? 0 : percent}">
          <span style="width:${unavailable ? 0 : percent}%"></span>
        </div>
        <div class="billing-token-footnote">
          <span>${unavailable ? "Upgrade to unlock" : `${formatCompactTokenNumber(used)} used`}</span>
          <span>${escapeHtml(formatReset(quota))}</span>
        </div>
      </article>
    `;
  }

  function renderCapability(feature, quota) {
    const unavailable = !quota.available || !quota.limit;
    const remaining = Math.max(0, quota.remaining);
    const usage = unavailable ? "Not included" : `${remaining} of ${quota.limit} left`;
    return `
      <div class="billing-capability-row" data-feature="${feature}">
        <span class="billing-capability-icon" aria-hidden="true"></span>
        <span class="billing-capability-copy">
          <strong>${escapeHtml(quota.label)}</strong>
          <span>${escapeHtml(formatReset(quota))}</span>
        </span>
        <span class="billing-capability-value ${unavailable ? "is-unavailable" : ""}">${escapeHtml(usage)}</span>
      </div>
    `;
  }

  function renderPlanOption(plan, summary, currentPlan, nextUpgradeCode) {
    const current = plan.code === summary.plan_code;
    const currentPrice = Number(currentPlan?.price_paise || 0);
    const planPrice = Number(plan?.price_paise || 0);
    const upgrade = planPrice > currentPrice;
    const nextUpgrade = plan.code === nextUpgradeCode;
    const disabled = current || plan.code === "free";
    const actionLabel = current ? "Current plan" : plan.code === "free" ? "Included" : upgrade ? "Upgrade" : "Switch plan";
    return `
      <article class="billing-plan-option ${current ? "is-current" : ""} ${nextUpgrade ? "is-recommended" : ""}">
        <div class="billing-plan-option-copy">
          <div class="billing-plan-option-title-row">
            <h4>${escapeHtml(plan.name)}</h4>
            ${current ? '<span class="billing-plan-badge">Current</span>' : nextUpgrade ? '<span class="billing-plan-badge is-accent">Next step</span>' : ""}
          </div>
          <p>${escapeHtml(plan.description || "")}</p>
        </div>
        <div class="billing-plan-option-meta">
          <span class="billing-plan-price">${escapeHtml(formatPrice(plan))}</span>
          <button class="btn ${current ? "btn-secondary" : "btn-primary"} billing-plan-action" type="button" data-plan-code="${escapeHtml(plan.code)}" ${disabled ? "disabled" : ""}>${actionLabel}</button>
        </div>
      </article>
    `;
  }

  function dispatchBillingSummary(summary, currentPlanName) {
    window.dispatchEvent(new CustomEvent("sentiq-billing-summary", {
      detail: {
        planCode: summary.plan_code || "free",
        planName: currentPlanName,
        status: summary.status || "available",
      },
    }));
  }

  function renderPanel() {
    if (!panel) return;
    if (!plansState || !billingState) {
      panel.innerHTML = `
        <div class="billing-panel-status" role="status">
          <span class="billing-loading-dot" aria-hidden="true"></span>
          Loading plan and usage…
        </div>
      `;
      return;
    }

    const summary = billingState.summary || {};
    const standard = normalizeQuota(summary, "premium_text");
    const lite = normalizeQuota(summary, "lite_text");
    const image = normalizeQuota(summary, "image_generation");
    const advanced = normalizeQuota(summary, "advanced_reasoning");
    const deepResearch = normalizeQuota(summary, "deep_research");
    const currentPlan = planForCode(summary.plan_code) || { code: "free", name: "Free", price_paise: 0 };
    const currentPlanName = currentPlan.name || planName(summary.plan_code);
    const status = formatStatus(summary);
    const plans = Array.isArray(plansState.plans) ? plansState.plans : [];
    const currentPrice = Number(currentPlan.price_paise || 0);
    const nextUpgrade = plans
      .filter((plan) => Number(plan.price_paise || 0) > currentPrice)
      .sort((left, right) => Number(left.price_paise || 0) - Number(right.price_paise || 0))[0]?.code || "";

    panel.innerHTML = `
      <div class="settings-section-heading billing-section-heading">
        <span class="settings-section-eyebrow">Plan &amp; usage</span>
        <h3>Your SentIQ Chat plan</h3>
        <p>See the allowances available to this account and upgrade only when your workflow needs more room.</p>
      </div>

      <section class="billing-plan-overview" aria-label="Current plan">
        <div class="billing-plan-overview-copy">
          <span class="billing-plan-kicker">Current plan</span>
          <div class="billing-plan-name-row">
            <h4>${escapeHtml(currentPlanName)}</h4>
            <span class="billing-status-badge">${escapeHtml(status)}</span>
          </div>
          <p>${escapeHtml(currentPlan.description || "Your current SentIQ Chat access and allowances.")}</p>
        </div>
        <div class="billing-plan-overview-actions">
          <span class="billing-current-price">${escapeHtml(formatPrice(currentPlan))}</span>
          <button id="billing-refresh-btn" class="btn btn-secondary billing-refresh-btn" type="button" aria-label="Refresh billing details">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>
            Refresh
          </button>
        </div>
      </section>

      <section class="billing-usage-section" aria-labelledby="billing-token-usage-title">
        <div class="billing-subsection-heading">
          <div><span class="billing-subsection-eyebrow">Rolling allowance</span><h4 id="billing-token-usage-title">Token usage</h4></div>
          <p>Input and generated output both count toward these pools.</p>
        </div>
        <div class="billing-token-list">
          ${renderTokenAllowance("premium_text", standard)}
          ${renderTokenAllowance("lite_text", lite)}
        </div>
      </section>

      <section class="billing-capability-section" aria-labelledby="billing-capabilities-title">
        <div class="billing-subsection-heading">
          <div><span class="billing-subsection-eyebrow">Specialised tools</span><h4 id="billing-capabilities-title">Other allowances</h4></div>
        </div>
        <div class="billing-capability-list">
          ${renderCapability("image_generation", image)}
          ${renderCapability("advanced_reasoning", advanced)}
          ${renderCapability("deep_research", deepResearch)}
        </div>
      </section>

      <section class="billing-upgrade-section" aria-labelledby="billing-upgrade-title">
        <div class="billing-subsection-heading billing-upgrade-heading">
          <div><span class="billing-subsection-eyebrow">Plans</span><h4 id="billing-upgrade-title">Upgrade or change plan</h4></div>
          <p>Checkout opens only after you choose a plan.</p>
        </div>
        <div class="billing-plan-list">
          ${plans.map((plan) => renderPlanOption(plan, summary, currentPlan, nextUpgrade)).join("")}
        </div>
      </section>
      <div id="billing-panel-message" class="billing-panel-message" aria-live="polite"></div>
    `;

    dispatchBillingSummary(summary, currentPlanName);
    panel.querySelector("#billing-refresh-btn")?.addEventListener("click", () => refreshBilling(true));
    panel.querySelectorAll("[data-plan-code]").forEach((button) => {
      button.addEventListener("click", () => startCheckout(button.getAttribute("data-plan-code") || ""));
    });
  }

  function getVisibleSettingsTabs() {
    if (!settingsModal) return [];
    return Array.from(settingsModal.querySelectorAll(".settings-tab[data-tab]"))
      .filter((tab) => tab.style.display !== "none" && !tab.hidden);
  }

  function activateSettingsTab(tabName) {
    if (!settingsModal) return;
    if (window.SentIQSettingsWorkspace?.activateTab) {
      window.SentIQSettingsWorkspace.activateTab(tabName);
      return;
    }
    const visibleTabs = getVisibleSettingsTabs();
    const requestedTab = visibleTabs.find((tab) => tab.getAttribute("data-tab") === tabName);
    const activeTab = requestedTab || visibleTabs[0] || null;
    const activeTabName = activeTab?.getAttribute("data-tab") || "";

    settingsModal.querySelectorAll(".settings-tab[data-tab]").forEach((tab) => {
      const isActive = tab === activeTab;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
      tab.setAttribute("tabindex", isActive ? "0" : "-1");
    });
    settingsModal.querySelectorAll(".settings-tab-content").forEach((content) => {
      const isActive = content.id === `settings-tab-${activeTabName}`;
      content.classList.toggle("active", isActive);
      content.toggleAttribute("hidden", !isActive);
    });
  }

  function setBillingVisibility(visible) {
    billingVisible = Boolean(visible);
    const billingTab = settingsModal?.querySelector('[data-tab="billing"]');
    const billingContent = document.getElementById("settings-tab-billing");
    if (billingTab) billingTab.style.display = billingVisible ? "" : "none";
    if (billingContent) billingContent.style.display = billingVisible ? "" : "none";
    if (accountBillingBtn) accountBillingBtn.style.display = billingVisible ? "" : "none";
    if (!billingVisible && billingTab?.classList.contains("active")) activateSettingsTab();
  }

  async function hasAuthenticatedBillingSession() {
    try {
      const session = await window.SentIQAuth?.getSession?.();
      return Boolean(session);
    } catch {
      return false;
    }
  }

  function clearBillingPanel() {
    plansState = null;
    billingState = null;
    if (panel) panel.innerHTML = "";
    dispatchBillingSummary({ plan_code: "free", status: "available" }, "Free");
  }

  async function refreshBilling(force = false) {
    const signedIn = await hasAuthenticatedBillingSession();
    setBillingVisibility(signedIn);
    if (!signedIn) {
      clearBillingPanel();
      return null;
    }
    if (!API || (!force && loadingPromise)) return loadingPromise;
    if (force && panel) {
      panel.innerHTML = '<div class="billing-panel-status" role="status"><span class="billing-loading-dot" aria-hidden="true"></span>Refreshing plan and usage…</div>';
    }
    loadingPromise = Promise.all([
      API.getBillingPlans(),
      API.getBillingMe(),
    ]).then(([plans, me]) => {
      plansState = plans;
      billingState = me;
      renderPanel();
    }).catch((error) => {
      if (panel) {
        panel.innerHTML = `
          <div class="billing-panel-status error" role="alert">
            <strong>Billing details are unavailable.</strong>
            <span>${escapeHtml(error?.message || "Please try again in a moment.")}</span>
            <button id="billing-retry-btn" class="btn btn-secondary" type="button">Retry</button>
          </div>
        `;
        panel.querySelector("#billing-retry-btn")?.addEventListener("click", () => refreshBilling(true));
      }
    }).finally(() => {
      loadingPromise = null;
    });
    return loadingPromise;
  }

  function setPanelMessage(message) {
    const messageNode = document.getElementById("billing-panel-message");
    if (messageNode) messageNode.textContent = message;
  }

  function loadRazorpayScript() {
    if (window.Razorpay) return Promise.resolve(true);
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.onload = () => resolve(Boolean(window.Razorpay));
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }

  async function startCheckout(planCode) {
    if (!planCode || !API) return;
    setPanelMessage("Preparing checkout…");
    try {
      const result = await API.startBillingCheckout(planCode);
      if (result.status !== "created" || !result.checkout?.subscription_id) {
        setPanelMessage(result.message || "Checkout is not available for this plan yet.");
        return;
      }
      const available = await loadRazorpayScript();
      if (!available) {
        setPanelMessage("Payment checkout could not load. Please try again.");
        return;
      }
      const checkout = result.checkout;
      const razorpay = new window.Razorpay({
        key: checkout.key_id,
        subscription_id: checkout.subscription_id,
        name: PRODUCT_NAME,
        description: `${PRODUCT_NAME} plan`,
        handler: async (payload) => {
          setPanelMessage("Verifying payment…");
          await API.verifyBillingCheckout(payload);
          await refreshBilling(true);
          setPanelMessage("Plan update is being applied.");
        },
        modal: {
          ondismiss: () => setPanelMessage("Checkout closed."),
        },
      });
      razorpay.open();
    } catch (error) {
      setPanelMessage(error?.message || "Checkout could not start.");
    }
  }

  function activateBillingTab() {
    if (!settingsModal) return;
    activateSettingsTab("billing");
  }

  async function openBilling() {
    const signedIn = await hasAuthenticatedBillingSession();
    setBillingVisibility(signedIn);
    if (!signedIn) return;
    window.SentIQChat?.openSettings?.();
    activateBillingTab();
    refreshBilling(true);
  }

  accountBillingBtn?.addEventListener("click", openBilling);
  document.addEventListener("sentiq-auth-changed", (event) => {
    const signedIn = Boolean(event?.detail?.session);
    setBillingVisibility(signedIn);
    if (signedIn) refreshBilling(true);
    else clearBillingPanel();
  });
  window.addEventListener("sentiq-billing-refresh", () => refreshBilling(true));

  window.SentIQBilling = {
    refresh: refreshBilling,
    open: openBilling,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => refreshBilling(true), { once: true });
  } else {
    refreshBilling(true);
  }
})();
