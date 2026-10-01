import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createTokenBroker, loadConfig, MODEL, TOKEN_ENDPOINT } from './index.mjs';

const extensionId = 'a'.repeat(32);
const origin = `chrome-extension://${extensionId}`;
const rootKey = 'root_key_for_mock_tests_only';
const accessToken = 'broker_access_token_for_mock_tests_only';
const firefoxOrigin = 'moz-extension://12345678-abcd-4321-bcde-123456789abc';
const safariOrigin = 'safari-web-extension://ABCDEF01-2345-6789-ABCD-EF0123456789';
const fixedNow = 1_800_000_000_000;
const sample = { apiKey: 'ek_mock_short_lived_token', expiresAt: new Date(fixedNow + 300_000).toISOString() };

async function fixture(t, overrides = {}) {
  const server = createTokenBroker({
    config: loadConfig({ DECART_API_KEY: rootKey, ALLOWED_EXTENSION_ID: extensionId }),
    fetchImpl: async () => Response.json(sample),
    now: () => fixedNow,
    ...overrides,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const port = server.address().port;
  return ({ method = 'POST', path = '/api/token', body = '{}', headers = {}, withOrigin = true } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path,
      headers: { ...(withOrigin ? { Origin: origin } : {}), 'Content-Type': 'application/json', ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('uses the official restricted token API and returns only the short-lived credential', async t => {
  let calls = 0;
  const request = await fixture(t, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, TOKEN_ENDPOINT);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-API-KEY'], rootKey);
    assert.deepEqual(JSON.parse(options.body), {
      expiresIn: 300, allowedModels: [MODEL], allowedOrigins: [origin],
      constraints: { realtime: { maxSessionDuration: 300 } },
    });
    return Response.json({ ...sample, token: 'unused_jwt', permissions: { models: [MODEL] } });
  } });
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, sample);
  assert.equal(response.headers['access-control-allow-origin'], origin);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.text.includes(rootKey), false);
  assert.equal(calls, 1);
});

test('rejects missing, other-extension, web, null and lookalike origins without calling upstream', async t => {
  const request = await fixture(t, { fetchImpl: async () => assert.fail('Must not mint a token') });
  const requests = [
    { withOrigin: false },
    ...['null', 'https://shop.example', 'http://127.0.0.1:5173', `chrome-extension://${'b'.repeat(32)}`, `${origin}.evil.test`, `${origin}/`]
      .map(value => ({ headers: { Origin: value } })),
  ];
  for (const options of requests) {
    const response = await request(options);
    assert.equal(response.status, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
});

test('validates Host against the listening loopback port', async t => {
  const request = await fixture(t, { fetchImpl: async () => assert.fail('Must not mint a token') });
  const response = await request({ headers: { Host: 'attacker.test' } });
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'LOCAL_ONLY');
});

test('requires bounded, uncompressed, empty JSON object bodies', async t => {
  const request = await fixture(t, { fetchImpl: async () => assert.fail('Must not mint a token') });
  for (const body of ['', 'null', '[]', 'true', '{', '{"expiresIn":3600}', '{"__proto__":{}}']) {
    assert.equal((await request({ body })).status, 400);
  }
  assert.equal((await request({ body: '{' + ' '.repeat(1100) + '}' })).status, 413);
  assert.equal((await request({ body: ' '.repeat(2000), headers: { 'Content-Length': '2000' } })).status, 413);
  assert.equal((await request({ headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request({ headers: { 'Content-Encoding': 'gzip' } })).status, 415);
});

test('CORS preflight accepts only configured origin, route method and permitted headers', async t => {
  const request = await fixture(t, { fetchImpl: async () => assert.fail('Must not mint a token') });
  const response = await request({ method: 'OPTIONS', body: '', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
  } });
  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], origin);
  assert.equal(response.headers['access-control-allow-methods'], 'POST');
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
  assert.equal((await request({ method: 'OPTIONS', body: '', headers: { 'Access-Control-Request-Method': 'GET' } })).status, 403);
  assert.equal((await request({ method: 'OPTIONS', body: '', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization',
  } })).status, 204);
  assert.equal((await request({ method: 'OPTIONS', body: '', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-unexpected',
  } })).status, 403);
});

