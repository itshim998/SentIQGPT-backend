import 'dart:convert';
import 'dart:typed_data';

class ContentPolicyException implements Exception {
  const ContentPolicyException(this.message);
  final String message;
  @override
  String toString() => message;
}

class AttachmentPolicy {
  static const int maximumBytes = 10 * 1024 * 1024;
  static const int maximumAttachments = 10;
  static const Set<String> supportedMimeTypes = <String>{
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'image/png',
    'image/jpeg',
    'image/webp',
  };
  static const Set<String> textExtensions = <String>{
    'txt',
    'md',
    'csv',
    'json',
    'html',
    'htm',
    'xml',
    'yaml',
    'yml',
    'dart',
    'js',
    'ts',
    'py',
    'java',
    'kt',
    'c',
    'cpp',
    'h',
    'css',
    'sql',
  };

  static String? validate({
    required String filename,
    required String mimeType,
    required int sizeBytes,
  }) {
    if (sizeBytes <= 0) return 'This file is empty.';
    if (sizeBytes > maximumBytes) {
      return 'Files must be 10 MB or smaller.';
    }
    final String extension = filename.contains('.')
        ? filename.split('.').last.toLowerCase()
        : '';
    final bool supported =
        supportedMimeTypes.contains(mimeType) ||
        textExtensions.contains(extension);
    if (!supported) {
      return 'This file type is not supported. Use PDF, text, code, PNG, JPEG or WebP.';
    }
    return null;
  }

  static bool looksLikeScannedPdf(String? extractedText) {
    final String value = extractedText?.toLowerCase() ?? '';
    return value.contains('appears to be scanned') ||
        value.contains('image-based') && value.contains('no selectable text');
  }

  static bool isLongPdf({
    required String mimeType,
    required int sizeBytes,
    String? text,
  }) {
    return mimeType == 'application/pdf' &&
        (sizeBytes >= 5 * 1024 * 1024 || (text?.length ?? 0) >= 120000);
  }
}

class RemoteContentPolicy {
  static const int maximumImageBytes = 24 * 1024 * 1024;
  static const int maximumArtifactBytes = 64 * 1024 * 1024;

  static Uri requireHttps(String value) {
    final Uri? uri = Uri.tryParse(value.trim());
    if (uri == null || uri.scheme != 'https' || uri.host.isEmpty) {
      throw const ContentPolicyException(
        'Only secure HTTPS content can be opened.',
      );
    }
    if (uri.userInfo.isNotEmpty) {
      throw const ContentPolicyException(
        'Credential-bearing URLs are blocked.',
      );
    }
    return uri;
  }

  static Uint8List decodeImageData(String value) {
    final String normalized = value.trim();
    final String data = normalized.startsWith('data:image/')
        ? normalized.substring(normalized.indexOf(',') + 1)
        : normalized;
    final Uint8List bytes = base64Decode(data);
    if (bytes.length > maximumImageBytes) {
      throw const ContentPolicyException(
        'This image is too large to open safely.',
      );
    }
    return bytes;
  }

  static String sanitizeHtml(String html) {
    String value = html;
    value = value.replaceAll(
      RegExp(
        r'<\s*(script|iframe|object|embed|applet|meta|base)[^>]*>[\s\S]*?<\s*/\s*\1\s*>',
        caseSensitive: false,
      ),
      '',
    );
    value = value.replaceAll(
      RegExp(
        r'<\s*(script|iframe|object|embed|applet|meta|base)[^>]*/?\s*>',
        caseSensitive: false,
      ),
      '',
    );
    value = value.replaceAll(
      RegExp(
        r'''\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)''',
        caseSensitive: false,
      ),
      '',
    );
    value = value.replaceAll(
      RegExp(
        r'''(href|src)\s*=\s*(["'])\s*(javascript|file|content|intent|vbscript):[\s\S]*?\2''',
        caseSensitive: false,
      ),
      r'$1="#"',
    );
    return value;
  }

  static bool navigationAllowed(String value) {
    try {
      requireHttps(value);
      return true;
    } on ContentPolicyException {
      return false;
    }
  }
}
