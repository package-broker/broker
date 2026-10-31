import type { AuditDestinationSpec } from './plugin-api.js';
import { classifyUrl, createOutboundPolicy } from '../sources/url-policy.js';

export const DEFAULT_AUDIT_DESTINATIONS = Object.freeze({
  otlpEndpoint: 'PB_AUDIT_OTLP_ENDPOINT',
  otlpHeaders: 'PB_AUDIT_OTLP_HEADERS',
  webhookUrl: 'PB_AUDIT_WEBHOOK_URL',
  webhookHeaders: 'PB_AUDIT_WEBHOOK_HEADERS',
});

export const AUDIT_OTEL_ENDPOINTS = [
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
] as const;

export function auditDestinationNames(destination: AuditDestinationSpec): {
  endpoint: string;
  headers: string | undefined;
} {
  const endpoint =
    destination.protocol === 'otlp-http-json'
      ? (destination.endpointEnv ?? DEFAULT_AUDIT_DESTINATIONS.otlpEndpoint)
      : destination.urlEnv;
  const headers =
    destination.headersEnv ??
    (endpoint === DEFAULT_AUDIT_DESTINATIONS.otlpEndpoint
      ? DEFAULT_AUDIT_DESTINATIONS.otlpHeaders
      : endpoint === 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'
        ? 'OTEL_EXPORTER_OTLP_LOGS_HEADERS'
        : endpoint === 'OTEL_EXPORTER_OTLP_ENDPOINT'
          ? 'OTEL_EXPORTER_OTLP_HEADERS'
          : endpoint === DEFAULT_AUDIT_DESTINATIONS.webhookUrl
            ? DEFAULT_AUDIT_DESTINATIONS.webhookHeaders
            : undefined);
  return { endpoint, headers };
}

export function validAuditAlertDestination(raw: string | undefined): boolean {
  try {
    const url = new URL(raw ?? '');
    return (
      classifyUrl(
        url.href,
        createOutboundPolicy({
          runtime: 'cloudflare',
          allowPrivateHosts: [],
          selfOrigins: [],
        }),
      ).ok &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function auditTelemetryActive(endpoint: unknown): boolean {
  return Boolean(endpoint);
}

export function auditAlertPathActive(
  telemetryActive: boolean,
  alertUrl: string | undefined,
): boolean {
  return telemetryActive || alertUrl !== undefined;
}
