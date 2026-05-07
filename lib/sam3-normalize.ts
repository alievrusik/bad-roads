export type Sam3Diagnostic = {
  processingMode: "remote" | "fallback_visual";
  outputKind: "json" | "image" | "mixed" | "empty";
  attemptUsed: "sam3-image" | "none";
  upstreamStatus?: number;
  message?: string;
};

export type NormalizedDetection = {
  id: string;
  labelEn: string;
  score?: number;
  polygon?: [number, number][];
  bbox?: { x: number; y: number; width: number; height: number };
  maskIndex?: number;
};

export type Sam3NormalizedResponse = {
  ok: boolean;
  warnings: string[];
  diagnostics: Sam3Diagnostic;
  textPromptEn: string;
  previewDataUrl: string | null;
  overlayDataUrl: string | null;
  detections: NormalizedDetection[];
  rawJson?: unknown;
};

function toDataUrl(
  buf: ArrayBuffer,
  mime: "image/png" | "image/jpeg" | "image/webp",
): string {
  const b64 = Buffer.from(buf).toString("base64");
  return `data:${mime};base64,${b64}`;
}

function polygonFromFlatNumbers(nums: number[]): [number, number][] | undefined {
  if (nums.length < 6 || nums.length % 2 !== 0) return undefined;
  const out: [number, number][] = [];
  for (let i = 0; i < nums.length; i += 2) {
    out.push([nums[i]!, nums[i + 1]!]);
  }
  return out;
}

function bboxFromPolygon(poly: [number, number][] | undefined) {
  if (!poly?.length) return undefined;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of poly) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function pickImageMime(ct: string | null): "image/png" | "image/jpeg" | "image/webp" {
  if (ct?.includes("jpeg") || ct?.includes("jpg")) return "image/jpeg";
  if (ct?.includes("webp")) return "image/webp";
  return "image/png";
}

export function coerceRemoteImageUrl(
  input: string,
): string | typeof input {
  const t = input.trim();
  if (t.startsWith("data:")) return t;
  if (t.startsWith("http://") || t.startsWith("https://")) return t;
  try {
    if (/^[A-Za-z0-9+/=\s]+$/.test(t) && t.length > 256) {
      return `data:image/jpeg;base64,${t.replace(/\s/g, "")}`;
    }
  } catch {
    /* ignore */
  }
  return input;
}

export function fallbackSam3Payload(textPromptEn: string): Sam3NormalizedResponse {
  const w = 640;
  const h = 420;
  const svg = `
<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>
  <defs>
    <linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0' stop-color='#e5e7eb'/><stop offset='1' stop-color='#dbeafe'/>
    </linearGradient>
  </defs>
  <rect width='100%' height='100%' fill='url(#g)'/>
  <rect x='80' y='220' rx='24' ry='24' width='460' height='120' fill='#fbbf24' fill-opacity='0.35' stroke='#d97706' stroke-width='3'/>
  <text x='40' y='48' fill='#111827' font-family='Arial' font-size='20'>SAM3 недоступен — локальный предпросмотр</text>
  <text x='40' y='84' fill='#374151' font-family='Arial' font-size='14'>Подсказка (EN): ${escapeXml(textPromptEn)}</text>
  <text x='40' y='112' fill='#6b7280' font-family='Arial' font-size='13'>
    Загрузите снимок дороги. Сервер пробует удалённую сегментацию; при ошибке показывается эта схема.
  </text>
</svg>`.trim();
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return {
    ok: true,
    warnings: [
      "Использован локальный fallback: удалённый сервис сегментации не вернул изображений или недоступен.",
    ],
    diagnostics: {
      processingMode: "fallback_visual",
      outputKind: "image",
      attemptUsed: "none",
      message: "local_synthetic_preview",
    },
    textPromptEn,
    previewDataUrl: dataUrl,
    overlayDataUrl: dataUrl,
    detections: [
      {
        id: "synthetic-region",
        labelEn: textPromptEn || "road damage region",
        score: 0.35,
        polygon: [
          [80, 220],
          [540, 220],
          [540, 340],
          [80, 340],
        ],
        bbox: { x: 80, y: 220, width: 460, height: 120 },
      },
    ],
  };
}

function escapeXml(s: string): string {
  return s.replace(/[&<>'"]/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" }[
      ch
    ] ?? ch),
  );
}

function extractFirstUrl(blob: Record<string, unknown>): string | null {
  const keys = ["overlay", "preview", "preview_image", "overlay_image", "image"];
  for (const k of keys) {
    const v = blob[k];
    if (typeof v === "string" && (v.startsWith("http") || v.startsWith("data:"))) {
      return v;
    }
  }
  return null;
}

