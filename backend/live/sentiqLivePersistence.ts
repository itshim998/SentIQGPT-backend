import { randomUUID } from "crypto";
import {
  getControlDatabase,
  getOrAssignUserDatabase,
  initializeControlUserSession,
} from "../dbRouter";
import {
  createConversation,
  getConversationById,
  getConversationMessages,
  insertConversationMessage,
} from "../services/conversationService";
import { contextCapsuleService } from "../services/contextCapsuleService";
import { getMirroredUserProfile } from "../services/profileService";
import {
  LiveSessionError,
  type LivePreparedContext,
  type LiveSessionPersistence,
  type LiveTranscriptTurn,
} from "./liveSessionService";

const CONTEXT_MESSAGE_TYPES = new Set(["text", "live_transcript", "live_summary"]);

async function initializeUserSession(userDb: any, userId: string): Promise<void> {
  const { error } = await userDb.rpc("initialize_user_session", { p_user_id: userId });
  if (error) throw new Error(error.message || "User session initialization failed.");
}

async function getOwnedConversation(userDb: any, userId: string, conversationId: string) {
  const { data, error } = await getConversationById(userDb, conversationId);
  if (error) throw new Error(error.message || "Conversation lookup failed.");
  if (!data) {
    throw new LiveSessionError("Conversation not found.", "conversation_not_found", 404);
  }
  if (data.user_id !== userId) {
    throw new LiveSessionError("Unauthorized conversation access.", "conversation_forbidden", 403);
  }
  return data;
}

async function prepareUserWorkspace(userId: string) {
  await initializeControlUserSession(userId);
  const userDb = await getOrAssignUserDatabase(userId);
  await initializeUserSession(userDb, userId);
  const profile = await getMirroredUserProfile({
    userId,
    controlDb: getControlDatabase(),
    userDb,
  });
  if (profile.requiresName) {
    throw new LiveSessionError("Add your name to continue.", "profile_name_required", 403);
  }
  return { userDb, displayName: profile.displayName || undefined };
}

export class SentIQLivePersistence implements LiveSessionPersistence {
  async prepareContext(args: {
    userId: string;
    sourceConversationId?: string;
    conversationId?: string;
  }): Promise<LivePreparedContext> {
    const { userDb, displayName } = await prepareUserWorkspace(args.userId);
    const sourceConversationId = args.sourceConversationId || args.conversationId;

    let recentTurns: LiveTranscriptTurn[] = [];
    let workspaceCapsule: string | undefined;
    let conversationCapsule: string | undefined;

    if (sourceConversationId) {
      try {
        await getOwnedConversation(userDb, args.userId, sourceConversationId);
        const [capsules, messageResult] = await Promise.all([
          contextCapsuleService.readCapsules({
            userDb,
            ownerUserId: args.userId,
            conversationId: sourceConversationId,
          }),
          getConversationMessages(userDb, sourceConversationId),
        ]);
        if (!messageResult.error && Array.isArray(messageResult.data)) {
          recentTurns = messageResult.data
            .filter((message) => CONTEXT_MESSAGE_TYPES.has(message.message_type || "text"))
            .filter((message) => typeof message.content === "string" && message.content.trim())
            .slice(-6)
            .map((message) => ({
              role: (message.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
              text: message.content,
            }));
        }
        workspaceCapsule = capsules.workspace?.content;
        conversationCapsule = capsules.conversation?.content;
      } catch {
        // If source conversation cannot be read or is invalid, proceed with fresh context
      }
    }

    // Every Live session creates and owns a fresh destination conversation
    const liveConversationId = randomUUID();
    const created = await createConversation(userDb, {
      id: liveConversationId,
      userId: args.userId,
      title: "New Chat",
    });
    if (created.error || !created.data) {
      throw new Error(created.error?.message || "Live destination conversation creation failed.");
    }

    return {
      conversationId: liveConversationId,
      liveConversationId,
      sourceConversationId: sourceConversationId || undefined,
      displayName,
      workspaceCapsule,
      conversationCapsule,
      recentTurns,
    };
  }

  async persistTranscript(args: {
    userId: string;
    conversationId: string;
    sessionId: string;
    transcript: Array<{ role: "user" | "assistant"; text: string }>;
    summary?: string;
  }): Promise<number> {
    const { userDb } = await prepareUserWorkspace(args.userId);
    await getOwnedConversation(userDb, args.userId, args.conversationId);
    const transcriptLines = args.transcript.map((turn) => (
      `${turn.role === "assistant" ? "SentIQ" : "You"}: ${turn.text}`
    ));
    const sections = [
      args.summary ? `Summary\n${args.summary}` : "",
      transcriptLines.length > 0 ? `Live transcript\n${transcriptLines.join("\n")}` : "",
    ].filter(Boolean);
    if (sections.length === 0) return 0;

    const inserted = await insertConversationMessage(userDb, {
      conversationId: args.conversationId,
      role: "assistant",
      content: sections.join("\n\n"),
      clientRequestId: args.sessionId,
      messageType: "live_transcript",
    });
    if (inserted.error || !inserted.data) {
      throw new Error(inserted.error?.message || "Live transcript could not be committed.");
    }

    try {
      const segments = args.transcript.map((turn, index) => ({
        sequence: index,
        role: turn.role,
        text: turn.text,
      }));
      await userDb.rpc("commit_live_session_transcript", {
        p_session_id: args.sessionId,
        p_owner_user_id: args.userId,
        p_conversation_id: args.conversationId,
        p_segments: segments,
        p_summary: args.summary ?? null,
      });
    } catch {
      // Message insertion in conversations is primary; RPC records durable segments
    }

    return 1;
  }
}
