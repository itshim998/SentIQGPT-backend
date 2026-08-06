import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

class ThemeController extends StateNotifier<ThemeMode> {
  ThemeController({SharedPreferencesAsync? preferences})
    : _preferences = preferences ?? SharedPreferencesAsync(),
      super(ThemeMode.system) {
    unawaited(restore());
  }

  static const String _storageKey = 'sentiq:mobile:theme-mode';

  final SharedPreferencesAsync _preferences;

  Future<void> restore() async {
    final String? stored = await _preferences.getString(_storageKey);
    state = switch (stored) {
      'light' => ThemeMode.light,
      'dark' => ThemeMode.dark,
      _ => ThemeMode.system,
    };
  }

  Future<void> setMode(ThemeMode mode) async {
    state = mode;
    await _preferences.setString(_storageKey, mode.name);
  }
}
