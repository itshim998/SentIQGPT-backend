/* SentIQ Liquid Glass V4 — Phase 9.3 capability-aware actions */

import { CAPABILITY_MODEL_VERSION, DEFAULT_CAPABILITY_FACTS, deriveCapabilitySnapshot } from "./capability-model.mjs";
import { createCapabilityExplainer } from "./capability-explanation.js";
import { getPlanDisplayName } from "./free-tool-execution-policy.mjs";

const CAPABILITY_AWARENESS_VERSION = "9.3";
const REFRESH_STALE_MS = 60_000;
const CONTROLS = Object.freeze([
  { capability: "upload", selector: "#file-attach-btn, [data-starter-action='file']" },
  { capability: "image-generation", selector: "#image-gen-btn" },
  { capability: "deep-research", selector: "#deep-research-btn" },
  { capability: "live", selector: "#live-beta-btn" },
]);
const CONTROL_SELECTOR = CONTROLS.map(({ selector }) => selector).join(",");
const OBSERVED_CAPABILITY_SELECTOR = `${CONTROL_SELECTOR}, #file-input`;

function initializeCapabilityAwareness() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQCapabilities?.version === CAPABILITY_AWARENESS_VERSION) return;

  const API = window.SentIQAPI;
  const Auth = window.SentIQAuth;
  const fileInput = document.getElementById("file-input");
  const originalTitles = new WeakMap();
  const originalSubtitles = new WeakMap();
  const ownedDisabledInputs = new WeakSet();
  const helpNodes = new Map();
  const listeners = new Set();
  let facts = {
    ...DEFAULT_CAPABILITY_FACTS,
    online: navigator.onLine !== false,
    uploadSupported: typeof File === "function" && typeof FormData === "function" && typeof fetch === "function",
    uploadInputReady: fileInput instanceof HTMLInputElement,
    uploadApiReady: typeof API?.uploadFile === "function",
  };
  let snapshot = deriveCapabilitySnapshot(facts);
  let refreshSequence = 0;
  let refreshPromise = null;
  let lastRefreshAt = 0;

  const explainer = createCapabilityExplainer({
    onAction(cta) {
      if (cta === "sign-in") document.getElementById("auth-login-btn")?.click();
      if (cta === "upgrade") window.SentIQBilling?.open?.();
    },
  });

  function setAttributeIfChanged(element, name, value) {
    const next = String(value);
    if (element.getAttribute(name) !== next) element.setAttribute(name, next);
  }

  function setTextIfChanged(element, value) {
    const next = String(value ?? "");
    if (element.textContent !== next) element.textContent = next;
  }

  function helpNode(key) {
    if (helpNodes.has(key)) return helpNodes.get(key);
    const node = document.createElement("span");
    node.id = `sentiq-capability-help-${key}`;
    node.className = "sr-only sentiq-capability-help";
    document.body.appendChild(node);
    helpNodes.set(key, node);
    return node;
  }

  function appendDescription(control, id) {
    const ids = new Set((control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    ids.add(id);
    setAttributeIfChanged(control, "aria-describedby", [...ids].join(" "));
  }

  function compactReason(capability) {
    const labels = {
      "sign-in-required": "Sign in required",
      "plan-restricted": "Not included in this plan",
      "limit-reached": "Allowance used",
      cooldown: "Available again shortly",
      offline: "Internet connection required",
      checking: "Checking availability…",
      unavailable: "Unavailable right now",
    };
    return capability.state === "busy" && capability.key === "upload"
      ? "Upload already in progress"
      : labels[capability.state] || "Temporarily busy";
  }

  function capabilityFor(control) {
    const key = control?.dataset?.capabilityKey
      || CONTROLS.find(({ selector }) => control?.matches?.(selector))?.capability;
    return key ? snapshot.capabilities[key] || null : null;
  }

  function syncSubtitle(control, capability) {
    const subtitle = control.querySelector?.(".composer-action-subtitle");
    if (!(subtitle instanceof HTMLElement)) return;
    if (!originalSubtitles.has(subtitle)) originalSubtitles.set(subtitle, subtitle.textContent || "");
    const interactive = capability.interactive !== undefined ? capability.interactive : capability.available;
    if (interactive) {
      setTextIfChanged(subtitle, originalSubtitles.get(subtitle));
      subtitle.removeAttribute("data-capability-copy");
    } else {
      setTextIfChanged(subtitle, compactReason(capability));
      subtitle.dataset.capabilityCopy = "reason";
    }
  }

  function syncControl(control, capability) {
    if (!(control instanceof HTMLElement) || !capability) return;
    if (!originalTitles.has(control)) originalTitles.set(control, control.getAttribute("title"));
    const interactive = capability.interactive !== undefined ? capability.interactive : capability.available;
    control.dataset.capabilityKey = capability.key;
    control.dataset.capabilityState = capability.state;
    control.dataset.capabilityAvailable = String(capability.available);
    control.dataset.capabilityInteractive = String(interactive);
    control.dataset.capabilityReason = capability.reason;
    control.classList.toggle("is-capability-blocked", !interactive);
    control.classList.toggle("is-capability-checking", capability.state === "checking");
    setAttributeIfChanged(control, "aria-disabled", interactive ? "false" : "true");
    const help = helpNode(capability.key);
    setTextIfChanged(help, capability.reason);
    appendDescription(control, help.id);
    const originalTitle = originalTitles.get(control);
    if (interactive && originalTitle === null) control.removeAttribute("title");
    else setAttributeIfChanged(control, "title", interactive ? (originalTitle || "") : capability.reason);
    syncSubtitle(control, capability);
  }

  function syncUploadInput(capability) {
    if (!(fileInput instanceof HTMLInputElement)) return;
    const interactive = capability.interactive !== undefined ? capability.interactive : capability.available;
    fileInput.dataset.capabilityKey = "upload";
    fileInput.dataset.capabilityState = capability.state;
    fileInput.dataset.capabilityAvailable = String(capability.available);
    fileInput.dataset.capabilityInteractive = String(interactive);
    fileInput.dataset.capabilityReason = capability.reason;
    if (!interactive && !fileInput.disabled) {
      fileInput.disabled = true;
      ownedDisabledInputs.add(fileInput);
    } else if (interactive && ownedDisabledInputs.has(fileInput)) {
      fileInput.disabled = false;
      ownedDisabledInputs.delete(fileInput);
    }
  }

  function applySnapshot() {
    CONTROLS.forEach(({ capability: key, selector }) => {
      document.querySelectorAll(selector).forEach((control) => syncControl(control, snapshot.capabilities[key]));
    });
    syncUploadInput(snapshot.capabilities.upload);
    document.documentElement.dataset.capabilityAwarenessVersion = CAPABILITY_AWARENESS_VERSION;
    document.documentElement.dataset.capabilityBlocked = snapshot.blocked.join(" ");
    const openCapability = explainer.getCurrent();
    if (openCapability) explainer.update(snapshot.capabilities[openCapability.key]);
    document.dispatchEvent(new CustomEvent("sentiq-capabilities-change", { detail: snapshot }));
    listeners.forEach((listener) => { try { listener(snapshot); } catch { /* isolated */ } });
  }

  function patchFacts(patch = {}) {
    facts = { ...facts, ...patch };
    snapshot = deriveCapabilitySnapshot(facts);
    applySnapshot();
    return snapshot;
  }

  function extractQuota(payload, feature) {
    if (!payload || typeof payload !== "object") return null;
    return payload?.summary?.quotas?.[feature]
      || payload?.billing?.summary?.quotas?.[feature]
      || payload?.quotas?.[feature]
      || payload?.entitlements?.quotas?.[feature]
      || payload?.[feature]
      || payload?.quota
      || payload;
  }

  function billingSummary(payload) {
    return payload?.summary || payload?.billing?.summary || payload || {};
  }

  async function resolveSession(explicitSession) {
    if (explicitSession !== undefined) return explicitSession || null;
    try { return await Auth?.getSession?.() || null; } catch { return null; }
  }

  async function refresh(options = {}) {
    if (refreshPromise && !options.force) return refreshPromise;
    const sequence = ++refreshSequence;
    refreshPromise = (async () => {
      const session = await resolveSession(options.session);
      if (sequence !== refreshSequence) return snapshot;
      const authenticated = Boolean(session?.user);
      patchFacts({ authKnown: true, authenticated });
      if (!authenticated) {
        patchFacts({
          planKnown: true, planError: false, planCode: "guest", planName: "Guest",
          imageBillingQuota: null, imageQuotaKnown: true, imageQuotaError: false, imageQuota: null,
          deepResearchBillingQuota: null, deepResearchQuotaKnown: true, deepResearchQuotaError: false, deepResearchQuota: null,
          liveKnown: true, liveError: false,
          liveStatus: { enabled: true, available: false, reason: "sign_in_required" },
        });
        lastRefreshAt = Date.now();
        return snapshot;
      }

      patchFacts({
        planKnown: false, planError: false,
        imageQuotaKnown: false, imageQuotaError: false,
        deepResearchQuotaKnown: false, deepResearchQuotaError: false,
        liveKnown: false, liveError: false,
      });
      const unavailable = (label) => Promise.reject(new Error(`${label} unavailable`));
      const requests = [
        API?.getBillingMe?.() || unavailable("Billing API"),
        API?.getBillingPlans?.() || unavailable("Plan API"),
        API?.getImageQuota?.() || unavailable("Image quota API"),
        API?.getDeepResearchQuota?.() || unavailable("Deep Research quota API"),
        API?.getLiveStatus?.() || unavailable("Live status API"),
      ];
      const [billingResult, plansResult, imageResult, researchResult, liveResult] = await Promise.allSettled(requests);
      if (sequence !== refreshSequence) return snapshot;
      const billing = billingResult.status === "fulfilled" ? billingSummary(billingResult.value) : {};
      const planCode = String(billing.plan_code || billing.planCode || "").trim().toLowerCase();
      const plans = plansResult.status === "fulfilled" && Array.isArray(plansResult.value?.plans) ? plansResult.value.plans : [];
      patchFacts({
        planKnown: true,
        planError: billingResult.status === "rejected",
        planCode,
        planName: plans.find((plan) => plan?.code === planCode)?.name || getPlanDisplayName(planCode, ""),
        imageBillingQuota: extractQuota(billing, "image_generation"),
        imageQuotaKnown: true,
        imageQuotaError: imageResult.status === "rejected",
        imageQuota: imageResult.status === "fulfilled" ? extractQuota(imageResult.value, "image_generation") : null,
        deepResearchBillingQuota: extractQuota(billing, "deep_research"),
        deepResearchQuotaKnown: true,
        deepResearchQuotaError: researchResult.status === "rejected",
        deepResearchQuota: researchResult.status === "fulfilled" ? extractQuota(researchResult.value, "deep_research") : null,
        liveKnown: true,
        liveError: liveResult.status === "rejected",
        liveStatus: liveResult.status === "fulfilled" ? liveResult.value : null,
      });
      lastRefreshAt = Date.now();
      return snapshot;
    })().finally(() => { if (sequence === refreshSequence) refreshPromise = null; });
    return refreshPromise;
  }

  function explain(target, options = {}) {
    const control = target instanceof Element ? target.closest(CONTROL_SELECTOR) || target : null;
    const capability = capabilityFor(control);
    const interactive = capability?.interactive !== undefined ? capability.interactive : capability?.available;
    if (!capability || interactive) return false;
    return explainer.open(capability, options.anchor || control, { focus: options.focus });
  }

  function blockedControl(event) {
    if (!(event.target instanceof Element)) return null;
    const control = event.target.closest(CONTROL_SELECTOR);
    const capability = capabilityFor(control);
    const interactive = capability?.interactive !== undefined ? capability.interactive : capability?.available;
    return control instanceof HTMLElement && capability && !interactive ? control : null;
  }

  function containsAddedCapabilityControl(records) {
    return records.some((record) => Array.from(record.addedNodes).some((node) => (
      node instanceof Element
      && (
        node.matches(OBSERVED_CAPABILITY_SELECTOR)
        || Boolean(node.querySelector?.(OBSERVED_CAPABILITY_SELECTOR))
      )
    )));
  }

  document.addEventListener("click", (event) => {
    const control = blockedControl(event);
    if (!control) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    explain(control);
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const control = blockedControl(event);
    if (!control) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    explain(control, { focus: true });
  }, true);

  document.addEventListener("sentiq-auth-changed", (event) => void refresh({ force: true, session: event.detail?.session || null }));
  document.addEventListener("sentiq-live-status", (event) => patchFacts({ liveKnown: true, liveError: false, liveStatus: event.detail || null }));
  document.addEventListener("sentiq-ui-state-change", (event) => {
    const count = Number(event.detail?.facts?.uploadingCount ?? window.SentIQUIState?.getFacts?.()?.uploadingCount ?? 0);
    patchFacts({ uploadingCount: Number.isFinite(count) ? Math.max(0, count) : 0 });
  });

  let billingTimer = 0;
  window.addEventListener("sentiq-billing-refresh", () => {
    clearTimeout(billingTimer);
    billingTimer = setTimeout(() => void refresh({ force: true }), 220);
  });
  window.addEventListener("online", () => { patchFacts({ online: true }); void refresh({ force: true }); });
  window.addEventListener("offline", () => patchFacts({ online: false }));
  window.addEventListener("pageshow", () => {
    if (Date.now() - lastRefreshAt > REFRESH_STALE_MS) void refresh({ force: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastRefreshAt > REFRESH_STALE_MS) void refresh({ force: true });
  });

  new MutationObserver((records) => {
    if (containsAddedCapabilityControl(records)) applySnapshot();
  }).observe(document.body, { childList: true, subtree: true });

  window.SentIQCapabilities = Object.freeze({
    version: CAPABILITY_AWARENESS_VERSION,
    modelVersion: CAPABILITY_MODEL_VERSION,
    getSnapshot: () => snapshot,
    get: (key) => snapshot.capabilities[key] || null,
    refresh: (options = {}) => refresh({ force: true, ...options }),
    explain,
    closeExplanation: explainer.close,
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      if (options.emitCurrent !== false) listener(snapshot);
      return () => listeners.delete(listener);
    },
  });

  applySnapshot();
  void refresh({ force: true });
}

initializeCapabilityAwareness();
