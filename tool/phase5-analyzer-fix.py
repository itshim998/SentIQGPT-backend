from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    source = target.read_text(encoding="utf-8")
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old!r}")
    target.write_text(source.replace(old, new, 1), encoding="utf-8")


def wrap_single_statement_ifs(path: str, expected: int) -> None:
    target = ROOT / path
    lines = target.read_text(encoding="utf-8").splitlines(keepends=True)
    output: list[str] = []
    wrapped = 0
    index = 0

    while index < len(lines):
        line = lines[index]
        stripped = line.lstrip()
        indent = line[: len(line) - len(stripped)]

        if stripped.startswith("if (") and "{" not in stripped:
            balance = 0
            condition_end = index
            started = False
            while condition_end < len(lines):
                for character in lines[condition_end]:
                    if character == "(":
                        balance += 1
                        started = True
                    elif character == ")":
                        balance -= 1
                if started and balance == 0:
                    break
                condition_end += 1

            statement_index = condition_end + 1
            while statement_index < len(lines) and not lines[statement_index].strip():
                statement_index += 1

            if condition_end < len(lines) and statement_index < len(lines):
                condition_tail = lines[condition_end].rstrip("\n")
                statement = lines[statement_index].strip()
                statement_indent = lines[statement_index][
                    : len(lines[statement_index]) - len(lines[statement_index].lstrip())
                ]
                if (
                    condition_tail.rstrip().endswith(")")
                    and statement_indent.startswith(indent)
                    and len(statement_indent) > len(indent)
                    and statement.endswith(";")
                    and not statement.startswith("{")
                ):
                    output.extend(lines[index:condition_end])
                    output.append(f"{condition_tail} {{\n")
                    output.extend(lines[condition_end + 1 : statement_index + 1])
                    output.append(f"{indent}}}\n")
                    wrapped += 1
                    index = statement_index + 1
                    continue

        output.append(line)
        index += 1

    if wrapped != expected:
        raise SystemExit(f"Expected {expected} unbraced if statements in {path}, wrapped {wrapped}")
    target.write_text("".join(output), encoding="utf-8")


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

wrap_single_statement_ifs(
    "mobile/sentiq_chat/lib/features/billing/application/billing_controller.dart",
    expected=2,
)
wrap_single_statement_ifs(
    "mobile/sentiq_chat/lib/features/live/application/live_controller.dart",
    expected=1,
)

print("Applied asserted Phase 5 analyzer corrections.")
