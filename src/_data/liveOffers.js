import { readFile } from 'node:fs/promises';
import { activeOffers } from '../../lib/content.js';
export default async function() {
  return activeOffers(JSON.parse(await readFile(new URL('./offers.json', import.meta.url), 'utf8')));
}
