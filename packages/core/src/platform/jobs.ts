import type { OrgContext } from '../db/port.js';
import type { PluginPorts } from '../plugin.js';
import type { JobFences } from './job-fences.js';
import type { Observability } from './observability.js';

export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 160;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const MAX_JOB_ATTEMPTS = 100;
export const MIN_SCHEDULE_SECONDS = 60;
export const RETRY_BASE_SECONDS = 5;
export const RETRY_CAP_SECONDS = 3600;

const MAX_NAME_LENGTH = 64;
const MAX_PAYLOAD_DEPTH = 32;
const MAX_PAYLOAD_NODES = 10_000;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const SECRET_KEY_PATTERN = /^(password|secret|token|authorization|cookie|api_?key|e_?mail)$/i;
const QUALIFIED_NAME_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:v[1-9][0-9]*$/;
const EMAIL_VALUE_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PRINTABLE_ASCII = /^[\u0020-\u007e]+$/;
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const RESERVED_NAME = 'core';
const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set([RESERVED_NAME, 'schedule']);
const RESERVED_KEY_PREFIX = 'schedule:';
const RUN_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

export type JobErrorCode =
  | 'invalid_name'
  | 'invalid_version'
  | 'invalid_definition'
  | 'invalid_schedule'
  | 'invalid_payload'
  | 'payload_too_large'
  | 'invalid_idempotency_key'
  | 'invalid_run_at'
  | 'invalid_attempt'
  | 'unknown_job_type'
  | 'idempotency_conflict'
  | 'lease_lost'
  | 'timeout'
  | 'aborted'
  | 'handler_error';

const JOB_ERROR_CODES: ReadonlySet<string> = new Set<JobErrorCode>([
  'invalid_name',
  'invalid_version',
  'invalid_definition',
  'invalid_schedule',
  'invalid_payload',
  'payload_too_large',
  'invalid_idempotency_key',
  'invalid_run_at',
  'invalid_attempt',
  'unknown_job_type',
  'idempotency_conflict',
  'lease_lost',
  'timeout',
  'aborted',
  'handler_error',
]);

/** The message is the fixed code; caller-supplied text and payload values never enter it. */
export class JobError extends Error {
  readonly code: JobErrorCode;

  constructor(code: JobErrorCode) {
    super(code);
    this.name = 'JobError';
    this.code = code;
  }
}

/** The only error detail that may be persisted or logged for a job. */
export function jobErrorCode(error: unknown): JobErrorCode {
  try {
    if (!(error instanceof JobError)) return 'handler_error';
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (descriptor === undefined || !('value' in descriptor)) return 'handler_error';
    const code: unknown = descriptor.value;
    return typeof code === 'string' && JOB_ERROR_CODES.has(code)
      ? (code as JobErrorCode)
      : 'handler_error';
  } catch {
    return 'handler_error';
  }
}

export interface JobContext {
  readonly org: OrgContext;
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly fence: number;
  readonly signal: AbortSignal;
  readonly ports: PluginPorts;
  readonly observability: Observability;
  readonly fences?: JobFences;
}

export interface JobDefinition<P = unknown> {
  readonly name: string;
  readonly version: number;
  readonly validate: (input: unknown) => P;
  readonly handler: (payload: P, context: JobContext) => Promise<void>;
  readonly schedule?: { readonly everySeconds: number };
  readonly maxAttempts?: number;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'dead';

export type JobAttemptOutcome = 'running' | 'succeeded' | 'failed' | 'lease_expired' | 'released';

export interface JobAttemptSummary {
  readonly attempt: number;
  readonly outcome: JobAttemptOutcome;
  readonly errorCode: JobErrorCode | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface JobStatus {
  readonly id: string;
  readonly type: string;
  readonly state: JobState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAt: string;
  readonly lastErrorCode: JobErrorCode | null;
  readonly history: readonly JobAttemptSummary[];
}

export interface EnqueueInput {
  readonly idempotencyKey: string;
  readonly resourceKey?: string;
  readonly runAt?: string;
}

export interface Jobs {
  enqueue(
    ctx: OrgContext,
    type: string,
    payload: unknown,
    input: EnqueueInput,
  ): Promise<{ id: string; created: boolean }>;
  get(ctx: OrgContext, id: string): Promise<JobStatus | null>;
}

function assertName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_NAME_LENGTH ||
    value === RESERVED_NAME ||
    !NAME_PATTERN.test(value)
  ) {
    throw new JobError('invalid_name');
  }
}

export function isReservedPluginId(value: string): boolean {
  return RESERVED_PLUGIN_IDS.has(value);
}

export function assertPluginId(value: string): void {
  assertName(value);
  if (isReservedPluginId(value)) throw new JobError('invalid_name');
}

