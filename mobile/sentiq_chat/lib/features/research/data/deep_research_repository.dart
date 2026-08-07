import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/api_endpoints.dart';
import 'package:sentiq_chat/features/research/domain/deep_research_models.dart';

abstract interface class DeepResearchGateway {
  Future<DeepResearchQuota> quota();
  Future<DeepResearchReport> start({
    required String prompt,
    required String conversationId,
    required String clientRequestId,
  });
  Future<DeepResearchReport> status(String reportId);
  Future<DeepResearchReport> report(String reportId);
  Future<SentIQSseConnection> subscribe(String reportId);
  Future<DeepResearchReport> cancel(String reportId);
  Future<SentIQBinaryResponse> export(String reportId, String format);
}

class DeepResearchRepository implements DeepResearchGateway {
  const DeepResearchRepository(this._client);

  final SentIQApiClient _client;

  @override
  Future<DeepResearchQuota> quota() async {
    return DeepResearchQuota.fromJson(
      await _client.getJson(ApiEndpoints.deepResearchQuota),
    );
  }

  @override
  Future<DeepResearchReport> start({
    required String prompt,
    required String conversationId,
    required String clientRequestId,
  }) async {
    return DeepResearchReport.fromJson(
      await _client.postJson(
        ApiEndpoints.deepResearchStart,
        body: <String, Object?>{
          'prompt': prompt,
          'conversationId': conversationId,
          'clientRequestId': clientRequestId,
        },
      ),
    );
  }

  @override
  Future<DeepResearchReport> status(String reportId) async {
    return DeepResearchReport.fromJson(
      await _client.getJson(ApiEndpoints.deepResearchStatus(reportId)),
    );
  }

  @override
  Future<DeepResearchReport> report(String reportId) async {
    return DeepResearchReport.fromJson(
      await _client.getJson(ApiEndpoints.deepResearchReport(reportId)),
    );
  }

  @override
  Future<SentIQSseConnection> subscribe(String reportId) {
    return _client.getSseCancellable(ApiEndpoints.deepResearchEvents(reportId));
  }

  @override
  Future<DeepResearchReport> cancel(String reportId) async {
    return DeepResearchReport.fromJson(
      await _client.postJson(
        ApiEndpoints.deepResearchCancel(reportId),
        body: const <String, Object?>{},
      ),
    );
  }

  @override
  Future<SentIQBinaryResponse> export(String reportId, String format) {
    return _client.getBinary(
      ApiEndpoints.deepResearchExport(reportId, format),
      maximumBytes: 32 * 1024 * 1024,
    );
  }
}
