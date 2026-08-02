# Design QA — Land van Jan

## Selected source target

`docs/reference/approved-homepage-2026-08-01.png`

## Iteration

- **P1 corrected:** the earlier programme-first first viewport did not match the approved land-first composition.
- Rebuilt the desktop hero around the approved structure: real land image, oversized dark-green title, Huissen tag, three route cards, and the four-step route section.
- Added functional routes for Over het land, Agenda, Verhalen, Contact, and Word lid.
- Only one generated image is present and it is visibly labelled `TOEKOMSTVISUALISATIE`; all other imagery is supplied real land photography.
- The original photos remain unchanged in `public/images/`; responsive WebP delivery variants live alongside them in `public/images/responsive/`.

## Final checks

- Desktop hero inspected in browser: passed.
- All five routes render an individual page heading: passed.
- Console warnings and errors: none.
- Production build and site-worker tests: passed.
