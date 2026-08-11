import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show SelectedContent;
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/core/performance/performance_policy.dart';
import 'package:sentiq_chat/core/security/safe_external_link.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';

const String _streamMarker = '\uE000';

class NativeRichText extends StatelessWidget {
  const NativeRichText({
    required this.data,
    this.citations = const <ChatCitation>[],
    this.onSelectionChanged,
    this.streaming = false,
    super.key,
  });

  final String data;
  final List<ChatCitation> citations;
  final ValueChanged<String>? onSelectionChanged;
  final bool streaming;

  @override
  Widget build(BuildContext context) {
    final List<_RichSegment> segments = _splitSegments(data);
    final int lastMarkdownIndex = segments.lastIndexWhere(
      (_RichSegment segment) => segment.markdown.trim().isNotEmpty,
    );
    final bool trailingMarkdown =
        lastMarkdownIndex >= 0 && lastMarkdownIndex == segments.length - 1;
    return SelectionArea(
      onSelectionChanged: (SelectedContent? content) {
        onSelectionChanged?.call(content?.plainText ?? '');
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          for (final MapEntry<int, _RichSegment> entry
              in segments.asMap().entries)
            if (entry.value.code != null)
              _CodeBlock(
                language: entry.value.language,
                code: entry.value.code!,
              )
            else if (entry.value.math != null)
              _MathBlock(expression: entry.value.math!)
            else if (entry.value.markdown.trim().isNotEmpty)
              MarkdownBody(
                // Markdown is parsed on every streamed update. The marker is
                // an inline widget, so emphasis/headings/lists remain native
                // while the response grows word-by-word.
                data:
                    streaming && entry.key == lastMarkdownIndex
                        ? '${entry.value.markdown}$_streamMarker'
                        : entry.value.markdown,
                selectable: false,
                softLineBreak: true,
                extensionSet: md.ExtensionSet(
                  <md.BlockSyntax>[
                    ...md.ExtensionSet.gitHubFlavored.blockSyntaxes,
                  ],
                  <md.InlineSyntax>[
                    _StreamingMarkerSyntax(),
                    _InlineMathSyntax(),
                    ...md.ExtensionSet.gitHubFlavored.inlineSyntaxes,
                  ],
                ),
                builders: <String, MarkdownElementBuilder>{
                  _InlineMathSyntax.tag: _InlineMathBuilder(),
                  _StreamingMarkerSyntax.tag: _StreamingMarkerBuilder(),
                },
                styleSheet: _styleSheet(context),
                onTapLink: (String text, String? href, String title) {
                  if (href == null) return;
                  unawaited(SafeExternalLink.openHttps(href));
                },
              ),
          if (streaming && !trailingMarkdown)
            const Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: EdgeInsets.only(top: 6),
                child: _BreathingStreamCaret(),
              ),
            ),
          if (citations.isNotEmpty) ...<Widget>[
            const SizedBox(height: SentIQSpacing.sm),
            Wrap(
              spacing: SentIQSpacing.xs,
              runSpacing: SentIQSpacing.xs,
              children: citations
                  .asMap()
                  .entries
                  .map(
                    (MapEntry<int, ChatCitation> entry) =>
                        _CitationChip(citation: entry.value, index: entry.key),
                  )
                  .toList(),
            ),
          ],
        ],
      ),
    );
  }
}

class _StreamingMarkerSyntax extends md.InlineSyntax {
  _StreamingMarkerSyntax() : super(RegExp.escape(_streamMarker));

  static const String tag = 'sentiq-stream-marker';

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    parser.addNode(md.Element.empty(tag));
    return true;
  }
}

class _StreamingMarkerBuilder extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    return const Padding(
      padding: EdgeInsets.only(left: 3),
      child: _BreathingStreamCaret(),
    );
  }
}

class _BreathingStreamCaret extends StatefulWidget {
  const _BreathingStreamCaret();

  @override
  State<_BreathingStreamCaret> createState() => _BreathingStreamCaretState();
}

class _BreathingStreamCaretState extends State<_BreathingStreamCaret>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1050),
  );
  bool _reduceMotion = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final bool reduce = SentIQPerformancePolicy.reduceMotion(context);
    if (reduce == _reduceMotion && (_controller.isAnimating || reduce)) return;
    _reduceMotion = reduce;
    if (reduce) {
      _controller
        ..stop()
        ..value = 1;
    } else {
      _controller.repeat(reverse: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    final Widget caret = Container(
      width: 7,
      height: 17,
      decoration: BoxDecoration(
        color: palette.accent,
        borderRadius: BorderRadius.circular(999),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: palette.accent.withValues(alpha: 0.34),
            blurRadius: 10,
            spreadRadius: 1,
          ),
        ],
      ),
    );
    final Widget animated = _reduceMotion
        ? caret
        : AnimatedBuilder(
            animation: _controller,
            child: caret,
            builder: (BuildContext context, Widget? child) {
              final double eased = Curves.easeInOutCubic.transform(
                _controller.value,
              );
              return Opacity(
                opacity: 0.38 + (0.62 * eased),
                child: Transform.scale(
                  scale: 0.86 + (0.14 * eased),
                  alignment: Alignment.center,
                  child: child,
                ),
              );
            },
          );
    return Semantics(
      label: 'Response is still being written',
      child: animated,
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }
}

class _InlineMathSyntax extends md.InlineSyntax {
  _InlineMathSyntax() : super(r'\$([^\n$]+?)\$');

  static const String tag = 'sentiq-inline-math';

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    parser.addNode(md.Element.text(tag, match.group(1) ?? ''));
    return true;
  }
}

