// ================================================================
// Billing Panel
// ================================================================
import { PRODUCT_NAME } from "../shared/brand.js";

(function () {
  const API = window.SentIQAPI;
  const panel = document.getElementById("billing-panel");
  const quotaChip = document.getElementById("composer-quota-chip");
  const accountBillingBtn = document.getElementById("auth-menu-billing-btn");
  const settingsModal = document.getElementById("settings-modal");

  let plansState = null;
  let billingState = null;
  let loadingPromise = null;

  function formatPrice(plan) {
    const price = Number(plan?.price_paise || 0);
    if (!price) return "Free";
    const amount = price / 100;
    return `${plan.currency || "INR"} ${amount.toLocaleString("en-IN", { maximumFractionDigits: 0 })}/${plan.interval || "month"}`;
  }

  function normalizeQuota(summary, feature) {
    const quota = summary?.quotas?.[feature] || {};
    return {
      label: quota.label || feature.replace(/_/g, " "),
      used: Number(quota.used || 0),
      reserved: Number(quota.reserved || 0),
      remaining: Number(quota.remaining || 0),
      limit: Number(quota.limit || 0),
      resetAt: quota.reset_at || null,
    };
  }

  function planName(planCode) {
    const plan = plansState?.plans?.find((item) => item.code === planCode);
    return plan?.name || "Free";
  }

  function usageText(quota) {
    if (!quota.limit) return "Not available";
    const left = Math.max(0, quota.remaining);
    return `${left}/${quota.limit} left`;
  }

  function renderMeter(feature, quota) {
    const used = Math.max(0, quota.used + quota.reserved);
    const percent = quota.limit > 0 ? Math.min(100, Math.round((used / quota.limit) * 100)) : 0;
    return `
      <div class="billing-meter" data-feature="${feature}">
        <div class="billing-meter-row">
          <span>${escapeHtml(quota.label)}</span>
          <strong>${escapeHtml(usageText(quota))}</strong>
        </div>
        <div class="billing-meter-track" aria-hidden="true"><span style="width:${percent}%"></span></div>
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

  function updateQuotaChip() {
    if (!quotaChip || !billingState?.summary) return;
    const summary = billingState.summary;
    const standard = normalizeQuota(summary, "premium_text");
    const lite = normalizeQuota(summary, "lite_text");
    const currentPlan = planName(summary.plan_code);
    let text = `${currentPlan}: ${usageText(standard)}`;
    let state = "standard";

    if (standard.remaining <= 0 && lite.limit > 0 && lite.remaining > 0) {
      text = `Lite: ${usageText(lite)}`;
      state = "lite";
    } else if (standard.remaining <= 0 && lite.remaining <= 0) {
      text = summary.plan_code === "free" ? "Free limit reached" : "Limit reached";
      state = "exhausted";
    }

    quotaChip.textContent = text;
    quotaChip.dataset.state = state;
    quotaChip.style.display = "inline-flex";
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
    const currentPlan = planName(summary.plan_code);
    const status = summary.status === "active" ? "Active" : summary.status === "canceling" ? "Cancels at renewal" : "Available";

    panel.innerHTML = `
      <div class="billing-current">
        <div>
          <span class="billing-eyebrow">Current plan</span>
          <h3>${escapeHtml(currentPlan)}</h3>
          <p>${escapeHtml(status)}</p>
        </div>
        <button id="billing-refresh-btn" class="btn btn-secondary" type="button">Refresh</button>
      </div>
      <div class="billing-usage-grid">
        ${renderMeter("premium_text", standard)}
        ${renderMeter("lite_text", lite)}
        ${renderMeter("image_generation", image)}
        ${renderMeter("advanced_reasoning", advanced)}
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

  async function refreshBilling(force = false) {
    if (!API || (!force && loadingPromise)) return loadingPromise;
    loadingPromise = Promise.all([
      API.getBillingPlans(),
      API.getBillingMe(),
    ]).then(([plans, me]) => {
      plansState = plans;
      billingState = me;
      renderPanel();
      updateQuotaChip();
    }).catch((error) => {
      if (panel) panel.innerHTML = `<div class="billing-panel-status error">${escapeHtml(error?.message || "Billing details are unavailable.")}</div>`;
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
    settingsModal.querySelectorAll(".settings-tab").forEach((tab) => tab.classList.remove("active"));
    settingsModal.querySelectorAll(".settings-tab-content").forEach((content) => content.classList.remove("active"));
    settingsModal.querySelector('[data-tab="billing"]')?.classList.add("active");
    document.getElementById("settings-tab-billing")?.classList.add("active");
  }

  function openBilling() {
    window.SentIQChat?.openSettings?.();
    activateBillingTab();
    refreshBilling(true);
  }

  accountBillingBtn?.addEventListener("click", openBilling);
  quotaChip?.addEventListener("click", openBilling);
  document.addEventListener("sentiq-auth-changed", () => refreshBilling(true));
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
