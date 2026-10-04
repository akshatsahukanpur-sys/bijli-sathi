import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Icon } from './ui';
import { fetchRoadRoute, getCachedRoad, roadKey } from '../lib/osrm';

const WAVES_SVG_FOR_MAP = (color, px) => `
  <svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M2 12.5 H4.2 C4.9 12.5 5.2 8 6.4 8 C7.6 8 7.9 17 9.2 17 C10.5 17 10.6 8 12 8 C13.4 8 13.5 17 14.8 17 C16.1 17 16.3 8 17.6 8 C18.9 8 19.1 12.5 19.8 12.5 H22" />
  </svg>`;

export function pinIcon({ color = '#F2A93B', glyph = 'bolt', ping = false, size = 36 }) {
  const isWaves = glyph === 'waves';
  const iconInner = isWaves ? WAVES_SVG_FOR_MAP(color, Math.round(size * 0.55)) : glyph;
  const fontStyle = isWaves ? '' : `font-family:'Material Symbols Outlined';`;
  const ligatureStyle = isWaves ? '' : `overflow:hidden;max-width:1em;max-height:1em;width:1em;height:1em;display:inline-flex;align-items:center;justify-content:center;`;
  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative;width:${size}px;height:${size}px">
        ${ping ? `<span style="position:absolute;inset:-8px;border-radius:9999px;border:2px solid rgba(242,169,59,.55);animation:radar-expand 2s ease-out infinite"></span>
        <span style="position:absolute;inset:-8px;border-radius:9999px;border:2px solid rgba(242,169,59,.55);animation:radar-expand 2s ease-out infinite;animation-delay:1s"></span>` : ''}
        <div style="width:${size}px;height:${size}px;background:#fff;border:2px solid ${color};border-radius:9999px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(10,27,51,.25);${fontStyle}color:${color};font-size:${Math.round(size * 0.55)}px;line-height:1;overflow:hidden">${isWaves ? iconInner : `<span style="${ligatureStyle}font-size:${Math.round(size * 0.55)}px;line-height:1">${iconInner}</span>`}</div>
      </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

const STYLE_URLS = {
  map: 'https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
  satellite: 'https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
};
const STYLE_LABELS = [
  { key: 'map', label: 'Map' },
  { key: 'satellite', label: 'Satellite' },
];

export default function MapView({
  center,
  zoom = 17,
  markers = [],
  paths = [],
  draggableIndex = -1,
  onDragEnd,
  className = 'h-48',
  height,
  fitStrategy = 'always',
  dark = false,
  exact = false,
  showStyleSwitch = true,
  showLocate = true,
  showFullscreen = true,
  showTilt = true,
  focus = null,
  connector = null,
}) {
  const containerClass = height || className;
  const elRef = useRef(null);
  const wrapRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const accuracyRef = useRef(null);
  const markerRefs = useRef([]);
  const pathRefs = useRef([]);
  const roadRefs = useRef(new Map()); // key -> [line, casing]
  const roadStateRef = useRef(new Map()); // key -> { status }
  const didFitRef = useRef(false);
  const onDragRef = useRef(onDragEnd);
  onDragRef.current = onDragEnd;
  const [styleKey, setStyleKey] = useState('map');
  const [locating, setLocating] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [tilted, setTilted] = useState(false);
  const orbitRef = useRef(null);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const initCenter = center || (markers[0] ? (Array.isArray(markers[0]) ? markers[0] : [markers[0].lat, markers[0].lng]) : [26.4499, 80.3319]);
    const map = L.map(elRef.current, {
      center: initCenter,
      zoom,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      touchZoom: true,
      boxZoom: true,
      keyboard: true,
      worldCopyJump: true,
      zoomSnap: 1,
    });
    const tileOpts = { maxZoom: 20, subdomains: ['mt0', 'mt1', 'mt2', 'mt3'], attribution: '', errorTileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' };
    const baseLayer = L.tileLayer(STYLE_URLS.map, tileOpts).addTo(map);
    layerRef.current = baseLayer;
    baseLayer.on('tileerror', () => {
      try {
        if (!map._osmFallbackAdded) {
          L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            subdomains: ['a', 'b', 'c'],
            attribution: '',
          }).addTo(map);
          map._osmFallbackAdded = true;
        }
      } catch (e) {}
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);
    mapRef.current = map;
    setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 120);
    const onFs = () => {
      try { setIsFull(!!document.fullscreenElement); } catch {}
      setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 150);
    };
    try { document.addEventListener('fullscreenchange', onFs); } catch {}
    return () => {
      try { document.removeEventListener('fullscreenchange', onFs); } catch {}
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      if (connectorRef.current) {
        connectorRef.current.forEach((l) => { try { map.removeLayer(l); } catch {} });
        connectorRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try { layerRef.current?.setUrl(STYLE_URLS[styleKey] || STYLE_URLS.map); } catch {}
  }, [styleKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    while (markerRefs.current.length > markers.length) {
      markerRefs.current.pop()?.remove();
    }
    markers.forEach((m, i) => {
      const pos = Array.isArray(m) ? m : [m.lat, m.lng];
      if (pos[0] == null || pos[1] == null || Number.isNaN(pos[0]) || Number.isNaN(pos[1])) return;
      if (!markerRefs.current[i]) {
        const raw = Array.isArray(m) ? {} : m;
        const icon = raw.icon || (raw.iconConfig ? pinIcon(raw.iconConfig) : pinIcon({}));
        const mk = L.marker(pos, { icon, draggable: i === draggableIndex }).addTo(map);
        if (i === draggableIndex) {
          mk.on('dragend', () => {
            const p = mk.getLatLng();
            onDragRef.current?.([p.lat, p.lng]);
          });
        }
        markerRefs.current[i] = mk;
      } else {
        const raw2 = Array.isArray(m) ? {} : m;
        const icon2 = raw2.icon || (raw2.iconConfig ? pinIcon(raw2.iconConfig) : pinIcon({}));
        markerRefs.current[i].setLatLng(pos);
        markerRefs.current[i].setIcon(icon2);
      }
      const label = (Array.isArray(m) ? null : m.label);
      if (label) {
        markerRefs.current[i].bindPopup(`<span style="font-family:IBM Plex Sans,sans-serif;font-size:12px;font-weight:600;color:#0A1B33">${label}</span>`, { maxWidth: 220 });
        if (i === draggableIndex && label && label.length > 8) {
          setTimeout(() => { try { markerRefs.current[i].openPopup(); } catch (e) {} }, 300);
        }
      }
    });
    const pts = markers.map((m) => (Array.isArray(m) ? m : [m.lat, m.lng])).filter(Boolean);
    if (pts.length > 1) {
      if (fitStrategy === 'once') {
        if (!didFitRef.current) { map.fitBounds(L.latLngBounds(pts).pad(0.35)); didFitRef.current = true; }
      } else {
        map.fitBounds(L.latLngBounds(pts).pad(0.35));
      }
    } else if (pts.length === 1 && (fitStrategy === 'always' || !didFitRef.current)) {
      map.setView(pts[0], map.getZoom() || zoom);
      didFitRef.current = true;
    }
  }, [markers, draggableIndex]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Clear previous road-route layers & straight paths
    pathRefs.current.forEach((p) => { try { p.remove(); } catch {} });
    pathRefs.current = [];
    roadRefs.current.forEach((layers) => { layers.forEach((l) => { try { map.removeLayer(l); } catch {} }); });
    roadRefs.current = new Map();
    const roadPresent = new Set();

    const wantRoad = (paths || []).filter((p) => p?.road);
    if (wantRoad.length) {
      // Roads already cached draw immediately; missing ones fetch async.
      wantRoad.forEach((p, idx) => {
        const { from, to } = p;
        if (!from || !to || from.some((v) => v == null) || to.some((v) => v == null)) return;
        const key = roadKey(from, to);
        // Selected route gets its own slot so it never collides with auto routes.
        const storeKey = p.highlight ? 'hl:' + key : key;
        roadPresent.add(storeKey);
        const opts = mkRoadOpts(p);
        const cached = getCachedRoad(key);
        if (cached && cached.coordinates?.length) {
          drawRoadPolyline(map, storeKey, cached.coordinates, opts);
          return;
        }
        fetchRoadRoute(from, to, key).then((r) => {
          if (roadPresent.has(storeKey) && r.coordinates?.length) drawRoadPolyline(map, storeKey, r.coordinates, opts);
        }).catch(() => {
          // Road unavailable — for the highlighted route the DOM dotted connector
          // and its arrow already show; for others fall back to a dashed line.
          if (roadPresent.has(storeKey) && !p.highlight) {
            try {
              const fb = L.polyline([from, to], {
                color: opts.core, weight: opts.fallbackWeight, opacity: 0.95,
                dashArray: '6 8',
              }).addTo(map);
              if (fb.setZIndexOffset) fb.setZIndexOffset(opts.z);
              const prev = roadRefs.current.get(storeKey) || [];
              roadRefs.current.set(storeKey, [...prev, fb]);
            } catch (e) {}
          }
        });
      });
    }

    // Plain straight dashed paths (non-road).
    (paths || []).forEach((p) => {
      if (p?.road) return;
      if (!p?.from || !p?.to || p.from.some((v) => v == null) || p.to.some((v) => v == null)) return;
      const line = L.polyline([p.from, p.to], {
        color: p.color || '#F2A93B',
        weight: 3.5,
        opacity: 0.9,
        dashArray: p.solid ? null : '6 8',
      }).addTo(map);
      pathRefs.current.push(line);
    });

    // Drop cached layers whose key is no longer requested.
    roadRefs.current.forEach((layers, key) => {
      if (!roadPresent.has(key)) {
        layers.forEach((l) => { try { map.removeLayer(l); } catch {} });
        roadRefs.current.delete(key);
      }
    });
  }, [paths]);

  function mkRoadOpts(p) {
    if (p?.highlight) return {
      casing: '#ffffff', casingWeight: 15, casingOpacity: 0.85, // white halo so the dark path pops
      core: '#1a4fd6', weight: 10, inner: '#6fa3ff', z: 1000, fallbackWeight: 10,
    };
    return {
      casing: '#ffffff', casingWeight: 6, casingOpacity: 0.55,   // dim so the highlight pops
      core: p?.color || '#F2A93B', weight: 3.5, z: 300, fallbackWeight: 3,
    };
  }

  // DEDICATED connector renderer — a tiny, isolated effect with its own layer ref.
  // Draws the tech→fault link as DOM DOT MARKERS (not canvas polylines), because
  // markers are guaranteed to render on every device/browser. Produces a clearly
  // visible dotted green line + a direction arrow toward the fault.
  const connectorRef = useRef(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (connectorRef.current) {
      connectorRef.current.forEach((l) => { try { map.removeLayer(l); } catch {} });
      connectorRef.current = null;
    }
    const c = connector;
    if (!c || !c.from || !c.to || c.from.some((v) => v == null) || c.to.some((v) => v == null)) return;
    const layers = [];
    try {
      const color = c.color || '#15803d';
      const N = 12; // number of segments → dots along the straight link
      for (let i = 1; i < N; i++) {
        const t = i / N;
        const dot = L.marker(
          [c.from[0] + (c.to[0] - c.from[0]) * t, c.from[1] + (c.to[1] - c.from[1]) * t],
          {
            interactive: false, keyboard: false,
            icon: L.divIcon({
              className: 'connector-dot-icon',
              html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #ffffff;box-shadow:0 1px 3px rgba(0,0,0,0.35)"></div>`,
              iconSize: [14, 14],
              iconAnchor: [7, 7],
            }),
          },
        ).addTo(map);
        if (dot.setZIndexOffset) dot.setZIndexOffset(1200);
        layers.push(dot);
      }
      const brg = bearingDeg(c.from[0], c.from[1], c.to[0], c.to[1]);
      const mid = [(c.from[0] + c.to[0]) / 2, (c.from[1] + c.to[1]) / 2];
      const mk = L.marker(mid, {
        interactive: false, keyboard: false,
        icon: L.divIcon({
          className: 'connector-arrow-icon',
          html: `<div style="width:36px;height:36px;transform:rotate(${brg}deg);display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45))"><svg viewBox="0 0 24 24" width="34" height="34"><path d="M12 2 L21 21 L12 16.5 L3 21 Z" fill="#15803d" stroke="#ffffff" stroke-width="1.6"/></svg></div>`,
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        }),
      }).addTo(map);
      if (mk.setZIndexOffset) mk.setZIndexOffset(1201);
      layers.push(mk);
      connectorRef.current = layers;
    } catch (e) {
      connectorRef.current = null;
    }
  }, [connector]);

  // Bold dotted tech→fault connector — currently handled by the plain (non-road)
