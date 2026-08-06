import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/auth/application/auth_controller.dart';
import 'package:sentiq_chat/features/auth/presentation/auth_flow_screen.dart';

import '../support/auth_fakes.dart';

void main() {
  testWidgets('keyboard, rotation, and Android back keep auth navigation stable', (
    WidgetTester tester,
  ) async {
    final FakeAuthGateway gateway = FakeAuthGateway();
    final AuthController controller = AuthController(
      gateway: gateway,
      profileRepository: FakeProfileRepository(),
    );
    await controller.initialize();

    Widget appFor(MediaQueryData mediaQuery) {
      return ProviderScope(
        overrides: <Override>[
          authControllerProvider.overrideWith((Ref ref) => controller),
        ],
        child: MaterialApp(
          theme: SentIQTheme.light(),
          home: MediaQuery(
            data: mediaQuery,
            child: const AuthFlowScreen(),
          ),
        ),
      );
    }

    // Enter the credentials page before simulating an open keyboard. This
    // mirrors the real interaction order and avoids tapping an obscured
    // welcome-screen control.
    await tester.pumpWidget(
      appFor(const MediaQueryData(size: Size(360, 640))),
    );
    final Finder signInButton = find.widgetWithText(FilledButton, 'Sign in');
    await tester.ensureVisible(signInButton);
    await tester.tap(signInButton);
    await tester.pumpAndSettle();
    expect(find.text('Welcome back'), findsOneWidget);

    // The active form must remain usable while the keyboard occupies the
    // lower portion of a compact phone.
    await tester.pumpWidget(
      appFor(
        const MediaQueryData(
          size: Size(360, 640),
          viewInsets: EdgeInsets.only(bottom: 280),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Welcome back'), findsOneWidget);
    expect(find.text('Email'), findsOneWidget);
    expect(tester.takeException(), isNull);

    // Rotating into a wide layout must preserve the current auth page.
    await tester.pumpWidget(
      appFor(const MediaQueryData(size: Size(820, 460))),
    );
    await tester.pumpAndSettle();
    expect(find.text('Welcome back'), findsOneWidget);
    expect(tester.takeException(), isNull);

    // Android back returns to the welcome page instead of exiting from a
    // nested authentication step.
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('A calmer place to think.'), findsOneWidget);

    controller.dispose();
    await gateway.close();
  });
}
