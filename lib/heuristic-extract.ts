import type { ExtractedLocation } from "@/lib/llm-extract";

/** Учитывает многосложные топонимы («Карла Маркса»). */
const STREET_RE =
  /(?:^|[\s,;])((?:ул\.?|улица|просп\.?|проспект|пер\.?|переулок|набережная|наб\.?|пл\.?|площадь))\s+([\w«»А-Яа-яЁё\-]+(?:\s+[\w«»А-Яа-яЁё\-]+)*)/gim;

function collapseSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTrailingComplaints(nameRaw: string) {
  let s = collapseSpaces(nameRaw);
  const junk = [
    "трещинах",
    "трещины",
    "ячейкой",
    "нету",
    "опять",
    "уже",
    "полностью",
    "ужасно",
    "нет",
    "вся",
    "в",
    "на",
    "яма",
  ];
  const prioritizedTokens = [...junk].sort((a, b) => b.length - a.length);
  for (let i = 0; i < 10; i += 1) {
    let changed = false;
    for (const token of prioritizedTokens) {
      const rx = new RegExp(`\\s+${escapeRegExp(token)}$`, "iu");
      const trimmed = s.replace(rx, "").trim();
      if (trimmed !== s) {
        s = trimmed;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return s;
}

function severityFromLine(line: string): number {
  const l = line.toLowerCase();
  if (
    /авария|яма на всю|провал|опасн|не проехать|скорая|колея|обрыв/i.test(l)
  )
    return 9;
  if (/яма|выбоин|разбит|ужас|кошмар|ремонт не делали|грязь/i.test(l))
    return 7;
  if (/неровн|трещин|кочк|плохой асфальт/i.test(l)) return 5;
  return 4;
}

function expandStreetType(fragment: string, name: string) {
  const t = fragment.toLowerCase().trim();
  if (t.includes("просп")) return `проспект ${name}`;
  if (t.startsWith("ул") || t.includes("улица")) return `улица ${name}`;
  if (t.includes("переул") || /^пер\.?$/.test(t)) return `переулок ${name}`;
  if (t.includes("набережн") || /^наб\.?$/.test(t)) return `набережная ${name}`;
  if (t.includes("площадь") || /^пл\.?$/.test(t)) return `площадь ${name}`;
  return `${fragment.trim()} ${name}`;
}

/** Deterministic fallback when remote LLM is unavailable (smoke / offline). */
export function heuristicExtractTomsk(text: string): {
  locations: ExtractedLocation[];
  warnings: string[];
} {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const found = new Map<string, ExtractedLocation>();

  for (const line of lines) {
    let m: RegExpExecArray | null;
    const re = new RegExp(STREET_RE);
    while ((m = re.exec(line)) !== null) {
      const typeFrag = (m[1] ?? "").trim();
      const name = stripTrailingComplaints((m[2] ?? "").replace(/\s+/g, " "));
      if (!name || name.length < 2) continue;

      const display = collapseSpaces(`${typeFrag} ${name}`);
      const normalized = `${expandStreetType(typeFrag, name)}, Томск, Россия`;
      const key = normalized.toLowerCase();
      const sev = severityFromLine(line);
      const prev = found.get(key);
      const merged = prev
        ? {
            ...prev,
            severity_1_to_10: Math.max(prev.severity_1_to_10, sev),
            summary_ru: `${prev.summary_ru}; ${line.slice(0, 120)}`,
            confidence_0_to_1: Math.min(prev.confidence_0_to_1, 0.4),
          }
        : {
            name_raw: display,
            normalized_address_hint: normalized,
            severity_1_to_10: sev,
            summary_ru: line.slice(0, 200),
            confidence_0_to_1: 0.45,
          };
      found.set(key, merged);
    }
  }

  return {
    locations: [...found.values()],
    warnings: [
      "Использован локальный эвристический анализ (шаблоны улиц). Для промышленного контура включите переменные языкового провайдера.",
    ],
  };
}
