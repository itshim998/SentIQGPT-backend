/* SentIQ Liquid Glass V4 — Pass 8.3 authentication surfaces */

const AUTHENTICATION_SURFACE_VERSION = "8.3";

const AUTH_VIEW_COPY = Object.freeze({
  login: Object.freeze({
    emailTitle: "",
    emailDescription: "",
    passwordHint: "",
  }),
  signup: Object.freeze({
    emailTitle: "Sign up with email",
    emailDescription: "Use an email you can access. We'll send a confirmation.",
    passwordHint: "Longer passwords are stronger.",
  }),
  "forgot-password-request": Object.freeze({
    emailTitle: "Reset password",
    emailDescription: "We'll send a reset link to this address.",
    passwordHint: "",
  }),
  "password-recovery": Object.freeze({
    emailTitle: "New password",
    emailDescription: "Enter a new password.",
    passwordHint: "Don't reuse an old password.",
  }),
});

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isElementVisible(element) {
  if (!(element instanceof HTMLElement) || element.hidden) return false;
  if (element.style.display === "none") return false;
  try {
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  } catch {
    return true;
  }
}

function setText(element, value) {
  if (!(element instanceof HTMLElement)) return;
  const next = String(value ?? "");
  if (element.textContent !== next) element.textContent = next;
}

function setHidden(element, hidden) {
  if (!(element instanceof HTMLElement)) return;
  const next = Boolean(hidden);
  if (element.hidden !== next) element.hidden = next;
}

