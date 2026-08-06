import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:sentiq_chat/features/workspace/application/workspace_controller.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_brand_mark.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_empty_state.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_text_field.dart';

enum ConversationAction { rename, delete }

class ConversationSidebar extends StatelessWidget {
  const ConversationSidebar({
    required this.identity,
    required this.state,
    required this.controller,
    required this.onRename,
    required this.onDelete,
    required this.onAccount,
    required this.onSettings,
    this.onConversationSelected,
    super.key,
  });

  final AppIdentity identity;
  final WorkspaceState state;
  final WorkspaceController controller;
  final ValueChanged<ConversationSummary> onRename;
  final ValueChanged<ConversationSummary> onDelete;
  final VoidCallback onAccount;
  final VoidCallback onSettings;
  final VoidCallback? onConversationSelected;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Material(
      color: palette.surface,
      child: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(
              SentIQSpacing.md,
              SentIQSpacing.md,
              SentIQSpacing.md,
              SentIQSpacing.sm,
            ),
            child: Row(
              children: <Widget>[
                const SentIQBrandMark(size: 38),
                const SizedBox(width: SentIQSpacing.sm),
                Expanded(
                  child: Text(
                    'SentIQ Chat',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                SentIQIconButton(
                  icon: Icons.settings_outlined,
                  tooltip: 'Settings',
                  onPressed: onSettings,
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: SentIQSpacing.md),
            child: SentIQButton(
              label: 'New chat',
              icon: Icons.add_rounded,
              expand: true,
              onPressed: controller.newConversation,
            ),
          ),
          const SizedBox(height: SentIQSpacing.sm),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: SentIQSpacing.md),
            child: SentIQTextField(
              label: 'Search conversations',
              prefixIcon: Icons.search_rounded,
              onChanged: controller.search,
            ),
          ),
          const SizedBox(height: SentIQSpacing.sm),
          Expanded(
            child: state.loading && state.conversations.isEmpty
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : state.visibleConversations.isEmpty
                ? const SentIQEmptyState(
                    icon: Icons.chat_bubble_outline_rounded,
                    title: 'No conversations yet',
                    message: 'Start a new chat when you are ready.',
                  )
                : ListView.builder(
                    padding: const EdgeInsets.symmetric(
                      horizontal: SentIQSpacing.xs,
                    ),
                    itemCount: state.visibleConversations.length,
                    itemBuilder: (BuildContext context, int index) {
                      final ConversationSummary conversation =
                          state.visibleConversations[index];
                      final bool selected =
                          conversation.id == state.selectedConversationId;
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 2),
                        child: ListTile(
                          selected: selected,
                          selectedTileColor: palette.accentSoft,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(
                              SentIQRadii.medium,
                            ),
                          ),
                          leading: Icon(
                            Icons.chat_bubble_outline_rounded,
                            size: 20,
                            color: selected
                                ? palette.accent
                                : palette.textMuted,
                          ),
                          title: Text(
                            conversation.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle:
                              conversation.syncState ==
                                  ConversationSyncState.synced
                              ? null
                              : const Text('Waiting to sync'),
                          onTap: () {
                            controller.selectConversation(conversation.id);
                            onConversationSelected?.call();
                          },
                          trailing: PopupMenuButton<ConversationAction>(
                            tooltip: 'Conversation options',
                            onSelected: (ConversationAction action) {
                              switch (action) {
                                case ConversationAction.rename:
                                  onRename(conversation);
                                  break;
                                case ConversationAction.delete:
                                  onDelete(conversation);
                                  break;
                              }
                            },
                            itemBuilder: (BuildContext context) =>
                                const <PopupMenuEntry<ConversationAction>>[
                                  PopupMenuItem<ConversationAction>(
                                    value: ConversationAction.rename,
                                    child: Text('Rename'),
                                  ),
                                  PopupMenuItem<ConversationAction>(
                                    value: ConversationAction.delete,
                                    child: Text('Delete'),
                                  ),
                                ],
                          ),
                        ),
                      );
                    },
                  ),
          ),
          const Divider(height: 1),
          ListTile(
            leading: CircleAvatar(
              backgroundColor: palette.accentSoft,
              child: Icon(
                identity.isGuest
                    ? Icons.person_outline_rounded
                    : Icons.person_rounded,
                color: palette.accent,
              ),
            ),
            title: Text(identity.displayName ?? 'Your account'),
            subtitle: Text(
              identity.isGuest
                  ? 'Guest session'
                  : identity.email ?? 'Signed in',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: onAccount,
          ),
        ],
      ),
    );
  }
}
