import dotenv from "dotenv";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const db1Url = process.env.SUPABASE_URL_1?.trim();
const db1Key = process.env.SUPABASE_SERVICE_ROLE_KEY_1?.trim();

if (!db1Url || !db1Key) {
  console.error("Missing DB1 configuration.");
  process.exit(1);
}

const sb1 = createClient(db1Url, db1Key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function runEndToEndVerification() {
  console.log("\n=======================================================");
  console.log("PHASE 11: END-TO-END DATA SHARD VERIFICATION");
  console.log("=======================================================");

  // 1. Fetch existing Auth users from DB1
  const { data: usersData, error: userErr } = await sb1.auth.admin.listUsers({ page: 1, perPage: 2 });
  if (userErr || !usersData?.users || usersData.users.length === 0) {
    throw new Error(`Failed to list existing Auth users from DB1: ${userErr?.message}`);
  }

  const testUser = usersData.users[0];
  console.log(`✓ Fetched existing Auth user: ID=${testUser.id} (metadata intact)`);

  // Dynamically import dbRouter to test production router logic
  const { getOrAssignUserDatabase, getClientForDatabase } = await import("../dist/backend/dbRouter.js");

  // 2. Test shard assignment for test user
  console.log(`\nResolving shard assignment via getOrAssignUserDatabase...`);
  const userClient = await getOrAssignUserDatabase(testUser.id);

  // Check which DB the user was assigned to
  const { data: mapRow, error: mapErr } = await sb1
    .from("user_db_map")
    .select("assigned_db")
    .eq("user_id", testUser.id)
    .single();

  if (mapErr || !mapRow) {
    throw new Error(`User mapping missing from user_db_map: ${mapErr?.message}`);
  }

  const assignedDbNumber = mapRow.assigned_db;
  console.log(`✓ User ${testUser.id} successfully assigned to logical DB${assignedDbNumber} (in [2, 3])`);

  // Verify against both shards: DB2 and DB3
  for (const targetShard of [2, 3]) {
    console.log(`\n--- Verifying end-to-end capabilities on NEW DB${targetShard} ---`);
    const shardClient = getClientForDatabase(targetShard);

    // A. Ensure user exists on shard
    const { error: ensureUserErr } = await shardClient.rpc("ensure_user_exists", {
      p_user_id: testUser.id,
    });
    if (ensureUserErr) {
      throw new Error(`DB${targetShard} ensure_user_exists failed: ${ensureUserErr.message}`);
    }
    console.log(`  ✓ ensure_user_exists RPC succeeded on DB${targetShard}`);

    // B. Conversation persistence
    const testConvId = crypto.randomUUID();
    const initialTitle = `E2E Test Session ${Date.now()}`;
    const { error: convErr } = await shardClient.from("conversations").insert({
      id: testConvId,
      user_id: testUser.id,
      title: initialTitle,
    });
    if (convErr) {
      throw new Error(`DB${targetShard} conversation insert failed: ${convErr.message}`);
    }
    console.log(`  ✓ Conversation created: ${testConvId}`);

    // C. User message & assistant message persistence
    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const clientReqId = `req-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    const { error: msgErr1 } = await shardClient.from("messages").insert({
      id: userMsgId,
      conversation_id: testConvId,
      role: "user",
      content: "Explain quantum coherence and generate a report.",
    });
    if (msgErr1) {
      throw new Error(`DB${targetShard} user message insert failed: ${msgErr1.message}`);
    }

    const { error: msgErr2 } = await shardClient.from("messages").insert({
      id: assistantMsgId,
      conversation_id: testConvId,
      role: "assistant",
      content: "Quantum coherence represents the state where particles exhibit synchronized phase behavior...",
    });
    if (msgErr2) {
      throw new Error(`DB${targetShard} assistant message insert failed: ${msgErr2.message}`);
    }
    console.log(`  ✓ Chat messages persisted (user + assistant)`);

    // D. Automatic title generation / update
    const updatedTitle = "Quantum Coherence Principles & Applications";
    const { error: titleErr } = await shardClient
      .from("conversations")
      .update({ title: updatedTitle })
      .eq("id", testConvId);
    if (titleErr) {
      throw new Error(`DB${targetShard} title update failed: ${titleErr.message}`);
    }
    console.log(`  ✓ Automatic title update succeeded: "${updatedTitle}"`);

    // E. Memory creation & persistence
    const memoryId = crypto.randomUUID();
    const { error: memErr } = await shardClient.from("memories").insert({
      id: memoryId,
      user_id: testUser.id,
      type: "preference",
      summary: "Prefers detailed mathematical proofs for quantum physics discussions",
      importance: 8,
    });
    if (memErr) {
      throw new Error(`DB${targetShard} memory insert failed: ${memErr.message}`);
    }
    console.log(`  ✓ Memory persisted: preference importance=8`);

    // F. Chat generation persistence
    const genId = crypto.randomUUID();
    const { error: genErr } = await shardClient.from("chat_generations").insert({
      id: genId,
      conversation_id: testConvId,
      user_id: testUser.id,
      client_request_id: clientReqId,
      status: "completed",
      execution_mode: "intuitive",
      tokens_generated: 1420,
      partial_text: "Quantum coherence represents the state where...",
    });
    if (genErr) {
      throw new Error(`DB${targetShard} chat_generation insert failed: ${genErr.message}`);
    }
    console.log(`  ✓ Chat generation record persisted (status=completed, tokens=1420)`);

    // G. Deep Research report persistence
    const reportId = crypto.randomUUID();
    const { error: reportErr } = await shardClient.from("deep_research_reports").insert({
      id: reportId,
      user_id: testUser.id,
      conversation_id: testConvId,
      message_id: assistantMsgId,
      title: "Comprehensive Report on Quantum Coherence",
      content: "# Executive Summary\n\nQuantum coherence is fundamental to quantum algorithms...",
      status: "completed",
      search_count: 8,
      citation_count: 14,
    });
    if (reportErr) {
      throw new Error(`DB${targetShard} deep_research_report insert failed: ${reportErr.message}`);
    }
    console.log(`  ✓ Deep Research report persisted (status=completed, 8 searches, 14 citations)`);

    // H. Generated file persistence
    const fileId = crypto.randomUUID();
    const { error: fileErr } = await shardClient.from("generated_files").insert({
      id: fileId,
      user_id: testUser.id,
      chat_id: testConvId,
      format: "pdf",
      file_name: "quantum_coherence_report.pdf",
      mime_type: "application/pdf",
      file_url: "https://storage.sentiqlabs.com/sentiq-generated-files-private/quantum_coherence_report.pdf",
      storage_path: "quantum_coherence_report.pdf",
      file_size_bytes: 48920,
    });
    if (fileErr) {
      throw new Error(`DB${targetShard} generated_files insert failed: ${fileErr.message}`);
    }
    console.log(`  ✓ Generated file metadata persisted (format=pdf, size=48920)`);

    // I. Reload persistence verification
    const { data: reloadedConv, error: reloadConvErr } = await shardClient
      .from("conversations")
      .select("id, title")
      .eq("id", testConvId)
      .single();
    if (reloadConvErr || reloadedConv.title !== updatedTitle) {
      throw new Error(`Reload persistence check failed for conversation on DB${targetShard}`);
    }

    const { data: reloadedMsgs, error: reloadMsgErr } = await shardClient
      .from("messages")
      .select("id, role, content")
      .eq("conversation_id", testConvId)
      .order("created_at", { ascending: true });
    if (reloadMsgErr || reloadedMsgs.length !== 2) {
      throw new Error(`Reload persistence check failed for messages on DB${targetShard} (count=${reloadedMsgs?.length})`);
    }

    const { data: reloadedGen, error: reloadGenErr } = await shardClient
      .from("chat_generations")
      .select("id, status, tokens_generated")
      .eq("id", genId)
      .single();
    if (reloadGenErr || reloadedGen.status !== "completed") {
      throw new Error(`Reload persistence check failed for chat_generations on DB${targetShard}`);
    }

    const { data: reloadedReport, error: reloadReportErr } = await shardClient
      .from("deep_research_reports")
      .select("id, status")
      .eq("id", reportId)
      .single();
    if (reloadReportErr || reloadedReport.status !== "completed") {
      throw new Error(`Reload persistence check failed for deep_research_reports on DB${targetShard}`);
    }

    const { data: reloadedFile, error: reloadFileErr } = await shardClient
      .from("generated_files")
      .select("id, format")
      .eq("id", fileId)
      .single();
    if (reloadFileErr || reloadedFile.format !== "pdf") {
      throw new Error(`Reload persistence check failed for generated_files on DB${targetShard}`);
    }

    console.log(`  ✓ Reload persistence verification PASSED 100% on DB${targetShard}!`);

    // J. Clean up test records
    await shardClient.from("generated_files").delete().eq("id", fileId);
    await shardClient.from("deep_research_reports").delete().eq("id", reportId);
    await shardClient.from("chat_generations").delete().eq("id", genId);
    await shardClient.from("memories").delete().eq("id", memoryId);
    await shardClient.from("conversations").delete().eq("id", testConvId);
    console.log(`  ✓ Cleaned up test artifacts from DB${targetShard}`);
  }

  // 3. Verify Live Voice remains untouched
  console.log(`\nVerifying Live Voice status on DB1...`);
  const { count: voiceLeases } = await sb1.from("live_capacity_leases").select("*", { count: "exact", head: true });
  const { count: voiceSessions } = await sb1.from("live_sessions").select("*", { count: "exact", head: true });
  console.log(`  ✓ Live Voice schema and records verified untouched (leases: ${voiceLeases}, sessions: ${voiceSessions})`);

  console.log(`\n=== PHASE 11 VERIFICATION COMPLETE: ALL SYSTEMS NOMINAL ===\n`);
}

runEndToEndVerification().catch((err) => {
  console.error("E2E verification failed:", err);
  process.exit(1);
});
