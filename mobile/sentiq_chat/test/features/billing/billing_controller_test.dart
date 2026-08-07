import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/billing/application/billing_controller.dart';
import 'package:sentiq_chat/features/billing/data/billing_repository.dart';
import 'package:sentiq_chat/features/billing/domain/billing_models.dart';

void main() {
  const BillingPlan paidPlan = BillingPlan(
    code: 'plus',
    name: 'Plus',
    description: 'More usage',
    currency: 'INR',
    pricePaise: 25900,
    interval: 'month',
    sortOrder: 2,
  );

  test(
    'successful Razorpay result is verified and billing refreshes',
    () async {
      final _BillingFake repository = _BillingFake();
      final _CheckoutFake checkout = _CheckoutFake(
        const BillingPaymentResult(
          outcome: BillingCheckoutOutcome.success,
          paymentId: 'payment-1',
          signature: 'signature-1',
        ),
      );
      final BillingController controller = BillingController(
        repository: repository,
        checkoutGateway: checkout,
        email: 'user@example.com',
      );
      await controller.initialize();

      expect(await controller.subscribe(paidPlan), isTrue);
      expect(repository.verifyCount, 1);
      expect(repository.snapshotCount, 2);
      expect(controller.state.snapshot.planCode, 'plus');
      controller.dispose();
    },
  );

  test('checkout dismissal does not verify or change the plan', () async {
    final _BillingFake repository = _BillingFake();
    final BillingController controller = BillingController(
      repository: repository,
      checkoutGateway: _CheckoutFake(
        const BillingPaymentResult(
          outcome: BillingCheckoutOutcome.dismissed,
          message: 'Checkout was closed.',
        ),
      ),
    );
    await controller.initialize();

    expect(await controller.subscribe(paidPlan), isFalse);
    expect(repository.verifyCount, 0);
    expect(controller.state.snapshot.planCode, 'free');
    controller.dispose();
  });

  test('failed verification preserves the existing plan', () async {
    final _BillingFake repository = _BillingFake()..verifyResult = false;
    final BillingController controller = BillingController(
      repository: repository,
      checkoutGateway: _CheckoutFake(
        const BillingPaymentResult(
          outcome: BillingCheckoutOutcome.success,
          paymentId: 'payment-1',
          signature: 'bad-signature',
        ),
      ),
    );
    await controller.initialize();

    expect(await controller.subscribe(paidPlan), isFalse);
    expect(controller.state.snapshot.planCode, 'free');
    expect(controller.state.message, contains('verified'));
    controller.dispose();
  });

  test('usage and cancellation refresh the billing state', () async {
    final _BillingFake repository = _BillingFake()..currentPlan = 'plus';
    final BillingController controller = BillingController(
      repository: repository,
      checkoutGateway: _CheckoutFake(
        const BillingPaymentResult(outcome: BillingCheckoutOutcome.dismissed),
      ),
    );
    await controller.initialize();
    await controller.refreshUsage();
    expect(repository.usageCount, 1);
    expect(await controller.cancelSubscription(), isTrue);
    expect(repository.cancelCount, 1);
    controller.dispose();
  });
}

class _BillingFake implements BillingGateway {
  int snapshotCount = 0;
  int usageCount = 0;
  int verifyCount = 0;
  int cancelCount = 0;
  bool verifyResult = true;
  String currentPlan = 'free';

  @override
  Future<List<BillingPlan>> plans() async => const <BillingPlan>[
    BillingPlan(
      code: 'free',
      name: 'Free',
      description: 'Starter access',
      currency: 'INR',
      pricePaise: 0,
      interval: 'month',
      sortOrder: 1,
    ),
    BillingPlan(
      code: 'plus',
      name: 'Plus',
      description: 'More usage',
      currency: 'INR',
      pricePaise: 25900,
      interval: 'month',
      sortOrder: 2,
    ),
  ];

  @override
  Future<BillingSnapshot> snapshot() async {
    snapshotCount += 1;
    return BillingSnapshot(planCode: currentPlan);
  }

  @override
  Future<BillingSnapshot> usage() async {
    usageCount += 1;
    return BillingSnapshot(
      planCode: currentPlan,
      quotas: const <BillingQuotaMeter>[
        BillingQuotaMeter(
          key: 'image_generation',
          label: 'Images',
          used: 1,
          limit: 2,
          remaining: 1,
        ),
      ],
    );
  }

  @override
  Future<BillingCheckoutSession> checkout(String planCode) async {
    return BillingCheckoutSession(
      keyId: 'key',
      subscriptionId: 'subscription-1',
      planCode: planCode,
    );
  }

  @override
  Future<bool> verify({
    required String paymentId,
    required String subscriptionId,
    required String signature,
  }) async {
    verifyCount += 1;
    if (verifyResult) currentPlan = 'plus';
    return verifyResult;
  }

  @override
  Future<bool> cancel() async {
    cancelCount += 1;
    currentPlan = 'free';
    return true;
  }
}

class _CheckoutFake implements BillingCheckoutGateway {
  _CheckoutFake(this.result);

  final BillingPaymentResult result;

  @override
  Future<BillingPaymentResult> open({
    required BillingCheckoutSession checkout,
    required BillingPlan plan,
    String? email,
  }) async => result;

  @override
  Future<void> dispose() async {}
}
