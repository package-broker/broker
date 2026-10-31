import { describe, expect, it } from 'vitest';
import {
  auditAlertPathActive,
  auditDestinationNames,
  auditTelemetryActive,
  validAuditAlertDestination,
} from './destinations.js';

describe('audit destination configuration shared with deploy', () => {
  it.each([
    [{ protocol: 'otlp-http-json' }, 'PB_AUDIT_OTLP_ENDPOINT', 'PB_AUDIT_OTLP_HEADERS'],
    [{ protocol: 'otlp-http-json', endpointEnv: 'CUSTOM_ENDPOINT' }, 'CUSTOM_ENDPOINT', undefined],
    [
      { protocol: 'otlp-http-json', endpointEnv: 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT' },
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
    ],
    [
      { protocol: 'https-json', urlEnv: 'PB_AUDIT_WEBHOOK_URL' },
      'PB_AUDIT_WEBHOOK_URL',
      'PB_AUDIT_WEBHOOK_HEADERS',
    ],
    [
      { protocol: 'https-json', urlEnv: 'CUSTOM_URL', headersEnv: 'CUSTOM_HEADERS' },
      'CUSTOM_URL',
      'CUSTOM_HEADERS',
    ],
  ] as const)('resolves destination defaults %j', (destination, endpoint, headers) => {
    expect(auditDestinationNames(destination)).toEqual({ endpoint, headers });
  });

  it.each([
    ['https://alerts.example.test/events', true],
    [undefined, false],
    ['invalid', false],
    ['http://alerts.example.test/events', false],
    ['https://user:password@alerts.example.test', false],
    ['https://alerts.example.test/?token=sentinel', false],
    ['https://alerts.example.test/#fragment', false],
    ['https://169.254.169.254/events', false],
    ['https://127.0.0.1/events', false],
  ] as const)('validates alert destination %s', (raw, valid) => {
    expect(validAuditAlertDestination(raw)).toBe(valid);
  });

  it.each([
    [undefined, undefined, false],
    ['', undefined, false],
    ['https://collector.example.test', undefined, true],
    [undefined, 'https://alerts.example.test', true],
    ['https://collector.example.test', 'https://alerts.example.test', true],
  ])('resolves telemetry and webhook alert availability', (endpoint, alert, expected) => {
    expect(auditAlertPathActive(auditTelemetryActive(endpoint), alert)).toBe(expected);
  });
});
