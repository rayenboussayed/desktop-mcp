# OCR, image and colour search

## OCR

OCR runs offline in WebAssembly using `tesseract.js`. English data is shipped in the
optional dependency `@tesseract.js-data/eng`; desktop-mcp does not download data
automatically.

- Supported modes: exact, contains, fuzzy.
- Multi-line regions can be combined into one bounding box.
- Fuzzy search calculates edit distance and tolerates OCR slips.
- Other languages are supported if their data packages are installed and the path
  is set with `OSAGENT_OCR_LANG_PATH`, or the data package detects them.
- Weird or missing languages fail before server startup.

## Image matching

- Template matching is built in rather than nut.js's proprietary plugins.
- Supports confidence thresholds and multi-scale matching.
- Transparent pixels are ignored as an alpha mask.
- Scans produce clustered results, largest/best first.
- Slow, featureless templates should be avoided.

## Colour search

- `screen_find_color` locates regions with a colour and returns boxes ordered by
  area.
- `screen_color_at` reads a single pixel.
- `screen_highlight` can draw a temporary capture annotation region.

## Matching on HiDPI

Coordinates and pixels use logical screen dimensions expected by pointer APIs.
EOF