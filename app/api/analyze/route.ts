import { NextResponse } from "next/server";
import {
  AnalyzeRequestSchema,
  type MapPointItem,
} from "@/lib/analysis-types";
import { batchGeocodeTomskOverpass } from "@/lib/geo";
import { heuristicExtractTomsk, severityFromLine } from "@/lib/heuristic-extract";
import {
  callAnthropicExtract,
  callVllmExtract,
  parseLlmJson,
  type ExtractedLocation,
} from "@/lib/llm-extract";
import {
  buildLlmBatchDocumentWithCoords,
  partitionOsmEmbeddedAndPlain,
  stripHashCommentLines,
  type EmbeddedOsmLine,
} from "@/lib/osm-embedded-lines";
import {
  parseProviderList,
  textAnalysisProviderOrder,
} from "@/lib/provider-order";

export const runtime = "nodejs";
export const maxDuration = 60;

function aggregateLocations(
  locs: {
    name_raw: string;
    normalized_address_hint: string;
    severity_1_to_10: number;
    summary_ru: string;
    confidence_0_to_1: number;
    lat?: number | null;
    lon?: number | null;
  }[],
) {
  const map = new Map<
    string,
    {
      name_raw: string;
      normalized_address_hint: string;
      severity_1_to_10: number;
      summaries: string[];
      confidence_0_to_1: number;
      frequency: number;
      lat: number | null;
      lon: number | null;
    }
  >();

  for (const l of locs) {
    const key = l.normalized_address_hint.trim().toLowerCase();
    const latOk =
      l.lat != null &&
      l.lon != null &&
      l.lat >= 56.25 &&
      l.lat <= 56.62 &&
      l.lon >= 84.65 &&
      l.lon <= 85.35;
    const lat = latOk ? l.lat! : null;
    const lon = latOk ? l.lon! : null;

    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        name_raw: l.name_raw,
        normalized_address_hint: l.normalized_address_hint,
        severity_1_to_10: l.severity_1_to_10,
        summaries: [l.summary_ru],
        confidence_0_to_1: l.confidence_0_to_1,
        frequency: 1,
        lat,
        lon,
      });
    } else {
      prev.frequency += 1;
      prev.severity_1_to_10 = Math.max(prev.severity_1_to_10, l.severity_1_to_10);
      prev.summaries.push(l.summary_ru);
      prev.confidence_0_to_1 = Math.min(
        prev.confidence_0_to_1,
        l.confidence_0_to_1,
      );
      if ((prev.lat == null || prev.lon == null) && lat != null && lon != null) {
        prev.lat = lat;
        prev.lon = lon;
      }
    }
  }
  return [...map.values()];
}

function countMentionsInText(nameRaw: string, text: string): number {
  const esc = nameRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (esc.length < 2) return 1;
  const re = new RegExp(esc, "gi");
  return (text.match(re) ?? []).length || 1;
}

