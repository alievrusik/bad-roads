/** Tomsk centroid for fallback visuals */
export const DEFAULT_TOMSK_CENTER = {
  lat: 56.4884,
  lon: 84.9481,
};

type NominatimHit = {
  lat: string;
  lon: string;
  display_name: string;
};

type PhotonFeature = {
  geometry: { type: string; coordinates: [number, number] };
  properties: {
    name?: string;
    street?: string;
    locality?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
    countrycode?: string;
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Nominatim: не больше одного запроса в ~1 c на процесс (политика OSM). */
let nominatimGate: Promise<unknown> = Promise.resolve();

function scheduleNominatim<T>(fn: () => Promise<T>): Promise<T> {
  const run = nominatimGate.then(fn);
  nominatimGate = run.finally(() => sleep(1100));
  return run;
}

function inTomskMetro(lat: number, lon: number): boolean {
  return lat >= 56.25 && lat <= 56.62 && lon >= 84.65 && lon <= 85.35;
}

function formatPhotonDisplayName(
  props: PhotonFeature["properties"],
  fallback: string,
): string {
  const name = props.name ?? props.street;
  const city = props.city ?? props.locality;
  const region = props.state ?? props.county;
  const country = props.country;
  const parts = [name, city, region, country].filter(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );
  const uniq = [...new Set(parts)];
  return uniq.length ? uniq.join(", ") : fallback;
}

const PHOTON_TIMEOUT_MS = 8000;
const NOMINATIM_TIMEOUT_MS = 9000;

async function lookupPhoton(query: string): Promise<{
  lat: number;
  lon: number;
  displayName: string;
} | null> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "8");

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    next: { revalidate: 0 },
    signal: AbortSignal.timeout(PHOTON_TIMEOUT_MS),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as { features?: PhotonFeature[] };
  const features = data.features ?? [];
  const points = features.filter(
    (f) =>
      f.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates),
  );
  if (!points.length) return null;

  const inArea = points.filter((f) => {
    const [lon, lat] = f.geometry.coordinates;
    return inTomskMetro(lat, lon);
  });
  const pick = inArea[0] ?? points[0];
  const [lon, lat] = pick.geometry.coordinates;
  return {
    lat,
    lon,
    displayName: formatPhotonDisplayName(pick.properties, query),
  };
}

async function lookupNominatim(query: string): Promise<{
  lat: number;
  lon: number;
  displayName: string;
} | null> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", query);

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "LaplaceBadRoadsPrototype/1.0 (contact: demo@local)",
      Accept: "application/json",
    },
    next: { revalidate: 0 },
    signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as NominatimHit[];
  const hit = data[0];
  if (!hit) return null;
  return {
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    displayName: hit.display_name,
  };
}

function buildQueries(trimmed: string): string[] {
  const q = /томск/i.test(trimmed)
    ? trimmed
    : `${trimmed}, Томск, Россия`;
  const en = `${trimmed.replace(/,\s*Томск.*$/i, "").trim()}, Tomsk, Russia`;
  return [...new Set([q, en])];
}

export async function geocodeTomskStreet(streetHint: string): Promise<{
  lat: number;
  lon: number;
  displayName: string;
} | null> {
  const trimmed = streetHint.trim();
  if (!trimmed) return null;

  const queries = buildQueries(trimmed);

  for (const query of queries) {
    try {
      const hit = await lookupPhoton(query);
      if (hit) return hit;
    } catch {
      /* timeout / сеть — следующая формулировка или Nominatim */
    }
  }

  for (const query of queries) {
    try {
      const hit = await scheduleNominatim(() => lookupNominatim(query));
      if (hit) return hit;
    } catch {
      /* очередь / таймаут */
    }
  }

  return null;
}

const TOMSK_OVERPASS_BBOX = "(56.25,84.65,56.62,85.35)";
const OVERPASS_INTERPRETER = "https://overpass-api.de/api/interpreter";

const GEO_STOP_TOKENS = new Set([
  "ул",
  "улица",
  "просп",
  "проспект",
  "пер",
  "переулок",
  "наб",
  "набережная",
  "пл",
  "площадь",
  "томск",
  "россия",
]);

