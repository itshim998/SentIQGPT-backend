/* ============================================================
   SentIQ Activity Logo — reusable semantic activity primitive

   Renders one shared animated-logo surface for loading, thinking,
   and file-analysis states. The component intentionally owns only
   presentation; callers remain responsible for lifecycle/state.
   ============================================================ */

const LOGO_ACTIVITY_VERSION = "1.0.0";
const LOGO_ACTIVITY_STYLE_ID = "sentiq-activity-logo-styles";
const LOGO_SIZE_MAP = Object.freeze({
  sm: "28px",
  md: "44px",
  lg: "72px",
  xl: "96px",
});

const LOGO_VARIANTS = Object.freeze({
  "neural-dialog": Object.freeze({
    asset: "assets/sentiqlogo-neural-dialog.svg",
    defaultState: "loading",
  }),
  "neural-orbit": Object.freeze({
    asset: "assets/sentiqlogo-neural-orbit.svg",
    defaultState: "thinking",
  }),
  "infinite-dialog": Object.freeze({
    asset: "assets/sentiqlogo-infinite-dialog.svg",
    defaultState: "reading-files",
  }),
});

const LOGO_STATES = new Set([
  "loading",
  "thinking",
  "reading-files",
]);

function normalizeVariant(value) {
  const variant = String(value || "").trim().toLowerCase();
  return LOGO_VARIANTS[variant] ? variant : "neural-dialog";
}

function normalizeState(value, variant) {
  const state = String(value || "").trim().toLowerCase();
  if (LOGO_STATES.has(state)) return state;
  return LOGO_VARIANTS[variant].defaultState;
}

function resolveSize(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (LOGO_SIZE_MAP[normalized]) return LOGO_SIZE_MAP[normalized];
  if (/^\d+(?:\.\d+)?(?:px|rem|em|vw|vh)$/.test(normalized)) return normalized;
  return "64px";
}

function assetUrl(path) {
  try {
    return new URL(`../../${path}`, import.meta.url).href;
  } catch {
    return path;
  }
}

function stylesheetUrl() {
  try {
    return new URL("../../styles/modules/91-logo-activity.css", import.meta.url).href;
  } catch {
    return "styles/modules/91-logo-activity.css";
  }
}

function ensureStylesheet() {
  if (typeof document === "undefined") return;
  if (document.getElementById(LOGO_ACTIVITY_STYLE_ID)) return;

  const link = document.createElement("link");
  link.id = LOGO_ACTIVITY_STYLE_ID;
  link.rel = "stylesheet";
  link.href = stylesheetUrl();
  link.dataset.sentiqFeature = "logo-activity";
  document.head?.appendChild(link);
}

function setBooleanAttribute(element, name, value) {
  const next = Boolean(value);
  if (next) element.setAttribute(name, "");
  else element.removeAttribute(name);
}

class SentiQActivityLogo extends HTMLElement {
  static get observedAttributes() {
    return ["variant", "state", "size", "label", "aria-label"];
  }

  connectedCallback() {
    ensureStylesheet();
    this._render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this._render();
  }

  _render() {
    const variant = normalizeVariant(this.getAttribute("variant"));
    const state = normalizeState(this.getAttribute("state"), variant);
    const config = LOGO_VARIANTS[variant];
    const src = assetUrl(config.asset);
    const size = resolveSize(this.getAttribute("size"));
    const label = String(this.getAttribute("aria-label") || this.getAttribute("label") || "").trim();
    const accessibleLabel = label || (
      state === "loading" ? "Loading SentIQ Chat"
        : state === "reading-files" ? "Reading files"
          : "Thinking"
    );

    this.classList.add("sentiq-activity-logo");
    this.dataset.version = LOGO_ACTIVITY_VERSION;
    this.dataset.variant = variant;
    this.dataset.state = state;
    this.style.setProperty("--sentiq-activity-logo-size", size);
    this.style.setProperty("--sentiq-activity-logo-asset", `url("${src}")`);

    if (this.getAttribute("role") !== "img") this.setAttribute("role", "img");
    if (this.getAttribute("aria-label") !== accessibleLabel) this.setAttribute("aria-label", accessibleLabel);
    setBooleanAttribute(this, "aria-busy", true);

    const existing = this.querySelector(".sentiq-activity-logo__geometry");
    if (existing instanceof HTMLImageElement) {
      if (existing.src !== src) existing.src = src;
      existing.alt = "";
      return;
    }

    this.replaceChildren();

    const geometry = document.createElement("img");
    geometry.className = "sentiq-activity-logo__geometry";
    geometry.src = src;
    geometry.alt = "";
    geometry.decoding = "async";
    geometry.draggable = false;
    geometry.setAttribute("aria-hidden", "true");

    const breath = document.createElement("span");
    breath.className = "sentiq-activity-logo__breath";
    breath.setAttribute("aria-hidden", "true");

    const shimmer = document.createElement("span");
    shimmer.className = "sentiq-activity-logo__shimmer";
    shimmer.setAttribute("aria-hidden", "true");

    this.append(geometry, breath, shimmer);
  }
}

ensureStylesheet();

if (!customElements.get("sentiq-activity-logo")) {
  customElements.define("sentiq-activity-logo", SentiQActivityLogo);
}

window.SentIQActivityLogo = Object.freeze({
  version: LOGO_ACTIVITY_VERSION,
  variants: Object.freeze(Object.keys(LOGO_VARIANTS)),
  states: Object.freeze(Array.from(LOGO_STATES)),
});
