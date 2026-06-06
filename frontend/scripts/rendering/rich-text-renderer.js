(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.SentIQRenderer = factory(root);
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  var MAX_RENDER_CHARS_DEFAULT = 100000;
  var MATH_TERMS = /^(?:sin|cos|tan|cot|sec|csc|log|ln|exp|max|min|lim|sum|prod|det|mod|sqrt|frac)$/i;

  function getDocument() {
    return root && root.document ? root.document : null;
  }

  function escapeHtml(str) {
    var value = String(str == null ? "" : str);
    var doc = getDocument();
    if (doc) {
      var div = doc.createElement("div");
      div.textContent = value;
      return div.innerHTML;
    }
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sanitizeRenderedHtml(html) {
    var doc = getDocument();
    if (!doc || typeof NodeFilter === "undefined") {
      return String(html || "");
    }

    var template = doc.createElement("template");
    template.innerHTML = String(html || "");

    var blockedTags = new Set(["script", "style", "iframe", "object", "embed", "form", "input"]);
    var treeWalker = doc.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
    var elements = [];
    while (treeWalker.nextNode()) {
      elements.push(treeWalker.currentNode);
    }

    elements.forEach(function (element) {
      var tagName = element.tagName.toLowerCase();
      if (blockedTags.has(tagName)) {
        element.remove();
        return;
      }

      Array.from(element.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        var value = attr.value.trim();

        if (name.indexOf("on") === 0 || name === "srcdoc" || name === "style") {
          element.removeAttribute(attr.name);
          return;
        }

        if (name === "href" || name === "src") {
          var lowerValue = value.toLowerCase();
          var isSafeDataImage = tagName === "img" && /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(value);
          var isSafeUrl = /^(https?:|mailto:|#|\/)/i.test(value) || isSafeDataImage;
          if (!isSafeUrl || lowerValue.indexOf("javascript:") === 0 || lowerValue.indexOf("data:text/html") === 0) {
            element.removeAttribute(attr.name);
          }
        }
      });

      if (tagName === "a") {
        element.setAttribute("rel", "noopener noreferrer");
        if (!element.getAttribute("target")) {
          element.setAttribute("target", "_blank");
        }
      }
    });

    return template.innerHTML;
  }

  function cleanupLeakedMathSentinels(text) {
    return String(text || "")
      .replace(/\[?\s*SENTIQMATHBLOCKTOKEN\d+END\s*\]?/g, "")
      .replace(/\[?\s*@@SENTIQ_MATH_\d+@@\s*\]?/g, "")
      .replace(/@@\s*SENTIQ(?:\s|<[^>]+>)*ATH(?:\s|<[^>]+>|[A-Za-z0-9])*?@@/g, "")
      .replace(/\bMATH\d+\b/g, "")
      .replace(/[ \t]{2,}/g, " ");
  }

  function normalizeMathTex(tex) {
    return String(tex || "")
      .replace(/\\\\(?=(?:begin|end|[A-Za-z()[\]]))/g, "\\")
      .replace(/<->/g, "\\leftrightarrow ")
      .replace(/=>/g, "\\Rightarrow ")
      .replace(/->/g, "\\to ")
      .replace(/<-/g, "\\leftarrow ")
      .replace(/>=/g, "\\ge ")
      .replace(/<=/g, "\\le ")
      .replace(/!=/g, "\\ne ")
      .replace(/\bR(\d+)\b/g, "R_{$1}")
      .replace(/(\d)R(\d+)/g, "$1R_{$2}")
      .replace(/\bv_([A-Za-z0-9])/g, "v_{$1}")
      .replace(/\b([A-Za-z])_([A-Za-z0-9])/g, "$1_{$2}")
      .replace(/\bsqrt\(([^()]+)\)/g, "\\sqrt{$1}")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function unwrapMathTex(raw, display) {
    var tex = String(raw || "").trim();
    if (tex.indexOf("$$") === 0 && tex.lastIndexOf("$$") === tex.length - 2) {
      return tex.slice(2, -2).trim();
    }
    if (tex.indexOf("\\[") === 0 && tex.slice(-2) === "\\]") {
      return tex.slice(2, -2).trim();
    }
    if (tex.indexOf("\\(") === 0 && tex.slice(-2) === "\\)") {
      return tex.slice(2, -2).trim();
    }
    if (!display && tex.charAt(0) === "$" && tex.charAt(tex.length - 1) === "$") {
      return tex.slice(1, -1).trim();
    }
    return tex;
  }

  function renderMathFallback(tex, displayMode) {
    var escaped = escapeHtml(tex || "");
    return displayMode
      ? '<div class="math-display-shell"><code class="math-inline-fallback">' + escaped + "</code></div>"
      : '<code class="math-inline-fallback">' + escaped + "</code>";
  }

  function renderMathSegment(tex, displayMode, deps) {
    var normalized = normalizeMathTex(unwrapMathTex(tex, displayMode));
    var katexRef = deps && deps.katex ? deps.katex : root && root.katex;
    if (!katexRef || typeof katexRef.renderToString !== "function") {
      return renderMathFallback(normalized, displayMode);
    }
    try {
      var rendered = katexRef.renderToString(normalized, {
        displayMode: Boolean(displayMode),
        throwOnError: false,
        trust: false,
        strict: "warn"
      });
      if (rendered.indexOf("katex-error") >= 0) {
        return renderMathFallback(normalized, displayMode);
      }
      return displayMode ? '<div class="math-display-shell">' + rendered + "</div>" : rendered;
    } catch (_err) {
      return renderMathFallback(normalized, displayMode);
    }
  }

  function countProseWords(value) {
    var words = String(value || "").replace(/\\[A-Za-z]+/g, " ").match(/\b[A-Za-z]{3,}\b/g) || [];
    return words.filter(function (word) { return !MATH_TERMS.test(word); }).length;
  }

  function strictEquationLine(line) {
    void line;
    return false;
  }

  function isEscapedAt(source, index) {
    var slashCount = 0;
    for (var cursor = index - 1; cursor >= 0 && source.charAt(cursor) === "\\"; cursor -= 1) {
      slashCount += 1;
    }
    return slashCount % 2 === 1;
  }

  function isMarkdownTableLine(source, index) {
    var lineStart = source.lastIndexOf("\n", index - 1) + 1;
    var lineEnd = source.indexOf("\n", index);
    if (lineEnd < 0) lineEnd = source.length;
    var line = source.slice(lineStart, lineEnd).trim();
    if (line.indexOf("|") < 0) return false;
    if (/^:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+$/.test(line.replace(/^\||\|$/g, "").trim())) return true;
    return /^\|?.+\|.+\|?$/.test(line);
  }

  function makeMathCandidate(source, index, end, display) {
    return {
      index: index,
      end: end,
      raw: source.slice(index, end),
      display: Boolean(display)
    };
  }

  function findDelimitedMath(source, startIndex, open, close, display) {
    var searchIndex = startIndex;
    while (searchIndex < source.length) {
      var index = source.indexOf(open, searchIndex);
      if (index < 0) return null;
      if ((open === "$$" || open === "$") && isEscapedAt(source, index)) {
        searchIndex = index + open.length;
        continue;
      }
      var closeIndex = source.indexOf(close, index + open.length);
      if (closeIndex < 0) return null;
      var end = closeIndex + close.length;
      var inner = source.slice(index + open.length, closeIndex).trim();
      if (!inner || (display && isMarkdownTableLine(source, index))) {
        searchIndex = end;
        continue;
      }
      return makeMathCandidate(source, index, end, display);
    }
    return null;
  }

  function findClosingInlineDollar(source, openIndex) {
    var searchIndex = openIndex + 1;
    while (searchIndex < source.length) {
      var closeIndex = source.indexOf("$", searchIndex);
      if (closeIndex < 0) return -1;
      if (source.charAt(closeIndex + 1) === "$" || isEscapedAt(source, closeIndex)) {
        searchIndex = closeIndex + 1;
        continue;
      }
      return closeIndex;
    }
    return -1;
  }

  function isSafeInlineDollarMath(source, openIndex, closeIndex) {
    var inner = source.slice(openIndex + 1, closeIndex);
    var trimmed = inner.trim();
    var before = openIndex > 0 ? source.charAt(openIndex - 1) : "";
    var afterOpen = source.charAt(openIndex + 1);
    var afterClose = source.charAt(closeIndex + 1);
    var hasMathSyntax = /[\\=+\-*/^_{}<>]/.test(trimmed);

    if (!trimmed || trimmed.length > 180 || inner.indexOf("\n") >= 0) return false;
    if (/\s/.test(afterOpen) || /^\d/.test(trimmed)) return false;
    if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(afterClose)) return false;
    if (!hasMathSyntax && !/^[A-Za-z]$/.test(trimmed)) return false;
    if (!hasMathSyntax && countProseWords(trimmed) > 0) return false;
    return /[A-Za-z\\=+\-*/^_{}<>]/.test(trimmed);
  }

  function findInlineDollarMath(source, startIndex) {
    var searchIndex = startIndex;
    while (searchIndex < source.length) {
      var openIndex = source.indexOf("$", searchIndex);
      if (openIndex < 0) return null;
      if (source.charAt(openIndex + 1) === "$" || isEscapedAt(source, openIndex)) {
        searchIndex = openIndex + 1;
        continue;
      }
      var closeIndex = findClosingInlineDollar(source, openIndex);
      if (closeIndex < 0) return null;
      if (isSafeInlineDollarMath(source, openIndex, closeIndex)) {
        return makeMathCandidate(source, openIndex, closeIndex + 1, false);
      }
      searchIndex = openIndex + 1;
    }
    return null;
  }

  function findExplicitMath(source, startIndex) {
    var candidates = [
      findDelimitedMath(source, startIndex, "\\[", "\\]", true),
      findDelimitedMath(source, startIndex, "$$", "$$", true),
      findDelimitedMath(source, startIndex, "\\(", "\\)", false),
      findInlineDollarMath(source, startIndex)
    ].filter(Boolean);
    if (!candidates.length) return null;
    candidates.sort(function (left, right) {
      return left.index - right.index || right.raw.length - left.raw.length;
    });
    return candidates[0];
  }

  function pushProseSegment(segments, value) {
    if (!value) return;
    var previous = segments[segments.length - 1];
    if (previous && previous.type === "prose") {
      previous.value += value;
    } else {
      segments.push({ type: "prose", value: value });
    }
  }

  function segmentPlainText(value, segments) {
    pushProseSegment(segments, value);
  }

  function segmentText(source) {
    var segments = [];
    var text = cleanupLeakedMathSentinels(source);
    var codeFence = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
    var cursor = 0;
    var match;

    function segmentMathInText(value) {
      var local = String(value || "");
      var offset = 0;
      while (offset < local.length) {
        var found = findExplicitMath(local, offset);
        if (!found) {
          segmentPlainText(local.slice(offset), segments);
          break;
        }
        if (found.index > offset) {
          segmentPlainText(local.slice(offset, found.index), segments);
        }
        segments.push({ type: "math", display: found.display, value: found.raw });
        offset = found.end;
      }
    }

    function segmentNonCode(value) {
      var local = String(value || "");
      var inlineCode = /`[^`\n]*`/g;
      var cursor = 0;
      var match;
      while ((match = inlineCode.exec(local)) !== null) {
        if (match.index > cursor) {
          segmentMathInText(local.slice(cursor, match.index));
        }
        pushProseSegment(segments, match[0]);
        cursor = match.index + match[0].length;
      }
      if (cursor < local.length) {
        segmentMathInText(local.slice(cursor));
      }
    }

    while ((match = codeFence.exec(text)) !== null) {
      if (match.index > cursor) {
        segmentNonCode(text.slice(cursor, match.index));
      }
      segments.push({ type: "code", value: match[0] });
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) {
      segmentNonCode(text.slice(cursor));
    }
    return segments;
  }

  function renderMarkdown(value, deps) {
    var markedRef = deps && deps.marked ? deps.marked : root && root.marked;
    if (markedRef && typeof markedRef.parse === "function") {
      return markedRef.parse(value);
    }
    var html = escapeHtml(value);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
    html = html.split("\n\n").map(function (paragraph) {
      return paragraph.trim() ? "<p>" + paragraph.trim() + "</p>" : "";
    }).join("");
    return html.replace(/(?<!\n)\n(?!\n)/g, "<br>");
  }

  function renderRichText(text, options, deps) {
    var renderOptions = options || {};
    var source = String(text || "");
    if (!source) return "";

    var maxChars = renderOptions.maxRenderChars || MAX_RENDER_CHARS_DEFAULT;
    var truncated = false;
    if (source.length > maxChars) {
      source = source.slice(0, maxChars);
      truncated = true;
    }

    var segments = segmentText(source);
    var hasMath = segments.some(function (segment) { return segment.type === "math"; });
    var mathPlaceholders = [];
    var html = "";
    var markdownBuffer = "";

    function stashRenderedMath(renderedMath) {
      var token = "SENTIQKATEXPLACEHOLDER" + mathPlaceholders.length + "END";
      mathPlaceholders.push(renderedMath);
      return token;
    }

    function restoreRenderedMath(value) {
      return String(value || "")
        .replace(/SENTIQKATEXPLACEHOLDER(\d+)END/g, function (match, index) {
          return mathPlaceholders[Number(index)] || "";
        })
        .replace(/SENTIQKATEXPLACEHOLDER\d+END/g, "");
    }

    function flushMarkdownBuffer() {
      if (!markdownBuffer) return;
      html += renderMarkdown(markdownBuffer, deps);
      markdownBuffer = "";
    }

    segments.forEach(function (segment) {
      if (segment.type !== "math") {
        markdownBuffer += segment.value;
        return;
      }

      if (segment.display) {
        flushMarkdownBuffer();
        html += stashRenderedMath(renderMathSegment(segment.value, true, deps));
        return;
      }

      markdownBuffer += stashRenderedMath(renderMathSegment(segment.value, false, deps));
    });
    flushMarkdownBuffer();

    if (truncated) {
      html += '<div class="truncation-notice">[Message truncated - original exceeded 100k characters]</div>';
    }
    if (hasMath || /\bmath-display-shell\b|\bkatex-display\b|\bkatex\b/.test(html)) {
      html = '<div class="math-enhanced">' + html + "</div>";
    }
    return restoreRenderedMath(sanitizeRenderedHtml(html));
  }

  function runMathRenderSmokeTests() {
    var tests = [
      {
        name: "inline \\( ... \\)",
        input: "\\(x_0 + y_1\\)",
        expect: function (html) { return /\bkatex\b/.test(html) && !/math-inline-fallback/.test(html); }
      },
      {
        name: "display \\[ ... \\]",
        input: "\\[ \\frac{3h}{8}(y_0 + 3y_1 + 3y_2 + y_3) \\]",
        expect: function (html) { return /math-display-shell/.test(html) && /\bkatex-display\b/.test(html) && /mfrac/.test(html); }
      },
      {
        name: "display $$ ... $$",
        input: "$$x_0 + y_1$$",
        expect: function (html) { return /math-display-shell/.test(html) && /\bkatex-display\b/.test(html); }
      },
      {
        name: "currency stays prose",
        input: "The price is $20 and not math.",
        expect: function (html) { return html.indexOf("$20") >= 0 && !/\bkatex\b/.test(html); }
      },
      {
        name: "code block preserves dollars",
        input: "```txt\n$x$\n```",
        expect: function (html) { return /code-block-wrap/.test(html) && html.indexOf("$x$") >= 0 && !/\bkatex\b/.test(html); }
      },
      {
        name: "Markdown list with inline math",
        input: "- value \\(x_0\\)\n- next item",
        expect: function (html) { return /<li>/.test(html) && /\bkatex\b/.test(html); }
      },
      {
        name: "malformed LaTeX fallback",
        input: "\\(\\frac{1}{\\)",
        expect: function (html) { return /math-inline-fallback/.test(html) && !/katex-error/.test(html); }
      }
    ];
    var results = tests.map(function (test) {
      var html = renderRichText(test.input, { mode: "math" });
      var pass = false;
      try {
        pass = Boolean(test.expect(html));
      } catch (_err) {
        pass = false;
      }
      return {
        name: test.name,
        pass: pass,
        html: html
      };
    });
    if (root && root.console && typeof root.console.table === "function") {
      root.console.table(results.map(function (result) {
        return { name: result.name, pass: result.pass };
      }));
      if (results.some(function (result) { return !result.pass; }) && typeof root.console.warn === "function") {
        root.console.warn("[SentIQRenderer] Math smoke test failures:", results.filter(function (result) { return !result.pass; }));
      }
    }
    return results;
  }

  return {
    escapeHtml: escapeHtml,
    sanitizeRenderedHtml: sanitizeRenderedHtml,
    cleanupLeakedMathSentinels: cleanupLeakedMathSentinels,
    findExplicitMath: findExplicitMath,
    segmentText: segmentText,
    renderMathSegment: renderMathSegment,
    renderRichText: renderRichText,
    runMathRenderSmokeTests: runMathRenderSmokeTests,
    strictEquationLine: strictEquationLine,
    normalizeMathTex: normalizeMathTex
  };
});

if (typeof window !== "undefined" && !window.SentIQRenderer?.renderRichText) {
  try {
    const debugKey = window.SentIQBrand?.STORAGE_KEYS?.debug || "sentiq-chat:debug";
    const legacyDebugKey = window.SentIQBrand?.LEGACY_STORAGE_KEYS?.debug || "sentiq_debug";
    if (
      window.SENTIQ_DEBUG ||
      localStorage.getItem(debugKey) === "1" ||
      localStorage.getItem(legacyDebugKey) === "1"
    ) {
      console.warn("[SentIQRenderer] Inline renderer failed to initialize; Markdown-only fallback will be used.");
    }
  } catch (_) {}
}
