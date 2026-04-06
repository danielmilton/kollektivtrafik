// Livemap v5
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Session-tracking
const sessionId = localStorage.getItem('sid') || (() => {
  const id = Math.random().toString(36).slice(2);
  localStorage.setItem('sid', id);
  return id;
})();
fetch('/api/visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) }).catch(() => {});

let followId = null;
let stopsOn = false;
let typeFilter = { bus: true, train: true, tram: true, ferry: true, metro: true };
const vm = new Map();   // id → L.marker
const vd = new Map();   // id → vehicle data (senaste från API)
const vInterp = new Map(); // id → { lat, lng, bearing, speed, prevLat, prevLng, lastUpdate }

// Centrera mellan Östergötland och Örebro
const map = L.map('map', { zoomControl: false }).setView([58.8, 15.4], 9);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OSM &copy; CARTO | Trafiklab', maxZoom: 18
}).addTo(map);

const routeL = L.layerGroup().addTo(map);
const stopL = L.layerGroup();

// Teal/grön/cyan palette
const C = {
  bus:   { c:'#2dd4bf', e:'🚌', l:'Buss' },
  train: { c:'#4ade80', e:'🚆', l:'Tåg' },
  tram:  { c:'#22d3ee', e:'🚊', l:'Spårvagn' },
  ferry: { c:'#06b6d4', e:'⛴️',  l:'Färja' },
  metro: { c:'#fb923c', e:'🚇', l:'T-bana' },
};
let regionFilter = 'all'; // 'all', 'otraf', 'orebro'
const vc = t => C[t] || C.bus;

// ── Card ───────────────────────────────────────────────────────────
const cardEl = document.getElementById('card');
const cardIn = document.getElementById('card-inner');

function openCard(html) {
  cardIn.innerHTML = `<div class="card-bar"></div><button class="card-x" onclick="closeCard()"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg></button>${html}`;
  cardEl.classList.remove('hidden');
  cardEl.scrollTop = 0;
}
function closeCard() { cardEl.classList.add('hidden'); routeL.clearLayers(); }
window.closeCard = closeCard;

// ── Icons (alltid prickar) ─────────────────────────────────────────
function mkIcon(v) {
  const { c } = vc(v.vehicleType);
  const isF = followId === v.id;
  const hasLine = !!v.line;
  const zoom = map.getZoom();
  const sz = zoom >= 15 ? 14 : zoom >= 13 ? 11 : zoom >= 11 ? 8 : 6;
  const opacity = hasLine ? 1 : 0.25;
  return L.divIcon({
    className: '',
    html: `<div class="vdot ${isF?'follow':''}" style="background:${c};width:${sz}px;height:${sz}px;opacity:${opacity}"></div>`,
    iconSize: [sz, sz], iconAnchor: [sz/2, sz/2],
  });
}

map.on('zoomend', () => {
  for (const [id, m] of vm) {
    const v = vd.get(id);
    if (v) m.setIcon(mkIcon(v));
  }
  updateVisibleCount();
});

map.on('moveend', updateVisibleCount);

function updateVisibleCount() {
  const bounds = map.getBounds();
  let n = 0;
  for (const [id, v] of vd) {
    if (!v.line) continue; // Bara aktiva med linje
    if (!typeFilter[v.vehicleType]) continue;
    if (regionFilter !== 'all' && v.operator !== regionFilter) continue;
    if (bounds.contains([v.lat, v.lng])) n++;
  }
  document.getElementById('v-count').textContent = n;
}

// ── Smooth Interpolation ───────────────────────────────────────────
// Varje fordon har:
//   currentLat/Lng — var markören är just nu (visas)
//   targetLat/Lng  — var API:t senast sa att fordonet är
//   bearing, speed — för dead-reckoning framåt från target
//   targetTime     — performance.now() när target sattes
//
// Varje tick:
//   1. Beräkna predicted position = target + dead-reckoning sedan targetTime
//   2. Lerpa currentLat/Lng mot predicted (smooth, ingen hopp)

const DEG_PER_KM = 1 / 111;

// Smooth interpolation med requestAnimationFrame (60fps)
// Fordon glider framåt med sin hastighet+riktning.
// Vid nytt API-svar sätts ny target — fordonet lerpar mjukt dit
// över ~2 sekunder istället för att hoppa.

let lastFrame = 0;

