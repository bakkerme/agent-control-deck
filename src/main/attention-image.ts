import { nativeImage, type NativeImage } from "electron";

// Bundled PNG keeps the taskbar overlay available in development and packaged builds.
const lampPng = "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";
export function inputLamp(size = 16): NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(lampPng, "base64"))
    .resize({ width: size, height: size });
}

export function dockIconWithLamp(original: NativeImage): NativeImage {
  const size = 256;
  const lampSize = 96;
  const bitmap = Buffer.from(original.resize({ width: size, height: size }).toBitmap());
  const lamp = inputLamp(lampSize).toBitmap();
  // Both images come from toBitmap(): their channel order and premultiplication match.
  for (let y = 0; y < lampSize; y++) {
    for (let x = 0; x < lampSize; x++) {
      const source = (y * lampSize + x) * 4;
      const target = ((y + size - lampSize) * size + x + size - lampSize) * 4;
      const remaining = 1 - lamp[source + 3] / 255;
      for (let channel = 0; channel < 4; channel++) {
        bitmap[target + channel] = Math.min(255, Math.round(lamp[source + channel] + bitmap[target + channel] * remaining));
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
}
