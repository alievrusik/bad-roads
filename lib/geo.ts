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

async function lookupPhoton(query: string): Promise<{
  lat: number;
  lon: number;
  displayName: string;
} | null> {
  await sleep(200);

  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "8");

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
    },
    next: { revalidate: 0 },
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

  await sleep(1100);

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "LaplaceBadRoadsPrototype/1.0 (contact: demo@local)",
      Accept: "application/json",
    },
    next: { revalidate: 0 },
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
  const queries = [q];
  if (/томск/i.test(trimmed)) {
    queries.push(`${trimmed}, Россия`);
  }
  queries.push(`${trimmed}, Tomsk, Russia`);
  queries.push(`${trimmed}, Tomsk Oblast, Russia`);
  return [...new Set(queries)];
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
    const hit = await lookupPhoton(query);
    if (hit) return hit;
  }

  for (const query of queries) {
    const hit = await lookupNominatim(query);
    if (hit) return hit;
  }

  return null;
}
