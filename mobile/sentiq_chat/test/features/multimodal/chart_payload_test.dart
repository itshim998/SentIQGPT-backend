import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/multimodal/domain/multimodal_models.dart';

void main() {
  test('normalizes supported Chart.js payloads', () {
    final Map<String, Object?> fixture =
        (jsonDecode(
                  File(
                    'test/fixtures/phase4/chart-valid.json',
                  ).readAsStringSync(),
                )
                as Map)
            .map((key, value) => MapEntry(key.toString(), value));
    final ChartPayload chart = ChartPayload.fromJson(fixture);
    expect(chart.valid, isTrue);
    expect(chart.type, 'bar');
    expect(chart.labels, <String>['A', 'B', 'C']);
    expect(chart.series.single, <double>[3, 7, 5]);
  });

  test('malformed chart payloads fail safely', () {
    final Map<String, Object?> fixture =
        (jsonDecode(
                  File(
                    'test/fixtures/phase4/chart-malformed.json',
                  ).readAsStringSync(),
                )
                as Map)
            .map((key, value) => MapEntry(key.toString(), value));
    final ChartPayload chart = ChartPayload.fromJson(fixture);
    expect(chart.valid, isFalse);
    expect(chart.error, isNotEmpty);
  });

  test('normalizes persisted chart preview payloads', () {
    final ChartPayload chart = ChartPayload.fromJson(<String, Object?>{
      'chart_type': 'line',
      'chartjs_config': <String, Object?>{
        'type': 'line',
        'data': <String, Object?>{
          'labels': <String>['One', 'Two'],
          'datasets': <Object?>[
            <String, Object?>{
              'data': <int>[1, 2],
            },
          ],
        },
      },
    });
    expect(chart.valid, isTrue);
    expect(chart.series.single, <double>[1, 2]);
  });
}
