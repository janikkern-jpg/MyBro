// Erzeugt PNG-Icons aus public/kern-control.png für Favicon, PWA und
// iOS-Homescreen. Erneut ausführen, wenn sich das Quell-Bild ändert:
//   node scripts/generate-icons.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const publicDir = resolve(projectRoot, "public");
const srcImage = resolve(publicDir, "kern-control.png");

/** @type {Array<{ file: string; size: number }>} */
const targets = [
  { file: "icon-512.png", size: 512 },
  { file: "icon-192.png", size: 192 },
  { file: "apple-touch-icon.png", size: 180 },
  { file: "favicon-32.png", size: 32 },
];

const input = await readFile(srcImage);

await Promise.all(
  targets.map(async ({ file, size }) => {
    const out = resolve(publicDir, file);
    await sharp(input)
      .resize(size, size, {
        fit: "contain",
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .png()
      .toFile(out);
    console.log(`  ✓ ${file} (${size}x${size})`);
  }),
);

console.log("Fertig.");
