// SentIQGPT — Chart Renderer
//
// Converts a ChartSpec into runnable code for the chosen renderer.
//
// Supported renderers:
//   matplotlib — Python, outputs base64 PNG to stdout (deterministic, np.random.seed(42))
//   plotly     — Python, interactive HTML chart
//   chartjs    — JavaScript config object for frontend rendering
//
// All generated code is:
//   • Self-contained (all imports included)
//   • Deterministic (seeded RNGs)
//   • Numerically correct (axes, scales, labels)
//   • Reproducible across runs

import type { ChartSpec, ChartType, DataGenSpec, AxesSpec, StyleSpec, RendererType } from "./types";

// ==============================
// Helpers
// ==============================

function pyList(arr: ReadonlyArray<string | number>): string {
  return `[${arr.map((v) => (typeof v === "string" ? `"${v}"` : v)).join(", ")}]`;
}

function jsArray(arr: ReadonlyArray<string | number>): string {
  return `[${arr.map((v) => (typeof v === "string" ? `"${v}"` : v)).join(", ")}]`;
}

// ==============================
// Data-generation snippets (Python)
// ==============================

function pyDataSnippet(type: ChartType, gen: DataGenSpec): string {
  switch (gen.method) {
    case "gaussian_distribution": {
      const n = gen.num_points ?? 800;
      if (type === "histogram") {
        return `x = np.random.normal(${gen.x_mean ?? 5}, ${gen.x_std ?? 1}, ${n})`;
      }
      return (
        `x = np.random.normal(${gen.x_mean ?? 5}, ${gen.x_std ?? 1}, ${n})\n` +
        `y = np.random.normal(${gen.y_mean ?? 10}, ${gen.y_std ?? 2}, ${n})`
      );
    }
    case "linear_sequence": {
      const steps = gen.x_steps ?? 100;
      return `x = np.linspace(${gen.x_start ?? 0}, ${gen.x_end ?? 10}, ${steps})\ny = x`;
    }
    case "static_values": {
      const cats = gen.categories ?? ["A", "B", "C", "D", "E"];
      const vals = gen.values ?? [25, 42, 18, 56, 30];
      return `categories = ${pyList(cats)}\nvalues = ${pyList(vals.slice(0, cats.length))}`;
    }
    case "random_matrix": {
      const n = gen.num_points ?? 10;
      return `data = np.random.randn(${n}, ${n})`;
    }
    case "time_series_with_noise": {
      const steps = gen.x_steps ?? 100;
      return (
        `t = np.linspace(${gen.x_start ?? 0}, ${gen.x_end ?? 100}, ${steps})\n` +
        `y = np.cumsum(np.random.randn(${steps})) + 50`
      );
    }
    case "linear_with_noise": {
      const n = gen.num_points ?? 800;
      return (
        `x = np.random.normal(${gen.x_mean ?? 5}, ${gen.x_std ?? 1}, ${n})\n` +
        `y_true = 2 * x + 1\n` +
        `y = y_true + np.random.normal(0, ${gen.y_std ?? 1}, ${n})`
      );
    }
    case "pca_clusters": {
      const n = gen.num_points ?? 800;
      const perCluster = Math.floor(n / 3);
      return (
        `from sklearn.decomposition import PCA\n` +
        `cluster_data = np.vstack([\n` +
        `    np.random.normal([0, 0], 1, (${perCluster}, 2)),\n` +
        `    np.random.normal([4, 4], 1, (${perCluster}, 2)),\n` +
        `    np.random.normal([8, 0], 1, (${perCluster}, 2)),\n` +
        `])\n` +
        `labels = np.array([0] * ${perCluster} + [1] * ${perCluster} + [2] * ${perCluster})\n` +
        `pca = PCA(n_components=2)\n` +
        `transformed = pca.fit_transform(cluster_data)\n` +
        `x, y = transformed[:, 0], transformed[:, 1]`
      );
    }
    case "gaussian_clusters": {
      const n = gen.num_points ?? 800;
      const perCluster = Math.floor(n / 3);
      return (
        `x0 = np.random.normal(2, 0.8, ${perCluster}); y0 = np.random.normal(2, 0.8, ${perCluster})\n` +
        `x1 = np.random.normal(6, 0.8, ${perCluster}); y1 = np.random.normal(6, 0.8, ${perCluster})\n` +
        `x2 = np.random.normal(10, 0.8, ${perCluster}); y2 = np.random.normal(2, 0.8, ${perCluster})\n` +
        `xs = [x0, x1, x2]; ys = [y0, y1, y2]`
      );
    }
    case "gaussian_groups": {
      const cats = gen.categories ?? ["Group A", "Group B", "Group C"];
      const n = gen.num_points ?? 200;
      const m = gen.x_mean ?? 5;
      const s = gen.x_std ?? 1;
      return cats.map((c, i) => {
        const safeName = `grp${i}`;
        return `${safeName} = np.random.normal(${m + i * 2}, ${s}, ${n})`;
      }).join("\n") + `\ngroups = ${pyList(cats.map((_, i) => `grp${i}`))}`;
    }
    default:
      return `x = np.linspace(0, 10, 100)\ny = x`;
  }
}