function interpTick(timestamp) {
  requestAnimationFrame(interpTick);

  // Begränsa till ~30fps för perf (var ~33ms)
  if (timestamp - lastFrame < 33) return;
  const frameDt = (timestamp - lastFrame) / 1000;
  lastFrame = timestamp;

  for (const [id, s] of vInterp) {
    const m = vm.get(id);
    if (!m) continue;

    // Predicted position = target + dead reckoning
    const dt = (timestamp - s.targetTime) / 1000;
    let predLat = s.targetLat;
    let predLng = s.targetLng;

    if (s.speed > 0 && dt > 0) {
      const distKm = (s.speed / 3600) * dt;
      const rad = s.bearing * Math.PI / 180;
      predLat += distKm * DEG_PER_KM * Math.cos(rad);
      predLng += distKm * (DEG_PER_KM / Math.cos(s.targetLat * Math.PI / 180)) * Math.sin(rad);
    }

    // Tidbaserad lerp: ~3.0 per sekund = smooth catch-up
    const lerpSpeed = 3.0;
    const t = 1 - Math.exp(-lerpSpeed * frameDt);
    s.currentLat += (predLat - s.currentLat) * t;
    s.currentLng += (predLng - s.currentLng) * t;

    m.setLatLng([s.currentLat, s.currentLng]);

    if (followId === id) {
      if (!map._followPaused) map.panTo([s.currentLat, s.currentLng], { animate: false });
    }
  }
}

requestAnimationFrame(interpTick);

// ── Update Vehicles (API var 5s) ───────────────────────────────────
async function updateVehicles() {
  try {
    const data = await (await fetch('/api/vehicles')).json();
    const active = new Set();
    let n = 0;
    const now = performance.now();

    data.vehicles.forEach(v => {
      if (!typeFilter[v.vehicleType]) return;
      if (regionFilter !== 'all' && v.operator !== regionFilter) return;
      if (!v.line && !showInactive) return;
      active.add(v.id); n++;
      vd.set(v.id, v);

      const existing = vInterp.get(v.id);

      if (existing) {
        // Uppdatera target — current fortsätter lerpa dit
        existing.targetLat = v.lat;
        existing.targetLng = v.lng;
        existing.bearing = v.bearing || 0;
        existing.speed = v.speed || 0;
        existing.targetTime = now;
        // OBS: currentLat/Lng ändras INTE här — lerpen sköter det
      } else {
        // Nytt fordon — starta direkt på rätt position
        vInterp.set(v.id, {
          currentLat: v.lat,
          currentLng: v.lng,
          targetLat: v.lat,
          targetLng: v.lng,
          bearing: v.bearing || 0,
          speed: v.speed || 0,
          targetTime: now,
        });
      }

      const icon = mkIcon(v);
      if (!icon) return;

      if (vm.has(v.id)) {
        const m = vm.get(v.id);
        m.setIcon(icon);
        // Säkerställ att följt fordon alltid syns
        if (followId === v.id && !map.hasLayer(m)) m.addTo(map);
      } else {
        const m = L.marker([v.lat, v.lng], { icon })
          .on('click', () => selectVehicle(v.id));
        // I följ-läge: lägg bara till det följda fordonet på kartan
        if (!followId || v.id === followId) m.addTo(map);
        vm.set(v.id, m);
      }
    });

    for (const [id, m] of vm) {
      if (!active.has(id)) { map.removeLayer(m); vm.delete(id); vd.delete(id); vInterp.delete(id); }
    }

    updateVisibleCount();
    document.getElementById('live-dot').className = 'on';
  } catch {
    document.getElementById('live-dot').className = '';
  }
}

// ── Type Filters ───────────────────────────────────────────────────
document.querySelectorAll('.fbtn').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    btn.classList.toggle('on');
    typeFilter[type] = btn.classList.contains('on');

    // Remove vehicles of disabled type
    for (const [id, m] of vm) {
      const v = vd.get(id);
      if (v && !typeFilter[v.vehicleType]) {
        map.removeLayer(m);
        vm.delete(id);
      }
    }
    updateVehicles();
  });
});

