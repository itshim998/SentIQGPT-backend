import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';

class SentIQTextField extends StatefulWidget {
  const SentIQTextField({
    required this.label,
    this.controller,
    this.hint,
    this.helper,
    this.errorText,
    this.prefixIcon,
    this.suffixIcon,
    this.obscureText = false,
    this.maxLines = 1,
    this.keyboardType,
    this.textInputAction,
    this.autofillHints,
    this.onChanged,
    this.onSubmitted,
    this.enabled = true,
    super.key,
  });

  final String label;
  final TextEditingController? controller;
  final String? hint;
  final String? helper;
  final String? errorText;
  final IconData? prefixIcon;
  final Widget? suffixIcon;
  final bool obscureText;
  final int maxLines;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final Iterable<String>? autofillHints;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool enabled;

  @override
  State<SentIQTextField> createState() => _SentIQTextFieldState();
}

class _SentIQTextFieldState extends State<SentIQTextField> {
  bool _passwordVisible = false;

  @override
  void didUpdateWidget(covariant SentIQTextField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.obscureText && _passwordVisible) {
      _passwordVisible = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    final OutlineInputBorder border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(SentIQRadii.medium),
      borderSide: BorderSide(color: palette.glassBorder),
    );
    final bool obscured = widget.obscureText && !_passwordVisible;
    final Widget? suffix = widget.suffixIcon ??
        (widget.obscureText
            ? IconButton(
                tooltip: obscured ? 'Show password' : 'Hide password',
                onPressed: widget.enabled
                    ? () => setState(() => _passwordVisible = !_passwordVisible)
                    : null,
                icon: Icon(
                  obscured
                      ? Icons.visibility_outlined
                      : Icons.visibility_off_outlined,
                ),
              )
            : null);
    return TextField(
      controller: widget.controller,
      obscureText: obscured,
      maxLines: widget.obscureText ? 1 : widget.maxLines,
      keyboardType: widget.keyboardType,
      textInputAction: widget.textInputAction,
      autofillHints: widget.autofillHints,
      onChanged: widget.onChanged,
      onSubmitted: widget.onSubmitted,
      enabled: widget.enabled,
      decoration: InputDecoration(
        labelText: widget.label,
        hintText: widget.hint,
        helperText: widget.helper,
        errorText: widget.errorText,
        prefixIcon: widget.prefixIcon == null ? null : Icon(widget.prefixIcon),
        suffixIcon: suffix,
        filled: true,
        fillColor: palette.glass,
        border: border,
        enabledBorder: border,
        focusedBorder: border.copyWith(
          borderSide: BorderSide(color: palette.accent, width: 1.4),
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: SentIQSpacing.md,
          vertical: SentIQSpacing.sm,
        ),
      ),
    );
  }
}