// ==============================
// Matplotlib renderer
// ==============================

function renderMatplotlib(spec: ChartSpec): string {
  const { chart_type: type, data_generation: gen, axes, style } = spec;
  const color = style.marker_color ?? "#1f77b4";
  const ms = style.marker_size ?? 6;
  const lw = style.line_width ?? 2;
  const grid = style.grid ? "True" : "False";
  const palette = style.color_palette ?? ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"];

  const header = [
    "import numpy as np",
    "import matplotlib",
    "matplotlib.use('Agg')  # non-interactive backend for server rendering",
    "import matplotlib.pyplot as plt",
    "import io, base64",
    "",
    "np.random.seed(42)",
    "",
  ].join("\n");

  const dataCode = pyDataSnippet(type, gen);

  const outputFooter = [
    "",
    "plt.tight_layout()",
    "",
    "# Output as base64 PNG (server rendering)",
    "_buf = io.BytesIO()",
    "plt.savefig(_buf, format='png', dpi=100, bbox_inches='tight')",
    "_buf.seek(0)",
    "print('data:image/png;base64,' + base64.b64encode(_buf.read()).decode('utf-8'))",
    "plt.close()",
  ].join("\n");

  let plotCode: string;

  switch (type) {
    case "scatter":
      plotCode = [
        `plt.figure(figsize=(8, 6))`,
        `plt.scatter(x, y, s=${ms ** 2}, color="${color}", alpha=0.6)`,
        axes.x_range ? `plt.xlim(${axes.x_range[0]}, ${axes.x_range[1]})` : "",
        axes.y_range ? `plt.ylim(${axes.y_range[0]}, ${axes.y_range[1]})` : "",
        `plt.xlabel("${axes.x_label ?? "X"}")`,
        `plt.ylabel("${axes.y_label ?? "Y"}")`,
        `plt.grid(${grid})`,
      ].filter(Boolean).join("\n");
      break;

    case "line":
      plotCode = [
        `plt.figure(figsize=(8, 6))`,
        `plt.plot(x, y, color="${color}", linewidth=${lw})`,
        axes.x_range ? `plt.xlim(${axes.x_range[0]}, ${axes.x_range[1]})` : "",
        axes.y_range ? `plt.ylim(${axes.y_range[0]}, ${axes.y_range[1]})` : "",
        `plt.xlabel("${axes.x_label ?? "X"}")`,
        `plt.ylabel("${axes.y_label ?? "Y"}")`,
        `plt.grid(${grid})`,
      ].filter(Boolean).join("\n");
      break;

    case "bar":
      plotCode = [
        `plt.figure(figsize=(8, 6))`,
        `colors = ${pyList(palette.slice(0, (gen.categories ?? []).length || 5))}`,
        `plt.bar(categories, values, color=colors)`,
        `plt.xlabel("${axes.x_label ?? "Category"}")`,
        `plt.ylabel("${axes.y_label ?? "Value"}")`,
        `plt.grid(${grid})`,
      ].filter(Boolean).join("\n");
      break;

    case "histogram":
      plotCode = [
        `plt.figure(figsize=(8, 6))`,
        `plt.hist(x, bins=${gen.num_bins ?? 30}, color="${color}", edgecolor="white")`,
        axes.x_range ? `plt.xlim(${axes.x_range[0]}, ${axes.x_range[1]})` : "",
        `plt.xlabel("${axes.x_label ?? "Value"}")`,
        `plt.ylabel("${axes.y_label ?? "Frequency"}")`,
        `plt.grid(${grid})`,
      ].filter(Boolean).join("\n");
      break;

    case "heatmap":
      plotCode = [
        `plt.figure(figsize=(8, 6))`,
        `plt.imshow(data, cmap="viridis", aspect="auto")`,
        `plt.colorbar()`,
        `plt.xlabel("${axes.x_label ?? "X"}")`,
        `plt.ylabel("${axes.y_label ?? "Y"}")`,
      ].join("\n");
      break;

    case "time_series":
      plotCode = [
        `plt.figure(figsize=(10, 5))`,
        `plt.plot(t, y, color="${color}", linewidth=${lw})`,
        axes.x_range ? `plt.xlim(${axes.x_range[0]}, ${axes.x_range[1]})` : "",
        `plt.xlabel("${axes.x_label ?? "Time"}")`,
        `plt.ylabel("${axes.y_label ?? "Value"}")`,
        `plt.grid(${grid})`,
      ].filter(Boolean).join("\n");
      break;

    case "regression": {
      const [xMin, xMax] = axes.x_range ?? [0, 10];
      plotCode = [
        `from numpy.polynomial import polynomial as P`,
        `plt.figure(figsize=(8, 6))`,
        `plt.scatter(x, y, s=${ms ** 2}, color="${color}", alpha=0.5, label="Data")`,
        `_coef = np.polyfit(x, y, 1)`,
        `_line = np.poly1d(_coef)`,
        `_xfit = np.linspace(${xMin}, ${xMax}, 100)`,
        `plt.plot(_xfit, _line(_xfit), color="#d62728", linewidth=${lw}, label="Regression line")`,
        `plt.xlabel("${axes.x_label ?? "X"}")`,
        `plt.ylabel("${axes.y_label ?? "Y"}")`,
        `plt.legend()`,
        `plt.grid(${grid})`,
      ].join("\n");
      break;
    }

    case "pca":
    case "clustering": {
      const colors = palette;
      plotCode = type === "pca"
        ? [
          `fig, ax = plt.subplots(figsize=(8, 6))`,
          `for i, c in enumerate(${pyList(colors.slice(0, 3))}):\n    mask = labels == i\n    ax.scatter(x[mask], y[mask], s=${ms ** 2}, color=c, alpha=0.6, label=f"Cluster {i}")`,
          `ax.set_xlabel("${axes.x_label ?? "PC1"}")`,
          `ax.set_ylabel("${axes.y_label ?? "PC2"}")`,
          `ax.legend()`,
          `ax.grid(${grid})`,
        ].join("\n")
        : [
          `fig, ax = plt.subplots(figsize=(8, 6))`,
          `for i, (xi, yi) in enumerate(zip(xs, ys)):\n    ax.scatter(xi, yi, s=${ms ** 2}, color=${pyList(colors.slice(0, 3))}[i], alpha=0.6, label=f"Cluster {i}")`,
          `ax.set_xlabel("${axes.x_label ?? "X"}")`,
          `ax.set_ylabel("${axes.y_label ?? "Y"}")`,
          `ax.legend()`,
          `ax.grid(${grid})`,
        ].join("\n");
      break;
    }

    case "pie": {
      const cats = gen.categories ?? ["A", "B", "C", "D", "E"];
      plotCode = [
        `plt.figure(figsize=(7, 7))`,
        `plt.pie(values, labels=categories, colors=${pyList(palette.slice(0, cats.length))}, autopct="%1.1f%%", startangle=140)`,
        `plt.axis("equal")`,
      ].join("\n");
      break;
    }

    case "box": {
      const cats = gen.categories ?? ["Group A", "Group B", "Group C"];
      const dataVars = cats.map((_, i) => `grp${i}`);
      plotCode = [
        `plt.figure(figsize=(8, 6))`,
        `plt.boxplot([${dataVars.join(", ")}], labels=${pyList(cats)}, patch_artist=True)`,
        `plt.xlabel("${axes.x_label ?? "Group"}")`,
        `plt.ylabel("${axes.y_label ?? "Value"}")`,
        `plt.grid(${grid})`,
      ].join("\n");
      break;
    }

    default:
      plotCode = `plt.figure(figsize=(8, 6))\nplt.scatter(x, y, color="${color}")`;
  }

  return `${header}${dataCode}\n\n${plotCode}${outputFooter}`;
}

