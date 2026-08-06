# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Land van Jan decisions

- The exact visual source of truth is the version-controlled user-approved image `docs/reference/approved-homepage-2026-08-01.png`: editorial land-first hero, very large dark-green “Land van Jan” typography, three dark-green route cards over the hero, and the four-step route timeline.
- The original Lovable page is reference-only; never edit it. Build and upload this separate site instead.
- Use real land photos throughout. The sole generated asset is allowed only as a clearly labelled `Toekomstvisualisatie`.
- Never remove or replace the original files in `public/images/` without explicit owner approval. Responsive WebP files in `public/images/responsive/` are derived delivery assets; they do not replace the originals.
- Render photos only from version-controlled public assets (or an explicitly approved permanent object store), with stable alt text, focal points, dimensions, `srcset`/`sizes`, eager loading only for the active hero, and lazy loading below the fold. Never use Photos Library paths, local temporary paths, or expiring URLs in rendered pages or MongoDB.
- New owner-supplied summer orchard photos are curated in `public/images/originals/2026-08-06/`. Use the wide orchard, greenhouse and meeting images for place/community pages; reserve the vertical apple-harvest image for an editorial gallery card.
- Keep `HUISSEN` only in the compact header/footer wordmark. The large homepage lockup reads `Land van Jan` with `EN ALLE MAN` directly beneath it, right-aligned to the end of `Jan`. Keep the presentation calm: no decorative motion, gradients, or AI/watermarked artwork.
- Use the 2016px `kas-buiten` original for the homepage hero; retain the original `land-hero` photograph in the timeline so no owner photograph disappears from the project.
- The site needs real, clickable multi-page navigation and an SEO-ready structure. Future login, member administration, and opt-in bulk email require a separate secure, AVG/GDPR-compliant backend phase.
