import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/features/billing/data/billing_repository.dart';
import 'package:sentiq_chat/features/billing/domain/billing_models.dart';

class BillingController extends StateNotifier<BillingState> {
  BillingController({
    required BillingGateway repository,
    required BillingCheckoutGateway checkoutGateway,
    this.email,
  }) : _repository = repository,
       _checkoutGateway = checkoutGateway,
       super(const BillingState());

  final BillingGateway _repository;
  final BillingCheckoutGateway _checkoutGateway;
  final String? email;
  bool _disposed = false;

  Future<void> initialize() => refresh();

  Future<void> refresh() async {
    state = state.copyWith(loading: true, clearMessage: true);
    try {
      final List<BillingPlan> plans = await _repository.plans();
      final BillingSnapshot snapshot = await _repository.snapshot();
      if (!_disposed) {
        state = state.copyWith(
          plans: plans,
          snapshot: snapshot,
          loading: false,
        );
      }
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(loading: false, message: _message(error));
      }
    }
  }

  Future<void> refreshUsage() async {
    try {
      final BillingSnapshot usage = await _repository.usage();
      if (!_disposed) {
        state = state.copyWith(snapshot: usage, clearMessage: true);
      }
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(message: _message(error));
      }
    }
  }

  Future<bool> subscribe(BillingPlan plan) async {
    if (!plan.paid || state.checkoutInProgress) return false;
    state = state.copyWith(checkoutInProgress: true, clearMessage: true);
    try {
      final BillingCheckoutSession checkout = await _repository.checkout(
        plan.code,
      );
      if (!checkout.valid) {
        throw Exception('Checkout is unavailable right now.');
      }
      final BillingPaymentResult payment = await _checkoutGateway.open(
        checkout: checkout,
        plan: plan,
        email: email,
      );
      switch (payment.outcome) {
        case BillingCheckoutOutcome.dismissed:
          if (!_disposed) {
            state = state.copyWith(
              checkoutInProgress: false,
              message: payment.message ?? 'Checkout was closed.',
            );
          }
          return false;
        case BillingCheckoutOutcome.failure:
          throw Exception(payment.message ?? 'Payment could not be completed.');
        case BillingCheckoutOutcome.success:
          final String paymentId = payment.paymentId ?? '';
          final String signature = payment.signature ?? '';
          if (paymentId.isEmpty || signature.isEmpty) {
            throw Exception('Payment confirmation was incomplete.');
          }
          final bool verified = await _repository.verify(
            paymentId: paymentId,
            subscriptionId: checkout.subscriptionId,
            signature: signature,
          );
          if (!verified) throw Exception('Payment could not be verified.');
          await refresh();
          if (!_disposed) {
            state = state.copyWith(
              checkoutInProgress: false,
              message: '${plan.name} is now active.',
            );
          }
          return true;
      }
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(
          checkoutInProgress: false,
          message: _message(error),
        );
      }
      return false;
    }
  }

  Future<bool> cancelSubscription() async {
    if (state.cancelling || state.snapshot.planCode == 'free') return false;
    state = state.copyWith(cancelling: true, clearMessage: true);
    try {
      final bool cancelled = await _repository.cancel();
      await refresh();
      if (!_disposed) {
        state = state.copyWith(
          cancelling: false,
          message: cancelled
              ? 'Your subscription will end after the current billing period.'
              : 'The subscription could not be cancelled.',
        );
      }
      return cancelled;
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(cancelling: false, message: _message(error));
      }
      return false;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _checkoutGateway.dispose();
    super.dispose();
  }
}

String _message(Object error) {
  final String text = error.toString();
  return text.startsWith('Exception: ') ? text.substring(11) : text;
}
