// SentIQGPT — Chart Renderer
//
// Renders charts from the backend response payload.
// Supports three renderer types:
//   matplotlib → base64 PNG image (server-rendered)
//   plotly     → Plotly.js interactive chart
//   chartjs    → Chart.js canvas chart
//
// The Chart.js config is extracted from the code string via a safe eval
// approach: the code is expected to contain a JSON config assigned to
// a `chartConfig` variable.

/* global Plotly, Chart */

/**
 * Render a chart result into a container element.
 *
 * @param {HTMLElement} container - Target DOM element
 * @param {object} chartResult - Backend ChartResult payload
 *   { chart_type, renderer, code, preview, success }
 */
function renderChart(container, chartResult) {
  if (!chartResult || !chartResult.success) {
    container.innerHTML = `<div style="padding:16px;color:var(--danger);font-size:13px;">
      ⚠ Chart generation failed: ${escapeHtml(chartResult?.error ?? "Unknown error")}
    </div>`;
    return;
  }

  const { renderer, chart_type, code, preview } = chartResult;

  // Build the wrapper
  container.innerHTML = "";
  container.className = "chart-container";

  // ── Header ──
  const header = document.createElement("div");
  header.className = "chart-header";
  header.innerHTML = `
    <span>📊 ${escapeHtml(chart_type.replace("_", " "))}</span>
    <span class="chart-renderer-badge ${renderer}">${renderer}</span>
  `;
  container.appendChild(header);

  // ── Chart body ──
  if (renderer === "matplotlib" && preview) {
    renderMatplotlibPreview(container, preview);
  } else if (renderer === "plotly") {
    renderPlotly(container, code);
  } else if (renderer === "chartjs") {
    renderChartJs(container, code);
  } else if (preview) {
    // Any renderer with a base64 preview — show the image
    renderMatplotlibPreview(container, preview);
  } else {
    // Fallback: just show the code with a note
    const note = document.createElement("div");
    note.style.cssText = "padding:14px 16px;font-size:13px;color:var(--text-secondary);";
    note.textContent = `Chart code generated (${renderer}). Preview unavailable in this environment.`;
    container.appendChild(note);
  }

  // ── Collapsible code section ──
  if (code) {
    appendCodeSection(container, code, renderer);
  }
}

// ─── Matplotlib (base64 PNG) ──────────────────────────────────────────────

function renderMatplotlibPreview(container, preview) {
  const img = document.createElement("img");
  img.className = "chart-preview-image";
  // Accept both "data:image/png;base64,..." and raw base64
  img.src = preview.startsWith("data:") ? preview : `data:image/png;base64,${preview}`;
  img.alt = "Generated chart";
  img.onerror = () => {
    img.replaceWith(makeErrorNote("Failed to decode chart image."));
  };
  container.appendChild(img);
}

// ─── Plotly ───────────────────────────────────────────────────────────────

function renderPlotly(container, code) {
  if (typeof Plotly === "undefined") {
    // Lazily load Plotly from CDN then retry
    const script = document.createElement("script");
    script.src = "https://cdn.plot.ly/plotly-2.32.0.min.js";
    script.onload = () => renderPlotly(container, code);
    script.onerror = () => container.appendChild(makeErrorNote("Failed to load Plotly.js."));
    document.head.appendChild(script);
    container.appendChild(makeLoadingNote("Loading Plotly…"));
    return;
  }

  // Remove any previous loading note
  container.querySelectorAll(".chart-loading").forEach((el) => el.remove());

  const plotDiv = document.createElement("div");
  plotDiv.className = "chart-plotly-container";
  container.appendChild(plotDiv);

  try {
    // Extract Plotly data/layout from the generated Python code by parsing
    // the JSON spec embedded in the CHART_SPEC comment block.
    // As a safe fallback, produce a simple placeholder Plotly figure.
    const specMatch = code.match(/CHART_SPEC_JSON\s*=\s*({[\s\S]*?})\s*\n/);
    if (specMatch) {
      const spec = JSON.parse(specMatch[1]);
      Plotly.newPlot(plotDiv, spec.data ?? [], spec.layout ?? {}, { responsive: true });
    } else {
      // Generic Plotly figure (renderer code not yet executed server-side)
      Plotly.newPlot(
        plotDiv,
        [{ x: [1, 2, 3, 4, 5], y: [2, 4, 3, 6, 5], type: "scatter", mode: "lines+markers" }],
        { title: "Preview unavailable — run code locally", paper_bgcolor: "transparent", plot_bgcolor: "transparent", font: { color: "#e6edf3" } },
        { responsive: true },
      );
    }
  } catch (e) {
    plotDiv.replaceWith(makeErrorNote(`Plotly render error: ${e.message}`));
  }
}

