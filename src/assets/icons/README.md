# Web Recall mark

`mark.png` is the approved monochrome Faceted Trace mark: option 3 from the
geometric refinement proof. Its interlocking bands and openings retain the
genuine alpha silhouette from the selected ImageGen asset
(`exec-e2474a3b-5502-476f-a02b-8b40a2206b29.png`). The fill is normalized to the
interface's charcoal (`#242429`), with the same 80% footprint as the approved
actual-size proof.

The shared in-page branding masks this raster asset with the current text color,
so it follows the selected interface theme.

`outline-mark.png` is the approved black-and-white Outline variant, used for
the toolbar, Extensions page, store icon, extension page favicons and Mac
companion. Its white backing follows the original mark, leaving the surroundings
transparent. Chrome draws the pause badge separately; it is not part of the PNG.

Regenerate the size-specific PNGs with `node scripts/render-icons.mjs` after
changing the Outline master. The exporter uses Sharp from the pinned
Transformers.js dependency; the extension build only copies the prepared assets.
The Mac build generates the app icon with macOS tools and uses the toolbar's
48 px export for the menu bar, without template tinting.
