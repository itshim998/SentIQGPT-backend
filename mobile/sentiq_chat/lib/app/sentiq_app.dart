import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/core/config/app_config.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/foundation/presentation/foundation_gallery_screen.dart';

class SentIQApp extends ConsumerWidget {
  const SentIQApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppConfig config = ref.watch(appConfigProvider);
    return MaterialApp(
      title: 'SentIQ Chat',
      debugShowCheckedModeBanner: config.environment.isDevelopment,
      theme: SentIQTheme.light(),
      darkTheme: SentIQTheme.dark(),
      themeMode: ThemeMode.system,
      home: FoundationGalleryScreen(config: config),
    );
  }
}
