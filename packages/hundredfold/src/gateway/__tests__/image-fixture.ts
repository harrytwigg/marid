/**
 * A phone-photo-shaped JPEG for the image-variant suites: far more pixels than a
 * preview tile needs, and patterned rather than flat so the encoder cannot make
 * the original artificially tiny and flatter the thumbnail's saving.
 */
export async function photoBuffer(width = 3024, height = 2268): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    const x = (index / 3) % width;
    const y = Math.floor(index / 3 / width);
    pixels[index] = (x * 7 + y * 3) % 256;
    pixels[index + 1] = (x ^ y) % 256;
    pixels[index + 2] = (x * 3 + y * 11) % 256;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}
