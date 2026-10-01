import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mobileManifest } from '../scripts/mobile-build.mjs';

test('mobile entry stays in a popup and removes unsupported desktop APIs without mutating desktop', async () => {
  const desktop = JSON.parse(await readFile(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  for (const platform of ['firefox', 'safari']) {
    const mobile = mobileManifest(desktop, platform);
    assert.equal(mobile.action.default_popup, 'panel.html');
    assert.equal(mobile.background, undefined);
    assert.equal(mobile.side_panel, undefined);
    assert.equal(mobile.minimum_chrome_version, undefined);
    assert.deepEqual(mobile.permissions, ['storage', 'activeTab', 'scripting']);
    assert.deepEqual(mobile.host_permissions, []);
  }
  assert.equal(desktop.side_panel.default_path, 'panel.html');
  assert.ok(desktop.permissions.includes('sidePanel'));
});

test('Firefox declares video, credentials and website image transmission; Safari omits Gecko metadata', () => {
  const base = { permissions: [], action: {} };
  const firefox = mobileManifest(base, 'firefox');
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.required,
    ['personallyIdentifyingInfo', 'authenticationInfo', 'websiteContent']);
  assert.equal(mobileManifest(base, 'safari').browser_specific_settings, undefined);
  assert.throws(() => mobileManifest(base, 'unknown'));
});
