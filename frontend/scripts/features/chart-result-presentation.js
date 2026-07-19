/* SentIQ Liquid Glass V4 — Phase 7.3 chart results */

import { ASSET_RESULT_VERSION, cleanAssetText, findMessageRetryControl } from "./asset-result-state.js";

const EXPORT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>';
const legendSchedules = new WeakSet();

function setAttributeIfChanged(element, name, value) {
  if (element && element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function chartRenderer(container) {
  if (container.querySelector(".js-plotly-plot")) return "Interactive chart";
  if (container.querySelector("canvas")) return "Chart.js chart";
  if (container.querySelector(".message-chart-image")) return "Chart image";
  return "Preparing chart";
}

function ensureHeader(container) {
  let header = container.querySelector(":scope > .asset-chart-header");
  if (header) return header;
  header = document.createElement("header");
  header.className = "asset-result-header asset-chart-header";
  header.innerHTML = '<span class="asset-result-heading"><span class="asset-result-kicker">Chart</span><span class="asset-result-meta"></span></span><span class="asset-result-actions" role="toolbar" aria-label="Chart actions"></span>';
  container.insertBefore(header, container.firstChild);
  return header;
}

function setChartStatus(container, message = "", tone = "status") {
  let status = container.querySelector(":scope > .asset-chart-status");
  if (!message) {
    status?.remove();
    return;
  }
  if (!status) {
    status = document.createElement("div");
    status.className = "asset-chart-status";
    const header = container.querySelector(":scope > .asset-chart-header");
    (header || container.firstElementChild)?.insertAdjacentElement("afterend", status);
  }
  status.classList.toggle("is-error", tone === "error");
  status.textContent = message;
  status.setAttribute("role", tone === "error" ? "alert" : "status");
}

function triggerDownload(href, filename) {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function exportChart(container, button) {
  button.disabled = true;
  setAttributeIfChanged(button, "aria-busy", "true");
  setChartStatus(container, "");
  try {
    const plot = container.querySelector(".js-plotly-plot");
    if (plot && window.Plotly?.downloadImage) {
      await window.Plotly.downloadImage(plot, { format: "png", filename: `sentiq-chart-${Date.now()}` });
      setChartStatus(container, "Chart export started.");
      return;
    }
    const canvas = container.querySelector("canvas");
    if (canvas) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Chart export is unavailable.");
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `sentiq-chart-${Date.now()}.png`);
      setTimeout(() => URL.revokeObjectURL(url), 1200);
      setChartStatus(container, "Chart export started.");
      return;
    }
    const image = container.querySelector(".message-chart-image");
    if (image?.currentSrc || image?.src) {
      triggerDownload(image.currentSrc || image.src, `sentiq-chart-${Date.now()}.png`);
      setChartStatus(container, "Chart export started.");
      return;
    }
    throw new Error("Chart export is unavailable.");
  } catch {
    setChartStatus(container, "This chart could not be exported. Try regenerating it.", "error");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function legendEntries(container) {
  const canvas = container.querySelector("canvas");
  const chart = canvas && window.Chart?.getChart?.(canvas);
  if (chart?.data?.datasets) {
    return chart.data.datasets.map((dataset, index) => ({
      label: cleanAssetText(dataset.label) || `Series ${index + 1}`,
      color: Array.isArray(dataset.borderColor) ? dataset.borderColor[0] : dataset.borderColor
        || (Array.isArray(dataset.backgroundColor) ? dataset.backgroundColor[0] : dataset.backgroundColor),
    }));
  }
  const plot = container.querySelector(".js-plotly-plot");
  const traces = plot?._fullData || plot?.data || [];
  return traces.filter((trace) => trace?.showlegend !== false && cleanAssetText(trace?.name)).map((trace) => ({
    label: cleanAssetText(trace.name),
    color: trace?.line?.color || (Array.isArray(trace?.marker?.color) ? trace.marker.color[0] : trace?.marker?.color) || "",
  }));
}

function syncLegend(container) {
  const entries = legendEntries(container).slice(0, 12);
  let legend = container.querySelector(":scope > .asset-chart-legend");
  if (!entries.length) {
    legend?.remove();
    return false;
  }
  const signature = entries.map((entry) => `${entry.label}:${entry.color}`).join("|");
  if (!legend) {
    legend = document.createElement("div");
    legend.className = "asset-chart-legend";
    legend.setAttribute("aria-label", "Chart legend");
    legend.setAttribute("role", "list");
    container.appendChild(legend);
  }
  if (legend.dataset.signature === signature) return true;
  legend.dataset.signature = signature;
  legend.replaceChildren(...entries.map((entry) => {
    const item = document.createElement("span");
    item.className = "asset-chart-legend-item";
    item.setAttribute("role", "listitem");
    const swatch = document.createElement("span");
    swatch.className = "asset-chart-legend-swatch";
    if (typeof entry.color === "string" && entry.color) swatch.style.background = entry.color;
    swatch.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = entry.label;
    item.append(swatch, label);
    return item;
  }));
  return true;
}

function scheduleLegendSync(container) {
  if (legendSchedules.has(container)) return;
  legendSchedules.add(container);
  [0, 260, 760, 1500].forEach((delay, index, delays) => {
    setTimeout(() => {
      if (container.isConnected) syncLegend(container);
      if (index === delays.length - 1) legendSchedules.delete(container);
    }, delay);
  });
}

function createChartImage(container, source) {
  const image = document.createElement("img");
  image.className = "message-chart-image";
  image.alt = "Generated chart";
  image.loading = "eager";
  image.addEventListener("load", () => enhanceChartResult(container), { once: true });
  image.addEventListener("error", () => {
    const error = document.createElement("div");
    error.className = "message-chart-error";
    error.textContent = "Chart image failed to load.";
    image.replaceWith(error);
    enhanceChartResult(container);
  }, { once: true });
  image.src = source;
  return image;
}

function ensureFailure(container) {
  const error = container.querySelector(".message-chart-error");
  let actions = container.querySelector(":scope > .asset-result-failure-actions");
  if (!error) {
    actions?.remove();
    container.classList.remove("is-failed");
    return;
  }
  container.classList.add("is-failed");
  setAttributeIfChanged(error, "role", "alert");
  if (actions) return;

  const retryControl = findMessageRetryControl(container);
  const source = container.dataset.assetChartImageSource || "";
  actions = document.createElement("div");
  actions.className = "asset-result-failure-actions";
  if (source || retryControl) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "asset-result-retry";
    retry.textContent = "Retry chart";
    retry.addEventListener("click", () => {
      if (!source && retryControl) {
        retryControl.click();
        return;
      }
      retry.disabled = true;
      error.remove();
      actions.remove();
      setChartStatus(container, "Retrying chart…");
      container.appendChild(createChartImage(container, source));
      enhanceChartResult(container);
    });
    actions.appendChild(retry);
  } else {
    const hint = document.createElement("span");
    hint.textContent = "Use the response retry action to regenerate this chart.";
    actions.appendChild(hint);
  }
  container.appendChild(actions);
}

export function enhanceChartResult(container) {
  if (!(container instanceof HTMLElement)) return;
  container.dataset.assetResultVersion = ASSET_RESULT_VERSION;
  container.dataset.assetResultKind = "chart";
  setAttributeIfChanged(container, "role", "figure");
  setAttributeIfChanged(container, "aria-label", "Generated chart result");

  const header = ensureHeader(container);
  const meta = header.querySelector(".asset-result-meta");
  const renderer = chartRenderer(container);
  if (meta && meta.textContent !== renderer) meta.textContent = renderer;
  const actions = header.querySelector(".asset-result-actions");
  let exportButton = actions?.querySelector(".asset-chart-export");
  if (!exportButton && actions) {
    exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "asset-result-action asset-chart-export";
    exportButton.title = "Export chart as PNG";
    exportButton.setAttribute("aria-label", "Export chart as PNG");
    exportButton.innerHTML = `${EXPORT_ICON}<span>Export</span>`;
    exportButton.addEventListener("click", () => exportChart(container, exportButton));
    actions.appendChild(exportButton);
  }

  const image = container.querySelector(".message-chart-image");
  if (image?.src && !container.dataset.assetChartImageSource) {
    container.dataset.assetChartImageSource = image.currentSrc || image.src;
  }
  const ready = Boolean(image?.complete && image.naturalWidth > 0)
    || Boolean(container.querySelector("canvas, .js-plotly-plot"));
  const hasError = Boolean(container.querySelector(".message-chart-error"));
  container.classList.toggle("is-loading", !ready && !hasError);
  container.classList.toggle("is-ready", ready);
  setAttributeIfChanged(container, "aria-busy", !ready && !hasError ? "true" : "false");
  if (exportButton && exportButton.disabled === ready) exportButton.disabled = !ready;
  const status = container.querySelector(":scope > .asset-chart-status");
  if ((ready || hasError) && status?.textContent?.includes("Retrying")) status.remove();
  ensureFailure(container);
  scheduleLegendSync(container);
}
