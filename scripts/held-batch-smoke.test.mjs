import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkHeldResponses, assertPrivate } from './held-batch-smoke.mjs';

function responses() {
  return ['a', 'b'].map((letter) => {
    const requestId = `${letter.repeat(8)}-1234-1234-1234-123456789012`;
    return {
      status: 500,
      requestId,
      body: { error: { code: 'internal', message: 'Internal error', requestId } },
    };
  });
}

test('held response guard accepts safe, distinct scopes', () => {
  checkHeldResponses(responses());
});

test('held response guard rejects success, leaks, and shared scopes', () => {
  const success = responses();
  success[0].status = 200;
  assert.throws(() => checkHeldResponses(success), /500/);
  const leaked = responses();
  leaked[0].body.error.message = 'T767-secret';
  assert.throws(() => checkHeldResponses(leaked));
  const shared = responses();
  shared[1] = shared[0];
  assert.throws(() => checkHeldResponses(shared), /distinct request ids/);
});

test('privacy guard rejects raw and JSON escaped hostile values', () => {
  assertPrivate('safe');
  for (const value of [
    'T767-secret\nBearer t767-credential',
    'account@t767.test',
    'user:password',
  ]) {
    assert.throws(() => assertPrivate(value), /private/);
    assert.throws(() => assertPrivate(JSON.stringify(value)), /private/);
  }
});
