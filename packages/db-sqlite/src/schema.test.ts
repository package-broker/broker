import { describe, expect, it } from 'vitest';
import type { Insertable } from 'kysely';
import { compile, db, existsGuard } from './kysely.js';
import type { Database } from './kysely.js';

describe('identity table types', () => {
  it('compiles a select of every user_account column', () => {
    const statement = compile(
      db
        .selectFrom('user_account')
        .select([
          'id',
          'org_id',
          'email',
          'display_name',
          'status',
          'last_login_at',
          'idp_validated_at',
          'created_at',
          'updated_at',
        ]),
    );

    expect(statement.sql).toBe(
      'select "id", "org_id", "email", "display_name", "status", "last_login_at", "idp_validated_at", "created_at", "updated_at" from "user_account"',
    );
  });

  it('compiles a select of every identity column', () => {
    const statement = compile(
      db
        .selectFrom('identity')
        .select([
          'id',
          'org_id',
          'user_id',
          'provider',
          'subject',
          'email',
          'email_verified',
          'validated_at',
          'created_at',
          'updated_at',
        ]),
    );

    expect(statement.sql).toBe(
      'select "id", "org_id", "user_id", "provider", "subject", "email", "email_verified", "validated_at", "created_at", "updated_at" from "identity"',
    );
  });

  it('compiles a select of every user_group column', () => {
    const statement = compile(
      db
        .selectFrom('user_group')
        .select(['org_id', 'user_id', 'provider', 'group_name', 'refreshed_at']),
    );

    expect(statement.sql).toBe(
      'select "org_id", "user_id", "provider", "group_name", "refreshed_at" from "user_group"',
    );
  });

  it('compiles a select of every session column', () => {
    const statement = compile(
      db
        .selectFrom('session')
        .select([
          'id',
          'org_id',
          'user_id',
          'identity_id',
          'secret_hash',
          'csrf_hash',
          'created_at',
          'expires_at',
          'last_seen_at',
          'reauth_at',
          'revoked_at',
          'ip',
          'user_agent',
        ]),
    );

    expect(statement.sql).toBe(
      'select "id", "org_id", "user_id", "identity_id", "secret_hash", "csrf_hash", "created_at", "expires_at", "last_seen_at", "reauth_at", "revoked_at", "ip", "user_agent" from "session"',
    );
  });

  it('compiles a select of every role column', () => {
    const statement = compile(
      db
        .selectFrom('role')
        .select([
          'id',
          'org_id',
          'key',
          'name',
          'scope',
          'is_system',
          'protects_last_holder',
          'created_at',
          'updated_at',
        ]),
    );

    expect(statement.sql).toBe(
      'select "id", "org_id", "key", "name", "scope", "is_system", "protects_last_holder", "created_at", "updated_at" from "role"',
    );
  });

  it('compiles a select of every role_permission column', () => {
    const statement = compile(
      db.selectFrom('role_permission').select(['org_id', 'role_id', 'permission']),
    );

    expect(statement.sql).toBe('select "org_id", "role_id", "permission" from "role_permission"');
  });

  it('compiles a select of every access_grant column', () => {
    const statement = compile(
      db
        .selectFrom('access_grant')
        .select([
          'id',
          'org_id',
          'subject_type',
          'subject_value',
          'subject_provider',
          'scope',
          'project_id',
          'role_id',
          'created_by',
          'created_at',
          'updated_at',
        ]),
    );

    expect(statement.sql).toBe(
      'select "id", "org_id", "subject_type", "subject_value", "subject_provider", "scope", "project_id", "role_id", "created_by", "created_at", "updated_at" from "access_grant"',
    );
  });

  it('compiles a select of every project column', () => {
    const statement = compile(
      db
        .selectFrom('project')
        .select([
          'id',
          'org_id',
          'slug',
          'name',
          'status',
          'token_max_scope',
          'require_publish_approval',
          'created_at',
          'updated_at',
        ]),
    );

    expect(statement.sql).toBe(
      'select "id", "org_id", "slug", "name", "status", "token_max_scope", "require_publish_approval", "created_at", "updated_at" from "project"',
    );
  });

  it('compiles a select of every credential column', () => {
    const statement = compile(
      db
        .selectFrom('credential')
        .select([
          'id',
          'org_id',
          'project_id',
          'kind',
          'ciphertext',
          'nonce',
          'key_version',
          'aad',
          'rotated_at',
          'created_at',
          'updated_at',
        ]),
    );

    expect(statement.sql).toBe(
      'select "id", "org_id", "project_id", "kind", "ciphertext", "nonce", "key_version", "aad", "rotated_at", "created_at", "updated_at" from "credential"',
    );
  });

  it('compiles a select of every local_login column', () => {
    const statement = compile(
      db
        .selectFrom('local_login')
        .select([
          'user_id',
          'org_id',
          'password_hash',
          'totp_credential_id',
          'totp_enabled_at',
          'totp_last_step',
          'credential_rev',
          'setup_hash',
          'setup_expires_at',
          'failed_count',
          'locked_until',
          'last_op_id',
          'last_login_at',
          'created_at',
          'updated_at',
        ]),
    );

    expect(statement.sql).toBe(
      'select "user_id", "org_id", "password_hash", "totp_credential_id", "totp_enabled_at", "totp_last_step", "credential_rev", "setup_hash", "setup_expires_at", "failed_count", "locked_until", "last_op_id", "last_login_at", "created_at", "updated_at" from "local_login"',
    );
  });

  it('compiles a select of every identity_provider_binding column', () => {
    const statement = compile(
      db
        .selectFrom('identity_provider_binding')
        .select(['org_id', 'provider', 'anchor', 'created_at']),
    );

    expect(statement.sql).toBe(
      'select "org_id", "provider", "anchor", "created_at" from "identity_provider_binding"',
    );
  });

  it('rejects a select of a misspelt column', () => {
    // @ts-expect-error the column does not exist on session
    const query = db.selectFrom('session').select('user_agentt');

    expect(query).toBeDefined();
  });

  it('accepts a local_login insert without generated columns', () => {
    const query = db.insertInto('local_login').values({ user_id: 'user', org_id: 'org' });

    expect(query).toBeDefined();
  });

  it('rejects a local_login insert without user_id', () => {
    // @ts-expect-error user_id is required
    const query = db.insertInto('local_login').values({ org_id: 'org' });

    expect(query).toBeDefined();
  });
});

