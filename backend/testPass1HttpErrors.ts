import assert from "assert/strict";
import { HttpError, buildHttpErrorResponse } from "./httpErrors";

const notFoundResponse = buildHttpErrorResponse(
  new HttpError(404, "Conversation not found.", { code: "conversation_not_found" }),
);
assert.equal(notFoundResponse.statusCode, 404);
assert.deepEqual(notFoundResponse.body, {
  error: "Conversation not found.",
  code: "conversation_not_found",
});

const forbiddenResponse = buildHttpErrorResponse(
  new HttpError(403, "Unauthorized conversation access.", { code: "conversation_forbidden" }),
);
assert.equal(forbiddenResponse.statusCode, 403);
assert.deepEqual(forbiddenResponse.body, {
  error: "Unauthorized conversation access.",
  code: "conversation_forbidden",
});

const capacityResponse = buildHttpErrorResponse(
  new HttpError(503, "Service is temporarily at capacity. Please try again later.", {
    code: "shard_capacity_exhausted",
    expose: true,
    headers: { "Retry-After": "60" },
  }),
);
assert.equal(capacityResponse.statusCode, 503);
assert.equal(capacityResponse.headers["Retry-After"], "60");
assert.deepEqual(capacityResponse.body, {
  error: "Service is temporarily at capacity. Please try again later.",
  code: "shard_capacity_exhausted",
});

const genericResponse = buildHttpErrorResponse(new Error("raw database detail"));
assert.equal(genericResponse.statusCode, 500);
assert.deepEqual(genericResponse.headers, {});
assert.deepEqual(genericResponse.body, { error: "Internal server error." });

console.log("PASS | PASS 1 HTTP error regression tests passed.");
