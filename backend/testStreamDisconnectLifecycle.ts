import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  attachStreamDisconnectLifecycle,
  type StreamRequestLifecycle,
  type StreamResponseLifecycle,
} from "./streamDisconnectLifecycle";

class RequestLifecycleFixture implements StreamRequestLifecycle {
  complete = true;
  private readonly listeners = new Map<string, Array<() => void>>();

  once(event: "close", listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string): void {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.delete(event);
    for (const listener of listeners) listener();
  }
}

class ResponseLifecycleFixture implements StreamResponseLifecycle {
  writableEnded = false;
  private readonly listeners = new Map<string, Array<() => void>>();

  once(event: "close", listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: "close"): void {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.delete(event);
    for (const listener of listeners) listener();
  }
}

function createFixture() {
  const request = new RequestLifecycleFixture();
  const response = new ResponseLifecycleFixture();
  let responseCompleted = false;
  let disconnectCalls = 0;
  const lifecycle = attachStreamDisconnectLifecycle({
    request,
    response,
    isResponseCompleted: () => responseCompleted,
    onDisconnect: () => {
      disconnectCalls += 1;
    },
  });
  return {
    request,
    response,
    lifecycle,
    completeResponse: () => {
      responseCompleted = true;
    },
    disconnectCalls: () => disconnectCalls,
  };
}

{
  const fixture = createFixture();
  fixture.request.emit("close");
  assert.equal(fixture.lifecycle.isDisconnected(), false, "normal request close must not stop an SSE response");
  assert.equal(fixture.disconnectCalls(), 0);
}

{
  const fixture = createFixture();
  fixture.request.complete = false;
  fixture.request.emit("close");
  assert.equal(fixture.lifecycle.isDisconnected(), true, "an incomplete request close must stop upstream work");
  assert.equal(fixture.disconnectCalls(), 1);
  fixture.response.emit("close");
  assert.equal(fixture.disconnectCalls(), 1, "disconnect cleanup must be idempotent");
}

{
  const fixture = createFixture();
  fixture.response.emit("close");
  assert.equal(fixture.lifecycle.isDisconnected(), true, "a premature response close must stop upstream work");
  assert.equal(fixture.disconnectCalls(), 1);
}

{
  const fixture = createFixture();
  fixture.response.writableEnded = true;
  fixture.response.emit("close");
  assert.equal(fixture.lifecycle.isDisconnected(), false, "a normally ended response must not be treated as disconnected");
  assert.equal(fixture.disconnectCalls(), 0);
}

{
  const fixture = createFixture();
  fixture.completeResponse();
  fixture.request.complete = false;
  fixture.request.emit("close");
  fixture.response.emit("close");
  assert.equal(fixture.lifecycle.isDisconnected(), false, "late lifecycle events must not affect a completed response");
  assert.equal(fixture.disconnectCalls(), 0);
}

{
  const server = fs.readFileSync(path.join(process.cwd(), "backend", "server.ts"), "utf8");
  const guestGeneralStart = server.indexOf('route: "guest.general.stream"');
  const guestPromptStart = server.indexOf("const call = buildChatPrompt", guestGeneralStart);
  const ordinaryRouteEvent = server.indexOf(
    'await writeSseJson({ type: "route", route: "chat" })',
    guestGeneralStart,
  );

  assert(guestGeneralStart >= 0, "guest general stream route must exist");
  assert(guestPromptStart > guestGeneralStart, "guest general prompt must exist");
  assert(
    ordinaryRouteEvent > guestGeneralStart && ordinaryRouteEvent < guestPromptStart,
    "ordinary guest streams must emit neutral route evidence before model output",
  );

  const guestCatchStart = server.indexOf("let streamError = err;", guestPromptStart);
  const signedInCatchStart = server.indexOf("let streamError = err;", guestCatchStart + 1);
  for (const [label, catchStart] of [
    ["guest", guestCatchStart],
    ["signed-in", signedInCatchStart],
  ] as const) {
    assert(catchStart >= 0, `${label} partial-stream settlement catch must exist`);
    const catchContract = server.slice(catchStart, catchStart + 900);
    assert.match(
      catchContract,
      /err instanceof BillingQuotaError[\s\S]*?err\.code === "unified_text_quota_unavailable"/,
      `${label} stream must not retry a known unavailable settlement`,
    );
    assert.match(
      catchContract,
      /try \{[\s\S]*?commitTextBilling[\s\S]*?catch \(settlementErr\) \{[\s\S]*?streamError = settlementErr/,
      `${label} partial settlement failures must become public-safe stream errors`,
    );
    assert.match(
      catchContract,
      /await sendStreamError\(streamError, streamMetrics\)/,
      `${label} stream must emit an SSE error terminator after settlement failure`,
    );
  }
}

console.log("Stream disconnect lifecycle tests passed.");