describe('0003 access-model table types', () => {
  it('compiles a select of every service_principal_permission column', () => {
    const statement = compile(
      db
        .selectFrom('service_principal_permission')
        .select(['org_id', 'service_principal_id', 'permission']),
    );

    expect(statement.sql).toBe(
      'select "org_id", "service_principal_id", "permission" from "service_principal_permission"',
    );
  });

  it('compiles a select of every identity_block column', () => {
    const statement = compile(
      db
        .selectFrom('identity_block')
        .select(['org_id', 'provider', 'issuer', 'subject', 'blocked_at', 'blocked_by_user_id']),
    );

    expect(statement.sql).toBe(
      'select "org_id", "provider", "issuer", "subject", "blocked_at", "blocked_by_user_id" from "identity_block"',
    );
  });

  it('compiles a select of every access_mutation_guard column', () => {
    const statement = compile(db.selectFrom('access_mutation_guard').select('key'));

    expect(statement.sql).toBe('select "key" from "access_mutation_guard"');
  });

  it('compiles a select of every service_principal column', () => {
    const statement = compile(
      db
        .selectFrom('service_principal')
        .select([
          'id',
          'org_id',
          'name',
          'project_id',
          'created_by_user_id',
          'status',
          'created_at',
          'updated_at',
          'revision',
          'last_op_id',
        ]),
    );

    expect(statement.sql).toBe(
      'select "id", "org_id", "name", "project_id", "created_by_user_id", "status", "created_at", "updated_at", "revision", "last_op_id" from "service_principal"',
    );
  });

  it('compiles a select of every token column', () => {
    const statement = compile(
      db
        .selectFrom('token')
        .select([
          'id',
          'org_id',
          'kind',
          'selector',
          'hash',
          'pepper_version',
          'name',
          'scopes_json',
          'read_only',
          'user_id',
          'service_principal_id',
          'customer_id',
          'project_id',
          'created_by_user_id',
          'expires_at',
          'revoked_at',
          'last_used_at',
          'created_at',
          'project_mode',
          'validation_kind',
          'validation_identity_id',
          'last_op_id',
        ]),
    );

    expect(statement.sql).toBe(
      'select "id", "org_id", "kind", "selector", "hash", "pepper_version", "name", "scopes_json", "read_only", "user_id", "service_principal_id", "customer_id", "project_id", "created_by_user_id", "expires_at", "revoked_at", "last_used_at", "created_at", "project_mode", "validation_kind", "validation_identity_id", "last_op_id" from "token"',
    );
  });

  it('compiles the revision and last_op_id columns added by 0003', () => {
    expect(compile(db.selectFrom('role').select(['revision', 'last_op_id'])).sql).toBe(
      'select "revision", "last_op_id" from "role"',
    );
    expect(compile(db.selectFrom('access_grant').select(['revision', 'last_op_id'])).sql).toBe(
      'select "revision", "last_op_id" from "access_grant"',
    );
    expect(compile(db.selectFrom('project').select(['revision', 'last_op_id'])).sql).toBe(
      'select "revision", "last_op_id" from "project"',
    );
    expect(compile(db.selectFrom('service_principal').select(['revision', 'last_op_id'])).sql).toBe(
      'select "revision", "last_op_id" from "service_principal"',
    );
  });

  it('accepts inserts that omit the generated revision column', () => {
    expect(
      db
        .insertInto('role')
        .values({ id: 'role', org_id: 'org', key: 'key', name: 'name', scope: 'organization' }),
    ).toBeDefined();
    expect(
      db.insertInto('access_grant').values({
        id: 'grant',
        org_id: 'org',
        subject_type: 'email',
        subject_value: 'a@example.test',
        scope: 'organization',
        role_id: 'role',
      }),
    ).toBeDefined();
    expect(
      db
        .insertInto('project')
        .values({ id: 'project', org_id: 'org', slug: 'alpha', name: 'Alpha' }),
    ).toBeDefined();
    expect(
      db.insertInto('service_principal').values({
        id: 'principal',
        org_id: 'org',
        name: 'principal',
        created_by_user_id: 'user',
      }),
    ).toBeDefined();
  });

  it('accepts a null last_op_id and a null blocked_by_user_id', () => {
    expect(
      db.insertInto('identity_block').values({
        org_id: 'org',
        provider: 'oidc',
        issuer: 'https://issuer.example.test',
        subject: 'sub-1',
        blocked_by_user_id: null,
      }),
    ).toBeDefined();
    expect(
      db.insertInto('access_grant').values({
        id: 'grant',
        org_id: 'org',
        subject_type: 'email',
        subject_value: 'a',
        scope: 'organization',
        role_id: 'role',
        last_op_id: null,
      }),
    ).toBeDefined();
  });

  it('requires every service_principal_permission column', () => {
    expect(
      db.insertInto('service_principal_permission').values({
        org_id: 'org',
        service_principal_id: 'principal',
        permission: 'project:read',
      }),
    ).toBeDefined();
    // @ts-expect-error service_principal_id is required
    const missing: Insertable<Database['service_principal_permission']> = {
      org_id: 'org',
      permission: 'p',
    };

    expect(missing).toBeDefined();
  });

  it('requires project_mode on a token insert', () => {
    // @ts-expect-error project_mode is required on a token insert
    const missing: Insertable<Database['token']> = {
      id: 't',
      org_id: 'org',
      kind: 'pat',
      selector: '000000000000',
      hash: 'h',
      pepper_version: 1,
      name: 'n',
      scopes_json: '[]',
    };

    expect(missing).toBeDefined();
  });

  it('rejects a null project_mode and a null access_mutation_guard key', () => {
    const token = db.insertInto('token').values({
      id: 't',
      org_id: 'org',
      kind: 'pat',
      selector: '000000000000',
      hash: 'h',
      pepper_version: 1,
      name: 'n',
      scopes_json: '[]',
      // @ts-expect-error project_mode is not nullable
      project_mode: null,
    });
    const guardKey = db.insertInto('access_mutation_guard').values({
      // @ts-expect-error key is not nullable
      key: null,
    });

    expect(token).toBeDefined();
    expect(guardKey).toBeDefined();
  });

  it('accepts the new tables through the existsGuard helper', () => {
    const guards = [
      existsGuard((builder) =>
        builder.selectFrom('service_principal_permission').select('permission'),
      ),
      existsGuard((builder) => builder.selectFrom('identity_block').select('subject')),
      existsGuard((builder) => builder.selectFrom('access_mutation_guard').select('key')),
    ];

    for (const guard of guards) {
      expect(compile(db.selectFrom('organization').select('id').where(guard)).sql).toContain(
        'exists',
      );
    }
  });
});
