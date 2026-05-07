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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function geocodeTomskStreet(streetHint: string): Promise<{
  lat: number;
  lon: number;
  displayName: string;
} | null> {
  const trimmed = streetHint.trim();
  const q = /томск/i.test(trimmed)
    ? trimmed
    : `${trimmed}, Томск, Россия`;

  async function lookup(query: string) {
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
    return data[0] ?? null;
  }

  let hit = await lookup(q);

  if (!hit && /томск/i.test(trimmed)) {
    hit = await lookup(`${trimmed}, Россия`);
  }

  if (!hit) {
    hit = await lookup(`${trimmed}, Tomsk, Russia`);
  }

  if (!hit) {
    hit = await lookup(`${trimmed}, Tomsk Oblast, Russia`);
  }

  if (!hit) return null;
  return {
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    displayName: hit.display_name,
  };
}
