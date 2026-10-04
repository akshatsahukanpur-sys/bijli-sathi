import React, { useEffect, useState } from 'react';
import { api, clearAuth, faultId } from '../lib/api';
import { Icon, EmptyState, Shell, CallSheet } from '../components/ui';
import { useLang } from '../lib/i18n.jsx';
import MapView, { pinIcon } from '../components/Map';
import { openGoogleMapsRoute } from '../lib/gmaps';
// Permanent fleet fix v3 — FleetErrorBoundary + safeTechs/safeFaults + show_chart clip

const VARIANT_GLYPH = {
  'transformer-fault': 'electric_bolt',
  'broken-wire': 'cable',
  'meter-fault': 'electric_meter',
  'no-power': 'power_off',
  'voltage-fluctuation': 'show_chart',
  'streetlight': 'lightbulb',
};

function faultColor(u) {
  return (u ?? 0) >= 6 ? '#D64545' : (u ?? 0) >= 3 ? '#F2A93B' : '#5A6B8C';
}

// Permanent guard — v4: never crash whole Fleet page, show safe fallback and log full stack
class FleetErrorBoundary extends React.Component {
  constructor(p){ super(p); this.state={hasError:false, msg:'', stack:''}; }
  static getDerivedStateFromError(e){ return {hasError:true, msg:String(e?.message||e), stack: String(e?.stack||'').slice(0,400)}; }
  componentDidCatch(e,info){ try{console.error('Fleet tracking crash:',e, e.stack, info);}catch{} }
  render(){
    if(this.state.hasError){
      return (
        <div className="bg-paper rounded-2xl p-8 text-center shadow-card border border-haze">
          <Icon name="error" className="text-fault-red text-3xl mb-2" />
          <p className="font-bold text-ink-navy">Fleet temporarily unavailable — tap Retry</p>
          <p className="text-xs text-wire-slate mt-1 max-w-md mx-auto break-words">{this.state.msg.slice(0,200)}</p>
          {this.state.stack && <pre className="text-[9px] text-wire-slate/70 mt-2 max-w-md mx-auto overflow-auto whitespace-pre-wrap break-words bg-surface-container p-2 rounded">{this.state.stack.slice(0,300)}</pre>}
          <div className="flex gap-2 justify-center mt-4">
            <button onClick={()=>{ this.setState({hasError:false,msg:'',stack:''}); }} className="bg-circuit-amber text-ink-navy font-bold px-5 py-2.5 rounded-xl active:scale-95">Try Again</button>
            <button onClick={()=>{ try{localStorage.removeItem('bs_auth'); sessionStorage.clear();}catch{}; try{window.location.hash='#/'; window.location.reload();}catch{} }} className="bg-paper border border-haze text-ink-navy font-bold px-5 py-2.5 rounded-xl active:scale-95">Clear & Go Home</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function KescoTracking({ go }) {
  const { t: rawT } = useLang();
  const t = typeof rawT === 'function' ? rawT : (k) => k;
  const STATUS_STYLE = {
    'on-task': { label: t('onSite'), dot: 'bg-circuit-amber pulse-dot', cls: 'bg-secondary-fixed/40 border-circuit-amber/30 text-circuit-amber', bar: 'border-l-circuit-amber' },
    available: { label: t('travelingIdle'), dot: 'bg-wire-slate', cls: 'bg-surface-container-low border-haze text-wire-slate', bar: 'border-l-wire-slate' },
    offline: { label: t('offline'), dot: 'bg-fault-red/60', cls: 'bg-surface-container-low border-haze text-wire-slate', bar: 'border-l-fault-red/50' },
  };
  const [techs, setTechs] = useState([]);
  const [faults, setFaults] = useState([]);
  const [areas, setAreas] = useState({});
  const [ov, setOv] = useState({});
  const [focus, setFocus] = useState(null);
  const [showRoad, setShowRoad] = useState(true);
  const [selRoute, setSelRoute] = useState(null); // highlighted tech→fault road route key
  const [routeInfo, setRouteInfo] = useState(null); // { text, arrow, distance, eta } for the chip
  const selRouteRef = React.useRef(null); // tracks the CURRENT selection for async fetches
  const mapBoxRef = React.useRef(null);
  const focusOn = (points) => {
    if (!points?.length) return;
    setFocus({ points, key: Date.now() });
    try { mapBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
  };
  const techLatLng = (tech) => {
    const tc = tech?.currentLocation?.coordinates;
    return tc && tc.length >= 2 ? [tc[1], tc[0]] : null;
  };
  const faultLatLng = (fault) => {
    const fc = fault?.location?.coordinates;
    return fc && fc.length >= 2 ? [fc[1], fc[0]] : null;
  };
  // Open real turn-by-turn driving guidance in the Google Maps app
  // (technician's live location → fault). No in-app route drawing.
  const navToFaultGmaps = (tech, fault) => {
    const tp = techLatLng(tech);
    const fp = faultLatLng(fault);
    if (!tp) { alert('Technician live GPS not available yet — ask the lineman to tap START GPS in his app, then try again.'); return; }
    if (!fp) return;
    openGoogleMapsRoute(tp, fp);
  };
  // Highlight the technician → fault road route on the in-app map (Google-Maps style).
  const keyOf = (tech, fault) => {
    const tp = techLatLng(tech);
    const fp = faultLatLng(fault);
    if (!tp || !fp) return null;
    return `${tp[0].toFixed(4)},${tp[1].toFixed(4)}|${fp[0].toFixed(4)},${fp[1].toFixed(4)}`;
  };
  const showTechRoadRoute = (tech, fault) => {
    const tp = techLatLng(tech);
    const fp = faultLatLng(fault);
    if (!tp) { alert('Technician live GPS not available yet — ask the lineman to tap START GPS in his app, then try again.'); return; }
    if (!fp) return;
    const k = keyOf(tech, fault);
    if (selRoute && selRoute === k) { setSelRoute(null); setRouteInfo(null); selRouteRef.current = null; setShowRoad(true); return; }
    setShowRoad(true);
    selectRoute(k, tp, fp);
  };
  const selectRoute = (k, tp, fp) => {
    setSelRoute(k);
    selRouteRef.current = k;
    setRouteInfo(null);
    focusOn([tp, fp]);
    fetchRoadRoute(tp, fp, k).then((r) => {
      if (selRouteRef.current === k) setRouteInfo(buildRouteInfo(r));
    }).catch(() => {});
  };
  // Compact turn-by-turn hint for the map chip: first turn text, its arrow rotation,
  // plus total distance & ETA to the fault.
  const buildRouteInfo = (r) => {
    const coords = r.coordinates || [];
    const st = (r.instructions || [])[0] || null;
    let arrow = 0;
    if (coords.length >= 2) arrow = bearingDeg(coords[0], coords[coords.length - 1]);
    return {
      text: st && st.text ? st.text.replace(/^Head (north|south|east|west|[nsew](orth|outh|ast|est))/i, 'Start —') : 'Follow the road',
      arrow,
      distance: r.distanceM || null,
      eta: r.durationS || null,
    };
  };
  const bearingDeg = (a, b) => {
    try {
      const lat1 = (a[0] * Math.PI) / 180, lng1 = (a[1] * Math.PI) / 180;
      const lat2 = (b[0] * Math.PI) / 180, lng2 = (b[1] * Math.PI) / 180;
      const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
      return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    } catch (e) { return 0; }
  };
  // Robust mobile call — tap opens Call / WhatsApp choice (works on desktop too)
  const [callSheet, setCallSheet] = useState(null);
  const callTech = async (tech) => {
    let phone = tech?.phone;
    const name = tech?.name || tech?.technicianId || 'technician';
    const techId = tech?._id || tech?.technicianId;
    if (!phone && techId) {
      try {
        const r = await api('/api/kesco/call-technician', { method: 'POST', body: { technicianId: techId } });
        phone = r.phone;
      } catch (e) {}
      if (!phone) {
        try {
          const altId = tech?.technicianId || tech?._id;
          if (altId && altId !== techId) {
            const r2 = await api('/api/kesco/call-technician', { method: 'POST', body: { technicianId: altId } });
            phone = r2.phone;
          }
        } catch (e) {}
      }
    }
    if (!phone) {
      alert(`${name} has no phone number on file — ask them to add it at login (Profile → Phone).`);
      return;
    }
    const cleaned = String(phone).replace(/[^+0-9]/g, '');
    if (!cleaned || cleaned.length < 10) {
      alert(`Invalid phone for ${name}: ${phone}`);
      return;
    }
    setCallSheet({ phone: cleaned, name });
  };

  useEffect(() => {
    const areaCache = {};
    const reverseArea = async (id, lat, lng) => {
      const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
      if (areaCache[key]) { setAreas((a) => ({ ...a, [id]: areaCache[key] })); return; }
      try {
        const r = await api(`/api/geo/reverse?lat=${lat}&lng=${lng}`);
        const area = r?.area || '';
        if (area) { areaCache[key] = area; setAreas((a) => ({ ...a, [id]: area })); }
      } catch (e) {}
    };
    const hasValidCoords = (coords) => Array.isArray(coords) && coords.length >= 2;
    const load = () => {
      api('/api/kesco/technicians').then((r) => setTechs(r.technicians || [])).catch(() => setTechs([]));
      api('/api/kesco/overview').then((r) => setOv(r.overview || {})).catch(() => setOv({}));
      api('/api/kesco/complaints?limit=50&sortBy=createdAt&order=desc').then((r) => {
        const active = (r.complaints || []).filter((c) => c.status !== 'resolved' && hasValidCoords(c.location?.coordinates));
        setFaults(active);
        active.slice(0, 20).forEach((c) => {
          const [lng, lat] = c.location?.coordinates || [];
          if (!areas[c._id]) reverseArea(c._id, lat, lng);
        });
      }).catch(() => setFaults([]));
    };
    load();
    const it = setInterval(load, 10000);
    return () => { clearInterval(it); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const safeTechs = Array.isArray(techs) ? techs : [];
  const safeFaults = Array.isArray(faults) ? faults : [];
  const hasValidCoords = (coords) => Array.isArray(coords) && coords.length >= 2;
  const located = safeTechs.filter((t) => hasValidCoords(t?.currentLocation?.coordinates));
  const onSite = safeTechs.filter((t) => t?.status === 'on-task').length;

  // Live technician lookup by id — to frame each lineman ↔ fault route on this same map
  const techById = {};
  safeTechs.forEach((t) => { if (t?._id) techById[String(t._id)] = t; });

  const markers = (() => {
    try {
      const safeT = (k) => { try { return t(k); } catch (e) { return k; } };
      const faultMarkers = faults.map((c) => {
        try {
          const [lng, lat] = c.location.coordinates;
          const tech = c.assignedTechnicianId && typeof c.assignedTechnicianId === 'object' ? techById[String(c.assignedTechnicianId._id)] : null;
          const urgency = (c.urgencyScore ?? 0) >= 6 ? safeT('critical') : (c.urgencyScore ?? 0) >= 3 ? safeT('high') : safeT('normal');
          return {
            lat, lng,
            icon: (() => { try { return pinIcon({ color: faultColor(c.urgencyScore), glyph: VARIANT_GLYPH[c.problemVariant] || 'bolt', ping: (c.urgencyScore ?? 0) >= 6 && c.status === 'registered' }); } catch (e) { return pinIcon({}); } })(),
            label: `<b style="text-transform:capitalize">${String(c.problemVariant || '').replace(/-/g, ' ')}</b> • ${urgency}<br>${areas[c._id] ? `${areas[c._id]} • ` : ''}${new Date(c.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}${tech ? `<br>Lineman: ${tech.name || 'assigned'}${c.etaMinutes ? ` • ETA ~${c.etaMinutes < 60 ? c.etaMinutes + 'm' : Math.round(c.etaMinutes / 60) + 'h'}` : ''}` : `<br>${safeT('awaitingCommander')}`}`,
          };
        } catch (e) { console.warn('fault marker failed', e); return null; }
      }).filter(Boolean);
      const techMarkers = located.map((t2) => {
        try {
          const [lng, lat] = t2.currentLocation.coordinates;
          const fault = t2.currentComplaint && hasValidCoords(t2.currentComplaint.location?.coordinates) ? t2.currentComplaint : (Object.values(techById).length ? faults.find((f) => f.assignedTechnicianId && typeof f.assignedTechnicianId === 'object' && String(f.assignedTechnicianId._id) === String(t2._id)) : null);
          return {
            lat, lng,
            ship: true,
            icon: (() => { try { return pinIcon({ color: t2.status === 'on-task' ? '#F2A93B' : '#5A6B8C', glyph: 'engineering', ping: t2.status === 'on-task' }); } catch (e) { return pinIcon({}); } })(),
            label: `<b>${t2.name || t2.technicianId}</b> — ${t2.status === 'on-task' ? `${safeT('onSite')} • ${fault?.problemVariant?.replace(/-/g, ' ') || 'on job'}` : t2.status === 'available' ? safeT('travelingIdle').toLowerCase() : t2.status}<br>GPS updated ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} • auto-refresh 10s`,
          };
        } catch (e) { console.warn('tech marker failed', e); return null; }
      }).filter(Boolean);
      return [...faultMarkers, ...techMarkers];
    } catch (e) { console.error('markers build failed', e); return []; }
    })();

  // On-map routes: each dispatched lineman → his fault, drawn along the real
  // road network (same line style as Google Maps) via OSRM — toggleable with
  // the "road routes" button; reverts to dashed straight lines when off.
  const paths = (() => {
    try {
      const roadCount = { n: 0 };
      const p = [];
      const seen = new Set();
      safeFaults.forEach((c) => {
        try {
          const tech = c.assignedTechnicianId && typeof c.assignedTechnicianId === 'object' ? techById[String(c.assignedTechnicianId._id)] : null;
          const tc = tech?.currentLocation?.coordinates;
          if (!tc || !hasValidCoords(tc)) return;
          const [fLng, fLat] = c.location.coordinates;
          const [tLng, tLat] = tc;
          const k = `${tLat.toFixed(4)},${tLng.toFixed(4)}|${fLat.toFixed(4)},${fLng.toFixed(4)}`;
          if (seen.has(k)) return;
          seen.add(k);
          const line = { from: [tLat, tLng], to: [fLat, fLng], color: '#F2A93B' };
          if (showRoad) {
            if (roadCount.n >= 8) { p.push(line); return; }
            roadCount.n += 1;
            p.push({ ...line, road: true });
          } else {
            p.push(line);
          }
        } catch (e) {}
      });
      // Selected tech→fault route: a bold dotted connector (always visible,
      // drawn by the plain path loop) + the dark-blue Google-style road path on top.
      if (showRoad && selRoute) {
        const parts = selRoute.split('|');
        if (parts.length === 2) {
          const [from0, from1] = parts[0].split(',').map(Number);
          const [to0, to1] = parts[1].split(',').map(Number);
          const pair = { from: [from0, from1], to: [to0, to1] };
          p.push({ ...pair, highlight: true, color: '#15803d' });
          p.push({ ...pair, road: true, highlight: true, color: '#1a4fd6' });
        }
      }
      return p;
} catch (e) { return []; }
    })();

  // Dedicated connector prop for MapView — isolated renderer that always draws
  // the bold dotted green tech→fault link.
  const selConn = (() => {
    try {
      if (!showRoad || !selRoute) return null;
      const parts = selRoute.split('|');
      if (parts.length !== 2) return null;
      const [from0, from1] = parts[0].split(',').map(Number);
      const [to0, to1] = parts[1].split(',').map(Number);
      if ([from0, from1, to0, to1].some((v) => Number.isNaN(v))) return null;
      return { from: [from0, from1], to: [to0, to1], color: '#15803d' };
    } catch (e) { return null; }
  })();

  return (
    <FleetErrorBoundary>
    <Shell wide navLinks={[
      { icon: 'space_dashboard', label: t('navDashboard'), onClick: () => go('#/kesco') },
      { icon: 'radar', label: t('navFleet'), active: true },
      { icon: 'person', label: t('navOfficer'), onClick: () => go('#/kesco/profile') },
      { icon: 'logout', label: t('navLogout'), mobile: false, footer: true, onClick: () => { try { clearAuth(); } catch (e) {} go('#/'); } },
    ]}>
      <div className="font-kesco antialiased">
      <div className="mb-4 xs:mb-6">
        <h1 className="font-display text-2xl xs:text-2xl sm:text-3xl md:text-4xl font-black text-ink-navy tracking-tight leading-tight">{t('trackingTitle')}</h1>
        <p className="text-sm sm:text-[15px] text-wire-slate mt-2 leading-relaxed max-w-2xl">{t('trackingSub')}</p>
      </div>

      {/* Overview stats — mobile: friendly pressure cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 xs:gap-4 mb-4 xs:mb-6 mobile-stagger">
        <div className="bg-paper rounded-[16px] xs:rounded-2xl p-4 xs:p-5 shadow-card border border-white/60 relative overflow-hidden pressable">
          <div className="absolute top-0 right-0 w-16 h-16 xs:w-20 xs:h-20 bg-surface-container-high rounded-bl-full opacity-60" />
          <p className="text-[11px] xs:text-xs font-bold uppercase tracking-wider text-wire-slate z-10 relative">{t('jobsInProgress')}</p>
          <div className="flex items-end gap-1.5 xs:gap-2 mt-2 relative z-10">
            <span className="font-display text-3xl xs:text-4xl font-extrabold text-ink-navy leading-none tracking-tight">{ov?.working ?? 0}</span>
            <Icon name="trending_up" className="text-signal-green mb-1 text-lg xs:text-xl" />
          </div>
          <p className="text-[10px] xs:text-[11px] text-wire-slate mt-1 relative z-10">{t('cityWide')}</p>
        </div>
        <div className="bg-paper rounded-[16px] xs:rounded-2xl p-4 xs:p-5 shadow-card border border-white/60 relative overflow-hidden pressable">
          <div className="absolute top-0 right-0 w-16 h-16 xs:w-20 xs:h-20 bg-circuit-amber/15 rounded-bl-full opacity-60" />
          <p className="text-[11px] xs:text-xs font-bold uppercase tracking-wider text-wire-slate z-10 relative">{t('onSiteNow')}</p>
          <div className="flex items-end gap-1.5 xs:gap-2 mt-2 relative z-10">
            <span className="font-display text-3xl xs:text-4xl font-extrabold text-ink-navy leading-none tracking-tight">{onSite}</span>
            <span className="w-2 h-2 xs:w-2.5 xs:h-2.5 rounded-full bg-signal-green pulse-dot mb-1 xs:mb-1.5 ml-0.5" />
          </div>
          <p className="text-[10px] xs:text-[11px] text-wire-slate mt-1 relative z-10">{t('linemenSharing')}</p>
        </div>
        <div className="bg-paper rounded-[16px] xs:rounded-2xl p-4 xs:p-5 shadow-card border border-white/60 relative overflow-hidden pressable">
          <div className="absolute top-0 right-0 w-16 h-16 xs:w-20 xs:h-20 bg-fault-red/10 rounded-bl-full opacity-60" />
          <p className="text-[11px] xs:text-xs font-bold uppercase tracking-wider text-wire-slate z-10 relative">{t('activeFaultsLabel')}</p>
          <div className="flex items-end gap-1.5 xs:gap-2 mt-2 relative z-10">
            <span className="font-display text-3xl xs:text-4xl font-extrabold text-fault-red leading-none tracking-tight">{faults.length}</span>
            <Icon name="bolt" fill className="text-fault-red mb-1 text-lg xs:text-xl" />
          </div>
          <p className="text-[10px] xs:text-[11px] text-wire-slate mt-1 relative z-10">{t('reportedOnMap')}</p>
        </div>
        <div className="bg-paper rounded-[16px] xs:rounded-2xl p-4 xs:p-5 shadow-card border border-white/60 relative overflow-hidden pressable">
          <div className="absolute top-0 right-0 w-16 h-16 xs:w-20 xs:h-20 bg-surface-container-high rounded-bl-full opacity-60" />
          <p className="text-[11px] xs:text-xs font-bold uppercase tracking-wider text-wire-slate z-10 relative">{t('fleetLabel')}</p>
          <div className="flex items-end gap-1.5 xs:gap-2 mt-2 relative z-10">
            <span className="font-display text-3xl xs:text-4xl font-extrabold text-ink-navy leading-none tracking-tight">{techs.length}</span>
            <Icon name="engineering" className="text-wire-slate mb-1 text-lg xs:text-xl" />
          </div>
          <p className="text-[10px] xs:text-[11px] text-wire-slate mt-1 relative z-10">{t('fleetTotal')}</p>
        </div>
      </div>

      {/* Live control-room map: faults + technicians — In-App Map only */}
      <div ref={mapBoxRef} className="rounded-xl xs:rounded-2xl overflow-hidden shadow-raised border border-haze relative z-0 mb-3" style={{ minHeight: 280 }}>
        <MapView
          zoom={12} height="h-[280px] xs:h-[340px] sm:h-[420px]"
          markers={markers}
          paths={paths}
          connector={selConn}
          fitStrategy="once"
          focus={focus}
        />
        {/* Road routes toggle */}
        <button onClick={() => setShowRoad((v) => !v)}
          title={showRoad ? t('roadRoutesOff') : t('roadRoutesOn')}
          className={`absolute top-2.5 left-2.5 z-[500] flex items-center gap-1.5 backdrop-blur border shadow-card px-3 py-2 rounded-full text-[10px] xs:text-[11px] font-bold active:scale-95 transition-all ${showRoad ? 'bg-ink-navy text-white border-ink-navy' : 'bg-white/95 border-haze text-ink-navy hover:text-circuit-amber'}`}>
          <Icon name={showRoad ? 'route' : 'route'} className={showRoad ? 'text-circuit-amber text-sm' : 'text-sm'} />
          {showRoad ? t('roadRoutesOn') : t('roadRoutesShow')}
        </button>
        {/* Live directions chip for the selected tech→fault route */}
        {showRoad && selRoute && routeInfo && (
          <div className="absolute top-2.5 right-2.5 z-[500] max-w-[calc(100%-140px)] bg-white/95 backdrop-blur rounded-xl border border-[#1a4fd6]/40 shadow-card px-2.5 py-2 flex items-center gap-2">
            <span className="w-8 h-8 rounded-full bg-[#1a4fd6]/15 flex items-center justify-center shrink-0"
              style={{ transform: `rotate(${routeInfo.arrow}deg)` }}>
              <svg viewBox="0 0 24 24" width="20" height="20" className="shrink-0"><path d="M12 2 L21 21 L12 16.5 L3 21 Z" fill="#1a4fd6" stroke="#ffffff" strokeWidth="1" /></svg>
            </span>
            <div className="min-w-0">
              <p className="text-[10px] xs:text-[11px] font-bold text-ink-navy leading-tight capitalize truncate">{routeInfo.text}</p>
              <p className="text-[9px] xs:text-[10px] font-mono text-wire-slate">
                {routeInfo.distance != null ? (routeInfo.distance < 1000 ? `${routeInfo.distance} m` : `${(routeInfo.distance / 1000).toFixed(1)} km`) : ''}
                {routeInfo.eta != null ? ` • ${Math.round(routeInfo.eta / 60)} min` : ''}
              </p>
            </div>
            <button onClick={() => { setSelRoute(null); setRouteInfo(null); selRouteRef.current = null; }}
              className="ml-0.5 w-6 h-6 rounded-full hover:bg-surface-container flex items-center justify-center text-wire-slate text-xs shrink-0" aria-label="Close">
              ✕
            </button>
          </div>
        )}
        {/* Map legend */}
        <div className="absolute bottom-3 left-3 bg-white/95 backdrop-blur rounded-xl border border-haze shadow-card px-3 py-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-bold text-ink-navy z-[400]">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-fault-red" /> {t('criticalFault')}</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-circuit-amber" /> {t('faultBusy')}</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[#5A6B8C]" /> {t('idleLineman')}</span>
          {showRoad && <span className="flex items-center gap-1.5"><span className="w-3.5 h-1 rounded-full bg-circuit-amber" /> {t('activeRoute')}</span>}
          {selRoute && <span className="flex items-center gap-1.5"><span className="w-3.5 h-1 rounded-full bg-[#15803d]" /> {t('routeBtn')}</span>}
        </div>
      </div>
      <p className="text-[11px] text-wire-slate mb-4 xs:mb-6 flex items-center gap-1.5">
        <Icon name="info" className="text-sm" /> {t('legendDesc')}
      </p>

      {/* Fault locations list */}
      <h2 className="font-display font-bold text-ink-navy mb-2 xs:mb-3 text-sm xs:text-base flex items-center gap-2">
        <Icon name="bolt" fill className="text-fault-red" /> {t('faultLocationsTitle')} ({faults.length})
        <span className="text-[10px] font-mono font-normal text-wire-slate">{t('areaOfProblem')}</span>
      </h2>
      {faults.length === 0 ? (
        <EmptyState icon="task_alt" title={t('noActiveFaults')} sub={t('everyFaultAppears')} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 xs:gap-4 mb-6 xs:mb-8">
          {faults.slice(0, 12).map((c) => {
            const color = faultColor(c.urgencyScore);
            const [lng, lat] = c.location.coordinates;
            return (
              <div key={c._id} className="bg-paper rounded-xl xs:rounded-2xl p-3 xs:p-4 shadow-card border-l-4 hover:shadow-raised transition-all" style={{ borderLeftColor: color }}>
                <div className="flex justify-between items-start gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 overflow-hidden" style={{ background: `${color}1a` }}>
                      <Icon name={VARIANT_GLYPH[c.problemVariant] || 'bolt'} fill style={{ color, lineHeight: 1 }} className="text-lg leading-none" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-display font-bold text-xs xs:text-sm text-ink-navy capitalize truncate leading-tight">{String(c.problemVariant || '').replace(/-/g, ' ')}</h3>
                      <p className="font-mono text-[10px] text-wire-slate">{faultId(c)} • {new Date(c.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</p>
                    </div>
                  </div>
                  <span className="text-[9px] font-bold px-2 py-0.5 rounded-full uppercase shrink-0" style={{ background: `${color}1a`, color }}>{(c.urgencyScore ?? 0) >= 6 ? t('critical') : (c.urgencyScore ?? 0) >= 3 ? t('high') : t('normal')}</span>
                </div>
                <div className="mt-2.5 bg-surface-container-low rounded-lg px-2.5 py-2 flex items-start gap-1.5">
                  <Icon name="location_on" fill className="text-circuit-amber text-sm shrink-0 mt-0.5" />
                  <p className="text-[11px] xs:text-xs text-on-surface-variant leading-snug min-w-0">
                    {areas[c._id] ? <span className="font-semibold text-ink-navy">{areas[c._id]}</span> : <span className="text-wire-slate">{t('resolvingArea')}</span>}
                    <span className="block font-mono text-[9px] text-wire-slate mt-0.5">{lat.toFixed(5)}, {lng.toFixed(5)}</span>
                  </p>
                </div>
                <div className="flex items-center justify-between mt-2.5 gap-2 flex-wrap">
                  <span className="text-[10px] xs:text-[11px] text-wire-slate truncate">
                    {c.assignedTechnicianId?.name ? <span className="text-signal-green font-semibold flex items-center gap-1"><Icon name="engineering" className="text-xs" />{c.assignedTechnicianId.name}</span> : <span className="flex items-center gap-1"><Icon name="schedule" className="text-xs" />{t('awaitingCommander')}</span>}
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    <button onClick={() => focusOn([[lat, lng]])}
                      className="bg-ink-navy text-white text-[10px] xs:text-[11px] font-bold px-2.5 xs:px-3 py-1.5 rounded-lg flex items-center gap-1 hover:bg-grid-navy active:scale-95 transition-all">
                      <Icon name="map" className="text-xs" /> {t('openInMaps')}
                    </button>
                    {(c.assignedTechnicianId && typeof c.assignedTechnicianId === 'object' && techById[String(c.assignedTechnicianId._id)] && techLatLng(techById[String(c.assignedTechnicianId._id)])) && (
                      <>
                        <button onClick={() => showTechRoadRoute(techById[String(c.assignedTechnicianId._id)], c)}
                          title={selRoute === keyOf(techById[String(c.assignedTechnicianId._id)], c) ? t('clearRoute') : t('showRoute')}
                          className={selRoute === keyOf(techById[String(c.assignedTechnicianId._id)], c) ? 'bg-[#1a4fd6] text-white text-[10px] xs:text-[11px] font-bold px-2.5 xs:px-3 py-1.5 rounded-lg flex items-center gap-1 hover:brightness-110 active:scale-95 transition-all' : 'bg-paper border border-[#1a4fd6]/40 text-[#1a4fd6] text-[10px] xs:text-[11px] font-bold px-2.5 xs:px-3 py-1.5 rounded-lg flex items-center gap-1 hover:bg-[#1a4fd6]/10 active:scale-95 transition-all'}>
                          <Icon name="route" className="text-xs" /> {t('routeBtn')}
                        </button>
                        <button onClick={() => navToFaultGmaps(techById[String(c.assignedTechnicianId._id)], c)}
                          className="bg-circuit-amber text-ink-navy text-[10px] xs:text-[11px] font-bold px-2.5 xs:px-3 py-1.5 rounded-lg flex items-center gap-1 hover:brightness-105 active:scale-95 transition-all">
                          <Icon name="directions" className="text-xs" /> {t('navigate')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Fleet list */}
      <h2 className="font-display font-bold text-ink-navy mb-2 xs:mb-3 text-sm xs:text-base">{t('fleetCount')} ({techs.length})</h2>
      {techs.length === 0 ? (
        <EmptyState icon="engineering" title={t('noTechsYet')} sub={t('appearAfterLogin')} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 xs:gap-4 pb-4">
          {techs.map((tech) => {
            const st = STATUS_STYLE[tech.status] || STATUS_STYLE.available;
            const loc = tech.currentLocation?.coordinates;
            const target = tech.currentComplaint && hasValidCoords(tech.currentComplaint.location?.coordinates)
              ? tech.currentComplaint
              : faults.find((f) => f.assignedTechnicianId && typeof f.assignedTechnicianId === 'object' && String(f.assignedTechnicianId._id) === String(tech._id));
            const targetKey = target ? keyOf(tech, target) : null;
            return (
              <div key={tech._id} className={`bg-paper rounded-xl xs:rounded-2xl p-3 xs:p-4 shadow-card border-l-4 ${st.bar} hover:shadow-raised transition-all`}>
                <div className="flex justify-between items-start gap-2">
                  <div className="flex items-center gap-2.5 xs:gap-3 min-w-0 flex-1">
                    <div className={`w-10 h-10 xs:w-11 xs:h-11 rounded-full flex items-center justify-center shrink-0 ${tech.status === 'on-task' ? 'bg-secondary-fixed/50' : 'bg-surface-container-high'}`}>
                      <Icon name="engineering" fill className={`${tech.status === 'on-task' ? 'text-on-secondary-container' : 'text-wire-slate'} text-lg xs:text-xl`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-display font-bold text-xs xs:text-sm text-grid-navy truncate">{tech.name || 'Unnamed Tech'}</h3>
                      <p className="font-mono text-[10px] xs:text-[11px] text-wire-slate truncate">{tech.technicianId}</p>
                    </div>
                  </div>
                  <span className={`flex items-center gap-1 xs:gap-1.5 px-2 xs:px-2.5 py-1 rounded-full border text-[9px] xs:text-[10px] font-bold whitespace-nowrap shrink-0 ${st.cls}`}>
                    <span className={`w-1 h-1 xs:w-1.5 xs:h-1.5 rounded-full ${st.dot} shrink-0`} />{st.label}
                  </span>
                </div>
                <div className="flex items-center gap-1 xs:gap-1.5 text-[11px] xs:text-xs text-on-surface-variant mt-2.5 xs:mt-3 bg-surface-container-low rounded-lg px-2.5 xs:px-3 py-2">
                  <Icon name="assignment" className="text-sm xs:text-base shrink-0" />
                  <span className="truncate capitalize">{tech.currentComplaint ? `${String(tech.currentComplaint.problemVariant || '').replace(/-/g, ' ')} ${t('liveJob')}` : `${tech.assignedCount} ${t('assignedStanding')}`}</span>
                </div>
                <div className="flex justify-end gap-1.5 xs:gap-2 mt-2.5 xs:mt-3 flex-wrap">
                  {loc && target && (
                    <>
                      <button onClick={() => { if (selRoute !== targetKey) selectRoute(targetKey, techLatLng(tech), [target.location.coordinates[1], target.location.coordinates[0]]); else { setSelRoute(null); setRouteInfo(null); selRouteRef.current = null; } setShowRoad(true); }}
                        title={selRoute === targetKey ? t('clearRoute') : t('showRoute')}
                        className={selRoute === targetKey ? 'bg-[#1a4fd6] text-white text-[11px] xs:text-xs font-bold px-3 xs:px-4 py-2 rounded-lg flex items-center gap-1 hover:bg-[#2a63e8] active:scale-95 transition-all' : 'bg-paper border border-[#1a4fd6]/40 text-[#1a4fd6] text-[11px] xs:text-xs font-bold px-3 xs:px-4 py-2 rounded-lg flex items-center gap-1 hover:bg-[#1a4fd6]/10 active:scale-95 transition-all'}>
                        <Icon name="route" fill={selRoute === targetKey} className="text-xs xs:text-sm" /> {t('routeBtn')}
                      </button>
                      <button onClick={() => navToFaultGmaps(tech, target)}
                        className="bg-ink-navy text-white text-[11px] xs:text-xs font-bold px-3 xs:px-4 py-2 rounded-lg flex items-center gap-1 hover:bg-grid-navy active:scale-95 transition-all">
                        <Icon name="directions" fill className="text-xs xs:text-sm" /> {t('navigate')}
                      </button>
                    </>
                  )}
                  <button onClick={() => focusOn([techLatLng(tech)])}
                      className="bg-circuit-amber text-ink-navy text-[11px] xs:text-xs font-bold px-3 xs:px-4 py-2 rounded-lg flex items-center gap-1 hover:bg-secondary-container active:scale-95 transition-all">
                      <Icon name="location_on" fill className="text-xs xs:text-sm" /> {t('liveLocationBtn')}
                    </button>
                  <button onClick={() => callTech(tech)}
                    title={`Call ${tech.name || tech.technicianId}${tech.phone ? ' • ' + tech.phone : ''}`}
                    className="group inline-flex items-center gap-2 bg-circuit-amber hover:bg-[#f5b84f] text-ink-navy text-[11px] xs:text-xs font-extrabold pl-1 pr-3.5 xs:pl-1 xs:pr-4 py-1 xs:py-1 rounded-full shadow-glow-amber border border-circuit-amber/30 active:scale-[0.96] hover:shadow-[0_0_0_1px_rgba(242,169,59,0.4),0_8px_22px_rgba(242,169,59,0.28)] transition-all"
                  >
                    <span className="w-7 h-7 xs:w-8 xs:h-8 rounded-full bg-ink-navy group-hover:bg-grid-navy text-circuit-amber flex items-center justify-center shadow-card shrink-0 transition-colors">
                      <Icon name="call" fill className="text-sm xs:text-[16px] leading-none" />
                    </span>
                    <span className="tracking-tight">{t('callTechShort')}</span>
                  </button>
                </div>
                <p className="text-[10px] font-mono text-wire-slate mt-1.5 truncate">📞 {tech.phone || 'Tap Call to dial'} {t('directPhone')}</p>
              </div>
            );
          })}
        </div>
      )}
      </div>
      {callSheet ? <CallSheet phone={callSheet.phone} name={callSheet.name} onClose={() => setCallSheet(null)} /> : null}
    </Shell>
    </FleetErrorBoundary>
  );
}
