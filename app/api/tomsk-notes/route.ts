import { NextResponse } from "next/server";
import {
  fetchTomskNotesXml,
  parseOsmNotesXml,
} from "@/lib/osm-notes";
import { parsedNotesToEmbeddedLines } from "@/lib/osm-embedded-lines";
import { takeTomskSyntheticLines } from "@/lib/tomsk-supplement-comments";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const TARGET_LINES = 100;

export async function GET() {
  let notesXml: string | null = null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 24_500);
    try {
      notesXml = await fetchTomskNotesXml(TARGET_LINES, ac.signal);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.message
        : "Не удалось получить заметки OpenStreetMap.";
    return NextResponse.json(
      {
        ok: false,
        error: msg,
        text: buildSyntheticOnlyFallback(),
        stats: { osmParsed: 0, syntheticAdded: TARGET_LINES },
      },
      { status: 502 },
    );
  }

  const notesRaw = parseOsmNotesXml(notesXml).slice(0, TARGET_LINES);
  const shuffleScore = (s: string) =>
    /дорог|яма|ремонт|асфальт|проезд|ям|колей|выбоин/i.test(s) ? 2 : 1;
  const notesSorted = [...notesRaw].sort((a, b) => {
    const sb = shuffleScore(b.text + b.id);
    const sa = shuffleScore(a.text + a.id);
    if (sb !== sa) return sb - sa;
    return Number(b.id) - Number(a.id);
  });
  const notes = notesSorted.slice(0, TARGET_LINES);

  const embeddedLines = parsedNotesToEmbeddedLines(notes);
  const clipped = embeddedLines.slice(0, TARGET_LINES);
  const need = Math.max(0, TARGET_LINES - clipped.length);
  const synthetic = takeTomskSyntheticLines(need);

  const header = [
    "# Заголовок набора данных (не участвует в анализе):",
    "# — реальные заметки: OpenStreetMap API 0.6 /notes (bbox Томска), https://www.openstreetmap.org/copyright",
    `# — строк из OSM: ${clipped.length}; синтетически добавлено: ${need} (${need ? "материалы веб-поиска о дорогах Томска" : "—"})`,
    "",
  ].join("\n");

  const textBody = [...clipped, ...synthetic].join("\n");
  const text = `${header}${textBody}`;

  return NextResponse.json({
    ok: true,
    text,
    stats: {
      osmParsed: notesRaw.length,
      osmReturned: clipped.length,
      syntheticAdded: synthetic.length,
    },
  });
}

function buildSyntheticOnlyFallback(): string {
  const header = [
    "# Заголовок набора данных (не участвует в анализе):",
    "# Основная загрузка OSM недоступна — показана только синтетическая матрица с явной маркировкой источника.",
    "# Веб-сводка тем: дороги и ямы в Томске (официально-новостные материалы 2024–2026 на tomsk.ru, riatomsk.ru).",
    "",
  ].join("\n");
  return `${header}${takeTomskSyntheticLines(TARGET_LINES).join("\n")}`;
}
