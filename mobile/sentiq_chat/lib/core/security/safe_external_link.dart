import 'package:url_launcher/url_launcher.dart';

/// The only boundary allowed to hand an external URI to Android.
///
/// User/model supplied links are HTTPS-only, contain no credentials, and open
/// outside SentIQ Chat. The support-email helper is intentionally separate so
/// arbitrary `mailto:` values can never enter through rendered content.
abstract final class SafeExternalLink {
  static bool isSafeHttps(Uri uri) {
    return uri.scheme.toLowerCase() == 'https' &&
        uri.host.isNotEmpty &&
        uri.userInfo.isEmpty;
  }

  static Future<bool> openHttps(Object? value) async {
    final Uri? uri = _parse(value);
    if (uri == null || !isSafeHttps(uri)) return false;
    try {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } on Object {
      return false;
    }
  }

  static Uri? _parse(Object? value) {
    if (value is Uri) return value;
    if (value is String) return Uri.tryParse(value.trim());
    return null;
  }

  static Future<bool> emailSupport() async {
    final Uri uri = Uri(
      scheme: 'mailto',
      path: 'support@sentiqlabs.com',
      queryParameters: const <String, String>{'subject': 'SentIQ Chat support'},
    );
    try {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } on Object {
      return false;
    }
  }
}
