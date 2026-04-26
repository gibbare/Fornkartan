'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const OVERPASS_URL   = 'https://overpass-api.de/api/interpreter';
const FORNSOK_URL    = 'https://app.raa.se/open/fornsok/api/v2';
const DEFAULT_CENTER = [59.3293, 18.0686]; // Stockholm fallback
const DEFAULT_ZOOM   = 13;
const LOAD_ZOOM_MIN  = 12; // Don't auto-load below this zoom (too many results)

// ── Type definitions ──────────────────────────────────────────────────────────
const TYPES = {
  archaeological: {
    label:     'Fornlämning',
    plural:    'Fornlämningar',
    color:     '#c0392b',
    textColor: '#fff',
    osmValues: new Set([
      'archaeological_site','megalith','stone_circle','dolmen','cairn',
      'standing_stone','rune_stone','barrow','tumulus','grave_yard',
    ]),
  },
  building: {
    label:     'Historisk byggnad',
    plural:    'Historiska byggnader',
    color:     '#2471a3',
    textColor: '#fff',
    osmValues: new Set([
      'castle','church','manor','fortification','tower','windmill',
      'monastery','palace','city_gate','lighthouse','watermill','farm',
    ]),
  },
  environment: {
    label:     'Kulturmiljö',
    plural:    'Kulturmiljöer',
    color:     '#1e8449',
    textColor: '#fff',
    osmValues: new Set([
      'battlefield','heritage_transport','industrial','district',
      'bridge','road','mining','mill','navigation',
    ]),
  },
  other: {
    label:     'Övrigt historiskt',
    plural:    'Övrigt historiskt',
    color:     '#d35400',
    textColor: '#fff',
    osmValues: new Set([
      'memorial','monument','boundary_stone','wayside_cross',
      'wayside_shrine','milestone','ruins','cannon','aircraft','vehicle','ship',
    ]),
  },
};

// Swedish translations for OSM historic tag values
const HISTORIC_LABELS = {
  archaeological_site: 'Fornlämning',
  megalith:            'Megalit',
  stone_circle:        'Stencirkel',
  dolmen:              'Dös / gånggrift',
  cairn:               'Röse',
  standing_stone:      'Resta sten',
  rune_stone:          'Runsten',
  barrow:              'Gravhög',
  tumulus:             'Kummel',
  castle:              'Slott / borg',
  church:              'Kyrka',
  manor:               'Herrgård',
  fortification:       'Fästning',
  tower:               'Torn',
  windmill:            'Väderkvarn',
  monastery:           'Kloster',
  palace:              'Palats',
  city_gate:           'Stadsport',
  lighthouse:          'Fyr',
  watermill:           'Vattenkvarn',
  farm:                'Historisk gård',
  battlefield:         'Slagfält',
  memorial:            'Minnesmärke',
  monument:            'Monument',
  boundary_stone:      'Gränssten',
  wayside_cross:       'Vägkors',
  milestone:           'Milsten',
  ruins:               'Ruin',
  district:            'Historiskt distrikt',
  bridge:              'Historisk bro',
  industrial:          'Industrihistoria',
};

const HERITAGE_LABELS = {
  1: 'UNESCO Världsarv',
  2: 'Byggnadsminne',
  3: 'Kulturmärkt byggnad',
};

