import { Buffer } from "node:buffer";
import { NextResponse } from "next/server";
import {
  bufferToDataUrlJpeg,
  checkOrResizeImage,
  MAX_DIMENSION,
} from "@/lib/image-resize";
import {
  coerceRemoteImageUrl,
  fallbackSam3Payload,
  normalizeSam3Response,
} from "@/lib/sam3-normalize";

export const runtime = "nodejs";

function parseOptionalJsonField(
  raw: FormDataEntryValue | null,
  label: string,
): unknown | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label}: неверный JSON.`);
  }
}

async function fetchUrlAsBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Загрузка изображения по URL завершилась с ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function jsonOptionsBody(input: unknown) {
  return JSON.stringify(input);
}

export async function POST(req: Request) {
  const base = process.env.SAM3_API_BASE_URL?.replace(/\/$/, "");
  const key = process.env.SAM3_API_KEY;
  if (!base || !key) {
    const fb = fallbackSam3Payload("road pothole");
    return NextResponse.json(
      {
        ...fb,
        warnings: [
          ...fb.warnings,
          "Переменные окружения для сегментации не заданы (SAM3_API_BASE_URL / SAM3_API_KEY).",
        ],
        diagnostics: {
          ...fb.diagnostics,
          message: "missing_env",
        },
      },
      { status: 200 },
    );
  }

  const ct = req.headers.get("content-type") ?? "";
  let textPromptEn = "pothole, damaged asphalt, road defect";
  let imageField: string | undefined;
  let pointsInput: unknown;
  let pointLabelsInput: unknown;
  let boxesInput: unknown;
  let returnPreview = true;
  let returnOverlay = true;
  let returnMasks = false;
  let threshold = 0.45;
  let pointsPerSide = 32;
  let predIouThresh = 0.88;
  let maxMasks = 8;

  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const img = form.get("image");
    const urlField = form.get("imageUrl");
    if (typeof urlField === "string" && urlField.trim()) {
      imageField = urlField.trim();
    } else if (img instanceof File) {
      const ab = await img.arrayBuffer();
      imageField = bufferToDataUrlJpeg(Buffer.from(ab));
    }
    const prompt = form.get("text_prompt");
    if (typeof prompt === "string" && prompt.trim()) {
      textPromptEn = prompt.trim();
    }
    const pi = form.get("points_input");
    const pli = form.get("point_labels_input");
    const bi = form.get("boxes_input");
    try {
      pointsInput = parseOptionalJsonField(pi as FormDataEntryValue | null, "points_input");
      pointLabelsInput = parseOptionalJsonField(
        pli as FormDataEntryValue | null,
        "point_labels_input",
      );
      boxesInput = parseOptionalJsonField(bi as FormDataEntryValue | null, "boxes_input");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }
  } else {
    const json = (await req.json()) as Record<string, unknown>;
    if (typeof json.text_prompt === "string" && json.text_prompt.trim()) {
      textPromptEn = json.text_prompt.trim();
    }
    if (typeof json.image === "string") imageField = json.image;
    pointsInput = json.points_input;
    pointLabelsInput = json.point_labels_input;
    boxesInput = json.boxes_input;
    if (typeof json.return_preview === "boolean")
      returnPreview = json.return_preview;
    if (typeof json.return_overlay === "boolean")
      returnOverlay = json.return_overlay;
    if (typeof json.return_masks === "boolean")
      returnMasks = json.return_masks;
    if (typeof json.threshold === "number") threshold = json.threshold;
    if (typeof json.points_per_side === "number")
      pointsPerSide = json.points_per_side;
    if (typeof json.pred_iou_thresh === "number")
      predIouThresh = json.pred_iou_thresh;
    if (typeof json.max_masks === "number") maxMasks = json.max_masks;
  }

  if (!imageField?.trim()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Нужно передать изображение (image в JSON или поле image в форме).",
      },
      { status: 400 },
    );
  }

  let imagePayload = coerceRemoteImageUrl(imageField);
  const extraWarnings: string[] = [];

  try {
    if (
      typeof imagePayload === "string" &&
      (imagePayload.startsWith("http://") || imagePayload.startsWith("https://"))
    ) {
      const buf = await fetchUrlAsBuffer(imagePayload);
      const dim = await checkOrResizeImage(buf);
      if (!dim.ok) {
        extraWarnings.push(dim.warning);
      } else if (dim.resizedBuffer) {
        imagePayload = bufferToDataUrlJpeg(dim.resizedBuffer);
        extraWarnings.push(
          `Изображение уменьшено до максимального ребра ${MAX_DIMENSION} px перед отправкой.`,
        );
      }
    } else if (
      typeof imagePayload === "string" &&
      imagePayload.startsWith("data:")
    ) {
      const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(imagePayload);
      if (m?.[1]) {
        const buf = Buffer.from(m[1], "base64");
        const dim = await checkOrResizeImage(buf);
        if (!dim.ok) {
          extraWarnings.push(dim.warning);
        } else if (dim.resizedBuffer) {
          imagePayload = bufferToDataUrlJpeg(dim.resizedBuffer);
          extraWarnings.push(
            `Изображение уменьшено до максимального ребра ${MAX_DIMENSION} px перед отправкой.`,
          );
        }
      }
    }
  } catch (e) {
    extraWarnings.push(
      `Предобработка изображения: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const body: Record<string, unknown> = {
    image: imagePayload,
    text_prompt: textPromptEn,
    return_preview: returnPreview,
    return_overlay: returnOverlay,
    return_masks: returnMasks,
    threshold,
    points_per_side: pointsPerSide,
    pred_iou_thresh: predIouThresh,
    max_masks: maxMasks,
  };

  if (pointsInput !== undefined) {
    body.points_input =
      typeof pointsInput === "string"
        ? pointsInput
        : JSON.stringify(pointsInput);
  }
  if (pointLabelsInput !== undefined) {
    body.point_labels_input =
      typeof pointLabelsInput === "string"
        ? pointLabelsInput
        : JSON.stringify(pointLabelsInput);
  }
  if (boxesInput !== undefined) {
    body.boxes_input =
      typeof boxesInput === "string" ? boxesInput : JSON.stringify(boxesInput);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/sam3-image`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: jsonOptionsBody(body),
    });
  } catch (e) {
    const fb = fallbackSam3Payload(textPromptEn);
    return NextResponse.json(
      {
        ...fb,
        warnings: [
          ...fb.warnings,
          ...extraWarnings,
          `Сетевая ошибка: ${e instanceof Error ? e.message : String(e)}`,
        ],
        diagnostics: {
          ...fb.diagnostics,
          upstreamStatus: 0,
          message: "network_error",
        },
      },
      { status: 200 },
    );
  }

  const normalized = await normalizeSam3Response(upstream, textPromptEn);
  return NextResponse.json(
    {
      ...normalized,
      warnings: [...extraWarnings, ...normalized.warnings],
    },
    { status: 200 },
  );
}
