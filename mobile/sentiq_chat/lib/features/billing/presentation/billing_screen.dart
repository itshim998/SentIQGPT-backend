import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:sentiq_chat/features/billing/application/billing_controller.dart';
import 'package:sentiq_chat/features/billing/domain/billing_models.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_empty_state.dart';

class BillingScreen extends ConsumerWidget {
  const BillingScreen({required this.identity, super.key});

  final AppIdentity identity;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final BillingState state = ref.watch(billingControllerProvider(identity));
    final BillingController controller = ref.read(
      billingControllerProvider(identity).notifier,
    );
    final SentIQPalette palette = context.sentiqPalette;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Plan and usage'),
        actions: <Widget>[
          IconButton(
            tooltip: 'Refresh plan and usage',
            onPressed: state.loading
                ? null
                : () => unawaited(controller.refresh()),
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: state.loading && state.plans.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: controller.refresh,
              child: ListView(
                padding: const EdgeInsets.all(SentIQSpacing.md),
                children: <Widget>[
                  _CurrentPlanCard(state: state),
                  if (state.message != null) ...<Widget>[
                    const SizedBox(height: SentIQSpacing.sm),
                    Material(
                      color: palette.info.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(14),
                      child: Padding(
                        padding: const EdgeInsets.all(SentIQSpacing.sm),
                        child: Text(state.message!),
                      ),
                    ),
                  ],
                  const SizedBox(height: SentIQSpacing.lg),
                  Text('Usage', style: Theme.of(context).textTheme.titleLarge),
                  const SizedBox(height: SentIQSpacing.sm),
                  if (state.snapshot.quotas.isEmpty)
                    const SentIQEmptyState(
                      icon: Icons.data_usage_outlined,
                      title: 'Usage details unavailable',
                      message: 'Pull down to refresh your current allowances.',
                    )
                  else
                    ...state.snapshot.quotas.map(
                      (BillingQuotaMeter meter) => Padding(
                        padding: const EdgeInsets.only(
                          bottom: SentIQSpacing.sm,
                        ),
                        child: _QuotaCard(meter: meter),
                      ),
                    ),
                  const SizedBox(height: SentIQSpacing.md),
                  Text(
                    'Compare plans',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: SentIQSpacing.sm),
                  ...state.plans.map(
                    (BillingPlan plan) => Padding(
                      padding: const EdgeInsets.only(bottom: SentIQSpacing.sm),
                      child: _PlanCard(
                        plan: plan,
                        current: plan.code == state.snapshot.planCode,
                        busy: state.checkoutInProgress,
                        onSubscribe: identity.isGuest
                            ? null
                            : () => unawaited(controller.subscribe(plan)),
                      ),
                    ),
                  ),
                  if (!identity.isGuest &&
                      state.snapshot.planCode != 'free') ...<Widget>[
                    const SizedBox(height: SentIQSpacing.md),
                    SentIQButton(
                      label: state.cancelling
                          ? 'Cancelling…'
                          : 'Cancel subscription',
                      style: SentIQButtonStyle.secondary,
                      expand: true,
                      onPressed: state.cancelling
                          ? null
                          : () => _confirmCancel(context, controller),
                    ),
                  ],
                  const SizedBox(height: SentIQSpacing.xl),
                ],
              ),
            ),
    );
  }

  Future<void> _confirmCancel(
    BuildContext context,
    BillingController controller,
  ) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('Cancel subscription?'),
        content: const Text(
          'Your current plan will remain available until the end of the paid billing period.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Keep plan'),
          ),
          FilledButton.tonal(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Cancel subscription'),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.cancelSubscription();
  }
}

class _CurrentPlanCard extends StatelessWidget {
  const _CurrentPlanCard({required this.state});

  final BillingState state;

  @override
  Widget build(BuildContext context) {
    final BillingPlan? plan = state.currentPlan;
    final String title = plan?.name ?? _humanize(state.snapshot.planCode);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(SentIQSpacing.md),
        child: Row(
          children: <Widget>[
            const CircleAvatar(child: Icon(Icons.workspace_premium_outlined)),
            const SizedBox(width: SentIQSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(title, style: Theme.of(context).textTheme.titleMedium),
                  Text(
                    state.snapshot.cancelAtPeriodEnd
                        ? 'Ends after the current billing period'
                        : _humanize(state.snapshot.status),
                  ),
                  if (state.snapshot.currentPeriodEnd != null)
                    Text(
                      'Current period ends ${MaterialLocalizations.of(context).formatMediumDate(state.snapshot.currentPeriodEnd!)}',
                      style: Theme.of(context).textTheme.bodySmall,
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

class _QuotaCard extends StatelessWidget {
  const _QuotaCard({required this.meter});

  final BillingQuotaMeter meter;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(SentIQSpacing.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(child: Text(meter.label)),
                Text('${meter.remaining} remaining'),
              ],
            ),
            const SizedBox(height: SentIQSpacing.xs),
            LinearProgressIndicator(value: meter.fraction),
            const SizedBox(height: 6),
            Text(
              '${meter.used} of ${meter.limit} ${meter.unit}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  const _PlanCard({
    required this.plan,
    required this.current,
    required this.busy,
    required this.onSubscribe,
  });

  final BillingPlan plan;
  final bool current;
  final bool busy;
  final VoidCallback? onSubscribe;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(SentIQSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    plan.name,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                if (current) const Chip(label: Text('Current')),
              ],
            ),
            if (plan.description.isNotEmpty) Text(plan.description),
            const SizedBox(height: SentIQSpacing.xs),
            Text(
              plan.paid
                  ? '₹${plan.priceRupees.toStringAsFixed(plan.pricePaise % 100 == 0 ? 0 : 2)} / ${plan.interval}'
                  : 'Free',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: SentIQSpacing.xs),
            ...plan.quotas
                .take(5)
                .map(
                  (BillingQuotaMeter quota) => Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Row(
                      children: <Widget>[
                        const Icon(Icons.check_rounded, size: 16),
                        const SizedBox(width: 6),
                        Expanded(child: Text('${quota.label}: ${quota.limit}')),
                      ],
                    ),
                  ),
                ),
            if (plan.paid && !current) ...<Widget>[
              const SizedBox(height: SentIQSpacing.md),
              SentIQButton(
                label: busy ? 'Opening checkout…' : 'Choose ${plan.name}',
                expand: true,
                onPressed: busy ? null : onSubscribe,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

String _humanize(String value) {
  return value
      .replaceAll('_', ' ')
      .split(' ')
      .where((String word) => word.isNotEmpty)
      .map((String word) => '${word[0].toUpperCase()}${word.substring(1)}')
      .join(' ');
}
