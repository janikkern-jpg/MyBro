// Erzeugt PNG-Icons aus public/icon.svg für Favicon, PWA und iOS-Homescreen.
// Erneut ausführen, wenn sich public/icon.svg ändert:
//   node scripts/generate-icons.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const publicDir = resolve(projectRoot, "public");
const srcSvg = resolve(publicDir, "icon.svg");

/** @type {Array<{ file: string; size: number }>} */
const targets = [
  { file: "icon-512.png", size: 512 },
  { file: "icon-192.png", size: 192 },
  { file: "apple-touch-icon.png", size: 180 },
  { file: "favicon-32.png", size: 32 },
];

const svg = await readFile(srcSvg);

await Promise.all(
  targets.map(async ({ file, size }) => {
    const out = resolve(publicDir, file);
    await sharp(svg, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(out);
    console.log(`  ✓ ${file} (${size}x${size})`);
  }),
);

console.log("Fertig.");
