export const TOOL_ACTIVITY_MODES = Object.freeze({
  web_surf: "web_search",
  image_gen: "image_generation",
  chart_gen: "chart_generation",
  file_gen: "file_generation",
  memory_update: "memory_update",
});

export function reduceToolLifecycleState(previous, event) {
  const base = previous && typeof previous === "object"
    ? previous
    : { activityMode: "thinking", status: "idle", tool: null, callId: null };
  if (!event || typeof event !== "object") return base;
  if (event.type === "request_cancelled") {
    return { activityMode: "thinking", status: "cancelled", tool: base.tool || null, callId: base.callId || null };
  }
  if (event.type === "request_retry") {
    return { activityMode: "thinking", status: "idle", tool: null, callId: null };
  }
  if (event.type === "hydrate") {
    const hydrated = event.state;
    if (!hydrated || typeof hydrated !== "object") return base;
    if (!hydrated.tool || !TOOL_ACTIVITY_MODES[hydrated.tool]) {
      return { activityMode: "thinking", status: "idle", tool: null, callId: null };
    }
    const active = hydrated.status === "selected" || hydrated.status === "running";
    return {
      activityMode: active ? TOOL_ACTIVITY_MODES[hydrated.tool] : "thinking",
      status: hydrated.status || "idle",
      tool: hydrated.tool,
      callId: hydrated.callId || null,
      ...(hydrated.code ? { code: hydrated.code } : {}),
    };
  }
  if (!TOOL_ACTIVITY_MODES[event.tool]) return base;
  const identity = { tool: event.tool, callId: event.call_id || null };
  if (event.type === "tool_selected") {
    return { ...identity, activityMode: TOOL_ACTIVITY_MODES[event.tool], status: "selected" };
  }
  if (event.type === "tool_started") {
    return { ...identity, activityMode: TOOL_ACTIVITY_MODES[event.tool], status: "running" };
  }
  if (event.type === "tool_result") {
    return { ...identity, activityMode: "thinking", status: "succeeded" };
  }
  if (event.type === "tool_error") {
    return { ...identity, activityMode: "thinking", status: "failed", code: event.code || null };
  }
  return base;
}
