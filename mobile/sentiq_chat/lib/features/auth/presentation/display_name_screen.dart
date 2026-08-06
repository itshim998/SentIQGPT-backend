import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_brand_mark.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_text_field.dart';

class DisplayNameScreen extends ConsumerStatefulWidget {
  const DisplayNameScreen({super.key});

  @override
  ConsumerState<DisplayNameScreen> createState() =>
      _DisplayNameScreenState();
}

class _DisplayNameScreenState extends ConsumerState<DisplayNameScreen> {
  final TextEditingController _name = TextEditingController();

  @override
  void dispose() {
    _name.dispose();
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
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
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
                    'What should we call you?',
                    style: Theme.of(context).textTheme.headlineMedium,
                  ),
                  const SizedBox(height: SentIQSpacing.sm),
                  Text(
                    'This name appears only in your SentIQ Chat workspace and can be changed later.',
                    style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                          color: palette.textSecondary,
                        ),
                  ),
                  const SizedBox(height: SentIQSpacing.xl),
                  RefractiveGlassSurface(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        SentIQTextField(
                          label: 'Your name',
                          controller: _name,
                          textInputAction: TextInputAction.done,
                          autofillHints: const <String>[AutofillHints.name],
                          enabled: !state.busy,
                          onSubmitted: (_) => _save(),
                        ),
                        if (state.message != null) ...<Widget>[
                          const SizedBox(height: SentIQSpacing.sm),
                          Text(
                            state.message!,
                            style: TextStyle(color: palette.danger),
                          ),
                        ],
                        const SizedBox(height: SentIQSpacing.lg),
                        SentIQButton(
                          label: 'Continue',
                          expand: true,
                          loading: state.busy,
                          onPressed: _save,
                        ),
                      ],
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

  Future<void> _save() {
    return ref
        .read(authControllerProvider.notifier)
        .saveDisplayName(_name.text);
  }
}
