# SEO build

`src/route-meta.json` is de enige bron voor routetitels, descriptions en indexeerbaarheid. De React-app gebruikt deze metadata tijdens navigatie en `scripts/prerender-public-routes.mjs` gebruikt dezelfde bron tijdens de productiebuild.

De build schrijft voor iedere bekende route een eigen `dist/client/<route>/index.html` met een route-specifieke title, description, canonical, robots-tag en sociale metadata. Dezelfde build genereert `dist/client/robots.txt` en `dist/client/sitemap.xml`. `/leden`, `/beheer` en `/404` krijgen altijd `noindex,nofollow` en staan niet in de sitemap.

`PUBLIC_ORIGIN` bepaalt de publieke HTTPS-origin tijdens de build, bijvoorbeeld `https://www.eigen-domein.nl`. De waarde mag geen pad, query, fragment of inloggegevens bevatten. Zonder deze variabele gebruikt de build veilig de huidige Railway-origin `https://land-van-jan-production.up.railway.app`. De bestanden in `public/` bevatten dezelfde veilige fallback; de build overschrijft de kopieën in `dist/client/` wanneer `PUBLIC_ORIGIN` is gezet.

Nieuwe publieke routes moeten op twee plaatsen consistent worden toegevoegd:

1. `src/route-meta.json`;
2. de routes en inhoud van de React-app.

De sitemap wordt automatisch samengesteld uit alle routes met `index: true`.

`npm run build` maakt de routebestanden. `npm run test:sites` controleert de bronmetadata, crawlerbestanden en uiteindelijke HTML-output.
