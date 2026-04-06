import 'dotenv/config';
import express from 'express';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { Open } from 'unzipper';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3333;
const RESROBOT_KEY = process.env.RESROBOT_API_KEY || '';

// Operatörer med separata nycklar per operatör
const OPERATORS = (process.env.OPERATORS || 'otraf').split(',').map(s => s.trim());

// Bygg nyckelmap: { otraf: { rt, static }, orebro: { rt, static } }
const OP_KEYS = {};
for (const op of OPERATORS) {
  const prefix = op.toUpperCase();
  OP_KEYS[op] = {
    rt: process.env[`${prefix}_RT_KEY`] || '',
    static: process.env[`${prefix}_STATIC_KEY`] || '',
  };
  if (!OP_KEYS[op].rt) { console.error(`❌ ${prefix}_RT_KEY saknas!`); process.exit(1); }
}

console.log(`📡 Operatörer: ${OPERATORS.map(op => `${op} (RT:✅ Static:${OP_KEYS[op].static ? '✅' : '❌'})`).join(', ')}`);

// ── Statisk GTFS-data ──────────────────────────────────────────────
const GTFS_DIR = join(__dirname, 'gtfs-data');
const tripLookup = new Map();
const routeLookup = new Map();
let stopsData = [];

async function downloadAndParseGTFS() {
  mkdirSync(GTFS_DIR, { recursive: true });

  for (const op of OPERATORS) {
    const key = OP_KEYS[op].static;
    if (!key) { console.log(`  ⚠️ ${op}: ingen static-nyckel, hoppar över`); continue; }
    await downloadGTFSZip(op, `https://opendata.samtrafiken.se/gtfs/${op}/${op}.zip?key=${key}`);
  }

  const dirs = OPERATORS;
  for (const dir of dirs) {
    const base = join(GTFS_DIR, dir);
    if (existsSync(join(base, 'routes.txt'))) parseRoutes(join(base, 'routes.txt'));
    if (existsSync(join(base, 'trips.txt'))) parseTrips(join(base, 'trips.txt'));
    if (existsSync(join(base, 'stops.txt'))) parseStops(join(base, 'stops.txt'));
  }

  console.log(`📋 ${routeLookup.size} rutter, ${tripLookup.size} trips, ${stopsData.length} hållplatser`);
}

