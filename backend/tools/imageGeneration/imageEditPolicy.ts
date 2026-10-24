import type { BillingPlanCode } from "../../billing/entitlementTypes";
import { normalizeExecutionMode } from "../../orchestrator/executionProfile";
import { HttpError } from "../../httpErrors";
import type { ImageEditCapabilities, ImageEditInput, ImageEditOperation, ImageProvider } from "./types";

// Verified against Cloudflare's 2026-01-15 launch contract and Pollinations
// shared/registry/image.ts + src/routes/images.ts at d355e8a03c3bed155e9408804198a798990543c6.
// Capabilities are exact-ID allowlists, never inferred from aliases or names.
export const IMAGE_EDIT_CAPABILITIES: Readonly<Record<string, ImageEditCapabilities>> = Object.freeze({
  "@cf/black-forest-labs/flux-2-klein-4b": Object.freeze({ reference: true, mask: false, transparency: false }),
  "openai/gpt-image-2": Object.freeze({ reference: true, mask: false, transparency: false }),
  "microsoft/mai-image-2.6": Object.freeze({ reference: true, mask: false, transparency: false }),
});

export function assertPaidImageEdit(plan: BillingPlanCode | string | undefined, userId?: string | null, isGuest = false): void {
  if (isGuest || !userId || userId === "guest" || !["student_core", "premium", "pro"].includes(plan || "")) {
    throw new HttpError(403, "Image editing requires Essential, Plus or Pro.", { code: "image_edit_paid_only" });
  }
}

export function getImageEditModelIds(plan: BillingPlanCode, mode?: string): readonly string[] {
  assertPaidImageEdit(plan, "server");
  return plan === "pro" && normalizeExecutionMode(mode) === "intuitive"
    ? ["openai/gpt-image-2", "microsoft/mai-image-2.6"]
    : ["@cf/black-forest-labs/flux-2-klein-4b"];
}

export function supportsImageEdit(model: string, operation: ImageEditOperation): boolean {
  const capability = IMAGE_EDIT_CAPABILITIES[model];
  return Boolean(capability?.reference
    && (operation !== "erase_region" || capability.mask)
    && (operation !== "remove_background" || capability.transparency));
}

export function assertImageEditSupported(models: readonly string[], operation: ImageEditOperation): void {
  if (!["edit", "erase_region", "replace_background", "remove_background"].includes(operation)
      || !models.some((model) => supportsImageEdit(model, operation))) {
    throw new HttpError(422, "The configured image models do not support this editing operation.", { code: "image_edit_operation_unsupported" });
  }
}

export function assertProviderEditInput(provider: ImageProvider, edit: ImageEditInput): void {
  // Both the global model allowlist and adapter implementation must agree.
  const capability = provider.editCapabilities;
  if (!supportsImageEdit(provider.name, edit.operation) || !capability?.reference
      || (edit.mask && !capability.mask)
      || (edit.operation === "erase_region" && (!edit.mask || !capability.mask))
      || (edit.operation === "remove_background" && !capability.transparency)) {
    throw new HttpError(422, "This image model cannot perform the requested edit.", { code: "image_edit_model_unsupported" });
  }
}
