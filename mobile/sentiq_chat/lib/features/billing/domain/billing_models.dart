import 'dart:async';

enum BillingCheckoutOutcome { success, failure, dismissed }

class BillingQuotaMeter {
  const BillingQuotaMeter({
    required this.key,
    required this.label,
    required this.used,
    required this.limit,
    required this.remaining,
    this.resetAt,
    this.unit = 'count',
  });

  factory BillingQuotaMeter.fromJson(String key, Map<String, Object?> json) {
    final int limit = _integer(
      json['limit'] ?? json['token_limit'] ?? json['limit_tokens'],
    );
    final int used = _integer(
      json['used'] ?? json['tokens_consumed'] ?? json['used_tokens'],
    );
    return BillingQuotaMeter(
      key: key,
      label: json['label']?.toString() ?? _humanize(key),
      used: used,
      limit: limit,
      remaining: _integer(
        json['remaining'] ??
            json['tokens_remaining'] ??
            json['remaining_tokens'] ??
            (limit - used),
      ).clamp(0, limit <= 0 ? 1 << 30 : limit).toInt(),
      resetAt: _dateTime(
        json['reset_at'] ?? json['full_reset_at'] ?? json['next_recovery_at'],
      ),
      unit:
          json['unit']?.toString() ??
          (key.contains('text') ? 'tokens' : 'count'),
    );
  }

  final String key;
  final String label;
  final int used;
  final int limit;
  final int remaining;
  final DateTime? resetAt;
  final String unit;

  double get fraction => limit <= 0 ? 0 : (used / limit).clamp(0, 1).toDouble();
}

class BillingPlan {
  const BillingPlan({
    required this.code,
    required this.name,
    required this.description,
    required this.currency,
    required this.pricePaise,
    required this.interval,
    required this.sortOrder,
    this.quotas = const <BillingQuotaMeter>[],
  });

  factory BillingPlan.fromJson(Map<String, Object?> json) {
    final Map<String, Object?> entitlements = _map(json['entitlements']);
    final Map<String, Object?> quotas = _map(entitlements['quotas']);
    return BillingPlan(
      code: json['code']?.toString() ?? 'free',
      name:
          json['name']?.toString() ??
          _humanize(json['code']?.toString() ?? 'free'),
      description: json['description']?.toString() ?? '',
      currency: json['currency']?.toString() ?? 'INR',
      pricePaise: _integer(json['price_paise'] ?? json['pricePaise']),
      interval: json['interval']?.toString() ?? 'month',
      sortOrder: _integer(json['sort_order'] ?? json['sortOrder']),
      quotas: quotas.entries
          .map((MapEntry<String, Object?> entry) {
            return BillingQuotaMeter.fromJson(entry.key, _map(entry.value));
          })
          .toList(growable: false),
    );
  }

  final String code;
  final String name;
  final String description;
  final String currency;
  final int pricePaise;
  final String interval;
  final int sortOrder;
  final List<BillingQuotaMeter> quotas;

  bool get paid => code != 'free' && pricePaise > 0;
  double get priceRupees => pricePaise / 100;
}

class BillingSnapshot {
  const BillingSnapshot({
    this.mode = 'disabled',
    this.planCode = 'free',
    this.status = 'active',
    this.cancelAtPeriodEnd = false,
    this.currentPeriodEnd,
    this.quotas = const <BillingQuotaMeter>[],
  });