function assertVersion(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new JobError('invalid_version');
  }
}

export function qualifyJobName(pluginId: string, name: string, version: number): string {
  assertPluginId(pluginId);
  assertName(name);
  assertVersion(version);
  return `${pluginId}:${name}:v${version}`;
}

export function validateSchedule(schedule: { readonly everySeconds: number }): void {
  const every: unknown = schedule?.everySeconds;
  if (
    typeof every !== 'number' ||
    !Number.isSafeInteger(every) ||
    every < MIN_SCHEDULE_SECONDS ||
    every % 60 !== 0
  ) {
    throw new JobError('invalid_schedule');
  }
}

function readOwn(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw new JobError('invalid_definition');
  return descriptor.value;
}

/**
 * Reads every field once, validates the copies and freezes them; accessor properties are
 * rejected, so a getter cannot return different values to validation and to the registry.
 */
export function defineJob<P>(definition: JobDefinition<P>): JobDefinition<P> {
  if (typeof definition !== 'object' || definition === null) {
    throw new JobError('invalid_definition');
  }
  const name = readOwn(definition, 'name');
  const version = readOwn(definition, 'version');
  const validate = readOwn(definition, 'validate');
  const handler = readOwn(definition, 'handler');
  const scheduleInput = readOwn(definition, 'schedule');
  const maxAttempts = readOwn(definition, 'maxAttempts');
  assertName(name);
  assertVersion(version);
  if (typeof validate !== 'function' || typeof handler !== 'function') {
    throw new JobError('invalid_definition');
  }
  if (
    maxAttempts !== undefined &&
    (typeof maxAttempts !== 'number' ||
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > MAX_JOB_ATTEMPTS)
  ) {
    throw new JobError('invalid_definition');
  }
  let schedule: { readonly everySeconds: number } | undefined;
  if (scheduleInput !== undefined) {
    if (typeof scheduleInput !== 'object' || scheduleInput === null) {
      throw new JobError('invalid_schedule');
    }
    const everySeconds = readOwn(scheduleInput, 'everySeconds');
    if (typeof everySeconds !== 'number') throw new JobError('invalid_schedule');
    validateSchedule({ everySeconds });
    schedule = Object.freeze({ everySeconds });
  }
  return Object.freeze({
    name,
    version,
    validate: validate as JobDefinition<P>['validate'],
    handler: handler as JobDefinition<P>['handler'],
    ...(schedule === undefined ? {} : { schedule }),
    ...(maxAttempts === undefined ? {} : { maxAttempts: maxAttempts as number }),
  });
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

interface Sink {
  readonly parts: string[];
  bytes: number;
  nodes: number;
}

const encoder = new TextEncoder();

function emit(sink: Sink, text: string): void {
  if (text.length > MAX_PAYLOAD_BYTES) throw new JobError('payload_too_large');
  sink.bytes += encoder.encode(text).length;
  if (sink.bytes > MAX_PAYLOAD_BYTES) throw new JobError('payload_too_large');
  sink.parts.push(text);
}

function visit(sink: Sink, value: unknown, ancestors: object[]): void {
  sink.nodes += 1;
  if (sink.nodes > MAX_PAYLOAD_NODES) throw new JobError('payload_too_large');
  switch (typeof value) {
    case 'string':
      if (value.length > MAX_PAYLOAD_BYTES) throw new JobError('payload_too_large');
      if (EMAIL_VALUE_PATTERN.test(value)) throw new JobError('invalid_payload');
      emit(sink, JSON.stringify(value));
      return;
    case 'boolean':
      emit(sink, value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new JobError('invalid_payload');
      emit(sink, JSON.stringify(value));
      return;
    case 'object':
      break;
    default:
      throw new JobError('invalid_payload');
  }
  if (value === null) {
    emit(sink, 'null');
    return;
  }
  if (ancestors.includes(value)) throw new JobError('invalid_payload');
  if (ancestors.length >= MAX_PAYLOAD_DEPTH) throw new JobError('invalid_payload');
  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new JobError('invalid_payload');
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new JobError('invalid_payload');
      emit(sink, '[');
      for (let i = 0; i < value.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, i);
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new JobError('invalid_payload');
        }
        if (i > 0) emit(sink, ',');
        visit(sink, descriptor.value, ancestors);
      }
      emit(sink, ']');
      return;
    }
    if (!isPlainObject(value)) throw new JobError('invalid_payload');
    const keys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key) || SECRET_KEY_PATTERN.test(key)) {
        throw new JobError('invalid_payload');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw new JobError('invalid_payload');
      }
      keys.push(key);
      if (keys.length > MAX_PAYLOAD_NODES) throw new JobError('payload_too_large');
    }
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    emit(sink, '{');
    keys.forEach((key, index) => {
      if (index > 0) emit(sink, ',');
      if (key.length > MAX_PAYLOAD_BYTES) throw new JobError('payload_too_large');
      emit(sink, `${JSON.stringify(key)}:`);
      visit(
        sink,
        (Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor).value,
        ancestors,
      );
    });
    emit(sink, '}');
  } finally {
    ancestors.pop();
  }
}

