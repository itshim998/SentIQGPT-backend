// SentIQGPT - Frontend Chart Payload Builder
//
// Builds deterministic, JSON-serializable payloads for frontend chart
// renderers so the UI can render Plotly and Chart.js charts directly
// without executing arbitrary source code.

import type {
  ChartJsConfigSpec,
  ChartSpec,
  PlotlyFigureSpec,
} from "./types";

interface GeneratedSeries {
  readonly x?: number[];
  readonly y?: number[];
  readonly categories?: string[];
  readonly values?: number[];
  readonly matrix?: number[][];
  readonly t?: number[];
  readonly labels?: number[];
  readonly clusters?: readonly { readonly label: string; readonly points: readonly { x: number; y: number }[] }[];
  readonly groups?: readonly { readonly label: string; readonly values: readonly number[] }[];
}

function createSeededRng(seed = 42): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function gaussianSample(rng: () => number, mean: number, std: number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + std * z;
}

function linspace(start: number, end: number, count: number): number[] {
  if (count <= 1) return [start];
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, index) => start + step * index);
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function linearFit(x: readonly number[], y: readonly number[]): { slope: number; intercept: number } {
  const n = Math.min(x.length, y.length);
  if (n === 0) return { slope: 1, intercept: 0 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i += 1) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumXX += x[i] * x[i];
  }

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return { slope: 1, intercept: 0 };

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function generateSeries(spec: ChartSpec): GeneratedSeries {
  const { chart_type: type, data_generation: gen } = spec;
  const rng = createSeededRng(42);

  switch (gen.method) {
    case "gaussian_distribution": {
      const n = gen.num_points ?? 800;
      if (type === "histogram") {
        return {
          x: Array.from({ length: n }, () => round(gaussianSample(rng, gen.x_mean ?? 5, gen.x_std ?? 1))),
        };
      }
      return {
        x: Array.from({ length: n }, () => round(gaussianSample(rng, gen.x_mean ?? 5, gen.x_std ?? 1))),
        y: Array.from({ length: n }, () => round(gaussianSample(rng, gen.y_mean ?? 10, gen.y_std ?? 2))),
      };
    }

    case "linear_sequence": {
      const x = linspace(gen.x_start ?? 0, gen.x_end ?? 10, gen.x_steps ?? 100).map((value) => round(value));
      return { x, y: [...x] };
    }

    case "static_values":
      return {
        categories: [...(gen.categories ?? ["A", "B", "C", "D", "E"])],
        values: [...(gen.values ?? [25, 42, 18, 56, 30])],
      };

    case "random_matrix": {
      const size = gen.num_points ?? 10;
      return {
        matrix: Array.from({ length: size }, () =>
          Array.from({ length: size }, () => round(gaussianSample(rng, 0, 1))),
        ),
      };
    }

    case "time_series_with_noise": {
      const t = linspace(gen.x_start ?? 0, gen.x_end ?? 100, gen.x_steps ?? 100).map((value) => round(value));
      const y: number[] = [];
      let current = 50;
      for (let i = 0; i < t.length; i += 1) {
        current += gaussianSample(rng, 0, 1);
        y.push(round(current));
      }
      return { t, y };
    }

    case "linear_with_noise": {
      const n = gen.num_points ?? 800;
      const x = Array.from({ length: n }, () => round(gaussianSample(rng, gen.x_mean ?? 5, gen.x_std ?? 1)));
      const y = x.map((value) => round(2 * value + 1 + gaussianSample(rng, 0, gen.y_std ?? 1)));
      return { x, y };
    }

    case "pca_clusters":
    case "gaussian_clusters": {
      const n = gen.num_points ?? 800;
      const perCluster = Math.max(10, Math.floor(n / 3));
      const centers = gen.method === "pca_clusters"
        ? [{ x: -4, y: -1 }, { x: 0, y: 4 }, { x: 4, y: -2 }]
        : [{ x: 2, y: 2 }, { x: 6, y: 6 }, { x: 10, y: 2 }];
      const spread = gen.method === "pca_clusters" ? 1 : 0.8;
      const clusters = centers.map((center, index) => ({
        label: `Cluster ${index}`,
        points: Array.from({ length: perCluster }, () => ({
          x: round(gaussianSample(rng, center.x, spread)),
          y: round(gaussianSample(rng, center.y, spread)),
        })),
      }));

      return {
        clusters,
        x: clusters.flatMap((cluster) => cluster.points.map((point) => point.x)),
        y: clusters.flatMap((cluster) => cluster.points.map((point) => point.y)),
        labels: clusters.flatMap((cluster, index) => cluster.points.map(() => index)),
      };
    }

    case "gaussian_groups": {
      const labels = [...(gen.categories ?? ["Group A", "Group B", "Group C"])];
      const count = gen.num_points ?? 200;
      const mean = gen.x_mean ?? 5;
      const std = gen.x_std ?? 1;
      return {
        groups: labels.map((label, index) => ({
          label,
          values: Array.from({ length: count }, () => round(gaussianSample(rng, mean + index * 2, std))),
        })),
      };
    }

    default: {
      const x = linspace(0, 10, 100).map((value) => round(value));
      return { x, y: [...x] };
    }
  }
}

