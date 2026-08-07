from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    source = target.read_text(encoding="utf-8")
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old!r}")
    target.write_text(source.replace(old, new, 1), encoding="utf-8")


replace_once(
    "mobile/sentiq_chat/lib/features/account/presentation/account_screen.dart",
    "? const ListView(\n              children: <Widget>[",
    "? ListView(\n              children: const <Widget>[",
)
replace_once(
    "mobile/sentiq_chat/lib/features/live/presentation/live_screen.dart",
    """unawaited(controller.end(reason: 'navigation').then((_) {
            if (mounted) Navigator.of(context).pop();
          }));""",
    """final NavigatorState navigator = Navigator.of(context);
          unawaited(controller.end(reason: 'navigation').then((_) {
            if (mounted) navigator.pop();
          }));""",
)
replace_once(
    "mobile/sentiq_chat/lib/features/billing/application/billing_controller.dart",
    "if (!_disposed) state = state.copyWith(snapshot: usage, clearMessage: true);",
    """if (!_disposed) {
        state = state.copyWith(snapshot: usage, clearMessage: true);
      }""",
)
replace_once(
    "mobile/sentiq_chat/lib/features/billing/application/billing_controller.dart",
    "if (!_disposed) state = state.copyWith(message: _message(error));",
    """if (!_disposed) {
        state = state.copyWith(message: _message(error));
      }""",
)
replace_once(
    "mobile/sentiq_chat/lib/features/billing/application/billing_controller.dart",
    "if (!checkout.valid) throw Exception('Checkout is unavailable right now.');",
    """if (!checkout.valid) {
        throw Exception('Checkout is unavailable right now.');
      }""",
)
replace_once(
    "mobile/sentiq_chat/lib/features/live/application/live_controller.dart",
    "if (!_disposed) state = state.copyWith(status: status, clearMessage: true);",
    """if (!_disposed) {
        state = state.copyWith(status: status, clearMessage: true);
      }""",
)
replace_once(
    "mobile/sentiq_chat/lib/features/account/application/account_controller.dart",
    "final List<AccountMemory> memories = await _repository.memories();",
    """final List<AccountMemory> memories = List<AccountMemory>.of(
        await _repository.memories(),
      );""",
)
replace_once(
    "mobile/sentiq_chat/lib/features/research/application/deep_research_controller.dart",
    """    if (reportJson != null) {
      final DeepResearchReport report = DeepResearchReport.fromJson(reportJson);
      state = state.copyWith(
        report: report,
        streamConnected: !report.isTerminal,
        clearMessage: true,
      );""",
    """    if (reportJson != null) {
      final DeepResearchReport incoming = DeepResearchReport.fromJson(reportJson);
      final DeepResearchReport? existing = state.report;
      final DeepResearchReport report = incoming.copyWith(
        sources: incoming.sources.isEmpty ? existing?.sources : incoming.sources,
        partialContent: incoming.partialContent.isEmpty
            ? existing?.partialContent
            : incoming.partialContent,
      );
      state = state.copyWith(
        report: report,
        streamConnected: !report.isTerminal,
        clearMessage: true,
      );""",
)
replace_once(
    "mobile/sentiq_chat/test/features/live/live_controller_test.dart",
    """    audio.emit(const LiveAudioEvent(type: 'interruptionBegan'));
    expect(controller.state.connection, LiveConnectionState.suspended);""",
    """    audio.emit(const LiveAudioEvent(type: 'interruptionBegan'));
    await Future<void>.delayed(Duration.zero);
    expect(controller.state.connection, LiveConnectionState.suspended);""",
)
replace_once(
    "backend/testSentIQLive.ts",
    '  const audioModuleUrl = `data:text/javascript;base64,${Buffer.from(audioProtocol).toString("base64")}`;',
    '''  const isolatedAudioProtocol = audioProtocol.replace(
    'import { emitLivePcmLevel } from "./live-audio-visual-state.mjs";',
    "const emitLivePcmLevel = () => {};",
  );
  assert.notEqual(
    isolatedAudioProtocol,
    audioProtocol,
    "the audio protocol fixture should isolate the visual-level hook",
  );
  const audioModuleUrl = `data:text/javascript;base64,${Buffer.from(isolatedAudioProtocol).toString("base64")}`;''',
)

print("Applied ten asserted Phase 5 corrections.")
