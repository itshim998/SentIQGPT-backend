/* ============================================================
   SentIQ Chat — Pass 12.7.1
   Desktop sidebar transition polish

   Observes the existing sidebar-collapsed state rather than replacing its
   storage or event logic. The sidebar width animates through Web Animations,
   while the new rail/expanded contents enter softly instead of appearing in
   one abrupt frame.
   ============================================================ */

const SIDEBAR_TRANSITION_VERSION = "12.7.1";
const SIDEBAR_TRANSITION_DURATION_MS = 360;
const SIDEBAR_TRANSITION_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const DESKTOP_SIDEBAR_QUERY = "(min-width: 769px)";

function readPixelToken(name, fallback) {
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function initializeSidebarTransitionPolish() {
  const appContainer = document.querySelector(".app-container");
  const sidebar = document.getElementById("sidebar");
  if (!appContainer || !sidebar || typeof MutationObserver !== "function") return;

  sidebar.dataset.sidebarTransitionVersion = SIDEBAR_TRANSITION_VERSION;

  const desktopQuery = window.matchMedia?.(DESKTOP_SIDEBAR_QUERY);
  const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let previousCollapsed = appContainer.classList.contains("sidebar-collapsed");
  let sidebarAnimation = null;
  let contentAnimations = [];
  let transitionSequence = 0;

  function cancelAnimations() {
    sidebarAnimation?.cancel();
    sidebarAnimation = null;
    contentAnimations.forEach((animation) => animation.cancel());
    contentAnimations = [];
  }

  function finishTransition(sequence) {
    if (sequence !== transitionSequence) return;
    appContainer.removeAttribute("data-sidebar-transitioning");
    sidebar.style.removeProperty("will-change");
    cancelAnimations();
  }

  function animateSidebar(nextCollapsed) {
    const sequence = ++transitionSequence;
    const motionReduced = Boolean(motionQuery?.matches);
    const isDesktop = desktopQuery ? desktopQuery.matches : window.innerWidth >= 769;
    previousCollapsed = nextCollapsed;

    if (!isDesktop || motionReduced || typeof sidebar.animate !== "function") {
      finishTransition(sequence);
      return;
    }

    const currentWidth = sidebar.getBoundingClientRect().width;
    const targetWidth = nextCollapsed
      ? readPixelToken("--sentiq-sidebar-rail-width", 64)
      : readPixelToken("--sidebar-width", 280);

    if (!Number.isFinite(currentWidth) || Math.abs(currentWidth - targetWidth) < 0.5) {
      finishTransition(sequence);
      return;
    }

    cancelAnimations();
    appContainer.setAttribute("data-sidebar-transitioning", "true");
    sidebar.style.willChange = "width";

    sidebarAnimation = sidebar.animate(
      [
        { width: `${currentWidth}px` },
        { width: `${targetWidth}px` },
      ],
      {
        duration: SIDEBAR_TRANSITION_DURATION_MS,
        easing: SIDEBAR_TRANSITION_EASING,
        fill: "both",
      },
    );

    const entryOffset = nextCollapsed ? "-7px" : "7px";
    const regions = [
      sidebar.querySelector(".sidebar-header"),
      sidebar.querySelector(".sidebar-conversations"),
      sidebar.querySelector(".sidebar-footer"),
    ].filter(Boolean);

    contentAnimations = regions.map((region, index) => region.animate(
      [
        { opacity: 0.52, transform: `translate3d(${entryOffset}, 0, 0)` },
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
      ],
      {
        duration: 240,
        delay: 28 + (index * 18),
        easing: SIDEBAR_TRANSITION_EASING,
        fill: "both",
      },
    ));

    Promise.allSettled([
      sidebarAnimation.finished,
      ...contentAnimations.map((animation) => animation.finished),
    ]).then(() => finishTransition(sequence));
  }

  const observer = new MutationObserver(() => {
    const nextCollapsed = appContainer.classList.contains("sidebar-collapsed");
    if (nextCollapsed === previousCollapsed) return;
    animateSidebar(nextCollapsed);
  });

  observer.observe(appContainer, {
    attributes: true,
    attributeFilter: ["class"],
  });

  desktopQuery?.addEventListener?.("change", () => {
    transitionSequence += 1;
    previousCollapsed = appContainer.classList.contains("sidebar-collapsed");
    finishTransition(transitionSequence);
  });
}

if (typeof document !== "undefined") {
  const start = () => initializeSidebarTransitionPolish();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