export function buildPlotlyFigure(spec: ChartSpec): PlotlyFigureSpec | undefined {
  const { chart_type: type, axes, style, data_generation: gen } = spec;
  const palette = [...(style.color_palette ?? ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"])];
  const color = style.marker_color ?? palette[0] ?? "#1f77b4";
  const lineWidth = style.line_width ?? 2;
  const markerSize = style.marker_size ?? 6;
  const generated = generateSeries(spec);

  const layout: Record<string, unknown> = {
    showlegend: false,
    xaxis: { title: axes.x_label ?? "X" },
    yaxis: { title: axes.y_label ?? "Y" },
  };

  if (axes.x_range) (layout.xaxis as Record<string, unknown>).range = [...axes.x_range];
  if (axes.y_range) (layout.yaxis as Record<string, unknown>).range = [...axes.y_range];

  let data: Record<string, unknown>[];

  switch (type) {
    case "scatter":
      data = [{
        type: "scatter",
        mode: "markers",
        x: generated.x ?? [],
        y: generated.y ?? [],
        marker: { color, size: markerSize, opacity: 0.7 },
      }];
      break;

    case "line":
      data = [{
        type: "scatter",
        mode: "lines",
        x: generated.x ?? [],
        y: generated.y ?? [],
        line: { color, width: lineWidth },
      }];
      break;

    case "bar":
      data = [{
        type: "bar",
        x: generated.categories ?? [],
        y: generated.values ?? [],
        marker: { color: palette.slice(0, (generated.categories ?? []).length || palette.length) },
      }];
      break;

    case "histogram":
      data = [{
        type: "histogram",
        x: generated.x ?? [],
        nbinsx: gen.num_bins ?? 30,
        marker: { color },
      }];
      break;

    case "heatmap":
      data = [{
        type: "heatmap",
        z: generated.matrix ?? [],
        colorscale: "Viridis",
      }];
      break;

    case "time_series":
      data = [{
        type: "scatter",
        mode: "lines",
        x: generated.t ?? [],
        y: generated.y ?? [],
        line: { color, width: lineWidth },
      }];
      break;

    case "regression": {
      const x = generated.x ?? [];
      const y = generated.y ?? [];
      const { slope, intercept } = linearFit(x, y);
      const xMin = axes.x_range?.[0] ?? Math.min(...x);
      const xMax = axes.x_range?.[1] ?? Math.max(...x);
      const lineX = linspace(xMin, xMax, 100).map((value) => round(value));
      const lineY = lineX.map((value) => round(slope * value + intercept));
      layout.showlegend = true;
      data = [
        {
          type: "scatter",
          mode: "markers",
          name: "Data",
          x,
          y,
          marker: { color, size: markerSize, opacity: 0.65 },
        },
        {
          type: "scatter",
          mode: "lines",
          name: "Regression line",
          x: lineX,
          y: lineY,
          line: { color: "#d62728", width: lineWidth },
        },
      ];
      break;
    }

    case "pca":
    case "clustering":
      layout.showlegend = true;
      data = (generated.clusters ?? []).map((cluster, index) => ({
        type: "scatter",
        mode: "markers",
        name: cluster.label,
        x: cluster.points.map((point) => point.x),
        y: cluster.points.map((point) => point.y),
        marker: {
          color: palette[index % palette.length],
          size: markerSize,
          opacity: 0.7,
        },
      }));
      break;

    case "pie":
      layout.showlegend = true;
      data = [{
        type: "pie",
        labels: generated.categories ?? [],
        values: generated.values ?? [],
        marker: { colors: palette.slice(0, (generated.categories ?? []).length || palette.length) },
      }];
      delete layout.xaxis;
      delete layout.yaxis;
      break;

    case "box":
      layout.showlegend = false;
      data = (generated.groups ?? []).map((group, index) => ({
        type: "box",
        name: group.label,
        y: group.values,
        marker: { color: palette[index % palette.length] },
      }));
      break;

    default:
      data = [{
        type: "scatter",
        mode: "markers",
        x: generated.x ?? [],
        y: generated.y ?? [],
        marker: { color },
      }];
  }

  return {
    data,
    layout,
    config: {
      responsive: true,
      displayModeBar: false,
    },
  };
}

export function buildChartJsConfig(spec: ChartSpec): ChartJsConfigSpec | undefined {
  const { chart_type: type, axes, style, data_generation: gen } = spec;
  const palette = [...(style.color_palette ?? ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"])];
  const color = style.marker_color ?? palette[0] ?? "#1f77b4";
  const lineWidth = style.line_width ?? 2;
  const generated = generateSeries(spec);

  switch (type) {
    case "scatter":
      return {
        type: "scatter",
        data: {
          datasets: [{
            label: "Data",
            data: (generated.x ?? []).map((xValue, index) => ({ x: xValue, y: generated.y?.[index] ?? 0 })),
            backgroundColor: color,
            pointRadius: 3,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { title: { display: true, text: axes.x_label ?? "X" }, min: axes.x_range?.[0], max: axes.x_range?.[1] },
            y: { title: { display: true, text: axes.y_label ?? "Y" }, min: axes.y_range?.[0], max: axes.y_range?.[1] },
          },
        },
      };

    case "line":
      return {
        type: "line",
        data: {
          labels: (generated.x ?? []).map((value) => round(value, 2)),
          datasets: [{
            label: "y = x",
            data: generated.y ?? [],
            borderColor: color,
            borderWidth: lineWidth,
            tension: 0.1,
            pointRadius: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { title: { display: true, text: axes.x_label ?? "X" } },
            y: { title: { display: true, text: axes.y_label ?? "Y" } },
          },
        },
      };

    case "bar":
      return {
        type: "bar",
        data: {
          labels: generated.categories ?? [],
          datasets: [{
            label: "Values",
            data: generated.values ?? [],
            backgroundColor: palette.slice(0, (generated.categories ?? []).length || palette.length),
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { title: { display: true, text: axes.x_label ?? "Category" } },
            y: { title: { display: true, text: axes.y_label ?? "Value" } },
          },
        },
      };

    case "histogram": {
      const samples = generated.x ?? [];
      const bins = gen.num_bins ?? 30;
      const min = axes.x_range?.[0] ?? Math.min(...samples);
      const max = axes.x_range?.[1] ?? Math.max(...samples);
      const step = (max - min) / bins;
      const counts = new Array(bins).fill(0);
      for (const sample of samples) {
        const rawIndex = step === 0 ? 0 : Math.floor((sample - min) / step);
        const index = Math.max(0, Math.min(bins - 1, rawIndex));
        counts[index] += 1;
      }
      return {
        type: "bar",
        data: {
          labels: Array.from({ length: bins }, (_, index) => round(min + step * index, 2)),
          datasets: [{
            label: "Frequency",
            data: counts,
            backgroundColor: color,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { title: { display: true, text: axes.x_label ?? "Value" } },
            y: { title: { display: true, text: axes.y_label ?? "Frequency" } },
          },
        },
      };
    }

    case "pie":
      return {
        type: "pie",
        data: {
          labels: generated.categories ?? [],
          datasets: [{
            data: generated.values ?? [],
            backgroundColor: palette.slice(0, (generated.categories ?? []).length || palette.length),
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
        },
      };

    case "time_series":
      return {
        type: "line",
        data: {
          labels: generated.t ?? [],
          datasets: [{
            label: "Value",
            data: generated.y ?? [],
            borderColor: color,
            borderWidth: lineWidth,
            tension: 0.1,
            pointRadius: 0,
            fill: false,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { title: { display: true, text: axes.x_label ?? "Time" } },
            y: { title: { display: true, text: axes.y_label ?? "Value" } },
          },
        },
      };

    default:
      return undefined;
  }
}