// ==============================
// Plotly renderer
// ==============================

function renderPlotly(spec: ChartSpec): string {
  const { chart_type: type, data_generation: gen, axes, style } = spec;
  const color = style.marker_color ?? "#1f77b4";
  const palette = style.color_palette ?? ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"];

  const header = [
    "import numpy as np",
    "import pandas as pd",
    "import plotly.express as px",
    "import plotly.graph_objects as go",
    "",
    "np.random.seed(42)",
    "",
  ].join("\n");

  const dataCode = pyDataSnippet(type, gen);

  let figCode: string;

  switch (type) {
    case "scatter":
      figCode = [
        `df = pd.DataFrame({"x": x, "y": y})`,
        `fig = px.scatter(df, x="x", y="y", color_discrete_sequence=["${color}"])`,
        axes.x_range ? `fig.update_xaxes(range=[${axes.x_range[0]}, ${axes.x_range[1]}])` : "",
        axes.y_range ? `fig.update_yaxes(range=[${axes.y_range[0]}, ${axes.y_range[1]}])` : "",
        `fig.update_layout(showlegend=False, xaxis_title="${axes.x_label ?? "X"}", yaxis_title="${axes.y_label ?? "Y"}")`,
        `fig.show()`,
      ].filter(Boolean).join("\n");
      break;

    case "line":
      figCode = [
        `df = pd.DataFrame({"x": x, "y": y})`,
        `fig = px.line(df, x="x", y="y", color_discrete_sequence=["${color}"])`,
        axes.x_range ? `fig.update_xaxes(range=[${axes.x_range[0]}, ${axes.x_range[1]}])` : "",
        `fig.update_layout(xaxis_title="${axes.x_label ?? "X"}", yaxis_title="${axes.y_label ?? "Y"}")`,
        `fig.show()`,
      ].filter(Boolean).join("\n");
      break;

    case "bar": {
      const colorsStr = pyList(palette.slice(0, (gen.categories ?? []).length || 5));
      figCode = [
        `df = pd.DataFrame({"category": categories, "value": values})`,
        `fig = px.bar(df, x="category", y="value", color="category",`,
        `    color_discrete_sequence=${colorsStr})`,
        `fig.update_layout(showlegend=False, xaxis_title="${axes.x_label ?? "Category"}", yaxis_title="${axes.y_label ?? "Value"}")`,
        `fig.show()`,
      ].join("\n");
      break;
    }

    case "histogram":
      figCode = [
        `df = pd.DataFrame({"value": x})`,
        `fig = px.histogram(df, x="value", nbins=${gen.num_bins ?? 30}, color_discrete_sequence=["${color}"])`,
        axes.x_range ? `fig.update_xaxes(range=[${axes.x_range[0]}, ${axes.x_range[1]}])` : "",
        `fig.update_layout(xaxis_title="${axes.x_label ?? "Value"}", yaxis_title="${axes.y_label ?? "Frequency"}")`,
        `fig.show()`,
      ].filter(Boolean).join("\n");
      break;

    case "heatmap":
      figCode = [
        `fig = px.imshow(data, color_continuous_scale="Viridis")`,
        `fig.update_layout(xaxis_title="${axes.x_label ?? "X"}", yaxis_title="${axes.y_label ?? "Y"}")`,
        `fig.show()`,
      ].join("\n");
      break;

    case "time_series":
      figCode = [
        `df = pd.DataFrame({"time": t, "value": y})`,
        `fig = px.line(df, x="time", y="value", color_discrete_sequence=["${color}"])`,
        `fig.update_layout(xaxis_title="${axes.x_label ?? "Time"}", yaxis_title="${axes.y_label ?? "Value"}")`,
        `fig.show()`,
      ].join("\n");
      break;

    case "regression":
      figCode = [
        `df = pd.DataFrame({"x": x, "y": y})`,
        `fig = px.scatter(df, x="x", y="y", trendline="ols", color_discrete_sequence=["${color}"])`,
        `fig.update_layout(xaxis_title="${axes.x_label ?? "X"}", yaxis_title="${axes.y_label ?? "Y"}")`,
        `fig.show()`,
      ].join("\n");
      break;

    case "pca":
    case "clustering": {
      const clusterPalette = pyList(palette.slice(0, 3));
      figCode = type === "pca"
        ? [
          `df = pd.DataFrame({"PC1": x, "PC2": y, "cluster": labels.astype(str)})`,
          `fig = px.scatter(df, x="PC1", y="PC2", color="cluster",`,
          `    color_discrete_sequence=${clusterPalette})`,
          `fig.show()`,
        ].join("\n")
        : [
          `dfs = [pd.DataFrame({"x": xi, "y": yi, "cluster": str(i)}) for i, (xi, yi) in enumerate(zip(xs, ys))]`,
          `df = pd.concat(dfs, ignore_index=True)`,
          `fig = px.scatter(df, x="x", y="y", color="cluster",`,
          `    color_discrete_sequence=${clusterPalette})`,
          `fig.show()`,
        ].join("\n");
      break;
    }

    case "pie": {
      const colorsStr = pyList(palette.slice(0, (gen.categories ?? []).length || 5));
      figCode = [
        `df = pd.DataFrame({"label": categories, "value": values})`,
        `fig = px.pie(df, names="label", values="value",`,
        `    color_discrete_sequence=${colorsStr})`,
        `fig.show()`,
      ].join("\n");
      break;
    }

    case "box": {
      const cats = gen.categories ?? ["Group A", "Group B", "Group C"];
      const dataVars = cats.map((_, i) => `grp${i}`);
      figCode = [
        `import itertools`,
        `all_vals = list(itertools.chain(${dataVars.join(", ")}))`,
        `all_grps = ${cats.map((c, i) => `["${c}"] * len(grp${i})`).join(" + ")}`,
        `df = pd.DataFrame({"group": all_grps, "value": all_vals})`,
        `fig = px.box(df, x="group", y="value")`,
        `fig.update_layout(xaxis_title="${axes.x_label ?? "Group"}", yaxis_title="${axes.y_label ?? "Value"}")`,
        `fig.show()`,
      ].join("\n");
      break;
    }

    default:
      figCode = `df = pd.DataFrame({"x": x, "y": y})\nfig = px.scatter(df, x="x", y="y")\nfig.show()`;
  }

  return `${header}${dataCode}\n\n${figCode}`;
}

