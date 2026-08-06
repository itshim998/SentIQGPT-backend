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
    "mobile/sentiq_chat/lib/features/live/application/live_controller.dart",
    "if (!_disposed) state = state.copyWith(status: status, clearMessage: true);",
    """if (!_disposed) {
        state = state.copyWith(status: status, clearMessage: true);
      }""",
)

print("Applied five asserted Phase 5 analyzer corrections.")
