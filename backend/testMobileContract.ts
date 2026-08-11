import assert from "node:assert/strict";
import {
  MOBILE_CONTRACT,
  MOBILE_CONTRACT_VERSION,
  withMobileContract,
} from "./mobile/mobileContract";

const original = {
  version: "2.0.0",
  features: { chat: true, streaming: true },
  limits: { max_message_length: 10_000 },
};

const extended = withMobileContract(original);
assert.notStrictEqual(extended, original);
assert.deepEqual((extended as typeof original).features, original.features);
assert.deepEqual((extended as typeof original).limits, original.limits);
assert.equal(
  (extended as typeof original & { mobile_contract: typeof MOBILE_CONTRACT })
    .mobile_contract.contract_version,
  MOBILE_CONTRACT_VERSION,
);
assert.equal(MOBILE_CONTRACT_VERSION, 4);
assert.equal(MOBILE_CONTRACT.compatibility.unknown_fields, "ignore");
assert.equal(MOBILE_CONTRACT.compatibility.unknown_sse_events, "ignore");
assert.equal(MOBILE_CONTRACT.sse.version, 1);
assert.ok(MOBILE_CONTRACT.sse.event_types.includes("done"));
assert.ok(MOBILE_CONTRACT.endpoints.chat_stream.startsWith("/api/"));
assert.ok(MOBILE_CONTRACT.endpoints.chat_sync.startsWith("/api/"));
assert.ok(MOBILE_CONTRACT.endpoints.chat_selection.startsWith("/api/"));
assert.ok(MOBILE_CONTRACT.endpoints.conversation_messages.includes(":id"));
assert.ok(MOBILE_CONTRACT.endpoints.image_quota.endsWith("/quota"));
assert.ok(MOBILE_CONTRACT.endpoints.image_delete.includes(":id"));
assert.ok(MOBILE_CONTRACT.endpoints.generated_file_download.includes(":id"));
assert.ok(MOBILE_CONTRACT.endpoints.generated_file_update.includes(":id"));
assert.ok(MOBILE_CONTRACT.endpoints.deep_research_events.includes(":id"));
assert.ok(MOBILE_CONTRACT.endpoints.deep_research_export.includes(":id"));
assert.ok(MOBILE_CONTRACT.endpoints.billing_checkout.endsWith("/checkout"));
assert.ok(MOBILE_CONTRACT.endpoints.billing_verify.endsWith("/verify"));
assert.ok(MOBILE_CONTRACT.endpoints.live_session_commit.includes(":id"));
assert.strictEqual(withMobileContract("unchanged"), "unchanged");

console.log("Mobile API contract regression checks passed.");