// ── Select Vehicle → Sidopanel ─────────────────────────────────────
async function selectVehicle(id) {
  const v = vd.get(id);
  if (!v) return;
  const { c, l } = vc(v.vehicleType);
  const isF = followId === id;
  const speed = v.speed != null ? `${v.speed} km/h` : '—';

  const spEmpty = document.getElementById('sp-empty');
  const spContent = document.getElementById('sp-content');
  spEmpty.classList.add('hidden');
  spContent.classList.remove('hidden');

  // Header + loading
  spContent.innerHTML = `
    <div class="sp-head">
      <div class="sp-dot" style="background:${c}"></div>
      <span class="sp-title">${l} · Linje ${v.line || '?'}</span>
      <span class="sp-speed" id="s-speed">${speed}</span>
      <button class="sp-close" id="sp-x"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
    </div>
    <div class="spinner"></div>
  `;

  document.getElementById('sp-x').onclick = clearStopsPanel;

  // Hämta trip-data
  if (!v.tripId) {
    spContent.innerHTML += '<p class="empty">Inget aktivt trip-ID</p>';
    return;
  }

  try {
    const trip = await fetch(`/api/trip/${v.tripId}`).then(r => r.json());
    window._lastTrip = trip;
    const ni = nextStop(trip.stops);

    // Nästa stopp
    let nextHtml = '';
    if (ni >= 0) {
      const ns = trip.stops[ni];
      const time = (ns.departure || ns.arrival || '').substring(0, 5);
      nextHtml = `
        <div class="sp-next">
          <div class="sp-next-left">
            <span class="sp-next-label">Nästa stopp</span>
            <span class="sp-next-name">${esc(ns.name)}</span>
          </div>
          <span class="sp-next-time">${time}</span>
        </div>`;
    }

    // Stopplista — visa bara från nästa stopp och framåt
    const startIdx = ni >= 0 ? ni : 0;
    const remaining = trip.stops.length - startIdx;
    let stopsHtml = `<div class="sp-stops-label">Kommande hållplatser (${remaining})</div>`;
    trip.stops.forEach((s, i) => {
      if (ni >= 0 && i < ni) return; // Hoppa över passerade
      const isN = i === ni;
      const time = (s.departure || s.arrival || '').substring(0, 5);
      stopsHtml += `<div class="sp-row ${isN ? 'n' : ''}">
        <span class="sp-time">${time}</span>
        <span class="sp-rdot" style="background:${c}"></span>
        <span class="sp-name">${esc(s.name)}</span>
      </div>`;
    });

    spContent.innerHTML = `
      <div class="sp-head">
        <div class="sp-dot" style="background:${c}"></div>
        <span class="sp-title">${l} · Linje ${v.line || '?'}</span>
        <span class="sp-speed" id="s-speed">${speed}</span>
        <button class="sp-close" id="sp-x"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
      </div>
      ${nextHtml}
      <div class="sp-btns">
        <button class="sp-btn f ${isF?'on':''}" id="b-f">${isF ? 'Följer' : 'Följ'}</button>
        <button class="sp-btn" id="b-r">Visa rutt</button>
      </div>
      ${stopsHtml}
    `;

    document.getElementById('sp-x').onclick = () => { clearStopsPanel(); if (followId) stopFollow(); };
    document.getElementById('b-f').onclick = () => toggleFollow(id, trip);

    // Rutt toggle — helt fristående från follow
    document.getElementById('b-r').onclick = function() {
      if (routeL.getLayers().length > 0) {
        // Rutt visas → dölj den
        routeL.clearLayers();
        this.textContent = 'Visa rutt';
      } else {
        // Rutt gömd → visa den
        drawRoute(v, trip);
        this.textContent = 'Dölj rutt';
      }
      // ALLTID: säkerställ fordonspricken
      ensureVehicleVisible(id);
    };
    // Om follow är aktivt, visa rutt automatiskt
    if (followId === id && routeL.getLayers().length > 0) {
      document.getElementById('b-r').textContent = 'Dölj rutt';
    }

    // Scrolla till nästa
    setTimeout(() => {
      const el = spContent.querySelector('.sp-row.n');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);

  } catch {
    spContent.querySelector('.spinner')?.remove();
    spContent.innerHTML += '<p class="empty">Kunde inte ladda hållplatser</p>';
  }
}

function clearStopsPanel() {
  document.getElementById('sp-empty').classList.remove('hidden');
  document.getElementById('sp-content').classList.add('hidden');
  document.getElementById('sp-content').innerHTML = '';
  routeL.clearLayers();
}

// Mobil: klicka på overlay-bakgrunden döljer panelen (follow + rutt behålls)
document.getElementById('stops-panel').addEventListener('click', (e) => {
  if (e.target.id === 'stops-panel') {
    // Dölj panelen visuellt utan att rensa data eller stoppa follow
    document.getElementById('sp-empty').classList.remove('hidden');
    document.getElementById('sp-content').classList.add('hidden');
  }
});

// ── Hjälpfunktion: garantera att ett fordon syns ──────────────────
function ensureVehicleVisible(id) {
  const m = vm.get(id);
  if (m && !map.hasLayer(m)) map.addLayer(m);
}

// ── Follow ─────────────────────────────────────────────────────────
function toggleFollow(id, trip) {
  if (followId === id) { stopFollow(); return; }

  // Starta follow
  followId = id;
  map._followPaused = false;
  const v = vd.get(id);

  // UI
  document.getElementById('follow').classList.remove('hidden');
  const lineText = v?.line ? `Linje ${v.line}` : (document.querySelector('.sp-title')?.textContent || 'Fordon');
  document.getElementById('follow-text').textContent = lineText;
  const b = document.getElementById('b-f');
  if (b) { b.textContent = 'Följer'; b.classList.add('on'); }

  // Dölj globala hållplatser
  map.removeLayer(stopL);
  document.getElementById('chk-stops').checked = false;

  // 1. Dölj alla andra fordon
  for (const [vid, m] of vm) {
    if (vid !== id) map.removeLayer(m);
  }

  // 2. Visa det följda fordonet
  ensureVehicleVisible(id);

  // 3. Rita rutt + zooma
  if (trip) {
    drawRoute(v, trip);
    ensureVehicleVisible(id); // Igen efter drawRoute

    const bounds = L.latLngBounds();
    if (trip.shape?.length) trip.shape.forEach(p => bounds.extend(p));
    else trip.stops.filter(s => s.lat && s.lng).forEach(s => bounds.extend([s.lat, s.lng]));
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14, duration: 0.6 });

    // Uppdatera rutt-knapp
    const br = document.getElementById('b-r');
    if (br) br.textContent = 'Dölj rutt';
  }
}