test('health exposes booleans only and reports missing configuration', async t => {
  const request = await fixture(t, { config: loadConfig({ ALLOWED_EXTENSION_ID: extensionId }) });
  const health = await request({ method: 'GET', path: '/health', body: '', withOrigin: false });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: false, configured: false, apiKeyConfigured: false,
    extensionConfigured: true, developmentOriginConfigured: false, brokerAuthConfigured: false, mobileOriginsConfigured: false });
  assert.equal(Object.values(health.json).every(value => typeof value === 'boolean'), true);
  assert.equal((await request()).status, 503);
});

test('an explicitly configured local development origin is exact and bound upstream', async t => {
  const devOrigin = 'http://127.0.0.1:5173';
  const request = await fixture(t, {
    config: loadConfig({ DECART_API_KEY: rootKey, DEV_ORIGIN: devOrigin }),
    fetchImpl: async (_, options) => {
      assert.deepEqual(JSON.parse(options.body).allowedOrigins, [devOrigin]);
      return Response.json(sample);
    },
  });
  assert.equal((await request({ headers: { Origin: devOrigin } })).status, 200);
  assert.equal((await request({ headers: { Origin: 'http://localhost:5173' } })).status, 403);
  assert.equal((await request()).status, 403);
});

test('rejects unsafe or malformed configuration', () => {
  for (const env of [
    { ALLOWED_EXTENSION_ID: '*' }, { ALLOWED_EXTENSION_ID: 'a'.repeat(31) },
    { DEV_ORIGIN: '*' }, { DEV_ORIGIN: 'https://example.com' }, { DEV_ORIGIN: 'http://127.0.0.1:5173/' },
    { DEV_ORIGIN: 'http://user@127.0.0.1:5173' }, { DEV_ORIGIN: 'http://localhost:5173/path' },
    { PORT: '0' }, { PORT: '65536' }, { PORT: '8787junk' }, { DECART_API_KEY: 'bad\nkey' },
  ]) assert.throws(() => loadConfig(env));
  assert.deepEqual(loadConfig({ HOST: '0.0.0.0' }).origins, []);
});

test('limits issuance to six calls per minute and recovers after the window', async t => {
  let now = fixedNow;
  let calls = 0;
  const request = await fixture(t, { now: () => now, fetchImpl: async () => {
    calls++;
    return Response.json({ ...sample, expiresAt: new Date(now + 300_000).toISOString() });
  } });
  for (let index = 0; index < 6; index++) assert.equal((await request()).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'RATE_LIMITED');
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(calls, 6);
  now += 60_000;
  assert.equal((await request()).status, 200);
  assert.equal(calls, 7);
});

test('allows only one upstream token issuance in flight', async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const upstream = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const request = await fixture(t, { fetchImpl: async () => { calls++; entered(); return upstream; } });
  const first = request();
  await started;
  const second = await request();
  assert.equal(second.status, 429);
  assert.equal(second.json.error.code, 'TOKEN_PENDING');
  release(Response.json(sample));
  assert.equal((await first).status, 200);
  assert.equal(calls, 1);
});

test('upstream errors and malformed tokens are sanitized, and root keys never pass through', async t => {
  const upstreamResults = [
    () => { throw new Error(rootKey); },
    () => new Response(rootKey, { status: 401 }),
    () => Response.json({ apiKey: rootKey, expiresAt: sample.expiresAt }),
    () => Response.json({ apiKey: 'ek_expired', expiresAt: new Date(fixedNow - 1).toISOString() }),
    () => Response.json({ apiKey: 'ek_too_long_lived', expiresAt: new Date(fixedNow + 3_600_000).toISOString() }),
    () => new Response('invalid json'),
  ];
  const request = await fixture(t, { fetchImpl: async () => upstreamResults.shift()() });
  for (let index = 0; index < 6; index++) {
    const response = await request();
    assert.equal(response.status, 502);
    assert.equal(response.json.error.code, 'TOKEN_UNAVAILABLE');
    assert.equal(response.text.includes(rootKey), false);
    assert.equal('apiKey' in response.json, false);
  }
});