async function downloadGTFSZip(name, url) {
  const dir = join(GTFS_DIR, name);
  mkdirSync(dir, { recursive: true });
  const routesFile = join(dir, 'routes.txt');
  const maxAge = 24 * 60 * 60 * 1000;

  if (existsSync(routesFile) && (Date.now() - statSync(routesFile).mtimeMs) < maxAge) {
    console.log(`  ⏭️  ${name} — cache OK`);
    return;
  }

  console.log(`📥 Laddar ner ${name}...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);

  const zipPath = join(dir, `${name}.zip`);
  writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));

  const archive = await Open.file(zipPath);
  const wanted = ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'shapes.txt'];
  for (const file of archive.files) {
    if (wanted.includes(file.path)) {
      writeFileSync(join(dir, file.path), await file.buffer());
      console.log(`  ✅ ${name}/${file.path}`);
    }
  }
}

function parseCSV(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  return lines.slice(1).map(line => {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') { inQuotes = !inQuotes; }
      else if (char === ',' && !inQuotes) { values.push(current.trim()); current = ''; }
      else { current += char; }
    }
    values.push(current.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = values[i] || '');
    return obj;
  });
}

function parseRoutes(filePath) {
  for (const row of parseCSV(filePath)) {
    routeLookup.set(row.route_id, {
      shortName: row.route_short_name || '',
      longName: row.route_long_name || '',
      desc: row.route_desc || '',
      type: parseInt(row.route_type) || 3,
    });
  }
}

function parseTrips(filePath) {
  for (const row of parseCSV(filePath)) {
    const route = routeLookup.get(row.route_id);
    tripLookup.set(row.trip_id, {
      routeId: row.route_id,
      shapeId: row.shape_id || '',
      routeShortName: route?.shortName || '',
      routeLongName: route?.longName || route?.desc || '',
      headsign: row.trip_headsign || route?.desc || '',
      directionId: parseInt(row.direction_id) || 0,
      routeType: route?.type || 3,
    });
  }
}

function parseStops(filePath) {
  const newStops = parseCSV(filePath)
    .filter(row => row.stop_lat && row.stop_lon)
    .map(row => ({
      id: row.stop_id,
      name: row.stop_name || '',
      lat: parseFloat(row.stop_lat),
      lng: parseFloat(row.stop_lon),
      type: row.location_type || '0',
    }));
  stopsData = stopsData.concat(newStops);
}

// ── Stop-lookup ────────────────────────────────────────────────────
const stopById = new Map();
function buildStopIndex() {
  if (stopById.size > 0) return;
  for (const s of stopsData) stopById.set(s.id, s);
}

// ── Trip detail (lazy loaded) ──────────────────────────────────────
let stopTimesIndex = null;
const shapeCache = new Map();
let shapesLoaded = false;

function ensureStopTimesIndex() {
  if (stopTimesIndex) return;
  stopTimesIndex = new Map();

  for (const dir of OPERATORS) {
    const filePath = join(GTFS_DIR, dir, 'stop_times.txt');
    if (!existsSync(filePath)) continue;

    console.log(`📥 Indexerar ${dir}/stop_times.txt...`);
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const idx = {};
    headers.forEach((h, i) => idx[h] = i);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(',');
      const tripId = cols[idx.trip_id];
      if (!tripId) continue;
      if (!stopTimesIndex.has(tripId)) stopTimesIndex.set(tripId, []);
      stopTimesIndex.get(tripId).push({
        stopId: cols[idx.stop_id] || '',
        arrival: cols[idx.arrival_time] || '',
        departure: cols[idx.departure_time] || '',
        seq: parseInt(cols[idx.stop_sequence]) || 0,
        headsign: cols[idx.stop_headsign] || '',
      });
    }
  }

  for (const [, stops] of stopTimesIndex) stops.sort((a, b) => a.seq - b.seq);
  console.log(`  ✅ ${stopTimesIndex.size} trips indexerade`);
}

function loadShape(shapeId) {
  if (shapeCache.has(shapeId)) return shapeCache.get(shapeId);

  if (!shapesLoaded) {
    for (const dir of OPERATORS) {
      const filePath = join(GTFS_DIR, dir, 'shapes.txt');
      if (!existsSync(filePath)) continue;

      console.log(`📥 Laddar ${dir}/shapes.txt...`);
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
      const idx = {};
      headers.forEach((h, i) => idx[h] = i);

      const tmp = new Map();
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(',');
        const sid = cols[idx.shape_id];
        if (!sid) continue;
        if (!tmp.has(sid)) tmp.set(sid, []);
        tmp.get(sid).push({ lat: parseFloat(cols[idx.shape_pt_lat]), lng: parseFloat(cols[idx.shape_pt_lon]), seq: parseInt(cols[idx.shape_pt_sequence]) || 0 });
      }

      for (const [sid, pts] of tmp) {
        pts.sort((a, b) => a.seq - b.seq);
        shapeCache.set(sid, pts.map(p => [p.lat, p.lng]));
      }
    }
    shapesLoaded = true;
    console.log(`  ✅ ${shapeCache.size} shapes laddade`);
  }

  return shapeCache.get(shapeId) || [];
}

function getTripDetail(tripId) {
  buildStopIndex();
  ensureStopTimesIndex();
  const tripInfo = tripLookup.get(tripId);
  if (!tripInfo) return null;
  const stopTimes = stopTimesIndex?.get(tripId) || [];
  const stops = stopTimes.map(st => {
    const stop = stopById.get(st.stopId);
    return { id: st.stopId, name: stop?.name || st.headsign || st.stopId, lat: stop?.lat || 0, lng: stop?.lng || 0, arrival: st.arrival, departure: st.departure, seq: st.seq };
  });
  return { tripId, line: tripInfo.routeShortName, lineName: tripInfo.routeLongName, headsign: tripInfo.headsign, vehicleType: vehicleTypeLabel(tripInfo.routeType), stops, shape: tripInfo.shapeId ? loadShape(tripInfo.shapeId) : [] };
}

// ── Route types ────────────────────────────────────────────────────
function vehicleTypeLabel(rt) {
  if (rt === 100 || rt === 2) return 'train';
  if (rt === 900 || rt === 0) return 'tram';
  if (rt === 1) return 'metro';
  if (rt === 4 || rt === 1200) return 'ferry';
  return 'bus';
}

function occupancyLabel(s) {
  return ['Tomt','Många platser','Få platser','Bara ståplatser','Trångt','Fullt'][s] ?? null;
}

// ── Fordon (multi-operatör) ────────────────────────────────────────
let vehicleCache = { data: [], timestamp: 0 };

async function fetchVehiclePositions() {
  const now = Date.now();
  if (now - vehicleCache.timestamp < 5000) return vehicleCache.data;

  const allVehicles = [];

  // Hämta från alla operatörer parallellt
  const results = await Promise.allSettled(OPERATORS.map(async (op) => {
    const url = `https://opendata.samtrafiken.se/gtfs-rt/${op}/VehiclePositions.pb?key=${OP_KEYS[op].rt}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`${op}: ${response.status}`);
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(await response.arrayBuffer())
    );

    return feed.entity
      .filter(e => e.vehicle?.position)
      .map(e => {
        const v = e.vehicle;
        const tripId = v.trip?.tripId || '';
        const info = tripLookup.get(tripId);
        const routeType = info?.routeType ?? 3;
        return {
          id: `${op}_${e.id}`,
          vehicleId: v.vehicle?.id || e.id,
          operator: op,
          lat: v.position.latitude,
          lng: v.position.longitude,
          bearing: v.position.bearing || 0,
          speed: v.position.speed != null ? Math.round(v.position.speed * 3.6) : null,
          line: info?.routeShortName || '',
          lineName: info?.routeLongName || '',
          destination: info?.headsign || '',
          vehicleType: vehicleTypeLabel(routeType),
          routeType,
          occupancy: occupancyLabel(v.occupancyStatus),
          tripId,
          timestamp: v.timestamp?.low || v.timestamp || 0,
        };
      });
  }));

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allVehicles.push(...result.value);
    } else {
      console.error('❌', result.reason?.message);
    }
  }

  vehicleCache = { data: allVehicles, timestamp: now };
  return allVehicles;
}

