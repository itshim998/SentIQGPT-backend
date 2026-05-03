import { readFileSync } from "fs";
import { resolve } from "path";
import { buildTitleGeneratePrompt } from "./ai/PromptBuilders";
import { classifyQueryType, shouldForceWebSearch } from "./orchestrator/queryClassifier";
import { selectRenderer } from "./tools/chartGeneration/chartSpecGenerator";
import { getImageQuotaKey } from "./middleware/imageQuota";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`FAIL | ${message}`);
  }
  console.log(`PASS | ${message}`);
}

function serverSource(): string {
  return readFileSync(resolve(__dirname, "server.ts"), "utf8");
}

function routeBlock(source: string, path: string): string {
  const start = source.indexOf(`"${path}"`);
  assert(start >= 0, `${path} route exists`);
  return source.slice(start, start + 260);
}

function assertAuthBeforeRateLimit(path: string): void {
  const block = routeBlock(serverSource(), path);
  const authIndex = block.indexOf("verifyJWT({ allowGuest: false })");
  const rateLimitIndex = block.indexOf("aiRateLimiter");
  assert(authIndex >= 0, `${path} requires signed-in auth`);
  assert(rateLimitIndex >= 0, `${path} still has AI rate limiting`);
  assert(authIndex < rateLimitIndex, `${path} resolves user before rate limiting`);
}

function run(): void {
  const titleCall = buildTitleGeneratePrompt({
    userMessage: "Help me debug a Python loop",
    assistantReply: "Let's inspect the loop and fix the condition.",
    conversationId: "conversation-cache-scope",
    userId: "user-quota-scope",
  });
  assert(titleCall.user_id === "user-quota-scope", "title generation is attributed to userId");

  assertAuthBeforeRateLimit("/api/chat/title");
  assertAuthBeforeRateLimit("/api/search");
  assertAuthBeforeRateLimit("/api/search/simple");

  const auditBlock = routeBlock(serverSource(), "/api/audit");
  assert(auditBlock.includes("verifyJWT({ allowGuest: false })"), "/api/audit is not public");
  assert(auditBlock.includes("SENTIQ_ENABLE_AUDIT_API"), "/api/audit is disabled unless explicitly enabled");

  assert(!classifyQueryType("linear algebra 2026 homework").needsWebSearch, "weak year phrase does not force web search");
  assert(classifyQueryType("best AI models in 2026").needsWebSearch, "time-sensitive year phrase does force web search");
  assert(!shouldForceWebSearch("linear algebra 2026 homework"), "force-search guard rejects weak year phrase");
  assert(shouldForceWebSearch("best AI models in 2026"), "force-search guard accepts current comparison intent");

  assert(selectRenderer("make a bar chart of these values") === "chartjs", "chart generation defaults to frontend-native Chart.js");
  assert(selectRenderer("make a matplotlib histogram") === "matplotlib", "matplotlib remains explicit opt-in");

  const quotaKey = getImageQuotaKey({
    user: { sub: "user-123", isGuest: false, verificationMethod: "local" },
    ip: "203.0.113.10",
    socket: { remoteAddress: "203.0.113.10" },
  } as any);
  assert(quotaKey === "user:user-123", "image quota keys signed-in users by user ID");
}

run();
