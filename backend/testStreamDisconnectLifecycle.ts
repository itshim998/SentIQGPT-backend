import assert from "node:assert/strict";
import {
  attachStreamDisconnectLifecycle,
  type StreamRequestLifecycle,
  type StreamResponseLifecycle,
} from "./streamDisconnectLifecycle";

class RequestFixture implements StreamRequestLifecycle {
  complete = false;
  __sentiqGenerationDetached = false;
  private listeners = new Map<string, Array<() => void>>();
  once(event: "close" | "sentiq-generation-cancel", listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: "close" | "sentiq-generation-cancel") {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class ResponseFixture implements StreamResponseLifecycle {
  writableEnded = false;
  __sentiqGenerationDetached = false;
  private listeners = new Map<string, Array<() => void>>();
  once(event: "close", listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: "close") {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function createFixture(detached = true) {
  const request = new RequestFixture();
  const response = new ResponseFixture();
  request.__sentiqGenerationDetached = detached;
  response.__sentiqGenerationDetached = detached;
  let disconnects = 0;
  const lifecycle = attachStreamDisconnectLifecycle({
    request,
    response,
    isResponseCompleted: () => response.writableEnded,
    onDisconnect: () => { disconnects += 1; },
  });
  return { request, response, lifecycle, disconnects: () => disconnects };
}

{
  const fixture = createFixture(true);
  fixture.request.emit("close");
  fixture.response.emit("close");
  assert.equal(fixture.disconnects(), 0, "generation-owned transport close must not cancel generation");
  assert.equal(fixture.lifecycle.isDisconnected(), false);
}

{
  const fixture = createFixture(true);
  fixture.request.emit("sentiq-generation-cancel");
  assert.equal(fixture.disconnects(), 1, "explicit generation cancellation must abort the generation request");
  assert.equal(fixture.lifecycle.isDisconnected(), true);
}

{
  const fixture = createFixture(false);
  fixture.request.emit("close");
  assert.equal(fixture.disconnects(), 1, "non-generation SSE routes retain disconnect protection");
}

{
  const fixture = createFixture(true);
  fixture.response.writableEnded = true;
  fixture.response.emit("close");
  assert.equal(fixture.disconnects(), 0, "normal response completion is not cancellation");
}

console.log("Stream generation transport lifecycle tests passed.");