// path loop so it ALWAYS renders without any network dependency.

function drawRoadPolyline(map, storeKey, coords, opts) {
    try {
      // Replace any existing layer set (e.g. the instant straight preview) for this slot.
      const old = roadRefs.current.get(storeKey);
      if (old) old.forEach((l) => { try { map.removeLayer(l); } catch {} });
      const layers = [];
      const casing = L.polyline(coords, { color: opts.casing, weight: opts.casingWeight, opacity: opts.casingOpacity }).addTo(map);
      casing.setZIndexOffset && casing.setZIndexOffset(opts.z);
      layers.push(casing);
      const core = L.polyline(coords, { color: opts.core, weight: opts.weight, opacity: 1 }).addTo(map);
      core.setZIndexOffset && core.setZIndexOffset(opts.z + 1);
      layers.push(core);
      if (opts.inner) {
        const inner = L.polyline(coords, { color: opts.inner, weight: 3.5, opacity: 0.9 }).addTo(map);
        inner.setZIndexOffset && inner.setZIndexOffset(opts.z + 2);
        layers.push(inner);
        // Directional arrowheads along the highlighted route — point at the fault.
        addDirectionArrows(map, storeKey, coords, opts).forEach((m) => layers.push(m));
      }
      roadRefs.current.set(storeKey, layers);
    } catch (e) {
      // corrupt coords — ignore so the map never crashes
    }
  }

  // Place rotated chevron arrows every few segments so the officer sees which
  // way the route heads (Google-Maps style navigation hint), always toward the fault.
  function addDirectionArrows(map, storeKey, coords, opts) {
    const out = [];
    try {
      const step = Math.max(6, Math.round(coords.length / 12));
      const last = coords.length - 1;
      for (let i = step; i < last; i += step) {
        const a = coords[i - 1];
        const b = coords[i];
        if (!a || !b) continue;
        const brg = bearingDeg(a[0] ?? a.lat, a[1] ?? a.lng, b[0] ?? b.lat, b[1] ?? b.lng);
        const m = L.marker([b[0] ?? b.lat, b[1] ?? b.lng], {
          interactive: false, keyboard: false, pane: 'overlayPane',
          icon: L.divIcon({
            className: 'route-arrow-icon',
            html: `<div style="width:22px;height:22px;transform:rotate(${brg}deg);display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5))"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2 L21 21 L12 16.5 L3 21 Z" fill="#1a4fd6" stroke="#ffffff" stroke-width="1.4"/></svg></div>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
        }).addTo(map);
        if (m.setZIndexOffset) m.setZIndexOffset(opts.z + 3);
        out.push(m);
      }
      // Final arrow seated right before the fault point so the destination is obvious.
      if (coords.length > 4) {
        const a = coords[coords.length - 4];
        const b = coords[coords.length - 2 > last ? last : coords.length - 2];
        if (a && b) {
          const brg = bearingDeg(a[0] ?? a.lat, a[1] ?? a.lng, b[0] ?? b.lat, b[1] ?? b.lng);
          const m = L.marker([b[0] ?? b.lat, b[1] ?? b.lng], {
            interactive: false, keyboard: false,
            icon: L.divIcon({
              className: 'route-arrow-icon',
              html: `<div style="width:26px;height:26px;transform:rotate(${brg}deg);display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5))"><svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 2 L21 21 L12 16.5 L3 21 Z" fill="#1a4fd6" stroke="#ffffff" stroke-width="1.4"/></svg></div>`,
              iconSize: [26, 26],
              iconAnchor: [13, 13],
            }),
          }).addTo(map);
          if (m.setZIndexOffset) m.setZIndexOffset(opts.z + 4);
          out.push(m);
        }
      } else if (coords.length >= 2) {
        // Short/straight fallback route — one arrow at the midpoint aimed at the fault.
        const a = coords[0];
        const b = coords[coords.length - 1];
        const ax = a[0] ?? a.lat, ay = a[1] ?? a.lng;
        const bx = b[0] ?? b.lat, by = b[1] ?? b.lng;
        const mid = [(ax + bx) / 2, (ay + by) / 2];
        const brg = bearingDeg(ax, ay, bx, by);
        const m = L.marker(mid, {
          interactive: false, keyboard: false,
          icon: L.divIcon({
            className: 'route-arrow-icon',
            html: `<div style="width:32px;height:32px;transform:rotate(${brg}deg);display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5))"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M12 2 L21 21 L12 16.5 L3 21 Z" fill="#1a4fd6" stroke="#ffffff" stroke-width="1.4"/></svg></div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          }),
        }).addTo(map);
        if (m.setZIndexOffset) m.setZIndexOffset(opts.z + 4);
        out.push(m);
      }
    } catch (e) {}
    return out;
  }

  function bearingDeg(lat1, lng1, lat2, lng2) {
    try {
      const dLng = ((lng2 - lng1) * Math.PI) / 180;
      const la1 = (lat1 * Math.PI) / 180;
      const la2 = (lat2 * Math.PI) / 180;
      const y = Math.sin(dLng) * Math.cos(la2);
      const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
      return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    } catch (e) { return 0; }
  }

  const focusKey = focus?.key;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus || focusKey == null || !Array.isArray(focus.points)) return;
    try {
      const pts = focus.points.filter((p) => p && p[0] != null && p[1] != null && !Number.isNaN(p[0]) && !Number.isNaN(p[1]));
      if (!pts.length) return;
      if (pts.length === 1) map.flyTo(pts[0], Math.max(map.getZoom(), 16), { duration: 0.8 });
      else map.flyToBounds(L.latLngBounds(pts).pad(0.3), { duration: 0.8 });
    } catch {}
  }, [focusKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center) return;
    if (markers.length <= 1) {
      const cur = map.getCenter();
      const dLat = Math.abs(cur.lat - center[0]);
      const dLng = Math.abs(cur.lng - center[1]);
      if (dLat > 0.00005 || dLng > 0.00005) {
        map.setView(center, Math.max(map.getZoom(), zoom));
        setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 80);
      }
    }
  }, [center, zoom, markers.length]);

  const locateMe = () => {
    const map = mapRef.current;
    if (!map || !navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const ll = [pos.coords.latitude, pos.coords.longitude];
        try {
          map.flyTo(ll, Math.max(map.getZoom(), 17), { duration: 0.9 });
          if (accuracyRef.current) { try { map.removeLayer(accuracyRef.current); } catch {} accuracyRef.current = null; }
          if (pos.coords.accuracy && pos.coords.accuracy < 2000) {
            accuracyRef.current = L.circle(ll, {
              radius: Math.min(pos.coords.accuracy, 500),
              color: '#F2A93B',
              weight: 1.5,
              opacity: 0.7,
              fillColor: '#F2A93B',
              fillOpacity: 0.12,
            }).addTo(map);
          }
          setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 100);
        } catch {}
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
    );
  };

  const toggleFullscreen = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    try {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (wrap.requestFullscreen) {
        wrap.requestFullscreen();
      }
    } catch {}
  };

  useEffect(() => {
    const wrap = wrapRef.current;
    const el = elRef.current;
    const map = mapRef.current;
    if (!wrap || !el) return;
    try {
      if (orbitRef.current) { clearInterval(orbitRef.current); orbitRef.current = null; }
      if (tilted) {
        wrap.style.perspective = '1100px';
        el.style.transition = 'transform 0.9s ease';
        el.style.transformOrigin = '50% 100%';
        el.style.transform = 'rotateX(46deg) scale(1.5)';
        if (map) {
          orbitRef.current = setInterval(() => {
            try { map.panBy([5, 0], { animate: false }); } catch {}
          }, 140);
        }
      } else {
        el.style.transform = '';
        el.style.transformOrigin = '';
        wrap.style.perspective = '';
      }
      setTimeout(() => { try { map?.invalidateSize(); } catch (e) {} }, 950);
    } catch {}
    return () => {
      try {
        if (orbitRef.current) { clearInterval(orbitRef.current); orbitRef.current = null; }
      } catch {}
    };
  }, [tilted]);

  return (
    <div ref={wrapRef} className={`rounded-lg overflow-hidden border border-haze relative z-0 ${containerClass} ${isFull ? '!rounded-none !border-0' : ''}`} style={isFull ? { height: '100dvh' } : undefined}>
      <div ref={elRef} style={{ width: '100%', height: '100%' }} />
      {showStyleSwitch && (
        <div className="absolute top-2.5 left-2.5 z-[500] flex rounded-full bg-white/95 backdrop-blur border border-haze shadow-card p-0.5">
          {STYLE_LABELS.map((s) => (
            <button
              key={s.key}
              onClick={() => setStyleKey(s.key)}
              className={`px-3 py-1.5 rounded-full text-[11px] font-extrabold transition-all ${styleKey === s.key ? 'bg-ink-navy text-white shadow-card' : 'text-wire-slate hover:text-ink-navy'}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <div className="absolute right-2.5 bottom-24 z-[500] flex flex-col gap-2">
        {showTilt && (
          <button
            onClick={() => setTilted((v) => !v)}
            aria-label="Tilt"
            className={`w-9 h-9 rounded-full backdrop-blur border shadow-card flex items-center justify-center active:scale-90 transition-all ${tilted ? 'bg-ink-navy text-circuit-amber border-ink-navy' : 'bg-white/95 border-haze text-ink-navy hover:text-circuit-amber'}`}
          >
            <Icon name="3d_rotation" className="text-[19px]" />
          </button>
)}
        {showFullscreen && (
          <button
            onClick={toggleFullscreen}
            title="Fullscreen"
            aria-label="Fullscreen"
            className="w-9 h-9 rounded-full bg-white/95 backdrop-blur border border-haze shadow-card flex items-center justify-center text-ink-navy hover:text-circuit-amber active:scale-90 transition-all"
          >
            <Icon name={isFull ? 'fullscreen_exit' : 'fullscreen'} className="text-[19px]" />
          </button>
        )}
      </div>
      <style>{`
        .leaflet-container { background: #f8f9fa; font-family: 'IBM Plex Sans', sans-serif; }
        .leaflet-control-attribution { display: none !important; }
        .leaflet-control-zoom { border: none !important; box-shadow: none !important; display: flex; flex-direction: column; gap: 6px; }
        .leaflet-control-zoom a { border-radius: 9999px !important; width: 36px !important; height: 36px !important; line-height: 36px !important; border: 1px solid rgba(10,27,51,0.08) !important; box-shadow: 0 2px 8px rgba(10,27,51,0.15); background: rgba(255,255,255,0.95) !important; color: #0A1B33 !important; }
        .leaflet-control-scale-line { border-radius: 4px; background: rgba(255,255,255,0.9); }
        .leaflet-popup-content-wrapper { border-radius: 12px; box-shadow: 0 8px 24px rgba(10,27,51,0.15); font-family: 'IBM Plex Sans', sans-serif; font-size: 12px; }
        .leaflet-popup-tip { background: white; }
        @keyframes radar-expand {
          0%   { transform: scale(.7); opacity: .8; }
          100% { transform: scale(2.1); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
