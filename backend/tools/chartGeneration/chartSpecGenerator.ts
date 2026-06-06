// SentIQ Chat — Chart Specification Generator
//
// Converts a ChartIntent into a fully-specified ChartSpec that contains
// all parameters required by a renderer.
//
// All default values are deterministic (no Math.random()) so identical
// requests always produce identical specifications.

import type {
  ChartIntent,
  ChartSpec,
  ChartType,
  DataGenSpec,
  AxesSpec,
  StyleSpec,
  RendererType,
} from "./types";

// ==============================
// Constants
// ==============================

const DEFAULT_COLORS: ReadonlyArray<string> = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
];

const DEFAULT_CATEGORIES: ReadonlyArray<string> = ["A", "B", "C", "D", "E"];
const DEFAULT_VALUES: ReadonlyArray<number> = [25, 42, 18, 56, 30];

// ==============================
// Renderer selection
// ==============================

/**
 * Choose the appropriate renderer based on user-message keywords.
 *
 * Rules:
 *   "interactive" | "plotly"                → plotly
 *   "chart.js" | "frontend" | "javascript"  → chartjs
 *   Default                                 → matplotlib
 */
export function selectRenderer(message: string): RendererType {
  if (/\b(?:interactive|plotly)\b/i.test(message)) return "plotly";
  if (/\b(?:matplotlib|python)\b/i.test(message)) return "matplotlib";
  return "chartjs";
}

// ==============================
// Per-type spec factories
// ==============================

function scatterSpec(xMean: number, xStd: number, numPoints: number): {
  data: DataGenSpec; axes: AxesSpec; style: StyleSpec;
} {
  const yMean = xMean * 2;
  const yStd = xStd * 2;
  return {
    data: {
      method: "gaussian_distribution",
      x_mean: xMean, x_std: xStd,
      y_mean: yMean, y_std: yStd,
      num_points: numPoints,
    },
    axes: {
      x_label: "X", y_label: "Y",
      x_range: [xMean - xStd * 3, xMean + xStd * 3],
      y_range: [yMean - yStd * 3, yMean + yStd * 3],
    },
    style: { marker_color: DEFAULT_COLORS[0], marker_size: 6, grid: false, title: null },
  };
}

function lineSpec(): { data: DataGenSpec; axes: AxesSpec; style: StyleSpec } {
  return {
    data: { method: "linear_sequence", x_start: 0, x_end: 10, x_steps: 100 },
    axes: { x_label: "X", y_label: "Y", x_range: [0, 10], y_range: [0, 10] },
    style: { marker_color: DEFAULT_COLORS[0], line_width: 2, grid: true, title: null },
  };
}

function barSpec(categories: ReadonlyArray<string>): {
  data: DataGenSpec; axes: AxesSpec; style: StyleSpec;
} {
  const values = DEFAULT_VALUES.slice(0, categories.length);
  return {
    data: { method: "static_values", categories, values },
    axes: { x_label: "Category", y_label: "Value" },
    style: {
      color_palette: DEFAULT_COLORS.slice(0, categories.length),
      grid: false,
      title: null,
    },
  };
}

function histogramSpec(xMean: number, xStd: number, numPoints: number): {
  data: DataGenSpec; axes: AxesSpec; style: StyleSpec;
} {
  return {
    data: {
      method: "gaussian_distribution",
      x_mean: xMean, x_std: xStd,
      num_points: numPoints,
      num_bins: 30,
    },
    axes: {
      x_label: "Value", y_label: "Frequency",
      x_range: [xMean - xStd * 4, xMean + xStd * 4],
    },
    style: { marker_color: DEFAULT_COLORS[0], grid: false, title: null },
  };
}

function heatmapSpec(): { data: DataGenSpec; axes: AxesSpec; style: StyleSpec } {
  return {
    data: { method: "random_matrix", num_points: 10 },
    axes: { x_label: "X", y_label: "Y" },
    style: { grid: false, title: null },
  };
}

function timeSeriesSpec(): { data: DataGenSpec; axes: AxesSpec; style: StyleSpec } {
  return {
    data: {
      method: "time_series_with_noise",
      x_start: 0, x_end: 100, x_steps: 100,
      num_points: 100,
    },
    axes: { x_label: "Time", y_label: "Value", x_range: [0, 100] },
    style: { marker_color: DEFAULT_COLORS[0], line_width: 2, grid: true, title: null },
  };
}

