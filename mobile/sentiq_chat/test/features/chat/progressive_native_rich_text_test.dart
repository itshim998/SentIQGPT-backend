import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/chat/presentation/progressive_native_rich_text.dart';

void main() {
  testWidgets('coalesced response remains visibly progressive', (
    WidgetTester tester,
  ) async {
    String data = '';
    bool streaming = true;
    late StateSetter update;

    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: Scaffold(
          body: StatefulBuilder(
            builder: (BuildContext context, StateSetter setState) {
              update = setState;
              return Padding(
                padding: const EdgeInsets.all(16),
                child: ProgressiveNativeRichText(
                  data: data,
                  streaming: streaming,
                ),
              );
            },
          ),
        ),
      ),
    );

    expect(
      find.bySemanticsLabel('Response is still being written'),
      findsOneWidget,
    );

    update(() {
      data = '**One** two three four five six seven eight ';
      streaming = false;
    });
    await tester.pump();

    // A buffered/final network delivery must not make the whole answer appear
    // in the same frame. The breathing indicator stays alive while received
    // text is being revealed word-by-word.
    expect(
      find.bySemanticsLabel('Response is still being written'),
      findsOneWidget,
    );
    expect(find.text('eight'), findsNothing);

    await tester.pump(const Duration(milliseconds: 30));
    expect(find.text('One'), findsOneWidget);
    expect(
      find.bySemanticsLabel('Response is still being written'),
      findsOneWidget,
    );

    await tester.pump(const Duration(seconds: 1));
    expect(find.textContaining('eight'), findsOneWidget);
    expect(
      find.bySemanticsLabel('Response is still being written'),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('completed historical content paints immediately', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: const Scaffold(
          body: Padding(
            padding: EdgeInsets.all(16),
            child: ProgressiveNativeRichText(
              data: 'Already complete',
            ),
          ),
        ),
      ),
    );

    expect(find.text('Already complete'), findsOneWidget);
    expect(
      find.bySemanticsLabel('Response is still being written'),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });
}
