import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/app/sentiq_app.dart';
import 'package:sentiq_chat/core/config/app_config.dart';
import 'package:sentiq_chat/core/performance/performance_policy.dart';
import 'package:sentiq_chat/core/performance/performance_trace.dart';
import 'package:sentiq_chat/core/security/secure_auth_storage.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SentIQPerformanceTrace.beginStartup();
  SentIQPerformancePolicy.configureImageCache();
  final AppConfig config = AppConfig.fromEnvironment();
  await Supabase.initialize(
    url: config.supabaseUrl,
    publishableKey: config.supabasePublishableKey,
    authOptions: FlutterAuthClientOptions(
      authFlowType: AuthFlowType.pkce,
      detectSessionInUri: true,
      localStorage: SecureAuthStorage(),
    ),
  );
  SentIQPerformanceTrace.installFrameTimingTrace();
  SentIQPerformanceTrace.markFirstFlutterFrame();
  runApp(
    ProviderScope(
      overrides: <Override>[appConfigProvider.overrideWithValue(config)],
      child: const SentIQApp(),
    ),
  );
}
