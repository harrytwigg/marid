# Project site

The Hundredfold landing page and user docs, built with [VitePress](https://vitepress.dev).
Nothing under `docs/` is copied: `.vitepress/config.mts` reads the README and `docs/*.md`
from where they are and maps them to site URLs.

```sh
pnpm site:dev       # live preview
pnpm site:build     # production build into site/.vitepress/dist; fails on dead links
pnpm site:preview   # serve the build
```

- **Landing page:** `site/index.md` and `.vitepress/theme/HomeExtras.vue`.
- **Navigation:** the `sidebar` in `.vitepress/config.mts`. A new page in `docs/` is published
  automatically, but only appears in the sidebar once you add it there.
- **Kept off the site:** `docs/plans`, `qa`, `superpowers`, `design`, `adr` and a few working notes,
  listed in `EXCLUDED_DOC_*` in the config. Links to them from published pages point at GitHub.
- **Look:** colours and glass tokens follow `packages/web/src/routes/glass-identity.css`;
  fonts are the app's own, loaded from `packages/web/src/fonts`.
- **Base path:** `/hundredfold/` for `hundredfoldhq.github.io/hundredfold/`. Build with
  `SITE_BASE=/` for a custom domain.
- **Deploy:** `.github/workflows/pages.yml`.