function stopFollow() {
  const wasFollowing = followId;
  followId = null;

  // UI
  document.getElementById('follow').classList.add('hidden');
  const b = document.getElementById('b-f');
  if (b) { b.textContent = 'Följ'; b.classList.remove('on'); }

  // Rensa rutt
  routeL.clearLayers();
  const br = document.getElementById('b-r');
  if (br) br.textContent = 'Visa rutt';

  // Visa alla fordon
  for (const [id, m] of vm) {
    if (!map.hasLayer(m)) map.addLayer(m);
    const v = vd.get(id);
    if (v) m.setIcon(mkIcon(v));
  }
}

function refreshIcons() {
  for (const [id, m] of vm) {
    const v = vd.get(id);
    if (!v) continue;
    m.setIcon(mkIcon(v));

    if (followId) {
      // I follow-läge: bara visa det följda
      if (id === followId) ensureVehicleVisible(id);
      else map.removeLayer(m);
    }
  }
}

document.getElementById('follow-end').onclick = stopFollow;
// Dra i kartan pausar bara panTo, avbryter INTE follow
map.on('dragstart', () => { if (followId) map._followPaused = true; });
// Återuppta efter 5 sekunder
map.on('dragend', () => { if (followId) setTimeout(() => { map._followPaused = false; }, 5000); });

// ── Route ──────────────────────────────────────────────────────────
function drawRoute(v, trip) {
  routeL.clearLayers();
  const { c } = vc(v.vehicleType);
  if (trip.shape?.length > 1) L.polyline(trip.shape, { color: c, weight: 3, opacity: 0.45 }).addTo(routeL);
  const ni = nextStop(trip.stops);
  trip.stops.forEach((s, i) => {
    if (!s.lat || !s.lng) return;
    const isN = i === ni, isP = ni >= 0 && i < ni;
    const sz = isN ? 8 : 5;
    const bg = isN ? c : isP ? '#1e1e2e' : 'rgba(10,10,15,0.7)';
    const bc = isN ? '#fff' : isP ? '#333' : c;
    L.marker([s.lat, s.lng], {
      icon: L.divIcon({ className:'', html:`<div class="rs ${isN?'next':''}" style="width:${sz}px;height:${sz}px;background:${bg};border-color:${bc}"></div>`, iconSize:[sz,sz], iconAnchor:[sz/2,sz/2] }),
      zIndexOffset: isN ? 1000 : 0
    }).bindTooltip(`<b>${s.name}</b><br>${(s.departure||s.arrival||'').substring(0,5)}`, { direction:'top', offset:[0,-3] }).addTo(routeL);
  });
}

function renderStops(v, trip, el) {
  const { c } = vc(v.vehicleType);
  const ni = nextStop(trip.stops);
  let h = '<div class="sl">Hållplatser</div>';
  trip.stops.forEach((s, i) => {
    const isN = i === ni, isP = ni >= 0 && i < ni;
    h += `<div class="sr ${isN?'n':isP?'p':''}">
      <span class="sr-t">${(s.departure||s.arrival||'').substring(0,5)}</span>
      <span class="sr-d" style="background:${isN?c:isP?'#333':c}"></span>
      <span class="sr-n">${esc(s.name)}</span>
      ${isN ? '<span class="sr-b">Nästa</span>' : ''}</div>`;
  });
  el.innerHTML = h;
  setTimeout(() => { const x = el.querySelector('.sr.n'); if (x) x.scrollIntoView({ behavior:'smooth', block:'center' }); }, 100);
}

function nextStop(stops) {
  const now = new Date(), nm = now.getHours()*60+now.getMinutes();
  for (let i = 0; i < stops.length; i++) {
    const t = stops[i].departure || stops[i].arrival;
    if (!t) continue;
    const [h, m] = t.split(':').map(Number);
    if (h*60+m >= nm) return i;
  }
  return -1;
}

// ── Alerts ─────────────────────────────────────────────────────────
let alerts = [];
async function updateAlerts() {
  try {
    alerts = (await (await fetch('/api/alerts')).json()).alerts || [];
    const c = document.getElementById('al-count');
    if (c) c.textContent = alerts.length ? `(${alerts.length})` : '';
  } catch {}
}

