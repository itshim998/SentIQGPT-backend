import "./shared/brand.js";
import "./config.js";
import "./services/errors.js";
import "./rendering/rich-text-renderer.js";
import "./services/storage.js";
import "./services/auth.js";
import "./services/api.js";
import "./features/chat-controller.js";
import "./features/chat/title-sanitizer.js";
import "./features/live/live-controller.js";
import "./panels/memory-panel.js";
import "./panels/file-panel.js";
import "./panels/settings-panel.js";
import "./panels/billing-panel.js";
import "./panels/trust-panel.js";
import "./native/capacitor-bridge.js";

/* SentIQ Liquid Glass V4 — Phase 3.3 styles are colocated here so the pass
   remains one atomic, reversible frontend commit. */
const conversationHistoryStyleId = "sentiq-conversation-history-styles";
if (!document.getElementById(conversationHistoryStyleId)) {
  const style = document.createElement("style");
  style.id = conversationHistoryStyleId;
  style.textContent = String.raw`
/* ============================================================
   SentIQ Liquid Glass V4 — Phase 3.3
   Smarter conversation history
   ============================================================ */

.chat-history-group-label {
  margin: 13px 10px 5px;
  color: rgba(139, 147, 164, 0.68);
  font-size: 0.62rem;
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: 0.105em;
  text-transform: uppercase;
  user-select: none;
}

.chat-list > .chat-history-group-label:first-child,
.chat-list-collapsed-wrapper > .chat-history-group-label:first-child {
  margin-top: 2px;
}

.chat-list-item-actions {
  display: none;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
}

.chat-actions-overflow-btn {
  display: none;
  width: 29px;
  height: 29px;
  padding: 0;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: rgba(151, 159, 175, 0.78);
  box-shadow: none;
}

.chat-actions-menu {
  display: none;
}

.chat-action-label {
  display: inline;
}

.chat-actions-menu-btn {
  border: 1px solid transparent;
  background: transparent;
  color: rgba(174, 181, 195, 0.9);
}

.chat-actions-overflow-btn:hover,
.chat-actions-overflow-btn:focus-visible {
  border-color: rgba(210, 197, 255, 0.08);
  background: rgba(255, 255, 255, 0.045);
  color: rgba(240, 242, 247, 0.96);
  outline: none;
  box-shadow: 0 0 0 3px rgba(149, 123, 232, 0.05);
}

@media (hover: none), (pointer: coarse) {
  .chat-list-item {
    overflow: visible;
  }

  .chat-list-item-actions {
    display: inline-flex;
    margin-left: auto;
  }

  .chat-actions-overflow-btn {
    display: inline-flex;
  }

  .chat-actions-menu {
    display: none;
    order: 4;
    width: 100%;
    flex: 1 0 100%;
    margin: 5px 0 1px;
    padding: 4px;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    border: 1px solid rgba(255, 255, 255, 0.055);
    border-radius: 10px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.018)),
      rgba(8, 11, 18, 0.92);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.025),
      0 12px 28px rgba(0, 0, 0, 0.16);
  }

  .chat-list-item.chat-actions-open {
    flex-wrap: wrap;
    align-items: center;
    padding-bottom: 7px;
    background: rgba(255, 255, 255, 0.035);
    border-color: rgba(210, 197, 255, 0.07);
  }

  .chat-list-item.chat-actions-open .chat-actions-menu {
    display: flex;
  }

  .chat-list-item > .chat-rename-btn,
  .chat-list-item > .chat-delete-btn {
    display: none;
  }

  .chat-actions-menu-btn {
    display: flex;
    width: 100%;
    height: 35px;
    padding: 0 10px;
    align-items: center;
    justify-content: flex-start;
    gap: 9px;
    border-radius: 8px;
    opacity: 1;
    font-size: 0.76rem;
    font-weight: 560;
  }

  .chat-actions-menu-rename:hover,
  .chat-actions-menu-rename:focus-visible {
    border-color: rgba(210, 197, 255, 0.09);
    background: rgba(149, 123, 232, 0.07);
    color: rgba(222, 214, 255, 0.96);
  }

  .chat-actions-menu-delete:hover,
  .chat-actions-menu-delete:focus-visible {
    border-color: rgba(248, 113, 113, 0.1);
    background: rgba(248, 113, 113, 0.07);
    color: rgba(252, 165, 165, 0.94);
  }
}

@media (min-width: 769px) {
  .app-container.sidebar-collapsed .chat-history-group-label,
  .app-container.sidebar-collapsed .chat-list-item-actions,
  .app-container.sidebar-collapsed .chat-actions-menu {
    display: none;
  }
}

@media (max-width: 768px) {
  .chat-history-group-label {
    margin-right: 12px;
    margin-left: 12px;
  }
}

@media (forced-colors: active) {
  .chat-history-group-label {
    color: CanvasText;
  }

  .chat-actions-overflow-btn,
  .chat-list-item.chat-actions-open .chat-actions-menu {
    border: 1px solid ButtonText;
    background: Canvas;
    color: ButtonText;
    box-shadow: none;
  }
}
`;
  document.head.appendChild(style);
}

