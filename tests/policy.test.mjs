import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerOrigin, garmentSource, validateImage, MAX_IMAGE_BYTES, OperationGate } from '../src/policy.ts';

test('broker permits local HTTP or explicit HTTPS; insecure remote and URL secrets are rejected', () => {
  assert.equal(brokerOrigin('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(brokerOrigin('https://personal.example/'), 'https://personal.example');
  for (const url of ['http://remote.example', 'http://127.0.0.1.evil.test', 'http://user:secret@127.0.0.1:8787', 'http://127.0.0.1:8787/token', 'https://personal.example?token=example']) {
    assert.throws(() => brokerOrigin(url));
  }
});
test('garment inputs allow bounded raster formats only', () => {
  validateImage('image/png', 1024); validateImage('image/jpeg', MAX_IMAGE_BYTES);
  for (const [type, size] of [['image/svg+xml', 500], ['text/html', 500], ['image/png', 0], ['image/webp', MAX_IMAGE_BYTES + 1]]) assert.throws(() => validateImage(type, size));
});
test('web garment URLs cannot load scripts, file data or URL credentials', () => {
  assert.equal(garmentSource('https://example.com/shirt.jpg').hostname, 'example.com');
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,a', 'file:///private/image.png', 'https://user:password@example.com/image.jpg']) assert.throws(() => garmentSource(url));
});
test('a stop or newer start invalidates late camera and connection results', () => {
  const gate = new OperationGate();
  const old = gate.begin(); assert.equal(gate.current(old), true);
  gate.cancel(); assert.equal(gate.current(old), false);
  const fresh = gate.begin(); assert.equal(gate.current(fresh), true);
  gate.begin(); assert.equal(gate.current(fresh), false);
});