// ── State ─────────────────────────────────────────────────────────────────────
let map;
let markersLayer;
let allItems = [];          // { id, lat, lng, type, tags, marker }
let activeFilters = new Set(['archaeological','building','environment','other']);
let loadedBbox  = null;
let isLoading   = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dom = {
  sidebar:      () => document.getElementById('sidebar'),
  sidebarToggle:() => document.getElementById('sidebar-toggle'),
  locateBtn:    () => document.getElementById('locate-btn'),
  reloadBtn:    () => document.getElementById('reload-btn'),
  loadingRow:   () => document.getElementById('loading-row'),
  loadingText:  () => document.getElementById('loading-text'),
  statusMsg:    () => document.getElementById('status-msg'),
  infoCard:     () => document.getElementById('info-card'),
  infoBadge:    () => document.getElementById('info-badge'),
  infoName:     () => document.getElementById('info-name'),
  infoDetails:  () => document.getElementById('info-details'),
  infoLinks:    () => document.getElementById('info-links'),
  closeCard:    () => document.getElementById('close-card'),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function classifyItem(tags) {
  const h = (tags.historic || '').toLowerCase();
  for (const [type, cfg] of Object.entries(TYPES)) {
    if (cfg.osmValues.has(h)) return type;
  }
  if (tags.heritage) return 'building';
  if (h) return 'other';
  return null;
}

function getItemName(tags) {
  return tags['name:sv'] || tags.name || tags['name:en'] || null;
}

function createMarkerIcon(type, small = false) {
  const { color } = TYPES[type];
  const w = small ? 20 : 26;
  const h = small ? 28 : 34;
  const r = small ? 4  : 5;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 26 34">
    <path d="M13 1C6.925 1 2 5.925 2 12c0 9.5 11 21 11 21s11-11.5 11-21C24 5.925 19.075 1 13 1z"
          fill="${color}" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/>
    <circle cx="13" cy="12" r="${r}" fill="rgba(255,255,255,0.9)"/>
  </svg>`;
  return L.divIcon({
    html:        `<div class="map-marker">${svg}</div>`,
    className:   '',
    iconSize:    [w, h],
    iconAnchor:  [w / 2, h],
    popupAnchor: [0, -h],
  });
}

function setStatus(msg) { dom.statusMsg().textContent = msg; }

function setLoading(active, text = 'Hämtar data…') {
  isLoading = active;
  dom.loadingRow().classList.toggle('hidden', !active);
  dom.loadingText().textContent = text;
  dom.reloadBtn().disabled = active;
}

function updateCounts() {
  const counts = { archaeological: 0, building: 0, environment: 0, other: 0 };
  for (const item of allItems) counts[item.type]++;
  for (const [type, n] of Object.entries(counts)) {
    const el = document.getElementById(`count-${type}`);
    if (el) el.textContent = n > 0 ? String(n) : '–';
  }
}

function bboxFromBounds(bounds) {
  return {
    south: bounds.getSouth(),
    west:  bounds.getWest(),
    north: bounds.getNorth(),
    east:  bounds.getEast(),
  };
}

function bboxTooLarge(bbox) {
  return (bbox.north - bbox.south) > 0.5 || (bbox.east - bbox.west) > 0.8;
}

// ── Map setup ─────────────────────────────────────────────────────────────────
function initMap(center) {
  map = L.map('map', {
    center,
    zoom:       DEFAULT_ZOOM,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);

  // Load data when map stops moving (debounced)
  let moveTimer;
  map.on('moveend', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (map.getZoom() >= LOAD_ZOOM_MIN) loadData();
    }, 600);
  });

  // Initial load
  if (map.getZoom() >= LOAD_ZOOM_MIN) loadData();
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadData() {
  if (isLoading) return;
  const bounds = map.getBounds();
  const bbox   = bboxFromBounds(bounds);

  if (bboxTooLarge(bbox)) {
    setStatus('Zooma in för att ladda data (zoom ≥ 12).');
    return;
  }

  setLoading(true, 'Hämtar historiska platser…');
  setStatus('');

  try {
    const [osmItems, raaItems] = await Promise.allSettled([
      fetchOverpass(bbox),
      fetchFornsok(bbox),
    ]);

    const merged = new Map();

    if (osmItems.status === 'fulfilled') {
      for (const item of osmItems.value) merged.set(item.id, item);
    } else {
      console.warn('Overpass error:', osmItems.reason);
    }

    if (raaItems.status === 'fulfilled') {
      for (const item of raaItems.value) {
        if (!merged.has(item.id)) merged.set(item.id, item);
      }
    } else {
      console.warn('Fornsök error (non-critical):', raaItems.reason);
    }

    allItems = Array.from(merged.values());
    renderMarkers();
    updateCounts();
    loadedBbox = bbox;

    const total = allItems.length;
    setStatus(total > 0 ? `${total} platser hittade i vyn.` : 'Inga historiska platser hittades i vyn.');
  } catch (err) {
    console.error(err);
    setStatus('Fel vid datahämtning. Försök igen.');
  } finally {
    setLoading(false);
  }
}

// Overpass API — OpenStreetMap data
async function fetchOverpass(bbox) {
  const { south, west, north, east } = bbox;
  const query = `
[out:json][timeout:30][bbox:${south},${west},${north},${east}];
(
  node["historic"];
  way["historic"];
  node["heritage"];
  way["heritage"];
);
out center tags;
`.trim();

  const res = await fetch(OVERPASS_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const json = await res.json();

  const items = [];
  for (const el of json.elements) {
    const tags = el.tags || {};
    const type = classifyItem(tags);
    if (!type) continue;

    const lat = el.type === 'node' ? el.lat : el.center?.lat;
    const lng = el.type === 'node' ? el.lon : el.center?.lon;
    if (!lat || !lng) continue;

    items.push({ id: `osm-${el.type}-${el.id}`, lat, lng, type, tags, source: 'osm', osmId: el.id, osmType: el.type });
  }
  return items;
}

// RAÄ Fornsök API — Swedish National Heritage archaeological sites
async function fetchFornsok(bbox) {
  const { south, west, north, east } = bbox;
  const url = `${FORNSOK_URL}/features?bbox=${west},${south},${east},${north}&type=Archaeological`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fornsök HTTP ${res.status}`);
  const json = await res.json();

  const items = [];
  const features = json.features || json.hits || [];
  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (!coords) continue;

    const props = f.properties || {};
    const lat   = coords[1];
    const lng   = coords[0];
    const id    = `raa-${props.raaId || props.id || `${lat},${lng}`}`;

    const tags = {
      historic:    'archaeological_site',
      name:        props.name || props.antikvariskBedomning || props.typ || 'Fornlämning',
      description: props.beskrivning || props.description || '',
      raaId:       props.raaId || props.id,
      raaUrl:      props.raaId ? `https://app.raa.se/open/fornsok/#/details/${props.raaId}` : null,
    };
    items.push({ id, lat, lng, type: 'archaeological', tags, source: 'raa' });
  }
  return items;
}