(() => {
  /* ============================================================
     SentIQ Liquid Glass V4 — Phase 3.3
     Smarter conversation history

     Enhances the existing chat-list renderer without replacing its storage,
     search, rename, delete, active-chat, or expansion behaviour.
     ============================================================ */

  const DAY_MS = 24 * 60 * 60 * 1000;
  const GROUP_LABELS = Object.freeze({
    today: "Today",
    yesterday: "Yesterday",
    previous7: "Previous 7 days",
    older: "Older",
  });

  const chatList = document.getElementById("chat-list");
  const chatSearchInput = document.getElementById("chat-search-input");
  const Storage = window.SentIQStorage;

  if (chatList && Storage) {
    let enhancementScheduled = false;
    let enhancementRun = 0;
    let actionMenuSequence = 0;
    let midnightRefreshTimer = 0;

    function getChatTimestamp(chat) {
      const candidates = [
        chat?.last_activity_at,
        chat?.lastActivityAt,
        chat?.last_message_at,
        chat?.lastMessageAt,
        chat?.updated,
        chat?.updated_at,
        chat?.created,
        chat?.created_at,
      ];

      for (const candidate of candidates) {
        if (!candidate) continue;
        const timestamp = new Date(candidate).getTime();
        if (Number.isFinite(timestamp)) return timestamp;
      }
      return null;
    }

    function getCalendarOrdinal(timestamp) {
      const date = new Date(timestamp);
      return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
    }

    function getHistoryGroup(chat, now = Date.now()) {
      const timestamp = getChatTimestamp(chat);
      if (!Number.isFinite(timestamp)) return null;

      const dayDifference = getCalendarOrdinal(now) - getCalendarOrdinal(timestamp);
      if (dayDifference <= 0) return "today";
      if (dayDifference === 1) return "yesterday";
      if (dayDifference <= 7) return "previous7";
      return "older";
    }

    function getHistoryItems(container) {
      if (!container) return [];
      return Array.from(container.children).filter((child) => child.classList?.contains("chat-list-item"));
    }

    function createGroupLabel(groupKey) {
      const label = document.createElement("div");
      label.className = "chat-history-group-label";
      label.dataset.historyGroupLabel = groupKey;
      label.setAttribute("role", "heading");
      label.setAttribute("aria-level", "3");
      label.textContent = GROUP_LABELS[groupKey];
      return label;
    }

    function insertGroupLabels(container, items, initialGroup = null) {
      let previousGroup = initialGroup;
      for (const item of items) {
        const groupKey = item.dataset.historyGroup || "";
        if (groupKey && groupKey !== previousGroup) {
          container.insertBefore(createGroupLabel(groupKey), item);
        }
        previousGroup = groupKey || null;
      }
      return previousGroup;
    }

    function closeActionMenu(item, restoreFocus = false) {
      if (!item?.classList.contains("chat-actions-open")) return;
      item.classList.remove("chat-actions-open");
      const trigger = item.querySelector(".chat-actions-overflow-btn");
      trigger?.setAttribute("aria-expanded", "false");
      if (restoreFocus) trigger?.focus();
    }

    function closeOtherActionMenus(exceptItem = null) {
      chatList.querySelectorAll(".chat-list-item.chat-actions-open").forEach((item) => {
        if (item !== exceptItem) closeActionMenu(item);
      });
    }

    function createTouchActionButton(label, iconMarkup, className, onActivate) {
      const button = document.createElement("button");
      button.className = `chat-actions-menu-btn ${className}`;
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.innerHTML = `${iconMarkup}<span class="chat-action-label">${label}</span>`;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      });
      return button;
    }

    function enhanceChatActions(item) {
      if (item.dataset.historyActionsEnhanced === "true") return;

      const renameButton = Array.from(item.children).find((child) => child.classList?.contains("chat-rename-btn"));
      const deleteButton = Array.from(item.children).find((child) => child.classList?.contains("chat-delete-btn"));
      if (!renameButton || !deleteButton) return;

      item.dataset.historyActionsEnhanced = "true";
      const itemId = item.getAttribute("data-id") || String(++actionMenuSequence);
      const menuId = `chat-actions-${String(itemId).replace(/[^a-zA-Z0-9_-]/g, "-")}-${++actionMenuSequence}`;

      const triggerWrap = document.createElement("div");
      triggerWrap.className = "chat-list-item-actions";

      const overflowButton = document.createElement("button");
      overflowButton.className = "chat-actions-overflow-btn";
      overflowButton.type = "button";
      overflowButton.title = "Chat actions";
      overflowButton.setAttribute("aria-label", "Open chat actions");
      overflowButton.setAttribute("aria-haspopup", "menu");
      overflowButton.setAttribute("aria-expanded", "false");
      overflowButton.setAttribute("aria-controls", menuId);
      overflowButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
      triggerWrap.appendChild(overflowButton);

      const menu = document.createElement("div");
      menu.id = menuId;
      menu.className = "chat-actions-menu";
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "Chat actions");

      const renameProxy = createTouchActionButton(
        "Rename",
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
        "chat-actions-menu-rename",
        () => {
          closeActionMenu(item);
          renameButton.click();
        },
      );
      const deleteProxy = createTouchActionButton(
        "Delete",
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
        "chat-actions-menu-delete",
        () => {
          closeActionMenu(item);
          deleteButton.click();
        },
      );
      menu.append(renameProxy, deleteProxy);

      item.append(triggerWrap, menu);

      overflowButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const shouldOpen = !item.classList.contains("chat-actions-open");
        closeOtherActionMenus(item);
        item.classList.toggle("chat-actions-open", shouldOpen);
        overflowButton.setAttribute("aria-expanded", String(shouldOpen));
        if (shouldOpen) {
          requestAnimationFrame(() => menu.querySelector("button")?.focus());
        }
      });

      triggerWrap.addEventListener("click", (event) => event.stopPropagation());
      menu.addEventListener("click", (event) => event.stopPropagation());
    }

    function clearGeneratedLabels() {
      chatList.querySelectorAll(".chat-history-group-label").forEach((label) => label.remove());
    }

    function getRenderSignature(items, chatById) {
      const collapsedWrapper = chatList.querySelector(":scope > .chat-list-collapsed-wrapper");
      const wrapperState = collapsedWrapper
        ? (collapsedWrapper.classList.contains("expanded") ? "expanded" : "collapsed")
        : "flat";
      const searchState = String(chatSearchInput?.value || "").trim().toLowerCase();
      return [
        wrapperState,
        searchState,
        ...items.map((item) => {
          const id = item.getAttribute("data-id") || "";
          return `${id}:${getHistoryGroup(chatById.get(id)) || "ungrouped"}`;
        }),
      ].join("|");
    }

    async function enhanceConversationHistory() {
      const runId = ++enhancementRun;
      const initialItems = Array.from(chatList.querySelectorAll(".chat-list-item[data-id]"));
      if (initialItems.length === 0) {
        clearGeneratedLabels();
        chatList.removeAttribute("data-history-signature");
        return;
      }

      const initialToken = initialItems.map((item) => item.getAttribute("data-id") || "").join("|");
      const chats = typeof Storage.getAllChats === "function"
        ? await Storage.getAllChats().catch(() => [])
        : [];
      if (runId !== enhancementRun) return;

      const currentItems = Array.from(chatList.querySelectorAll(".chat-list-item[data-id]"));
      const currentToken = currentItems.map((item) => item.getAttribute("data-id") || "").join("|");
      if (initialToken !== currentToken) {
        scheduleEnhancement();
        return;
      }

      const chatById = new Map((Array.isArray(chats) ? chats : []).map((chat) => [String(chat?.id || ""), chat]));
      currentItems.forEach((item) => {
        const id = item.getAttribute("data-id") || "";
        const groupKey = getHistoryGroup(chatById.get(id));
        if (groupKey) item.dataset.historyGroup = groupKey;
        else delete item.dataset.historyGroup;
      });

      const signature = getRenderSignature(currentItems, chatById);
      const alreadyEnhanced = currentItems.every((item) => item.dataset.historyActionsEnhanced === "true");
      if (chatList.dataset.historySignature === signature && alreadyEnhanced) return;

      isMutatingHistoryDom = true;
      try {
        clearGeneratedLabels();
        currentItems.forEach(enhanceChatActions);

        const collapsedWrapper = chatList.querySelector(":scope > .chat-list-collapsed-wrapper");
        const topItems = getHistoryItems(chatList);
        const lastTopGroup = insertGroupLabels(chatList, topItems);
        if (collapsedWrapper) {
          const hiddenItems = getHistoryItems(collapsedWrapper);
          const firstHiddenGroup = hiddenItems[0]?.dataset.historyGroup || null;
          insertGroupLabels(
            collapsedWrapper,
            hiddenItems,
            firstHiddenGroup && firstHiddenGroup === lastTopGroup ? lastTopGroup : null,
          );
        }

        chatList.dataset.historySignature = signature;
      } finally {
        isMutatingHistoryDom = false;
      }
    }

    let isMutatingHistoryDom = false;
    function scheduleEnhancement() {
      if (enhancementScheduled) return;
      enhancementScheduled = true;
      queueMicrotask(() => {
        enhancementScheduled = false;
        void enhanceConversationHistory();
      });
    }

    function scheduleMidnightRefresh() {
      if (midnightRefreshTimer) window.clearTimeout(midnightRefreshTimer);
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2, 0);
      midnightRefreshTimer = window.setTimeout(() => {
        chatList.removeAttribute("data-history-signature");
        scheduleEnhancement();
        scheduleMidnightRefresh();
      }, Math.max(1000, nextMidnight.getTime() - now.getTime()));
    }

    const observer = new MutationObserver((records) => {
      if (isMutatingHistoryDom) return;
      const hasStructuralChanges = records.some((r) => (
        Array.from(r.addedNodes).some((n) => n instanceof HTMLElement && (n.classList.contains("chat-list-item") || n.classList.contains("chat-list-collapsed-wrapper")))
        || Array.from(r.removedNodes).some((n) => n instanceof HTMLElement && (n.classList.contains("chat-list-item") || n.classList.contains("chat-list-collapsed-wrapper")))
      ));
      if (hasStructuralChanges) scheduleEnhancement();
    });
    observer.observe(chatList, { childList: true, subtree: true });

    document.addEventListener("pointerdown", (event) => {
      chatList.querySelectorAll(".chat-list-item.chat-actions-open").forEach((item) => {
        if (!(event.target instanceof Node) || !item.contains(event.target)) closeActionMenu(item);
      });
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const openItem = chatList.querySelector(".chat-list-item.chat-actions-open");
      if (!openItem) return;
      closeActionMenu(openItem, true);
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      chatList.removeAttribute("data-history-signature");
      scheduleEnhancement();
      scheduleMidnightRefresh();
    });

    scheduleEnhancement();
    scheduleMidnightRefresh();
  }
})();
