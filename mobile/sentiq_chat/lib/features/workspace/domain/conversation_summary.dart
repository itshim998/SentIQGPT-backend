enum ConversationSyncState {
  synced,
  localOnly,
  pendingRename,
  pendingDelete;

  static ConversationSyncState parse(Object? value) {
    return ConversationSyncState.values.firstWhere(
      (ConversationSyncState state) => state.name == value?.toString(),
      orElse: () => ConversationSyncState.synced,
    );
  }
}

class ConversationSummary {
  const ConversationSummary({
    required this.id,
    required this.ownerScope,
    required this.title,
    required this.createdAt,
    required this.updatedAt,
    required this.syncState,
    this.lastMessagePreview,
  });

  factory ConversationSummary.fromJson(
    Map<String, Object?> json, {
    required String ownerScope,
  }) {
    final String id =
        (json['id'] ?? json['conversation_id'] ?? json['conversationId'])
            .toString();
    final DateTime now = DateTime.now().toUtc();
    return ConversationSummary(
      id: id,
      ownerScope: ownerScope,
      title: _text(json['title'], fallback: 'New chat'),
      createdAt: _date(json['created_at'] ?? json['createdAt']) ?? now,
      updatedAt: _date(json['updated_at'] ?? json['updatedAt']) ?? now,
      syncState: ConversationSyncState.synced,
      lastMessagePreview: _nullableText(
        json['last_message_preview'] ?? json['preview'],
      ),
    );
  }

  final String id;
  final String ownerScope;
  final String title;
  final DateTime createdAt;
  final DateTime updatedAt;
  final ConversationSyncState syncState;
  final String? lastMessagePreview;

  ConversationSummary copyWith({
    String? title,
    DateTime? updatedAt,
    ConversationSyncState? syncState,
    String? lastMessagePreview,
  }) {
    return ConversationSummary(
      id: id,
      ownerScope: ownerScope,
      title: title ?? this.title,
      createdAt: createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      syncState: syncState ?? this.syncState,
      lastMessagePreview: lastMessagePreview ?? this.lastMessagePreview,
    );
  }

  Map<String, Object?> toDatabase() => <String, Object?>{
        'id': id,
        'owner_scope': ownerScope,
        'title': title,
        'created_at': createdAt.toIso8601String(),
        'updated_at': updatedAt.toIso8601String(),
        'sync_state': syncState.name,
        'last_message_preview': lastMessagePreview,
      };

  static ConversationSummary fromDatabase(Map<String, Object?> row) {
    return ConversationSummary(
      id: row['id'].toString(),
      ownerScope: row['owner_scope'].toString(),
      title: _text(row['title'], fallback: 'New chat'),
      createdAt: _date(row['created_at']) ?? DateTime.now().toUtc(),
      updatedAt: _date(row['updated_at']) ?? DateTime.now().toUtc(),
      syncState: ConversationSyncState.parse(row['sync_state']),
      lastMessagePreview: _nullableText(row['last_message_preview']),
    );
  }
}

String _text(Object? value, {required String fallback}) {
  final String text = value?.toString().trim() ?? '';
  return text.isEmpty ? fallback : text;
}

String? _nullableText(Object? value) {
  final String text = value?.toString().trim() ?? '';
  return text.isEmpty ? null : text;
}

DateTime? _date(Object? value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString())?.toUtc();
}
