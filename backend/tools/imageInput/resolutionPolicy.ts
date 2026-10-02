export type MediaResolutionLevel = "low" | "medium" | "high";

export interface ResolutionConfig {
  readonly level: MediaResolutionLevel;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly jpegQuality: number;
  readonly estimatedTokensPerPage: number;
}

export const RESOLUTION_POLICIES: Readonly<Record<MediaResolutionLevel, ResolutionConfig>> = {
  low: {
    level: "low",
    maxWidth: 768,
    maxHeight: 1024,
    jpegQuality: 80,
    estimatedTokensPerPage: 258,
  },
  medium: {
    level: "medium",
    maxWidth: 1280,
    maxHeight: 1700,
    jpegQuality: 85,
    estimatedTokensPerPage: 512,
  },
  high: {
    level: "high",
    maxWidth: 1792,
    maxHeight: 2400,
    jpegQuality: 90,
    estimatedTokensPerPage: 1024,
  },
};

export function selectInitialResolutionPolicy(args: {
  readonly query?: string;
  readonly assetType?: "pdf" | "image";
  readonly filename?: string;
}): ResolutionConfig {
  const text = `${args.query || ""} ${args.filename || ""}`.toLowerCase();
  const denseVisualTerms = [
    "handwriting",
    "handwritten",
    "notes",
    "equation",
    "math",
    "formula",
    "diagram",
    "small text",
    "fine print",
    "table",
    "chart",
    "calculation",
  ];
  const requiresHighFidelity = denseVisualTerms.some((term) => text.includes(term));
  if (requiresHighFidelity) {
    return RESOLUTION_POLICIES.high;
  }
  return RESOLUTION_POLICIES.medium;
}

export function shouldRefineAtHigherResolution(evidence: {
  readonly uncertainty?: string;
  readonly needs_refinement?: boolean;
  readonly confidence?: "high" | "medium" | "low";
}): boolean {
  if (evidence.needs_refinement === true) return true;
  if (evidence.confidence === "low") return true;
  if (evidence.uncertainty && evidence.uncertainty.trim().length > 0) return true;
  return false;
}