export async function normalizeSam3Response(
  res: Response,
  textPromptEn: string,
): Promise<Sam3NormalizedResponse> {
  const diagnostics: Sam3Diagnostic = {
    processingMode: "remote",
    outputKind: "empty",
    attemptUsed: "sam3-image",
    upstreamStatus: res.status,
  };

  if (!res.ok) {
    return {
      ...fallbackSam3Payload(textPromptEn),
      diagnostics: {
        ...diagnostics,
        processingMode: "fallback_visual",
        message: `upstream_${res.status}`,
      },
      warnings: [
        `Запрос к сегментации завершился с кодом ${res.status}.`,
        ...fallbackSam3Payload(textPromptEn).warnings,
      ],
    };
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.startsWith("image/")) {
    const buf = await res.arrayBuffer();
    const mime = pickImageMime(ct);
    const dataUrl = toDataUrl(buf, mime);
    diagnostics.outputKind = "image";
    return {
      ok: true,
      warnings: [],
      diagnostics,
      textPromptEn,
      previewDataUrl: dataUrl,
      overlayDataUrl: dataUrl,
      detections: [
        {
          id: "full-frame",
          labelEn: textPromptEn,
          polygon: [],
          bbox: { x: 0, y: 0, width: 100, height: 100 },
        },
      ],
    };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return {
      ...fallbackSam3Payload(textPromptEn),
      diagnostics: { ...diagnostics, outputKind: "empty", processingMode: "fallback_visual", message: "invalid_json_body" },
      warnings: ["Ответ сервера не является JSON и не изображением.", ...fallbackSam3Payload(textPromptEn).warnings],
    };
  }

  const blob = json as Record<string, unknown>;
  diagnostics.outputKind = "json";

  const detectionsRaw = blob["detections"];
  const masksRaw = blob["masks"];
  const items: NormalizedDetection[] = [];

  if (Array.isArray(detectionsRaw)) {
    detectionsRaw.forEach((d, idx) => {
      if (!d || typeof d !== "object") return;
      const o = d as Record<string, unknown>;
      const polyFlat = o["polygon"] ?? o["points"];
      let poly: [number, number][] | undefined;
      if (Array.isArray(polyFlat) && polyFlat.length && typeof polyFlat[0] === "number") {
        poly = polygonFromFlatNumbers(polyFlat as number[]);
      } else if (Array.isArray(polyFlat)) {
        const maybe = polyFlat as unknown[];
        poly = [];
        for (const p of maybe) {
          if (Array.isArray(p) && p.length >= 2 && typeof p[0] === "number") {
            poly.push([Number(p[0]), Number(p[1])]);
          }
        }
        if (!poly.length) poly = undefined;
      }
      const bbox =
        typeof o["bbox_x"] === "number"
          ? {
              x: Number(o["bbox_x"]),
              y: Number(o["bbox_y"]),
              width: Number(o["bbox_w"] ?? o["width"] ?? 0),
              height: Number(o["bbox_h"] ?? o["height"] ?? 0),
            }
          : bboxFromPolygon(poly);

      items.push({
        id: String(o["id"] ?? idx),
        labelEn: textPromptEn,
        score: typeof o["score"] === "number" ? (o["score"] as number) : undefined,
        polygon: poly,
        bbox,
        maskIndex: idx,
      });
    });
  } else if (Array.isArray(masksRaw)) {
    masksRaw.forEach((_, idx) =>
      items.push({
        id: `mask_${idx}`,
        labelEn: textPromptEn,
        maskIndex: idx,
      }),
    );
  }

  let preview =
    typeof blob["preview"] === "string"
      ? blob["preview"]
      : typeof blob["preview_base64"] === "string"
        ? `data:image/png;base64,${String(blob["preview_base64"]).replace(/\s/g, "")}`
        : null;
  let overlay =
    typeof blob["overlay"] === "string"
      ? blob["overlay"]
      : typeof blob["overlay_base64"] === "string"
        ? `data:image/png;base64,${String(blob["overlay_base64"]).replace(/\s/g, "")}`
        : null;

  if (!preview && !overlay) {
    const first = extractFirstUrl(blob);
    if (first) {
      preview = first;
      overlay = first;
    }
  }

  if (!preview && overlay) preview = overlay;
  if (!overlay && preview) overlay = preview;

  const emptyDetections =
    items.length === 0 && !(preview ?? overlay)?.length && !blob["preview"];

  if (emptyDetections) {
    return {
      ...fallbackSam3Payload(textPromptEn),
      diagnostics: {
        ...diagnostics,
        outputKind: "empty",
        processingMode: "fallback_visual",
        message: "upstream_empty_masks",
      },
      warnings: [
        "Ответ содержит пустые детекции — показана локальная схема.",
        ...fallbackSam3Payload(textPromptEn).warnings,
      ],
      rawJson: json,
    };
  }

  diagnostics.outputKind =
    preview || overlay ? "mixed" : "json";

  return {
    ok: true,
    warnings: [],
    diagnostics,
    textPromptEn,
    previewDataUrl: preview,
    overlayDataUrl: overlay,
    detections: items.length ? items : [
      {
        id: "inferred-region",
        labelEn: textPromptEn,
      },
    ],
    rawJson: json,
  };
}

export function bboxFromNormalizedDetections(det: NormalizedDetection[]) {
  return det.flatMap((d) => (d.bbox ? [d.bbox] : []));
}
