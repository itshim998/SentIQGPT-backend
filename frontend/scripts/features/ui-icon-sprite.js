/* SentIQ Chat — Pass 11.6 reusable interface SVG symbols */

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const SPRITE_ID = "sentiq-ui-icon-sprite";
const SYMBOL_PREFIX = "sentiq-icon";

const ICONS = Object.freeze({
  "zoom-in": '<circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4 4"></path><path d="M11 8v6M8 11h6"></path>',
  download: '<path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path>',
});

function symbolId(name) {
  return `${SYMBOL_PREFIX}-${name}`;
}

export function ensureUiIconSprite(doc = document) {
  if (!doc?.createElementNS) return null;
  const existing = doc.getElementById(SPRITE_ID);
  if (existing) return existing;

  const sprite = doc.createElementNS(SVG_NS, "svg");
  sprite.id = SPRITE_ID;
  sprite.setAttribute("aria-hidden", "true");
  sprite.setAttribute("focusable", "false");
  sprite.setAttribute("width", "0");
  sprite.setAttribute("height", "0");
  sprite.setAttribute("viewBox", "0 0 0 0");
  sprite.style.position = "absolute";
  sprite.style.width = "0";
  sprite.style.height = "0";
  sprite.style.overflow = "hidden";
  sprite.style.pointerEvents = "none";

  const definitions = doc.createElementNS(SVG_NS, "defs");
  Object.entries(ICONS).forEach(([name, markup]) => {
    const symbol = doc.createElementNS(SVG_NS, "symbol");
    symbol.id = symbolId(name);
    symbol.setAttribute("viewBox", "0 0 24 24");
    symbol.innerHTML = markup;
    definitions.appendChild(symbol);
  });
  sprite.appendChild(definitions);
  (doc.body || doc.documentElement)?.prepend(sprite);
  return sprite;
}

export function createUiIcon(name, options = {}) {
  const doc = options.document || document;
  if (!Object.hasOwn(ICONS, name) || !doc?.createElementNS) return null;
  ensureUiIconSprite(doc);

  const icon = doc.createElementNS(SVG_NS, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  icon.setAttribute("width", String(options.width || 18));
  icon.setAttribute("height", String(options.height || 18));
  if (options.className) icon.setAttribute("class", options.className);

  const use = doc.createElementNS(SVG_NS, "use");
  const href = `#${symbolId(name)}`;
  use.setAttribute("href", href);
  use.setAttributeNS(XLINK_NS, "xlink:href", href);
  icon.appendChild(use);
  return icon;
}

export const UI_ICON_NAMES = Object.freeze(Object.keys(ICONS));
