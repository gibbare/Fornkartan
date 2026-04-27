/**
 * Fornkartan API — Cloudflare Worker
 * ====================================
 * GET /api/heritage?south=&west=&north=&east=
 *
 * Datakällor:
 *   1. K-samsök / KMR  (kulturarvsdata.se) — officiella RAÄ-fornlämningar
 *   2. Overpass (OSM)                       — historiska byggnader, monument m.m.
 *
 * K-samsök returnerar XML; parsas server-side.
 * Svar cachas i R2 med 24h TTL per ~5km-rutnätscell.
 */

const OVERPASS_URL  = 'https://overpass-api.de/api/interpreter';
const KSAMSOK_URL   = 'https://kulturarvsdata.se/ksamsok/api';
const CACHE_TTL_MS  = 24 * 60 * 60 * 1000;
const GRID_STEP     = 0.05;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Hjälpare ─────────────────────────────────────────────────────────────────

function jsonResp(data, status = 200, extra = {}) {
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

// ── XML-parsning för K-samsök ─────────────────────────────────────────────────

// Hämtar textinnehållet i första matchande tagg (namespace-okänslig)
function xmlText(xml, localName) {
  const re = new RegExp(
    `<(?:[\\w]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w]+:)?${localName}>`, 'i',
  );
  const m = xml.match(re);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

// Hämtar attributvärde från tagg
function xmlAttr(xml, localName, attr) {
  const re = new RegExp(`<(?:[\\w]+:)?${localName}[^>]+${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function parseRecord(record) {
  // URI: rdf:about="http://kulturarvsdata.se/raa/lamning/{uuid}"
  const uri = xmlAttr(record, 'Entity', 'rdf:about') || xmlAttr(record, 'Entity', 'about');
  if (!uri) return null;
  const uuid = uri.split('/').pop();
  if (!uuid) return null;

  // Koordinater: <gml:coordinates>lon,lat</gml:coordinates>
  const coordStr = xmlText(record, 'coordinates');
  if (!coordStr) return null;
  const parts = coordStr.split(',');
  const lng = parseFloat(parts[0]);
  const lat = parseFloat(parts[1]);
  if (isNaN(lat) || isNaN(lng)) return null;

  // Typ/rubrik och RAÄ-registernummer
  const label     = xmlText(record, 'itemLabel')     || 'Fornlämning';
  const raaNumber = xmlText(record, 'number');        // t.ex. "L2013:7448"

  // Första beskrivningsfältet
  const desc = xmlText(record, 'desc');

  return {
    id:  `raa-${uuid}`,
    lat,
    lng,
    tags: {
      historic:    'archaeological_site',
      name:        label,
      raaNumber,
      description: desc,
      raaUrl:      `https://app.raa.se/open/fornsok/lamning/${uuid}`,
    },
    source: 'raa',
  };
}

// ── Datahämtning ──────────────────────────────────────────────────────────────

async function fetchKsamsok(s, w, n, e) {
  // K-samsök: bbox-koordinater anges som "lon1 lat1 lon2 lat2" (WGS84)
  const query = `fornlämning AND boundingBox=/WGS84 "${w} ${s} ${e} ${n}"`;
  const params = new URLSearchParams({
    method:      'search',
    hitsPerPage: '500',
    startRecord: '1',
    query,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  let res;
  try {
    res = await fetch(`${KSAMSOK_URL}?${params}`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`K-samsök HTTP ${res.status}`);
  const xml = await res.text();

  const items = [];
  const re = /<record>([\s\S]*?)<\/record>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const item = parseRecord(m[1]);
    if (item) items.push(item);
  }
  return items;
}

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
    items.push({ id: `osm-${el.type}-${el.id}`, lat, lng, tags, source: 'osm', osmId: el.id, osmType: el.type });
  }
  return items;
}

// ── Merge & deduplicering ─────────────────────────────────────────────────────
// RAÄ-poster prioriteras; OSM-poster med archaeological_site nära ett RAÄ-objekt
// (~60 m) ignoreras för att undvika dubbletter.

function merge(raaItems, osmItems) {
  const result = [...raaItems];
  const raaCoords = raaItems.map(i => [i.lat, i.lng]);

  for (const osm of osmItems) {
    const isArchOsm = (osm.tags?.historic || '').includes('archaeological')
      || (osm.tags?.historic || '') === 'rune_stone'
      || (osm.tags?.historic || '') === 'standing_stone';

    const tooClose = isArchOsm && raaCoords.some(
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
      return jsonResp({ error: 'Not found' }, 404);
    }

    const s = parseFloat(url.searchParams.get('south'));
    const w = parseFloat(url.searchParams.get('west'));
    const n = parseFloat(url.searchParams.get('north'));
    const e = parseFloat(url.searchParams.get('east'));

    if ([s, w, n, e].some(isNaN)) {
      return jsonResp({ error: 'Saknade parametrar: south, west, north, east' }, 400);
    }

    const key = r2Key(s, w, n, e);

    // ── R2-cache ──────────────────────────────────────────────────────────────
    const cached = await env.BUCKET.get(key);
    if (cached) {
      const age   = Date.now() - new Date(cached.customMetadata?.cachedAt || 0).getTime();
      if (age < CACHE_TTL_MS) {
        return new Response(await cached.text(), {
          headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT',
            'X-Cache-Age': String(Math.round(age / 1000)), 'Cache-Control': 'public, max-age=3600', ...CORS },
        });
      }
    }

    // ── Hämta från K-samsök + Overpass parallellt ─────────────────────────────
    const [raaResult, osmResult] = await Promise.allSettled([
      fetchKsamsok(s, w, n, e),
      fetchOverpass(s, w, n, e),
    ]);

    const raaItems  = raaResult.status === 'fulfilled' ? raaResult.value : [];
    const osmItems  = osmResult.status === 'fulfilled' ? osmResult.value : [];
    const items     = merge(raaItems, osmItems);
    const raaFailed = raaResult.status === 'rejected';

    const payload = {
      items,
      count:   items.length,
      cachedAt: new Date().toISOString(),
      bbox:    [s, w, n, e],
      sources: {
        raa:      raaItems.length,
        osm:      osmItems.length,
        raaError: raaFailed ? raaResult.reason?.message : null,
        osmError: osmResult.status === 'rejected' ? osmResult.reason?.message : null,
      },
    };

    const body = JSON.stringify(payload);

    // Cachelagra bara om K-samsök lyckades — annars saknas fornlämningar
    if (!raaFailed) {
      await env.BUCKET.put(key, body, {
        httpMetadata:   { contentType: 'application/json' },
        customMetadata: { cachedAt: payload.cachedAt },
      });
    }

    return new Response(body, {
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS',
        'Cache-Control': 'public, max-age=3600', ...CORS },
    });
  },
};
