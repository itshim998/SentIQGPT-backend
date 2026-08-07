import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/core/config/app_environment.dart';

const String _productionApiBase =
    'https://sentiqgpt-backend.ashygrass-913d190e.centralindia.azurecontainerapps.io';
const String _defaultSupabaseUrl = 'https://lzgohufdrqjdupfsvqlj.supabase.co';
const String _defaultSupabasePublishableKey =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6Z29odWZkcnFqZHVwZnN2cWxqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNjYwNTYsImV4cCI6MjA4OTk0MjA1Nn0.S1UYzT1yeMcCFSlcjYVfLkzzQtpwjmYWaeu74gFn-Pw';

class AppConfig {
  const AppConfig({
    required this.environment,
    required this.apiBaseUri,
    required this.supabaseUrl,
    required this.supabasePublishableKey,
    required this.mobileContractVersion,
    required this.loginRedirectUri,
    required this.recoveryRedirectUri,
  });

  factory AppConfig.fromEnvironment() {
    const String rawEnvironment = String.fromEnvironment(
      'SENTIQ_ENV',
      defaultValue: 'production',
    );
    const String overrideBase = String.fromEnvironment('SENTIQ_API_BASE');
    const String supabaseUrl = String.fromEnvironment(
      'SENTIQ_SUPABASE_URL',
      defaultValue: _defaultSupabaseUrl,
    );
    const String supabaseKey = String.fromEnvironment(
      'SENTIQ_SUPABASE_PUBLISHABLE_KEY',
      defaultValue: _defaultSupabasePublishableKey,
    );
    final AppEnvironment environment = AppEnvironment.parse(rawEnvironment);
    final String defaultBase = switch (environment) {
      AppEnvironment.development => 'http://10.0.2.2:3001',
      AppEnvironment.staging => _productionApiBase,
      AppEnvironment.production => _productionApiBase,
    };
    return AppConfig(
      environment: environment,
      apiBaseUri: Uri.parse(overrideBase.isEmpty ? defaultBase : overrideBase),
      supabaseUrl: supabaseUrl,
      supabasePublishableKey: supabaseKey,
      mobileContractVersion: 4,
      loginRedirectUri: Uri.parse(
        'com.sentiqlabs.sentiqchat://login-callback/',
      ),
      recoveryRedirectUri: Uri.parse(
        'com.sentiqlabs.sentiqchat://reset-callback/',
      ),
    );
  }

  final AppEnvironment environment;
  final Uri apiBaseUri;
  final String supabaseUrl;
  final String supabasePublishableKey;
  final int mobileContractVersion;
  final Uri loginRedirectUri;
  final Uri recoveryRedirectUri;
}

final Provider<AppConfig> appConfigProvider = Provider<AppConfig>(
  (ref) => throw StateError('AppConfig must be overridden at bootstrap.'),
);