// alerts count uppdateras i updateAlerts

function showAlerts() {
  if (!alerts.length) { openCard('<div class="al-h">Störningar</div><p class="empty">Inga aktiva störningar</p>'); return; }
  openCard('<div class="al-h">Störningar <span class="al-count">' + alerts.length + '</span></div>' +
    alerts.map(a => {
      const short = a.description.length > 100;
      return `<details class="al ${a.effect>=3?'sev':''}">
        <summary class="al-t">${esc(a.header)}</summary>
        <div class="al-d">${esc(a.description)}</div>
      </details>`;
    }).join(''));
}

// ── Departures ─────────────────────────────────────────────────────
async function showDep(stop) {
  openCard(`<div class="dep-h">${esc(stop.name)}</div><div class="spinner"></div>`);
  try {
    const sr = await (await fetch(`/api/resrobot/stops?q=${encodeURIComponent(stop.name)}`)).json();
    const rs = sr.stopLocationOrCoordLocation?.[0]?.StopLocation;
    if (!rs) { openCard(`<div class="dep-h">${esc(stop.name)}</div><p class="empty">Hittades inte</p>`); return; }
    const data = await (await fetch(`/api/resrobot/departures?id=${rs.extId}`)).json();
    const deps = data.Departure || [];
    let h = `<div class="dep-h">${esc(stop.name)}</div><div class="dep-sub">Nästa avgångar</div>`;
    if (!deps.length) h += '<p class="empty">Inga avgångar just nu</p>';
    else h += deps.slice(0,6).map(d => {
      const p = d.ProductAtStop || d.Product?.[0] || {};
      const cat = (p.catOutL||'').toLowerCase();
      const col = cat.includes('tåg') ? '#4ade80' : cat.includes('spårv') ? '#22d3ee' : '#2dd4bf';
      const time = (d.time||'').substring(0,5);
      const rt = d.rtTime ? d.rtTime.substring(0,5) : null;
      return `<div class="dr"><span class="dr-l" style="background:${col}">${p.displayNumber||'?'}</span><span class="dr-d">${d.direction||'—'}</span><span class="dr-t">${time}${rt&&rt!==time?`<span class="dr-late"> ${rt}</span>`:''}</span></div>`;
    }).join('');
    openCard(h);
  } catch { openCard(`<div class="dep-h">${esc(stop.name)}</div><p class="empty">Fel</p>`); }
}

map.on('click', async e => {
  if (followId) return; // Ignorera kartklick i följ-läge
  try {
    const d = await (await fetch(`/api/stops/nearest?lat=${e.latlng.lat}&lng=${e.latlng.lng}`)).json();
    if (d.stops?.[0]?.distance < 1.5) showDep(d.stops[0]);
  } catch {}
});

// ── Trip ───────────────────────────────────────────────────────────
const PROD = { all:'', train:'31', bus:'288' };

// Trip-bar bindings (elementen finns i HTML)
document.getElementById('tgo').onclick = doTrip;
document.getElementById('tt').onkeydown = e => { if (e.key === 'Enter') doTrip(); };
document.getElementById('ts').onclick = () => { const a=document.getElementById('tf'),b=document.getElementById('tt'); [a.value,b.value]=[b.value,a.value]; };

