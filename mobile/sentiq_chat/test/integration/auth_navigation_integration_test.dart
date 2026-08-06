import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/auth/application/auth_controller.dart';
import 'package:sentiq_chat/features/auth/presentation/auth_flow_screen.dart';

import '../support/auth_fakes.dart';

void main() {
  testWidgets(
    'keyboard, rotation, and Android back keep auth navigation stable',
    (WidgetTester tester) async {
      final FakeAuthGateway gateway = FakeAuthGateway();
      final AuthController controller = AuthController(
        gateway: gateway,
        profileRepository: FakeProfileRepository(),
      );
      await controller.initialize();

      final ValueNotifier<MediaQueryData> mediaQuery =
          ValueNotifier<MediaQueryData>(
            const MediaQueryData(size: Size(360, 640)),
          );
      addTearDown(mediaQuery.dispose);

      await tester.pumpWidget(
        ProviderScope(
          overrides: <Override>[
            authControllerProvider.overrideWith((Ref ref) => controller),
          ],
          child: MaterialApp(
            theme: SentIQTheme.light(),
            home: ValueListenableBuilder<MediaQueryData>(
              valueListenable: mediaQuery,
              builder:
                  (BuildContext context, MediaQueryData value, Widget? child) {
                    return MediaQuery(data: value, child: child!);
                  },
              child: const AuthFlowScreen(),
            ),
          ),
        ),
      );

      // Enter the credentials page before simulating an open keyboard. This
      // mirrors the real interaction order and avoids tapping an obscured
      // welcome-screen control.
      final Finder signInButton = find.widgetWithText(FilledButton, 'Sign in');
      await tester.ensureVisible(signInButton);
      await tester.tap(signInButton);
      await tester.pumpAndSettle();
      expect(find.text('Welcome back'), findsOneWidget);

      // The active form must remain usable while the keyboard occupies the
      // lower portion of a compact phone.
      mediaQuery.value = const MediaQueryData(
        size: Size(360, 640),
        viewInsets: EdgeInsets.only(bottom: 280),
      );
      await tester.pumpAndSettle();
      expect(find.text('Welcome back'), findsOneWidget);
      expect(find.text('Email'), findsOneWidget);
      expect(tester.takeException(), isNull);

      // Rotating into a wide layout must preserve the current auth page without
      // replacing the provider container or authentication controller.
      mediaQuery.value = const MediaQueryData(size: Size(820, 460));
      await tester.pumpAndSettle();
      expect(find.text('Welcome back'), findsOneWidget);
      expect(tester.takeException(), isNull);

      // Android back returns to the welcome page instead of exiting from a
      // nested authentication step.
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.text('A calmer place to think.'), findsOneWidget);

      // Let ProviderScope own and dispose the overridden controller once.
      await tester.pumpWidget(const SizedBox.shrink());
      await gateway.close();
    },
  );
}
