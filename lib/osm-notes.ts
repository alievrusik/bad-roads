/**
 * OSM Notes API (0.6) — см. https://wiki.openstreetmap.org/wiki/API_v0.6#Map_Notes_API
 */

export type ParsedOsmNote = {
  id: string;
  lat: number;
  lon: number;
  /** Первое осмысленное текстовое описание заметки (действие opened или первый абзац) */
  text: string;
  status?: string;
};

/** Границы территории города для выборки заметок (~Томск) */
export const TOMSK_NOTES_BBOX = {
  west: 84.82,
  south: 56.38,
  east: 85.08,
  north: 56.58,
} as const;

const NOTE_BLOCK =
  /<note\s+lon="([^"]+)"\s+lat="([^"]+)"[^>]*>([\s\S]*?)<\/note>/g;

function decodeXmlEntities(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractFirstOpenedText(noteInner: string): string {
  const comments = [...noteInner.matchAll(/<comment>([\s\S]*?)<\/comment>/g)];
  for (const c of comments) {
    const inner = c[1] ?? "";
    if (!/<action>opened<\/action>/i.test(inner)) continue;
    const textMatch = /<text>([\s\S]*?)<\/text>/i.exec(inner);
    const raw = textMatch?.[1]?.trim();
    if (raw && raw.replace(/\s+/g, " ").length > 0) {
      return decodeXmlEntities(raw).replace(/\s+/g, " ").trim();
    }
  }
  const anyText = /<text>([\s\S]*?)<\/text>/i.exec(noteInner)?.[1]?.trim();
  return decodeXmlEntities(anyText ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseOsmNotesXml(xml: string): ParsedOsmNote[] {
  const out: ParsedOsmNote[] = [];
  NOTE_BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NOTE_BLOCK.exec(xml)) !== null) {
    const lon = Number(m[1]);
    const lat = Number(m[2]);
    const inner = m[3] ?? "";
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const id = /<id>(\d+)<\/id>/.exec(inner)?.[1];
    if (!id) continue;
    const status = /<status>([^<]+)<\/status>/i.exec(inner)?.[1]?.trim();
    const text = extractFirstOpenedText(inner);
    if (!text) continue;
    out.push({ id, lat, lon, text, status });
  }
  return out;
}

const OSM_NOTES_ENDPOINT = "https://api.openstreetmap.org/api/0.6/notes";

export async function fetchTomskNotesXml(
  limit = 100,
  signal?: AbortSignal,
): Promise<string> {
  const { west, south, east, north } = TOMSK_NOTES_BBOX;
  const url = `${OSM_NOTES_ENDPOINT}?bbox=${west},${south},${east},${north}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { Accept: "application/xml" },
    signal,
    next: { revalidate: 0 },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OSM Notes ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.text();
}
