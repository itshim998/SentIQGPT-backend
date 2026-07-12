const COMMON_PUBLISHER_LABELS = Object.freeze({
  "bbc.com": "BBC",
  "bbc.co.uk": "BBC",
  "cnn.com": "CNN",
  "fifa.com": "FIFA",
  "reuters.com": "Reuters",
  "skysports.com": "Sky Sports",
  "nodejs.org": "Node.js",
  "nytimes.com": "The New York Times",
  "theguardian.com": "The Guardian",
  "apnews.com": "AP News",
  "espn.com": "ESPN",
  "nasa.gov": "NASA",
});

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "com.br", "co.in",
]);

export function cleanWebSurfPresentationText(value, maxChars = 220) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, maxChars));
}

export function getWebSurfPresentationVersion(payload) {
  return Number(payload?.presentationVersion) === 1 ? 1 : 0;
}

export function getWebSurfDomainKey(value) {
  const host = cleanWebSurfPresentationText(value, 253)
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return host;
}

function getRegistrableLabelPart(host) {
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] || "";
  const suffix = parts.slice(-2).join(".");
  if (MULTI_PART_PUBLIC_SUFFIXES.has(suffix) && parts.length >= 3) return parts.at(-3) || "";
  return parts.at(-2) || "";
}

function humanizeDomainPart(value) {
  const words = value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (words.length === 0) return "";
  return words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

/** A bounded display label only; it is never treated as HTML or as a URL. */
export function getWebSurfPublisherLabel(source) {
  const explicit = cleanWebSurfPresentationText(source?.publisher, 80);
  if (explicit) return explicit;
  const host = getWebSurfDomainKey(source?.domain);
  if (!host) return "Source";
  if (COMMON_PUBLISHER_LABELS[host]) return COMMON_PUBLISHER_LABELS[host];
  const part = getRegistrableLabelPart(host);
  return cleanWebSurfPresentationText(humanizeDomainPart(part) || host, 80) || "Source";
}

/** Keeps the frozen backend order while preferring the first source per domain. */
export function selectFeaturedWebSurfSources(sources, maxCount = 3) {
  const selected = [];
  const domains = new Set();
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source?.url) continue;
    let domain = getWebSurfDomainKey(source.domain);
    if (!domain) {
      try {
        domain = getWebSurfDomainKey(new URL(source.url).hostname);
      } catch {
        continue;
      }
    }
    if (!domain || domains.has(domain)) continue;
    domains.add(domain);
    selected.push(source);
    if (selected.length >= maxCount) break;
  }
  return selected;
}

export function truncateWebSurfExcerpt(value, maxChars = 220) {
  const text = cleanWebSurfPresentationText(value, Math.max(maxChars + 48, maxChars));
  if (text.length <= maxChars) return text;
  const boundary = text.lastIndexOf(" ", maxChars - 1);
  const clipped = boundary >= Math.floor(maxChars * 0.55) ? text.slice(0, boundary) : text.slice(0, maxChars);
  return `${clipped.trimEnd()}…`;
}

/**
 * Returns only valid model citation markers that occur in ordinary Markdown
 * prose. Markers inside code or Markdown links are intentionally ignored.
 */
export function collectWebSurfCitationIds(value, sourceIds) {
  const sourceSet = sourceIds instanceof Set ? sourceIds : new Set(sourceIds || []);
  const text = String(value || "");
  const found = [];
  let inInlineCode = false;
  let inFencedCode = false;
  let inLinkDestination = false;
  let linkDestinationDepth = 0;
  let linkLabelDepth = 0;
  let lastLiteralChar = "";

  for (let index = 0; index < text.length;) {
    if (text.startsWith("```", index)) {
      inFencedCode = !inFencedCode;
      inInlineCode = false;
      lastLiteralChar = "`";
      index += 3;
      continue;
    }

    if (!inInlineCode && !inFencedCode && !inLinkDestination && linkLabelDepth === 0) {
      const marker = text.slice(index).match(/^\[\[(S\d+)\]\]/);
      if (marker) {
        if (sourceSet.has(marker[1])) found.push(marker[1]);
        index += marker[0].length;
        lastLiteralChar = "]";
        continue;
      }
    }

    const char = text[index];
    if (!inFencedCode && char === "`") {
      inInlineCode = !inInlineCode;
    } else if (!inFencedCode && !inInlineCode) {
      if (inLinkDestination) {
        if (char === "(") linkDestinationDepth += 1;
        if (char === ")") {
          linkDestinationDepth -= 1;
          if (linkDestinationDepth <= 0) {
            inLinkDestination = false;
            linkDestinationDepth = 0;
          }
        }
      } else if (lastLiteralChar === "]" && char === "(") {
        inLinkDestination = true;
        linkDestinationDepth = 1;
      } else if (char === "[") {
        linkLabelDepth += 1;
      } else if (char === "]" && linkLabelDepth > 0) {
        linkLabelDepth -= 1;
      }
    }
    lastLiteralChar = char;
    index += 1;
  }
  return found;
}
