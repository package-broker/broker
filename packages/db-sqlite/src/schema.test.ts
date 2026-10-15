import { describe, expect, it } from 'vitest';
import { compile, db } from './kysely.js';

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
