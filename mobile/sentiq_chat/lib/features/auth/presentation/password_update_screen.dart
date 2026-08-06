import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_brand_mark.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_text_field.dart';

class PasswordUpdateScreen extends ConsumerStatefulWidget {
  const PasswordUpdateScreen({super.key});

  @override
  ConsumerState<PasswordUpdateScreen> createState() =>
      _PasswordUpdateScreenState();
}

class _PasswordUpdateScreenState extends ConsumerState<PasswordUpdateScreen> {
  final TextEditingController _password = TextEditingController();
  final TextEditingController _confirmation = TextEditingController();
  String? _localError;

  @override
  void dispose() {
    _password.dispose();
    _confirmation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final AppAuthState state = ref.watch(authControllerProvider);
    final SentIQPalette palette = context.sentiqPalette;
    return Scaffold(
      resizeToAvoidBottomInset: true,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(
              SentIQSpacing.lg,
              SentIQSpacing.xxl,
              SentIQSpacing.lg,
              SentIQSpacing.xxl + MediaQuery.viewInsetsOf(context).bottom,
            ),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  const Align(
                    alignment: Alignment.centerLeft,
                    child: SentIQBrandMark(size: 58),
                  ),
                  const SizedBox(height: SentIQSpacing.lg),
                  Text(
                    'Choose a new password',
                    style: Theme.of(context).textTheme.headlineMedium,
                  ),
                  const SizedBox(height: SentIQSpacing.sm),
                  Text(
                    'Use at least 8 characters. Your other signed-in sessions may need to reconnect.',
                    style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                      color: palette.textSecondary,
                    ),
                  ),
                  const SizedBox(height: SentIQSpacing.xl),
                  RefractiveGlassSurface(
                    child: AutofillGroup(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          SentIQTextField(
                            label: 'New password',
                            controller: _password,
                            obscureText: true,
                            textInputAction: TextInputAction.next,
                            autofillHints: const <String>[
                              AutofillHints.newPassword,
                            ],
                            enabled: !state.busy,
                          ),
                          const SizedBox(height: SentIQSpacing.sm),
                          SentIQTextField(
                            label: 'Confirm password',
                            controller: _confirmation,
                            obscureText: true,
                            textInputAction: TextInputAction.done,
                            autofillHints: const <String>[
                              AutofillHints.newPassword,
                            ],
                            enabled: !state.busy,
                            onSubmitted: (_) => _save(),
                          ),
                          if (_localError != null ||
                              state.message != null) ...<Widget>[
                            const SizedBox(height: SentIQSpacing.sm),
                            Text(
                              _localError ?? state.message!,
                              style: TextStyle(color: palette.danger),
                            ),
                          ],
                          const SizedBox(height: SentIQSpacing.lg),
                          SentIQButton(
                            label: 'Update password',
                            expand: true,
                            loading: state.busy,
                            onPressed: _save,
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _save() async {
    setState(() => _localError = null);
    if (_password.text.length < 8) {
      setState(() => _localError = 'Use at least 8 characters.');
      return;
    }
    if (_password.text != _confirmation.text) {
      setState(() => _localError = 'The passwords do not match.');
      return;
    }
    await ref
        .read(authControllerProvider.notifier)
        .updatePassword(_password.text);
  }
}