  factory BillingSnapshot.fromJson(Map<String, Object?> payload) {
    final Map<String, Object?> summary = _map(payload['summary']).isEmpty
        ? payload
        : _map(payload['summary']);
    final Map<String, Object?> quotaJson = _map(summary['quotas']);
    final List<BillingQuotaMeter> quotas = quotaJson.entries
        .map(
          (MapEntry<String, Object?> entry) =>
              BillingQuotaMeter.fromJson(entry.key, _map(entry.value)),
        )
        .toList();
    final Map<String, Object?> textAllowance = _map(summary['text_allowance']);
    if (textAllowance.isNotEmpty) {
      quotas.removeWhere(
        (BillingQuotaMeter meter) =>
            meter.key == 'premium_text' || meter.key == 'lite_text',
      );
      quotas.insert(
        0,
        BillingQuotaMeter.fromJson('text_allowance', textAllowance),
      );
    }
    return BillingSnapshot(
      mode: payload['mode']?.toString() ?? 'disabled',
      planCode: summary['plan_code']?.toString() ?? 'free',
      status: summary['status']?.toString() ?? 'active',
      cancelAtPeriodEnd:
          summary['cancel_at_period_end'] == true ||
          summary['cancelAtPeriodEnd'] == true,
      currentPeriodEnd: _dateTime(
        summary['current_period_end'] ?? summary['currentPeriodEnd'],
      ),
      quotas: quotas,
    );
  }

  final String mode;
  final String planCode;
  final String status;
  final bool cancelAtPeriodEnd;
  final DateTime? currentPeriodEnd;
  final List<BillingQuotaMeter> quotas;
}

class BillingCheckoutSession {
  const BillingCheckoutSession({
    required this.keyId,
    required this.subscriptionId,
    required this.planCode,
  });

  factory BillingCheckoutSession.fromJson(Map<String, Object?> json) {
    return BillingCheckoutSession(
      keyId: (json['key_id'] ?? json['keyId'] ?? '').toString(),
      subscriptionId: (json['subscription_id'] ?? json['subscriptionId'] ?? '')
          .toString(),
      planCode: (json['plan_code'] ?? json['planCode'] ?? '').toString(),
    );
  }

  final String keyId;
  final String subscriptionId;
  final String planCode;

  bool get valid => keyId.isNotEmpty && subscriptionId.isNotEmpty;
}

class BillingPaymentResult {
  const BillingPaymentResult({
    required this.outcome,
    this.paymentId,
    this.signature,
    this.message,
  });

  final BillingCheckoutOutcome outcome;
  final String? paymentId;
  final String? signature;
  final String? message;
}

class BillingState {
  const BillingState({
    this.plans = const <BillingPlan>[],
    this.snapshot = const BillingSnapshot(),
    this.loading = false,
    this.checkoutInProgress = false,
    this.cancelling = false,
    this.message,
  });

  final List<BillingPlan> plans;
  final BillingSnapshot snapshot;
  final bool loading;
  final bool checkoutInProgress;
  final bool cancelling;
  final String? message;

  BillingPlan? get currentPlan {
    for (final BillingPlan plan in plans) {
      if (plan.code == snapshot.planCode) return plan;
    }
    return null;
  }

  BillingState copyWith({
    List<BillingPlan>? plans,
    BillingSnapshot? snapshot,
    bool? loading,
    bool? checkoutInProgress,
    bool? cancelling,
    String? message,
    bool clearMessage = false,
  }) {
    return BillingState(
      plans: plans ?? this.plans,
      snapshot: snapshot ?? this.snapshot,
      loading: loading ?? this.loading,
      checkoutInProgress: checkoutInProgress ?? this.checkoutInProgress,
      cancelling: cancelling ?? this.cancelling,
      message: clearMessage ? null : message ?? this.message,
    );
  }
}

abstract interface class BillingCheckoutGateway {
  Future<BillingPaymentResult> open({
    required BillingCheckoutSession checkout,
    required BillingPlan plan,
    String? email,
  });
  Future<void> dispose();
}

Map<String, Object?> _map(Object? value) {
  if (value is! Map) return const <String, Object?>{};
  return value.map(
    (Object? key, Object? nested) => MapEntry(key.toString(), nested),
  );
}

int _integer(Object? value) => value is num ? value.toInt() : 0;

DateTime? _dateTime(Object? value) {
  final String text = value?.toString() ?? '';
  return text.isEmpty ? null : DateTime.tryParse(text)?.toLocal();
}

String _humanize(String value) {
  return value
      .replaceAll('_', ' ')
      .split(' ')
      .where((String word) => word.isNotEmpty)
      .map((String word) => '${word[0].toUpperCase()}${word.substring(1)}')
      .join(' ');
}
