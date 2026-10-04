import { useEffect, useRef } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { pinIcon } from './Map';

// Mobile-only spinning globe — deferred + throttled to fix lag on slow 50KB/s devices (screenshot: 53.5KB/s)
export default function LeafletGlobe({ height = 'h-full', className = '' }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const rafRef = useRef(null);
  const pausedRef = useRef(false);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const prefersReduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let cancelled = false;
    let initTimer = null;
    let map = null;

    const init = () => {
      if (cancelled || !elRef.current || mapRef.current) return;
      map = L.map(elRef.current, {
        center: [26.4499, 80.3319],
        zoom: 3,
        zoomControl: false,
        attributionControl: false,
        dragging: true,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        worldCopyJump: true,
      });

      // Leaflet only — no API key — HOT OSM Google-like, high clarity (maxZoom 18 for street-level like Google Maps)
      const hotUrl = 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png';
      const hotLayer = L.tileLayer(hotUrl, {
        maxZoom: 18,
        minZoom: 2,
        subdomains: ['a','b','c'],
        noWrap: false,
      }).addTo(map);
      hotLayer.on('tileerror', () => {
        try {
          if (!map._hotFallbackAdded) {
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: ['a','b','c'] }).addTo(map);
            map._hotFallbackAdded = true;
          }
        } catch (e) {}
      });

      const m1 = L.marker([26.4499, 80.3319], {
        icon: pinIcon({ color: '#F2A93B', glyph: 'location_on', ping: true, size: 22 }),
      }).addTo(map);
      const m2 = L.marker([26.46, 80.33], {
        icon: pinIcon({ color: '#FF6B35', glyph: 'bolt', ping: true, size: 20 }),
      }).addTo(map);
      // Connect Leaflet markers + map to Google Maps for location — Leaflet only, no API key
      const openGmaps = (lat, lng) => {
        try { window.open(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`, '_blank', 'noopener'); } catch (e) {}
      };
      m1.on('click', () => openGmaps(26.4499, 80.3319));
      m2.on('click', () => openGmaps(26.46, 80.33));
      map.on('click', (e) => {
        if (e && e.latlng) openGmaps(e.latlng.lat.toFixed(5), e.latlng.lng.toFixed(5));
      });
      try { map.getContainer().style.cursor = 'pointer'; map.getContainer().title = 'Tap globe to open in Google Maps — Leaflet, no API'; } catch (e) {}

      // In the group: show the person's location from mobile phone on the globe — Leaflet, no API key
      let userMarker = null;
      let userWatchId = null;
      let spinLon = 80.3319;
      const showUserOnGlobe = (lat, lng) => {
        try {
          if (userMarker) { try { map.removeLayer(userMarker); } catch (e) {} }
          userMarker = L.marker([lat, lng], {
            icon: pinIcon({ color: '#4285F4', glyph: 'my_location', ping: true, size: 28 }),
          }).addTo(map);
          userMarker.on('click', () => openGmaps(lat, lng));
          userMarker.bindPopup(`<b style="font-family:system-ui">You are here</b><br><a href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" rel="noreferrer" style="color:#1a73e8;font-weight:700">Open in Google Maps</a>`);
          map.setView([lat, lng], 12, { animate: true });
          spinLon = lng;
        } catch (e) {}
      };
      // Try to get mobile phone location — no API key, Leaflet only
      if (typeof navigator !== 'undefined' && navigator.geolocation) {
        try {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const lat = pos.coords.latitude;
              const lng = pos.coords.longitude;
              if (typeof lat === 'number' && typeof lng === 'number') showUserOnGlobe(lat, lng);
            },
            () => {},
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
          );
          // Also watch for group live updates if user moves
          try {
            userWatchId = navigator.geolocation.watchPosition(
              (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                if (typeof lat === 'number' && typeof lng === 'number' && userMarker) {
                  try { userMarker.setLatLng([lat, lng]); } catch (e) {}
                }
              },
              () => {},
              { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
            );
            map._userWatchId = userWatchId;
          } catch (e) {}
        } catch (e) {}
      }

      mapRef.current = map;
      setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 100);

      const pause = () => { pausedRef.current = true; };
      const resume = () => { setTimeout(() => { pausedRef.current = false; }, 3500); };
      map.on('movestart', pause);
      map.on('zoomstart', pause);
      map.on('moveend', resume);
      if (elRef.current) {
        elRef.current.addEventListener('touchstart', pause, { passive: true });
      }

      // Throttled spin — reduced to 200ms + pause when hidden to prevent shaking on low-end
      if (!prefersReduced) {
        const spin = () => {
          if (document.hidden || pausedRef.current || !mapRef.current) {
            rafRef.current = setTimeout(spin, 300);
            return;
          }
          spinLon += 0.08;
          if (spinLon > 180) spinLon -= 360;
          try {
            mapRef.current.setView([20, spinLon], mapRef.current.getZoom(), { animate: false });
          } catch (e) {}
          rafRef.current = setTimeout(spin, 200);
        };
        rafRef.current = setTimeout(spin, 1200);
        // Pause spin when tab hidden to save GPU
        const onVis = () => { if (document.hidden) pausedRef.current = true; else setTimeout(() => { pausedRef.current = false; }, 800); };
        document.addEventListener('visibilitychange', onVis);
        // cleanup will remove listener
        const origCleanup = () => document.removeEventListener('visibilitychange', onVis);
        // store for cleanup
        map._spinCleanup = origCleanup;
      }
    };

    // Defer heavy Leaflet init 500ms after first paint so hero headline/CTA appear instantly on 50KB/s
    initTimer = setTimeout(init, 500);

    return () => {
      cancelled = true;
      try { clearTimeout(initTimer); } catch (e) {}
      try { clearTimeout(rafRef.current); } catch (e) {}
      try { if (userWatchId != null) navigator.geolocation.clearWatch(userWatchId); } catch (e) {}
      try { if (map && map._userWatchId != null) navigator.geolocation.clearWatch(map._userWatchId); } catch (e) {}
      try { if (map && map._spinCleanup) map._spinCleanup(); } catch (e) {}
      try { map?.off('movestart', () => {}); } catch (e) {}
      try { map?.remove(); } catch (e) {}
      mapRef.current = null;
    };
  }, []);

  return (
    <div className={`relative overflow-hidden bg-transparent flex items-center justify-center ${height} ${className}`}>
      <div className="relative w-full h-full rounded-full overflow-hidden shadow-[0_24px_60px_rgba(10,27,51,0.35),0_0_0_1px_rgba(255,255,255,1),inset_0_0_0_1px_rgba(10,27,51,0.08),inset_0_0_40px_rgba(255,255,255,0.7)] border-[1.5px] border-white/80 shrink-0 bg-[#E5E3DF]">
        <div ref={elRef} className="w-full h-full rounded-full overflow-hidden" style={{ background: '#E5E3DF' }} />
        <div className="absolute inset-0 rounded-full pointer-events-none" style={{ boxShadow: 'inset -24px -14px 32px rgba(0,0,0,.14), inset 10px 10px 20px rgba(255,255,255,1), inset 0 0 0 1px rgba(255,255,255,0.6)' }} />
      </div>
      <style>{`
        .leaflet-container { background: #E5E3DF; filter: contrast(1.05) saturate(1.1); }
        .leaflet-control-attribution { display:none !important; }
        .leaflet-tile { image-rendering: -webkit-optimize-contrast; }
      `}</style>
    </div>
  );
}
