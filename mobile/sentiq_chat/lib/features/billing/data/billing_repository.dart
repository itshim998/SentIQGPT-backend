import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/api_endpoints.dart';
import 'package:sentiq_chat/features/billing/domain/billing_models.dart';

abstract interface class BillingGateway {
  Future<List<BillingPlan>> plans();
  Future<BillingSnapshot> snapshot();
  Future<BillingSnapshot> usage();
  Future<BillingCheckoutSession> checkout(String planCode);
  Future<bool> verify({
    required String paymentId,
    required String subscriptionId,
    required String signature,
  });
  Future<bool> cancel();
}

class BillingRepository implements BillingGateway {
  const BillingRepository(this._client);

  final SentIQApiClient _client;

  @override
  Future<List<BillingPlan>> plans() async {
    final Map<String, Object?> payload = await _client.getJson(
      ApiEndpoints.billingPlans,
    );
    final Object? raw = payload['plans'];
    if (raw is! List) return const <BillingPlan>[];
    final List<BillingPlan> result = raw.whereType<Map>().map((Map item) {
      return BillingPlan.fromJson(
        item.map(
          (Object? key, Object? value) => MapEntry(key.toString(), value),
        ),
      );
    }).toList();
    result.sort(
      (BillingPlan a, BillingPlan b) => a.sortOrder.compareTo(b.sortOrder),
    );
    return result;
  }

  @override
  Future<BillingSnapshot> snapshot() async {
    return BillingSnapshot.fromJson(
      await _client.getJson(ApiEndpoints.billingMe),
    );
  }

  @override
  Future<BillingSnapshot> usage() async {
    return BillingSnapshot.fromJson(
      await _client.getJson(ApiEndpoints.billingUsage),
    );
  }

  @override
  Future<BillingCheckoutSession> checkout(String planCode) async {
    final Map<String, Object?> payload = await _client.postJson(
      ApiEndpoints.billingCheckout,
      body: <String, Object?>{'plan_code': planCode},
    );
    final Object? raw = payload['checkout'];
    if (raw is! Map) {
      throw Exception(
        payload['message']?.toString() ?? 'Checkout is unavailable right now.',
      );
    }
    return BillingCheckoutSession.fromJson(
      raw.map((Object? key, Object? value) => MapEntry(key.toString(), value)),
    );
  }

  @override
  Future<bool> verify({
    required String paymentId,
    required String subscriptionId,
    required String signature,
  }) async {
    final Map<String, Object?> payload = await _client.postJson(
      ApiEndpoints.billingVerify,
      body: <String, Object?>{
        'razorpay_payment_id': paymentId,
        'razorpay_subscription_id': subscriptionId,
        'razorpay_signature': signature,
      },
    );
    return payload['verified'] == true;
  }

  @override
  Future<bool> cancel() async {
    final Map<String, Object?> payload = await _client.postJson(
      ApiEndpoints.billingCancel,
      body: const <String, Object?>{},
    );
    return payload['canceled'] == true;
  }
}
