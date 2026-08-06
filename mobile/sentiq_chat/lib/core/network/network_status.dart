import 'package:connectivity_plus/connectivity_plus.dart';

// Connectivity is a hint only. API failures still decide degraded mode.
enum NetworkAvailability { online, offline }

abstract interface class NetworkMonitor {
  Future<NetworkAvailability> current();
  Stream<NetworkAvailability> get changes;
}

class ConnectivityNetworkMonitor implements NetworkMonitor {
  ConnectivityNetworkMonitor({Connectivity? connectivity})
      : _connectivity = connectivity ?? Connectivity();

  final Connectivity _connectivity;

  @override
  Future<NetworkAvailability> current() async {
    return _map(await _connectivity.checkConnectivity());
  }

  @override
  Stream<NetworkAvailability> get changes => _connectivity.onConnectivityChanged
      .map(_map)
      .distinct();

  NetworkAvailability _map(List<ConnectivityResult> values) {
    return values.contains(ConnectivityResult.none)
        ? NetworkAvailability.offline
        : NetworkAvailability.online;
  }
}
