/**
 * Emergency fallback used only when the texting-model classification call is
 * unavailable. Normal automatic image generation always uses the validated
 * requires_text_rendering Boolean returned by image_gen.
 */
export function detectExplicitTextRenderingRequirement(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized) return false;

  const quotedCopy = /(?:write|say|says|reads?|display|show|include|containing|with(?: the)? (?:text|words?|title|caption|label|headline|slogan))[^\n]{0,80}["“'][^"”'\n]{1,160}["”']/i;
  const explicitCopy = /\b(?:readable|legible|exact)\s+(?:text|words?|letters?|numbers?|copy|typography)\b/i;
  const textSurface = /\b(?:poster|banner|billboard|sign(?:age)?|logo|wordmark|book cover|album cover|menu|flyer|invitation|certificate|name tag|label|caption|subtitle|headline|title card|quote card|infographic|app screen|website mockup|ui mockup)\b/i;
  const renderingVerb = /\b(?:write|spell|letter|typeset|render|print|display|show|read|say)\b[^\n]{0,80}\b(?:text|word|phrase|name|title|caption|slogan|quote|number|date|price|label)\b/i;

  return quotedCopy.test(normalized)
    || explicitCopy.test(normalized)
    || textSurface.test(normalized)
    || renderingVerb.test(normalized);
}
