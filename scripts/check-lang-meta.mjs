/** Dev check: prints title/description of the built language pages. */
import { readFileSync } from 'node:fs';

for (const f of ['dist/ar.html', 'dist/ar/about.html', 'dist/pcm.html', 'dist/pcm/about.html']) {
  const c = readFileSync(f, 'utf8');
  const title = c.match(/<title>([^<]+)<\/title>/);
  const desc = c.match(/<meta name="description" content="([^"]*)"/);
  console.log('---', f);
  console.log('  TITLE:', JSON.stringify(title ? title[1] : 'NONE'));
  console.log('  DESC :', JSON.stringify(desc ? desc[1].slice(0, 90) : 'NONE'));
}
