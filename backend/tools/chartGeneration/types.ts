// SentIQGPT — Chart Generation Types
//
// Shared type definitions for the deterministic chart generation system.
// Charts are always rendered with real plotting libraries (matplotlib, plotly,
// chart.js) — image models are never used for data visualizations.

// ==============================
// Chart type taxonomy
// ==============================

export type ChartType =
  | "scatter"
  | "line"
  | "bar"
  | "histogram"
  | "heatmap"
  | "time_series"
  | "pca"
  | "clustering"
  | "regression"
  | "pie"
  | "box";

export type DataSourceType =
  | "user_data"
  | "generated_data"
  | "mathematical_function";

export type RendererType = "matplotlib" | "plotly" | "chartjs";

// ==============================
// Chart intent (from detector)
// ==============================

export interface ChartIntent {
  readonly type: ChartType;
  readonly data_source: DataSourceType;
  readonly parameters: Record<string, unknown>;
}

// ==============================
// Chart specification
// ==============================

export interface DataGenSpec {
  readonly method: string;
  /** Gaussian x-axis mean */
  readonly x_mean?: number;
  readonly x_std?: number;
  /** Gaussian y-axis mean */
  readonly y_mean?: number;
  readonly y_std?: number;
  readonly num_points?: number;
  /** For bar / pie charts */
  readonly categories?: readonly string[];
  readonly values?: readonly number[];
  /** For histograms */
  readonly num_bins?: number;
  /** For line / time-series */
  readonly x_start?: number;
  readonly x_end?: number;
  readonly x_steps?: number;
  readonly formula?: string;
}

export interface AxesSpec {
  readonly x_label?: string;
  readonly y_label?: string;
  readonly x_range?: readonly [number, number];
  readonly y_range?: readonly [number, number];
  readonly title?: string;
}

export interface StyleSpec {
  readonly marker_color?: string;
  readonly marker_size?: number;
  readonly line_width?: number;
  readonly grid?: boolean;
  readonly title?: string | null;
  readonly color_palette?: readonly string[];
}

export interface ChartSpec {
  readonly chart_type: ChartType;
  readonly renderer: RendererType;
  readonly data_generation: DataGenSpec;
  readonly axes: AxesSpec;
  readonly style: StyleSpec;
}

// ==============================
// Chart result (from router)
// ==============================

export interface ChartResult {
  readonly success: boolean;
  readonly chart_type: ChartType;
  readonly renderer: RendererType;
  /** Runnable source code for the selected renderer */
  readonly code: string;
  /** Optional base64 PNG preview (matplotlib only, when Python service available) */
  readonly preview?: string;
  readonly error?: string;
}
