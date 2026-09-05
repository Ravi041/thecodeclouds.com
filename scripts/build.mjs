import Eleventy from '@11ty/eleventy';
import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only delete this project's generated output, never a caller-provided directory.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, '_site');
if (path.dirname(output) !== path.resolve(root) || path.basename(output) !== '_site') {
  throw new Error('Refusing to clean an unexpected output directory');
}
const existing = await lstat(output).catch(error => {
  if (error.code !== 'ENOENT') throw error;
});
if (existing?.isSymbolicLink()) throw new Error('Refusing to clean a symlinked output directory');
await rm(output, { recursive: true, force: true });
process.chdir(root);
await new Eleventy('src', '_site').write();
