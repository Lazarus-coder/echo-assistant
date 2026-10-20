# Echo product site

A bilingual, responsive product and download page. The page uses plain HTML, CSS, and JavaScript, with no build step or external asset dependencies.

- [中文](index.html)
- [English](en.html)
- [Local preview instructions](../docs/development.md#preview-the-product-site)

GitHub displays the HTML as source. To view the page, open `index.html` in a browser or serve this directory locally. This directory is ready for static hosting; committing it does not publish a hosted website.

## Updating a release

Update both pages together: version, download URL, release notes, system requirements, and any changes to product behavior. Use an explicit release tag while Echo has only prereleases; GitHub's `/releases/latest` endpoint does not select them.

The installation and permissions links currently point to the documentation branch accompanying this site. Update them when that branch is merged or the documentation moves. Keep all external documentation links valid before publishing.

The interface illustrations are sample workflows, not screenshots of the live app. The README preview images capture this product page. Keep them aligned with visible changes to the first screen.

## Design

The information sequence was informed by the public [UniCone site](https://www.unicone.club/en): product promise, concrete use cases, controls, and a short path to installation. Echo's layout, copy, styling, and tab interaction were implemented independently; no UniCone application code or brand assets are included.
