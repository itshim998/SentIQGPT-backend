// Guest experience observer safety.
//
// guest-experience.js intentionally observes .main-content so it can re-apply
// guest policy when the shell is rebuilt. Its policy also changes DOM
// attributes (class, style, aria-*, disabled), so observing those same
// attributes creates a self-triggering MutationObserver -> microtask loop.
//
// Keep the guest observer's childList/characterData coverage, but suppress
// only its attribute observation. Other MutationObservers are left untouched.

const GUEST_MAIN_CONTENT_ATTRIBUTE_FILTER = new Set([
  "disabled",
  "aria-disabled",
  "aria-hidden",
  "style",
  "class",
]);

function isGuestMutationObserverConfig(target, options) {
  if (!(target instanceof Element) || target.matches(".main-content") !== true) return false;
  if (!options?.attributes || !Array.isArray(options.attributeFilter)) return false;
  return GUEST_MAIN_CONTENT_ATTRIBUTE_FILTER.size === options.attributeFilter.length
    && options.attributeFilter.every((attribute) => GUEST_MAIN_CONTENT_ATTRIBUTE_FILTER.has(attribute));
}

function installGuestObserverSafetyGuard() {
  if (typeof window === "undefined" || typeof window.MutationObserver !== "function") return;
  const NativeMutationObserver = window.MutationObserver;
  if (NativeMutationObserver.__sentiqGuestAttributeGuard) return;

  class GuestSafeMutationObserver extends NativeMutationObserver {
    observe(target, options = {}) {
      if (isGuestMutationObserverConfig(target, options)) {
        const { attributes: _attributes, attributeFilter: _attributeFilter, ...safeOptions } = options;
        return super.observe(target, safeOptions);
      }
      return super.observe(target, options);
    }
  }

  Object.defineProperty(GuestSafeMutationObserver, "__sentiqGuestAttributeGuard", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  window.MutationObserver = GuestSafeMutationObserver;
}

installGuestObserverSafetyGuard();
