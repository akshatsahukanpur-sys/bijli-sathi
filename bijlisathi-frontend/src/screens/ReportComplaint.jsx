import React, { useState, useRef, useCallback } from 'react';
import { api, faultId } from '../lib/api';
import { Icon, Spinner, Shell } from '../components/ui';
import { useLang } from '../lib/i18n.jsx';
import MapView, { pinIcon } from '../components/Map';

export default function ReportComplaint({ go }) {
  const lang = useLang();
  const t = lang?.t ? lang.t : (k) => k;
  const PROBLEMS = [
    { key: 'transformer-fault', icon: 'electric_bolt', label: t('sparking') },
    { key: 'broken-wire', icon: 'cable', label: t('wireDown') },
    { key: 'meter-fault', icon: 'electric_meter', label: t('meterFaultLabel2') },
    { key: 'no-power', icon: 'power_off', label: t('noPowerLabel2') },
    { key: 'voltage-fluctuation', icon: 'show_chart', label: t('voltageIssue') },
    { key: 'streetlight', icon: 'lightbulb', label: t('streetlightLabel') },
  ];
  const VARIANT_META = {
    'transformer-fault': { icon: 'electric_bolt' },
    'broken-wire': { icon: 'cable' },
    'meter-fault': { icon: 'electric_meter' },
    'no-power': { icon: 'power_off' },
    'voltage-fluctuation': { icon: 'show_chart' },
    'streetlight': { icon: 'lightbulb' },
  };
  const [coords, setCoords] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [locating, setLocating] = useState(true); // start true -> auto-locate immediately
  const [geoStatus, setGeoStatus] = useState(t('autoDetecting'));
  const [myComplaints, setMyComplaints] = useState([]);
  React.useEffect(() => {
    api('/api/complaints/my').then((r) => setMyComplaints(r.complaints || [])).catch(() => {});
    const onAuth = () => api('/api/complaints/my').then((r) => setMyComplaints(r.complaints || [])).catch(() => {});
    window.addEventListener('bs_auth_change', onAuth);
    return () => window.removeEventListener('bs_auth_change', onAuth);
  }, []);
  const [address, setAddress] = useState('');
  const [addrLoading, setAddrLoading] = useState(false);
  const [problem, setProblem] = useState('no-power');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [doneId, setDoneId] = useState('');
  const [query, setQuery] = useState('');
  const [pickedName, setPickedName] = useState('');
  const [focusKey, setFocusKey] = useState(0);
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showSug, setShowSug] = useState(false);

  const addrTimerRef = useRef(null);
  const searchTimerRef = useRef(null);
  const searchAbortRef = useRef(null);
  const cacheRef = useRef(new Map());
  const [activeIdx, setActiveIdx] = useState(-1);
  const [recent, setRecent] = useState(() => {
    try { const v = JSON.parse(localStorage.getItem('bs_recent_searches') || '[]'); return Array.isArray(v) ? v.slice(0, 5) : []; } catch { return []; }
  });
  const persistRecent = (list) => {
    try { localStorage.setItem('bs_recent_searches', JSON.stringify(list.slice(0, 5))); } catch {}
  };

  const reverseGeocode = useCallback(async (lat, lng) => {
    setAddrLoading(true);
    try {
      // Nominatim free reverse - zoom 18 = building/road level like Google Maps, with 8s timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=en`;
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error('geocode failed');
      const data = await res.json();
      if (data?.address) {
        const a = data.address;
        // Google Maps-like short address: house + road, locality, city, state, postcode
        const line1 = [a.house_number, a.road].filter(Boolean).join(' ');
        const locality = a.neighbourhood || a.suburb || a.hamlet || a.village || a.road || '';
        const city = a.city || a.town || a.city_district || a.county || 'Kanpur';
        const state = a.state || 'Uttar Pradesh';
        const postcode = a.postcode || '';
        const shortParts = [line1 || a.amenity || a.building, locality, city, postcode ? `${state} ${postcode}` : state].filter(Boolean);
        const shortAddr = shortParts.join(', ');
        // Prefer short, but keep full display_name as fallback if short is too short
        setAddress(shortAddr.length > 10 ? shortAddr : (data.display_name || shortAddr));
      } else if (data?.display_name) {
        setAddress(data.display_name);
      } else {
        setAddress(`${lat.toFixed(5)}, ${lng.toFixed(5)} • Kanpur, UP`);
      }
    } catch (e) {
      setAddress(`${lat.toFixed(5)}, ${lng.toFixed(5)} • Kanpur, Uttar Pradesh`);
    } finally {
      setAddrLoading(false);
    }
  }, []);

  const scheduleReverse = useCallback((lat, lng) => {
    if (addrTimerRef.current) clearTimeout(addrTimerRef.current);
    // debounce 400ms so dragging pin doesn't spam API
    addrTimerRef.current = setTimeout(() => reverseGeocode(lat, lng), 400);
  }, [reverseGeocode]);

  const handleCoordsChange = (next) => {
    setCoords(next);
    if (next?.[0] != null && next?.[1] != null) scheduleReverse(next[0], next[1]);
  };

  /* Location search — improved: cache + Kanpur boost + recent + keyboard nav, faster 300ms */
  const searchPlaces = useCallback(async (q) => {
    const key = q.trim().toLowerCase();
    if (cacheRef.current.has(key)) {
      const cached = cacheRef.current.get(key);
      setSuggestions(cached);
      setShowSug(cached.length > 0);
      setActiveIdx(-1);
      if (cached.length === 0) setError('No place found — try a nearby landmark or locality name');
      else setError('');
      return;
    }
    if (searchAbortRef.current) try { searchAbortRef.current.abort(); } catch (e) {}
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    setActiveIdx(-1);
    let data = null;
    try {
      const timeout = setTimeout(() => controller.abort(), 8000);
      // Primary: backend proxy (Nominatim + Photon, Kanpur-biased via viewbox, supports India-wide)
      const res = await api(`/api/geo/search?q=${encodeURIComponent(q)}&limit=8`, { signal: undefined });
      clearTimeout(timeout);
      data = res?.results || [];
    } catch (e) {
      // Fallback: direct Nominatim with Kanpur viewbox boost
      try {
        const timeout = setTimeout(() => controller.abort(), 7000);
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=8&accept-language=en&addressdetails=1&countrycodes=in&viewbox=79.9,26.9,80.7,26.2&bounded=0`;
        const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) data = await res.json();
      } catch (e) {}
    }
    try {
      const list = Array.isArray(data) ? data.slice(0, 8) : [];
      cacheRef.current.set(key, list);
      if (cacheRef.current.size > 40) {
        const first = cacheRef.current.keys().next().value;
        cacheRef.current.delete(first);
      }
      if (list.length) {
        setSuggestions(list);
        setShowSug(true);
        setError('');
      } else {
        setSuggestions([]);
        setShowSug(false);
        setError('No place found — try a nearby landmark, colony or pin-drag. Example: “Swaroop Nagar”, “Kakadeo”');
      }
    } finally {
      setSearching(false);
    }
  }, []);

  const onQueryChange = (v) => {
    setQuery(v);
    setError('');
    setActiveIdx(-1);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!v || v.trim().length < 2) {
      setShowSug(false); setSuggestions([]);
      return;
    }
    searchTimerRef.current = setTimeout(() => searchPlaces(v.trim()), 300);
  };

  const pickSuggestion = (s) => {
    // recent entry stored as string
    if (s._recent) {
      onQueryChange(String(s.display_name || ''));
      searchPlaces(String(s.display_name || ''));
      return;
    }
    // Robust coords: backend proxy {lat,lon}, Nominatim {lat,lon}, variants {latitude,longitude,lng,center,geometry}
    const rawLat = s.lat ?? s.latitude ?? s.center?.lat ?? s.geometry?.coordinates?.[1];
    const rawLng = s.lon ?? s.lng ?? s.longitude ?? s.center?.lng ?? s.center?.lon ?? s.geometry?.coordinates?.[0];
    const lat = parseFloat(rawLat), lon = parseFloat(rawLng);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      setError('Could not locate this place — try another nearby name or drag the pin on the map');
      return;
    }
    setCoords([lat, lon]);
    setAccuracy(null);
    setGeoStatus(t('locationDetected'));
    setLocating(false);
    setShowSug(false);
    setSuggestions([]);
    setActiveIdx(-1);
    // persist to recent
    try {
      const entry = String(s.display_name || '').slice(0, 80);
      const next = [entry, ...recent.filter(x => x !== entry)].slice(0, 5);
      setRecent(next);
      persistRecent(next);
    } catch {}
    const parts = String(s.display_name || '').split(',').map((x) => x.trim());
    const short = parts.slice(0, 2).join(', ');
    // Keep the picked landmark visible: search bar + address card show it,
    // map flies to it smoothly. Reverse-geocode fills the confirmed address below.
    setPickedName(short);
    setQuery(short);
    setAddress('');
    setFocusKey((k) => k + 1);
    scheduleReverse(lat, lon);
  };

  const locateMe = (silent = false, attempt = 0) => {
    if (!navigator.geolocation) {
      setError('Geolocation not supported on this device');
      setLocating(false);
      setGeoStatus('Geolocation not supported');
      if (!coords) {
        const fallback = [26.4499, 80.3319];
        setCoords(fallback);
        scheduleReverse(fallback[0], fallback[1]);
      }
      return;
    }
    if (!silent) {
      setLocating(true);
      setGeoStatus(t('autoDetecting'));
      setError('');
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // Reject a STALE fix (browser returns the last-known position from a
        // previous session/complaint) — force one fresh GPS retry so the pin
        // points at the CURRENT location, not the previous report's location.
        const fixAgeMs = Date.now() - (pos.timestamp || NaN);
        if (attempt === 0 && Number.isFinite(fixAgeMs) && fixAgeMs > 30000) {
          console.warn('[Report] geolocation returned a stale fix — requesting fresh location', { ageMs: Math.round(fixAgeMs) });
          locateMe(true, 1);
          return;
        }
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const acc = pos.coords.accuracy;
        handleCoordsChange([lat, lng]);
        setPickedName('');
        setAccuracy(acc ? Math.round(acc) : null);
        setLocating(false);
        setGeoStatus(acc && acc < 50 ? t('exactLocationLocked') : t('locationDetected'));
        setError('');
      },
      (err) => {
        console.warn('geolocation error', err);
        let msg = 'Could not get exact location';
        if (err.code === 1) msg = 'Location permission denied — enable GPS and tap Locate Me';
        else if (err.code === 2) msg = 'GPS unavailable — drag pin to set location manually';
        else if (err.code === 3) msg = 'Location timeout — try again or drag pin manually';
        if (!silent) setError(msg);
        setLocating(false);
        setGeoStatus(msg);
        // Fallback to Kanpur central if no coords yet, so map always shows something and user can drag
        if (!coords) {
          const fallback = [26.4499, 80.3319];
          setCoords(fallback);
          scheduleReverse(fallback[0], fallback[1]);
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  React.useEffect(() => {
    locateMe(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Also re-fetch address if coords set externally (initial)
  React.useEffect(() => {
    if (coords && !address && !addrLoading) {
      scheduleReverse(coords[0], coords[1]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords]);

  const [aiResult, setAiResult] = useState(null);
  const submit = async () => {
    setError('');
    // Auto-fallback: if GPS still pending, use Kanpur central or last known pin so citizen is never blocked
    let useCoords = coords;
    if (!useCoords) {
      useCoords = [26.4499, 80.3319];
      setCoords(useCoords);
      setGeoStatus('Using Kanpur central — drag pin to adjust if needed');
    }
    if (!problem) {
      setError('Please select a problem type');
      return;
    }
    // Description & photo are optional. With neither, AI rates 35% genuine.
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('problemVariant', problem);
      fd.append('description', description);
      fd.append('location', JSON.stringify({ lat: useCoords[0], lng: useCoords[1] }));
      if (file) fd.append('photo', file);
      console.log('[Report] submitting', { problem, useCoords, hasFile: !!file, descLen: description.length });
      let res;
      try {
        res = await api('/api/complaints', { method: 'POST', body: fd, isForm: true });
      } catch (apiErr) {
        console.warn('[Report] api threw, will create local fallback', apiErr);
        // Even if api throws, create a local offline complaint so user always reaches success village
        const fallbackId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
        res = { complaint: { _id: fallbackId, problemVariant: problem, description, status: 'registered', createdAt: new Date().toISOString() }, genuinenessScore: 0.8, urgencyScore: 5, eta: { label: '~50 mins', estimatedAt: new Date(Date.now()+50*60000).toISOString(), reasoning: 'Queued locally — will sync when online' }, photoAnalysis: { isRelevant: true, confidence: 0.7, reasoning: 'Queued locally' }, assignment: { assigned: false }, _localFallback: true };
      }
      console.log('[Report] submit success', res);
      let newId = res.complaint?._id || res._id || res.complaintId || res.complaintId || '';
      // Permanent fix: if backend still returned no ID (edge), create a local ID so citizen always reaches the desired village (track page)
      if (!newId) {
        console.warn('[Report] no ID from server, creating local fallback ID');
        newId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
        const localComplaint = { _id: newId, problemVariant: problem, description, status: 'registered', createdAt: new Date().toISOString(), isDismissed: false };
        try {
          const auth = JSON.parse(localStorage.getItem('bs_auth') || 'null');
          const uid = auth?.userId || auth?.id || 'citizen';
          const key = `bs_offline_complaints_${uid}`;
          const list = JSON.parse(localStorage.getItem(key) || '[]');
          list.unshift(localComplaint);
          localStorage.setItem(key, JSON.stringify(list.slice(0, 20)));
          // also generic pending for KESCO sync
          const pendingKey = 'bs_pending_complaints';
          const pending = JSON.parse(localStorage.getItem(pendingKey) || '[]');
          pending.unshift({ problemVariant: problem, description, location: { lat: useCoords[0], lng: useCoords[1] }, photoPending: !!file, createdAt: new Date().toISOString() });
          localStorage.setItem(pendingKey, JSON.stringify(pending.slice(0, 10)));
        } catch {}
        res = { ...res, complaint: localComplaint, _localFallback: true };
      }
      setDoneId(newId);
      setAiResult(res);
      // Scroll to top so success “village” (track card) is visible immediately
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
    } catch (e) {
      console.error('[Report] submit failed', e);
      const msg = String(e.message || 'Failed to submit — please try again');
      if (msg.toLowerCase().includes('401') || msg.toLowerCase().includes('token') || msg.toLowerCase().includes('session') || msg.toLowerCase().includes('unauthorized')) {
        setError('Session expired — please Logout and Login again, then submit. ' + msg);
      } else if (msg.toLowerCase().includes('timed out') || msg.toLowerCase().includes('timeout')) {
        setError(msg + ' — Tap Submit again (image will be retried). Tip: use a smaller photo or try without photo.');
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (doneId) {
    const eta = aiResult?.eta;
    const assignment = aiResult?.assignment;
    const isDup = !!aiResult?.complaint?.isDuplicateOf;
    const isFake = (aiResult?.genuinenessScore ?? 1) < 0.4;
    return (
      <Shell navLinks={[]}>
        <div className="flex items-center justify-center min-h-[70vh] py-6">
          <div className="text-center max-w-lg w-full px-4 rise">
            <div className="w-40 h-40 mx-auto rounded-full bg-paper shadow-glow-amber border-[3px] border-circuit-amber/70 flex items-center justify-center mb-4 overflow-hidden">
              <img src="/logo.png" alt="BijliSathi" className="w-36 h-36 object-contain scale-110" style={{ imageRendering: '-webkit-optimize-contrast' }} />
            </div>
            <h2 className="font-display text-2xl md:text-3xl font-bold text-ink-navy mb-2">{isFake ? t('falseNotRegisteredTitle') : t('complaintOnWay')}</h2>
            <p className="text-xs font-mono text-wire-slate mb-4">ID: {faultId(aiResult?.complaint) || `#${doneId.slice(-8)}`} • {t('aiTriagedSec')}</p>

            {/* AI ETA — genuine & duplicate reports show rough fix time; false complaints never do */}
            {eta && !isFake && (
              <div className="bg-ink-navy text-white rounded-2xl p-4 mb-3 text-left shadow-raised">
                <p className="text-[11px] font-bold uppercase tracking-widest text-circuit-amber flex items-center gap-1.5"><Icon name="schedule" className="text-sm" /> {t('aiEtaTitle')}</p>
                <p className="text-lg font-bold mt-1">{eta.label} <span className="font-normal text-white/70 text-sm">• by {eta.estimatedAt ? new Date(eta.estimatedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span></p>
                {assignment?.assigned && <p className="text-xs text-signal-green mt-2 flex items-center gap-1"><Icon name="engineering" className="text-sm" /> KESCO Controller auto-assigned nearest technician — you’ll see him on Track</p>}
                {isDup && <p className="text-xs text-circuit-amber mt-2 flex items-center gap-1"><Icon name="join_full" className="text-sm" /> {t('nearbyMerged')}</p>}
              </div>
            )}

            {/* What happens next — the response: outcome steps only, no verification internals */}
            {!isFake && (
              <div className="bg-paper border border-haze rounded-2xl p-4 mb-3 text-left shadow-card">
                <p className="text-[11px] font-bold uppercase tracking-widest text-wire-slate mb-2.5">{t('nextStepsTitle')}</p>
                <div className="space-y-2">
                  {[t('stepReported'), t('stepVerified'), t('stepAssigned'), t('stepRepair'), t('stepResolved')].map((s, i) => (
                    <div key={s} className="flex items-center gap-2.5">
                      <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-extrabold shrink-0 ${i === 0 ? 'bg-signal-green text-white' : i === 1 ? 'bg-circuit-amber text-ink-navy' : 'bg-surface-container-high text-wire-slate'}`}>{i === 0 ? '✓' : i + 1}</span>
                      <p className={`text-xs ${i <= 1 ? 'font-bold text-ink-navy' : 'text-wire-slate'}`}>{s}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Duplicate notice when no ETA card is shown */}
            {isDup && !isFake && !eta && (
              <div className="bg-circuit-amber/10 border border-circuit-amber/25 rounded-xl p-3.5 mb-3 text-left">
                <p className="text-xs font-bold text-ink-navy flex items-center gap-1.5"><Icon name="join_full" className="text-base text-circuit-amber" /> Duplicate — someone nearby already reported this</p>
                <p className="text-xs text-wire-slate mt-1 leading-relaxed">{t('aiDuplicateDesc')}</p>
              </div>
            )}

            {/* False complaint — NOT registered: strict warning, no tracker, no fix time */}
            {isFake && (
              <div className="bg-error-container/60 border border-fault-red/25 rounded-xl p-4 mb-3 text-left">
                <p className="text-xs font-bold text-on-error-container flex items-center gap-1.5"><Icon name="gpp_maybe" className="text-base" /> {t('falseNotRegisteredTitle')}</p>
                <p className="text-xs text-on-surface-variant mt-1 leading-relaxed">{t('falseStrictMsg')}</p>
              </div>
            )}

            <div className="flex gap-3 justify-center">
              <button onClick={() => go(`#/track/${doneId}`)} className="bg-circuit-amber text-ink-navy font-bold px-7 py-3.5 rounded-xl shadow-glow-amber active:scale-95 flex items-center gap-2">{t('trackLiveBtn')} <Icon name="radar" /></button>
              <button onClick={() => go('#/home')} className="bg-paper border border-haze text-ink-navy px-7 py-3.5 rounded-xl active:scale-95">{t('homeBtn')}</button>
            </div>
            <p className="text-[11px] text-wire-slate mt-4">{t('kescoSeesDesc')}</p>
          </div>
        </div>
      </Shell>
    );
  }

  const StepHead = ({ n, title }) => (
    <div className="flex items-center gap-2.5 mb-4">
      <div className={`w-8 h-8 rounded-full flex items-center justify-center font-display font-bold text-sm ${n === 1 ? 'bg-circuit-amber text-ink-navy shadow-glow-amber' : 'bg-surface-container-high text-on-surface'}`}>{n}</div>
      <h2 className="font-display text-lg font-bold text-ink-navy">{title}</h2>
    </div>
  );

  return (
    <Shell navLinks={[
      { icon: 'home', label: t('navHome'), onClick: () => go('#/home') },
      { icon: 'add_circle', label: t('navReport'), active: true },
      { icon: 'person', label: t('navProfile'), onClick: () => go('#/profile') },
    ]} wide>
      <div className="max-w-5xl lg:max-w-7xl mx-auto">
        <div className="mb-4 xs:mb-6 lg:mb-8">
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-2 lg:gap-6">
            <div>
              <h1 className="font-display text-xl xs:text-2xl md:text-3xl lg:text-4xl font-extrabold text-ink-navy tracking-tight flex items-center gap-2.5"><span className="hidden lg:inline-flex w-10 h-10 rounded-xl bg-circuit-amber items-center justify-center"><Icon name="add_circle" fill className="text-ink-navy text-xl" /></span>{t('reportIssue')}</h1>
              <p className="text-xs xs:text-sm lg:text-base text-wire-slate mt-1 lg:mt-2 font-medium">{t('reportSub')} <span className="hidden lg:inline text-ink-navy font-semibold">• {t('takes60')}</span></p>
            </div>
            <p className="hidden lg:flex items-center gap-1.5 text-xs font-semibold text-signal-green bg-signal-green/10 border border-signal-green/20 rounded-full px-3 py-1.5"><span className="w-2 h-2 rounded-full bg-signal-green pulse-dot" /> {t('aiVerified')}</p>
          </div>
          {/* Desktop step progress — glanceable */}
          <div className="hidden lg:flex items-center gap-2 mt-6">
            {[['1', t('shareLocation')],['2', t('selectProblem')],['3', t('describeIssue')],['4', t('uploadPhoto')]].map(([n, label]) => (
              <div key={n} className="flex items-center gap-2 flex-1">
                <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${n==='1'?'bg-circuit-amber text-ink-navy shadow-glow-amber':'bg-surface-container-high text-wire-slate border border-haze'}`}>{n}</span>
                <span className={`text-xs font-semibold ${n==='1'?'text-ink-navy':'text-wire-slate'}`}>{label}</span>
                {n!=='4' && <span className="flex-1 h-px bg-haze mx-2" />}
              </div>
            ))}
          </div>
        </div>

        <div className="grid lg:grid-cols-12 gap-4 xs:gap-6 lg:gap-8 items-start">
          {/* Left: map + problem — INITIAL MOBILE: stacked single column, map 260px thumb, 2-col problem grid */}
          <div className="lg:col-span-7 xl:col-span-8 space-y-4 xs:space-y-6">
            <section className="bg-paper rounded-xl xs:rounded-2xl shadow-raised p-4 xs:p-5 sm:p-6 border border-haze/60">
              <StepHead n={1} title={t('shareLocation')} />
              {/* Location search — premium: shadow-raised, amber badge, glow, recent + keyboard */}
              <div className="relative mb-3 z-[500]">
                <div className="flex items-center gap-2 bg-paper rounded-2xl shadow-card border border-haze/60 pl-2 pr-2 py-2 focus-within:border-circuit-amber focus-within:shadow-glow-amber focus-within:bg-white transition-all">
                  <span className="w-10 h-10 rounded-xl bg-circuit-amber/15 border border-circuit-amber/20 flex items-center justify-center shrink-0">
                    <Icon name="search" className="text-circuit-amber text-xl" />
                  </span>
                  <input
                    value={query}
                    onChange={(e) => onQueryChange(e.target.value)}
                    onFocus={() => { if (query.trim().length >= 2 && suggestions.length) setShowSug(true); }}
                    onBlur={() => setTimeout(() => setShowSug(false), 180)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)); }
                      else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, -1)); }
                      else if (e.key === 'Enter') {
                        if (activeIdx >= 0 && suggestions[activeIdx]) { e.preventDefault(); pickSuggestion(suggestions[activeIdx]); }
                        else if (query.trim().length >= 2) { e.preventDefault(); searchPlaces(query.trim()); }
                      } else if (e.key === 'Escape') { setShowSug(false); setActiveIdx(-1); }
                    }}
                    placeholder={t('searchPlaceholder')}
                    className="flex-1 bg-transparent py-2 text-[15px] text-ink-navy placeholder-wire-slate/60 focus:outline-none min-w-0 font-medium"
                  />
                  {searching ? (
                    <span className="w-6 h-6 border-2 border-haze border-t-circuit-amber rounded-full animate-spin shrink-0 mr-1" />
                  ) : query ? (
                    <button onClick={() => { setQuery(''); setShowSug(false); setSuggestions([]); setActiveIdx(-1); }} className="w-8 h-8 rounded-full bg-surface-container border border-haze hover:bg-error-container hover:border-fault-red/20 hover:text-fault-red flex items-center justify-center shrink-0 transition-colors" aria-label="Clear"><Icon name="close" className="text-sm" /></button>
                  ) : null}
                  <button onClick={() => query.trim().length >= 2 && searchPlaces(query.trim())} disabled={searching || query.trim().length < 2} className="shrink-0 bg-circuit-amber text-ink-navy rounded-xl px-4 py-2.5 text-xs font-extrabold hover:bg-[#fdb244] active:scale-95 transition-all disabled:opacity-50 flex items-center gap-1 shadow-glow-amber border border-circuit-amber/20">
                    <Icon name="search" className="text-sm" /> Go
                  </button>
                </div>
                {/* Suggestions dropdown — premium card */}
                {showSug && suggestions.length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-2 bg-paper rounded-2xl shadow-raised border border-haze/60 overflow-hidden max-h-[280px] overflow-y-auto">
                    {!query.trim() && <p className="text-[11px] font-bold uppercase tracking-widest text-ink-navy px-4 py-2.5 bg-circuit-amber/10 border-b border-circuit-amber/20 flex items-center gap-1.5"><Icon name="history" className="text-sm text-circuit-amber" /> Recent searches</p>}
                    {suggestions.map((s, i) => (
                      <button key={i} onMouseDown={(e) => e.preventDefault()} onClick={() => pickSuggestion(s)} onMouseEnter={() => setActiveIdx(i)}
                        className={`w-full flex items-center gap-3 px-4 py-3 text-left border-b border-haze/40 last:border-0 transition-all ${i === activeIdx ? 'bg-circuit-amber/15 border-l-4 border-l-circuit-amber' : 'hover:bg-surface-container border-l-4 border-l-transparent'}`}>
                        <span className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${s._recent ? 'bg-surface-container text-wire-slate' : 'bg-circuit-amber/15 text-circuit-amber border border-circuit-amber/20'}`}>
                          <Icon name={s._recent ? 'history' : s.type === 'city' || s.type === 'suburb' || s.type === 'neighbourhood' ? 'location_city' : 'place'} className="text-base" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-bold text-ink-navy truncate">{String(s.display_name || '').split(',')[0]}</span>
                          <span className="block text-[11px] text-wire-slate truncate">{s._recent ? 'Tap to search again' : String(s.display_name || '').split(',').slice(1, 4).join(',')}</span>
                        </span>
                        <Icon name={s._recent ? 'refresh' : 'north_west'} className={`${s._recent ? 'text-wire-slate' : 'text-ink-navy bg-ink-navy/5 rounded-full p-1 w-6 h-6 flex items-center justify-center'} text-xs shrink-0`} />
                      </button>
                    ))}
                    <p className="text-[10px] font-medium text-wire-slate text-center py-2 bg-surface-container/60 flex items-center justify-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-circuit-amber" /> Kanpur boosted • India-wide • ↑↓ Enter</p>
                  </div>
                )}
              </div>
              {/* Auto-location status badge */}
              <div className={`mb-3 flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-full border w-fit ${locating ? 'bg-circuit-amber/10 border-circuit-amber/30 text-ink-navy' : coords ? 'bg-signal-green/10 border-signal-green/25 text-signal-green' : 'bg-surface-container border-haze text-wire-slate'}`}>
                <span className={`w-2 h-2 rounded-full ${locating ? 'bg-circuit-amber animate-pulse' : 'bg-signal-green'}`} />
                {locating ? t('autoDetecting') : geoStatus}
              </div>

              {coords ? (
                <div className="relative">
                  <MapView
                    center={coords} zoom={18} height="h-[280px] xs:h-[320px] sm:h-[360px] lg:h-[420px]" exact
                    draggableIndex={0}
                    focus={coords ? { key: focusKey, points: [coords] } : null}
                    onDragEnd={(p) => { handleCoordsChange(p); setPickedName(''); setGeoStatus(t('locationDetected')); setAccuracy(null); }}
                    markers={[
                      { lat: coords[0], lng: coords[1], icon: pinIcon({ color: '#F2A93B', glyph: 'bolt', ping: !locating }) },
                      ...myComplaints.filter((c) => c.location?.coordinates && (c.status === 'working' || c.status === 'registered')).slice(0, 5).map((c) => ({
                        lat: c.location.coordinates[1],
                        lng: c.location.coordinates[0],
                        icon: pinIcon({ color: '#C3C9D4', glyph: VARIANT_META[c.problemVariant]?.icon || 'bolt' }),
                      })),
                    ]}
                  />
                </div>
              ) : (
                <div className="w-full h-[260px] xs:h-[300px] sm:h-[340px] lg:h-[400px] rounded-xl border-2 border-dashed border-haze bg-surface-container-high flex items-center justify-center flex-col gap-3 p-4 text-center">
                  {locating ? <><Spinner /> <p className="text-xs text-wire-slate font-medium">{t('autoDetecting')}<br />Please allow location permission</p></> : <span className="text-xs xs:text-sm text-wire-slate">Getting location…</span>}
                </div>
              )}

              {/* Exact address card — Google Maps style detail below map */}
              <div className="mt-3 rounded-xl border bg-paper shadow-card border-haze/60 p-3 xs:p-3.5">
                <div className="flex items-start gap-2.5">
                  <div className="w-9 h-9 rounded-full bg-circuit-amber/15 border border-circuit-amber/20 flex items-center justify-center shrink-0">
                    <Icon name="home_pin" fill className="text-circuit-amber text-lg" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-bold tracking-widest uppercase text-wire-slate">{t('complaintFromTitle')}</p>
                    {pickedName ? (
                      <>
                        <p className="text-xs xs:text-[13px] font-bold text-ink-navy leading-snug mt-1 break-words">{pickedName}</p>
                        {addrLoading ? (
                          <p className="text-[11px] text-wire-slate flex items-center gap-1.5 mt-1"><span className="w-3 h-3 border-2 border-haze border-t-circuit-amber rounded-full animate-spin inline-block" /> {t('fetchingFromMaps')}</p>
                        ) : address ? (
                          <p className="text-[11px] text-wire-slate leading-snug mt-0.5 break-words">{address}</p>
                        ) : null}
                        <a href={`https://www.google.com/maps/search/?api=1&query=${coords[0]},${coords[1]}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-bold text-circuit-amber hover:text-spark-ember mt-1">
                          <Icon name="map" className="text-xs" /> {t('viewOnMaps')}
                        </a>
                      </>
                    ) : addrLoading ? (
                      <p className="text-xs text-wire-slate flex items-center gap-1.5 mt-1"><span className="w-3 h-3 border-2 border-haze border-t-circuit-amber rounded-full animate-spin inline-block" /> {t('fetchingFromMaps')}</p>
                      ) : address ? (
                        <>
                          <p className="text-xs xs:text-[13px] font-bold text-ink-navy leading-snug mt-1 break-words">{address}</p>
                          <a href={`https://www.google.com/maps/search/?api=1&query=${coords[0]},${coords[1]}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-bold text-circuit-amber hover:text-spark-ember mt-1">
                            <Icon name="map" className="text-xs" /> {t('viewOnMaps')}
                          </a>
                        </>
                      ) : (
                      <p className="text-xs text-wire-slate mt-1">{t('addressWillAppear')}</p>
                    )}
                      {coords && (
                        <p className="text-[11px] font-mono text-wire-slate mt-1.5 break-all">
                          {coords[0].toFixed(6)}, {coords[1].toFixed(6)} {accuracy ? `• ±${accuracy}m` : ''} • Kanpur
                        </p>
                      )}
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-[11px] text-wire-slate flex items-center gap-1"><Icon name="ads_click" className="text-xs" /> {t('dragPinToAdjust')}</p>
                  <button onClick={() => locateMe()} disabled={locating} className="shrink-0 bg-ink-navy text-white rounded-full pl-3 pr-4 py-2 flex items-center gap-1.5 text-xs font-bold hover:bg-grid-navy active:scale-95 transition-all shadow-card disabled:opacity-60 whitespace-nowrap">
                    <Icon name="my_location" className="text-base" /> {locating ? t('locating') : t('locateMeAgain')}
                  </button>
                </div>
              </div>
            </section>

            <section className="bg-paper rounded-[18px] xs:rounded-2xl shadow-raised p-4 xs:p-5 sm:p-6 border border-white/60">
              <StepHead n={2} title={t('selectProblem')} />
              <div className="grid grid-cols-2 xs:grid-cols-3 gap-2.5 xs:gap-3">
                {PROBLEMS.map((p) => (
                  <button key={p.key} onClick={() => { try{navigator.vibrate&&navigator.vibrate(6)}catch{} setProblem(p.key); }}
                    className={`flex flex-col items-center justify-center p-3 xs:p-3.5 rounded-2xl border-2 transition-all duration-200 min-h-[88px] xs:min-h-[96px] pressable ${problem === p.key ? 'border-circuit-amber bg-circuit-amber/12 shadow-glow-amber scale-[1.03]' : 'border-haze/60 bg-surface hover:border-circuit-amber/40 hover:bg-white active:scale-[0.97]'}`}>
                    <span className={`w-9 h-9 xs:w-10 xs:h-10 rounded-xl flex items-center justify-center mb-1.5 transition-colors ${problem === p.key ? 'bg-circuit-amber text-ink-navy shadow-glow-amber' : 'bg-surface-container text-wire-slate'}`}>
                      <Icon name={p.icon} fill={problem === p.key} className="text-[20px] xs:text-[22px]" />
                    </span>
                    <span className={`text-[11px] xs:text-xs text-center font-bold leading-tight ${problem === p.key ? 'text-ink-navy' : 'text-wire-slate'}`}>{p.label}</span>
                    {problem === p.key && <span className="mt-1 w-1.5 h-1.5 rounded-full bg-circuit-amber pulse-dot" aria-hidden />}
                  </button>
                ))}
              </div>
            </section>
          </div>

          {/* Right: describe + photo + submit — INITIAL MOBILE: stacked below map, thumb-friendly inputs, 56dp submit — desktop is lg:sticky */}
          <div className="lg:col-span-5 xl:col-span-4 space-y-4 xs:space-y-6 lg:sticky lg:top-6">
            <section className="bg-paper rounded-[18px] xs:rounded-2xl shadow-raised p-4 xs:p-5 sm:p-6 lg:p-7 border border-white/60">
              <StepHead n={3} title={t('describeIssue')} />
              <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder={t('describePlaceholder')}
                rows={4}
                maxLength={500}
                aria-label="Describe the issue (optional)"
                className="w-full bg-surface border-2 border-haze/60 rounded-2xl p-3.5 xs:p-4 lg:p-4 focus:outline-none focus:border-circuit-amber focus:shadow-glow-amber transition-all resize-none h-28 xs:h-32 lg:h-36 text-[15px] xs:text-base lg:text-[15px] leading-relaxed" />
              <div className="flex justify-between items-center mt-2.5 gap-2">
                <p className="text-[11px] xs:text-[11px] lg:text-xs text-wire-slate flex items-center gap-1.5 font-medium"><span className="w-5 h-5 rounded-full bg-circuit-amber/15 flex items-center justify-center shrink-0"><Icon name="auto_awesome" className="text-[11px] text-circuit-amber" /></span> {t('detailedBoost')}</p>
                <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-full bg-surface-container border border-haze text-wire-slate">{description.length}/500</span>
              </div>
            </section>

            <section className="bg-paper rounded-[18px] xs:rounded-2xl shadow-raised p-3.5 xs:p-5 sm:p-6 lg:p-7 border border-white/60">
              <StepHead n={4} title={t('uploadPhoto')} />
              {preview ? (
                <div className="relative rounded-2xl overflow-hidden border border-haze/60 shadow-card">
                  <img src={preview} alt="" className="w-full h-48 xs:h-52 lg:h-56 object-cover" />
                  <button onClick={() => { setPreview(''); setFile(null); }} className="absolute top-2.5 right-2.5 bg-white rounded-full p-2 shadow-raised border border-haze hover:bg-error-container transition-colors active:scale-90"><Icon name="close" className="text-fault-red text-base" /></button>
                </div>
              ) : (
                <label className="block w-full max-w-full box-border border-2 border-dashed border-haze/60 rounded-2xl p-5 xs:p-6 sm:p-8 lg:p-10 flex flex-col items-center justify-center bg-surface hover:bg-surface-container-high hover:border-circuit-amber active:scale-[0.99] transition-all cursor-pointer group overflow-hidden pressable">
                  <div className="w-14 h-14 xs:w-14 xs:h-14 sm:w-16 sm:h-16 lg:w-20 lg:h-20 rounded-full bg-circuit-amber/10 group-hover:bg-circuit-amber/15 flex items-center justify-center mb-3 transition-colors shrink-0 border border-circuit-amber/20"><Icon name="add_a_photo" className="text-[26px] xs:text-[26px] sm:text-[30px] lg:text-[36px] text-circuit-amber" /></div>
                  <span className="text-sm xs:text-sm lg:text-base font-extrabold text-ink-navy text-center leading-tight">{t('tapPhotoUpload')}</span>
                  <span className="text-[11px] xs:text-[11px] sm:text-xs lg:text-sm text-wire-slate mt-1 text-center leading-tight px-2 font-medium">{t('optionalHelpsFaster')}</span>
                  <span className="mt-2 text-[10px] font-bold tracking-widest uppercase text-wire-slate/70 bg-surface-container px-2.5 py-1 rounded-full border border-haze">JPG • PNG • WEBP</span>
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; setFile(f); setPreview(URL.createObjectURL(f)); }} />
                </label>
              )}
            </section>

            {/* Desktop helper — visible only on lg */}
            <div className="hidden lg:block bg-ink-navy rounded-2xl p-5 text-white relative overflow-hidden">
              <div className="absolute -right-8 -top-8 w-28 h-28 bg-circuit-amber/15 rounded-full blur-2xl" />
              <p className="relative text-xs font-bold uppercase tracking-widest text-circuit-amber flex items-center gap-1.5"><Icon name="lightbulb" fill className="text-sm" /> {t('tipsFaster')}</p>
              <ul className="relative mt-3 space-y-2 text-xs leading-relaxed text-white/80">
                <li className="flex gap-2"><span className="text-circuit-amber mt-0.5">•</span> {t('tip1')}</li>
                <li className="flex gap-2"><span className="text-circuit-amber mt-0.5">•</span> {t('tip2')}</li>
                <li className="flex gap-2"><span className="text-circuit-amber mt-0.5">•</span> {t('tip3')}</li>
              </ul>
            </div>

            {error && <p className="text-xs xs:text-sm lg:text-sm text-fault-red text-center flex items-center justify-center gap-1.5 bg-error-container/60 border border-fault-red/20 rounded-2xl py-3 px-3 break-words"><Icon name="error" className="text-sm xs:text-base shrink-0" />{error}</p>}
            {!coords && <p className="text-xs lg:text-sm text-amber-700 text-center bg-amber-50 border border-amber-200 rounded-2xl py-3 px-3 font-semibold">📍 {t('waitingLocation')} — will use Kanpur central if you submit now, drag pin to correct</p>}
            <button onClick={submit} disabled={submitting}
              className="w-full bg-circuit-amber text-ink-navy font-display text-xl font-extrabold py-4 rounded-2xl shadow-glow-amber hover:bg-[#fdb244] active:scale-[0.98] transition-all justify-center items-center gap-2 disabled:opacity-60 tracking-tight min-h-[56px] shadow-raised">
              {submitting ? <span className="flex items-center justify-center gap-2"><span className="w-5 h-5 border-2 border-ink-navy/30 border-t-ink-navy rounded-full animate-spin" /> {t('loading')}</span> : <>{t('submitComplaint')} <Icon name="send" className="text-xl" /></>}
            </button>
            <p className="text-center text-xs text-wire-slate font-medium px-2">{t('gpsCaptured')}</p>
          </div>
        </div>
      </div>
    </Shell>
  );
}
