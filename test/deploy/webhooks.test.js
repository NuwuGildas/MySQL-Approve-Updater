'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifySignature, pushedBranch, pushedCommit, eventKind, normalizeAutoShip } = require('../../lib/deploy/webhooks');

const secret = 'shh-very-secret';
const body = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', after: 'abcdef1234567890', head_commit: { id: 'abcdef1234567890' } }));
const url = new URL('http://localhost:3001/hooks/t1');

test('GitHub HMAC signature is verified with constant-time compare', () => {
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifySignature({ 'x-hub-signature-256': sig }, body, secret, url), null);
  assert.match(verifySignature({ 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body, secret, url), /bad X-Hub-Signature-256/);
  assert.match(verifySignature({ 'x-hub-signature-256': sig }, Buffer.from('tampered'), secret, url), /bad X-Hub-Signature-256/);
});
test('GitLab token, generic query token and bearer are accepted; nothing → rejected', () => {
  assert.equal(verifySignature({ 'x-gitlab-token': secret }, body, secret, url), null);
  assert.match(verifySignature({ 'x-gitlab-token': 'nope' }, body, secret, url), /bad X-Gitlab-Token/);
  assert.equal(verifySignature({}, body, secret, new URL('http://x/hooks/t1?token=' + secret)), null);
  assert.equal(verifySignature({ authorization: 'Bearer ' + secret }, body, secret, url), null);
  assert.match(verifySignature({}, body, secret, url), /no signature/);
  assert.match(verifySignature({ 'x-gitlab-token': secret }, body, '', url), /no webhook secret/);
});
test('push payload parsing across providers', () => {
  assert.equal(pushedBranch({ ref: 'refs/heads/main' }), 'main');
  assert.equal(pushedBranch({ ref: 'refs/heads/feature/x' }), 'feature/x');
  assert.equal(pushedBranch({ push: { changes: [{ new: { name: 'develop', target: { hash: 'ff00' } } }] } }), 'develop');
  assert.equal(pushedCommit({ push: { changes: [{ new: { target: { hash: 'ff00' } } }] } }), 'ff00');
  assert.equal(pushedCommit(JSON.parse(body.toString())), 'abcdef1234567890');
  assert.equal(eventKind({ 'x-github-event': 'push' }), 'github:push');
  assert.equal(eventKind({ 'x-gitlab-event': 'Push Hook' }), 'gitlab:push hook');
  assert.equal(eventKind({}), 'generic');
});
test('normalizeAutoShip keeps the secret across edits and rotates on demand', () => {
  assert.equal(normalizeAutoShip({}, null), null);
  const a = normalizeAutoShip({ autoShip: { enabled: true, mode: 'webhook', branch: 'main' } }, null);
  assert.equal(a.enabled, true); assert.equal(a.mode, 'webhook'); assert.equal(a.branch, 'main'); assert.equal(a.secret.length, 48);
  const b = normalizeAutoShip({ autoShip: { enabled: true, mode: 'poll', pollMinutes: 2 } }, { autoShip: a });
  assert.equal(b.secret, a.secret); assert.equal(b.mode, 'poll'); assert.equal(b.pollMinutes, 2);
  const c = normalizeAutoShip({ autoShip: { enabled: true, rotateSecret: true } }, { autoShip: a });
  assert.notEqual(c.secret, a.secret);
  const d = normalizeAutoShip({ autoShip: { enabled: false } }, { autoShip: a });
  assert.equal(d.enabled, false); assert.equal(d.secret, a.secret);
  assert.throws(() => normalizeAutoShip({ autoShip: { enabled: true, branch: 'bad branch;rm' } }, null), /invalid characters/);
});
