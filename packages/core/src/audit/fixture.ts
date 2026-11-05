import type { AuditSinkRegistration } from './sinks/registry.js';
import type { resolveAuditDestination } from './sinks/transport.js';

declare global {
  interface ImportMeta {
    readonly pbAuditFixture?: boolean;
  }
  // Supplied only by the disposable e2e entry, never by a runtime environment binding.
  var __pbAuditFixture: {
    transport(
      options: Parameters<typeof resolveAuditDestination>[0],
    ): Parameters<typeof resolveAuditDestination>[0];
    registry(
      configured: readonly AuditSinkRegistration[],
    ): Promise<readonly AuditSinkRegistration[]>;
    beforeSave(sink: string): Promise<'none' | 'crash' | 'cas'>;
    afterSave(job: string, sink: string, saved: boolean): Promise<void>;
  };
}

export {};