// ── Marker rendering ──────────────────────────────────────────────────────────
function renderMarkers() {
  markersLayer.clearLayers();

  for (const item of allItems) {
    if (!activeFilters.has(item.type)) continue;

    const icon   = createMarkerIcon(item.type);
    const name   = getItemName(item.tags) || TYPES[item.type].label;
    const marker = L.marker([item.lat, item.lng], { icon, title: name });

    marker.on('click', () => showInfoCard(item));
    marker.addTo(markersLayer);
    item.marker = marker;
  }
}

// ── Info card ─────────────────────────────────────────────────────────────────
function showInfoCard(item) {
  const tags   = item.tags;
  const cfg    = TYPES[item.type];
  const name   = getItemName(tags) || cfg.label;

  // Badge
  const badge = dom.infoBadge();
  badge.textContent = cfg.label;
  badge.style.background = cfg.color + '33';
  badge.style.color      = cfg.color;
  badge.style.border     = `1px solid ${cfg.color}66`;

  // Name
  dom.infoName().textContent = name;

  // Detail rows
  const details = dom.infoDetails();
  details.innerHTML = '';

  function addRow(label, value) {
    if (!value) return;
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    details.appendChild(dt);
    details.appendChild(dd);
  }

  const historicLabel = HISTORIC_LABELS[tags.historic] || tags.historic;
  addRow('Typ',        historicLabel || cfg.label);
  addRow('Plats',      tags['addr:city'] || tags.municipality || tags.county || '');
  addRow('Skyddsnivå', HERITAGE_LABELS[tags.heritage] || (tags['heritage:operator'] ? `Skyddad av ${tags['heritage:operator']}` : ''));
  addRow('Byggd',      tags.start_date || tags['historic:start_date'] || tags['construction_date'] || '');
  if (tags.description) addRow('Info', tags.description.substring(0, 200) + (tags.description.length > 200 ? '…' : ''));

  // Links
  const linksEl = dom.infoLinks();
  linksEl.innerHTML = '';

  function addLink(href, icon, label) {
    if (!href) return;
    const a    = document.createElement('a');
    a.href     = href;
    a.target   = '_blank';
    a.rel      = 'noopener noreferrer';
    a.className = 'info-link';
    a.innerHTML = `<span class="link-icon">${icon}</span><span>${label}</span>`;
    linksEl.appendChild(a);
  }

  addLink(tags.website || tags.url,           '🌐', 'Officiell webbplats');
  addLink(tags.wikipedia ? `https://sv.wikipedia.org/wiki/${encodeURIComponent(tags.wikipedia.replace(/^sv:/, ''))}` : null, '📖', 'Wikipedia');
  addLink(tags.wikidata  ? `https://www.wikidata.org/wiki/${tags.wikidata}` : null, '🔗', 'Wikidata');
  addLink(tags.raaUrl,                        '🏛', 'Riksantikvarieämbetet');

  if (item.source === 'osm') {
    const osmUrl = `https://www.openstreetmap.org/${item.osmType}/${item.osmId}`;
    addLink(osmUrl, '🗺', 'Visa på OpenStreetMap');
  }

  if (!linksEl.children.length) {
    linksEl.innerHTML = '<p style="font-size:12px;color:var(--text-muted);margin-top:4px">Inga externa länkar tillgängliga.</p>';
  }

  dom.infoCard().classList.remove('hidden');
}