async function doTrip() {
  const from=document.getElementById('tf').value.trim(), to=document.getElementById('tt').value.trim();
  const filt=document.querySelector('input[name="pf"]:checked')?.value||'all';
  const el=document.getElementById('trip-results');
  if (!from||!to) { el.innerHTML='<p class="empty">Fyll i från och till</p>'; return; }
  el.innerHTML='<div class="spinner"></div>';
  try {
    const [fr,tr] = await Promise.all([
      fetch(`/api/resrobot/stops?q=${encodeURIComponent(from)}`).then(r=>r.json()),
      fetch(`/api/resrobot/stops?q=${encodeURIComponent(to)}`).then(r=>r.json())]);
    const fs=fr.stopLocationOrCoordLocation?.[0]?.StopLocation, ts=tr.stopLocationOrCoordLocation?.[0]?.StopLocation;
    if (!fs||!ts) { el.innerHTML='<p class="empty">Hittade inte hållplatserna</p>'; return; }
    let url=`/api/resrobot/trip?from=${fs.extId}&to=${ts.extId}`;
    if (PROD[filt]) url+=`&products=${PROD[filt]}`;
    const trips=(await fetch(url).then(r=>r.json())).Trip||[];
    if (!trips.length) { el.innerHTML='<p class="empty">Inga resor</p>'; return; }
    el.innerHTML=trips.slice(0,5).map(trip => {
      const legs=trip.LegList?.Leg||[]; if(!legs.length)return'';
      const dep=st(legs[0]?.Origin?.time), arr=st(legs[legs.length-1]?.Destination?.time);
      const dur=trip.duration?fmtDur(trip.duration):'', ch=legs.filter(l=>l.type!=='WALK').length-1;
      const badges=legs.filter(l=>l.type!=='WALK').map(l=>{const{emoji,color,displayName}=ld(l.Product?.[0]);return`<span class="tc-b" style="background:${color}">${emoji} ${displayName}</span>`;}).join('<span class="tc-s">›</span>');
      const det=legs.map(l=>{
        if(l.type==='WALK')return`<div class="tl w"><div class="tl-b"><div class="tl-d" style="border-color:var(--dim)"></div><div class="tl-l da"></div></div><div class="tl-i"><span class="tl-wt">🚶 ${l.dist||''}m</span></div></div>`;
        const{emoji,color,displayName}=ld(l.Product?.[0]);
        return`<div class="tl"><div class="tl-b"><div class="tl-d" style="border-color:${color}"></div><div class="tl-l" style="background:${color}"></div><div class="tl-d" style="border-color:${color}"></div></div><div class="tl-i"><div class="tl-s"><b>${st(l.Origin?.time)}</b>${esc(l.Origin?.name||'')}</div><div class="tl-m"><span class="tl-badge" style="background:${color}">${emoji} ${displayName}</span><span class="tl-dir">→ ${esc(l.direction||l.Destination?.name||'')}</span></div><div class="tl-s"><b>${st(l.Destination?.time)}</b>${esc(l.Destination?.name||'')}</div></div></div>`;
      }).join('');
      return`<div class="tc"><div class="tc-top"><div><span class="tc-t">${dep}</span><span class="tc-a"> → ${arr}</span></div><div><span class="tc-dur">${dur}</span><span class="tc-ch">${ch<=0?'Direkt':`${ch} byte`}</span></div></div><div class="tc-legs">${badges}</div><details class="tc-det"><summary>Detaljer</summary><div class="tc-det-in">${det}</div></details></div>`;
    }).join('');
  } catch(err) { el.innerHTML=`<p class="empty">${err.message}</p>`; }
}

function ld(p) {
  if (!p) return{emoji:'',color:'#2dd4bf',displayName:'?'};
  const cat=(p.catOutL||'').toLowerCase(), num=p.displayNumber||'', op=p.operator||'';
  let type='bus',color='#2dd4bf';
  if(cat.includes('tåg')||[1,2,4].includes(+p.catCode)){type='train';color='#4ade80';}
  else if(cat.includes('spårv')||+p.catCode===8){type='tram';color='#22d3ee';}
  const far=cat.includes('express')||cat.includes('fjärr')||(type==='bus'&&num.length>=4);
  return{emoji:'',color,displayName:far&&op?op.replace(/^Vy\s+/i,''):num};
}

// ── Stops ──────────────────────────────────────────────────────────
async function loadStops() {
  if (stopsOn) return; stopsOn = true;
  try {
    const d = await(await fetch('/api/stops')).json();
    d.stops.forEach(s => {
      L.marker([s.lat,s.lng], { icon: L.divIcon({className:'',html:'<div class="stop-dot"></div>',iconSize:[4,4],iconAnchor:[2,2]}) })
        .bindTooltip(s.name, {direction:'top',offset:[0,-2]})
        .on('click', () => showDep(s))
        .addTo(stopL);
    });
  } catch { stopsOn = false; }
}

// ── Toolbar actions ────────────────────────────────────────────────
// Region filter + zoom
const REGION_VIEW = {
  all:    { lat: 58.8, lng: 15.4, zoom: 9 },
  otraf:  { lat: 58.42, lng: 15.65, zoom: 11 },
  orebro: { lat: 59.27, lng: 15.21, zoom: 11 },
};

document.getElementById('region-select').onchange = function() {
  regionFilter = this.value;
  for (const [id, m] of vm) {
    const v = vd.get(id);
    if (v && regionFilter !== 'all' && v.operator !== regionFilter) {
      map.removeLayer(m); vm.delete(id);
    }
  }
  const rv = REGION_VIEW[regionFilter] || REGION_VIEW.all;
  map.flyTo([rv.lat, rv.lng], rv.zoom, { duration: 0.8 });
  updateVehicles();
};

// Hållplatser toggle
document.getElementById('chk-stops').onchange = function() {
  if (this.checked) { loadStops(); map.addLayer(stopL); }
  else map.removeLayer(stopL);
};

// Visa/dölj inaktiva fordon
let showInactive = true;
document.getElementById('chk-inactive').onchange = function() {
  showInactive = this.checked;
  for (const [id, m] of vm) {
    const v = vd.get(id);
    if (!v) continue;
    if (!v.line && !showInactive) {
      map.removeLayer(m);
    } else if (!(followId && id !== followId)) {
      if (!map.hasLayer(m)) map.addLayer(m);
      m.setIcon(mkIcon(v));
    }
  }
};

