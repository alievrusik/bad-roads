import { z } from "zod";

const LlmLocationSchema = z
  .object({
    /** plain — жалоба из свободного текста; osm_note — одна запись на строку с координатами из батча. */
    kind: z.enum(["plain", "osm_note"]).default("plain"),
    /** Для kind=osm_note — id из заголовка строки (как в batch). */
    osm_note_id: z.string().optional(),
    name_raw: z.string(),
    normalized_address_hint: z.string(),
    severity_1_to_10: z.number().min(1).max(10),
    summary_ru: z.string(),
    confidence_0_to_1: z.number().min(0).max(1).optional(),
    lat: z.coerce.number().nullable().optional(),
    lon: z.coerce.number().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "osm_note") {
      if (!v.osm_note_id?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "osm_note requires osm_note_id",
          path: ["osm_note_id"],
        });
      }
      if (v.lat == null || v.lon == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "osm_note requires lat and lon from the line header",
          path: ["lat"],
        });
      }
    }
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
  const locs: ExtractedLocation[] = v.data.locations.map((l) => {
    const kind = l.kind ?? "plain";
    let lat = l.lat ?? null;
    let lon = l.lon ?? null;
    const bboxOk =
      lat != null &&
      lon != null &&
      lat >= 56.25 &&
      lat <= 56.62 &&
      lon >= 84.65 &&
      lon <= 85.35;
    if (kind === "plain" && !bboxOk) {
      lat = null;
      lon = null;
    }
    return {
      ...l,
      kind,
      lat,
      lon,
      confidence_0_to_1: l.confidence_0_to_1 ?? 0.65,
    };
  });
  return { locations: locs, warnings: v.data.warnings ?? [] };
}

const LLM_FETCH_TIMEOUT_MS = 45_000;

const EXTRACTION_SYSTEM_EN = `You extract road complaints for Tomsk (Russia) from ONE batch user message.
Each line is numbered. Lines marked [plain] are free-text comments. Lines marked [osm_note id=... lat=... lon=...] are OpenStreetMap notes with authoritative coordinates.

Return exactly ONE JSON object (no markdown) with this structure:
{"locations":[ ... ], "warnings":[]}

Each entry in "locations" must be either:
A) Free-text road issue from a [plain] line:
   {"kind":"plain","name_raw":"...","normalized_address_hint":"e.g. ул. Иркутская, Томск","severity_1_to_10":1-10,"summary_ru":"...","confidence_0_to_1":0-1,"lat":null,"lon":null}
   Optional lat/lon only if you are sure they fall in Tomsk bbox (lat ~56.25–56.62, lon ~84.65–85.35); otherwise null.

B) One object per [osm_note ...] line (road-related or not — still output it if the note text mentions roads/surface/potholes OR if unsure, include with lower severity):
   {"kind":"osm_note","osm_note_id":"<same id as in line>","name_raw":"short label","normalized_address_hint":"OpenStreetMap заметка №<id>","severity_1_to_10":1-10,"summary_ru":"from note text","confidence_0_to_1":0-1,"lat":<number>,"lon":<number>}
   lat and lon MUST copy EXACT numeric values from that line's header (after [osm_note id=… lat=… lon=…]).

Rules:
- Cover every [osm_note] line with exactly one osm_note object (matching osm_note_id).
- From [plain] lines, extract every distinct street/road complaint (kind plain); merge duplicates from the same line with higher severity.
- severity_1_to_10: 10 = emergency / impassable; 1 = cosmetic.
- Do not invent streets. warnings in English for ambiguity.`;

export async function callVllmExtract(batchUserDocument: string): Promise<{
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
      max_tokens: 8192,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_EN },
        { role: "user", content: batchUserDocument },
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

export async function callAnthropicExtract(batchUserDocument: string): Promise<{
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
      max_tokens: 8192,
      temperature: 0.1,
      system: EXTRACTION_SYSTEM_EN,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: batchUserDocument }],
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
