/** Dev check: prints title/description of every built language page. */
import { readFileSync } from 'node:fs';

const paths = [
  ['dist/index.html', 'dist/ar.html', 'dist/pcm.html'],
  ['dist/about.html', 'dist/ar/about.html', 'dist/pcm/about.html'],
  ['dist/apps.html', 'dist/ar/apps.html', 'dist/pcm/apps.html'],
  ['dist/order-vpn.html', 'dist/ar/order-vpn.html', 'dist/pcm/order-vpn.html'],
  ['dist/vpn-servers.html', 'dist/ar/vpn-servers.html', 'dist/pcm/vpn-servers.html'],
  ['dist/vpn-types-guide.html', 'dist/ar/vpn-types-guide.html', 'dist/pcm/vpn-types-guide.html'],
  ['dist/connection-guide.html', 'dist/ar/connection-guide.html', 'dist/pcm/connection-guide.html'],
  ['dist/articles.html', 'dist/ar/articles.html', 'dist/pcm/articles.html'],
  ['dist/contact.html', 'dist/ar/contact.html', 'dist/pcm/contact.html'],
  ['dist/advertise.html', 'dist/ar/advertise.html', 'dist/pcm/advertise.html'],
  ['dist/privacy-policy.html', 'dist/ar/privacy-policy.html', 'dist/pcm/privacy-policy.html'],
  ['dist/terms.html', 'dist/ar/terms.html', 'dist/pcm/terms.html'],
  ['dist/affiliate-disclosure.html', 'dist/ar/affiliate-disclosure.html', 'dist/pcm/affiliate-disclosure.html'],
];

let missing = 0;
for (const group of paths) {
  for (const f of group) {
    let c;
    try {
      c = readFileSync(f, 'utf8');
    } catch {
      console.log('---', f, 'MISSING');
      missing++;
      continue;
    }
    const title = c.match(/<title>([^<]+)<\/title>/);
    const desc = c.match(/<meta name="description" content="([^"]*)"/);
    console.log('---', f);
    console.log('  TITLE:', JSON.stringify(title ? title[1] : 'NONE'));
    console.log('  DESC :', JSON.stringify(desc ? desc[1].slice(0, 90) : 'NONE'));
  }
}
process.exitCode = missing ? 1 : 0;
