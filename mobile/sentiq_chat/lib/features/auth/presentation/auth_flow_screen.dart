import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_brand_mark.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_text_field.dart';

enum _AuthPage { welcome, signIn, signUp, recovery }

class AuthFlowScreen extends ConsumerStatefulWidget {
  const AuthFlowScreen({super.key});

  @override
  ConsumerState<AuthFlowScreen> createState() => _AuthFlowScreenState();
}

class _AuthFlowScreenState extends ConsumerState<AuthFlowScreen> {
  final TextEditingController _email = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final TextEditingController _confirmation = TextEditingController();
  _AuthPage _page = _AuthPage.welcome;
  String? _localError;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _confirmation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final AppAuthState authState = ref.watch(authControllerProvider);
    final SentIQPalette palette = context.sentiqPalette;
    return PopScope(
      canPop: _page == _AuthPage.welcome,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (!didPop && _page != _AuthPage.welcome) {
          setState(() {
            _page = _AuthPage.welcome;
            _localError = null;
          });
        }
      },
      child: Scaffold(
        resizeToAvoidBottomInset: true,
        body: Stack(
          children: <Widget>[
            Positioned(
              top: -180,
              right: -120,
              child: IgnorePointer(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: RadialGradient(
                      colors: <Color>[
                        palette.accent.withValues(alpha: 0.24),
                        palette.accent.withValues(alpha: 0),
                      ],
                    ),
                  ),
                  child: const SizedBox.square(dimension: 430),
                ),
              ),
            ),
            SafeArea(
              child: LayoutBuilder(
                builder: (BuildContext context, BoxConstraints constraints) {
                  final double horizontal = constraints.maxWidth >= 700
                      ? (constraints.maxWidth - 520) / 2
                      : SentIQSpacing.lg;
                  return SingleChildScrollView(
                    keyboardDismissBehavior:
                        ScrollViewKeyboardDismissBehavior.onDrag,
                    padding: EdgeInsets.fromLTRB(
                      horizontal.clamp(SentIQSpacing.lg, 180),
                      SentIQSpacing.xxl,
                      horizontal.clamp(SentIQSpacing.lg, 180),
                      SentIQSpacing.xxl + MediaQuery.viewInsetsOf(context).bottom,
                    ),
                    child: AnimatedSwitcher(
                      duration: SentIQMotion.standard,
                      child: _page == _AuthPage.welcome
                          ? _welcome(authState)
                          : _credentials(authState),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _welcome(AppAuthState state) {
    final SentIQPalette palette = context.sentiqPalette;
    return Column(
      key: const ValueKey<String>('welcome'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const Align(
          alignment: Alignment.centerLeft,
          child: SentIQBrandMark(size: 64),
        ),
        const SizedBox(height: SentIQSpacing.lg),
        Text(
          'A calmer place to think.',
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(height: SentIQSpacing.sm),
        Text(
          'Start privately as a guest, or sign in to keep conversations available across sessions.',
          style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                color: palette.textSecondary,
              ),
        ),
        const SizedBox(height: SentIQSpacing.xl),
        RefractiveGlassSurface(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              SentIQButton(
                label: 'Continue as guest',
                icon: Icons.arrow_forward_rounded,
                expand: true,
                onPressed: state.busy
                    ? null
                    : ref.read(authControllerProvider.notifier).continueAsGuest,
              ),
              const SizedBox(height: SentIQSpacing.sm),
              SentIQButton(
                label: 'Sign in',
                style: SentIQButtonStyle.secondary,
                expand: true,
                onPressed: state.busy
                    ? null
                    : () => setState(() => _page = _AuthPage.signIn),
              ),
              const SizedBox(height: SentIQSpacing.sm),
              SentIQButton(
                label: 'Create an account',
                style: SentIQButtonStyle.quiet,
                expand: true,
                onPressed: state.busy
                    ? null
                    : () => setState(() => _page = _AuthPage.signUp),
              ),
              const SizedBox(height: SentIQSpacing.xs),
              const Divider(),
              const SizedBox(height: SentIQSpacing.xs),
              SentIQButton(
                label: 'Continue with Google',
                icon: Icons.language_rounded,
                style: SentIQButtonStyle.secondary,
                expand: true,
                loading: state.busy,
                onPressed: () => ref
                    .read(authControllerProvider.notifier)
                    .signInWithGoogle(),
              ),
            ],
          ),
        ),
        if (state.message != null) ...<Widget>[
          const SizedBox(height: SentIQSpacing.md),
          Text(
            state.message!,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: palette.textSecondary,
                ),
          ),
        ],
      ],
    );
  }

  Widget _credentials(AppAuthState state) {
    final bool signingUp = _page == _AuthPage.signUp;
    final bool recovering = _page == _AuthPage.recovery;
    final SentIQPalette palette = context.sentiqPalette;
    return AutofillGroup(
      key: ValueKey<_AuthPage>(_page),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Align(
            alignment: Alignment.centerLeft,
            child: SentIQIconButton(
              icon: Icons.arrow_back_rounded,
              tooltip: 'Back',
              onPressed: () => setState(() {
                _page = _AuthPage.welcome;
                _localError = null;
              }),
            ),
          ),
          const SizedBox(height: SentIQSpacing.lg),
          Text(
            recovering
                ? 'Reset your password'
                : signingUp
                    ? 'Create your account'
                    : 'Welcome back',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          const SizedBox(height: SentIQSpacing.xs),
          Text(
            recovering
                ? 'We will email you a secure link to choose a new password.'
                : signingUp
                    ? 'Your conversations and preferences will stay with your account.'
                    : 'Sign in to continue where you left off.',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: palette.textSecondary,
                ),
          ),
          const SizedBox(height: SentIQSpacing.lg),
          SentIQTextField(
            label: 'Email',
            controller: _email,
            keyboardType: TextInputType.emailAddress,
            textInputAction:
                recovering ? TextInputAction.done : TextInputAction.next,
            autofillHints: const <String>[AutofillHints.email],
            enabled: !state.busy,
            onSubmitted: recovering ? (_) => _submit() : null,
          ),
          if (!recovering) ...<Widget>[
            const SizedBox(height: SentIQSpacing.sm),
            SentIQTextField(
              label: 'Password',
              controller: _password,
              obscureText: true,
              textInputAction:
                  signingUp ? TextInputAction.next : TextInputAction.done,
              autofillHints: <String>[
                signingUp
                    ? AutofillHints.newPassword
                    : AutofillHints.password,
              ],
              enabled: !state.busy,
              onSubmitted: signingUp ? null : (_) => _submit(),
            ),
          ],
          if (signingUp) ...<Widget>[
            const SizedBox(height: SentIQSpacing.sm),
            SentIQTextField(
              label: 'Confirm password',
              controller: _confirmation,
              obscureText: true,
              textInputAction: TextInputAction.done,
              autofillHints: const <String>[AutofillHints.newPassword],
              enabled: !state.busy,
              onSubmitted: (_) => _submit(),
            ),
          ],
          if (_localError != null || state.message != null) ...<Widget>[
            const SizedBox(height: SentIQSpacing.sm),
            Text(
              _localError ?? state.message!,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: _localError == null
                        ? palette.textSecondary
                        : palette.danger,
                  ),
            ),
          ],
          const SizedBox(height: SentIQSpacing.lg),
          SentIQButton(
            label: recovering
                ? 'Send reset link'
                : signingUp
                    ? 'Create account'
                    : 'Sign in',
            expand: true,
            loading: state.busy,
            onPressed: _submit,
          ),
          if (!signingUp && !recovering) ...<Widget>[
            const SizedBox(height: SentIQSpacing.xs),
            SentIQButton(
              label: 'Forgot password?',
              style: SentIQButtonStyle.quiet,
              expand: true,
              onPressed: state.busy
                  ? null
                  : () => setState(() => _page = _AuthPage.recovery),
            ),
          ],
        ],
      ),
    );
  }

  Future<void> _submit() async {
    final String email = _email.text.trim();
    final String password = _password.text;
    setState(() => _localError = null);
    if (!email.contains('@')) {
      setState(() => _localError = 'Enter a valid email address.');
      return;
    }
    final controller = ref.read(authControllerProvider.notifier);
    if (_page == _AuthPage.recovery) {
      await controller.requestPasswordReset(email);
      return;
    }
    if (password.length < 8) {
      setState(() => _localError = 'Use at least 8 characters for your password.');
      return;
    }
    if (_page == _AuthPage.signUp && password != _confirmation.text) {
      setState(() => _localError = 'The passwords do not match.');
      return;
    }
    if (_page == _AuthPage.signUp) {
      await controller.signUp(email, password);
    } else {
      await controller.signIn(email, password);
    }
  }
}
