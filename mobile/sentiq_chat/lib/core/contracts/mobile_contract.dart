class MobileContract {
  const MobileContract({
    required this.contractVersion,
    required this.minimumClientContractVersion,
    required this.sseVersion,
    required this.unknownFieldsAreSafe,
    required this.unknownSseEventsAreSafe,
    required this.endpoints,
  });

  factory MobileContract.fromConfig(Map<String, Object?> config) {
    final Map<String, Object?> mobile = _map(config['mobile_contract']);
    final Map<String, Object?> compatibility = _map(mobile['compatibility']);
    final Map<String, Object?> sse = _map(mobile['sse']);
    final Map<String, Object?> endpoints = _map(mobile['endpoints']);
    return MobileContract(
      contractVersion: _integer(mobile['contract_version'], fallback: 1),
      minimumClientContractVersion: _integer(
        mobile['minimum_client_contract_version'],
        fallback: 1,
      ),
      sseVersion: _integer(sse['version'], fallback: 1),
      unknownFieldsAreSafe: compatibility['unknown_fields'] == 'ignore',
      unknownSseEventsAreSafe: compatibility['unknown_sse_events'] == 'ignore',
      endpoints: endpoints.map(
        (String key, Object? value) => MapEntry(key, value.toString()),
      ),
    );
  }

  final int contractVersion;
  final int minimumClientContractVersion;
  final int sseVersion;
  final bool unknownFieldsAreSafe;
  final bool unknownSseEventsAreSafe;
  final Map<String, String> endpoints;

  bool supportsClientVersion(int clientVersion) {
    return clientVersion >= minimumClientContractVersion;
  }
}

Map<String, Object?> _map(Object? value) {
  if (value is! Map) return <String, Object?>{};
  return value.map(
    (Object? key, Object? nested) => MapEntry(key.toString(), nested),
  );
}

int _integer(Object? value, {required int fallback}) {
  return value is num ? value.toInt() : fallback;
}