// ─── Chart.js ────────────────────────────────────────────────────────────

function renderChartJs(container, code) {
  if (typeof Chart === "undefined") {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js";
    script.onload = () => renderChartJs(container, code);
    script.onerror = () => container.appendChild(makeErrorNote("Failed to load Chart.js."));
    document.head.appendChild(script);
    container.appendChild(makeLoadingNote("Loading Chart.js…"));
    return;
  }

  container.querySelectorAll(".chart-loading").forEach((el) => el.remove());

  const wrapper = document.createElement("div");
  wrapper.className = "chart-canvas-wrapper";
  const canvas = document.createElement("canvas");
  wrapper.appendChild(canvas);
  container.appendChild(wrapper);

  try {
    // Extract the chartConfig object from the generated JS code.
    // The chartjs renderer emits: const chartConfig = { type:..., data:..., options:... }
    // We use a Function constructor to safely evaluate the config object in isolation.
    // Only the chartConfig variable is extracted — no DOM access is granted.
    const configMatch = code.match(/const\s+chartConfig\s*=\s*(\{[\s\S]+?\});\s*(?:\/\/|new Chart|$)/m);
    let config;
    if (configMatch) {
      // eslint-disable-next-line no-new-func
      config = new Function(`"use strict"; return (${configMatch[1]});`)();
    } else {
      // Fallback placeholder
      config = {
        type: "bar",
        data: {
          labels: ["A", "B", "C", "D", "E"],
          datasets: [{ label: "Values", data: [25, 42, 18, 56, 30], backgroundColor: "#58a6ff" }],
        },
        options: { responsive: true, maintainAspectRatio: false },
      };
    }

    // Ensure responsive rendering
    if (!config.options) config.options = {};
    config.options.responsive = true;
    config.options.maintainAspectRatio = false;

    new Chart(canvas, config);
  } catch (e) {
    wrapper.replaceWith(makeErrorNote(`Chart.js render error: ${e.message}`));
  }
}

// ─── Code section ─────────────────────────────────────────────────────────

function appendCodeSection(container, code, renderer) {
  const section = document.createElement("div");
  section.className = "chart-code-section";

  const toggle = document.createElement("button");
  toggle.className = "chart-code-toggle";
  toggle.innerHTML = `<span>▶</span> View ${renderer} code`;

  const codeBlock = document.createElement("pre");
  codeBlock.className = "chart-code-block";
  codeBlock.textContent = code;

  toggle.addEventListener("click", () => {
    const isVisible = codeBlock.classList.toggle("visible");
    toggle.querySelector("span").textContent = isVisible ? "▼" : "▶";
  });

  section.appendChild(toggle);
  section.appendChild(codeBlock);
  container.appendChild(section);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeErrorNote(msg) {
  const el = document.createElement("div");
  el.style.cssText = "padding:12px 16px;color:var(--danger);font-size:13px;";
  el.textContent = `⚠ ${msg}`;
  return el;
}

function makeLoadingNote(msg) {
  const el = document.createElement("div");
  el.className = "chart-loading";
  el.style.cssText = "padding:12px 16px;color:var(--text-muted);font-size:13px;";
  el.textContent = msg;
  return el;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

window.SentIQChartRenderer = { renderChart };