function appendDescribedBy(element, id) {
  if (!(element instanceof HTMLElement) || !id) return;
  const ids = new Set((element.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
  ids.add(id);
  element.setAttribute("aria-describedby", [...ids].join(" "));
}

function inferAuthView({ heading, submitButton, oauthGroup, emailInput, passwordInput }) {
  const copy = normalizeText(`${heading?.textContent || ""} ${submitButton?.textContent || ""}`);
  const emailVisible = isElementVisible(emailInput?.closest(".auth-field") || emailInput);
  const passwordVisible = isElementVisible(passwordInput?.closest(".auth-field") || passwordInput);
  const oauthVisible = isElementVisible(oauthGroup);

  if (/new password|update password|save password|set password|password recovery/.test(copy)) {
    return "password-recovery";
  }
  if (/forgot|send.*reset|reset link|recovery email/.test(copy) || (emailVisible && !passwordVisible && !oauthVisible)) {
    return "forgot-password-request";
  }
  if (/create|sign up|signup|register|new account/.test(copy)) {
    return "signup";
  }
  return "login";
}

function passwordStrength(value) {
  const password = String(value || "");
  if (!password) return { level: 0, label: "Enter a password" };
  const variety = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;

  if (password.length < 8) return { level: 1, label: "Too short" };
  if (password.length >= 12 && variety >= 3) return { level: 4, label: "Strong" };
  if (password.length >= 10 && variety >= 2) return { level: 3, label: "Good" };
  return { level: 2, label: "Fair" };
}

function initializeAuthenticationSurface() {
  if (typeof document === "undefined") return;

  const modal = document.getElementById("auth-modal");
  const nameModal = document.getElementById("name-modal");
  const surface = modal?.querySelector(".auth-modal-container");
  const body = modal?.querySelector(".auth-modal-body");
  const form = document.getElementById("auth-form");
  const oauthGroup = document.getElementById("auth-oauth-group");
  const googleButton = document.getElementById("auth-google-btn");
  const googleLabel = document.getElementById("auth-google-label");
  const divider = oauthGroup?.querySelector(".auth-divider");
  const emailInput = document.getElementById("auth-email");
  const passwordInput = document.getElementById("auth-password");
  const passwordToggle = document.getElementById("auth-password-toggle");
  const passwordWrap = passwordInput?.closest(".auth-password-wrap");
  const emailField = emailInput?.closest(".auth-field");
  const passwordField = passwordInput?.closest(".auth-field");
  const forgotRow = document.getElementById("auth-forgot-row");
  const status = document.getElementById("auth-status");
  const submitButton = document.getElementById("auth-submit-btn");
  const switchRow = form?.querySelector(".auth-switch");
  const heading = document.getElementById("auth-modal-heading");

  if (!(modal instanceof HTMLElement)
      || !(surface instanceof HTMLElement)
      || !(body instanceof HTMLElement)
      || !(form instanceof HTMLFormElement)
      || !(emailInput instanceof HTMLInputElement)
      || !(passwordInput instanceof HTMLInputElement)) return;
  if (modal.dataset.authenticationSurfaceVersion === AUTHENTICATION_SURFACE_VERSION) return;

  modal.dataset.authenticationSurfaceVersion = AUTHENTICATION_SURFACE_VERSION;
  modal.classList.add("authentication-surface-root");
  surface.classList.add("authentication-surface");
  body.classList.add("authentication-surface-body");
  form.classList.add("authentication-form");
  nameModal?.classList.add("authentication-surface-root", "authentication-name-surface-root");
  nameModal?.querySelector(".name-modal-container")?.classList.add("authentication-surface");

  emailInput.inputMode = "email";
  emailInput.autocapitalize = "none";
  emailInput.spellcheck = false;
  emailInput.setAttribute("aria-errormessage", "auth-status");
  passwordInput.setAttribute("aria-errormessage", "auth-status");

  if (oauthGroup && !oauthGroup.querySelector(".authentication-method-heading")) {
    const methodHeading = document.createElement("div");
    methodHeading.className = "authentication-method-heading";
    methodHeading.innerHTML = `
      <span>Google account</span>
      <small>Continue without creating another password.</small>
    `;
    oauthGroup.prepend(methodHeading);
  }

  if (googleButton instanceof HTMLButtonElement) {
    googleButton.classList.add("authentication-google-route");
    googleButton.setAttribute("aria-describedby", "authentication-google-help");
    let help = document.getElementById("authentication-google-help");
    if (!help) {
      help = document.createElement("span");
      help.id = "authentication-google-help";
      help.className = "sr-only";
      help.textContent = "Continue with your Google account.";
      googleButton.after(help);
    }
  }

  const dividerLabel = divider?.querySelector("span:nth-child(2)");
  setText(dividerLabel, "OR");

  let emailPath = form.querySelector(".authentication-email-path");
  if (!emailPath) {
    emailPath = document.createElement("section");
    emailPath.className = "authentication-email-path";
    emailPath.setAttribute("aria-labelledby", "authentication-email-path-title");

    const routeHeader = document.createElement("div");
    routeHeader.className = "authentication-route-header";
    routeHeader.innerHTML = `
      <strong id="authentication-email-path-title"></strong>
      <small id="authentication-email-path-description"></small>
    `;
    emailPath.appendChild(routeHeader);

    [emailField, passwordField, forgotRow, status, submitButton, switchRow]
      .filter((node) => node instanceof HTMLElement)
      .forEach((node) => emailPath.appendChild(node));
    form.appendChild(emailPath);
  }

  let passwordFeedback = document.getElementById("authentication-password-feedback");
  if (!passwordFeedback && passwordWrap instanceof HTMLElement) {
    passwordFeedback = document.createElement("div");
    passwordFeedback.id = "authentication-password-feedback";
    passwordFeedback.className = "authentication-password-feedback";
    passwordFeedback.innerHTML = `
      <div class="authentication-password-feedback-row">
        <span id="authentication-password-state" aria-live="polite"></span>
        <span id="authentication-caps-lock" class="authentication-caps-lock" role="status" aria-live="polite" hidden>Caps Lock is on</span>
      </div>
      <div class="authentication-password-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <p id="authentication-password-help"></p>
    `;
    passwordWrap.after(passwordFeedback);
  }

  appendDescribedBy(emailInput, "auth-status");
  appendDescribedBy(emailInput, "authentication-email-path-description");
  appendDescribedBy(passwordInput, "auth-status");
  appendDescribedBy(passwordInput, "authentication-password-help");

  const passwordState = document.getElementById("authentication-password-state");
  const passwordHelp = document.getElementById("authentication-password-help");
  const capsLock = document.getElementById("authentication-caps-lock");
  const emailPathTitle = document.getElementById("authentication-email-path-title");
  const emailPathDescription = document.getElementById("authentication-email-path-description");

  function clearFieldErrors() {
    emailInput.removeAttribute("aria-invalid");
    passwordInput.removeAttribute("aria-invalid");
    form.removeAttribute("data-auth-error-scope");
  }

  function syncStatus() {
    if (!(status instanceof HTMLElement)) return;
    const text = normalizeText(status.textContent);
    const isError = status.classList.contains("is-error");
    const isSuccess = status.classList.contains("is-success");
    const isVisible = status.classList.contains("is-visible") || Boolean(text);
    const state = isError ? "error" : isSuccess ? "success" : isVisible ? "info" : "idle";

    status.dataset.statusState = state;
    status.setAttribute("aria-atomic", "true");
    status.setAttribute("role", isError ? "alert" : "status");
    status.setAttribute("aria-live", isError ? "assertive" : "polite");

    clearFieldErrors();
    if (!isError || !text) return;

    const emailError = /email|address|account|confirmation|already registered|user/.test(text);
    const passwordError = /password|credential|login|incorrect|weak|characters/.test(text);
    if (emailError) emailInput.setAttribute("aria-invalid", "true");
    if (passwordError || (!emailError && /invalid/.test(text))) passwordInput.setAttribute("aria-invalid", "true");
    if (!emailError && !passwordError) form.dataset.authErrorScope = "form";
  }

  function syncPasswordState(view) {
    if (!(passwordFeedback instanceof HTMLElement)) return;
    const visible = passwordInput.type === "text";
    const strength = passwordStrength(passwordInput.value);
    const showStrength = view === "signup" || view === "password-recovery";

    passwordFeedback.dataset.passwordView = showStrength ? "strength" : "visibility";
    passwordFeedback.dataset.strength = String(showStrength ? strength.level : 0);
    if (passwordState) {
      setText(passwordState, showStrength ? strength.label : "");
    }
    setText(passwordHelp, AUTH_VIEW_COPY[view]?.passwordHint || "");
    if (passwordToggle instanceof HTMLButtonElement) {
      passwordToggle.setAttribute("aria-pressed", visible ? "true" : "false");
      passwordToggle.title = visible ? "Hide password" : "Show password";
    }
  }

  function syncView() {
    const view = inferAuthView({ heading, submitButton, oauthGroup, emailInput, passwordInput });
    const copy = AUTH_VIEW_COPY[view] || AUTH_VIEW_COPY.login;
    modal.dataset.authenticationView = view;
    form.dataset.authenticationView = view;
    surface.dataset.authenticationView = view;

    setText(emailPathTitle, copy.emailTitle);
    setText(emailPathDescription, copy.emailDescription);
    if (googleLabel && isElementVisible(oauthGroup)) {
      setText(googleLabel, view === "signup" ? "Sign up with Google" : "Continue with Google");
    }

    const passwordIsUsed = view !== "forgot-password-request" && isElementVisible(passwordField || passwordInput);
    setHidden(passwordFeedback, !passwordIsUsed);
    if (view === "login") passwordInput.autocomplete = "current-password";
    if (view === "signup" || view === "password-recovery") passwordInput.autocomplete = "new-password";

    syncPasswordState(view);
    syncStatus();
  }

  function syncSensitiveSurfaceState() {
    const authOpen = modal.style.display !== "none" && modal.getAttribute("aria-hidden") !== "true";
    const nameOpen = nameModal instanceof HTMLElement
      && nameModal.style.display !== "none"
      && nameModal.getAttribute("aria-hidden") !== "true";
    document.body.classList.toggle("auth-sensitive-surface-open", authOpen || nameOpen);
    if (authOpen) syncViewportHeight();
  }

  function syncViewportHeight() {
    const viewport = window.visualViewport;
    const height = viewport?.height || window.innerHeight;
    const next = `${Math.max(320, Math.round(height))}px`;
    if (modal.style.getPropertyValue("--authentication-viewport-height") !== next) {
      modal.style.setProperty("--authentication-viewport-height", next);
    }
  }

  function keepFocusedControlVisible() {
    syncViewportHeight();
    if (window.innerWidth > 640) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !modal.contains(active)) return;
    window.requestAnimationFrame(() => {
      active.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    });
  }

  function setCapsLock(event) {
    if (!(capsLock instanceof HTMLElement) || typeof event.getModifierState !== "function") return;
    const active = event.getModifierState("CapsLock");
    setHidden(capsLock, !active);
    passwordFeedback?.classList.toggle("has-caps-lock", active);
  }

  emailInput.addEventListener("input", () => {
    emailInput.removeAttribute("aria-invalid");
    if (!passwordInput.hasAttribute("aria-invalid")) form.removeAttribute("data-auth-error-scope");
  });
  passwordInput.addEventListener("input", () => {
    passwordInput.removeAttribute("aria-invalid");
    syncPasswordState(modal.dataset.authenticationView || "login");
    if (!emailInput.hasAttribute("aria-invalid")) form.removeAttribute("data-auth-error-scope");
  });
  passwordInput.addEventListener("keydown", setCapsLock);
  passwordInput.addEventListener("keyup", setCapsLock);
  passwordInput.addEventListener("blur", () => {
    setHidden(capsLock, true);
    passwordFeedback?.classList.remove("has-caps-lock");
  });
  passwordToggle?.addEventListener("click", () => {
    window.requestAnimationFrame(() => syncPasswordState(modal.dataset.authenticationView || "login"));
  });

  const observer = new MutationObserver(() => {
    syncView();
    syncSensitiveSurfaceState();
  });
  observer.observe(modal, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "type", "disabled"],
  });
  if (nameModal instanceof HTMLElement) {
    observer.observe(nameModal, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "disabled"],
    });
    const nameStatus = document.getElementById("name-status");
    nameStatus?.setAttribute("aria-atomic", "true");
  }

  window.visualViewport?.addEventListener("resize", keepFocusedControlVisible, { passive: true });
  window.visualViewport?.addEventListener("scroll", syncViewportHeight, { passive: true });
  window.addEventListener("resize", syncViewportHeight, { passive: true });
  modal.addEventListener("focusin", keepFocusedControlVisible);

  syncViewportHeight();
  syncView();
  syncSensitiveSurfaceState();

  window.SentIQAuthenticationSurface = Object.freeze({
    version: AUTHENTICATION_SURFACE_VERSION,
    sync: () => {
      syncView();
      syncSensitiveSurfaceState();
    },
    getView: () => modal.dataset.authenticationView || "login",
  });
}

initializeAuthenticationSurface();
