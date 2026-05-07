import sharp from "sharp";

export const MAX_DIMENSION = 1024;

export type DimensionCheck =
  | { ok: true; width: number; height: number; resizedBuffer?: Buffer }
  | { ok: false; warning: string; width: number; height: number };

export async function checkOrResizeImage(
  input: Buffer,
): Promise<DimensionCheck> {
  const meta = await sharp(input).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) {
    return {
      ok: false,
      warning: "Не удалось прочитать размеры изображения.",
      width: w,
      height: h,
    };
  }
  const maxDim = Math.max(w, h);
  if (maxDim <= MAX_DIMENSION) {
    return { ok: true, width: w, height: h };
  }
  const scale = MAX_DIMENSION / maxDim;
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const resizedBuffer = await sharp(input)
    .resize(nw, nh, { fit: "inside" })
    .jpeg({ quality: 88 })
    .toBuffer();
  return {
    ok: true,
    width: nw,
    height: nh,
    resizedBuffer,
  };
}

export function bufferToDataUrlJpeg(buf: Buffer): string {
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}
