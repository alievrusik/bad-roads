import { z } from "zod";

const LlmLocationSchema = z.object({
  name_raw: z.string(),
  normalized_address_hint: z.string(),
  severity_1_to_10: z.number().min(1).max(10),
  summary_ru: z.string(),
  confidence_0_to_1: z.number().min(0).max(1).optional(),
  /** Одним JSON вместе с фактами: координаты в городе Томск (если уверенно), иначе null/опусти поля. */
  lat: z.number().nullable().optional(),
  lon: z.number().nullable().optional(),
});

const LlmExtractSchema = z.object({
  locations: z.array(LlmLocationSchema),
  warnings: z.array(z.string()).optional(),
});

export type ExtractedLocation = z.infer<typeof LlmLocationSchema> & {
  confidence_0_to_1: number;
};

function stripJsonFence(text: string): string {
  const t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(t);
  if (fence?.[1]) return fence[1].trim();
  return t;
}

function coerceJsonPayload(text: string): string {
  const stripped = stripJsonFence(text.trim());
  try {
    JSON.parse(stripped);
    return stripped;
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return stripped.slice(start, end + 1);
    }
    throw new Error("No JSON object found");
  }
}

export function parseLlmJson(content: string): {
  locations: ExtractedLocation[];
  warnings: string[];
} {
  const raw = coerceJsonPayload(content);
  const parsed: unknown = JSON.parse(raw);
  const v = LlmExtractSchema.safeParse(parsed);
  if (!v.success) {
    throw new Error("LLM JSON schema mismatch");
  }
  const locs = v.data.locations.map((l) => {
    let lat = l.lat ?? null;
    let lon = l.lon ?? null;
    const bboxOk =
      lat != null &&
      lon != null &&
      lat >= 56.25 &&
      lat <= 56.62 &&
      lon >= 84.65 &&
      lon <= 85.35;
    if (!bboxOk) {
      lat = null;
      lon = null;
    }
    return {
      ...l,
      lat,
      lon,
      confidence_0_to_1: l.confidence_0_to_1 ?? 0.65,
    };
  });
  return { locations: locs, warnings: v.data.warnings ?? [] };
}

const EXTRACTION_SYSTEM_EN = `You are a precise information extraction tool for Russian social media about road quality in Tomsk (Tomsk Oblast, Russia).
The user message is ONE batch document: numbered lines. You MUST read every line for context; extract road-related locations from all relevant content.
Some lines may be machine-prefixed: [[osm-note id=... lat=... lon=...]] followed by text — do NOT add those to "locations" (the server already has their coordinates). Use them only as context for nearby plain lines.
From every plain (non-[[osm-note]]) line that describes a road/street problem, extract distinct locations.
Output ONLY valid JSON (no markdown) with this shape:
{"locations":[{"name_raw":"...","normalized_address_hint":"short Russian address with street type for geocoding","severity_1_to_10":1-10,"summary_ru":"one short Russian phrase","confidence_0_to_1":0-1,"lat":56.48,"lon":84.95}],"warnings":[]}
Optional lat/lon: WGS84 decimals inside Tomsk urban bbox ONLY if you are confident (lat ~56.25–56.62, lon ~84.65–85.35). Otherwise omit lat/lon or set both null.
Rules:
- severity_1_to_10: 10 = emergency / deep pothole / impassable; 1 = cosmetic / minor crack.
- If no location is explicit, skip the mention (do not invent streets).
- Keep name_raw as in text; normalized_address_hint should be a concise geocoding query in Russian (e.g. "ул. Иркутская, Томск").
- Duplicates in the same comment line can be merged in one object with higher severity.
- warnings: short English notes if text is ambiguous.`;

export function buildExtractionUserPayload(text: string): string {
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
  return [
    `Below are ${lines.length} lines in ONE batch (analyze all of them together).`,
    "",
    numbered,
  ].join("\n");
}

const LLM_FETCH_TIMEOUT_MS = 22_000;

export async function callVllmExtract(text: string): Promise<{
  content: string;
  provider: "vllm";
}> {
  const base = process.env.DEMO_VLLM_BASE_URL?.replace(/\/$/, "");
  const key = process.env.DEMO_VLLM_API_KEY;
  const model = process.env.DEMO_VLLM_MODEL;
  if (!base || !key || !model) {
    throw new Error("vLLM env not configured");
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 4096,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_EN },
        { role: "user", content: buildExtractionUserPayload(text) },
      ],
    }),
    signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`vLLM ${res.status}: ${err.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("vLLM empty content");
  return { content, provider: "vllm" };
}

export async function callAnthropicExtract(text: string): Promise<{
  content: string;
  provider: "anthropic";
}> {
  const configured =
    process.env.ANTHROPIC_PROXY_URL?.replace(/\/$/, "") ??
    process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, "");
  /** Прямой Anthropic Messages API без отдельного прокси (Vercel / локально). */
  const proxy =
    configured && configured.trim().length > 0 ? configured.trim() : "https://api.anthropic.com";
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  if (!key) {
    throw new Error(
      "Не задан ANTHROPIC_API_KEY — укажите ключ в переменных окружения или отключите anthropic в DEMO_FOUNDATION_PROVIDERS.",
    );
  }
  const url =
    proxy.endsWith("/v1/messages") || proxy.endsWith("/messages")
      ? proxy
      : `${proxy}/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0.1,
      system: EXTRACTION_SYSTEM_EN,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildExtractionUserPayload(text) }],
        },
      ],
    }),
    signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };
  const blocks = data.content ?? [];
  const textBlock = blocks.find((b) => b.type === "text");
  const content = textBlock?.text;
  if (!content) throw new Error("Anthropic empty content");
  return { content, provider: "anthropic" };
}
