import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const TOKEN_ENDPOINT = 'https://api.decart.ai/v1/client/tokens';
export const MODEL = 'lucy-vton-3.5';
const BODY_LIMIT = 1024;
const TOKEN_TTL_SECONDS = 300;
const WINDOW_MS = 60_000;
const MAX_ISSUANCES = 6;

class BrokerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function loadConfig(env = process.env) {
  const apiKey = (env.DECART_API_KEY ?? '').trim();
  const extensionId = (env.ALLOWED_EXTENSION_ID ?? '').trim();
  const accessToken = (env.BROKER_ACCESS_TOKEN ?? '').trim();
  const extraOriginsText = (env.ALLOWED_EXTENSION_ORIGINS ?? '').trim();
  const extensionOrigins = extraOriginsText ? extraOriginsText.split(',').map(value => value.trim()) : [];
  const devOrigin = (env.DEV_ORIGIN ?? '').trim();
  const portText = (env.PORT ?? '8787').trim();
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  if (extensionId && !/^[a-p]{32}$/.test(extensionId)) {
    throw new Error('ALLOWED_EXTENSION_ID must be a 32-character Chrome extension ID.');
  }
  if (accessToken && (accessToken.length < 32 || accessToken.length > 256
    || !/^[A-Za-z0-9._~+\/-]+={0,2}$/.test(accessToken) || accessToken === apiKey)) {
    throw new Error('BROKER_ACCESS_TOKEN must be a separate random token of 32 to 256 characters.');
  }
  // These schemes identify extension pages; normal websites and opaque origins are never accepted here.
  const mobileOrigin = /^(?:moz-extension|safari-web-extension):\/\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (extensionOrigins.length > 20 || extensionOrigins.some(value => !mobileOrigin.test(value))) {
    throw new Error('ALLOWED_EXTENSION_ORIGINS must contain only exact moz-extension://UUID or safari-web-extension://UUID origins.');
  }
  if (extensionOrigins.length && !accessToken) {
    throw new Error('Additional extension origins require BROKER_ACCESS_TOKEN.');
  }
  // A deliberate, exact development origin is required; never accept a wildcard.
  if (devOrigin) {
    let parsed;
    try { parsed = new URL(devOrigin); } catch { /* validated below */ }
    if (!parsed || parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || !parsed.port || parsed.origin !== devOrigin) {
      throw new Error('DEV_ORIGIN must be an exact http://127.0.0.1:port or http://localhost:port origin.');
    }
  }
  if (/\s/.test(apiKey)) throw new Error('DECART_API_KEY must not contain whitespace.');
  const origins = [...new Set([extensionId && `chrome-extension://${extensionId}`, ...extensionOrigins, devOrigin].filter(Boolean))];
  return Object.freeze({ apiKey, accessToken, extensionId, extensionOrigins: Object.freeze(extensionOrigins), devOrigin,
    origins: Object.freeze(origins), port: Number(portText) });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function readEmptyJson(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
    || req.headers['content-encoding']) {
    throw new BrokerError(415, 'JSON_REQUIRED', 'Send application/json with an empty object.');
  }
  if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT) {
    throw new BrokerError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAbort);
    };
    const fail = (error) => {
      cleanup();
      req.resume();
      reject(error);
    };
    const onError = () => fail(new BrokerError(400, 'INVALID_BODY', 'Unable to read request body.'));
    const onAbort = () => fail(new BrokerError(400, 'INVALID_BODY', 'Request was interrupted.'));
    const onData = (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) return fail(new BrokerError(413, 'BODY_TOO_LARGE', 'Request body is too large.'));
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length) throw new Error();
        resolve();
      } catch {
        reject(new BrokerError(400, 'INVALID_BODY', 'Request body must be an empty JSON object.'));
      }
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAbort);
  });
}

