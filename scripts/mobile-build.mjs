import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function mobileManifest(desktop, platform) {
  if (!['firefox', 'safari'].includes(platform)) throw new Error('Unknown mobile platform');
  const manifest = structuredClone(desktop);
  delete manifest.minimum_chrome_version;
  delete manifest.side_panel;
  delete manifest.background;
  manifest.description = '从浏览器扩展菜单调出试衣面板。手机适配开发版，需个人 HTTPS 凭证服务及真机验证。';
  manifest.permissions = ['storage', 'activeTab', 'scripting'];
  manifest.host_permissions = [];
  manifest.action = { default_title: '打开实时演算', default_popup: 'panel.html' };
  if (platform === 'firefox') {
    manifest.browser_specific_settings = {
      gecko: {
        id: 'realtime-engine@kkun72045-jpg.github.io',
        strict_min_version: '142.0',
        data_collection_permissions: { required: ['personallyIdentifyingInfo', 'authenticationInfo', 'websiteContent'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    };
  }
  return manifest;
}

async function build() {
  const root = process.cwd();
  const source = path.resolve(root, 'dist');
  const desktop = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
  for (const platform of ['firefox', 'safari']) {
    const directory = `dist-mobile-${platform}`;
    const target = path.resolve(root, directory);
    // Only clean generated directories directly inside this project.
    if (path.dirname(target) !== root || path.basename(target) !== directory) throw new Error('Unsafe output path');
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
    await rm(path.join(target, 'assets/background.js'), { force: true });
    await writeFile(path.join(target, 'manifest.json'), JSON.stringify(mobileManifest(desktop, platform), null, 2) + '\n');
    await writeFile(path.join(target, 'MOBILE-DEVELOPMENT.txt'),
      '实时演算 0.1.0 — mobile extension development source\n' +
      'Not signed, not store-published, and not verified on Android or iPhone hardware.\n' +
      'See docs/mobile.md in the source repository for testing, HTTPS service and signing requirements.\n');
  }
  console.log('Firefox Android and Safari mobile development packages generated (unsigned, hardware unverified).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await build();
