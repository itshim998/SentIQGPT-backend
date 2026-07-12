/**
 * Converts internal WebSurf source sentinels into plain stream-safe text.
 * The complete raw answer is retained separately for persistence and final
 * citation rendering; this filter only prevents an incomplete `[[S1]]` from
 * appearing in a token stream when SSE happens to split it mid-marker.
 */
export class WebSurfCitationStream {
  private static readonly MAX_PENDING_MARKER_CHARS = 32;
  private pending = "";
  private inInlineCode = false;
  private inFencedCode = false;
  private inLinkDestination = false;
  private linkDestinationDepth = 0;
  private linkLabelDepth = 0;
  private lastLiteralChar = "";

  constructor(
    private readonly sourceIds: ReadonlySet<string>,
    private readonly options: { readonly preserveSourceMarkers?: boolean } = {},
  ) {}

  private appendLiteral(text: string): string {
    for (let index = 0; index < text.length; index += 1) {
      if (text.startsWith("```", index)) {
        this.inFencedCode = !this.inFencedCode;
        this.inInlineCode = false;
        this.lastLiteralChar = "`";
        index += 2;
        continue;
      }

      const char = text[index];
      if (!this.inFencedCode && char === "`") {
        this.inInlineCode = !this.inInlineCode;
      } else if (!this.inFencedCode && !this.inInlineCode) {
        if (this.inLinkDestination) {
          if (char === "(") this.linkDestinationDepth += 1;
          if (char === ")") {
            this.linkDestinationDepth -= 1;
            if (this.linkDestinationDepth <= 0) {
              this.inLinkDestination = false;
              this.linkDestinationDepth = 0;
            }
          }
        } else if (this.lastLiteralChar === "]" && char === "(") {
          this.inLinkDestination = true;
          this.linkDestinationDepth = 1;
        } else if (char === "[") {
          this.linkLabelDepth += 1;
        } else if (char === "]" && this.linkLabelDepth > 0) {
          this.linkLabelDepth -= 1;
        }
      }
      this.lastLiteralChar = char;
    }
    return text;
  }

  private canRenderCitation(): boolean {
    return !this.inInlineCode && !this.inFencedCode && !this.inLinkDestination && this.linkLabelDepth === 0;
  }

  push(chunk: string): string {
    this.pending += chunk;
    let visible = "";

    while (this.pending.length > 0) {
      const markerStart = this.pending.indexOf("[[");
      if (markerStart < 0) {
        const retainedPrefix = this.pending.endsWith("[") ? "[" : "";
        const literal = this.pending.slice(0, this.pending.length - retainedPrefix.length);
        visible += this.appendLiteral(literal);
        this.pending = retainedPrefix;
        break;
      }

      visible += this.appendLiteral(this.pending.slice(0, markerStart));
      this.pending = this.pending.slice(markerStart);
      const markerEnd = this.pending.indexOf("]]", 2);
      if (markerEnd < 0) {
        if (this.pending.length > WebSurfCitationStream.MAX_PENDING_MARKER_CHARS) {
          visible += this.appendLiteral(this.pending.slice(0, 2));
          this.pending = this.pending.slice(2);
          continue;
        }
        break;
      }

      const marker = this.pending.slice(0, markerEnd + 2);
      const match = marker.match(/^\[\[(S\d+)\]\]$/);
      if (match && this.sourceIds.has(match[1]) && this.canRenderCitation()) {
        // Pass C's client has the frozen source registry before answer tokens.
        // Keeping the opaque marker lets it hydrate an accessible publisher chip
        // without changing legacy stream output or model/persistence content.
        visible += this.options.preserveSourceMarkers ? marker : `[${Number.parseInt(match[1].slice(1), 10)}]`;
      } else {
        // An unknown source is ordinary text, never an interactive citation.
        visible += this.appendLiteral(marker);
      }
      this.pending = this.pending.slice(markerEnd + 2);
    }

    return visible;
  }

  flush(): string {
    const remaining = this.appendLiteral(this.pending);
    this.pending = "";
    return remaining;
  }
}