function regressionSpec(xMean: number, xStd: number, numPoints: number): {
  data: DataGenSpec; axes: AxesSpec; style: StyleSpec;
} {
  const yMean = xMean * 2;
  const yStd = xStd;
  return {
    data: {
      method: "linear_with_noise",
      x_mean: xMean, x_std: xStd,
      y_mean: yMean, y_std: yStd,
      num_points: numPoints,
    },
    axes: {
      x_label: "X", y_label: "Y",
      x_range: [xMean - xStd * 3, xMean + xStd * 3],
      y_range: [yMean - yStd * 3, yMean + yStd * 3],
    },
    style: { marker_color: DEFAULT_COLORS[0], marker_size: 6, grid: false, title: null },
  };
}

function pcaSpec(numPoints: number): { data: DataGenSpec; axes: AxesSpec; style: StyleSpec } {
  return {
    data: { method: "pca_clusters", num_points: numPoints },
    axes: { x_label: "PC1", y_label: "PC2" },
    style: {
      color_palette: [...DEFAULT_COLORS],
      marker_size: 6, grid: false, title: null,
    },
  };
}

function clusteringSpec(numPoints: number): {
  data: DataGenSpec; axes: AxesSpec; style: StyleSpec;
} {
  return {
    data: { method: "gaussian_clusters", num_points: numPoints },
    axes: { x_label: "X", y_label: "Y" },
    style: {
      color_palette: [...DEFAULT_COLORS],
      marker_size: 6, grid: false, title: null,
    },
  };
}

function pieSpec(categories: ReadonlyArray<string>): {
  data: DataGenSpec; axes: AxesSpec; style: StyleSpec;
} {
  const values = DEFAULT_VALUES.slice(0, categories.length);
  return {
    data: { method: "static_values", categories, values },
    axes: {},
    style: {
      color_palette: DEFAULT_COLORS.slice(0, categories.length),
      title: null,
    },
  };
}

function boxSpec(xMean: number, xStd: number): {
  data: DataGenSpec; axes: AxesSpec; style: StyleSpec;
} {
  const groups = ["Group A", "Group B", "Group C"] as const;
  return {
    data: {
      method: "gaussian_groups",
      categories: groups,
      num_points: 200,
      x_mean: xMean, x_std: xStd,
    },
    axes: { x_label: "Group", y_label: "Value" },
    style: {
      color_palette: DEFAULT_COLORS.slice(0, groups.length),
      grid: false, title: null,
    },
  };
}

// ==============================
// Public API
// ==============================

/**
 * Convert a ChartIntent and original user message into a fully-specified
 * ChartSpec ready for the renderer.
 */
export function generateChartSpec(intent: ChartIntent, message: string): ChartSpec {
  const renderer = selectRenderer(message);
  const { type, parameters } = intent;

  const numPoints = typeof parameters.num_points === "number" ? parameters.num_points : 800;
  const xMean    = typeof parameters.mean === "number" ? parameters.mean : 5;
  const xStd     = typeof parameters.std  === "number" ? parameters.std  : 1;

  const userCategories = Array.isArray(parameters.categories)
    ? (parameters.categories as string[]).filter((c) => typeof c === "string")
    : null;

  let data: DataGenSpec;
  let axes: AxesSpec;
  let style: StyleSpec;

  const chartTypeMap: Record<ChartType, () => { data: DataGenSpec; axes: AxesSpec; style: StyleSpec }> = {
    scatter:     () => scatterSpec(xMean, xStd, numPoints),
    line:        () => lineSpec(),
    bar:         () => barSpec(userCategories ?? DEFAULT_CATEGORIES),
    histogram:   () => histogramSpec(xMean, xStd, numPoints),
    heatmap:     () => heatmapSpec(),
    time_series: () => timeSeriesSpec(),
    regression:  () => regressionSpec(xMean, xStd, numPoints),
    pca:         () => pcaSpec(numPoints),
    clustering:  () => clusteringSpec(numPoints),
    pie:         () => pieSpec(userCategories ?? DEFAULT_CATEGORIES),
    box:         () => boxSpec(xMean, xStd),
  };

  const factory = chartTypeMap[type] ?? chartTypeMap.scatter;
  ({ data, axes, style } = factory());

  return { chart_type: type, renderer, data_generation: data, axes, style };
}
