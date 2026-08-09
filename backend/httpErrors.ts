export type HttpErrorBody = {
  error: string;
  code?: string;
  requires_name?: boolean;
};

export type HttpErrorResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: HttpErrorBody;
};

type HttpErrorOptions = {
  code?: string;
  expose?: boolean;
  headers?: Record<string, string>;
  requires_name?: boolean;
};

const CONVERSATION_RETENTION_DB_MARKER = "conversation_retention_artifact_cleanup_required";
export const CONVERSATION_RETENTION_CLEANUP_CODE = "conversation_retention_cleanup_required";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly expose: boolean;
  readonly headers: Record<string, string>;
  readonly requiresName?: boolean;

  constructor(statusCode: number, message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = options.code;
    this.expose = options.expose ?? statusCode < 500;
    this.headers = options.headers ?? {};
    this.requiresName = options.requires_name;
  }
}

function isConversationRetentionCleanupError(err: Error): boolean {
  return String(err?.message || "").includes(CONVERSATION_RETENTION_DB_MARKER);
}

export function buildHttpErrorResponse(err: Error): HttpErrorResponse {
  // The database deliberately aborts a 51st-chat insert when the exact bottom
  // conversation owns Storage-backed artifacts. Expose only a stable public code
  // so the browser can remove that conversation through the normal DELETE API
  // (which cleans Storage objects) and retry once. The raw Postgres marker and
  // internal database details remain private.
  if (isConversationRetentionCleanupError(err)) {
    return {
      statusCode: 409,
      headers: {},
      body: {
        error: "The oldest stored conversation needs cleanup before this conversation can be saved.",
        code: CONVERSATION_RETENTION_CLEANUP_CODE,
      },
    };
  }

  const isHttpError = err instanceof HttpError;
  const statusCode = isHttpError && Number.isInteger(err.statusCode)
    ? err.statusCode
    : 500;
  const exposeMessage = isHttpError ? err.expose : statusCode < 500;
  const body: HttpErrorBody = {
    error: exposeMessage ? err.message : "Internal server error.",
  };

  if (isHttpError && err.code) {
    body.code = err.code;
  }
  if (isHttpError && err.requiresName) {
    body.requires_name = true;
  }

  return {
    statusCode,
    headers: isHttpError ? err.headers : {},
    body,
  };
}
