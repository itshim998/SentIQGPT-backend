// Provider-neutral Pollinations image model adapter.
//
// Used when routing needs to instantiate a named Pollinations model directly
// (for example klein, kontext, gpt-image-2, or legacy explicit preferences).
// The model identifier remains visible in provider lifecycle logs and billing
// settlement, while credentials and prompt-bearing URLs remain private.

import type {
  ImageModelPreference,
  ImageProvider,
  ImageProviderRequestContext,
  ImageProviderResult,
} from "../types";
import {
  buildPollinationsUrl,
  enhancePrompt,
  fetchPollinationsImage,
  getPollinationsApiKey,
} from "../pollinationsUtils";
import { ImageProviderFailure, failureOutcomeForHttpStatus } from "../types";
import { IMAGE_EDIT_CAPABILITIES, assertProviderEditInput } from "../imageEditPolicy";
import { readEditProviderResponse, validateEditInput } from "../imageEditValidation";
import { createHash } from "node:crypto";
import sharp from "sharp";

export interface PollinationsImageModelProviderOptions {
  readonly timeoutMs?: number;
  readonly enhance?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class PollinationsImageModelProvider implements ImageProvider {
  readonly name: string;
  get editCapabilities() { return IMAGE_EDIT_CAPABILITIES[this.name]; }
  private readonly timeoutMs: number;
  private readonly enhance: boolean;

  constructor(
    modelName: ImageModelPreference | string,
    options: PollinationsImageModelProviderOptions = {},
  ) {
    this.name = modelName;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.enhance = options.enhance ?? false;
  }

  isAvailable(): boolean {
    return Boolean(getPollinationsApiKey());
  }

  async generate(
    prompt: string,
    size?: string,
    signal?: AbortSignal,
    context?: ImageProviderRequestContext,
  ): Promise<ImageProviderResult> {
    if (context?.edit) return this.edit(prompt, size, signal, context);
    const providerPrompt = this.enhance ? enhancePrompt(prompt) : prompt;
    const imageUrl = buildPollinationsUrl(
      providerPrompt,
      this.name,
      size,
      context?.requestKey,
    );
    const base64 = await fetchPollinationsImage(imageUrl, this.timeoutMs, signal);
    return { base64 };
  }

  private async edit(prompt: string, size: string | undefined, signal: AbortSignal | undefined, context: ImageProviderRequestContext): Promise<ImageProviderResult> {
    const edit = context.edit!;
    assertProviderEditInput(this, edit);
    await validateEditInput(edit.source, edit.operation, edit.mask);
    const source = await sharp(edit.source).rotate().png().toBuffer();
    if (source.length > 8 * 1024 * 1024) throw new ImageProviderFailure("Normalized image exceeds editing size limit", "definitive");
    const key = getPollinationsApiKey();
    if (!key) throw new ImageProviderFailure("Image editing provider is not configured", "definitive");
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch("https://gen.pollinations.ai/v1/images/edits", {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.name,
          prompt,
          image: `data:image/png;base64,${source.toString("base64")}`,
          size: size || "1024x1024",
          seed: Number.parseInt(createHash("sha256").update(context.requestKey).digest("hex").slice(0, 8), 16) % 2147483647,
          response_format: "b64_json",
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new ImageProviderFailure("Image editing provider rejected the request", failureOutcomeForHttpStatus(response.status), response.status);
      // Refuse upstream rescue to any model outside the exact edit allowlist.
      const actualModel = response.headers.get("x-model-used");
      if (actualModel !== this.name) throw new ImageProviderFailure("Image editing provider did not confirm the selected model", "indeterminate");
      const body = JSON.parse((await readEditProviderResponse(response)).toString("utf8")) as { data?: { b64_json?: string }[] };
      const base64 = body.data?.[0]?.b64_json;
      if (!base64 || base64.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        throw new ImageProviderFailure("Image editing provider returned an invalid image", "indeterminate");
      }
      return { base64 };
    } catch (error) {
      if (error instanceof ImageProviderFailure) throw error;
      // Do not expose fetch errors that might contain request data or credentials.
      throw new ImageProviderFailure("Image editing provider request failed", "indeterminate");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
