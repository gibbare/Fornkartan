/**
 * Fornkartan API — Cloudflare Worker
 * ====================================
 * GET /api/heritage?south=&west=&north=&east=
 *
 * Datakällor:
 *   1. K-samsök / KMR  (kulturarvsdata.se) — officiella RAÄ-fornlämningar
 *   2. Bebyggelseregistret / BeBR (via K-samsök) — kulturhistoriska byggnader
 *   3. Overpass (OSM)                       — historiska byggnader, monument m.m.
 *
 * K-samsök returnerar XML; parsas server-side.
 * Svar cachas i R2 med 24h TTL per ~5km-rutnätscell.
 */

const OVERPASS_URL  = 'https://overpass-api.de/api/interpreter';
const KSAMSOK_URL   = 'https://kulturarvsdata.se/ksamsok/api';
const CACHE_TTL_MS  = 24 * 60 * 60 * 1000;
const GRID_STEP     = 0.05;
const KSAMSOK_TIMEOUT_MS = 8000;

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

// ── XML-parsning ──────────────────────────────────────────────────────────────

function xmlText(xml, localName) {
  const re = new RegExp(
    `<(?:[\\w]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w]+:)?${localName}>`, 'i',
  );
  const m = xml.match(re);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

function xmlAttr(xml, localName, attr) {
  const re = new RegExp(`<(?:[\\w]+:)?${localName}[^>]+${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

// ── K-samsök med timeout ──────────────────────────────────────────────────────

async function ksamsokFetch(query, hitsPerPage = '500') {
  const params = new URLSearchParams({
    method: 'search',
    hitsPerPage,
    startRecord: '1',
    query,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KSAMSOK_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${KSAMSOK_URL}?${params}`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`K-samsök HTTP ${res.status}`);
  return res.text();
}

// ── Fornlämningar (K-samsök / KMR) ───────────────────────────────────────────

function parseLamning(record) {
  const uri = xmlAttr(record, 'Entity', 'rdf:about') || xmlAttr(record, 'Entity', 'about');
  if (!uri) return null;
  const uuid = uri.split('/').pop();
  if (!uuid) return null;

  const coordStr = xmlText(record, 'coordinates');
  if (!coordStr) return null;
  const [lngStr, latStr] = coordStr.split(',');
  const lng = parseFloat(lngStr);
  const lat = parseFloat(latStr);
  if (isNaN(lat) || isNaN(lng)) return null;

  const label     = xmlText(record, 'itemLabel') || 'Fornlämning';
  const raaNumber = xmlText(record, 'number');
  const desc      = xmlText(record, 'desc');

  return {
    id:  `raa-${uuid}`,
    lat, lng,
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

async function fetchKsamsok(s, w, n, e) {
  const xml = await ksamsokFetch(`fornlämning AND boundingBox=/WGS84 "${w} ${s} ${e} ${n}"`);
  const items = [];
  const re = /<record>([\s\S]*?)<\/record>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const item = parseLamning(m[1]);
    if (item) items.push(item);
  }
  return items;
}

// ── Bebyggelseregistret (BeBR via K-samsök) ───────────────────────────────────

function parseBebr(record) {
  const uri = xmlAttr(record, 'Entity', 'rdf:about') || xmlAttr(record, 'Entity', 'about');
  if (!uri) return null;
  const uuid = uri.split('/').pop();
  if (!uuid) return null;

  const coordStr = xmlText(record, 'coordinates');
  if (!coordStr) return null;
  const [lngStr, latStr] = coordStr.split(',');
  const lng = parseFloat(lngStr);
  const lat = parseFloat(latStr);
  if (isNaN(lat) || isNaN(lng)) return null;

  const itemLabel     = xmlText(record, 'itemLabel');     // t.ex. "Kulturhistoriskt värdefull"
  const itemClassName = xmlText(record, 'itemClassName'); // t.ex. "Bostadshus, flerbostadshus"
  const municipality  = xmlText(record, 'municipalityName');
  const bbrUrl        = xmlText(record, 'url');           // länk till BeBR-post

  // Namn: använd designation (t.ex. "STOCKHOLM JÄGAREN 9") om tillgängligt
  const designation = xmlText(record, 'itemDesignation') || xmlText(record, 'itemName');
  const name = designation || itemClassName || 'Byggnad';

  return {
    id:  `bbr-${uuid}`,
    lat, lng,
    tags: {
      historic:    'building',
      name,
      description: [itemLabel, itemClassName].filter(Boolean).join(' — '),
      municipality,
      raaUrl:      bbrUrl || `https://bebyggelseregistret.raa.se/bbr2/byggnad/visaHistorik.raa?byggnadId=${uuid}`,
    },
    source: 'bbr',
  };
}

async function fetchBebr(s, w, n, e) {
  const xml = await ksamsokFetch(`bebyggelseregistret AND boundingBox=/WGS84 "${w} ${s} ${e} ${n}"`);
  const items = [];
  const re = /<record>([\s\S]*?)<\/record>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const item = parseBebr(m[1]);
    if (item) items.push(item);
  }
  return items;
}

// ── Overpass (OSM) ────────────────────────────────────────────────────────────

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
// RAÄ/BeBR-poster prioriteras; nära OSM-dubbletter filtreras bort.

function merge(raaItems, bebrItems, osmItems) {
  const result = [...raaItems, ...bebrItems];
  const officialCoords = result.map(i => [i.lat, i.lng]);

  for (const osm of osmItems) {
    const isArchOsm = (osm.tags?.historic || '').includes('archaeological')
      || osm.tags?.historic === 'rune_stone'
      || osm.tags?.historic === 'standing_stone'
      || osm.tags?.historic === 'building'
      || osm.tags?.historic === 'castle'
      || osm.tags?.historic === 'church'
      || osm.tags?.historic === 'manor';

    const tooClose = isArchOsm && officialCoords.some(
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
      const age = Date.now() - new Date(cached.customMetadata?.cachedAt || 0).getTime();
      if (age < CACHE_TTL_MS) {
        return new Response(await cached.text(), {
          headers: {
            'Content-Type': 'application/json', 'X-Cache': 'HIT',
            'X-Cache-Age': String(Math.round(age / 1000)),
            'Cache-Control': 'public, max-age=3600', ...CORS,
          },
        });
      }
    }

    // ── Hämta från alla tre källor parallellt ─────────────────────────────────
    const [raaResult, bebrResult, osmResult] = await Promise.allSettled([
      fetchKsamsok(s, w, n, e),
      fetchBebr(s, w, n, e),
      fetchOverpass(s, w, n, e),
    ]);

    const raaItems  = raaResult.status  === 'fulfilled' ? raaResult.value  : [];
    const bebrItems = bebrResult.status === 'fulfilled' ? bebrResult.value : [];
    const osmItems  = osmResult.status  === 'fulfilled' ? osmResult.value  : [];
    const items     = merge(raaItems, bebrItems, osmItems);

    const raaFailed  = raaResult.status  === 'rejected';
    const bebrFailed = bebrResult.status === 'rejected';

    const payload = {
      items,
      count:    items.length,
      cachedAt: new Date().toISOString(),
      bbox:     [s, w, n, e],
      sources: {
        raa:       raaItems.length,
        bbr:       bebrItems.length,
        osm:       osmItems.length,
        raaError:  raaFailed  ? raaResult.reason?.message  : null,
        bebrError: bebrFailed ? bebrResult.reason?.message : null,
        osmError:  osmResult.status === 'rejected' ? osmResult.reason?.message : null,
      },
    };

    const body = JSON.stringify(payload);

    // Cachelagra bara om båda RAÄ-källorna lyckades
    if (!raaFailed && !bebrFailed) {
      await env.BUCKET.put(key, body, {
        httpMetadata:   { contentType: 'application/json' },
        customMetadata: { cachedAt: payload.cachedAt },
      });
    }

    return new Response(body, {
      headers: {
        'Content-Type': 'application/json', 'X-Cache': 'MISS',
        'Cache-Control': 'public, max-age=3600', ...CORS,
      },
    });
  },
};
