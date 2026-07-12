/**
 * Removes a deliberately small set of internal WebSurf artefacts before they
 * reach the SSE stream or persisted answer. It does not rewrite Markdown,
 * prose, URLs, or valid WebSurf citation sentinels.
 */
const SOURCE_LINE_ARTEFACT = /\[\d{1,3}\u2020L\d{1,6}-L\d{1,6}\]/g;
const EVIDENCE_DELIMITER = /(?:<<<\/?WEBSURF_[A-Z_]+>>>|\[WEBSURF_(?:EVIDENCE|SOURCE_REGISTRY)_(?:START|END)\])/g;
const ROLE_LABEL = /(^|\n)(?:Source\s+)?Role:\s*(?:official_primary|authoritative_news|specialist_reporting|live_data_or_results|reference|social_or_video|aggregator|unknown)\s*(?=\n|$)/gim;
const PLAN_LABEL = /(^|\n)(?:ANSWER PROFILE|PRIMARY ENTITY|INTERPRETATION|AS OF DATE|REQUIRED COVERAGE GOALS|OPTIONAL COVERAGE GOALS|TABLE POLICY|MAX TABLE ROWS|UNCERTAINTY POLICY|FOLLOW-UP POLICY)\s*:\s*[^\n]*(?=\n|$)/gim;
const INTERNAL_LINE_PREFIXES = [
  "ROLE:",
  "SOURCE ROLE:",
  "ANSWER PROFILE:",
  "PRIMARY ENTITY:",
  "INTERPRETATION:",
  "AS OF DATE:",
  "REQUIRED COVERAGE GOALS:",
  "OPTIONAL COVERAGE GOALS:",
  "TABLE POLICY:",
  "MAX TABLE ROWS:",
  "UNCERTAINTY POLICY:",
  "FOLLOW-UP POLICY:",
] as const;

function stripKnownArtefacts(value: string, sourceIds: ReadonlySet<string>): string {
  let output = value
    .replace(SOURCE_LINE_ARTEFACT, "")
    .replace(EVIDENCE_DELIMITER, "")
    .replace(ROLE_LABEL, "$1")
    .replace(PLAN_LABEL, "$1");
  output = output.replace(/\[\[(S[^\]\r\n]{0,24})\]\]/g, (marker, sourceId: string) => (
    sourceIds.has(sourceId) ? marker : ""
  ));
  return output;
}

function incompleteInternalSuffixStart(value: string): number | undefined {
  const lastBracket = value.lastIndexOf("[");
  if (lastBracket >= 0) {
    const suffix = value.slice(lastBracket);
    if (["[[S", "[0\u2020L", "[WEBSURF_"].some((prefix) => prefix.startsWith(suffix))) return lastBracket;
  }
  const lastAngle = value.lastIndexOf("<");
  if (lastAngle >= 0) {
    const suffix = value.slice(lastAngle);
    if ("<<<WEBSURF_".startsWith(suffix)) return lastAngle;
  }
  const candidates = [value.lastIndexOf("[[S"), value.lastIndexOf("[0\u2020L"), value.lastIndexOf("<<<WEBSURF_"), value.lastIndexOf("[WEBSURF_")]
    .filter((index) => index >= 0)
    .sort((left, right) => right - left);
  for (const index of candidates) {
    const suffix = value.slice(index);
    if (suffix.startsWith("[[S") && !suffix.includes("]]")) return index;
    if (suffix.startsWith("[0\u2020L") && !suffix.includes("]")) return index;
    if (suffix.startsWith("<<<WEBSURF_") && !suffix.includes(">>>")) return index;
    if (suffix.startsWith("[WEBSURF_") && !suffix.includes("]")) return index;
  }

  const lineStart = Math.max(value.lastIndexOf("\n") + 1, 0);
  const line = value.slice(lineStart).toUpperCase();
  if (line.length > 0 && INTERNAL_LINE_PREFIXES.some((prefix) => prefix.startsWith(line) || line.startsWith(prefix))) {
    return lineStart;
  }
  return undefined;
}

function discardIncompleteInternalSuffix(value: string): string {
  const start = incompleteInternalSuffixStart(value);
  return start === undefined ? value : value.slice(0, start);
}

export class WebSurfOutputGuardStream {
  private pending = "";
  private removed = false;

  constructor(private readonly sourceIds: ReadonlySet<string>) {}

  push(chunk: string): string {
    this.pending += chunk;
    const suffixStart = incompleteInternalSuffixStart(this.pending);
    const ready = suffixStart === undefined ? this.pending : this.pending.slice(0, suffixStart);
    this.pending = suffixStart === undefined ? "" : this.pending.slice(suffixStart);
    const output = stripKnownArtefacts(ready, this.sourceIds);
    if (output !== ready) this.removed = true;
    return output;
  }

  flush(): string {
    const ready = discardIncompleteInternalSuffix(this.pending);
    if (ready !== this.pending) this.removed = true;
    this.pending = "";
    const output = stripKnownArtefacts(ready, this.sourceIds);
    if (output !== ready) this.removed = true;
    return output;
  }

  get removedInternalArtefact(): boolean {
    return this.removed;
  }
}

export function normalizeWebSurfAnswerOutput(text: string, sourceIds: ReadonlySet<string>): string {
  const guard = new WebSurfOutputGuardStream(sourceIds);
  return `${guard.push(text)}${guard.flush()}`;
}