test('does not offer arbitrary methods, paths or upstream proxy routes', async t => {
  const request = await fixture(t, { fetchImpl: async () => assert.fail('Must not mint a token') });
  assert.equal((await request({ method: 'GET', body: '' })).status, 405);
  assert.equal((await request({ path: '/v1/client/tokens' })).status, 404);
  assert.equal((await request({ path: '/api/token?model=other' })).status, 404);
});

test('mobile origins require a distinct, sufficiently long access token at configuration time', () => {
  assert.throws(() => loadConfig({ ALLOWED_EXTENSION_ORIGINS: firefoxOrigin }));
  for (const token of ['short', 'x'.repeat(31), 'x'.repeat(257), 'x'.repeat(32) + '\nsecret']) {
    assert.throws(() => loadConfig({ BROKER_ACCESS_TOKEN: token }));
  }
  assert.throws(() => loadConfig({ DECART_API_KEY: accessToken, BROKER_ACCESS_TOKEN: accessToken }));
  const config = loadConfig({ BROKER_ACCESS_TOKEN: accessToken, ALLOWED_EXTENSION_ORIGINS: `${firefoxOrigin}, ${safariOrigin}` });
  assert.deepEqual(config.origins, [firefoxOrigin, safariOrigin]);
});

test('mobile origin allowlist rejects opaque origins, websites, wildcards and altered URLs', () => {
  for (const value of ['null', '*', 'https://example.com', 'http://127.0.0.1:5173',
    'moz-extension://*', 'safari-web-extension://not-a-uuid', `${firefoxOrigin}/`, `${firefoxOrigin}:80`,
    `${firefoxOrigin}?x=1`, `${firefoxOrigin}#x`, `${firefoxOrigin},`, `${firefoxOrigin},null`,
    'moz-extension://user@12345678-abcd-4321-bcde-123456789abc']) {
    assert.throws(() => loadConfig({ BROKER_ACCESS_TOKEN: accessToken, ALLOWED_EXTENSION_ORIGINS: value }));
  }
});

test('mobile health and token routes require exact Bearer authorization and leak no secrets', async t => {
  const request = await fixture(t, {
    config: loadConfig({ DECART_API_KEY: rootKey, BROKER_ACCESS_TOKEN: accessToken, ALLOWED_EXTENSION_ORIGINS: firefoxOrigin }),
    fetchImpl: async () => assert.fail('Unauthenticated calls must not mint a token'),
  });
  for (const authorization of [undefined, 'Bearer wrong', `bearer ${accessToken}`, `Bearer ${accessToken}x`, `Bearer ${rootKey}`]) {
    const headers = { Origin: firefoxOrigin, ...(authorization ? { Authorization: authorization } : {}) };
    for (const route of [{}, { method: 'GET', path: '/health', body: '' }]) {
      const response = await request({ ...route, headers });
      assert.equal(response.status, 401);
      assert.equal(response.json.error.code, 'UNAUTHORIZED');
      assert.equal(response.headers['access-control-allow-origin'], firefoxOrigin);
      assert.match(response.headers['www-authenticate'], /^Bearer /);
      assert.equal(response.text.includes(rootKey), false);
      assert.equal(response.text.includes(accessToken), false);
    }
  }
  assert.equal((await request({ method: 'GET', path: '/health', body: '', withOrigin: false })).status, 401);
});

test('authenticated mobile requests bind exact origin upstream and never send the broker token to Decart', async t => {
  let upstreamCalls = 0;
  const request = await fixture(t, {
    config: loadConfig({ DECART_API_KEY: rootKey, BROKER_ACCESS_TOKEN: accessToken,
      ALLOWED_EXTENSION_ORIGINS: `${firefoxOrigin},${safariOrigin}` }),
    fetchImpl: async (url, options) => {
      upstreamCalls++;
      assert.equal(url, TOKEN_ENDPOINT);
      assert.equal(options.headers['X-API-KEY'], rootKey);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(JSON.stringify(options).includes(accessToken), false);
      assert.ok([firefoxOrigin, safariOrigin].includes(JSON.parse(options.body).allowedOrigins[0]));
      return Response.json({ ...sample, rootKey, brokerToken: accessToken });
    },
  });
  for (const mobileOrigin of [firefoxOrigin, safariOrigin]) {
    const headers = { Origin: mobileOrigin, Authorization: `Bearer ${accessToken}` };
    const health = await request({ method: 'GET', path: '/health', body: '', headers });
    assert.equal(health.status, 200);
    assert.equal(health.json.configured, true);
    assert.equal(health.json.brokerAuthConfigured, true);
    assert.equal(health.json.mobileOriginsConfigured, true);
    assert.equal(Object.values(health.json).every(value => typeof value === 'boolean'), true);
    const token = await request({ headers });
    assert.equal(token.status, 200);
    assert.deepEqual(token.json, sample);
    assert.equal(token.headers['access-control-allow-origin'], mobileOrigin);
    assert.equal(token.text.includes(rootKey), false);
    assert.equal(token.text.includes(accessToken), false);
  }
  assert.equal(upstreamCalls, 2);
});

