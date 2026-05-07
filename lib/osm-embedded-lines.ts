import type { ParsedOsmNote } from "@/lib/osm-notes";

/** Машиночитаемый префикс для строк, пришедших из OSM Notes (серверный анализ). */
const OSM_EMBEDDED =
  /^\[\[osm-note id=(\d+) lat=([\d.]+) lon=([\d.]+)\]\]\s*(.*)$/;

export type EmbeddedOsmLine = {
  id: string;
  lat: number;
  lon: number;
  text: string;
};

/** Убираем строки комментариев (# …) перед извлечением сущностей. */
export function stripHashCommentLines(raw: string): string {
  return raw
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .join("\n");
}

/**
 * Один батч для LLM: каждая строка пронумерована, у OSM явно id и координаты.
 */
export function buildLlmBatchDocumentWithCoords(strippedText: string): string {
  const lines = strippedText
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const numbered = lines.map((line, i) => {
    const m = OSM_EMBEDDED.exec(line);
    if (m) {
      const id = m[1];
      const lat = m[2];
      const lon = m[3];
      const noteText = (m[4] ?? "").trim();
      return `Line ${i + 1} [osm_note id=${id} lat=${lat} lon=${lon}]: ${noteText}`;
    }
    return `Line ${i + 1} [plain]: ${line}`;
  });
  return [
    `Below are ${lines.length} lines in ONE batch. Every line must be accounted for in your JSON: include one "osm_note" object per line that shows [osm_note ...] (copy osm_note_id, lat, lon exactly from that header) and extract "plain" road complaints from [plain] lines.`,
    "",
    ...numbered,
  ].join("\n");
}

export function partitionOsmEmbeddedAndPlain(
  strippedText: string,
): { embedded: EmbeddedOsmLine[]; plainLines: string[] } {
  const lines = strippedText
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const embedded: EmbeddedOsmLine[] = [];
  const plainLines: string[] = [];
  for (const line of lines) {
    const m = OSM_EMBEDDED.exec(line);
    if (!m) {
      plainLines.push(line);
      continue;
    }
    const id = m[1];
    const lat = Number(m[2]);
    const lon = Number(m[3]);
    const text = (m[4] ?? "").trim();
    if (
      id &&
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      text.length > 0
    ) {
      embedded.push({ id, lat, lon, text });
    }
  }
  return { embedded, plainLines };
}

export function parsedNotesToEmbeddedLines(notes: ParsedOsmNote[]): string[] {
  return notes.map((n) =>
    [
      `[[osm-note id=${n.id} lat=${n.lat} lon=${n.lon}]]`,
      n.text.replace(/\s+/g, " ").trim(),
    ].join(" "),
  );
}
