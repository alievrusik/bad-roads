import { NextResponse } from "next/server";
import {
  AnalyzeRequestSchema,
  type MapPointItem,
} from "@/lib/analysis-types";
import { geocodeTomskStreet } from "@/lib/geo";
import { heuristicExtractTomsk } from "@/lib/heuristic-extract";
import {
  callAnthropicExtract,
  callVllmExtract,
  parseLlmJson,
} from "@/lib/llm-extract";
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
    }
  >();

  for (const l of locs) {
    const key = l.normalized_address_hint.trim().toLowerCase();
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        name_raw: l.name_raw,
        normalized_address_hint: l.normalized_address_hint,
        severity_1_to_10: l.severity_1_to_10,
        summaries: [l.summary_ru],
        confidence_0_to_1: l.confidence_0_to_1,
        frequency: 1,
      });
    } else {
      prev.frequency += 1;
      prev.severity_1_to_10 = Math.max(prev.severity_1_to_10, l.severity_1_to_10);
      prev.summaries.push(l.summary_ru);
      prev.confidence_0_to_1 = Math.min(
        prev.confidence_0_to_1,
        l.confidence_0_to_1,
      );
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
    const msg = parsed.error.errors[0]?.message ?? "Ошибка валидации.";
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }

  const { text, maxComments } = parsed.data;
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const clipped =
    typeof maxComments === "number"
      ? lines.slice(0, maxComments).join("\n")
      : text;

  const order = textAnalysisProviderOrder(
    parseProviderList(process.env.DEMO_FOUNDATION_PROVIDERS),
  );

  const warnings: string[] = [];
  let providerUsed: string | null = null;
  let processingMode:
    | "foundation_vllm"
    | "foundation_anthropic"
    | "heuristic_fallback" = "heuristic_fallback";
  let extract = heuristicExtractTomsk(clipped);

  for (const p of order) {
    try {
      if (p === "vllm") {
        const { content, provider } = await callVllmExtract(clipped);
        extract = parseLlmJson(content);
        providerUsed = provider;
        processingMode = "foundation_vllm";
        break;
      }
      if (p === "anthropic") {
        const { content, provider } = await callAnthropicExtract(clipped);
        extract = parseLlmJson(content);
        providerUsed = provider;
        processingMode = "foundation_anthropic";
        break;
      }
    } catch (e) {
      warnings.push(
        `Не удалось извлечь данные автоматической моделью: ${
          e instanceof Error ? e.message : String(e).slice(0, 240)
        }`,
      );
    }
  }

  if (!providerUsed) {
    warnings.push(...extract.warnings);
    extract = heuristicExtractTomsk(clipped);
  } else if (extract.warnings.length) {
    warnings.push(...extract.warnings);
  }

  const aggregated = aggregateLocations(extract.locations);

  const items: MapPointItem[] = [];
  let idx = 0;
  for (const row of aggregated) {
    idx += 1;
    const freq =
      row.frequency > 1
        ? row.frequency
        : countMentionsInText(row.name_raw, clipped);

    const geo = await geocodeTomskStreet(row.normalized_address_hint);

    items.push({
      id: `pt_${idx}_${row.normalized_address_hint.slice(0, 24)}`,
      locationRaw: row.name_raw,
      normalizedAddress: geo?.displayName ?? row.normalized_address_hint,
      lat: geo?.lat ?? null,
      lon: geo?.lon ?? null,
      severity: row.severity_1_to_10,
      summary: [...new Set(row.summaries)].slice(0, 4).join(" · "),
      frequency: freq,
      confidence: Math.max(0, Math.min(1, row.confidence_0_to_1)),
      explanation: undefined,
      processingMode,
      outputKind: geo ? "geocoded" : "coords_missing",
      geocodeWarning: geo ? undefined : "Геокодирование не нашло точку",
    });
  }

  if (items.length && items.every((i) => i.lat == null)) {
    warnings.push(
      "Не удалось геокодировать адреса автоматически. Проверьте конкретность формулировок.",
    );
  }

  return NextResponse.json({
    ok: true,
    warnings,
    explanation:
      providerUsed == null
        ? "Анализ выполнен локальными эвристиками без вызова языковой модели."
        : "Извлечение адресов и оценки тяжести выполнены языковой моделью на сервере.",
    providerUsed,
    items,
    diagnostics: {
      attempts: order.join(","),
      linesReceived: lines.length,
      geoProvider: "photon_then_nominatim",
    },
  });
}
