// Pink emblem with transparent background, cropped to fill the native tray slot.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
let png;
function trayPng() {
  png ??= fs.readFileSync(path.join(__dirname, '..', 'assets', 'ui', 'tray-icon.png'));
  return png;
}

function createAppImage(nativeImage, size = 256) {
  if (!Number.isInteger(size) || size < 1 || size > 256) throw new RangeError('Icon size must be between 1 and 256.');
  const source = nativeImage.createFromBuffer(trayPng());
  const { width, height } = source.getSize();
  const bitmap = source.toBitmap();
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // Ignore almost-transparent generation residue when fitting the actual emblem.
    if (bitmap[(y * width + x) * 4 + 3] < 8) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  let image = source;
  if (right >= left && bottom >= top) {
    // Keep the proportions and about half an output pixel around the tips.
    const contentSize = Math.max(right - left + 1, bottom - top + 1);
    const padding = Math.max(2, Math.ceil(contentSize / 64));
    const side = Math.min(width, height, contentSize + padding * 2);
    const x = Math.max(0, Math.min(width - side, Math.floor((left + right + 1 - side) / 2)));
    const y = Math.max(0, Math.min(height - side, Math.floor((top + bottom + 1 - side) / 2)));
    image = source.crop({ x, y, width: side, height: side });
  }
  return image.resize({ width: size, height: size, quality: 'best' });
}

function createTrayImage(nativeImage) { return createAppImage(nativeImage, 32); }

module.exports = { trayPng, createAppImage, createTrayImage };
