import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/core/config/app_environment.dart';

const String _productionApiBase =
    'https://sentiqgpt-backend.ashygrass-913d190e.centralindia.azurecontainerapps.io';

class AppConfig {
  const AppConfig({
    required this.environment,
    required this.apiBaseUri,
    required this.mobileContractVersion,
  });

  factory AppConfig.fromEnvironment() {
    const String rawEnvironment = String.fromEnvironment(
      'SENTIQ_ENV',
      defaultValue: 'production',
    );
    const String overrideBase = String.fromEnvironment('SENTIQ_API_BASE');
    final AppEnvironment environment = AppEnvironment.parse(rawEnvironment);
    final String defaultBase = switch (environment) {
      AppEnvironment.development => 'http://10.0.2.2:3001',
      AppEnvironment.staging => _productionApiBase,
      AppEnvironment.production => _productionApiBase,
    };
    return AppConfig(
      environment: environment,
      apiBaseUri: Uri.parse(overrideBase.isEmpty ? defaultBase : overrideBase),
      mobileContractVersion: 1,
    );
  }

  final AppEnvironment environment;
  final Uri apiBaseUri;
  final int mobileContractVersion;
}

final Provider<AppConfig> appConfigProvider = Provider<AppConfig>(
  (ref) => throw StateError('AppConfig must be overridden at bootstrap.'),
);