// ── Störningar (multi-operatör) ────────────────────────────────────
let alertsCache = { data: [], timestamp: 0 };

async function fetchAlerts() {
  const now = Date.now();
  if (now - alertsCache.timestamp < 60000) return alertsCache.data;

  const allAlerts = [];
  const results = await Promise.allSettled(OPERATORS.map(async (op) => {
    const url = `https://opendata.samtrafiken.se/gtfs-rt/${op}/ServiceAlerts.pb?key=${OP_KEYS[op].rt}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`${op}: ${response.status}`);
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(await response.arrayBuffer())
    );

    return feed.entity.map(e => {
      const a = e.alert;
      const getText = f => f?.translation?.[0]?.text || '';
      return { id: `${op}_${e.id}`, operator: op, header: getText(a.headerText), description: getText(a.descriptionText), cause: a.cause, effect: a.effect, routes: a.informedEntity?.map(ie => ie.routeId).filter(Boolean) || [], stops: a.informedEntity?.map(ie => ie.stopId).filter(Boolean) || [], startTime: a.activePeriod?.[0]?.start?.low || a.activePeriod?.[0]?.start || null, endTime: a.activePeriod?.[0]?.end?.low || a.activePeriod?.[0]?.end || null };
    });
  }));

  for (const r of results) {
    if (r.status === 'fulfilled') allAlerts.push(...r.value);
  }

  alertsCache = { data: allAlerts, timestamp: now };
  return allAlerts;
}

// ── ResRobot ───────────────────────────────────────────────────────
async function searchTrip(originId, destId, products) {
  if (!RESROBOT_KEY) return { error: 'RESROBOT_API_KEY saknas' };
  let url = `https://api.resrobot.se/v2.1/trip?originId=${originId}&destId=${destId}&format=json&accessId=${RESROBOT_KEY}`;
  if (products) url += `&products=${products}`;
  try { return await (await fetch(url)).json(); } catch (err) { return { error: err.message }; }
}

async function searchStops(query) {
  if (!RESROBOT_KEY) return { error: 'RESROBOT_API_KEY saknas' };
  try { return await (await fetch(`https://api.resrobot.se/v2.1/location.name?input=${encodeURIComponent(query)}&format=json&accessId=${RESROBOT_KEY}`)).json(); } catch (err) { return { error: err.message }; }
}

// ── Besöksstatistik ────────────────────────────────────────────────
const STATS_FILE = join(__dirname, 'stats.json');
let stats = { daily: {}, active: new Set() };

function loadStats() {
  try {
    if (existsSync(STATS_FILE)) {
      const data = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
      stats.daily = data.daily || {};
    }
  } catch {}
}

function saveStats() {
  try {
    writeFileSync(STATS_FILE, JSON.stringify({ daily: stats.daily }, null, 2));
  } catch {}
}

function trackVisit(sessionId) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (!stats.daily[today]) stats.daily[today] = { visits: 0, unique: [] };
  const day = stats.daily[today];

  if (!day.unique.includes(sessionId)) {
    day.unique.push(sessionId);
    day.visits++;
    saveStats();
  }

  // Rensa gammal data (behåll 30 dagar)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const key of Object.keys(stats.daily)) {
    if (key < cutoffStr) delete stats.daily[key];
  }
}

function getStats14Days() {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const dayNum = d.getDate();
    const month = d.getMonth() + 1;
    days.push({
      date: `${dayNum}/${month}`,
      count: stats.daily[key]?.visits || 0,
    });
  }
  return days;
}

