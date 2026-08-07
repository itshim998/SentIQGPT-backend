import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/features/account/application/account_controller.dart';
import 'package:sentiq_chat/features/account/domain/account_models.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:sentiq_chat/features/billing/presentation/billing_screen.dart';
import 'package:sentiq_chat/features/workspace/application/workspace_controller.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_text_field.dart';
import 'package:url_launcher/url_launcher.dart';

class AccountScreen extends ConsumerWidget {
  const AccountScreen({
    required this.identity,
    required this.session,
    super.key,
  });

  final AppIdentity identity;
  final WorkspaceSession session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AccountState state = ref.watch(accountControllerProvider(session));
    final AccountController controller = ref.read(
      accountControllerProvider(session).notifier,
    );
    return DefaultTabController(
      length: 4,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Account'),
          bottom: const TabBar(
            isScrollable: true,
            tabs: <Widget>[
              Tab(text: 'Profile'),
              Tab(text: 'Memory'),
              Tab(text: 'Privacy'),
              Tab(text: 'Data & support'),
            ],
          ),
        ),
        body: Column(
          children: <Widget>[
            if (state.message != null)
              MaterialBanner(
                content: Text(state.message!),
                actions: <Widget>[
                  TextButton(
                    onPressed: controller.clearMessage,
                    child: const Text('Dismiss'),
                  ),
                ],
              ),
            Expanded(
              child: TabBarView(
                children: <Widget>[
                  _ProfileTab(identity: identity),
                  _MemoryTab(
                    identity: identity,
                    state: state,
                    controller: controller,
                  ),
                  const _PrivacyTab(),
                  _DataSupportTab(
                    identity: identity,
                    state: state,
                    controller: controller,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ProfileTab extends ConsumerWidget {
  const _ProfileTab({required this.identity});

  final AppIdentity identity;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppIdentity activeIdentity =
        ref.watch(authControllerProvider).identity ?? identity;
    return ListView(
      padding: const EdgeInsets.all(SentIQSpacing.md),
      children: <Widget>[
        Card(
          child: Padding(
            padding: const EdgeInsets.all(SentIQSpacing.md),
            child: Row(
              children: <Widget>[
                CircleAvatar(
                  radius: 26,
                  child: Text(
                    (activeIdentity.displayName?.trim().isNotEmpty == true
                            ? activeIdentity.displayName!.trim()[0]
                            : activeIdentity.email?.trim().isNotEmpty == true
                            ? activeIdentity.email!.trim()[0]
                            : 'S')
                        .toUpperCase(),
                  ),
                ),
                const SizedBox(width: SentIQSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        activeIdentity.isGuest
                            ? 'Guest session'
                            : activeIdentity.displayName ??
                                  'SentIQ Chat account',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      Text(
                        activeIdentity.isGuest
                            ? 'Temporary on this device'
                            : activeIdentity.email ?? 'Signed in',
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: SentIQSpacing.md),
        if (!activeIdentity.isGuest)
          ListTile(
            leading: const Icon(Icons.badge_outlined),
            title: const Text('Name used by SentIQ Chat'),
            subtitle: Text(activeIdentity.displayName ?? 'Not set'),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () => _editName(context, ref, activeIdentity.displayName),
          ),
        ListTile(
          leading: const Icon(Icons.workspace_premium_outlined),
          title: const Text('Plan and usage'),
          subtitle: const Text('Current plan, allowances and plan comparison'),
          trailing: const Icon(Icons.chevron_right_rounded),
          onTap: () => Navigator.of(context).push<void>(
            MaterialPageRoute<void>(
              builder: (_) => BillingScreen(identity: activeIdentity),
            ),
          ),
        ),
        if (activeIdentity.isGuest)
          Padding(
            padding: const EdgeInsets.only(top: SentIQSpacing.md),
            child: SentIQButton(
              label: 'Sign in or create account',
              expand: true,
              onPressed: () {
                ref.read(authControllerProvider.notifier).returnToSignIn();
                Navigator.of(
                  context,
                ).popUntil((Route<dynamic> route) => route.isFirst);
              },
            ),
          ),
      ],
    );
  }

  Future<void> _editName(
    BuildContext context,
    WidgetRef ref,
    String? current,
  ) async {
    final TextEditingController controller = TextEditingController(
      text: current,
    );
    final String? value = await showDialog<String>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('Your name'),
        content: SentIQTextField(
          label: 'Name',
          controller: controller,
          textInputAction: TextInputAction.done,
          onSubmitted: (String value) => Navigator.of(context).pop(value),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(controller.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (value != null && value.trim().isNotEmpty) {
      await ref.read(authControllerProvider.notifier).saveDisplayName(value);
    }
  }
}

class _MemoryTab extends StatelessWidget {
  const _MemoryTab({
    required this.identity,
    required this.state,
    required this.controller,
  });

  final AppIdentity identity;
  final AccountState state;
  final AccountController controller;

  @override
  Widget build(BuildContext context) {
    if (identity.isGuest) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(SentIQSpacing.lg),
          child: Text(
            'Guest sessions do not save memories. Sign in to manage memories across conversations.',
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: controller.refreshMemories,
      child: state.loading && state.memories.isEmpty
          ? ListView(
              children: const <Widget>[
                SizedBox(height: 240),
                Center(child: CircularProgressIndicator()),
              ],
            )
          : ListView.builder(
              padding: const EdgeInsets.all(SentIQSpacing.md),
              itemCount: state.memories.isEmpty ? 1 : state.memories.length,
              itemBuilder: (BuildContext context, int index) {
                if (state.memories.isEmpty) {
                  return const Padding(
                    padding: EdgeInsets.only(top: 160),
                    child: Text(
                      'No memories are saved yet. Memories appear only when you explicitly ask SentIQ Chat to remember something.',
                      textAlign: TextAlign.center,
                    ),
                  );
                }
                final AccountMemory memory = state.memories[index];
                return Card(
                  child: ListTile(
                    title: Text(memory.summary),
                    subtitle: Text(
                      '${memory.scope == 'chat' ? 'Single chat' : 'Across chats'} · ${memory.importance}/10',
                    ),
                    trailing: IconButton(
                      tooltip: 'Delete memory',
                      icon: const Icon(Icons.delete_outline_rounded),
                      onPressed: () =>
                          unawaited(controller.deleteMemory(memory.id)),
                    ),
                  ),
                );
              },
            ),
    );
  }
}

class _PrivacyTab extends StatelessWidget {
  const _PrivacyTab();

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(SentIQSpacing.md),
      children: <Widget>[
        Text('Privacy', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: SentIQSpacing.sm),
        const Text(
          'SentIQ Chat can be used for conversations, files, web search, deep research, and content creation. As with any AI-powered tool, we recommend reviewing important outputs before relying on them.',
        ),
        const SizedBox(height: SentIQSpacing.sm),
        const Text(
          'Guest sessions are temporary by design. Conversations started without an account are not saved and will not persist once the session ends.',
        ),
        const SizedBox(height: SentIQSpacing.sm),
        const Text(
          'Signing in to your account allows your conversations, messages, memories, and created files to be securely saved and accessible across sessions.',
        ),
        const SizedBox(height: SentIQSpacing.sm),
        const Text(
          'Files you share with SentIQ Chat are used solely to fulfill your request.',
        ),
        const SizedBox(height: SentIQSpacing.xl),
        Text('Terms of use', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: SentIQSpacing.sm),
        const Text(
          'By using SentIQ Chat, you agree to use the service lawfully and responsibly. You are responsible for ensuring that any material you upload or share is content you have the right to use.',
        ),
        const SizedBox(height: SentIQSpacing.sm),
        const Text(
          'We recommend reviewing important outputs before relying on them, as SentIQ Chat, like any AI-powered tool, may occasionally produce inaccurate or incomplete results.',
        ),
      ],
    );
  }
}

class _DataSupportTab extends ConsumerWidget {
  const _DataSupportTab({
    required this.identity,
    required this.state,
    required this.controller,
  });

  final AppIdentity identity;
  final AccountState state;
  final AccountController controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ListView(
      padding: const EdgeInsets.all(SentIQSpacing.md),
      children: <Widget>[
        Text('Data controls', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: SentIQSpacing.xs),
        const Text(
          'Clearing local data removes this device’s cache and temporary upload session. It does not remove cloud conversations or memories.',
        ),
        const SizedBox(height: SentIQSpacing.md),
        SentIQButton(
          label: 'Clear temporary files',
          style: SentIQButtonStyle.secondary,
          expand: true,
          onPressed: state.clearing
              ? null
              : () => unawaited(controller.clearTemporaryFiles()),
        ),
        const SizedBox(height: SentIQSpacing.sm),
        SentIQButton(
          label: 'Clear data on this device',
          style: SentIQButtonStyle.secondary,
          expand: true,
          onPressed: state.clearing
              ? null
              : () => _confirmClear(context, controller),
        ),
        const SizedBox(height: SentIQSpacing.sm),
        const Text(
          'Delete conversations from the conversation list and memories from Memory. For account-deletion help, contact support.',
        ),
        const SizedBox(height: SentIQSpacing.xl),
        Text('Support', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: SentIQSpacing.xs),
        const Text('For account, privacy, file, or chat help, email our team.'),
        const SizedBox(height: SentIQSpacing.md),
        SentIQButton(
          label: 'Email support',
          expand: true,
          onPressed: () => unawaited(
            launchUrl(Uri(scheme: 'mailto', path: 'support@sentiqlabs.com')),
          ),
        ),
        if (!identity.isGuest) ...<Widget>[
          const SizedBox(height: SentIQSpacing.xl),
          SentIQButton(
            label: 'Sign out and clear local data',
            style: SentIQButtonStyle.secondary,
            expand: true,
            onPressed: () => _signOut(context, ref, controller),
          ),
        ],
      ],
    );
  }

  Future<void> _confirmClear(
    BuildContext context,
    AccountController controller,
  ) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('Clear data on this device?'),
        content: const Text(
          'Recent cached conversations and app preferences will be removed from this device. Cloud conversations and memories are not deleted.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton.tonal(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Clear device data'),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.clearDeviceData();
  }

  Future<void> _signOut(
    BuildContext context,
    WidgetRef ref,
    AccountController controller,
  ) async {
    await controller.clearDeviceData();
    await ref.read(authControllerProvider.notifier).signOut();
    if (context.mounted) {
      Navigator.of(context).popUntil((Route<dynamic> route) => route.isFirst);
    }
  }
}
