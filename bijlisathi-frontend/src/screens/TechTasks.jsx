import React, { useEffect, useMemo, useState } from 'react';
import { api, getAuth, clearAuth, photoUrl, faultId } from '../lib/api';
import { Icon, StatusPill, UrgencyBadge, Spinner, EmptyState, Shell } from '../components/ui';
import { useLang } from '../lib/i18n.jsx';
import MapView, { pinIcon } from '../components/Map';
import ChatAssistant from '../components/ChatAssistant';
import { openGoogleMapsRoute } from '../lib/gmaps';
import { fetchRoadRoute } from '../lib/osrm';

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function timeAgo(ts) {
  const m = Math.floor((Date.now() - new Date(ts)) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function TechTasks({ go }) {
  const { t } = useLang();
const FILTERS = [
    { key: 'all', label: t('allTasks'), icon: 'grid_view' },
    { key: 'active', label: t('activeJobs'), icon: 'construction' },
    { key: 'completed', label: t('completedJobs'), icon: 'check_circle' },
    { key: 'transformer-fault', label: t('transformers'), icon: 'electric_bolt' },
    { key: 'broken-wire', label: t('wiresCables'), icon: 'cable' },
  ];
  const [tasks, setTasks] = useState([]);
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState('');
  const [myPos, setMyPos] = useState(null);
  const [showRoad, setShowRoad] = useState(true);
  const [sharingGps, setSharingGps] = useState(false);
  const watchRef = React.useRef(null);
  const sharingRef = React.useRef(false);
  const gpsRetriesRef = React.useRef(0);
  const pollRef = React.useRef(null);
  const [gpsError, setGpsError] = useState('');
  const [lastGpsAt, setLastGpsAt] = useState(null);
  const routeBoxRef = React.useRef(null);

  // FLOW: AI suggests nearest ideal FREE tech (available, closest, lowest load) → KESCO Controller clicks Assign on suggested tech → task lands in THAT tech's My Jobs as 'registered' (pending) → Tech taps Accept → status 'working' + GPS starts → Tech works → taps Resolve → 'resolved'
  // Tech can also tap Reject → task returns to KESCO pool for next AI suggestion. AI NEVER auto-dispatches directly; KESCO + Tech approval both mandatory.

  useEffect(() => {
    // Isolate per technician: fetch fresh for current token
    load();
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition((p) => setMyPos([p.coords.latitude, p.coords.longitude]), () => {}, { timeout: 8000 });
    // Auto-refresh tasks — when KESCO assigns to this technician, the new job appears within seconds
    const it = setInterval(load, 10000);
    // Also listen for real-time assignment via socket (instant)
    let sock = null;
    (async () => {
      try {
        const { io } = await import('socket.io-client');
        const { getAuth } = await import('../lib/api');
        const API_BASE = (import.meta.env.VITE_API_URL || 'https://bijli-sathi-api.vercel.app').replace(/\/$/, '');
        const tid = getAuth()?.userId;
        sock = io(API_BASE, { transports: ['websocket', 'polling'], withCredentials: false });
        const onAssigned = (data) => {
          const tId = data?.technician?._id || data?.technicianId;
          if (!tId || String(tId) === String(tid)) load();
        };
        sock.on('technician-auto-assigned', onAssigned);
        sock.on('technician-assigned-broadcast', onAssigned);
        sock.on('technician-assigned', onAssigned);
      } catch (e) {}
    })();
    // Resume sharing when the app comes back to foreground — ONLY if it was already running
    const onVis = () => {
      if (document.visibilityState === 'visible' && sharingRef.current) {
        if (watchRef.current) { navigator.geolocation.clearWatch(watchRef.current); watchRef.current = null; }
        startGps();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    const onAuth = () => { load(); };
    window.addEventListener('bs_auth_change', onAuth);
    return () => { clearInterval(it); if (sock) try { sock.disconnect(); } catch (e) {} stopGps(); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('bs_auth_change', onAuth); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async () => {
    try {
      const res = await api('/api/technician/task-list');
      setTasks(res.complaints || []);
    } catch (e) { setTasks([]); }
  };

  // START — only by tapping the GPS button or after accepting a task
  // Robust GPS: watchPosition + fallback poll, handles permission, timeout, and stale watch
  const startGps = async () => {
    if (!navigator.geolocation) { setGpsError('GPS is not supported on this device'); return; }
    // Check permission state first (if API available)
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const p = await navigator.permissions.query({ name: 'geolocation' });
        if (p.state === 'denied') {
          setGpsError('Location permission denied — allow GPS in browser Site Settings, then tap START GPS');
          return;
        }
      }
    } catch (e) {}
    if (watchRef.current) { try { navigator.geolocation.clearWatch(watchRef.current); } catch (e) {} watchRef.current = null; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    sharingRef.current = true;
    setSharingGps(true);
    setGpsError('');
    gpsRetriesRef.current = 0;

    const sendPos = (lat, lng, acc, heading) => {
      setLastGpsAt(Date.now());
      gpsRetriesRef.current = 0;
      setGpsError('');
      setMyPos([lat, lng]);
      api('/api/technician/share-location', { method: 'POST', body: { lat, lng } })
        .then((r) => {
          if (r?.needRelogin) {
            setGpsError(r.error || 'Profile not found — please log out and log in again');
            sharingRef.current = false; setSharingGps(false);
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            if (watchRef.current) { try { navigator.geolocation.clearWatch(watchRef.current); } catch (e) {} watchRef.current = null; }
          }
        })
        .catch((e) => {
          const msg = e.message || 'Could not send location to the Control Room — check internet';
          // Don't stop sharing on network error — keep GPS, will retry on next fix
          if (String(msg).toLowerCase().includes('not authorized') || String(msg).toLowerCase().includes('invalid signature')) {
            setGpsError('Session expired — please logout and login again');
            sharingRef.current = false; setSharingGps(false);
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            if (watchRef.current) { try { navigator.geolocation.clearWatch(watchRef.current); } catch (e) {} watchRef.current = null; }
          } else {
            setGpsError(msg);
          }
        });
    };

    // Immediate one-shot to get quick lock
    navigator.geolocation.getCurrentPosition(
      (pos) => sendPos(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.coords.heading),
      (err) => {
        if (err.code === 1) {
          sharingRef.current = false; setSharingGps(false);
          setGpsError('Location permission denied — allow GPS in browser Site Settings, then tap START GPS');
        } else {
          setGpsError('Acquiring GPS… please stay outdoors or near window, then tap again if needed');
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );

    // Continuous watch
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => sendPos(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.coords.heading),
      (err) => {
        if (err.code === 1) {
          sharingRef.current = false; setSharingGps(false);
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          if (watchRef.current) { try { navigator.geolocation.clearWatch(watchRef.current); } catch (e) {} watchRef.current = null; }
          setGpsError('Location permission denied — allow GPS in browser settings, then tap START GPS');
        } else {
          const isTimeout = err.code === 3;
          setGpsError(isTimeout ? 'GPS timeout — moving outdoors helps, retrying…' : 'GPS signal weak — retrying automatically…');
        }
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 }
    );

    // Fallback poll every 8s — ensures location is sent even if watch stalls (common on some Android WebViews)
    pollRef.current = setInterval(() => {
      if (!sharingRef.current) { clearInterval(pollRef.current); pollRef.current = null; return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => sendPos(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.coords.heading),
        () => {},
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
      );
    }, 8000);
  };

  // STOP — technician taps to stop; also fires automatically when a job is resolved
  const stopGps = () => {
    if (watchRef.current) { try { navigator.geolocation.clearWatch(watchRef.current); } catch (e) {} watchRef.current = null; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    sharingRef.current = false;
    gpsRetriesRef.current = 0;
    setSharingGps(false);
  };

  const [acceptModal, setAcceptModal] = useState(null); // { complaintId, complaint } or null
  const [etaInput, setEtaInput] = useState('45');

  const accept = async (complaintId) => {
    // Open modal: technician reads description + photo, then sets ETA
    const complaint = tasks.find(c => c._id === complaintId);
    setAcceptModal({ complaintId, complaint });
    setEtaInput('45');
  };
  const confirmAccept = async () => {
    if (!acceptModal) return;
    const mins = Math.round(Number(String(etaInput).replace(/[^\d]/g, '')));
    if (!mins || mins < 10 || mins > 720) { alert('Please enter a time between 10 minutes and 12 hours (720 minutes).'); return; }
    setBusy(acceptModal.complaintId);
    setAcceptModal(null);
    try { await api('/api/technician/accept-task', { method: 'POST', body: { complaintId: acceptModal.complaintId, etaMinutes: mins } }); await load(); startGps(); }
    catch (e) { alert(e.message); }
    setBusy('');
  };
  const reject = async (complaintId) => {
    if (!confirm('Reject this task? It will return to KESCO for AI to suggest the next nearest ideal free technician.')) return;
    setBusy(complaintId);
    try { await api('/api/technician/reject-task', { method: 'POST', body: { complaintId } }); await load(); stopGps(); }
    catch (e) { alert(e.message); }
    setBusy('');
  };
  const setStatus = async (complaintId, status) => {
    setBusy(complaintId);
    try { await api('/api/technician/update-status', { method: 'POST', body: { complaintId, status } }); if (status === 'resolved') stopGps(); await load(); }
    catch (e) { alert(e.message); }
    setBusy('');
  };

  const matchesFilter = (c) => {
    if (filter === 'all') return true;
    if (filter === 'active') return c.status !== 'resolved';
    if (filter === 'completed') return c.status === 'resolved';
    return c.problemVariant === filter;
  };
  const filteredTasks = useMemo(() => (tasks || []).filter(matchesFilter), [tasks, filter]);
  // The working job (first working job with coords)
  const activeJob = useMemo(() => (tasks || []).find((c) => c.status === 'working' && c.location?.coordinates), [tasks]);
  const activeFaultPos = activeJob ? [activeJob.location.coordinates[1], activeJob.location.coordinates[0]] : null;

  // Open real turn-by-turn driving guidance in the Google Maps app
  // (technician's live location → fault).
  const openNavInGmaps = () => {
    if (!myPos || !activeFaultPos) return;
    openGoogleMapsRoute(myPos, activeFaultPos);
  };

  // In-app guidance on the map, mirroring the KESCO control room:
  // Google-style path + bold dotted green connector (DOM markers) + directions chip.
  const [routeOn, setRouteOn] = useState(false);
  const [routeInfo, setRouteInfo] = useState(null);
  const routeRef = React.useRef(false);

  const bearingDeg = (a, b) => {
    const toRad = (x) => (x * Math.PI) / 180;
    const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
    const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
    return (Math.atan2(y, x) * 180) / Math.PI;
  };
  const fmtKm = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
  const buildRouteInfo = (r) => {
    try {
      const inst = r && r.instructions && r.instructions[0];
      const dist = (r && r.summary && r.summary.totalDistance) || 0;
      const time = (r && r.summary && r.summary.totalTime) || 0;
      const durS = Math.max(1, Math.round(time ? time / 60 : dist / 500));
      const etaMs = Date.now() + durS * 60000;
      const eta = new Date(etaMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return { inst, dist, eta };
    } catch (e) { return null; }
  };
  const toggleRoute = () => {
    if (!myPos || !activeFaultPos) return;
    const next = !routeOn;
    routeRef.current = next;
    setRouteOn(next);
    if (next) {
      setRouteInfo(null);
      fetchRoadRoute(myPos, activeFaultPos).then((r) => { if (routeRef.current) setRouteInfo(buildRouteInfo(r)); }).catch(() => {});
    } else {
      setRouteInfo(null);
    }
  };
  const selConn = routeOn && myPos && activeFaultPos ? { from: myPos, to: activeFaultPos, color: '#15803d' } : null;

  const TaskCard = ({ c }) => {
    const dist = myPos && c.location?.coordinates ? haversineKm(myPos, [c.location.coordinates[1], c.location.coordinates[0]]).toFixed(1) : null;
    const prio = (c.urgencyScore ?? 0) >= 6 ? [t('critical'), 'bg-error-container text-on-error-container'] : (c.urgencyScore ?? 0) >= 3 ? [t('high'), 'bg-secondary-fixed/70 text-on-secondary-container'] : [t('normal'), 'bg-surface-container-high text-wire-slate'];
    const isActive = c.status === 'working';
    return (
      <div className={`bg-paper rounded-[16px] sm:rounded-2xl p-4 xs:p-5 shadow-card border ${isActive ? 'border-l-4 border-l-circuit-amber border-y border-r border-haze/40' : 'border-white/60 sm:border-haze/60'} hover:shadow-raised active:scale-[0.98] transition-all pressable`}>
        <div className="flex justify-between items-start gap-2 mb-3">
          <span className="font-mono text-[11px] bg-surface-container px-2 py-1 rounded text-wire-slate">{faultId(c)}</span>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${prio[1]}`}>
              <Icon name="priority_high" className="text-xs" />{prio[0]}
            </span>
            <StatusPill status={c.status} />
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 overflow-hidden ${c.problemVariant === 'transformer-fault' ? 'bg-error-container' : 'bg-secondary-fixed/50'}`}>
            <Icon name={c.problemVariant === 'broken-wire' ? 'cable' : c.problemVariant === 'meter-fault' ? 'electric_meter' : c.problemVariant === 'voltage-fluctuation' ? 'show_chart' : c.problemVariant === 'streetlight' ? 'lightbulb' : c.problemVariant === 'no-power' ? 'power_off' : 'electric_bolt'} fill className={`${c.problemVariant === 'transformer-fault' ? 'text-on-error-container' : 'text-on-secondary-container'} text-xl leading-none`} style={{ lineHeight: 1 }} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-display font-bold text-ink-navy capitalize leading-tight">{String(c.problemVariant || '').replace(/-/g, ' ')}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs text-wire-slate">
              {dist && <span className="flex items-center gap-0.5"><Icon name="near_me" className="text-sm text-circuit-amber" />{dist} {t('kmAway')}</span>}
              <span className="flex items-center gap-0.5"><Icon name="schedule" className="text-sm" />{timeAgo(c.createdAt)}</span>
              <UrgencyBadge score={c.urgencyScore} />
            </div>
            {c.description && <p className="text-xs text-on-surface-variant mt-2 line-clamp-2">{c.description}</p>}
            {c.description && c.photoUrl ? (
              <img src={photoUrl(c.photoUrl)} alt="" className="mt-2 h-24 w-full object-cover rounded-xl border border-haze/60" />
            ) : c.photoUrl ? (
              <img src={photoUrl(c.photoUrl)} alt="" className="mt-2 h-24 w-full object-cover rounded-xl border border-haze/60" />
            ) : null}
          </div>
        </div>
        {c.status === 'registered' && (
          <p className="mt-3 text-[11px] font-semibold text-circuit-amber bg-circuit-amber/10 border border-circuit-amber/20 rounded-lg px-3 py-2 flex items-center gap-1.5">
            <Icon name="auto_awesome" className="text-sm shrink-0" /> On Accept you read the description & photo, then set the fix-time ETA for the citizen.
          </p>
        )}
        {c.status === 'working' && (c.safetyPrecautions || c.resolutionProcess || c.techEtaLabel) && (
          <div className="mt-3 space-y-2">
            {c.techEtaLabel && (
              <p className="text-[11px] font-bold text-signal-green bg-signal-green/10 border border-signal-green/20 rounded-lg px-3 py-2 flex items-center gap-1.5">
                <Icon name="schedule" className="text-sm shrink-0" /> Your ETA to citizen: <span className="font-extrabold">{c.techEtaLabel}</span>
              </p>
            )}
            {c.safetyPrecautions && (
              <div className="rounded-lg border border-error-container bg-error-container/40 p-3">
                <p className="text-[11px] font-extrabold uppercase tracking-widest text-fault-red flex items-center gap-1.5 mb-1.5"><Icon name="warning" className="text-sm" /> Safety Precautions <span className="text-[9px] normal-case font-bold text-wire-slate">AI</span></p>
                <ul className="space-y-1">
                  {String(c.safetyPrecautions).split('\n').filter(Boolean).map((s, i) => (
                    <li key={i} className="text-[11px] text-on-surface-variant flex gap-1.5"><span className="text-fault-red shrink-0 mt-0.5">•</span>{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {c.resolutionProcess && (
              <div className="rounded-lg border border-haze bg-surface-container/60 p-3">
                <p className="text-[11px] font-extrabold uppercase tracking-widest text-ink-navy flex items-center gap-1.5 mb-1.5"><Icon name="fact_check" className="text-sm" /> Resolution Process <span className="text-[9px] normal-case font-bold text-wire-slate">AI</span></p>
                <ol className="space-y-1">
                  {String(c.resolutionProcess).split('\n').filter(Boolean).map((s, i) => (
                    <li key={i} className="text-[11px] text-on-surface-variant flex gap-2"><span className="font-mono font-bold text-circuit-amber shrink-0">{i + 1}.</span>{s}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
        {c.status === 'registered' ? (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button onClick={() => reject(c._id)} disabled={busy === c._id}
              className="bg-paper border-2 border-haze text-wire-slate text-sm font-bold rounded-full sm:rounded-xl min-h-[52px] active:scale-[0.97] transition-all disabled:opacity-60 flex items-center justify-center gap-1.5 pressable hover:border-fault-red hover:text-fault-red">
              <Icon name="close" className="text-lg shrink-0" /> Reject
            </button>
            <button onClick={() => accept(c._id)} disabled={busy === c._id}
              className="bg-circuit-amber text-ink-navy text-sm font-extrabold rounded-full sm:rounded-xl shadow-glow-amber min-h-[52px] active:scale-[0.97] transition-all disabled:opacity-60 flex items-center justify-center gap-1.5 pressable">
              <Icon name="task_alt" className="text-lg shrink-0" /> {busy === c._id ? '...' : 'Accept'}
            </button>
          </div>
        ) : c.status === 'working' ? (
          <button onClick={() => setStatus(c._id, 'resolved')} disabled={busy === c._id}
            className="mt-4 w-full bg-signal-green text-white text-sm font-extrabold rounded-full sm:rounded-xl shadow-card min-h-[52px] active:scale-[0.97] transition-all disabled:opacity-60 flex items-center justify-center gap-1.5 pressable">
            <Icon name="check_circle" className="text-lg shrink-0" /> {t('resolveBtn')} — Issue Resolved
          </button>
        ) : (
          <p className="mt-4 text-center text-sm text-signal-green font-bold py-2 bg-signal-green/10 rounded-full border border-signal-green/20">{t('jobComplete')}</p>
        )}
      </div>
    );
  };

  return (
    <Shell navLinks={[
      { icon: 'bolt', label: t('navTasks'), active: true },
      { icon: 'person', label: t('navProfile'), onClick: () => go('#/tech/profile') },
      { icon: 'logout', label: t('navLogout'), mobile: false, footer: true, onClick: () => { try { clearAuth(); } catch (e) {} go('#/'); } },
    ]} wide>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-4 xs:mb-5">
        <div>
          <h1 className="font-display text-xl xs:text-2xl md:text-3xl font-bold text-ink-navy leading-tight">{t('myJobsOnlyYours')}</h1>
          <p className="text-xs xs:text-sm text-wire-slate mt-0.5">{t('isolatedPerTech')}</p>
        </div>
        <button onClick={sharingGps ? stopGps : startGps} title={t('gpsStartsAnytime')}
          className={`relative flex items-center gap-3 px-4 xs:px-5 py-3.5 rounded-xl text-sm font-bold transition-all active:scale-[0.97] whitespace-nowrap shrink-0 ${sharingGps
            ? 'bg-signal-green text-white shadow-[0_0_24px_rgba(46,158,107,0.6)] border border-signal-green/30'
            : 'bg-paper border-2 border-haze text-ink-navy hover:border-circuit-amber hover:bg-surface-container-low'}`}>
          <span className="relative w-9 h-9 rounded-full flex items-center justify-center shrink-0"
            style={{ background: sharingGps ? 'rgba(255,255,255,0.25)' : 'rgba(242,169,59,0.18)' }}>
            {sharingGps && <span className="radar-ping absolute inset-0" />}
            <Icon name={sharingGps ? 'satellite_alt' : 'location_on'} fill className={`text-xl relative z-10 ${sharingGps ? 'text-white' : 'text-circuit-amber'}`} />
          </span>
          <span className="flex flex-col items-start leading-none min-w-0">
            <span className="tracking-wide text-[14px]">{sharingGps ? t('gpsOn') : t('startGps')}</span>
            <span className={`text-[10px] font-bold uppercase tracking-wider mt-0.5 ${sharingGps ? 'text-white/90' : 'text-wire-slate'}`}>
              {sharingGps ? t('tapToStop') : t('offTapToStart')}
            </span>
          </span>
        </button>
      </div>
      {/* GPS sharing status — bold strip; the Control Room sees this location on its live map */}
      {gpsError ? (
        <div className="bg-fault-red text-white rounded-xl px-4 py-3 mb-4 xs:mb-6 flex items-center gap-3 shadow-card">
          <span className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center shrink-0">
            <Icon name="location_off" fill className="text-lg" />
          </span>
          <p className="text-xs font-semibold leading-snug">{gpsError}</p>
        </div>
      ) : sharingGps ? (
        <div className="bg-gradient-to-r from-signal-green/15 via-signal-green/10 to-transparent border border-signal-green/30 rounded-xl px-4 py-3 mb-4 xs:mb-6 flex items-center gap-3">
          <span className="relative w-9 h-9 rounded-full bg-signal-green flex items-center justify-center shrink-0 shadow-[0_0_14px_rgba(46,158,107,0.5)]">
            <span className="radar-ping absolute inset-0" />
            <Icon name="satellite_alt" fill className="text-white text-lg relative z-10" />
          </span>
          <p className="text-xs font-bold text-signal-green leading-snug">
            {t('trackingOn')}
            <span className="block font-semibold text-wire-slate mt-0.5">
              {lastGpsAt ? `${t('lastUpdate')} ${Math.max(1, Math.round((Date.now() - lastGpsAt) / 1000))}s ago • ${t('tapToStop')}` : t('acquiringGps')}
            </span>
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-wire-slate bg-surface-container-high/60 border border-haze/60 rounded-xl px-3 py-2 mb-4 xs:mb-6 flex items-center gap-1.5">
          <Icon name="info" className="text-sm text-circuit-amber shrink-0" />
          {t('gpsOffDesc')}
        </p>
      )}

      {/* (Video-call incoming-call panel removed — KESCO calls technicians by phone number now) */}

      {/* Filter chips — INITIAL MOBILE: snap + haptic + scroll-fade (<1024px only) — from first mobile */}
      <div className="relative scroll-fade -mx-3 xs:mx-0 px-3 xs:px-0 mb-4 xs:mb-6">
        <div className="flex gap-2 overflow-x-auto hide-scrollbar pb-2 snap-x snap-mandatory pr-6">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => { try{navigator.vibrate&&navigator.vibrate(5)}catch{} setFilter(filter === f.key ? 'all' : f.key); }}
              className={`flex items-center gap-1.5 xs:gap-1.5 px-4 xs:px-4 py-2 xs:py-2 rounded-full text-xs xs:text-sm font-bold whitespace-nowrap transition-all snap-start shrink-0 min-h-[36px] active:scale-95 ${filter === f.key ? 'bg-ink-navy text-white shadow-card' : 'bg-paper border border-haze/70 text-wire-slate hover:border-circuit-amber hover:text-ink-navy'}`}>
              <Icon name={f.icon} className="text-sm xs:text-base" /> {f.label}
            </button>
          ))}
          <span className="shrink-0 w-4" aria-hidden />
        </div>
      </div>

      {/* Technician → fault on my map */}
      {(() => {
        if (!activeJob || !myPos) return null;
        const faultPos = activeFaultPos;
        const techPos = myPos;
        return (
          <div ref={routeBoxRef} className="mb-4 xs:mb-6 rounded-xl xs:rounded-2xl shadow-raised border border-haze/60 overflow-hidden relative z-0">
            <MapView
              height="h-[300px] xs:h-[360px]"
              zoom={15}
              fitStrategy="once"
              markers={[
                { lat: faultPos[0], lng: faultPos[1], icon: pinIcon({ color: '#D64545', glyph: 'bolt', ping: activeJob.urgencyScore >= 6 }) },
                { lat: techPos[0], lng: techPos[1], icon: pinIcon({ color: '#F2A93B', glyph: 'engineering', ping: true }) },
              ]}
              paths={[
                { from: techPos, to: faultPos, color: '#F2A93B', road: showRoad },
                ...(routeOn ? [{ from: techPos, to: faultPos, road: true, highlight: true, color: '#1a4fd6' }] : []),
              ]}
              connector={selConn}
            />
            <div className="absolute top-2.5 left-2.5 z-[500]">
              <button onClick={() => setShowRoad((v) => !v)}
                title={showRoad ? t('roadRoutesOff') : t('roadRoutesOn')}
                className={`flex items-center gap-1.5 backdrop-blur border shadow-card px-3 py-2 rounded-full text-[10px] xs:text-[11px] font-bold active:scale-95 transition-all ${showRoad ? 'bg-ink-navy text-white border-ink-navy' : 'bg-white/95 border-haze text-ink-navy'}`}>
                <Icon name="route" className={showRoad ? 'text-circuit-amber text-sm' : 'text-sm'} />
                {showRoad ? t('roadRoutesOn') : t('roadRoutesShow')}
              </button>
            </div>
            <div className="absolute top-2.5 right-2.5 z-[500] flex gap-1.5">
              <button onClick={toggleRoute}
                title={routeOn ? t('clearRoute') : t('showRoute')}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-[11px] xs:text-xs font-bold shadow-card active:scale-95 transition-all ${routeOn ? 'bg-[#15803d] text-white border border-[#15803d]' : 'bg-white/95 border border-[#15803d]/40 text-[#15803d]'}`}>
                <Icon name="route" fill className="text-sm" /> {routeOn ? t('clearRoute') : t('routeBtn')}
              </button>
              <button onClick={openNavInGmaps}
                className="bg-circuit-amber text-ink-navy text-[11px] xs:text-xs font-bold px-3 py-2 rounded-full flex items-center gap-1.5 shadow-card active:scale-95 transition-all">
                <Icon name="directions" fill className="text-sm" /> {t('navigate')}
              </button>
            </div>
            {routeOn && routeInfo && (
              <div className="absolute bottom-2.5 left-2.5 z-[500] max-w-[calc(100%-140px)] bg-white/95 backdrop-blur border border-haze/70 shadow-raised rounded-xl px-3 py-2 flex items-center gap-2">
                <span className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center" style={{ transform: `rotate(${bearingDeg(techPos, faultPos)}deg)` }}>
                  <svg viewBox="0 0 24 24" width="30" height="30"><path d="M12 2 L21 21 L12 16.5 L3 21 Z" fill="#15803d" stroke="#ffffff" stroke-width="1.4"/></svg>
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] xs:text-xs font-bold text-ink-navy truncate">{routeInfo.inst ? String(routeInfo.inst.text || '').trim() : 'Head'}</p>
                  {myPos && (
                    <p className="text-[10px] font-semibold text-wire-slate">
                      {fmtKm(routeInfo.dist)} • {t('eta')} {routeInfo.eta}
                    </p>
                  )}
                </div>
                <button onClick={toggleRoute} className="ml-auto shrink-0 w-6 h-6 rounded-full flex items-center justify-center hover:bg-haze/60 text-wire-slate">
                  <Icon name="close" className="text-sm" />
                </button>
              </div>
            )}
          </div>
        );
      })()}

      <div className="space-y-8">
        {filteredTasks.length > 0 && (
          <section>
            <h2 className="font-display font-bold text-ink-navy mb-3 flex items-center gap-2">{t('myJobsSection')} <span className="text-xs font-mono bg-surface-container-high px-2 py-0.5 rounded-full text-wire-slate">{filteredTasks.length}</span></h2>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">{filteredTasks.map((c) => <TaskCard key={c._id} c={c} />)}</div>
          </section>
        )}
        {filteredTasks.length === 0 && (
          <EmptyState icon="engineering" title={t('queueClear')} sub={t('queueClearSub')} />
        )}
      </div>

      {/* Sathi AI — on-field assistant for the technician */}
      <ChatAssistant title="Sathi — Technician Assistant" collapsedLabel="Sathi" audience="technician" />

      {/* Accept Task Modal — technician reads description + photo, then sets ETA for citizen */}
      {acceptModal && (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-ink-navy/60 backdrop-blur-sm p-0 sm:p-6" onClick={() => setAcceptModal(null)}>
          <div className="bg-surface w-full sm:max-w-lg max-h-[88vh] sm:max-h-[85vh] rounded-t-3xl sm:rounded-3xl shadow-raised flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-haze bg-paper shrink-0">
              <div className="min-w-0">
                <h3 className="font-display font-bold text-ink-navy text-sm sm:text-base">Accept Task — Set ETA</h3>
                <p className="text-[11px] text-wire-slate mt-0.5">Read the complaint below, then set estimated resolution time for the citizen</p>
              </div>
              <button onClick={() => setAcceptModal(null)} className="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center text-wire-slate shrink-0"><Icon name="close" /></button>
            </div>
            <div className="overflow-y-auto p-5 space-y-4">
              {/* Complaint details — description + photo */}
              {acceptModal.complaint && (
                <div className="bg-paper rounded-xl p-4 border border-haze/60">
                  <div className="flex items-center gap-2 mb-2">
                    <Icon name={acceptModal.complaint.problemVariant === 'broken-wire' ? 'cable' : acceptModal.complaint.problemVariant === 'meter-fault' ? 'electric_meter' : acceptModal.complaint.problemVariant === 'voltage-fluctuation' ? 'show_chart' : acceptModal.complaint.problemVariant === 'streetlight' ? 'lightbulb' : acceptModal.complaint.problemVariant === 'no-power' ? 'power_off' : 'electric_bolt'} fill className="text-circuit-amber text-xl" />
                    <span className="font-display font-bold text-ink-navy capitalize">{String(acceptModal.complaint.problemVariant || '').replace(/-/g, ' ')}</span>
                  </div>
                  {acceptModal.complaint.description && (
                    <div className="bg-surface-container-low rounded-lg p-3 mb-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-wire-slate mb-1">Citizen Description</p>
                      <p className="text-sm text-ink-navy leading-relaxed">{acceptModal.complaint.description}</p>
                    </div>
                  )}
                  {acceptModal.complaint.photoUrl && (
                    <img src={photoUrl(acceptModal.complaint.photoUrl)} alt="Fault photo" className="w-full h-40 object-cover rounded-xl border border-haze" />
                  )}
                </div>
              )}

              {/* ETA input */}
              <div className="bg-circuit-amber/10 border border-circuit-amber/30 rounded-xl p-4">
                <p className="text-[11px] font-bold uppercase tracking-widest text-circuit-amber mb-2 flex items-center gap-1.5">
                  <Icon name="schedule" className="text-sm" /> Estimated Resolution Time
                </p>
                <p className="text-[11px] text-on-surface-variant mb-3">This time will be shown to the citizen. Be realistic based on the problem.</p>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="10"
                    max="720"
                    value={etaInput}
                    onChange={(e) => setEtaInput(e.target.value)}
                    className="flex-1 bg-paper border-2 border-haze rounded-xl px-4 py-3 text-lg font-bold text-ink-navy focus:border-circuit-amber focus:outline-none transition-colors"
                    placeholder="45"
                  />
                  <span className="text-sm font-semibold text-wire-slate">minutes</span>
                </div>
                <div className="flex gap-2 mt-3 flex-wrap">
                  {[30, 60, 120, 180, 300, 360].map((m) => (
                    <button key={m} onClick={() => setEtaInput(String(m))} className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${String(m) === etaInput ? 'bg-circuit-amber text-ink-navy' : 'bg-paper border border-haze text-wire-slate hover:border-circuit-amber'}`}>
                      {m < 60 ? `${m}m` : `${m / 60}h`}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-haze bg-paper flex gap-3 shrink-0">
              <button onClick={() => setAcceptModal(null)} className="flex-1 bg-paper border-2 border-haze text-wire-slate text-sm font-bold py-3 rounded-xl active:scale-[0.98] transition-all">
                Cancel
              </button>
              <button onClick={confirmAccept} className="flex-1 bg-circuit-amber text-ink-navy text-sm font-extrabold py-3 rounded-xl shadow-glow-amber active:scale-[0.98] transition-all flex items-center justify-center gap-2">
                <Icon name="task_alt" className="text-base" /> Accept & Set ETA
              </button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
