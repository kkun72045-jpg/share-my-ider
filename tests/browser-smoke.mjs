/**
 * Standalone, offline browser smoke test (deliberately not a node:test file).
 * Build first, then run: node tests/browser-smoke.mjs
 * Optional: PLAYWRIGHT_MODULE / BROWSER_EXECUTABLE override local installations.
 * Uses an isolated temporary browser profile, synthetic canvas camera, and a
 * real local broker with no API key. Never returns a fake successful AI result.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTokenBroker, loadConfig } from '../server/index.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const bundledModules = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
let playwright;
for (const modulePath of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(bundledModules, 'playwright')].filter(Boolean)) {
  try { playwright = require(modulePath); break; } catch { /* Try next explicit local installation. */ }
}
assert.ok(playwright, 'No locally installed Playwright; set PLAYWRIGHT_MODULE.');
const { chromium } = playwright;
const browserPath = [
  process.env.BROWSER_EXECUTABLE,
  chromium.executablePath(),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find(existsSync);
assert.ok(browserPath, 'No usable local Chromium browser; no browser test was executed.');
assert.ok(existsSync(path.join(dist, 'panel.html')), 'Build dist/panel.html before this test.');
const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);

const result = { browser: browserPath, mode: '', checks: [], unverifiedChecks: [], failures: [], externalRequestsBlocked: [], cspViolations: [], pageErrors: [], tokenRequests: 0, upstreamCalls: 0, stoppedTracks: 0, mobileDeviceTesting: 'Not verified on Android or iPhone hardware' };
const profile = await mkdtemp(path.join(os.tmpdir(), 'realtime-engine-browser-'));
const allowedNetworkOrigins = new Set();
let context, broker, staticServer, fixtureServer;
const check = async (name, action) => {
  try {
    if (await action() === false) { result.unverifiedChecks.push(name); console.log(`UNVERIFIED ${name}`); }
    else { result.checks.push(name); console.log(`PASS ${name}`); }
  }
  catch (error) { result.failures.push(`${name}: ${error.message}`); console.error(`FAIL ${name}: ${error.message}`); }
};
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});
const closeServer = server => server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: browserPath,
    headless: true,
    viewport: { width: 420, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--enable-unsafe-extension-debugging', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    ],
  });
  context.setDefaultTimeout(6000);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (!['http:', 'https:'].includes(url.protocol) || allowedNetworkOrigins.has(url.origin)) return route.continue();
    result.externalRequestsBlocked.push(url.origin + url.pathname);
    return route.abort('blockedbyclient');
  });
  if (context.routeWebSocket) await context.routeWebSocket('**/*', ws => {
    result.externalRequestsBlocked.push(ws.url());
    ws.close({ code: 1008, reason: 'External networking disabled by offline smoke test' });
  });
  await context.exposeFunction('__qaTrackStopped', () => { result.stoppedTracks++; });
  await context.exposeFunction('__qaCspViolation', violation => { result.cspViolations.push(violation); });
  await context.addInitScript(() => {
    window.__qaMedia = { calls: 0, tracks: [], canvases: [] };
    addEventListener('securitypolicyviolation', event => {
      void window.__qaCspViolation({ directive: event.violatedDirective, blocked: event.blockedURI, sourceFile: event.sourceFile, line: event.lineNumber, column: event.columnNumber, sample: event.sample, document: event.documentURI });
    });
    // A real MediaStream from a synthetic canvas; no real getUserMedia call.
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        window.__qaMedia.calls++;
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 480;
        const drawing = canvas.getContext('2d');
        drawing.fillStyle = '#d8dfcc'; drawing.fillRect(0, 0, 640, 480);
        drawing.fillStyle = '#314c3a'; drawing.fillRect(220, 60, 200, 350);
        const stream = canvas.captureStream(15);
        window.__qaMedia.canvases.push(canvas);
        for (const track of stream.getTracks()) {
          window.__qaMedia.tracks.push(track);
          const stop = track.stop.bind(track);
          track.stop = () => { stop(); void window.__qaTrackStopped(); };
        }
        return stream;
      },
    });
  });

  let appUrl, origin;
  const browserSession = await context.browser().newBrowserCDPSession();
  result.browserVersion = (await browserSession.send('Browser.getVersion')).product;
  try {
    // Current branded Chrome/Edge removed --load-extension. CDP sideloading
    // is explicitly enabled only in this disposable testing profile.
    const extension = await browserSession.send('Extensions.loadUnpacked', { path: dist });
    assert.match(extension.id, /^[a-p]{32}$/);
    origin = `chrome-extension://${extension.id}`;
    appUrl = `${origin}/panel.html`;
    result.mode = 'MV3 extension loaded with Extensions.loadUnpacked';
    result.extensionId = extension.id;
  } catch (error) {
    result.extensionLoadError = error.message;
    result.failures.push(`MV3 extension loading was NOT verified: ${error.message}`);
    result.mode = 'static preview fallback (not an extension verification)';
    staticServer = http.createServer(async (req, res) => {
      try {
        const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
        const absolute = path.resolve(dist, relative || 'panel.html');
        if (!absolute.startsWith(dist + path.sep)) throw new Error('Outside dist');
        const data = await readFile(absolute);
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
        res.writeHead(200, { 'Content-Type': types[path.extname(absolute)] || 'application/octet-stream', 'Content-Security-Policy': manifest.content_security_policy.extension_pages });
        res.end(data);
      } catch { res.writeHead(404); res.end(); }
    });
    origin = await listen(staticServer);
    allowedNetworkOrigins.add(origin);
    appUrl = `${origin}/panel.html`;
  }
  const config = loadConfig({ DECART_API_KEY: '', ALLOWED_EXTENSION_ID: result.extensionId || '', DEV_ORIGIN: result.extensionId ? '' : origin, PORT: '8787' });
  broker = createTokenBroker({ config, fetchImpl: async () => {
    result.upstreamCalls++;
    throw new Error('Upstream deliberately blocked by offline smoke test');
  } });
  broker.on('request', request => { if (request.url === '/api/token' && request.method === 'POST') result.tokenRequests++; });
  const brokerOrigin = await listen(broker);
  allowedNetworkOrigins.add(brokerOrigin);
  const page = await context.newPage();
  page.on('pageerror', error => result.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /content.security.policy|refused to (execute|load|connect)/i.test(message.text())) result.cspViolations.push({ console: message.text() });
  });
  await page.goto(appUrl, { waitUntil: 'load' });
  await page.locator('#camera-start').waitFor();
  await mkdir(path.join(root, '.local'), { recursive: true });
  await page.screenshot({ path: path.join(root, '.local/panel.png'), fullPage: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'docs/preview.jpg'), type: 'jpeg', quality: 85, fullPage: true });
  await check('MV3 runtime and panel.html load', async () => {
    assert.ok(result.extensionId, 'Only static preview was available.');
    const runtime = await page.evaluate(() => ({ id: chrome.runtime.id, manifestVersion: chrome.runtime.getManifest().manifest_version }));
    assert.equal(runtime.id, result.extensionId);
    assert.equal(runtime.manifestVersion, 3);
    assert.equal(await page.locator('#extension-id').inputValue(), origin);
  });
  await check('desktop side panel configuration and no new-tab creation in background source', async () => {
    assert.equal(manifest.side_panel?.default_path, 'panel.html');
    assert.ok(manifest.permissions?.includes('sidePanel'));
    assert.equal(manifest.action?.default_popup, undefined, 'Desktop action should open the side panel.');
    const background = await readFile(path.join(root, 'src/background.ts'), 'utf8');
    assert.doesNotMatch(background, /\btabs\s*(?:\.\s*create|\[\s*['"]create['"]\s*\])\s*\(/);
    if (result.extensionId) {
      const options = await page.evaluate(() => chrome.sidePanel.getOptions({}));
      assert.equal(options.path, 'panel.html');
      assert.notEqual(options.enabled, false);
      const behavior = await page.evaluate(() => chrome.sidePanel.getPanelBehavior());
      assert.equal(behavior.openPanelOnActionClick, true);
      result.sidePanelConfiguration = 'Manifest and live chrome.sidePanel API verified';
      result.sidePanelCloseApi = await page.evaluate(() => typeof chrome.sidePanel.close);
    }
  });
  await check('toolbar action does not create another browser tab', async () => {
    assert.ok(result.extensionId, 'An actual extension is required for the action check.');
    const hostPage = context.pages().find(candidate => candidate !== page && candidate.url() === 'about:blank') || await context.newPage();
    const hostSession = await context.newCDPSession(hostPage);
    const targets = await browserSession.send('Target.getTargets', { filter: [{}] });
    const tabTarget = targets.targetInfos.find(target => target.type === 'tab' && target.url === hostPage.url());
    await hostPage.bringToFront();
    const tabsBefore = await page.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id).sort());
    try {
      assert.ok(tabTarget, 'Native tab target unavailable in this headless browser.');
      await browserSession.send('Extensions.triggerAction', { id: result.extensionId, targetId: tabTarget.targetId });
    } catch (error) {
      result.sidePanelEntry = `Native side-panel action unavailable in this browser: ${error.message}; manifest and API configuration only`;
      console.log(`LIMITATION ${result.sidePanelEntry}`);
      return false;
    } finally { await hostSession.detach(); await page.bringToFront(); }
    await new Promise(resolve => setTimeout(resolve, 400));
    const tabsAfter = await page.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id).sort());
    assert.deepEqual(tabsAfter, tabsBefore, 'Toolbar action must not create a tab.');
    const panels = await page.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }));
    result.sidePanelContextsOpened = panels.length;
    result.sidePanelEntry = panels.length
      ? 'CDP toolbar action opened a SIDE_PANEL context without creating a tab'
      : 'CDP action kept tab count unchanged; native SIDE_PANEL rendering unavailable in headless browser, configuration verified only';
    result.tabCountBeforeAction = tabsBefore.length;
    result.tabCountAfterAction = tabsAfter.length;
  });
  await check('narrow panel layout fits the viewport', async () => {
    try {
      for (const width of [420, 360]) {
        await page.setViewportSize({ width, height: 900 });
        const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
        assert.equal(dimensions.viewport, width);
        assert.ok(dimensions.content <= dimensions.viewport, `Horizontal overflow: ${dimensions.content} > ${dimensions.viewport}`);
      }
    } finally { await page.setViewportSize({ width: 420, height: 900 }); }
  });
  await check('initial buttons, consent and empty previews', async () => {
    assert.equal(await page.locator('#camera-start').isEnabled(), true);
    for (const id of ['camera-stop', 'session-start', 'session-stop']) assert.equal(await page.locator(`#${id}`).isDisabled(), true, id);
    assert.equal(await page.locator('#privacy-consent').isChecked(), false);
    assert.equal(await page.evaluate(() => document.querySelector('#local-video').srcObject), null);
    assert.equal(await page.evaluate(() => document.querySelector('#remote-video').srcObject), null);
    assert.equal(await page.evaluate(() => window.__qaMedia.calls), 0);
  });
  await check('panel close control stops camera tracks', async () => {
    const openPanelsBeforeClose = result.extensionId ? await page.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })) : [];
    result.sidePanelContextsBeforeClose = openPanelsBeforeClose.length;
    await page.locator('#camera-start').click();
    await page.waitForFunction(() => document.querySelector('#local-video').srcObject?.getVideoTracks().some(track => track.readyState === 'live'));
    const stoppedBefore = result.stoppedTracks;
    await page.locator('#panel-close').click();
    for (let attempt = 0; attempt < 20 && result.stoppedTracks <= stoppedBefore; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(result.stoppedTracks > stoppedBefore, 'Close control must stop the synthetic camera even if native panel closing is unavailable.');
    if (!page.isClosed()) await page.waitForFunction(() => window.__qaMedia.tracks.every(track => track.readyState === 'ended'));
    if (openPanelsBeforeClose.length && result.sidePanelCloseApi === 'function') {
      const worker = context.serviceWorkers().find(worker => worker.url().startsWith(origin));
      assert.ok(worker, 'Extension service worker is required to inspect the closed panel.');
      let remaining = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        remaining = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }));
        if (!remaining.length) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(remaining.length, 0, 'Native SIDE_PANEL context should close.');
      result.sidePanelClose = 'Native SIDE_PANEL context closed and synthetic camera stopped';
    } else {
      result.sidePanelClose = 'Close control stops media; native side-panel closing not verified because no rendered SIDE_PANEL context was available';
    }
  });
  await check('web-image picker rejects an extension tab and restores its controls', async () => {
    await page.bringToFront();
    await page.evaluate(() => {
      const original = chrome.scripting.executeScript.bind(chrome.scripting);
      window.__qaScanCalls = 0;
      window.__qaRestoreScripting = () => { chrome.scripting.executeScript = original; };
      chrome.scripting.executeScript = (...args) => { window.__qaScanCalls++; return original(...args); };
    });
    try {
      await page.locator('#page-images-open').click();
      await page.waitForFunction(() => /此页面无法选图|无法读取此页面/.test(document.querySelector('#page-images-status').textContent));
      assert.equal(await page.evaluate(() => window.__qaScanCalls), 0, 'Restricted extension tab must not be scanned.');
      assert.equal(await page.locator('#page-images-open').isEnabled(), true);
      assert.equal(await page.locator('#page-images-list > *').count(), 0);
      await page.locator('#page-images-close').click();
      assert.equal(await page.locator('#page-images-panel').isHidden(), true);
    } finally { await page.evaluate(() => window.__qaRestoreScripting()); }
  });
  await check('web-image picker reads local product metadata without refetching images', async () => {
    let fixtureImageRequests = 0;
    fixtureServer = http.createServer((req, res) => {
      if (req.url === '/garment.svg') {
        fixtureImageRequests++;
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="360"><rect width="300" height="360" fill="#c8dcc5"/></svg>');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Offline garment fixture</title><img src="/garment.svg" alt="Synthetic product garment" width="300" height="360">');
      }
    });
    // localhost is deliberately outside the default 127.0.0.1 host permission.
    const loopbackFixtureOrigin = await listen(fixtureServer);
    const fixtureOrigin = loopbackFixtureOrigin.replace('127.0.0.1', 'localhost');
    allowedNetworkOrigins.add(fixtureOrigin);
    const fixturePage = await context.newPage();
    const fixtureSession = await context.newCDPSession(fixturePage);
    try {
      await fixturePage.goto(fixtureOrigin, { waitUntil: 'load' });
      await fixturePage.waitForFunction(() => document.images[0]?.naturalWidth === 300);
      await fixturePage.bringToFront();
      assert.equal(await page.evaluate(origin => chrome.permissions.contains({ origins: [`${origin}/*`] }), fixtureOrigin), false, 'Fixture must not have persistent host permission.');
      const targets = await browserSession.send('Target.getTargets', { filter: [{}] });
      const tabTarget = targets.targetInfos.find(target => target.type === 'tab' && target.url === fixturePage.url());
      try {
        assert.ok(tabTarget, 'Native tab target unavailable in this headless browser.');
        await browserSession.send('Extensions.triggerAction', { id: result.extensionId, targetId: tabTarget.targetId });
      } catch (error) {
        result.webImageActiveTab = `Not verified: browser could not simulate toolbar user action (${error.message}); no host permission granted`;
        return false;
      }
      const [active] = await page.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }));
      if (!active?.url) {
        result.unverifiedChecks.push('activeTab permission grant from the native toolbar action');
        result.webImageActiveTab = 'CDP action opened a panel but did not grant activeTab URL access; real user permission flow unverified. Metadata collection uses the existing 127.0.0.1 host permission instead, with no new permission grant.';
        allowedNetworkOrigins.add(loopbackFixtureOrigin);
        await fixturePage.goto(loopbackFixtureOrigin, { waitUntil: 'load' });
        await fixturePage.waitForFunction(() => document.images[0]?.naturalWidth === 300);
      }
      const requestsBefore = fixtureImageRequests;
      // Run the real panel handler without changing the active product tab.
      await page.locator('#page-images-open').evaluate(button => button.click());
      await page.waitForFunction(() => !document.querySelector('#page-images-open').disabled);
      result.webImageFixtureDiagnostics = {
        status: await page.locator('#page-images-status').textContent(),
        activeTabs: await page.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true })).map(tab => ({ id: tab.id, url: tab.url }))),
        expectedUrl: fixturePage.url(),
      };
      assert.equal(await page.locator('#page-images-list .page-image-choice').count(), 1, JSON.stringify(result.webImageFixtureDiagnostics));
      assert.match(await page.locator('#page-images-list').textContent(), /Synthetic product garment.*300×360/);
      assert.equal(await page.locator('#page-images-list img').count(), 0);
      assert.equal(fixtureImageRequests, requestsBefore, 'Metadata listing must not refetch product images.');
      assert.equal(await page.locator('#page-images-open').isEnabled(), true);
      result.webImageCollection = 'Real scripting.executeScript collected one product image as text metadata only; no image refetch or added host permission';
      if (!result.webImageActiveTab) result.webImageActiveTab = 'Real scripting.executeScript collected metadata from localhost after CDP user action without persistent host permission';
      await page.locator('#page-images-close').evaluate(button => button.click());
    } finally {
      await fixtureSession.detach(); await fixturePage.close(); await page.bringToFront();
    }
  });
  await check('missing broker address produces visible error', async () => {
    const settings = page.locator('details').filter({ has: page.locator('#broker-url') });
    if (!await settings.evaluate(details => details.open)) await settings.locator('summary').click();
    await page.locator('#broker-url').fill('');
    await page.locator('#check-connection').click();
    await page.waitForFunction(() => ['error', 'warning'].includes(document.querySelector('#status-message').dataset.tone));
    assert.ok((await page.locator('#status-message').textContent()).trim());
    assert.equal(result.tokenRequests, 0);
  });
  await check('real unconfigured local broker reports error without upstream call', async () => {
    await page.locator('#broker-url').fill(brokerOrigin);
    const healthResponse = page.waitForResponse(response => response.url() === `${brokerOrigin}/health`);
    await page.locator('#check-connection').click();
    assert.equal((await healthResponse).status(), 200);
    await page.waitForFunction(() => ['error', 'warning'].includes(document.querySelector('#status-message').dataset.tone));
    const status = await page.locator('#status-message').textContent();
    assert.match(status, /配置|configur|连接|服务未就绪/i);
    assert.equal(result.tokenRequests, 0);
    assert.equal(result.upstreamCalls, 0);
  });
  await check('image upload and wardrobe preview', async () => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
      const drawing = canvas.getContext('2d');
      drawing.fillStyle = '#faf6eb'; drawing.fillRect(0, 0, 512, 512);
      drawing.fillStyle = '#82a58a'; drawing.fillRect(130, 90, 250, 340);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#garment-input').setInputFiles({ name: 'synthetic-garment.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.locator('#garment-list img').first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('#garment-list img')].every(image => image.complete && image.naturalWidth > 0));
    assert.equal(await page.locator('#garment-list img').count(), 1);
    assert.equal(await page.locator('#garment-empty').isHidden(), true);
    await page.locator('#garment-list .garment-select').click();
    assert.equal(await page.locator('#garment-list .garment-select').getAttribute('aria-pressed'), 'true');
  });
  await check('open synthetic camera and enforce consent gate', async () => {
    await page.locator('#camera-start').click();
    await page.waitForFunction(() => document.querySelector('#local-video').srcObject?.getVideoTracks().some(track => track.readyState === 'live'));
    assert.equal(await page.locator('#camera-stop').isEnabled(), true);
    assert.equal(await page.locator('#session-start').isDisabled(), true);
    // Dispatch an event as well as checking the disabled UI to exercise the
    // consent guard inside the handler without enabling consent.
    await page.locator('#session-start').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(result.tokenRequests, 0);
    assert.equal(result.upstreamCalls, 0);
    assert.equal(await page.evaluate(() => document.querySelector('#remote-video').srcObject), null);
    await page.screenshot({ path: path.join(root, '.local/browser-smoke-synthetic-camera.png'), fullPage: true });
  });
  await check('stop camera ends all local tracks', async () => {
    await page.locator('#camera-stop').click();
    await page.waitForFunction(() => window.__qaMedia.tracks.length > 0 && window.__qaMedia.tracks.every(track => track.readyState === 'ended'));
    assert.equal(await page.locator('#camera-stop').isDisabled(), true);
    assert.equal(await page.locator('#camera-start').isEnabled(), true);
    assert.equal(await page.evaluate(() => document.querySelector('#local-video').srcObject), null);
  });
  await check('pagehide stops camera tracks', async () => {
    await page.locator('#camera-start').click();
    await page.waitForFunction(() => document.querySelector('#local-video').srcObject?.getVideoTracks().some(track => track.readyState === 'live'));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await page.waitForFunction(() => window.__qaMedia.tracks.every(track => track.readyState === 'ended'));
    assert.equal(result.upstreamCalls, 0);
  });
  await check('isolated SDK engine module loads without connecting to a model', async () => {
    const enginePage = await context.newPage();
    enginePage.on('pageerror', error => result.pageErrors.push(`engine: ${error.message}`));
    enginePage.on('console', message => {
      if (message.type() === 'error' && /content.security.policy|refused to (execute|load|connect)/i.test(message.text())) result.cspViolations.push({ engineConsole: message.text() });
    });
    try {
      await enginePage.goto(`${origin}/engine.html`, { waitUntil: 'load' });
      await enginePage.waitForFunction(() => typeof window.realtimeEngine?.connect === 'function');
      assert.equal(result.upstreamCalls, 0);
      assert.equal(result.tokenRequests, 0);
    } finally { await enginePage.close(); }
  });
  await check('no runtime errors or CSP violations', async () => {
    assert.deepEqual(result.pageErrors, []);
    assert.deepEqual(result.cspViolations, []);
  });
  await check('no external service attempts or token issuance', async () => {
    assert.deepEqual(result.externalRequestsBlocked, []);
    assert.equal(result.upstreamCalls, 0);
    assert.equal(result.tokenRequests, 0);
  });
} catch (error) {
  result.failures.push(error.stack || error.message);
} finally {
  await context?.close();
  await Promise.all([closeServer(broker), closeServer(staticServer), closeServer(fixtureServer)]);
  // Profile is a mkdtemp child of the OS temp directory, never a user profile.
  if (path.dirname(profile) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('realtime-engine-browser-')) await rm(profile, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.failures.length ? 1 : 0;
