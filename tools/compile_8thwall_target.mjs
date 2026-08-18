#!/usr/bin/env node
/**
 * 8th Wall image-target compiler (AR_SYSTEM.md §G Phase 3).
 *
 * `@8thwall/image-target-cli` (the official tool for this) only ships an
 * INTERACTIVE prompt-driven CLI (`npx @8thwall/image-target-cli`) — no
 * flags, no non-interactive mode. This wraps its own internal, importable
 * functions (`applyCrop`, same package) directly, the same way
 * `compile_mind_target.mjs` drives MindAR's browser-only Compiler through
 * headless Chrome instead of expecting a human at a keyboard.
 *
 * Critical difference from just accepting the tool's own default crop:
 * `getDefaultCrop()` (internal, not used here) FORCES the tracked region
 * to a 3:4/4:3 aspect ratio — fine for the tool's typical use (photos),
 * wrong for our plaques, which are already an intentional 90x30mm (3:1)
 * landscape. Letting the default crop run would silently discard part of
 * the artwork (confirmed: the previous 1024x1024 square plaques came out
 * cropped to 768x1024 by this exact default, ~25% of the image lost).
 * This script instead passes an explicit crop covering the ENTIRE source
 * image — nothing is ever cropped away.
 *
 * Output `imagePath` also needs a fixup the tool doesn't do itself:
 * `ImageTargetLoader.ts` requires a root-relative served path (e.g.
 * "/assets/image-targets/site-front/site-front_luminance.png"), but the
 * tool writes a bare relative one ("image-targets/..._luminance.png") —
 * documented as an expected manual step in that file's own doc comment.
 *
 * Run:
 *   node tools/compile_8thwall_target.mjs <input.png> <output-folder> <name>
 *   e.g. node tools/compile_8thwall_target.mjs \
 *          tools/plaque/site/plaque-front.png \
 *          public/assets/image-targets/site-front site-front
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

// @8thwall/image-target-cli lives in tools/vendor/image-target-cli/ — an
// ISOLATED npm install, not a root package.json dependency. The root
// project has a pre-existing, unrelated peer-dependency conflict
// (rolldown vs. rolldown-plugin-dts) that breaks `npm install` for any
// new package, even with --legacy-peer-deps; vendoring this tool in its
// own directory sidesteps that entirely rather than fighting it.
const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'image-target-cli');
const { default: sharp } = await import(path.join(VENDOR_DIR, 'node_modules', 'sharp', 'lib', 'index.js'));
const { applyCrop } = await import(
  path.join(VENDOR_DIR, 'node_modules', '@8thwall', 'image-target-cli', 'src', 'apply.js')
);

const [inputArg, folderArg, nameArg] = process.argv.slice(2);
if (!inputArg || !folderArg || !nameArg) {
  console.error('usage: node tools/compile_8thwall_target.mjs <input.png> <output-folder> <name>');
  process.exit(1);
}

const inputPath = path.resolve(inputArg);
const outputFolder = path.resolve(folderArg);
const name = nameArg;

async function main() {
  const image = sharp(inputPath);
  const metadata = await image.metadata();

  // Full-image, non-lossy crop -- see module doc comment for why this
  // can't be the tool's own getDefaultCrop().
  const geometry = {
    top: 0,
    left: 0,
    width: metadata.width,
    height: metadata.height,
    isRotated: false,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
  };

  const { dataPath } = await applyCrop(
    image,
    { type: 'PLANAR', geometry },
    outputFolder,
    name,
    true // overwrite -- this is a build tool re-run on every artwork change, not a one-shot
  );

  // Fixup: root-relative served path, per ImageTargetLoader.ts's own
  // documented requirement (the tool writes a bare relative path).
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  const servedFolder = `/assets/image-targets/${name}`;
  data.imagePath = `${servedFolder}/${path.basename(data.imagePath)}`;
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);

  console.log(`wrote ${dataPath} (imagePath fixed up to ${data.imagePath})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
