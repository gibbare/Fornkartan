/**
 * Fornkartan API — Cloudflare Worker
 * ====================================
 * GET /api/heritage?south=&west=&north=&east=
 *
 * Hämtar historiska platser från:
 *   1. OpenStreetMap Overpass API  (byggnader, monument, m.m.)
 *   2. RAÄ Fornsök API             (arkeologiska fornlämningar)
 *
 * Svar cachas i R2 med 24h TTL per rutnätscell (~5km).
 * Server-side fetch kringgår CORS-begränsningar från Fornsök.
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const FORNSOK_URL  = 'https://app.raa.se/open/fornsok/api/v2';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // 24 timmar
const GRID_STEP    = 0.05;                   // ~5.5 km latitud vid 60°N

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Hjälpare ─────────────────────────────────────────────────────────────────

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

function snapDown(v) { return Math.floor(v / GRID_STEP) * GRID_STEP; }
function snapUp(v)   { return Math.ceil(v  / GRID_STEP) * GRID_STEP; }

function r2Key(s, w, n, e) {
  return `heritage/${snapDown(s).toFixed(2)},${snapDown(w).toFixed(2)},${snapUp(n).toFixed(2)},${snapUp(e).toFixed(2)}.json`;
}

// ── Datahämtning ──────────────────────────────────────────────────────────────

async function fetchOverpass(s, w, n, e) {
  const query = `[out:json][timeout:30][bbox:${s},${w},${n},${e}];
(
  node["historic"];
  way["historic"];
  node["heritage"];
  way["heritage"];
);
out center tags;`;

  const res = await fetch(OVERPASS_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `data=${encodeURIComponent(query)}`,
    cf:      { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);

  const { elements = [] } = await res.json();
  const items = [];

  for (const el of elements) {
    const tags = el.tags || {};
    const lat  = el.type === 'node' ? el.lat : el.center?.lat;
    const lng  = el.type === 'node' ? el.lon : el.center?.lon;
    if (!lat || !lng) continue;

    items.push({
      id:      `osm-${el.type}-${el.id}`,
      lat,
      lng,
      tags,
      source:  'osm',
      osmId:   el.id,
      osmType: el.type,
    });
  }
  return items;
}

async function fetchFornsok(s, w, n, e) {
  const url = `${FORNSOK_URL}/features?bbox=${w},${s},${e},${n}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Fornsök HTTP ${res.status}`);

  const body = await res.json();
  const features = body.features || body.hits || [];
  const items = [];

  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (!coords) continue;

    const props = f.properties || {};
    const lat   = coords[1];
    const lng   = coords[0];
    const raaId = String(props.raaId || props.id || '');

    items.push({
      id:  `raa-${raaId || `${lat.toFixed(6)},${lng.toFixed(6)}`}`,
      lat,
      lng,
      tags: {
        historic:    'archaeological_site',
        name:        props.name || props.lamningstypKod || 'Fornlämning',
        description: props.beskrivning || props.antikvariskBedomning || '',
        raaId,
        raaUrl:      raaId ? `https://app.raa.se/open/fornsok/#/details/${raaId}` : '',
      },
      source: 'raa',
    });
  }
  return items;
}

// ── Merge & deduplicering ─────────────────────────────────────────────────────
// Fornsök-poster prioriteras (officiell källa); OSM-poster läggs till
// om det inte redan finns ett RAÄ-objekt inom ~60 m.

function merge(raaItems, osmItems) {
  const result = [...raaItems];
  const raaCoords = raaItems.map(i => [i.lat, i.lng]);

  for (const osm of osmItems) {
    const tooClose = raaCoords.some(
      ([rlat, rlng]) =>
        Math.abs(osm.lat - rlat) < 0.0006 && Math.abs(osm.lng - rlng) < 0.0008,
    );
    if (!tooClose) result.push(osm);
  }
  return result;
}

// ── Huvud-handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname !== '/api/heritage') {
      return json({ error: 'Not found' }, 404);
    }

    const s = parseFloat(url.searchParams.get('south'));
    const w = parseFloat(url.searchParams.get('west'));
    const n = parseFloat(url.searchParams.get('north'));
    const e = parseFloat(url.searchParams.get('east'));

    if ([s, w, n, e].some(isNaN)) {
      return json({ error: 'Saknade parametrar: south, west, north, east' }, 400);
    }

    const key = r2Key(s, w, n, e);

    // ── Kolla R2-cache ────────────────────────────────────────────────────────
    const cached = await env.BUCKET.get(key);
    if (cached) {
      const meta    = cached.customMetadata || {};
      const age     = Date.now() - new Date(meta.cachedAt || 0).getTime();
      const stale   = age > CACHE_TTL_MS;

      if (!stale) {
        const body = await cached.text();
        return new Response(body, {
          headers: {
            'Content-Type':  'application/json',
            'X-Cache':       'HIT',
            'X-Cache-Age':   String(Math.round(age / 1000)),
            'Cache-Control': 'public, max-age=3600',
            ...CORS,
          },
        });
      }
      // Stale — faller igenom till ny hämtning
    }

    // ── Cache miss / stale — hämta från båda källorna parallellt ─────────────
    const [osmResult, raaResult] = await Promise.allSettled([
      fetchOverpass(s, w, n, e),
      fetchFornsok(s, w, n, e),
    ]);

    const osmItems = osmResult.status === 'fulfilled' ? osmResult.value : [];
    const raaItems = raaResult.status === 'fulfilled' ? raaResult.value : [];

    const items = merge(raaItems, osmItems);

    const payload = {
      items,
      count:    items.length,
      cachedAt: new Date().toISOString(),
      bbox:     [s, w, n, e],
      sources:  {
        osm: osmItems.length,
        raa: raaItems.length,
        osmError: osmResult.status === 'rejected' ? osmResult.reason?.message : null,
        raaError: raaResult.status === 'rejected' ? raaResult.reason?.message : null,
      },
    };

    const body = JSON.stringify(payload);

    // ── Spara i R2 ────────────────────────────────────────────────────────────
    await env.BUCKET.put(key, body, {
      httpMetadata:   { contentType: 'application/json' },
      customMetadata: { cachedAt: payload.cachedAt },
    });

    return new Response(body, {
      headers: {
        'Content-Type':  'application/json',
        'X-Cache':       'MISS',
        'Cache-Control': 'public, max-age=3600',
        ...CORS,
      },
    });
  },
};