function hideInfoCard() {
  dom.infoCard().classList.add('hidden');
}

// ── Geolocation ───────────────────────────────────────────────────────────────
function locateUser() {
  if (!navigator.geolocation) {
    setStatus('Platsinformation stöds inte av din webbläsare.');
    return;
  }
  setLoading(true, 'Hämtar din position…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      map.setView([lat, lng], DEFAULT_ZOOM);
      L.circleMarker([lat, lng], {
        radius:      8,
        color:       '#38bdf8',
        fillColor:   '#38bdf8',
        fillOpacity: 0.7,
        weight:      2,
      }).addTo(map).bindPopup('Du är här').openPopup();
      setLoading(false);
    },
    err => {
      setLoading(false);
      setStatus(`Kunde inte hämta position: ${err.message}`);
    },
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

// ── Place search (Nominatim) ──────────────────────────────────────────────────
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
let searchDebounce;

async function searchPlace(query) {
  if (!query.trim()) return [];
  const params = new URLSearchParams({
    q:              query,
    format:         'json',
    countrycodes:   'se',
    limit:          6,
    addressdetails: 1,
  });
  const res = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: { 'Accept-Language': 'sv' },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  return res.json();
}

function showSuggestions(results) {
  const list = document.getElementById('search-suggestions');
  list.innerHTML = '';
  if (!results.length) {
    list.classList.add('hidden');
    return;
  }
  for (const r of results) {
    const li   = document.createElement('li');
    li.textContent = r.display_name;
    li.addEventListener('click', () => goToResult(r));
    list.appendChild(li);
  }
  list.classList.remove('hidden');
}

function goToResult(result) {
  const lat  = parseFloat(result.lat);
  const lng  = parseFloat(result.lon);
  const bbox = result.boundingbox; // [s, n, w, e]

  document.getElementById('search-suggestions').classList.add('hidden');
  document.getElementById('search-input').value = result.display_name.split(',')[0];

  if (bbox) {
    map.fitBounds([[+bbox[0], +bbox[2]], [+bbox[1], +bbox[3]]], { maxZoom: 14 });
  } else {
    map.setView([lat, lng], 13);
  }
}

function bindSearch() {
  const input = document.getElementById('search-input');
  const btn   = document.getElementById('search-btn');
  const list  = document.getElementById('search-suggestions');

  input.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const q = input.value.trim();
    if (q.length < 2) { list.classList.add('hidden'); return; }
    searchDebounce = setTimeout(async () => {
      try {
        const results = await searchPlace(q);
        showSuggestions(results);
      } catch { /* silent */ }
    }, 350);
  });

  async function triggerSearch() {
    const q = input.value.trim();
    if (!q) return;
    try {
      const results = await searchPlace(q);
      if (results.length === 1) goToResult(results[0]);
      else showSuggestions(results);
    } catch { setStatus('Sökning misslyckades.'); }
  }

  btn.addEventListener('click', triggerSearch);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') triggerSearch(); });

  // Close suggestions when clicking outside
  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !list.contains(e.target)) {
      list.classList.add('hidden');
    }
  });
}

// ── Filter toggle ─────────────────────────────────────────────────────────────
function bindFilters() {
  for (const type of Object.keys(TYPES)) {
    const cb = document.getElementById(`filter-${type}`);
    if (!cb) continue;
    cb.addEventListener('change', () => {
      if (cb.checked) activeFilters.add(type);
      else            activeFilters.delete(type);
      renderMarkers();
    });
  }
}

// ── Sidebar toggle ────────────────────────────────────────────────────────────
function bindSidebarToggle() {
  const btn     = dom.sidebarToggle();
  const sidebar = dom.sidebar();
  btn.addEventListener('click', () => {
    const collapsed = sidebar.classList.toggle('collapsed');
    btn.textContent = collapsed ? '▼' : '◀';
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindFilters();
  bindSidebarToggle();
  bindSearch();
  dom.closeCard().addEventListener('click', hideInfoCard);
  dom.locateBtn().addEventListener('click', () => { hideInfoCard(); locateUser(); });
  dom.reloadBtn().addEventListener('click', () => { allItems = []; loadData(); });

  // Attempt to geolocate first, then fall back to Stockholm
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => initMap([pos.coords.latitude, pos.coords.longitude]),
      ()  => initMap(DEFAULT_CENTER),
      { timeout: 5000 },
    );
  } else {
    initMap(DEFAULT_CENTER);
  }
});
