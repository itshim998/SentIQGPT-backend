export const MAX_CLIENT_UPLOAD_BYTES = 10 * 1024 * 1024;

export const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  ".pdf", ".txt", ".png", ".jpg", ".jpeg", ".webp", ".html", ".css", ".js", ".ts",
  ".json", ".xml", ".md", ".py", ".java", ".cpp", ".c", ".rs", ".go",
]);

export const SUPPORTED_UPLOAD_MIME_PREFIXES = ["text/"];

export const SUPPORTED_UPLOAD_MIME_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "image/png",
  "image/jpeg",
  "image/webp",
]);
