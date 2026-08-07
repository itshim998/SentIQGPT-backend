import 'dart:async';

import 'package:razorpay_flutter/razorpay_flutter.dart';
import 'package:sentiq_chat/features/billing/domain/billing_models.dart';

class RazorpayCheckoutGateway implements BillingCheckoutGateway {
  RazorpayCheckoutGateway({Razorpay? razorpay})
    : _razorpay = razorpay ?? Razorpay() {
    _razorpay.on(Razorpay.EVENT_PAYMENT_SUCCESS, _success);
    _razorpay.on(Razorpay.EVENT_PAYMENT_ERROR, _failure);
    _razorpay.on(Razorpay.EVENT_EXTERNAL_WALLET, _wallet);
  }

  final Razorpay _razorpay;
  Completer<BillingPaymentResult>? _pending;

  @override
  Future<BillingPaymentResult> open({
    required BillingCheckoutSession checkout,
    required BillingPlan plan,
    String? email,
  }) {
    if (_pending != null && !_pending!.isCompleted) {
      return Future<BillingPaymentResult>.value(
        const BillingPaymentResult(
          outcome: BillingCheckoutOutcome.failure,
          message: 'A checkout is already open.',
        ),
      );
    }
    final Completer<BillingPaymentResult> completer =
        Completer<BillingPaymentResult>();
    _pending = completer;
    _razorpay.open(<String, dynamic>{
      'key': checkout.keyId,
      'subscription_id': checkout.subscriptionId,
      'name': 'SentIQ Chat',
      'description': '${plan.name} plan',
      'prefill': <String, dynamic>{'email': ?email},
      'retry': const <String, dynamic>{'enabled': true, 'max_count': 2},
      'theme': const <String, dynamic>{'color': '#6D5CE7'},
    });
    return completer.future;
  }

  void _success(PaymentSuccessResponse response) {
    _complete(
      BillingPaymentResult(
        outcome: BillingCheckoutOutcome.success,
        paymentId: response.paymentId,
        signature: response.signature,
      ),
    );
  }

  void _failure(PaymentFailureResponse response) {
    final String message =
        response.message ?? 'Payment could not be completed.';
    final String normalized = message.toLowerCase();
    _complete(
      BillingPaymentResult(
        outcome: normalized.contains('cancel') || normalized.contains('dismiss')
            ? BillingCheckoutOutcome.dismissed
            : BillingCheckoutOutcome.failure,
        message: message,
      ),
    );
  }

  void _wallet(ExternalWalletResponse response) {
    _complete(
      BillingPaymentResult(
        outcome: BillingCheckoutOutcome.failure,
        message:
            '${response.walletName ?? 'External wallet'} is not supported for subscriptions.',
      ),
    );
  }

  void _complete(BillingPaymentResult result) {
    final Completer<BillingPaymentResult>? pending = _pending;
    if (pending == null || pending.isCompleted) return;
    pending.complete(result);
    _pending = null;
  }

  @override
  Future<void> dispose() async {
    final Completer<BillingPaymentResult>? pending = _pending;
    if (pending != null && !pending.isCompleted) {
      pending.complete(
        const BillingPaymentResult(
          outcome: BillingCheckoutOutcome.dismissed,
          message: 'Checkout was closed.',
        ),
      );
    }
    _pending = null;
    _razorpay.clear();
  }
}
