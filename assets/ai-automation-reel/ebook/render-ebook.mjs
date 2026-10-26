// Print first-automation.html to first-automation.pdf (6 × 9 in), plus PNG previews of each page with --previews.
//   node render-ebook.mjs [--previews]
// Needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`, or set CHROMIUM to a browser binary).
// Serves this folder over HTTP: Chromium won't load the CSS-masked logo SVGs from file://.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try { const p = join(DIR, decodeURIComponent(new URL(req.url, 'http://x').pathname)), body = await readFile(p); res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
}).listen(0);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 576, height: 864 }, deviceScaleFactor: 2 });
await page.goto(`http://localhost:${server.address().port}/first-automation.html`, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.pdf({ path: join(DIR, 'first-automation.pdf'), width: '6in', height: '9in', printBackground: true, preferCSSPageSize: true });
console.log('wrote first-automation.pdf');

if (process.argv.includes('--previews')) {
  await mkdir(join(DIR, 'previews'), { recursive: true });
  const pages = await page.$$('.page');
  for (const [i, el] of pages.entries()) await el.screenshot({ path: join(DIR, 'previews', `page-${String(i + 1).padStart(2, '0')}.png`) });
  console.log(`wrote ${pages.length} previews to previews/`);
}
await browser.close(); server.close();