/**
 * Canonical key-sorted JSON of at most 16 KiB of UTF-8. Serialization stops at the first byte or
 * node over budget, so hostile shapes (shared-reference DAGs, huge strings) fail fast.
 * Rejected: non-plain values, cycles, accessors, non-finite numbers, depth over 32, the keys
 * `__proto__`/`constructor`/`prototype`, and keys named like a credential
 * (password, secret, token, authorization, cookie, api_key/apikey, email/e_mail; case-insensitive),
 * and string values shaped like an e-mail address.
 * These credential and e-mail rules are cheap guards for references-only payloads, not detectors.
 */
export function canonicalPayload(payload: unknown): string {
  const sink: Sink = { parts: [], bytes: 0, nodes: 0 };
  visit(sink, payload, []);
  return sink.parts.join('');
}

export function validateJobPayload(payload: unknown): string {
  return canonicalPayload(payload);
}

/**
 * Runs a definition's validate on a JSON round-trip of the canonical payload, so a Proxy or a
 * getter on the caller's object never reaches plugin code.
 */
export function validateWithDefinition<P>(definition: JobDefinition<P>, payload: unknown): P {
  return definition.validate(JSON.parse(canonicalPayload(payload)) as unknown);
}

/** SHA-256 hex of the canonical payload, used for idempotency equality. */
export async function hashPayload(payload: unknown): Promise<string> {
  const text = validateJobPayload(payload);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 1..160 printable ASCII characters, not starting with the runtime-reserved `schedule:`. */
export function validateIdempotencyKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !PRINTABLE_ASCII.test(key) ||
    key.startsWith(RESERVED_KEY_PREFIX)
  ) {
    throw new JobError('invalid_idempotency_key');
  }
}

export interface ParsedJobName {
  readonly pluginId: string;
  readonly name: string;
  readonly version: number;
}

export function parseQualifiedJobName(qualified: string): ParsedJobName {
  if (typeof qualified !== 'string' || !QUALIFIED_NAME_PATTERN.test(qualified)) {
    throw new JobError('invalid_name');
  }
  const [pluginId = '', name = '', versionText = ''] = qualified.split(':');
  const version = Number(versionText.slice(1));
  if (
    name === RESERVED_NAME ||
    pluginId.length > MAX_NAME_LENGTH ||
    name.length > MAX_NAME_LENGTH ||
    !Number.isSafeInteger(version)
  ) {
    throw new JobError('invalid_name');
  }
  return { pluginId, name, version };
}

export function assertQualifiedJobName(qualified: string): void {
  parseQualifiedJobName(qualified);
}

/**
 * Throws unless the qualified type belongs to the plugin. The enqueue port and the registry call
 * this; this module only supplies the check.
 */
export function assertJobOwnedBy(pluginId: string, qualifiedType: string): void {
  assertPluginId(pluginId);
  if (parseQualifiedJobName(qualifiedType).pluginId !== pluginId) {
    throw new JobError('invalid_name');
  }
}

/** `<qualifiedType>:<key>`; at most 146 + 1 + 160 = 307 characters. */
export function storedIdempotencyKey(qualifiedType: string, key: string): string {
  assertQualifiedJobName(qualifiedType);
  validateIdempotencyKey(key);
  return `${qualifiedType}:${key}`;
}

/** Accepts only `YYYY-MM-DDTHH:MM:SS.sssZ` naming a real instant, so lexicographic order holds.
 * The instant is not bounded; the enqueue path applies any horizon check. */
export function normalizeRunAt(value: string): string {
  if (typeof value !== 'string') throw new JobError('invalid_run_at');
  const match = RUN_AT_PATTERN.exec(value);
  if (match === null) throw new JobError('invalid_run_at');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new JobError('invalid_run_at');
  }
  return value;
}

/** min(3600, 5*2^(attempt-1)) scaled by a jitter of 0.8 + 0.2*random, random in [0,1]. */
export function retryDelaySeconds(attempt: number, random: () => number = Math.random): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new JobError('invalid_attempt');
  const r = random();
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 1) {
    throw new JobError('invalid_attempt');
  }
  const exponent = Math.min(attempt - 1, 30);
  const base = Math.min(RETRY_CAP_SECONDS, RETRY_BASE_SECONDS * 2 ** exponent);
  return base * (0.8 + 0.2 * r);
}
