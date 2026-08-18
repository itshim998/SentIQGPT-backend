// ================================================================
// Billing Panel
// ================================================================
import { PRODUCT_NAME } from "../shared/brand.js";
import { calculateUsagePercent, formatCompactTokenNumber } from "./billing-usage-format.js";
import { formatRecoveryCountdown, normalizeTextAllowance } from "../features/text-quota-state.mjs";
import "../features/text-quota-controller.js";

(function () {
  const API = window.SentIQAPI;
  const panel = document.getElementById("billing-panel");
  const accountBillingBtn = document.getElementById("auth-menu-billing-btn");
  const settingsModal = document.getElementById("settings-modal");

  let plansState = null;
  let billingState = null;
  let loadingPromise = null;
  let billingVisible = false;

  function formatPrice(plan) {
    const price = Number(plan?.price_paise || 0);
    if (!price) return "Free";
    const amount = price / 100;
    return `${plan.currency || "INR"} ${amount.toLocaleString("en-IN", { maximumFractionDigits: 0 })}/${plan.interval || "month"}`;
  }

  function normalizeQuota(summary, feature) {
    const quota = summary?.quotas?.[feature] || {};
    let label = quota.label || feature.replace(/_/g, " ");
    if (feature === "deep_research") label = "Deep Researches";
    return {
      label,
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

  function planName(planCode) {
    const plan = plansState?.plans?.find((item) => item.code === planCode);
    return plan?.name || "Free";
  }

  function usageText(quota) {
    if (!quota.available || !quota.limit) return "Not available";
    const left = Math.max(0, quota.remaining);
    if (quota.isTokenPool) {
      return `${formatCompactTokenNumber(left)} / ${formatCompactTokenNumber(quota.limit)} left`;
    }
    return `${left}/${quota.limit} left`;
  }

  function renderMeter(feature, quota) {
    const percent = calculateUsagePercent(quota.limit, quota.remaining);
    const tokenDescription = quota.isTokenPool
      ? '<span class="billing-meter-description">Counts model input and generated output within your rolling allowance.</span>'
      : "";
    return `
      <div class="billing-meter" data-feature="${feature}" ${quota.isTokenPool ? 'aria-description="Counts model input and generated output within your rolling allowance."' : ""}>
        <div class="billing-meter-row">
          <span>${escapeHtml(quota.label)}</span>
          <strong>${escapeHtml(usageText(quota))}</strong>
        </div>
        <div class="billing-meter-track" aria-hidden="true"><span style="width:${percent}%"></span></div>
        ${tokenDescription}
      </div>
    `;
  }

  function renderUnifiedTextMeter(rawAllowance) {
    const allowance = normalizeTextAllowance(rawAllowance);
    if (!allowance) return "";
    const percent = calculateUsagePercent(allowance.limitTokens, allowance.remainingTokens);
    return `
      <div class="billing-meter billing-meter-unified" data-feature="unified_text" aria-description="One shared rolling text-token allowance.">
        <div class="billing-meter-row">
          <span>Text tokens</span>
          <strong>${escapeHtml(`${formatCompactTokenNumber(allowance.remainingTokens)} / ${formatCompactTokenNumber(allowance.limitTokens)} left`)}</strong>
        </div>
        <div class="billing-meter-track billing-meter-track-unified" aria-hidden="true">
          <span style="width:${percent}%"></span>
          <i style="left:${Math.max(0, Math.min(100, ((allowance.limitTokens - allowance.fastReserveTokens) / Math.max(1, allowance.limitTokens)) * 100))}%"></i>
        </div>
      </div>
    `;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderPanel() {
    if (!panel) return;
    if (!plansState || !billingState) {
      panel.innerHTML = '<div class="billing-panel-status">Loading billing details...</div>';
      return;
    }

    const summary = billingState.summary || {};
    const standard = normalizeQuota(summary, "premium_text");
    const lite = normalizeQuota(summary, "lite_text");
    const image = normalizeQuota(summary, "image_generation");
    const advanced = normalizeQuota(summary, "advanced_reasoning");
    const deepResearch = normalizeQuota(summary, "deep_research");
    const unifiedTextActive = billingState.quota_ui_enabled === true
      && Boolean(normalizeTextAllowance(summary.text_allowance));
    const currentPlan = planName(summary.plan_code);
    const status = summary.status === "active" ? "Active" : summary.status === "canceling" ? "Cancels at renewal" : "";

    panel.innerHTML = `
      <div class="billing-current">
        <div>
          <span class="billing-eyebrow">Current plan</span>
          <h3>${escapeHtml(currentPlan)}</h3>
          ${status ? `<p>${escapeHtml(status)}</p>` : ""}
        </div>
        <button id="billing-refresh-btn" class="btn btn-secondary billing-refresh-btn" type="button" aria-label="Refresh plan limits" title="Refresh">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
            <path d="M3 3v5h5"></path>
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
            <path d="M21 21v-5h-5"></path>
          </svg>
        </button>
      </div>
      <div class="billing-usage-grid">
        ${unifiedTextActive
          ? renderUnifiedTextMeter(summary.text_allowance)
          : `${renderMeter("premium_text", standard)}${renderMeter("lite_text", lite)}`}
        ${renderMeter("image_generation", image)}
        ${renderMeter("advanced_reasoning", advanced)}
        ${renderMeter("deep_research", deepResearch)}
      </div>
      <div class="billing-plan-grid">
        ${(plansState.plans || []).map((plan) => `
          <article class="billing-plan-card ${plan.code === summary.plan_code ? "active" : ""}">
            <div>
              <h4>${escapeHtml(plan.name)}</h4>
              <p>${escapeHtml(plan.description || "")}</p>
            </div>
            <div class="billing-plan-price">${escapeHtml(formatPrice(plan))}</div>
            <button class="btn ${plan.code === summary.plan_code ? "btn-secondary" : "btn-primary"} billing-plan-action" type="button" data-plan-code="${escapeHtml(plan.code)}" ${plan.code === summary.plan_code || plan.code === "free" ? "disabled" : ""}>
              ${plan.code === summary.plan_code ? "Current" : plan.code === "free" ? "Included" : "Choose plan"}
            </button>
          </article>
        `).join("")}
      </div>
      <div id="billing-panel-message" class="billing-panel-message" aria-live="polite"></div>
    `;

    panel.querySelector("#billing-refresh-btn")?.addEventListener("click", () => refreshBilling(true));
    panel.querySelectorAll("[data-plan-code]").forEach((button) => {
      button.addEventListener("click", () => startCheckout(button.getAttribute("data-plan-code") || ""));
    });
  }

  function getVisibleSettingsTabs() {
    if (!settingsModal) return [];
    return Array.from(settingsModal.querySelectorAll(".settings-tab[data-tab]"))
      .filter((tab) => tab.style.display !== "none");
  }

  function activateSettingsTab(tabName) {
    if (!settingsModal) return;
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
  }

  async function refreshBilling(force = false) {
    const signedIn = await hasAuthenticatedBillingSession();
    setBillingVisibility(signedIn);
    if (!signedIn) {
      clearBillingPanel();
      return null;
    }
    if (!API || (!force && loadingPromise)) return loadingPromise;
    const refreshBtn = panel?.querySelector("#billing-refresh-btn");
    refreshBtn?.classList.add("is-refreshing");
    loadingPromise = Promise.all([
      API.getBillingPlans(),
      API.getBillingMe(),
    ]).then(([plans, me]) => {
      plansState = plans;
      billingState = me;
      window.dispatchEvent(new CustomEvent("sentiq-billing-summary", { detail: me }));
      renderPanel();
      return me;
    }).catch((error) => {
      if (panel) panel.innerHTML = `<div class="billing-panel-status error">${escapeHtml(error?.message || "Billing details are unavailable.")}</div>`;
      return null;
    }).finally(() => {
      loadingPromise = null;
      refreshBtn?.classList.remove("is-refreshing");
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
    setPanelMessage("Preparing checkout...");
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
          setPanelMessage("Verifying payment...");
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
