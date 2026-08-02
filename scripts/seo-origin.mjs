export const DEFAULT_PUBLIC_ORIGIN = 'https://land-van-jan-production.up.railway.app';

export function resolvePublicOrigin(value) {
  const candidate = typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_PUBLIC_ORIGIN;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('PUBLIC_ORIGIN must be a valid absolute HTTPS origin.');
  }

  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment.');
  }

  return url.origin;
}

export function renderRobots(origin) {
  const hostname = new URL(origin).hostname;
  return `User-agent: *
Allow: /
Disallow: /leden
Disallow: /beheer
Disallow: /404

Sitemap: ${origin}/sitemap.xml
Host: ${hostname}
`;
}

export function renderSitemap(origin, routeMetadata) {
  const locations = Object.entries(routeMetadata)
    .filter(([, metadata]) => metadata.index)
    .map(([route]) => `  <url><loc>${origin}${route === '/' ? '/' : route}</loc></url>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locations}
</urlset>
`;
}