async function mintToken(config, origin, fetchImpl, now) {
  let response;
  try {
    // Official SDK contract: tokens/client.ts, shared/request.ts, create-client.ts.
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: { 'X-API-KEY': config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expiresIn: TOKEN_TTL_SECONDS,
        allowedModels: [MODEL],
        allowedOrigins: [origin],
        constraints: { realtime: { maxSessionDuration: TOKEN_TTL_SECONDS } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Upstream rejected token creation.');
    }
    const value = await response.json();
    const expires = Date.parse(value?.expiresAt);
    if (typeof value?.apiKey !== 'string' || !value.apiKey.startsWith('ek_')
      || value.apiKey.length > 8192 || value.apiKey === config.apiKey || value.apiKey === config.accessToken
      || !Number.isFinite(expires) || expires <= now() || expires > now() + (TOKEN_TTL_SECONDS + 60) * 1000) {
      throw new Error('Unexpected upstream response.');
    }
    // Deliberately return only the documented browser credential and expiry.
    return { apiKey: value.apiKey, expiresAt: value.expiresAt };
  } catch {
    throw new BrokerError(502, 'TOKEN_UNAVAILABLE', 'Unable to create a short-lived token. Check server configuration or retry later.');
  }
}

export function createTokenBroker({ config = loadConfig(), fetchImpl = fetch, now = Date.now } = {}) {
  const allowedOrigins = new Set(config.origins);
  // Hash both values to fixed-size buffers so even wrong-length candidates use a constant-time comparison.
  const authorizationDigest = config.accessToken
    ? createHash('sha256').update(`Bearer ${config.accessToken}`).digest() : null;
  let inFlight = false;
  let issuanceTimes = [];
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    let cors = {};
    try {
      const localPort = server.address()?.port;
      if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress)
        || ![`127.0.0.1:${localPort}`, `localhost:${localPort}`].includes(req.headers.host)) {
        throw new BrokerError(403, 'LOCAL_ONLY', 'Only local requests are accepted.');
      }
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) {
        throw new BrokerError(403, 'ORIGIN_DENIED', 'This origin is not allowed.');
      }
      if (origin) cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
      const isHealth = req.url === '/health';
      const isToken = req.url === '/api/token';
      if (!isHealth && !isToken) throw new BrokerError(404, 'NOT_FOUND', 'Route not found.');
      if (req.method === 'OPTIONS') {
        const method = isHealth ? 'GET' : 'POST';
        const requestedHeaders = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
        if (!origin || req.headers['access-control-request-method'] !== method
          || requestedHeaders.some(header => !['content-type', 'authorization'].includes(header))) {
          throw new BrokerError(403, 'PREFLIGHT_DENIED', 'Preflight request is not allowed.');
        }
        // A browser preflight has no bearer credential. It only authorizes the actual request to be sent.
        send(res, 204, undefined, { ...cors, 'Access-Control-Allow-Methods': method, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '300' });
        return;
      }
      if (authorizationDigest) {
        const supplied = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
        const suppliedDigest = createHash('sha256').update(supplied).digest();
        if (!timingSafeEqual(authorizationDigest, suppliedDigest)) {
          cors['WWW-Authenticate'] = 'Bearer realm="realtime-broker"';
          throw new BrokerError(401, 'UNAUTHORIZED', 'A valid broker access token is required.');
        }
      }
      if (isHealth && req.method === 'GET') {
        send(res, 200, {
          ok: Boolean(config.apiKey && allowedOrigins.size),
          configured: Boolean(config.apiKey && allowedOrigins.size),
          apiKeyConfigured: Boolean(config.apiKey),
          extensionConfigured: Boolean(config.extensionId || config.extensionOrigins?.length),
          developmentOriginConfigured: Boolean(config.devOrigin),
          brokerAuthConfigured: Boolean(config.accessToken),
          mobileOriginsConfigured: Boolean(config.extensionOrigins?.length),
        }, cors);
        return;
      }
      if (!isToken || req.method !== 'POST') {
        throw new BrokerError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      }
      if (!origin) throw new BrokerError(403, 'ORIGIN_REQUIRED', 'An allowed browser origin is required.');
      if (!config.apiKey || !allowedOrigins.size) throw new BrokerError(503, 'NOT_CONFIGURED', 'Token broker is not configured.');
      await readEmptyJson(req);
      const current = now();
      issuanceTimes = issuanceTimes.filter(time => time > current - WINDOW_MS);
      if (issuanceTimes.length >= MAX_ISSUANCES) {
        cors['Retry-After'] = String(Math.max(1, Math.ceil((issuanceTimes[0] + WINDOW_MS - current) / 1000)));
        throw new BrokerError(429, 'RATE_LIMITED', 'Too many token requests. Wait before trying again.');
      }
      if (inFlight) {
        cors['Retry-After'] = '2';
        throw new BrokerError(429, 'TOKEN_PENDING', 'A token request is already in progress.');
      }
      issuanceTimes.push(current);
      inFlight = true;
      try {
        const token = await mintToken(config, origin, fetchImpl, now);
        send(res, 200, token, cors);
      } finally { inFlight = false; }
    } catch (error) {
      const known = error instanceof BrokerError;
      if (!res.destroyed && !res.headersSent) send(res, known ? error.status : 500, {
        error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'Token broker encountered an error.' },
      }, cors);
      req.resume();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 50;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const server = createTokenBroker({ config });
    server.on('error', () => {
      console.error('Token broker could not start. Check that its port is available.');
      process.exitCode = 1;
    });
    server.listen(config.port, '127.0.0.1', () => {
      console.log(`Token broker listening on http://127.0.0.1:${config.port}`);
      if (!config.apiKey || !config.origins.length) console.log('Configuration incomplete. Set DECART_API_KEY and an allowed browser origin; see .env.example.');
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch {
    console.error('Token broker configuration is invalid. Check .env.example; no credential values were logged.');
    process.exitCode = 1;
  }
}
