import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcJson = path.join(rootDir, 'data', 'zemuria.latest.json');

if (!fs.existsSync(srcJson)) {
  console.error(`Missing canonical dataset: ${srcJson}`);
  process.exit(1);
}

const targets = [
  path.join(rootDir, 'public', 'data', 'zemuria.latest.json'),
  path.join(rootDir, 'wp-plugin', 'kiseki-relation-graph', 'seed', 'zemuria.seed.json'),
];

for (const dest of targets) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(srcJson, dest);
}
