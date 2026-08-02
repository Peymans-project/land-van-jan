#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRobots, renderSitemap, resolvePublicOrigin } from './seo-origin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = path.join(root, 'dist', 'client');
const indexPath = path.join(clientDir, 'index.html');
const metadataPath = path.join(root, 'src', 'route-meta.json');
const productionOrigin = resolvePublicOrigin(process.env.PUBLIC_ORIGIN);

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function upsertHeadTag(html, pattern, tag) {
  if (pattern.test(html)) return html.replace(pattern, tag);
  return html.replace('</head>', `    ${tag}\n  </head>`);
}

function renderRoute(template, route, metadata) {
  const title = escapeHtml(metadata.title);
  const description = escapeHtml(metadata.description);
  const canonical = escapeHtml(`${productionOrigin}${route === '/' ? '/' : route}`);
  const socialImage = escapeHtml(`${productionOrigin}/images/land-hero.jpeg`);
  const robots = metadata.index ? 'index,follow,max-image-preview:large' : 'noindex,nofollow';

  let html = upsertHeadTag(template, /<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
  html = upsertHeadTag(html, /<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${description}" />`);
  html = upsertHeadTag(html, /<meta\s+name=["']robots["'][^>]*>/i, `<meta name="robots" content="${robots}" />`);
  html = upsertHeadTag(html, /<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${canonical}" />`);
  html = upsertHeadTag(html, /<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${title}" />`);
  html = upsertHeadTag(html, /<meta\s+property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${description}" />`);
  html = upsertHeadTag(html, /<meta\s+property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${canonical}" />`);
  html = upsertHeadTag(html, /<meta\s+property=["']og:image["'][^>]*>/i, `<meta property="og:image" content="${socialImage}" />`);
  html = upsertHeadTag(html, /<meta\s+name=["']twitter:title["'][^>]*>/i, `<meta name="twitter:title" content="${title}" />`);
  html = upsertHeadTag(html, /<meta\s+name=["']twitter:description["'][^>]*>/i, `<meta name="twitter:description" content="${description}" />`);
  html = upsertHeadTag(html, /<meta\s+name=["']twitter:image["'][^>]*>/i, `<meta name="twitter:image" content="${socialImage}" />`);
  return html;
}

const [template, metadataSource] = await Promise.all([
  readFile(indexPath, 'utf8'),
  readFile(metadataPath, 'utf8'),
]);
const routeMetadata = JSON.parse(metadataSource);

for (const [route, metadata] of Object.entries(routeMetadata)) {
  if (!/^\/(?:[a-z0-9-]+)?$/.test(route)) throw new Error(`Unsafe route in metadata: ${route}`);
  if (!metadata.title || !metadata.description || typeof metadata.index !== 'boolean') {
    throw new Error(`Incomplete metadata for route: ${route}`);
  }

  const outputPath = route === '/' ? indexPath : path.join(clientDir, route.slice(1), 'index.html');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderRoute(template, route, metadata));
}

await Promise.all([
  writeFile(path.join(clientDir, 'robots.txt'), renderRobots(productionOrigin)),
  writeFile(path.join(clientDir, 'sitemap.xml'), renderSitemap(productionOrigin, routeMetadata)),
]);

console.log(`Prerendered SEO metadata for ${Object.keys(routeMetadata).length} routes at ${productionOrigin}.`);
