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

export function buildHttpErrorResponse(err: Error): HttpErrorResponse {
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
