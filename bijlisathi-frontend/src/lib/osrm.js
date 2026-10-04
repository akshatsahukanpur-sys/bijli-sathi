// Road routing powered by the Leaflet Routing Machine OSRM router, driven
// directly — WITHOUT rendering LRM's own control/DOM itinerary. The OSRM road
// polyline is drawn by our own Leaflet layers so it looks like Google Maps'
// route line, without the plugin's on-screen navigation bar or load-order crash
// (window.L is guaranteed first and the bundle is loaded as a classic script).
import * as L from 'leaflet';

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';
const SCRIPT_ID = 'leaflet-routing-script';

let lrmPromise = null;

// Load the browserify UMD bundle as a real <script> AFTER window.L is set.
// The bundle reads window['L'] at eval time and attaches window.L.Routing.
function ensureLrm() {
  if (lrmPromise) return lrmPromise;
  if (typeof window !== 'undefined') window.L = L;
  lrmPromise = new Promise((resolve) => {
    if (typeof window === 'undefined') { resolve(false); return; }
    if (window.L && window.L.Routing && window.L.Routing.osrmv1) { resolve(true); return; }
    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener('load', () => resolve(!!window.L?.Routing?.osrmv1));
      existing.addEventListener('error', () => resolve(false));
      return;
    }
    const s = document.createElement('script');
    s.id = SCRIPT_ID;
    s.src = new URL('leaflet-routing-machine/dist/leaflet-routing-machine.js', import.meta.url).href;
    s.async = true;
    s.onload = () => resolve(!!window.L?.Routing?.osrmv1);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return lrmPromise;
}

function normalizeRoute(r0) {
  const coords = (r0.coordinates || []).map((c) => [Number(c.lat ?? c[0]), Number(c.lng ?? c[1])]);
  return {
    distanceM: Math.round(r0.summary?.totalDistance || 0),
    durationS: Math.round(r0.summary?.totalTime || 0),
    coordinates: coords,
    instructions: (r0.instructions || []).map((i) => ({
      text: i.text || '',
      modifier: i.modifier || '',
      type: i.type,
      distanceM: Math.round(i.distance || 0),
      timeS: Math.round(i.time || 0),
    })),
  };
}

// Session cache + in-flight dedupe so the public OSRM endpoint isn't hammered
// when the same tech→fault pair is re-rendered every 10s.
const routeCache = new Map(); // key -> { coordinates, distanceM, durationS }
const inflight = new Map(); // key -> Promise

export function roadKey(from, to) {
  const r = (v) => Number(v).toFixed(4);
  return `${r(from[0])},${r(from[1])}|${r(to[0])},${r(to[1])}`;
}

export function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function getCachedRoad(key) {
  return routeCache.get(key) || null;
}

export function fetchRoadRoute(from, to, key = roadKey(from, to)) {
  const cached = routeCache.get(key);
  if (cached) return cached ? Promise.resolve(cached) : null;
  if (inflight.has(key)) return inflight.get(key);
  const p = ensureLrm().then(() => {
    const L2 = (typeof window !== 'undefined' && window.L) ? window.L : L;
    if (!L2.Routing || !L2.Routing.osrmv1) throw new Error('LRM not loaded');
    return new Promise((resolve, reject) => {
      try {
        L2.Routing.osrmv1({ serviceUrl: OSRM_URL, profile: 'driving' })
          .route([L2.latLng(from[0], from[1]), L2.latLng(to[0], to[1])], (err, routes) => {
            if (err || !routes || !routes.length) return reject(new Error('No route'));
            resolve(normalizeRoute(routes[0]));
          });
      } catch (e) {
        reject(e);
      }
    });
  }).then((r) => {
    routeCache.set(key, r);
    inflight.delete(key);
    return r;
  }).catch((e) => {
    inflight.delete(key);
    throw e;
  });
  inflight.set(key, p);
  return p;
}

export function resetRoadCache() {
  routeCache.clear();
  inflight.clear();
}