// ==============================
// Chart.js renderer
// ==============================

function renderChartJs(spec: ChartSpec): string {
  const { chart_type: type, data_generation: gen, axes, style } = spec;
  const color = style.marker_color ?? "#1f77b4";
  const palette = style.color_palette ?? ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"];

  let datasetCode: string;
  let scalesCode: string;
  let chartType: string;

  switch (type) {
    case "scatter": {
      const n = gen.num_points ?? 800;
      const xMean = gen.x_mean ?? 5;
      const xStd  = gen.x_std  ?? 1;
      const yMean = gen.y_mean ?? 10;
      const yStd  = gen.y_std  ?? 2;
      const xMin  = axes.x_range ? axes.x_range[0] : xMean - xStd * 3;
      const xMax  = axes.x_range ? axes.x_range[1] : xMean + xStd * 3;
      const yMin  = axes.y_range ? axes.y_range[0] : yMean - yStd * 3;
      const yMax  = axes.y_range ? axes.y_range[1] : yMean + yStd * 3;
      chartType = "scatter";
      datasetCode = `// Seeded gaussian sample (${n} points)\nconst points = Array.from({ length: ${n} }, () => ({\n  x: gaussRandom(${xMean}, ${xStd}),\n  y: gaussRandom(${yMean}, ${yStd}),\n}));\nconst datasets = [{ label: "Data", data: points, backgroundColor: "${color}", pointRadius: 3 }];`;
      scalesCode = `x: { min: ${xMin}, max: ${xMax}, title: { display: true, text: "${axes.x_label ?? "X"}" } },\n      y: { min: ${yMin}, max: ${yMax}, title: { display: true, text: "${axes.y_label ?? "Y"}" } }`;
      break;
    }

    case "line": {
      const steps = gen.x_steps ?? 100;
      chartType = "line";
      datasetCode = `const labels = Array.from({ length: ${steps} }, (_, i) => (i * ${(gen.x_end ?? 10) / steps}).toFixed(1));\nconst datasets = [{ label: "y = x", data: Array.from({ length: ${steps} }, (_, i) => i * ${(gen.x_end ?? 10) / steps}), borderColor: "${color}", tension: 0.1, pointRadius: 0 }];`;
      scalesCode = `x: { title: { display: true, text: "${axes.x_label ?? "X"}" } },\n      y: { title: { display: true, text: "${axes.y_label ?? "Y"}" } }`;
      break;
    }

    case "bar": {
      const cats = gen.categories ?? ["A", "B", "C", "D", "E"];
      const vals = gen.values ?? [25, 42, 18, 56, 30];
      const colorsStr = jsArray(palette.slice(0, cats.length));
      chartType = "bar";
      datasetCode = `const labels = ${jsArray(cats)};\nconst datasets = [{ label: "Values", data: ${jsArray(vals.slice(0, cats.length))}, backgroundColor: ${colorsStr} }];`;
      scalesCode = `x: { title: { display: true, text: "${axes.x_label ?? "Category"}" } },\n      y: { title: { display: true, text: "${axes.y_label ?? "Value"}" } }`;
      break;
    }

    case "histogram": {
      const n = gen.num_points ?? 800;
      const bins = gen.num_bins ?? 30;
      const xMean = gen.x_mean ?? 5;
      const xStd  = gen.x_std  ?? 1;
      chartType = "bar";
      datasetCode = `// Histogram: bin ${n} gaussian samples into ${bins} bins\nconst samples = Array.from({ length: ${n} }, () => gaussRandom(${xMean}, ${xStd}));\nconst binEdges = Array.from({ length: ${bins} + 1 }, (_, i) => ${xMean - xStd * 4} + i * ${(xStd * 8) / bins});\nconst counts = new Array(${bins}).fill(0);\nsamples.forEach(v => {\n  const idx = Math.min(Math.floor((v - ${xMean - xStd * 4}) / ${(xStd * 8) / bins}), ${bins - 1});\n  if (idx >= 0 && idx < ${bins}) counts[idx]++;\n});\nconst labels = binEdges.slice(0, -1).map(e => e.toFixed(1));\nconst datasets = [{ label: "Frequency", data: counts, backgroundColor: "${color}" }];`;
      scalesCode = `x: { title: { display: true, text: "${axes.x_label ?? "Value"}" } },\n      y: { title: { display: true, text: "${axes.y_label ?? "Frequency"}" } }`;
      break;
    }

    case "pie": {
      const cats = gen.categories ?? ["A", "B", "C", "D", "E"];
      const vals = gen.values ?? [25, 42, 18, 56, 30];
      const colorsStr = jsArray(palette.slice(0, cats.length));
      chartType = "pie";
      datasetCode = `const labels = ${jsArray(cats)};\nconst datasets = [{ data: ${jsArray(vals.slice(0, cats.length))}, backgroundColor: ${colorsStr} }];`;
      scalesCode = "";
      break;
    }

    case "time_series": {
      const steps = gen.x_steps ?? 100;
      chartType = "line";
      datasetCode = `// Time-series with random walk\nconst labels = Array.from({ length: ${steps} }, (_, i) => i);\nconst values = [50];\nfor (let i = 1; i < ${steps}; i++) values.push(values[i-1] + (Math.random() - 0.5) * 5);\nconst datasets = [{ label: "Value", data: values, borderColor: "${color}", tension: 0.1, pointRadius: 0, fill: false }];`;
      scalesCode = `x: { title: { display: true, text: "${axes.x_label ?? "Time"}" } },\n      y: { title: { display: true, text: "${axes.y_label ?? "Value"}" } }`;
      break;
    }

    default: {
      chartType = "scatter";
      datasetCode = `const points = Array.from({ length: 200 }, () => ({ x: Math.random() * 10, y: Math.random() * 10 }));\nconst datasets = [{ label: "Data", data: points, backgroundColor: "${color}" }];`;
      scalesCode = `x: { min: 0, max: 10 },\n      y: { min: 0, max: 10 }`;
    }
  }

  const gaussHelper = [
    "// Box-Muller transform for gaussian samples",
    "function gaussRandom(mean, std) {",
    "  let u = 0, v = 0;",
    "  while (u === 0) u = Math.random();",
    "  while (v === 0) v = Math.random();",
    "  return mean + std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);",
    "}",
    "",
  ].join("\n");

  const scalesBlock = scalesCode
    ? `  options: {\n    scales: {\n      ${scalesCode}\n    }\n  }`
    : `  options: {}`;

  return [
    gaussHelper,
    datasetCode,
    "",
    `const config = {`,
    `  type: '${chartType}',`,
    `  data: { labels: typeof labels !== 'undefined' ? labels : undefined, datasets },`,
    scalesBlock,
    `};`,
    "",
    "// Mount with Chart.js:",
    "// const ctx = document.getElementById('myChart').getContext('2d');",
    "// new Chart(ctx, config);",
  ].join("\n");
}

// ==============================
// Public API
// ==============================

/**
 * Generate runnable renderer code from a ChartSpec.
 *
 * Returns deterministic, self-contained source code for the
 * renderer specified in spec.renderer.
 */
export function renderChart(spec: ChartSpec): string {
  switch (spec.renderer) {
    case "plotly":
      return renderPlotly(spec);
    case "chartjs":
      return renderChartJs(spec);
    case "matplotlib":
    default:
      return renderMatplotlib(spec);
  }
}

/** Return a human-readable label for a renderer type. */
export function rendererLabel(renderer: RendererType): string {
  switch (renderer) {
    case "matplotlib": return "Python + Matplotlib";
    case "plotly":     return "Python + Plotly";
    case "chartjs":    return "Chart.js";
  }
}