function coreAddressNorm(hint: string): string {
  return hint
    .replace(/,\s*Томск.*$/i, "")
    .replace(/,\s*Россия.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokensFromCore(core: string): string[] {
  return core
    .toLowerCase()
    .replace(/[«».,;:!?()"']/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !GEO_STOP_TOKENS.has(t));
}

/** Regex-фрагмент для Overpass name~ (кириллица без лишнего экранирования пробелов). */
function hintToOverpassStreetRegex(hint: string): string | null {
  const core = coreAddressNorm(hint);
  if (core.length < 2) return null;
  return core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
}

function overpassElementCenter(el: {
  center?: { lat: number; lon: number };
  lat?: number;
  lon?: number;
}): { lat: number; lon: number } | null {
  if (el.center && typeof el.center.lat === "number") {
    return { lat: el.center.lat, lon: el.center.lon };
  }
  if (typeof el.lat === "number" && typeof el.lon === "number") {
    return { lat: el.lat, lon: el.lon };
  }
  return null;
}

function matchHintToElements(
  hint: string,
  elements: Array<{
    tags?: Record<string, string>;
    center?: { lat: number; lon: number };
    lat?: number;
    lon?: number;
  }>,
): (typeof elements)[number] | null {
  const core = coreAddressNorm(hint);
  const tokens = significantTokensFromCore(core);
  if (!tokens.length) return null;
  let best: { el: (typeof elements)[number]; score: number } | null = null;
  for (const el of elements) {
    const name = (el.tags?.name ?? el.tags?.["name:ru"] ?? "").toLowerCase();
    if (!name) continue;
    const score = tokens.filter((t) => name.includes(t)).length;
    if (score > 0 && (!best || score > best.score)) {
      best = { el, score };
    }
  }
  return best?.el ?? null;
}

/**
 * Все подсказки за один POST к Overpass — вместо N запросов Photon/Nominatim.
 */
export async function batchGeocodeTomskOverpass(
  hints: string[],
): Promise<Map<string, { lat: number; lon: number; displayName: string }>> {
  const out = new Map<
    string,
    { lat: number; lon: number; displayName: string }
  >();

  const seenKey = new Set<string>();
  const uniqueHints: string[] = [];
  for (const h of hints) {
    const t = h.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    uniqueHints.push(t);
  }

  const limited = uniqueHints.slice(0, 40);
  const hintList: { hint: string; rx: string }[] = [];
  const seenRx = new Set<string>();
  const queryLines: string[] = [];

  for (const hint of limited) {
    const rx = hintToOverpassStreetRegex(hint);
    if (!rx) continue;
    hintList.push({ hint, rx });
    if (!seenRx.has(rx)) {
      seenRx.add(rx);
      queryLines.push(
        `  way["highway"]["name"~"${rx}",i]${TOMSK_OVERPASS_BBOX};`,
      );
    }
  }

  if (!queryLines.length) return out;

  const query = `[out:json][timeout:25];\n(\n${queryLines.join("\n")}\n);\nout center;`;

  let elements: Array<{
    type: string;
    center?: { lat: number; lon: number };
    lat?: number;
    lon?: number;
    tags?: Record<string, string>;
  }> = [];

  try {
    const res = await fetch(OVERPASS_INTERPRETER, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "LaplaceBadRoadsPrototype/1.0 (contact: demo@local)",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(28_000),
    });
    if (!res.ok) return out;
    const data = (await res.json()) as {
      elements?: typeof elements;
    };
    elements = data.elements ?? [];
  } catch {
    return out;
  }

  for (const { hint } of hintList) {
    const key = hint.toLowerCase();
    if (out.has(key)) continue;
    const el = matchHintToElements(hint, elements);
    if (!el) continue;
    const c = overpassElementCenter(el);
    if (!c || !inTomskMetro(c.lat, c.lon)) continue;
    const label = el.tags?.name ?? el.tags?.["name:ru"] ?? coreAddressNorm(hint);
    out.set(key, {
      lat: c.lat,
      lon: c.lon,
      displayName: `${label}, Томск`,
    });
  }

  return out;
}
