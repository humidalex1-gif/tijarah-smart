import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { APP_ICON_SVG, MASKABLE_ICON_SVG } from "../src/lib/pwa";

/**
 * Renders the app icons from the SVG in `src/lib/pwa.ts`.
 *
 *   node --import tsx scripts/build-icons.ts
 *
 * The SOURCE of the mark is the SVG, kept in code and covered by tests; these
 * PNGs are generated output. An install is refused without 192 and 512, and
 * iOS ignores the manifest's icons entirely, reading `apple-touch-icon`
 * instead — so all four files below are load-bearing, not decorative.
 *
 * Committed rather than built on deploy: the server builds from source with no
 * image toolchain guaranteed, and a missing icon degrades an install silently.
 */

const OUT = path.join(process.cwd(), "public");

const TARGETS = [
  { file: "icon-192.png", size: 192, svg: APP_ICON_SVG },
  { file: "icon-512.png", size: 512, svg: APP_ICON_SVG },
  { file: "icon-maskable-512.png", size: 512, svg: MASKABLE_ICON_SVG },
  // iOS renders this at 180 and applies its own rounded-rectangle mask, which
  // is gentler than Android's circle — the plain mark survives it.
  { file: "apple-touch-icon.png", size: 180, svg: APP_ICON_SVG },
];

async function main() {
  await mkdir(OUT, { recursive: true });

  for (const target of TARGETS) {
    const png = await sharp(Buffer.from(target.svg))
      .resize(target.size, target.size)
      .png()
      .toBuffer();
    await writeFile(path.join(OUT, target.file), png);
    console.log(`${target.file.padEnd(26)} ${target.size}x${target.size}  ${png.length} bytes`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