// Sök resa knapp — toggle trip-bar
document.getElementById('btn-trip').onclick = () => {
  const tb = document.getElementById('trip-bar');
  tb.classList.toggle('hidden');
  if (!tb.classList.contains('hidden')) {
    document.getElementById('search-bar').classList.add('hidden');
    document.getElementById('tf').focus();
  }
};

// ── Toolbar buttons ────────────────────────────────────────────────
document.getElementById('btn-search').onclick = () => {
  const sb = document.getElementById('search-bar');
  sb.classList.toggle('hidden');
  if (!sb.classList.contains('hidden')) document.getElementById('search').focus();
};

document.getElementById('btn-locate').onclick = () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    p => map.flyTo([p.coords.latitude, p.coords.longitude], 15),
    err => { if (err.code === 1) alert('Tillåt platstjänster i inställningarna'); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

let lightOn = false;
document.getElementById('btn-theme').onclick = function() {
  lightOn = !lightOn;
  document.body.classList.toggle('light', lightOn);
  document.getElementById('theme-icon').innerHTML = lightOn
    ? '<path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" fill="none" stroke="currentColor" stroke-width="2.5"/>'
    : '<circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" fill="none" stroke="currentColor" stroke-width="2.5"/>';
  this.title = lightOn ? 'Byt till mörkt tema' : 'Byt till ljust tema';
  map.eachLayer(l => { if (l instanceof L.TileLayer) map.removeLayer(l); });
  L.tileLayer(lightOn
    ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; OSM &copy; CARTO | Trafiklab', maxZoom: 18 }
  ).addTo(map);
};

// ── Search ─────────────────────────────────────────────────────────
const searchIn = document.getElementById('search');
const searchList = document.getElementById('search-list');
let sTO;
searchIn.oninput = () => {
  clearTimeout(sTO);
  const q = searchIn.value.trim();
  if (q.length<2) { searchList.classList.add('hidden'); return; }
  sTO = setTimeout(async () => {
    try {
      const d = await(await fetch(`/api/resrobot/stops?q=${encodeURIComponent(q)}`)).json();
      const s = d.stopLocationOrCoordLocation||[];
      if(!s.length){searchList.classList.add('hidden');return;}
      searchList.innerHTML = s.slice(0,5).map(x=>{const sl=x.StopLocation;return sl?`<div class="s-item" data-lat="${sl.lat}" data-lng="${sl.lon}" data-name="${esc(sl.name)}">${esc(sl.name)}</div>`:''}).join('');
      searchList.classList.remove('hidden');
    } catch { searchList.classList.add('hidden'); }
  }, 300);
};
searchList.onclick = e => {
  const it = e.target.closest('.s-item'); if(!it)return;
  map.flyTo([+it.dataset.lat,+it.dataset.lng],15);
  searchIn.value = it.dataset.name;
  searchList.classList.add('hidden');
  document.getElementById('search-bar').classList.add('hidden');
  showDep({name:it.dataset.name,lat:+it.dataset.lat,lng:+it.dataset.lng});
};
searchIn.onblur = () => setTimeout(()=>searchList.classList.add('hidden'),200);

// ── Helpers ────────────────────────────────────────────────────────
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function st(t){return t?t.substring(0,5):'';}
function fmtDur(d){const m=d.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);return m?`${m[1]?m[1]+'h ':''}${m[2]?m[2]+'min':''}`.trim():d;}
function fmtTs(ts){return ts?new Date(ts*1000).toLocaleTimeString('sv-SE',{hour:'2-digit',minute:'2-digit'}):'—';}

