export interface AuthorizedAutomaticMemory {
  readonly content: string;
  readonly scope: "global" | "chat";
}

const COMMAND = "(?:remember|save|store)";
const CHAT_SCOPE = "(?:for|in)\\s+(?:this|the)\\s+(?:chat|conversation)";

function normalizeClause(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function validateAuthorizedClause(value: string): string {
  const clause = normalizeClause(value).replace(/\?$/, "").trim();
  const semanticClause = clause.replace(/[.!?]+$/, "").trim();
  if (!semanticClause || /^(?:it|this|that|something|everything)$/i.test(semanticClause)) {
    throw new Error("The memory request does not identify an explicit fact to store.");
  }
  if (/;/.test(clause) || /[.!?]\s+\S/.test(clause)) {
    throw new Error("The memory request contains multiple ambiguous targets.");
  }
  if (/\b(?:and|or)\s+(?:i|my|we|our|the\s+project)\b/i.test(clause)) {
    throw new Error("The memory request contains multiple ambiguous targets.");
  }
  return clause;
}

export function authorizeAutomaticMemoryUpdate(originalUserMessage: string): AuthorizedAutomaticMemory {
  const message = normalizeClause(originalUserMessage);
  if (!message) throw new Error("An explicit memory request is required.");

  // Commands quoted or merely discussed are data, not user authorization.
  if (/["“][^"”]*(?:remember|save|store)\b[^"”]*["”]/i.test(message)) {
    throw new Error("Quoted memory commands are not authorization.");
  }

  const prefix = new RegExp(
    `^(?:please\\s+)?(?:(?:(?:can|could|would|will)\\s+you\\s+)|(?:i\\s+(?:want|need|would\\s+like)\\s+you\\s+to\\s+))?${COMMAND}\\b\\s*(.*)$`,
    "i",
  );
  const prefixMatch = message.match(prefix);
  if (prefixMatch) {
    let remainder = prefixMatch[1].trim();
    let scope: "global" | "chat" = "global";
    const leadingScope = new RegExp(`^${CHAT_SCOPE}\\s*[:,]?\\s*`, "i");
    const trailingScope = new RegExp(`\\s+${CHAT_SCOPE}\\s*[.!?]*$`, "i");
    if (leadingScope.test(remainder)) {
      scope = "chat";
      remainder = remainder.replace(leadingScope, "");
    } else if (trailingScope.test(remainder)) {
      scope = "chat";
      remainder = remainder.replace(trailingScope, "");
    }
    remainder = remainder.replace(/^(?:that\s+|this\s*:?[ ]*|to\s+|:\s*)/i, "");
    return { content: validateAuthorizedClause(remainder), scope };
  }

  // One declarative clause may authorize a following unambiguous "remember it" request.
  const suffix = new RegExp(
    `^([^.!?;]+?)(?:[.!?]\\s+|,\\s*)(?:please\\s+)?${COMMAND}\\s+(?:it|that|this)(?:\\s+(${CHAT_SCOPE}))?\\s*[.!?]*$`,
    "i",
  );
  const suffixMatch = message.match(suffix);
  if (suffixMatch) {
    return {
      content: validateAuthorizedClause(suffixMatch[1]),
      scope: suffixMatch[2] ? "chat" : "global",
    };
  }

  throw new Error("A direct, explicit remember, save, or store request is required.");
}

export function enforceAutomaticMemoryScope(
  authorized: AuthorizedAutomaticMemory,
  modelScope: "global" | "chat",
): AuthorizedAutomaticMemory {
  if (authorized.scope !== modelScope) {
    throw new Error("The requested memory scope does not match the user's authorization.");
  }
  return authorized;
}
