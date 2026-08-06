abstract final class ApiEndpoints {
  static const String config = '/api/config';
  static const String profile = '/api/profile';
  static const String chat = '/api/chat';
  static const String chatStream = '/api/chat/stream';
  static const String conversations = '/api/conversations';
  static String conversation(String id) =>
      '/api/conversations/${Uri.encodeComponent(id)}';
  static String conversationTitle(String id) =>
      '${conversation(id)}/title';
  static String conversationMessages(String id) =>
      '${conversation(id)}/messages';
  static const String filesUpload = '/api/files/upload';
  static const String filesUpdates = '/api/files/updates';
  static const String imagesGenerate = '/api/images/generate';
  static const String deepResearchStart = '/api/deep-research/start';
  static const String billingMe = '/api/billing/me';
  static const String liveStatus = '/api/live/status';
  static const String liveSessionToken = '/api/live/session-token';
}
