import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PUBLIC_ORIGIN,
  renderRobots,
  renderSitemap,
  resolvePublicOrigin,
} from '../scripts/seo-origin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = resolvePublicOrigin(process.env.PUBLIC_ORIGIN);
const expectedRoutes = [
  '/', '/over-het-land', '/agenda', '/verhalen', '/contact',
  '/lid-worden', '/privacy', '/leden', '/beheer', '/404',
];

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

test('resolves a strict configurable public HTTPS origin', () => {
  assert.equal(resolvePublicOrigin(), DEFAULT_PUBLIC_ORIGIN);
  assert.equal(resolvePublicOrigin(' https://voorbeeld.nl/ '), 'https://voorbeeld.nl');
  assert.throws(() => resolvePublicOrigin('http://voorbeeld.nl'), /HTTPS origin/);
  assert.throws(() => resolvePublicOrigin('https://voorbeeld.nl/submap'), /HTTPS origin/);
  assert.throws(() => resolvePublicOrigin('not-a-url'), /valid absolute HTTPS origin/);
});

test('does not reference the unrelated legacy hostname', async () => {
  const files = [
    'scripts/seo-origin.mjs',
    'scripts/prerender-public-routes.mjs',
    'public/robots.txt',
    'public/sitemap.xml',
    'dist/client/robots.txt',
    'dist/client/sitemap.xml',
    'dist/client/index.html',
  ];
  const sources = await Promise.all(files.map((file) => readFile(path.join(root, file), 'utf8')));
  assert.doesNotMatch(sources.join('\n'), /landvanjan\.nl/i);
});

test('uses one complete route metadata source', async () => {
  const metadata = JSON.parse(await readFile(path.join(root, 'src', 'route-meta.json'), 'utf8'));
  assert.deepEqual(Object.keys(metadata), expectedRoutes);

  for (const [route, value] of Object.entries(metadata)) {
    assert.match(route, /^\/(?:[a-z0-9-]+)?$/);
    assert.ok(value.title.length >= 20);
    assert.ok(value.description.length >= 40);
    assert.equal(typeof value.index, 'boolean');
  }

  for (const route of ['/leden', '/beheer', '/404']) assert.equal(metadata[route].index, false);

  const content = await readFile(path.join(root, 'src', 'content.jsx'), 'utf8');
  assert.match(content, /import routeMetadata from ['"]\.\/route-meta\.json['"]/);
  assert.match(content, /export const routeMeta = routeMetadata/);
});

test('ships crawler controls for the production hostname', async () => {
  const metadata = JSON.parse(await readFile(path.join(root, 'src', 'route-meta.json'), 'utf8'));
  const [robots, sitemap, deployedRobots, deployedSitemap] = await Promise.all([
    readFile(path.join(root, 'public', 'robots.txt'), 'utf8'),
    readFile(path.join(root, 'public', 'sitemap.xml'), 'utf8'),
    readFile(path.join(root, 'dist', 'client', 'robots.txt'), 'utf8'),
    readFile(path.join(root, 'dist', 'client', 'sitemap.xml'), 'utf8'),
  ]);

  assert.equal(robots, renderRobots(DEFAULT_PUBLIC_ORIGIN));
  assert.equal(sitemap, renderSitemap(DEFAULT_PUBLIC_ORIGIN, metadata));
  assert.equal(deployedRobots, renderRobots(origin));
  assert.equal(deployedSitemap, renderSitemap(origin, metadata));
  assert.match(deployedRobots, new RegExp(`Sitemap: ${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\/sitemap\\.xml`));
  assert.match(deployedRobots, /Disallow: \/leden/);
  assert.match(deployedRobots, /Disallow: \/beheer/);

  for (const route of expectedRoutes.slice(0, 7)) {
    const canonical = `${origin}${route === '/' ? '/' : route}`;
    assert.match(deployedSitemap, new RegExp(`<loc>${canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/loc>`));
  }
  for (const route of ['/leden', '/beheer', '/404']) assert.doesNotMatch(deployedSitemap, new RegExp(`<loc>${origin}${route}`));
});

test('prerenders route-specific SEO tags for every route', async () => {
  const metadata = JSON.parse(await readFile(path.join(root, 'src', 'route-meta.json'), 'utf8'));

  for (const [route, value] of Object.entries(metadata)) {
    const outputPath = route === '/'
      ? path.join(root, 'dist', 'client', 'index.html')
      : path.join(root, 'dist', 'client', route.slice(1), 'index.html');
    await access(outputPath);
    const html = await readFile(outputPath, 'utf8');
    const canonical = `${origin}${route === '/' ? '/' : route}`;
    const robots = value.index ? 'index,follow,max-image-preview:large' : 'noindex,nofollow';

    assert.ok(html.includes(`<title>${escapeHtml(value.title)}</title>`), `${route} title`);
    assert.ok(html.includes(`<meta name="description" content="${escapeHtml(value.description)}" />`), `${route} description`);
    assert.ok(html.includes(`<meta name="robots" content="${robots}" />`), `${route} robots`);
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}" />`), `${route} canonical`);
    assert.ok(html.includes(`<meta property="og:url" content="${canonical}" />`), `${route} og:url`);
    assert.ok(html.includes(`<meta property="og:image" content="${origin}/images/land-hero.jpeg" />`), `${route} og:image`);
    assert.ok(html.includes(`<meta name="twitter:image" content="${origin}/images/land-hero.jpeg" />`), `${route} twitter:image`);
  }
});
