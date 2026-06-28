# CCSwitchMulti Codex Logo Handoff

## Direction

Codex SVG based multi-route mark for CCSwitchMulti.

The icon uses the LobeHub Codex SVG path as the primary anchor, then adds three parallel routing bands behind it. This keeps the six-arc Codex cloud silhouette intact while making CCSwitchMulti read as a multi-provider router.

## Preserve

- Product spelling: CCSwitchMulti.
- Core metaphor: Codex cloud/terminal mark, multi-provider routing, multi-agent coding.
- Small-size readability: Codex cloud silhouette and three route bands must remain clear at 32px.
- Dark app-icon base so it works in macOS Dock, menu surfaces, docs, and release assets.

## Avoid

- Direct OpenAI/Codex logo copy.
- Claude orange starburst geometry.
- Decorative text inside the app icon.
- Thin line work that disappears in the Dock.
- Generic refresh rings that do not communicate Codex or Multi.
- Share-network node diagrams that do not feel like routing inside Codex.

## Assets

- `assets/brand/codex-reference-lobehub.svg`: downloaded Codex SVG reference from `@lobehub/icons-static-svg`.
- `assets/brand/ccswitchmulti-codex-app-icon.svg`: vector master for app icon exports, derived from the Codex reference.
- `assets/brand/ccswitchmulti-codex-logo-lockup.svg`: wordmark lockup for docs, release notes, and covers.
- `src/assets/icons/app-icon.png`: 32px in-app About icon export.
- `src-tauri/icons/*`: generated app/package icon exports.

## Production Notes

Generated typography in the lockup is directional; final brand use should keep the SVG text or outline it in a design tool before print use. Trademark clearance is still a separate review if the logo becomes public-facing branding.