class _InlineMathBuilder extends MarkdownElementBuilder {
  _InlineMathBuilder();

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final SentIQPalette palette = context.sentiqPalette;
    final String expression = element.textContent.trim();
    return Math.tex(
      expression,
      mathStyle: MathStyle.text,
      textStyle: preferredStyle ?? parentStyle,
      onErrorFallback: (FlutterMathException error) => Text(
        expression,
        style: (preferredStyle ?? parentStyle)?.copyWith(
          fontFamily: 'monospace',
          color: palette.textSecondary,
        ),
      ),
    );
  }
}

class _CitationChip extends StatelessWidget {
  const _CitationChip({required this.citation, required this.index});

  final ChatCitation citation;
  final int index;

  @override
  Widget build(BuildContext context) {
    final String label = citation.title?.trim().isNotEmpty == true
        ? citation.title!
        : 'Source ${index + 1}';
    return ActionChip(
      avatar: const Icon(Icons.link_rounded, size: 15),
      label: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
      onPressed: citation.url == null
          ? null
          : () {
              unawaited(SafeExternalLink.openHttps(citation.url));
            },
    );
  }
}

class _MathBlock extends StatelessWidget {
  const _MathBlock({required this.expression});

  final String expression;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: SentIQSpacing.xs),
      padding: const EdgeInsets.symmetric(
        horizontal: SentIQSpacing.sm,
        vertical: SentIQSpacing.md,
      ),
      decoration: BoxDecoration(
        color: palette.surfaceElevated.withValues(alpha: 0.6),
        border: Border.all(color: palette.glassBorder),
        borderRadius: BorderRadius.circular(14),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Math.tex(
          expression.trim(),
          mathStyle: MathStyle.display,
          textStyle: Theme.of(context).textTheme.bodyLarge,
          onErrorFallback: (FlutterMathException error) => Text(
            expression.trim(),
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              fontFamily: 'monospace',
              color: palette.textSecondary,
            ),
          ),
        ),
      ),
    );
  }
}

class _CodeBlock extends StatelessWidget {
  const _CodeBlock({required this.language, required this.code});

  final String? language;
  final String code;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: SentIQSpacing.xs),
      decoration: BoxDecoration(
        color: palette.surfaceElevated,
        border: Border.all(color: palette.glassBorder),
        borderRadius: BorderRadius.circular(16),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(SentIQSpacing.sm, 6, 4, 4),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    language?.trim().isNotEmpty == true ? language! : 'Code',
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: palette.textSecondary,
                    ),
                  ),
                ),
                IconButton(
                  visualDensity: VisualDensity.compact,
                  tooltip: 'Copy code',
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: code));
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Code copied')),
                    );
                  },
                  icon: const Icon(Icons.copy_rounded, size: 18),
                ),
              ],
            ),
          ),
          Divider(height: 1, color: palette.glassBorder),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.all(SentIQSpacing.sm),
            child: Text(
              code,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                fontFamily: 'monospace',
                height: 1.55,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

MarkdownStyleSheet _styleSheet(BuildContext context) {
  final ThemeData theme = Theme.of(context);
  final SentIQPalette palette = context.sentiqPalette;
  return MarkdownStyleSheet.fromTheme(theme).copyWith(
    p: theme.textTheme.bodyLarge?.copyWith(height: 1.55),
    h1: theme.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w600),
    h2: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600),
    h3: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
    blockquote: theme.textTheme.bodyLarge?.copyWith(
      color: palette.textSecondary,
      height: 1.5,
    ),
    blockquoteDecoration: BoxDecoration(
      border: Border(left: BorderSide(color: palette.accent, width: 3)),
      color: palette.surfaceElevated.withValues(alpha: 0.55),
      borderRadius: BorderRadius.circular(8),
    ),
    tableBorder: TableBorder.all(color: palette.glassBorder),
    tableHead: theme.textTheme.labelLarge,
    tableBody: theme.textTheme.bodyMedium,
    tableCellsPadding: const EdgeInsets.all(SentIQSpacing.xs),
    a: theme.textTheme.bodyLarge?.copyWith(
      color: palette.accent,
      decoration: TextDecoration.underline,
    ),
    code: theme.textTheme.bodyMedium?.copyWith(
      fontFamily: 'monospace',
      color: palette.textPrimary,
      backgroundColor: palette.surfaceElevated,
    ),
  );
}

class _RichSegment {
  const _RichSegment.markdown(this.markdown)
    : code = null,
      language = null,
      math = null;

  const _RichSegment.code({required this.code, this.language})
    : markdown = '',
      math = null;

  const _RichSegment.math(this.math)
    : markdown = '',
      code = null,
      language = null;

  final String markdown;
  final String? code;
  final String? language;
  final String? math;
}

List<_RichSegment> _splitSegments(String value) {
  final RegExp richBlock = RegExp(
    r'```([^\n`]*)\n([\s\S]*?)```|\$\$([\s\S]*?)\$\$',
  );
  final List<_RichSegment> output = <_RichSegment>[];
  int cursor = 0;
  for (final RegExpMatch match in richBlock.allMatches(value)) {
    if (match.start > cursor) {
      output.add(_RichSegment.markdown(value.substring(cursor, match.start)));
    }
    final String? code = match.group(2);
    if (code != null) {
      output.add(
        _RichSegment.code(language: match.group(1)?.trim(), code: code),
      );
    } else {
      output.add(_RichSegment.math(match.group(3) ?? ''));
    }
    cursor = match.end;
  }
  if (cursor < value.length) {
    output.add(_RichSegment.markdown(value.substring(cursor)));
  }
  if (output.isEmpty) output.add(_RichSegment.markdown(value));
  return output;
}