// ── Mobil navbar ───────────────────────────────────────────────────
function closeMobPanels() {
  document.getElementById('mob-filter').classList.add('hidden');
  document.getElementById('mob-more').classList.add('hidden');
  document.getElementById('trip-bar').classList.add('hidden');
  document.getElementById('search-bar').classList.add('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
}

document.getElementById('nav-trip')?.addEventListener('click', function() {
  const open = !document.getElementById('trip-bar').classList.contains('hidden');
  closeMobPanels();
  if (!open) {
    document.getElementById('trip-bar').classList.remove('hidden');
    this.classList.add('active');
    document.getElementById('tf').focus();
  }
});

document.getElementById('nav-search')?.addEventListener('click', function() {
  const open = !document.getElementById('search-bar').classList.contains('hidden');
  closeMobPanels();
  if (!open) {
    document.getElementById('search-bar').classList.remove('hidden');
    this.classList.add('active');
    document.getElementById('search').focus();
  }
});

document.getElementById('nav-filter')?.addEventListener('click', function() {
  const open = !document.getElementById('mob-filter').classList.contains('hidden');
  closeMobPanels();
  if (!open) {
    document.getElementById('mob-filter').classList.remove('hidden');
    this.classList.add('active');
  }
});

document.getElementById('nav-locate')?.addEventListener('click', function() {
  closeMobPanels();
  if (!navigator.geolocation) { alert('Platstjänster stöds inte i denna webbläsare'); return; }
  this.classList.add('active');
  navigator.geolocation.getCurrentPosition(
    p => { map.flyTo([p.coords.latitude, p.coords.longitude], 15); this.classList.remove('active'); },
    err => { alert(err.code === 1 ? 'Tillåt platstjänster i inställningarna' : 'Kunde inte hämta position'); this.classList.remove('active'); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

document.getElementById('nav-more')?.addEventListener('click', function() {
  const open = !document.getElementById('mob-more').classList.contains('hidden');
  closeMobPanels();
  if (!open) {
    document.getElementById('mob-more').classList.remove('hidden');
    this.classList.add('active');
  }
});

// Mobil filter — synka med desktop-logik
document.querySelectorAll('.mf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    btn.classList.toggle('on');
    typeFilter[type] = btn.classList.contains('on');
    // Synka desktop-knappar
    document.querySelector(`.fbtn[data-type="${type}"]`)?.classList.toggle('on', typeFilter[type]);
    for (const [id, m] of vm) {
      const v = vd.get(id);
      if (v && !typeFilter[v.vehicleType]) { map.removeLayer(m); vm.delete(id); }
    }
    updateVehicles();
  });
});

document.getElementById('mob-region')?.addEventListener('change', function() {
  regionFilter = this.value;
  document.getElementById('region-select').value = this.value;
  for (const [id, m] of vm) {
    const v = vd.get(id);
    if (v && regionFilter !== 'all' && v.operator !== regionFilter) { map.removeLayer(m); vm.delete(id); }
  }
  const rv = REGION_VIEW[regionFilter] || REGION_VIEW.all;
  map.flyTo([rv.lat, rv.lng], rv.zoom, { duration: 0.8 });
  updateVehicles();
});

document.getElementById('mob-chk-stops')?.addEventListener('change', function() {
  document.getElementById('chk-stops').checked = this.checked;
  if (this.checked) { loadStops(); map.addLayer(stopL); }
  else map.removeLayer(stopL);
});

document.getElementById('mob-chk-inactive')?.addEventListener('change', function() {
  showInactive = this.checked;
  document.getElementById('chk-inactive').checked = this.checked;
  for (const [id, m] of vm) {
    const v = vd.get(id);
    if (!v) continue;
    if (!v.line && !showInactive) map.removeLayer(m);
    else if (!(followId && id !== followId)) { if (!map.hasLayer(m)) map.addLayer(m); m.setIcon(mkIcon(v)); }
  }
});

// Mer-meny knappar
document.getElementById('mm-theme')?.addEventListener('click', () => {
  closeMobPanels();
  document.getElementById('btn-theme').click();
});

document.getElementById('mm-alerts')?.addEventListener('click', () => {
  closeMobPanels();
  showAlerts();
});

function showAbout() {
  openCard(`
    <div class="about">
      <div class="about-title">Om Kollektivtrafik</div>
      <p class="about-text">En realtidskarta som visar alla bussar, tåg och spårvagnar i Östergötland och Örebro län. Fordonspositioner uppdateras var 5:e sekund med smooth interpolation för en flytande upplevelse.</p>
      <div class="about-section">
        <div class="about-label">Funktioner</div>
        <p class="about-text">Följ enskilda fordon i realtid, sök resor mellan hållplatser, se avgångar och trafikstörningar. Installera som app på din telefon för snabb åtkomst.</p>
      </div>
      <div class="about-section">
        <div class="about-label">Data</div>
        <p class="about-text">All trafikdata hämtas i realtid via Trafiklabs öppna API:er (GTFS Regional + ResRobot). Licensierad under CC BY 4.0.</p>
        <a href="https://trafiklab.se" target="_blank" rel="noopener" class="about-link">trafiklab.se</a>
      </div>
      <div class="about-section">
        <div class="about-label">Utvecklad av</div>
        <a href="https://papai.se" target="_blank" rel="noopener" class="about-dev">
          <span>Papai.se</span>
        </a>
      </div>
      <div class="about-footer">Version 1.0 — Byggd med Node.js och Leaflet.js</div>
    </div>
  `);
}

document.getElementById('mm-info')?.addEventListener('click', () => {
  closeMobPanels();
  showAbout();
});

// ── Init ───────────────────────────────────────────────────────────
updateVehicles(); updateAlerts();
setInterval(updateVehicles, 5000);
setInterval(updateAlerts, 60000);