test('valid broker credentials do not bypass Origin or Host checks', async t => {
  const request = await fixture(t, {
    config: loadConfig({ DECART_API_KEY: rootKey, BROKER_ACCESS_TOKEN: accessToken, ALLOWED_EXTENSION_ORIGINS: firefoxOrigin }),
    fetchImpl: async () => assert.fail('Denied requests must not mint a token'),
  });
  for (const deniedOrigin of [origin, safariOrigin, 'null', 'https://example.com', `${firefoxOrigin}/`]) {
    assert.equal((await request({ headers: { Origin: deniedOrigin, Authorization: `Bearer ${accessToken}` } })).status, 403);
  }
  assert.equal((await request({ withOrigin: false, headers: { Authorization: `Bearer ${accessToken}` } })).status, 403);
  const response = await request({ headers: { Origin: firefoxOrigin, Authorization: `Bearer ${accessToken}`,
    Host: 'broker.example.com', 'X-Forwarded-Host': '127.0.0.1:8787', 'X-Forwarded-For': '127.0.0.1' } });
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'LOCAL_ONLY');
});

test('mobile CORS preflight is credential-free but only permits configured origins', async t => {
  const request = await fixture(t, {
    config: loadConfig({ DECART_API_KEY: rootKey, BROKER_ACCESS_TOKEN: accessToken, ALLOWED_EXTENSION_ORIGINS: firefoxOrigin }),
    fetchImpl: async () => assert.fail('Preflight must not mint a token'),
  });
  for (const [path, method] of [['/health', 'GET'], ['/api/token', 'POST']]) {
    const headers = { Origin: firefoxOrigin, 'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': 'content-type, authorization' };
    const response = await request({ method: 'OPTIONS', path, body: '', headers });
    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-headers'], 'Content-Type, Authorization');
    assert.equal((await request({ method: 'OPTIONS', path, body: '', headers: { ...headers, Origin: safariOrigin } })).status, 403);
  }
});

test('enabling access authentication also protects the original Chrome-only mode', async t => {
  const request = await fixture(t, { config: loadConfig({ DECART_API_KEY: rootKey,
    ALLOWED_EXTENSION_ID: extensionId, BROKER_ACCESS_TOKEN: accessToken }) });
  assert.equal((await request()).status, 401);
  assert.equal((await request({ method: 'GET', path: '/health', body: '' })).status, 401);
  assert.equal((await request({ headers: { Authorization: `Bearer ${accessToken}` } })).status, 200);
});

test('a reflected broker access credential is never returned as an upstream client token', async t => {
  const tokenWithEphemeralPrefix = 'ek_broker_access_credential_for_tests_only';
  const request = await fixture(t, {
    config: loadConfig({ DECART_API_KEY: rootKey, BROKER_ACCESS_TOKEN: tokenWithEphemeralPrefix, ALLOWED_EXTENSION_ORIGINS: firefoxOrigin }),
    fetchImpl: async () => Response.json({ apiKey: tokenWithEphemeralPrefix, expiresAt: sample.expiresAt }),
  });
  const response = await request({ headers: { Origin: firefoxOrigin, Authorization: `Bearer ${tokenWithEphemeralPrefix}` } });
  assert.equal(response.status, 502);
  assert.equal(response.text.includes(tokenWithEphemeralPrefix), false);
});
