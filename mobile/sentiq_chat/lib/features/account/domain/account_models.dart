class AccountMemory {
  const AccountMemory({
    required this.id,
    required this.summary,
    required this.type,
    required this.scope,
    required this.importance,
    this.createdAt,
  });

  factory AccountMemory.fromJson(Map<String, Object?> json) {
    return AccountMemory(
      id: (json['id'] ?? '').toString(),
      summary: (json['summary'] ?? json['content'] ?? '').toString(),
      type: json['type']?.toString() ?? 'memory',
      scope:
          json['scope']?.toString() ??
          (json['chat_id'] == null ? 'global' : 'chat'),
      importance: json['importance'] is num
          ? (json['importance'] as num).toInt()
          : 0,
      createdAt: _dateTime(json['timestamp'] ?? json['created_at']),
    );
  }

  final String id;
  final String summary;
  final String type;
  final String scope;
  final int importance;
  final DateTime? createdAt;
}

class AccountState {
  const AccountState({
    this.memories = const <AccountMemory>[],
    this.loading = false,
    this.clearing = false,
    this.message,
  });

  final List<AccountMemory> memories;
  final bool loading;
  final bool clearing;
  final String? message;

  AccountState copyWith({
    List<AccountMemory>? memories,
    bool? loading,
    bool? clearing,
    String? message,
    bool clearMessage = false,
  }) {
    return AccountState(
      memories: memories ?? this.memories,
      loading: loading ?? this.loading,
      clearing: clearing ?? this.clearing,
      message: clearMessage ? null : message ?? this.message,
    );
  }
}

DateTime? _dateTime(Object? value) {
  final String text = value?.toString() ?? '';
  return text.isEmpty ? null : DateTime.tryParse(text)?.toLocal();
}
