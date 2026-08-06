import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originals = [
  'ankh-kunst.jpeg', 'appel-ankh.jpeg', 'boomgaard-hd.jpeg', 'buitenplek.jpeg',
  'gemeenschap-hd.jpeg', 'kas-binnen-hd.jpeg', 'kas-buiten-hd.jpeg', 'kas-detail.jpeg',
  'land-hero.jpeg', 'muziek.jpeg', 'toekomstvisualisatie.png', 'werkplaats-hd.jpeg',
];

const suppliedArchive = Array.from({ length: 38 }, (_, index) => `photo-${String(index + 1).padStart(3, '0')}.jpeg`);

test('keeps every curated original photo in source and deployment output', async () => {
  for (const filename of originals) {
    const source = path.join(root, 'public', 'images', filename);
    const deployed = path.join(root, 'dist', 'client', 'images', filename);
    await access(source);
    await access(deployed);
    assert.ok((await stat(source)).size > 50_000, `${filename} looks truncated`);
  }
});

test('ships responsive variants and never renders temporary or Photos Library paths', async () => {
  for (const filename of ['photo-015-480.webp', 'photo-015-960.webp', 'photo-015-1024.webp', 'photo-026-1024.webp', 'photo-035-768.webp', 'gemeenschap-hd-1600.webp', 'toekomstvisualisatie-960.webp']) {
    await access(path.join(root, 'public', 'images', 'responsive', filename));
    await access(path.join(root, 'dist', 'client', 'images', 'responsive', filename));
  }
  const content = await readFile(path.join(root, 'src', 'content.jsx'), 'utf8');
  assert.doesNotMatch(content, /Photos Library|\/private\/var\/|\/Users\/|https?:\/\//i);
  assert.match(content, /focalPoint/);
  assert.match(content, /widths:/);
});

test('archives every supplied photo with complete curation metadata', async () => {
  const archive = path.join(root, 'public', 'images', 'originals', '2026-08-02');
  const deployedArchive = path.join(root, 'dist', 'client', 'images', 'originals', '2026-08-02');
  for (const filename of suppliedArchive) {
    await access(path.join(archive, filename));
    await access(path.join(deployedArchive, filename));
  }

  const manifest = JSON.parse(await readFile(path.join(archive, 'manifest.json'), 'utf8'));
  assert.equal(manifest.assets.length, 38);
  assert.equal(new Set(manifest.assets.map(({ key }) => key)).size, 38);
  assert.equal(manifest.assets.filter(({ state }) => state === 'excluded').length, 1);
  assert.equal(manifest.assets.find(({ key }) => key === 'photo-004').state, 'excluded');

  for (const asset of manifest.assets) {
    assert.match(asset.archivePath, /^\/images\/originals\/2026-08-02\/photo-\d{3}\.jpeg$/);
    assert.ok(asset.originalBasename && !asset.originalBasename.includes('/'));
    assert.ok(asset.width > 0 && asset.height > 0 && asset.bytes > 0);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(asset.alt && asset.focalPoint && asset.suggestedSection);
    assert.equal(typeof asset.people.recognizable, 'boolean');
    assert.ok(asset.people.consent);

    const bytes = await readFile(path.join(root, 'public', asset.archivePath));
    assert.equal(bytes.byteLength, asset.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  }
});

test('keeps the August orchard curation as permanent responsive assets', async () => {
  const archive = path.join(root, 'public', 'images', 'originals', '2026-08-06');
  const manifest = JSON.parse(await readFile(path.join(archive, 'manifest.json'), 'utf8'));
  assert.equal(manifest.assets.length, 5);

  for (const asset of manifest.assets) {
    const source = path.join(root, 'public', asset.archivePath);
    await access(source);
    assert.equal((await stat(source)).size, asset.bytes);
    const bytes = await readFile(source);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
    assert.match(asset.archivePath, /^\/images\/originals\/2026-08-06\/[a-z-]+\.jpeg$/);
    assert.ok(asset.alt && asset.focalPoint && asset.suggestedSection);
  }

  for (const filename of [
    'boomgaard-wolkendek-480.webp', 'boomgaard-wolkendek-1024.webp',
    'boomgaard-picknick-960.webp', 'kas-zomerlicht-960.webp',
    'samenzijn-boomgaard-1024.webp', 'appeloogst-ladder-768.webp',
  ]) {
    await access(path.join(root, 'public', 'images', 'responsive', filename));
    await access(path.join(root, 'dist', 'client', 'images', 'responsive', filename));
  }
});

test('archives both supplied videos and deploys optimized muted playback assets', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'docs', 'video-assets-2026-08-02.json'), 'utf8'));
  assert.equal(manifest.assets.length, 2);
  assert.equal(manifest.playbackPolicy.autoplay, true);
  assert.equal(manifest.playbackPolicy.muted, true);
  assert.equal(manifest.playbackPolicy.nativeControls, false);

  for (const asset of manifest.assets) {
    for (const variant of [asset.original, asset.web]) {
      const sourcePath = path.join(root, 'public', variant.path);
      const deployedPath = path.join(root, 'dist', 'client', variant.path);
      const bytes = await readFile(sourcePath);
      await access(deployedPath);
      assert.equal(bytes.byteLength, variant.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), variant.sha256);
      assert.ok(variant.width > 0 && variant.height > 0 && variant.durationSeconds > 0);
    }
    await access(path.join(root, 'public', asset.web.poster));
    await access(path.join(root, 'dist', 'client', asset.web.poster));
  }

  const app = await readFile(path.join(root, 'src', 'App.jsx'), 'utf8');
  assert.match(app, /muted loop playsInline/);
  assert.match(app, /prefers-reduced-motion/);
  assert.doesNotMatch(app, /bmrng\.me|cloudflarestorage\.com/);
});