function applyServerOsmCoords(
  locations: ExtractedLocation[],
  embedded: EmbeddedOsmLine[],
): void {
  const byId = new Map(embedded.map((e) => [e.id, e]));
  for (const loc of locations) {
    if (loc.kind !== "osm_note") continue;
    const id = loc.osm_note_id?.trim();
    if (!id) continue;
    const a = byId.get(id);
    if (a) {
      loc.lat = a.lat;
      loc.lon = a.lon;
    }
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Некорректный JSON тела запроса." },
      { status: 400 },
    );
  }

  const parsed = AnalyzeRequestSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Ошибка валидации.";
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }

  const { text, maxComments } = parsed.data;

  let clipped = stripHashCommentLines(text);
  if (maxComments !== undefined) {
    const ln = clipped
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    clipped = ln.slice(0, maxComments).join("\n");
  }

  const { embedded: embeddedOsm, plainLines } =
    partitionOsmEmbeddedAndPlain(clipped);

  const plainJoined = plainLines.join("\n");
  const hasPlainText = plainJoined.trim().length > 0;
  const hasEmbeddedOsm = embeddedOsm.length > 0;

  if (!hasPlainText && !hasEmbeddedOsm) {
    return NextResponse.json(
      { ok: false, error: "Нет строк для анализа (после удаления заголовков #)." },
      { status: 400 },
    );
  }

  const order = textAnalysisProviderOrder(
    parseProviderList(process.env.DEMO_FOUNDATION_PROVIDERS),
  );
  const skipLlm = ["1", "true"].includes(
    process.env.BAD_ROADS_SKIP_LLM?.trim().toLowerCase() ?? "",
  );

  const warnings: string[] = [];
  let providerUsed: string | null = null;
  let plainProcessingMode:
    | "foundation_vllm"
    | "foundation_anthropic"
    | "heuristic_fallback" = "heuristic_fallback";
  let extractPlain: { locations: ExtractedLocation[]; warnings: string[] } =
    hasPlainText
      ? heuristicExtractTomsk(plainJoined)
      : { locations: [], warnings: [] };

  if ((hasPlainText || hasEmbeddedOsm) && skipLlm && hasPlainText) {
    warnings.push(
      "Режим без LLM (BAD_ROADS_SKIP_LLM): разбор текста только эвристикой, быстрее и без внешних моделей.",
    );
  }

  if (
    (hasPlainText || hasEmbeddedOsm) &&
    !skipLlm &&
    order.length > 0
  ) {
    if (hasPlainText) {
      extractPlain = heuristicExtractTomsk(plainJoined);
    } else {
      extractPlain = { locations: [], warnings: [] };
    }

    const batchDoc = buildLlmBatchDocumentWithCoords(clipped);

    for (const p of order) {
      try {
        if (p === "vllm") {
          const { content, provider } = await callVllmExtract(batchDoc);
          const next = parseLlmJson(content);
          applyServerOsmCoords(next.locations, embeddedOsm);
          extractPlain = next;
          providerUsed = provider;
          plainProcessingMode = "foundation_vllm";
          break;
        }
        if (p === "anthropic") {
          const { content, provider } = await callAnthropicExtract(batchDoc);
          const next = parseLlmJson(content);
          applyServerOsmCoords(next.locations, embeddedOsm);
          extractPlain = next;
          providerUsed = provider;
          plainProcessingMode = "foundation_anthropic";
          break;
        }
      } catch (e) {
        const em = e instanceof Error ? e.message : String(e).slice(0, 240);
        const timedOut =
          em.includes("timeout") ||
          em.includes("aborted") ||
          (typeof e === "object" &&
            e !== null &&
            "name" in e &&
            (e as { name?: string }).name === "TimeoutError");
        warnings.push(
          timedOut
            ? `Вызов языковой модели прерван по таймауту — используется эвристика. (${em.slice(0, 120)})`
            : `Не удалось извлечь данные автоматической моделью: ${em}`,
        );
      }
    }

    if (!providerUsed) {
      if (hasPlainText) {
        warnings.push(...extractPlain.warnings);
        extractPlain = heuristicExtractTomsk(plainJoined);
        plainProcessingMode = "heuristic_fallback";
      } else {
        extractPlain = { locations: [], warnings: [] };
        plainProcessingMode = "heuristic_fallback";
      }
    } else if (extractPlain.warnings.length) {
      warnings.push(...extractPlain.warnings);
    }
  }

  const plainLocs = extractPlain.locations.filter(
    (l) => (l.kind ?? "plain") === "plain",
  );
  const aggregatedPlain = aggregateLocations(plainLocs);

  const hintsForBatch = aggregatedPlain
    .filter((row) => row.lat == null || row.lon == null)
    .map((row) => row.normalized_address_hint);

  const batchKeyCount = new Set(
    hintsForBatch.map((h) => h.trim().toLowerCase()),
  ).size;
  if (batchKeyCount > 40) {
    warnings.push(
      "Геокодирование одним запросом Overpass: учтены первые 40 уникальных адресов без координат.",
    );
  }

  const batchGeo =
    hintsForBatch.length > 0
      ? await batchGeocodeTomskOverpass(hintsForBatch)
      : new Map<string, { lat: number; lon: number; displayName: string }>();

  const items: MapPointItem[] = [];
  let idx = 0;
  for (const row of aggregatedPlain) {
    idx += 1;
    const freq =
      row.frequency > 1
        ? row.frequency
        : countMentionsInText(row.name_raw, plainJoined || clipped);

    let lat = row.lat;
    let lon = row.lon;
    let normalizedAddress = row.normalized_address_hint;

    const bg = batchGeo.get(row.normalized_address_hint.trim().toLowerCase());
    if ((lat == null || lon == null) && bg) {
      lat = bg.lat;
      lon = bg.lon;
      normalizedAddress = bg.displayName;
    } else if (lat != null && lon != null && providerUsed) {
      normalizedAddress = `${row.name_raw} — Томск`;
    }

    const geo = lat != null && lon != null;
    items.push({
      id: `pt_${idx}_${row.normalized_address_hint.slice(0, 24)}`,
      locationRaw: row.name_raw,
      normalizedAddress,
      lat,
      lon,
      severity: row.severity_1_to_10,
      summary: [...new Set(row.summaries)].slice(0, 4).join(" · "),
      frequency: freq,
      confidence: Math.max(0, Math.min(1, row.confidence_0_to_1)),
      explanation: undefined,
      processingMode: plainProcessingMode,
      outputKind: geo ? "geocoded" : "coords_missing",
      geocodeWarning: geo ? undefined : "Геокодирование не нашло точку",
    });
  }

  const embeddedById = new Map(embeddedOsm.map((e) => [e.id, e]));
  const osmFromLlm = extractPlain.locations.filter((l) => l.kind === "osm_note");
  const coveredOsmIds = new Set<string>();

  for (const loc of osmFromLlm) {
    const id = loc.osm_note_id?.trim();
    if (!id) continue;
    const auth = embeddedById.get(id);
    if (!auth) {
      warnings.push(`LLM вернула osm_note_id=${id}, которого нет во входных данных — пропуск.`);
      continue;
    }
    coveredOsmIds.add(id);
    idx += 1;
    items.push({
      id: `pt_osm_${id}_${idx}`,
      locationRaw: loc.name_raw.slice(0, 220),
      normalizedAddress: loc.normalized_address_hint,
      lat: auth.lat,
      lon: auth.lon,
      severity: loc.severity_1_to_10,
      summary: loc.summary_ru.slice(0, 200),
      frequency: 1,
      confidence: Math.max(0, Math.min(1, loc.confidence_0_to_1)),
      explanation: undefined,
      processingMode: providerUsed
        ? `${plainProcessingMode}_osm_note`
        : "heuristic_osm_note",
      outputKind: "osm_coordinates",
    });
  }

  for (let i = 0; i < embeddedOsm.length; i += 1) {
    const e = embeddedOsm[i]!;
    if (coveredOsmIds.has(e.id)) continue;
    idx += 1;
    items.push({
      id: `pt_osm_${e.id}_${idx}`,
      locationRaw: e.text.slice(0, 220),
      normalizedAddress: `OpenStreetMap заметка №${e.id}`,
      lat: e.lat,
      lon: e.lon,
      severity: severityFromLine(e.text),
      summary: e.text.slice(0, 200),
      frequency: 1,
      confidence: 0.92,
      processingMode: "osm_note_embedded",
      outputKind: "osm_coordinates",
    });
  }

  if (aggregatedPlain.length > 0 && embeddedOsm.length > 0) {
    warnings.push(
      "Смешанный режим: свободный текст и заметки OSM обработаны одним батчем LLM (координаты OSM сверены с сервером).",
    );
  }

  if (embeddedOsm.length > 0 && !hasPlainText) {
    warnings.push(
      "Только строки OSM: извлечение и метки тяжести — из одного ответа LLM по всем заметкам.",
    );
  }

  const plainGeoItems = items.filter((it) => !it.id.startsWith("pt_osm_"));
  if (
    plainGeoItems.length &&
    plainGeoItems.every((i) => i.lat == null)
  ) {
    warnings.push(
      "Не удалось геокодировать адреса автоматически. Проверьте конкретность формулировок.",
    );
  }

  const explanationPlain =
    !hasPlainText && !hasEmbeddedOsm
      ? "Нет текстовых строк для разбора."
      : providerUsed == null
        ? hasPlainText
          ? "Свободный текст: эвристика; заметки OSM при наличии — из серверных координат."
          : "Без вызова LLM — смотрите эвристику или только встроенные точки."
        : "Один батч LLM: все [plain] и [osm_note] строки → единый JSON; координаты OSM выровнены по данным сервера.";

  const explanation = explanationPlain;

  const hadBatchGeo = hintsForBatch.length > 0;
  const geoMeta = !hasPlainText
    ? "none"
    : hadBatchGeo
      ? "overpass_single_request"
      : "llm_inline_only";

  return NextResponse.json({
    ok: true,
    warnings,
    explanation,
    providerUsed,
    items,
    diagnostics: {
      attempts: order.join(","),
      linesReceived: text
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean).length,
      plainLines: plainLines.length,
      osmEmbeddedLines: embeddedOsm.length,
      geoProvider: geoMeta,
    },
  });
}
