#!/usr/bin/env node
// Generate the Windows application icon (installer/windows/dvalincode.ico) from
// the app icon SVG that the web UI and the macOS .icns already use.
//
// Why this exists: Bun's `--windows-icon` takes an `.ico` file, and Windows
// shortcuts, the taskbar, Explorer and the uninstall entry all read the icon
// out of the PE resource — so the one asset we did not have was the only one
// Windows can use. Keeping it generated (and the generator in the tree) means
// the .ico never drifts from the SVG it came from.
//
// Rendering needs a browser: the SVG uses gradients and an feDropShadow filter,
// which librsvg/ImageMagick render differently from the engine that draws the
// real UI. Chromium draws it, hands back raw RGBA for the small sizes and a
// PNG for the large ones, and this script assembles the ICO container itself.
//
// Usage (needs playwright + a Chromium it can launch):
//   node scripts/generate-windows-icon.mjs [--variant dark|light] [--out PATH]

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Classic 32-bpp DIB entries for the sizes Windows draws in lists, menus and
// the taskbar; PNG-compressed entries for the two large ones, which is what
// every Vista-era and later icon does (a 256×256 BGRA bitmap would be 256 KiB
// on its own).
const DIB_SIZES = [16, 24, 32, 48, 64];
const PNG_SIZES = [128, 256];

function parseArgs(argv) {
  const options = { variant: 'dark', out: path.join('installer', 'windows', 'dvalincode.ico') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--variant') options.variant = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.variant !== 'dark' && options.variant !== 'light') {
    throw new Error(`--variant must be 'dark' or 'light' (got '${options.variant}')`);
  }
  return options;
}

/** A 32-bpp bottom-up DIB with an all-zero AND mask: alpha lives in the pixels. */
function dibFromRgba(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight — colour rows + mask rows
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceRow = (size - 1 - y) * size * 4; // ICO rows run bottom-up
    for (let x = 0; x < size; x += 1) {
      const from = sourceRow + x * 4;
      const to = (y * size + x) * 4;
      pixels[to] = rgba[from + 2]; // B
      pixels[to + 1] = rgba[from + 1]; // G
      pixels[to + 2] = rgba[from]; // R
      pixels[to + 3] = rgba[from + 3]; // A
    }
  }
  header.writeUInt32LE(pixels.length, 20); // biSizeImage

  const maskStride = Math.ceil(size / 8 / 4) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskStride * size)]);
}

function buildIco(images) {
  const count = images.length;
  const directory = Buffer.alloc(6 + count * 16);
  directory.writeUInt16LE(0, 0); // reserved
  directory.writeUInt16LE(1, 2); // type 1 = icon
  directory.writeUInt16LE(count, 4);

  let offset = directory.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry); // 0 means 256
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette colours
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([directory, ...images.map((image) => image.data)]);
}

async function render(svg, sizes) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
    const source = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    await page.setContent('<!doctype html><meta charset="utf-8"><body style="margin:0">');
    return await page.evaluate(async ({ source, sizes }) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const out = [];
      for (const size of sizes) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.clearRect(0, 0, size, size);
        context.drawImage(image, 0, 0, size, size);
        out.push({
          size,
          rgba: Array.from(context.getImageData(0, 0, size, size).data),
          png: canvas.toDataURL('image/png').split(',')[1],
        });
      }
      return out;
    }, { source, sizes });
  } finally {
    await browser.close();
  }
}

const options = parseArgs(process.argv.slice(2));
const svgPath = path.join(repoRoot, 'web', 'public', `app-icon-${options.variant}.svg`);
const svg = await readFile(svgPath, 'utf8');

const sizes = [...DIB_SIZES, ...PNG_SIZES].sort((a, b) => a - b);
const rendered = await render(svg, sizes);

const images = rendered.map(({ size, rgba, png }) => ({
  size,
  data: PNG_SIZES.includes(size)
    ? Buffer.from(png, 'base64')
    : dibFromRgba(Uint8Array.from(rgba), size),
}));

const outPath = path.isAbsolute(options.out) ? options.out : path.join(repoRoot, options.out);
await writeFile(outPath, buildIco(images));

console.log(`✓ ${path.relative(repoRoot, outPath)} — ${images.length} sizes (${sizes.join(', ')}) from ${path.relative(repoRoot, svgPath)}`);
