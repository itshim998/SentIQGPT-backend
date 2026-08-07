import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/features/account/data/account_repository.dart';
import 'package:sentiq_chat/features/account/domain/account_models.dart';

class AccountController extends StateNotifier<AccountState> {
  AccountController({
    required AccountGateway repository,
    required this.ownerScope,
    required this.cloudEnabled,
  }) : _repository = repository,
       super(const AccountState());

  final AccountGateway _repository;
  final String ownerScope;
  final bool cloudEnabled;
  bool _disposed = false;

  void clearMessage() {
    state = state.copyWith(clearMessage: true);
  }

  Future<void> initialize() async {
    if (cloudEnabled) await refreshMemories();
  }

  Future<void> refreshMemories() async {
    if (!cloudEnabled) return;
    state = state.copyWith(loading: true, clearMessage: true);
    try {
      final List<AccountMemory> memories = List<AccountMemory>.of(
        await _repository.memories(),
      );
      memories.sort((AccountMemory a, AccountMemory b) {
        final int importance = b.importance.compareTo(a.importance);
        if (importance != 0) return importance;
        return (b.createdAt ?? DateTime(1970)).compareTo(
          a.createdAt ?? DateTime(1970),
        );
      });
      if (!_disposed) {
        state = state.copyWith(memories: memories, loading: false);
      }
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(loading: false, message: _message(error));
      }
    }
  }

  Future<void> deleteMemory(String id) async {
    try {
      await _repository.deleteMemory(id);
      if (!_disposed) {
        state = state.copyWith(
          memories: state.memories
              .where((AccountMemory memory) => memory.id != id)
              .toList(growable: false),
          clearMessage: true,
        );
      }
    } catch (error) {
      if (!_disposed) state = state.copyWith(message: _message(error));
    }
  }

  Future<bool> clearTemporaryFiles() async {
    state = state.copyWith(clearing: true, clearMessage: true);
    try {
      await _repository.clearTemporaryFiles();
      if (!_disposed) {
        state = state.copyWith(
          clearing: false,
          message: 'Temporary uploaded files were cleared.',
        );
      }
      return true;
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(clearing: false, message: _message(error));
      }
      return false;
    }
  }

  Future<bool> clearDeviceData() async {
    state = state.copyWith(clearing: true, clearMessage: true);
    try {
      await _repository.clearDeviceData(ownerScope);
      if (!_disposed) {
        state = state.copyWith(
          clearing: false,
          message: 'SentIQ Chat data on this device was cleared.',
        );
      }
      return true;
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(clearing: false, message: _message(error));
      }
      return false;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

String _message(Object error) {
  final String text = error.toString();
  return text.startsWith('Exception: ') ? text.substring(11) : text;
}
