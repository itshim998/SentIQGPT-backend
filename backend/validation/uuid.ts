import { HttpError } from "../httpErrors";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

function invalidUuidError(label: string): HttpError {
  return new HttpError(400, `${label} must be a valid UUID.`, { code: "invalid_uuid" });
}

export function getRequiredUuid(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new HttpError(400, `${label} is required.`, { code: "missing_uuid" });
  }
  if (!isUuid(normalized)) {
    throw invalidUuidError(label);
  }
  return normalized;
}

export function getOptionalUuid(
  value: unknown,
  label: string,
  options: { ignoreInvalid?: boolean } = {},
): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return undefined;
  if (!isUuid(normalized)) {
    if (options.ignoreInvalid) return undefined;
    throw invalidUuidError(label);
  }
  return normalized;
}
