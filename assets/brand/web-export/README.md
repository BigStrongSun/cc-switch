# CCSMulti Website Icon Export

These website assets are exported from `../ccswitchmulti-codex-app-icon.svg`, the CCSwitchMulti Codex multi-route icon master.

## Files

- `ccsmulti-icon.svg`: website-facing SVG copy of the vector master.
- `ccsmulti-icon-1024.png`: 1024px PNG rendered from SVG.
- `ccsmulti-icon-2048.png`: 2048px PNG rendered from SVG.
- `ccsmulti-icon-4096.png`: 4096px PNG rendered from SVG.
- `ccsmulti-icon-with-label-*.png`: transparent PNGs with dark `ccsmulti` text for light website backgrounds.
- `ccsmulti-icon-with-label-light-text-*.png`: transparent PNGs with light `ccsmulti` text for dark website backgrounds.
- `ccsmulti-icon-with-label-white-bg-black-text-*.png`: white-background PNGs with black `ccsmulti` text for direct website placement.

## Notes

- Keep app/package icons in `src-tauri/icons/`; this directory is only for website/export usage.
- The full product name remains `CCSwitchMulti`; the `ccsmulti` label here is a website short-name asset requested for compact placement.
- Re-render PNGs from the SVG master rather than upscaling lower-resolution PNGs.
