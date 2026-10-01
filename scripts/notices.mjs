import { readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const sections = ['THIRD-PARTY NOTICES\n\nThe original application is licensed under MIT. The following third-party packages retain their own licenses. Model service access, weights and outputs are not licensed by this application.\n'];
for (const [path, details] of Object.entries(lock.packages)) {
  if (!path || details.dev || details.optional) continue;
  const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  if (pkg.name === '@bufbuild/protobuf' && pkg.version === '1.10.1') {
    sections.push(`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\n${await readFile('licenses/protobuf-1.10.1.txt', 'utf8')}`);
    continue;
  }
  const names = (await readdir(path)).filter(name => /^(license|licence|copying|notice)([._-]|$)/i.test(name));
  if (!names.length) throw new Error(`Missing license text for runtime dependency: ${pkg.name}`);
  sections.push(`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nDeclared license: ${pkg.license ?? details.license ?? 'see below'}\n`);
  for (const name of names.sort()) sections.push(await readFile(join(path, name), 'utf8'));
}
await writeFile('THIRD_PARTY_NOTICES.txt', sections.join('\n'), 'utf8');
await copyFile('THIRD_PARTY_NOTICES.txt', 'dist/THIRD_PARTY_NOTICES.txt');
await copyFile('LICENSE', 'dist/LICENSE');
console.log('Third-party license notices included in extension distribution.');