// Track active connections
let activeConnections = 0;

loadStats();

// ── Endpoints ──────────────────────────────────────────────────────
app.get('/api/vehicles', async (req, res) => {
  try { const v = await fetchVehiclePositions(); res.json({ count: v.length, timestamp: Date.now(), vehicles: v }); }
  catch { res.status(500).json({ error: 'Fel' }); }
});

app.get('/api/alerts', async (req, res) => {
  try { res.json({ alerts: await fetchAlerts() }); }
  catch { res.status(500).json({ error: 'Fel' }); }
});

app.get('/api/stops', (req, res) => {
  const { lat, lng, radius } = req.query;
  let stops = stopsData.filter(s => s.type === '1' || s.type === '');
  if (lat && lng && radius) {
    const cLat = parseFloat(lat), cLng = parseFloat(lng), r = parseFloat(radius);
    stops = stops.filter(s => haversine(cLat, cLng, s.lat, s.lng) <= r);
  }
  res.json({ count: stops.length, stops });
});

app.get('/api/stops/nearest', (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat & lng krävs' });
  const cLat = parseFloat(lat), cLng = parseFloat(lng);
  const sorted = stopsData.filter(s => s.type === '1' || s.type === '')
    .map(s => ({ ...s, distance: haversine(cLat, cLng, s.lat, s.lng) }))
    .sort((a, b) => a.distance - b.distance).slice(0, 5);
  res.json({ stops: sorted });
});

app.get('/api/resrobot/departures', async (req, res) => {
  if (!RESROBOT_KEY) return res.status(503).json({ error: 'RESROBOT_API_KEY saknas' });
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id krävs' });
  try { res.json(await (await fetch(`https://api.resrobot.se/v2.1/departureBoard?id=${id}&format=json&accessId=${RESROBOT_KEY}&duration=60`)).json()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/resrobot/stops', async (req, res) => { res.json(await searchStops(req.query.q || '')); });
app.get('/api/resrobot/trip', async (req, res) => {
  const { from, to, products } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from & to krävs' });
  res.json(await searchTrip(from, to, products));
});

app.get('/api/trip/:tripId', (req, res) => {
  const d = getTripDetail(req.params.tripId);
  if (!d) return res.status(404).json({ error: 'Trip hittades inte' });
  res.json(d);
});

// Statistik
app.post('/api/visit', express.json(), (req, res) => {
  const sid = req.body?.sessionId || req.ip;
  trackVisit(sid);
  activeConnections = Math.max(1, activeConnections);
  res.json({ ok: true });
});

app.get('/api/stats', (req, res) => {
  const days = getStats14Days();
  const total = Object.values(stats.daily).reduce((s, d) => s + d.visits, 0);
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = stats.daily[today]?.visits || 0;
  res.json({ days, total, today: todayCount, active: activeConnections });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', operators: OPERATORS, vehicleCount: vehicleCache.data.length, routeCount: routeLookup.size, tripCount: tripLookup.size, stopCount: stopsData.length, alertCount: alertsCache.data.length, resrobot: !!RESROBOT_KEY });
});

app.use(express.static(join(__dirname, 'public')));

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Start ──────────────────────────────────────────────────────────
async function start() {
  try { await downloadAndParseGTFS(); }
  catch (err) { console.error('⚠️ GTFS:', err.message); }

  app.listen(PORT, () => {
    console.log(`🚌 Livemap på http://localhost:${PORT}`);
    console.log(`   Operatörer: ${OPERATORS.join(', ')}`);
    console.log(`   ResRobot: ${RESROBOT_KEY ? '✅' : '❌'}`);
  });
}

start();
