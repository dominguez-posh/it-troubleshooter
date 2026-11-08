import { nativeImage } from 'electron';
import { ShotError, type ImageOps } from './shots';

/** Bild-Ein-/Ausgabe über Electron (BGRA-Bitmap). Wird nur für Schwärzen und Doku-Export genutzt. */
export const electronImageOps: ImageOps = {
  decode(jpeg) {
    const img = nativeImage.createFromBuffer(jpeg);
    if (img.isEmpty()) throw new ShotError('Das Bild konnte nicht gelesen werden.');
    const { width, height } = img.getSize();
    return { width, height, data: img.toBitmap() };
  },
  encode(raw, quality) {
    return nativeImage.createFromBitmap(raw.data, { width: raw.width, height: raw.height }).toJPEG(quality);
  },
};
