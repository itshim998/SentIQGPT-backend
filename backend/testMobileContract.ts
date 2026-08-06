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
assert.equal(MOBILE_CONTRACT.compatibility.unknown_fields, "ignore");
assert.equal(MOBILE_CONTRACT.compatibility.unknown_sse_events, "ignore");
assert.equal(MOBILE_CONTRACT.sse.version, 1);
assert.ok(MOBILE_CONTRACT.endpoints.chat_stream.startsWith("/api/"));
assert.strictEqual(withMobileContract("unchanged"), "unchanged");

console.log("Mobile API contract regression checks passed.");
