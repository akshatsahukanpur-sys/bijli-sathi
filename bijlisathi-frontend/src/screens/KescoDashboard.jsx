import React, { useEffect, useState } from 'react';
import { api, photoUrl, clearAuth, faultId } from '../lib/api';
import { Icon, StatCard, MiniBars, Shell, CallSheet } from '../components/ui';
import { useLang } from '../lib/i18n.jsx';
import ChatAssistant from '../components/ChatAssistant';

const VARIANT_GLYPH = {
  'transformer-fault': 'electric_bolt',
  'broken-wire': 'cable',
  'meter-fault': 'electric_meter',
  'no-power': 'power_off',
  'voltage-fluctuation': 'show_chart',
  'streetlight': 'lightbulb',
};

export default function KescoDashboard({ go }) {
  const { t } = useLang();
  const PRIORITY = (c) => (c.genuinenessScore < 0.4 ? [t('falseFlagsStat'), 'bg-surface-container-high text-wire-slate'] : c.urgencyScore >= 6 ? [t('critical'), 'bg-error-container text-on-error-container'] : c.urgencyScore >= 3 ? [t('high'), 'bg-secondary-fixed/70 text-on-secondary-container'] : [t('normal'), 'bg-surface-container-high text-wire-slate']);
  const STATUS_TAG = (s) => ({ registered: [t('dispatching'), 'bg-circuit-amber/15 text-circuit-amber'], working: [t('inProgress'), 'bg-secondary-container text-on-secondary-container'], resolved: [t('filterResolved'), 'bg-signal-green/15 text-signal-green'] }[s] || ['—', '']);
  const [ov, setOv] = useState({});
  const [complaints, setComplaints] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [aiQueue, setAiQueue] = useState(null);
  const [console_, setConsole] = useState(false);
  const [cFilter, setCFilter] = useState('open');
  const [busyAssign, setBusyAssign] = useState('');
  // Citizen history modal
  const [citizenHistory, setCitizenHistory] = useState({ open: false, meterNumber: '', name: '', complaints: [], loading: false });
  // Technician history modal (open by clicking the tech ID below a problem)
  const [techHistory, setTechHistory] = useState({ open: false, tech: null, complaints: [], loading: false });

  // Tap Call → choice sheet (normal call + WhatsApp, works on desktop too).
  // Resolves the number first (API fallback for techs missing phone locally).
  const [callSheet, setCallSheet] = useState(null);
  const callTech = async (techObj) => {
    let phone = typeof techObj === 'object' ? techObj?.phone : techObj;
    const name = techObj?.name || techObj?.technicianId || 'technician';
    const techId = techObj?._id || techObj?.technicianId;
    // If phone not in populated object (common for 2nd tech), fetch via KESCO call-technician endpoint with both _id and technicianId
    if (!phone && techId) {
      try {
        const r = await api('/api/kesco/call-technician', { method: 'POST', body: { technicianId: techId } });
        phone = r.phone;
      } catch (e) {
        // Try alternative id field
        try {
          const altId = techObj?.technicianId || techObj?._id;
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

  // AI-ranked shortlist per complaint — availability • distance • workload
  const [recs, setRecs] = useState({});
  const [recLoading, setRecLoading] = useState('');
  const [dupOpen, setDupOpen] = useState({});
  const CitizenBadge = ({ c }) => (
    <>
      <button onClick={() => setDupOpen((p) => ({ ...p, [c._id]: !p[c._id] }))}
        title="View the citizens who reported this merged fault"
        aria-expanded={!!dupOpen[c._id]}
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold gap-1 leading-none transition-all shrink-0 ${dupOpen[c._id] ? 'bg-circuit-amber text-ink-navy ring-1 ring-circuit-amber/40' : 'bg-circuit-amber/15 text-circuit-amber hover:bg-circuit-amber/25'}`}>
        <Icon name="join_full" className="text-[10px]" /> {c.mergedCitizenCount ? `${c.mergedCitizenCount} ${t('citizens')}` : t('merged')}
      </button>
      {dupOpen[c._id] && (c.mergedCitizens || []).length > 0 && (
        <div className="w-full mt-2 rounded-xl border border-circuit-amber/25 bg-secondary-fixed/20 p-2.5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-circuit-amber mb-1.5 flex items-center gap-1"><Icon name="groups" className="text-xs" /> {(c.mergedCitizens || []).length} {t('citizens')}</p>
          <div className="space-y-1">
            {(c.mergedCitizens || []).map((mc) => (
              <div key={mc.complaintId} className="flex items-center gap-2 text-[11px] min-w-0">
                <span className="font-mono text-wire-slate bg-surface-container px-1.5 py-0.5 rounded shrink-0">{mc.meterNumber ? `MTR ${mc.meterNumber}` : '—'}</span>
                <span className="text-on-surface-variant truncate min-w-0">{mc.name || 'Citizen'}</span>
                {mc.isRepresentative && <span className="text-[9px] font-bold text-signal-green uppercase shrink-0">{t('firstReporter')}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );

  const toggleRecs = async (complaintId) => {
    if (recs[complaintId]) { setRecs((p) => ({ ...p, [complaintId]: null })); return; }
    setRecLoading(complaintId);
    try {
      const r = await api(`/api/kesco/recommendations/${complaintId}`);
      setRecs((p) => ({ ...p, [complaintId]: r.recommendations || [] }));
    } catch (e) { alert(e.message); }
    setRecLoading('');
  };

  // Assign a specific technician picked from the AI shortlist — AI only suggests, Controller decides
  const assignTo = async (complaintId, technicianId) => {
    setBusyAssign(complaintId);
    try {
      const r = await api('/api/kesco/assign-nearest', { method: 'POST', body: { complaintId, technicianId } });
      alert(`Task sent to ${r.technician?.name || 'technician'}${r.distanceKm != null ? ` • ${r.distanceKm.toFixed(1)} km away` : ''} — awaiting Accept`);
      setRecs((p) => ({ ...p, [complaintId]: null }));
      loadAll();
    } catch (e) { alert(e.message); }
    setBusyAssign('');
  };

  // Ranked recommendation panel — shown to the Controller for unassigned genuine faults — displays AI suggestion with technician ID
  const RecPanel = ({ c }) => !Array.isArray(recs[c._id]) ? null : (
    <div className="w-full mt-2.5 bg-surface-container-low rounded-lg p-2 space-y-1 border border-haze/50">
      <p className="text-[10px] font-bold uppercase tracking-wider text-wire-slate flex items-center gap-1"><Icon name="auto_awesome" fill className="text-xs text-circuit-amber" />{t('aiRankedDesc')} — AI suggests by nearest + ideal free</p>
      {recs[c._id].length === 0 && <p className="text-[11px] text-wire-slate px-1 py-1">{t('noFreeTechs')}</p>}
      {recs[c._id].map((tech, i) => (
        <div key={String(tech._id)} className="flex items-center gap-2 text-[11px] bg-paper rounded-md px-2 py-1.5 border border-haze/50">
          <span className={`font-display font-extrabold ${i === 0 ? 'text-signal-green' : 'text-wire-slate'}`}>#{i + 1}</span>
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-ink-navy truncate block leading-none">{tech.name}</span>
            <span className="font-mono text-[10px] text-wire-slate truncate block leading-none mt-0.5">ID: {tech.technicianId} {tech.phone ? `• ${tech.phone}` : ''}</span>
          </div>
          <span className="hidden md:inline text-wire-slate truncate max-w-[240px] text-[10px]">{tech.reason}</span>
          <span className="font-mono text-circuit-amber shrink-0 text-[10px]">{tech.distanceKm ?? '—'} km</span>
          <button onClick={() => assignTo(c._id, tech._id)} disabled={busyAssign === c._id} className="bg-circuit-amber text-ink-navy font-bold px-2.5 py-1 rounded-md active:scale-95 disabled:opacity-50 shrink-0">{t('assignBtn')}</button>
        </div>
      ))}
    </div>
  );

  const loadAll = () => {
    api('/api/kesco/overview').then((r) => setOv(r.overview || {})).catch(() => setOv({}));
    api('/api/kesco/complaints?limit=100').then((r) => setComplaints(r.complaints || [])).catch(() => {});
    api('/api/kesco/analytics').then((r) => setAnalytics(r)).catch(() => {});
    api('/api/kesco/ai-queue').then((r) => setAiQueue(r)).catch(() => setAiQueue(null));
  };
  useEffect(() => {
    setComplaints([]); setAnalytics(null); setAiQueue(null);
    loadAll();
    const it = setInterval(loadAll, 10000); // Silent auto-refresh every 10s
    const onAuth = () => { setComplaints([]); loadAll(); };
    window.addEventListener('bs_auth_change', onAuth);
    return () => { window.removeEventListener('bs_auth_change', onAuth); clearInterval(it); };
  }, []);

  const isDismissed = (c) => !!c?.isDismissed || String(c?.resolutionNotes || '').includes('Manually dismissed');
  const override = async (complaintId, action) => {
    try {
      await api('/api/kesco/manual-override', { method: 'POST', body: { complaintId, action } });
      if (action === 'dismiss') setCFilter('dismissed');
      loadAll();
    }
    catch (e) { alert(e.message); }
  };

  // Fetch citizen complaint history by meter number — with offline/local fallback
  const fetchCitizenHistory = async (meterNumber, name) => {
    const cleanMeter = String(meterNumber || '').trim();
    setCitizenHistory({ open: true, meterNumber: cleanMeter, name, complaints: [], loading: true });
    try {
      const r = await api(`/api/kesco/citizen-history/${encodeURIComponent(cleanMeter)}`);
      // Prefer backend result, but fallback to already-loaded complaints if backend returns empty (e.g. old deployment without route)
      const backendList = Array.isArray(r.complaints) ? r.complaints : [];
      if (backendList.length > 0) {
        setCitizenHistory({ open: true, meterNumber: cleanMeter, name, complaints: backendList, loading: false });
        return;
      }
      // Backend empty → try local filter from current complaints list (already populated with citizenId.meterNumber)
      const local = (complaints || []).filter((c) => String(c.citizenId?.meterNumber || '').trim() === cleanMeter);
      if (local.length > 0) {
        setCitizenHistory({ open: true, meterNumber: cleanMeter, name, complaints: local, loading: false });
        return;
      }
      setCitizenHistory({ open: true, meterNumber: cleanMeter, name, complaints: backendList, loading: false });
    } catch (e) {
      // Network/CORS/404 fallback — show local history so KESCO always sees something on click
      const local = (complaints || []).filter((c) => String(c.citizenId?.meterNumber || '').trim() === cleanMeter);
      if (local.length > 0) {
        setCitizenHistory({ open: true, meterNumber: cleanMeter, name, complaints: local, loading: false });
        return;
      }
      setCitizenHistory({ open: true, meterNumber: cleanMeter, name, complaints: [], loading: false });
      // Don't block UI with alert on 404 — modal will show “No complaints found” with meter number
      console.warn('citizen-history failed, showing empty:', e.message);
    }
  };

  // Fetch technician info + their faults history by technician id — opens on clicking tech ID below a problem
  const fetchTechHistory = async (techObj) => {
    const id = techObj?._id || techObj?.technicianId;
    if (!id) return;
    setTechHistory({ open: true, tech: typeof techObj === 'object' ? techObj : null, complaints: [], loading: true });
    try {
      const r = await api(`/api/kesco/technician-history/${encodeURIComponent(id)}`);
      const tech = r.technician || techObj || null;
      setTechHistory({ open: true, tech, complaints: Array.isArray(r.complaints) ? r.complaints : [], loading: false });
    } catch (e) {
      const local = (complaints || []).filter((c) => c.assignedTechnicianId && typeof c.assignedTechnicianId === 'object' && String(c.assignedTechnicianId._id) === String(id));
      setTechHistory({ open: true, tech: techObj || null, complaints: local, loading: false });
      console.warn('technician-history failed, showing local:', e.message);
    }
  };

  const assignNearest = async (complaintId) => {
    setBusyAssign(complaintId);
    try {
      const r = await api('/api/kesco/assign-nearest', { method: 'POST', body: { complaintId } });
      alert(`Task sent to ${r.technician?.name || 'nearest tech'}${r.distanceKm != null ? ` • ${r.distanceKm.toFixed(1)} km away` : ''} — awaiting technician Accept`);
      loadAll();
    } catch (e) { alert(e.message); }
    setBusyAssign('');
  };

  const faults = complaints.filter((c) => c.status !== 'resolved' && !isDismissed(c));

  return (
    <Shell wide navLinks={[
      { icon: 'space_dashboard', label: t('navDashboard'), active: true },
      { icon: 'radar', label: t('navFleet'), onClick: () => go('#/kesco/tracking') },
      { icon: 'person', label: t('navOfficer'), onClick: () => go('#/kesco/profile') },
      { icon: 'logout', label: t('navLogout'), mobile: false, footer: true, onClick: () => { try { clearAuth(); } catch (e) {} go('#/'); } },
    ]}>
      <div className="max-w-7xl mx-auto font-kesco antialiased">
        {/* Page header — Namaste like Citizen */}
        <div className="mb-5 xs:mb-6">
          <p className="text-[15px] xs:text-base sm:text-lg text-wire-slate font-bold flex items-center gap-2 min-w-0"><span className="w-2 h-2 rounded-full bg-signal-green pulse-dot shrink-0" />{t('namaste')}</p>
          <h1 className="font-display text-2xl xs:text-3xl md:text-4xl lg:text-[2.6rem] font-black text-ink-navy tracking-[-0.02em] leading-none mt-1">{t('controllerDashboardTitle')}</h1>
          <p className="text-xs xs:text-sm md:text-[15px] text-on-surface-variant mt-3 font-medium leading-relaxed max-w-2xl flex items-start gap-2">
            <Icon name="auto_awesome" fill className="text-circuit-amber text-base shrink-0 mt-0.5" />
            <span>{t('controllerSubTitle')}</span>
          </p>
        </div>

        {/* Stats — INITIAL MOBILE: 2-col grid, stagger, 118px min-h — first mobile build (desktop is xl:grid-cols-6) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2.5 xs:gap-4 mb-5 xs:mb-6 mobile-stagger">
          <StatCard icon="warning" tint="amber" label={t('totalActive')} value={ov.active ?? 0} sub={t('ongoing')} className="min-h-[118px] xs:min-h-[124px]" />
          <StatCard icon="bolt" tint="amber" label={t('genuineQueue')} value={ov.genuineQueue ?? 0} sub={t('aiCleared')} className="min-h-[118px] xs:min-h-[124px]" />
          <StatCard icon="error" tint="red" label={t('workingStat')} value={ov.working ?? 0} sub={t('linemenOnSite')} className="min-h-[118px] xs:min-h-[124px]" />
          <StatCard icon="check_circle" tint="green" label={t('filterResolved')} value={ov.resolved ?? 0} sub={ov.avgResolutionMinutes != null ? `avg ${ov.avgResolutionMinutes}m` : t('allTime')} className="min-h-[118px] xs:min-h-[124px]" />
          <StatCard icon="content_copy" tint="slate" label={t('duplicatesStat')} value={ov.duplicates ?? 0} sub={t('mergedClusters')} className="min-h-[118px] xs:min-h-[124px]" />
          <StatCard icon="gpp_maybe" tint="slate" label={t('falseFlagsStat')} value={ov.falseFlags ?? 0} sub={`${ov.photoFlagged ?? 0} ${t('photoFlaggedSub')}`} className="min-h-[118px] xs:min-h-[124px]" />
        </div>

        {/* AI Controller strip */}
        <div className="bg-ink-navy rounded-2xl p-4 xs:p-5 sm:p-6 mb-5 xs:mb-6 shadow-raised text-white relative overflow-hidden">
          <div className="absolute -right-10 -top-10 w-44 h-44 bg-circuit-amber/10 rounded-full blur-2xl pointer-events-none" />
          <div className="relative z-10">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-circuit-amber flex items-center gap-1.5">
                  <Icon name="auto_awesome" fill className="text-sm" /> {t('aiGridBrain')}
                </p>
                <h2 className="font-display font-bold text-base sm:text-lg leading-snug tracking-tight mt-1.5">{t('aiGridDescTitle')}</h2>
                <p className="text-xs text-white/60 mt-1 leading-relaxed max-w-xl">{t('aiGridSub')}</p>
              </div>
              <div className="flex gap-1.5 sm:gap-2 flex-wrap shrink-0 max-w-full">
                <span className="bg-white/10 border border-white/15 rounded-full px-2.5 sm:px-3.5 py-1 sm:py-1.5 text-[11px] sm:text-xs font-bold leading-none whitespace-nowrap shrink-0">{t('genuineBadge')} <span className="text-signal-green ml-1">{aiQueue?.counts?.genuine ?? 0}</span></span>
                <span className="bg-circuit-amber/20 border border-circuit-amber/30 rounded-full px-2.5 sm:px-3.5 py-1 sm:py-1.5 text-[11px] sm:text-xs font-bold leading-none whitespace-nowrap shrink-0 text-circuit-amber">{t('duplicatesBadge')} <span className="ml-1">{aiQueue?.counts?.duplicate ?? 0}</span></span>
                <span className="bg-fault-red/15 border border-fault-red/20 rounded-full px-2.5 sm:px-3.5 py-1 sm:py-1.5 text-[11px] sm:text-xs font-bold leading-none whitespace-nowrap shrink-0 text-red-200">{t('falseBadge')} <span className="ml-1">{aiQueue?.counts?.fake ?? 0}</span></span>
              </div>
            </div>

            {/* Queue preview — aligned cards */}
            {aiQueue?.complaints?.length > 0 && (
              <div className="mt-4 grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {aiQueue.complaints.slice(0, 3).map((c) => (
                  <div key={c._id} className="bg-white rounded-xl p-3.5 shadow-card text-ink-navy flex flex-col">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] bg-surface-container px-2 py-0.5 rounded text-wire-slate">{faultId(c)}</span>
                      <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide ${c.genuinenessScore < 0.4 ? 'bg-fault-red/10 text-fault-red' : c.isDuplicateOf ? 'bg-circuit-amber/15 text-circuit-amber' : 'bg-signal-green/15 text-signal-green'}`}>
                        {c.genuinenessScore < 0.4 ? t('falseBadge').toUpperCase() : c.isDuplicateOf ? t('duplicatesBadge').toUpperCase() : t('genuineBadge').toUpperCase()}
                      </span>
                    </div>
                    <p className="text-sm font-semibold capitalize leading-snug mt-2">{String(c.problemVariant || '').replace(/-/g, ' ')}</p>
                    <p className="text-xs text-wire-slate line-clamp-1 mt-0.5">{c.description || '—'}</p>
                    <div className="mt-auto pt-3 flex gap-2 items-center flex-wrap">
                      {c.assignedTechnicianId && typeof c.assignedTechnicianId === 'object' && (c.genuinenessScore ?? 1) >= 0.4 ? (
                        <button onClick={() => callTech(c.assignedTechnicianId)} className="flex-1 min-w-[120px] bg-signal-green text-white text-xs font-bold py-2 rounded-lg hover:bg-signal-green/85 active:scale-95 flex items-center justify-center gap-1">
                          <Icon name="call" className="text-sm shrink-0" /> <span className="truncate">{t('callTechShort')} {c.assignedTechnicianId.name || 'Tech'}</span>
                        </button>
                      ) : !c.isDuplicateOf && c.genuinenessScore >= 0.4 && !c.assignedTechnicianId ? (
                        <>
                          {c.recommendedTechnicianId && typeof c.recommendedTechnicianId === 'object' && (
                            <span className="w-full text-[10px] font-bold text-signal-green flex items-center gap-1"><Icon name="recommend" className="text-sm shrink-0" />AI suggests: {c.recommendedTechnicianId.name}{c.recommendedDistanceKm != null ? ` (${Number(c.recommendedDistanceKm).toFixed(1)} km)` : ''}</span>
                          )}
                          <button onClick={() => assignNearest(c._id)} disabled={busyAssign === c._id} className="flex-1 min-w-[120px] bg-circuit-amber text-ink-navy text-xs font-bold py-2 rounded-lg active:scale-95 disabled:opacity-60 flex items-center justify-center gap-1">
                            <Icon name="near_me" className="text-sm shrink-0" /> {busyAssign === c._id ? 'Assigning…' : c.recommendedTechnicianId ? t('approveAssign') : t('assignNearest')}
                          </button>
                        </>
                      ) : null}
                      {c.isDuplicateOf && (c.genuinenessScore ?? 1) >= 0.4 && <CitizenBadge c={c} />}
                      {(c.genuinenessScore ?? 1) < 0.4 && (
                        <button onClick={() => override(c._id, 'dismiss')} className="text-[11px] font-bold px-3 py-2 rounded-lg bg-fault-red/10 border border-fault-red/30 text-fault-red hover:bg-fault-red hover:text-white transition-colors flex items-center gap-1"><Icon name="delete" className="text-xs" />{t('removeTaskBtn')}</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Main grid — faults + analytics rail */}
        <div className="grid lg:grid-cols-5 gap-4 xs:gap-6 items-start">
          {/* Recent faults */}
          <section className="lg:col-span-3 min-w-0">
            <div className="flex items-center justify-between mb-3.5 gap-2 min-w-0">
              <h2 className="font-display font-bold text-ink-navy text-sm sm:text-base tracking-tight flex items-center gap-1.5 min-w-0 flex-1">
                <Icon name="bolt" fill className="text-circuit-amber text-base shrink-0" />{t('recentFaults')} <span className="text-wire-slate font-medium text-xs tracking-normal whitespace-nowrap">{t('aiTriagedSuffix')}</span>
              </h2>
              <span className="text-xs font-mono tabular-nums text-wire-slate bg-surface-container px-2.5 py-1 rounded-full border border-haze whitespace-nowrap shrink-0">{faults.length} {t('openCount')}</span>
            </div>
            <div className="space-y-3">
              {faults.map((c) => {
                const prio = PRIORITY(c);
                const st = STATUS_TAG(c.status);
                const isFalseCard = (c.genuinenessScore ?? 1) < 0.4;
                return (
                  <div key={c._id} className={`bg-paper rounded-xl p-4 shadow-card border-l-4 ${prio[0] === t('critical') ? 'border-l-fault-red' : prio[0] === t('high') ? 'border-l-circuit-amber' : 'border-l-wire-slate'} hover:shadow-raised transition-all`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <span className="font-mono text-xs bg-surface-container px-2 py-0.5 rounded text-wire-slate font-medium">{faultId(c)}</span>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${prio[1]}`}>{prio[0]}</span>
                        {c.aiPhotoAnalysis?.isRelevant === false && <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold bg-error-container text-on-error-container">{t('photoFlaggedLabel')}</span>}
                        {c.aiPhotoAnalysis?.isRelevant === true && <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold bg-signal-green/15 text-signal-green">{t('photoOk')}</span>}
                        {c.isDuplicateOf && !isFalseCard && <CitizenBadge c={c} />}
                      </div>
                      <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold ${st[1]} whitespace-nowrap shrink-0`}>{st[0]}</span>
                    </div>
                    <div className="flex gap-3 mt-2.5">
                      {c.photoUrl && <img src={photoUrl(c.photoUrl)} alt="" className="w-14 h-14 rounded-lg object-cover border border-haze shrink-0 hidden sm:block" loading="lazy" />}
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <div className="flex items-center gap-2.5 min-w-0 overflow-hidden">
                          <Icon name={VARIANT_GLYPH[c.problemVariant] || 'bolt'} fill className="text-circuit-amber text-base shrink-0 overflow-hidden" style={{width:'1em',height:'1em'}} />
                          <p className="font-display font-semibold text-sm text-ink-navy capitalize truncate min-w-0 flex-1">{String(c.problemVariant || '').replace(/-/g, ' ')}</p>
                        </div>
                        <p className="text-xs text-on-surface-variant line-clamp-1 mt-1">{c.description || 'No description'}</p>
                        <div className="flex flex-wrap items-center gap-2 mt-1.5">
                          {c.etaMinutes ? <span className="text-[11px] font-mono text-wire-slate">{t('etaPrefix')} {c.etaMinutes < 60 ? c.etaMinutes + 'm' : Math.round(c.etaMinutes / 60) + 'h'}</span> : null}
                          {c.genuinenessScore != null && <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${c.genuinenessScore < 0.4 ? 'bg-fault-red/10 text-fault-red' : c.genuinenessScore > 0.7 ? 'bg-signal-green/10 text-signal-green' : 'bg-surface-container text-wire-slate'}`}>{c.genuinenessScore < 0.4 ? 'Flagged' : c.genuinenessScore > 0.7 ? 'Genuine' : 'Review'}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-haze/50 gap-2 flex-wrap">
                      <span className="text-[10px] font-mono text-wire-slate truncate min-w-0 flex items-center gap-1.5">
                        <span className="shrink-0">{new Date(c.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                        {c.citizenId?.meterNumber ? (
                          <button onClick={() => fetchCitizenHistory(c.citizenId.meterNumber, c.citizenId?.name || 'Citizen')} className="flex items-center gap-1 text-circuit-amber hover:text-spark-ember hover:underline transition-colors font-mono text-[10px]" style={{fontFamily:'JetBrains Mono, IBM Plex Mono, monospace', background: 'none', border: 'none', padding: 0, cursor: 'pointer'}}>
                            <Icon name="history" className="text-[10px]" /> MTR {c.citizenId.meterNumber}
                          </button>
                        ) : ''}
                        {c.assignedTechnicianId && typeof c.assignedTechnicianId === 'object' ? (
                          <button onClick={() => fetchTechHistory(c.assignedTechnicianId)} title={`View ${c.assignedTechnicianId.name || 'technician'}'s history`} className="flex items-center gap-1 text-signal-green hover:text-spark-ember hover:underline transition-colors font-mono text-[10px]" style={{fontFamily:'JetBrains Mono, IBM Plex Mono, monospace', background: 'none', border: 'none', padding: 0, cursor: 'pointer'}}>
                            <Icon name="engineering" className="text-[10px]" /> TID {c.assignedTechnicianId.technicianId || c.assignedTechnicianId.name || 'Assigned'}
                          </button>
                        ) : ''}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                        {isFalseCard ? (
                          <button onClick={() => override(c._id, 'dismiss')} className="text-[11px] font-bold px-3 py-1.5 rounded-full bg-fault-red/10 border border-fault-red/30 text-fault-red hover:bg-fault-red hover:text-white transition-colors flex items-center gap-1"><Icon name="delete" className="text-xs" />{t('removeTaskBtn')}</button>
                        ) : c.isDuplicateOf ? (
                          c.representativeTech ? (
                            <span className="flex items-center gap-1.5 text-[11px] font-bold text-signal-green bg-signal-green/10 border border-signal-green/25 px-3 py-1.5 rounded-full">
                              <Icon name="engineering" className="text-sm" /> {c.representativeTech.name || c.representativeTech.technicianId} • {c.representativeTech.jobStatus === 'working' ? t('inProgress') : t('dispatching')}{c.representativeTech.techEtaLabel ? ` • ${c.representativeTech.techEtaLabel}` : ''}
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold bg-circuit-amber/15 text-circuit-amber whitespace-nowrap">{t('dispatching')}</span>
                          )
                        ) : c.assignedTechnicianId && typeof c.assignedTechnicianId === 'object' ? (
                          <>
                            <span className="text-[11px] font-medium text-signal-green flex items-center gap-1"><Icon name="engineering" className="text-sm" />{c.assignedTechnicianId.name || 'Assigned'}</span>
                            <button onClick={() => callTech(c.assignedTechnicianId)} title={c.assignedTechnicianId.phone ? `Call ${c.assignedTechnicianId.phone}` : 'No phone on file'} className={`text-[11px] font-bold px-3 py-1.5 rounded-full active:scale-95 flex items-center gap-1 transition-all ${c.assignedTechnicianId.phone ? 'bg-signal-green text-white hover:bg-signal-green/85' : 'bg-paper border border-haze text-wire-slate'}`}>
                              <Icon name="call" className="text-xs" /> {t('callTechShort')}
                            </button>
                          </>
                        ) : (
                          <span className="flex items-center gap-1.5 flex-wrap justify-end">
                            {c.recommendedTechnicianId && typeof c.recommendedTechnicianId === 'object' && (
                              <span className="text-[10px] font-bold text-signal-green flex items-center gap-1"><Icon name="recommend" className="text-xs" />AI: {c.recommendedTechnicianId.name}{c.recommendedDistanceKm != null ? ` (${Number(c.recommendedDistanceKm).toFixed(1)} km)` : ''}</span>
                            )}
                            <button onClick={() => toggleRecs(c._id)} title="AI-ranked technicians for this job" className="text-[10px] font-bold text-ink-navy bg-circuit-amber/15 border border-circuit-amber/40 px-2 py-1 rounded-full flex items-center gap-0.5 hover:border-circuit-amber active:scale-95 transition-all">
                              <Icon name="auto_awesome" className="text-xs text-circuit-amber" /> {recLoading === c._id ? '…' : t('aiPicks')}
                            </button>
                            <button onClick={() => assignNearest(c._id)} disabled={busyAssign === c._id} className="text-[11px] font-bold bg-circuit-amber text-ink-navy px-3 py-1.5 rounded-full active:scale-95 disabled:opacity-60 flex items-center gap-1">
                              <Icon name="near_me" className="text-xs" /> {busyAssign === c._id ? 'Assigning…' : c.recommendedTechnicianId ? t('approveAssign') : t('assignNearest')}
                            </button>
                          </span>
                        )}
                      </div>
                    </div>
                    <RecPanel c={c} />
                  </div>
                );
              })}
              {faults.length === 0 && (
                <div className="bg-paper border border-haze rounded-2xl p-10 text-center shadow-card">
                  <Icon name="task_alt" className="text-signal-green text-4xl mb-2" />
                  <p className="text-wire-slate text-sm font-medium">{t('gridQuiet')}</p>
                </div>
              )}
            </div>
          </section>

          {/* Analytics rail */}
          <section className="lg:col-span-2 space-y-4 min-w-0">
            <div className="bg-paper rounded-2xl p-5 shadow-card border border-haze/60">
              <h3 className="font-display font-bold text-ink-navy text-sm tracking-tight">{t('last7Days')}</h3>
              <p className="text-[11px] text-wire-slate mt-0.5 mb-3">{t('reportsPerDay')}</p>
              <MiniBars data={analytics?.last7Days || []} />
            </div>

            <div className="bg-paper rounded-2xl p-5 shadow-card border border-haze/60">
              <h3 className="font-display font-bold text-ink-navy text-sm tracking-tight">{t('byFaultType')}</h3>
              <p className="text-[11px] text-wire-slate mt-0.5 mb-3">{t('mostReported')}</p>
              <div className="space-y-2.5">
                {(analytics?.byVariant || []).slice(0, 5).map((v) => {
                  const max = analytics.byVariant[0].count || 1;
                  return (
                    <div key={v._id}>
                      <div className="flex justify-between items-center text-xs mb-1 gap-2">
                        <span className="capitalize text-on-surface-variant truncate">{String(v._id || '').replace(/-/g, ' ')}</span>
                        <span className="font-mono font-semibold text-ink-navy shrink-0">{v.count}</span>
                      </div>
                      <div className="h-2 bg-surface-container-high rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-circuit-amber to-spark-ember transition-all duration-500" style={{ width: `${Math.max(4, (v.count / max) * 100)}%` }} />
                      </div>
                    </div>
                  );
                })}
                {(!analytics?.byVariant?.length) && <p className="text-xs text-wire-slate">{t('noDataYet')}</p>}
              </div>
            </div>

            <div className="bg-paper rounded-2xl p-5 shadow-card border border-haze/60">
              <h3 className="font-display font-bold text-ink-navy text-sm tracking-tight">{t('techniciansTitle')}</h3>
              <p className="text-[11px] text-wire-slate mt-0.5 mb-3">{t('liveFleetStatus')}</p>
              <div className="grid grid-cols-3 gap-2 text-center">
                {[[t('available'), ov.technicians?.available, 'text-signal-green'], [t('onTask'), ov.technicians?.onTask, 'text-circuit-amber'], [t('offline'), ov.technicians?.offline, 'text-wire-slate']].map(([l, v, cls]) => (
                  <div key={l} className="bg-surface-container-low rounded-xl p-3">
                    <p className={`font-display text-xl font-bold leading-none tabular-nums ${cls}`}>{v ?? 0}</p>
                    <p className="text-[10px] text-wire-slate uppercase tracking-wider mt-1.5">{l}</p>
                  </div>
                ))}
              </div>
              <button onClick={() => go('#/kesco/tracking')} className="mt-4 w-full bg-ink-navy text-white text-sm font-semibold py-3 rounded-xl flex items-center justify-center gap-2 hover:bg-grid-navy active:scale-[0.98] transition-all">
                <Icon name="radar" fill className="text-circuit-amber" /> {t('openFleetTracking')}
              </button>
            </div>
          </section>
        </div>
      </div>

      {/* FAB — Issue Console — above BottomNav on mobile, compact circle to not cover Officer */}
      <button onClick={() => setConsole(true)} title={t('issueConsole')}
        className="fixed bottom-20 sm:bottom-8 lg:bottom-8 right-4 sm:right-5 lg:right-8 z-40 h-12 w-12 sm:h-14 sm:w-auto sm:px-5 rounded-full bg-circuit-amber text-ink-navy shadow-glow-amber flex items-center justify-center sm:gap-2 hover:bg-secondary-container active:scale-90 transition-all overflow-hidden shrink-0"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
        <Icon name="terminal" className="text-xl sm:text-2xl shrink-0" />
        <span className="text-sm font-bold hidden sm:inline truncate">{t('issueConsole')}</span>
      </button>

      {/* Issue Console modal */}
      {console_ && (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-ink-navy/60 backdrop-blur-sm p-0 sm:p-6" onClick={() => setConsole(false)}>
          <div className="bg-surface w-full sm:max-w-3xl max-h-[88vh] sm:max-h-[85vh] rounded-t-3xl sm:rounded-3xl shadow-raised flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-haze bg-paper shrink-0">
              <div className="min-w-0">
                <h3 className="font-display font-bold text-ink-navy text-sm sm:text-base">{t('issueConsoleTitle')}</h3>
                <p className="text-[11px] text-wire-slate mt-0.5">{t('issueConsoleSub')}</p>
              </div>
              <button onClick={() => setConsole(false)} className="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center text-wire-slate shrink-0" aria-label="Close"><Icon name="close" /></button>
            </div>
            <div className="flex gap-1.5 sm:gap-2 px-3 sm:px-5 py-3 bg-paper border-b border-haze/60 overflow-x-auto hide-scrollbar shrink-0 min-w-0">
              {[[ 'open', t('filterOpen')], ['registered', t('filterDispatching')], ['working', t('filterInProgress')], ['resolved', t('filterResolved')], ['dismissed', t('filterDismissed')], ['false', t('filterFalse')], ['dup', t('filterDup')], ['photo', t('filterPhoto')]].map(([k, l]) => (
                <button key={k} onClick={() => setCFilter(k)}
                  className={`px-2.5 sm:px-3.5 py-1 sm:py-1.5 rounded-full text-[11px] sm:text-xs font-semibold whitespace-nowrap shrink-0 leading-none transition-all ${cFilter === k ? 'bg-ink-navy text-white shadow-card' : 'bg-surface-container-high text-wire-slate hover:text-ink-navy'}`}>{l}</button>
              ))}
            </div>
            <div className="overflow-y-auto p-4 space-y-2.5">
              {complaints
                .filter((c) => {
                  if (cFilter === 'open') return c.status !== 'resolved' && !isDismissed(c);
                  if (cFilter === 'dismissed') return isDismissed(c);
                  if (cFilter === 'resolved') return c.status === 'resolved' && !isDismissed(c);
                  if (cFilter === 'false') return (c.genuinenessScore ?? 1) < 0.4 && !isDismissed(c);
                  if (cFilter === 'dup') return !!c.isDuplicateOf && !isDismissed(c);
                  if (cFilter === 'photo') return c.aiPhotoAnalysis?.isRelevant === false && !isDismissed(c);
                  return c.status === cFilter && !isDismissed(c);
                })
                .map((c) => {
                  const prio = PRIORITY(c);
                  const st = STATUS_TAG(c.status);
                  const isFalse = (c.genuinenessScore ?? 1) < 0.4;
                  const isDupRow = !!c.isDuplicateOf && !isFalse;
                  const showCall = !isDismissed(c) && !isFalse && !isDupRow && c.assignedTechnicianId && typeof c.assignedTechnicianId === 'object';
                  const showAssign = !isDismissed(c) && c.status !== 'resolved' && !c.assignedTechnicianId && !c.isDuplicateOf && c.genuinenessScore >= 0.4;
                  return (
                    <div key={c._id} className="bg-paper rounded-xl p-3.5 shadow-card border border-haze/50 overflow-hidden">
                      <div className="flex justify-between items-start gap-2 mb-1.5 flex-wrap gap-y-1 min-w-0">
                        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap min-w-0 flex-1">
                          <span className="font-mono text-[10px] sm:text-[11px] bg-surface-container px-1.5 sm:px-2 py-0.5 rounded text-wire-slate shrink-0">{faultId(c)}</span>
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase leading-none whitespace-nowrap shrink-0 ${prio[1]}`}>{prio[0]}</span>
                          {isDismissed(c) ? (
                            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold leading-none whitespace-nowrap shrink-0 bg-ink-navy text-white">{t('dismissedBadge')}</span>
                          ) : (
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold leading-none whitespace-nowrap shrink-0 ${st[1]}`}>{st[0]}</span>
                          )}
                          {c.aiPhotoAnalysis?.isRelevant === false && <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold leading-none whitespace-nowrap shrink-0 bg-error-container text-on-error-container">{t('photoFlaggedLabel')}</span>}
                          {c.isDuplicateOf && !isFalse && <CitizenBadge c={c} />}
                        </div>
<span className="flex items-center gap-1 text-[10px] font-mono text-wire-slate shrink-0 whitespace-nowrap">
                        <span className="shrink-0">{new Date(c.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span>
                        {c.citizenId?.meterNumber ? (
                          <button onClick={() => fetchCitizenHistory(c.citizenId.meterNumber, c.citizenId?.name || 'Citizen')} className="flex items-center gap-1 text-circuit-amber hover:text-spark-ember hover:underline transition-colors font-mono text-[10px]" style={{fontFamily:'JetBrains Mono, IBM Plex Mono, monospace', background: 'none', border: 'none', padding: 0, cursor: 'pointer'}}>
                            <Icon name="history" className="text-[10px]" /> MTR {c.citizenId.meterNumber}
                          </button>
                        ) : ''}
                      </span>
                      </div>
                      {c.photoUrl && <img src={photoUrl(c.photoUrl)} alt="" className="w-full h-28 object-cover rounded-lg border border-haze mt-1 mb-2" loading="lazy" />}
                      <p className="text-sm font-medium text-ink-navy capitalize flex items-center gap-2 min-w-0 overflow-hidden">
                        <Icon name={VARIANT_GLYPH[c.problemVariant] || 'bolt'} fill className="text-circuit-amber text-base shrink-0 overflow-hidden" style={{width:'1em',height:'1em'}} />
                        <span className="truncate min-w-0 flex-1">{String(c.problemVariant || '').replace(/-/g, ' ')}</span>
                      </p>
                      <p className="text-xs text-on-surface-variant line-clamp-2 mt-0.5">{c.description || '—'}</p>
                      {c.aiPhotoAnalysis?.reasoning && <p className="text-[11px] text-wire-slate mt-1.5 bg-surface-container rounded-lg p-2 leading-relaxed">{c.aiPhotoAnalysis.reasoning} • {Math.round((c.aiPhotoAnalysis.confidence ?? 0) * 100)}% confidence</p>}
                      <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[11px] font-mono text-wire-slate">
                        {c.etaMinutes ? <span className="bg-ink-navy text-white px-2 py-0.5 rounded-full">{t('etaPrefix')} {c.etaMinutes < 60 ? c.etaMinutes + 'm' : Math.round(c.etaMinutes / 60) + 'h'}</span> : null}
                        {c.genuinenessScore != null && <span className={c.genuinenessScore < 0.4 ? 'text-fault-red font-bold' : 'text-wire-slate'}>{c.genuinenessScore < 0.4 ? 'Flagged' : c.genuinenessScore > 0.7 ? 'Genuine' : 'Review'}</span>}
                        {c.duplicateConfidence != null && c.isDuplicateOf ? <span>dup {Math.round(c.duplicateConfidence * 100)}%</span> : null}
                      </div>
                      <div className="flex flex-wrap gap-2 mt-3">
                        {showCall ? (
                          <button onClick={() => callTech(c.assignedTechnicianId)} className={`text-xs font-bold px-3 py-2 rounded-lg active:scale-95 flex items-center gap-1 transition-all ${c.assignedTechnicianId.phone ? 'bg-signal-green text-white hover:bg-signal-green/85' : 'bg-paper border border-haze text-wire-slate'}`}>
                            <Icon name="call" className="text-sm" /> {t('callTechShort')} {c.assignedTechnicianId.name || 'Tech'}
                          </button>
                        ) : null}
                        {showAssign ? (
                          <>
                            {c.recommendedTechnicianId && typeof c.recommendedTechnicianId === 'object' && (
                              <span className="text-[10px] font-bold text-signal-green flex items-center gap-1 self-center"><Icon name="recommend" className="text-sm shrink-0" />AI: {c.recommendedTechnicianId.name}{c.recommendedDistanceKm != null ? ` (${Number(c.recommendedDistanceKm).toFixed(1)} km)` : ''}</span>
                            )}
                            <button onClick={() => assignNearest(c._id)} disabled={busyAssign === c._id} className="text-xs font-bold bg-circuit-amber text-ink-navy px-3 py-2 rounded-lg flex items-center gap-1 active:scale-95 disabled:opacity-60">
                              <Icon name="near_me" className="text-sm" /> {busyAssign === c._id ? 'Assigning…' : c.recommendedTechnicianId ? t('approveAssign') : t('assignNearest')}
                            </button>
                            <button onClick={() => toggleRecs(c._id)} title="AI-ranked technicians for this job" className={`text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-1 active:scale-95 transition-all border ${Array.isArray(recs[c._id]) ? 'bg-circuit-amber text-ink-navy border-circuit-amber' : 'bg-paper border-circuit-amber/50 text-ink-navy hover:border-circuit-amber'}`}>
                              <Icon name="auto_awesome" fill className={`text-sm ${Array.isArray(recs[c._id]) ? '' : 'text-circuit-amber'}`} /> {recLoading === c._id ? '…' : t('aiPicks')}
                            </button>
                          </>
                        ) : null}
                        {!isDismissed(c) && isDupRow ? (
                          c.representativeTech ? (
                            <span className="flex items-center gap-1.5 text-[11px] font-bold text-signal-green bg-signal-green/10 border border-signal-green/25 px-3 py-2 rounded-lg">
                              <Icon name="engineering" className="text-sm" /> {c.representativeTech.name || c.representativeTech.technicianId} • {c.representativeTech.jobStatus === 'working' ? t('inProgress') : t('dispatching')}{c.representativeTech.techEtaLabel ? ` • ${c.representativeTech.techEtaLabel}` : ''}
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold bg-circuit-amber/15 text-circuit-amber whitespace-nowrap">{t('dispatching')}</span>
                          )
                        ) : null}
                        {isDismissed(c) ? (
                          <>
                            <span className="inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold bg-ink-navy text-white border border-ink-navy/30"><Icon name="block" className="text-xs mr-1" />{t('dismissedBadge')}</span>
                            <span className="text-[11px] text-wire-slate self-center truncate max-w-[220px]">{c.resolutionNotes || t('dismissedByKesco')}</span>
                            <button onClick={() => override(c._id, 'restore')} className="text-[11px] font-semibold px-3 py-2 rounded-lg border border-haze text-wire-slate hover:border-signal-green hover:text-signal-green transition-colors flex items-center gap-1"><Icon name="restart_alt" className="text-xs" />{t('restoreBtn')}</button>
                          </>
                        ) : (
                          <>
                            {isFalse ? (
                              c.status !== 'resolved' && (
                                <button onClick={() => override(c._id, 'dismiss')} className="text-[11px] font-bold px-3 py-2 rounded-lg bg-fault-red/10 border border-fault-red/30 text-fault-red hover:bg-fault-red hover:text-white transition-colors flex items-center gap-1"><Icon name="delete" className="text-xs" />{t('removeTaskBtn')}</button>
                              )
                            ) : (
                              <>
                                {c.status !== 'resolved' && (
                                  <button onClick={() => override(c._id, 'dismiss')} className="text-[11px] font-semibold px-3 py-2 rounded-lg border border-haze text-wire-slate hover:border-fault-red hover:text-fault-red transition-colors">{t('dismissBtn')}</button>
                                )}
                                {(c.genuinenessScore ?? 1) < 0.4 && (
                                  <button onClick={() => override(c._id, 'unflag')} className="text-[11px] font-semibold px-3 py-2 rounded-lg border border-haze text-wire-slate hover:border-signal-green hover:text-signal-green transition-colors">{t('markGenuineBtn')}</button>
                                )}
                              </>
                            )}
                            {c.isDuplicateOf && !isFalse && <span className="text-[11px] text-circuit-amber font-semibold self-center flex items-center gap-1"><Icon name="join_full" className="text-sm" />{t('mergedClusterLabel')}</span>}
                          </>
                        )}
                      </div>
                      <RecPanel c={c} />
                    </div>
                  );
                })}
              {complaints.filter((c) => {
                  if (cFilter === 'open') return c.status !== 'resolved' && !isDismissed(c);
                  if (cFilter === 'dismissed') return isDismissed(c);
                  if (cFilter === 'resolved') return c.status === 'resolved' && !isDismissed(c);
                  if (cFilter === 'false') return (c.genuinenessScore ?? 1) < 0.4 && !isDismissed(c);
                  if (cFilter === 'dup') return !!c.isDuplicateOf && !isDismissed(c);
                  if (cFilter === 'photo') return c.aiPhotoAnalysis?.isRelevant === false && !isDismissed(c);
                  return c.status === cFilter && !isDismissed(c);
                }).length === 0 && <p className="text-center text-sm text-wire-slate py-8">{t('nothingInFilter')}</p>}
              {complaints.length === 0 && <p className="text-center text-sm text-wire-slate py-8">{t('noComplaintsSystem')}</p>}
            </div>
          </div>
        </div>
      )}

      {/* Sathi AI — raised above the Issue Console FAB */}
      <ChatAssistant complaintId={null} title="Sathi — KESCO Controller AI" collapsedLabel="Sathi" raise />
      {callSheet ? <CallSheet phone={callSheet.phone} name={callSheet.name} onClose={() => setCallSheet(null)} /> : null}

      {/* Citizen History Modal — by meter number */}
      {citizenHistory.open && (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-ink-navy/60 backdrop-blur-sm p-0 sm:p-6" onClick={() => setCitizenHistory((p) => ({ ...p, open: false }))}>
          <div className="bg-surface w-full sm:max-w-3xl max-h-[88vh] sm:max-h-[85vh] rounded-t-3xl sm:rounded-3xl shadow-raised flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-haze bg-paper shrink-0">
              <div className="min-w-0">
                <h3 className="font-display font-bold text-ink-navy text-sm sm:text-base">{t('citizenHistoryTitle')}</h3>
                <p className="text-[10px] font-mono text-wire-slate mt-0.5">{citizenHistory.name} • MTR {citizenHistory.meterNumber}</p>
              </div>
              <button onClick={() => setCitizenHistory((p) => ({ ...p, open: false }))} className="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center text-wire-slate shrink-0" aria-label="Close"><Icon name="close" /></button>
            </div>
            <div className="overflow-y-auto p-4 space-y-2.5">
              {citizenHistory.loading ? (
                <div className="flex items-center justify-center py-8"><div className="w-8 h-8 border-2 border-haze border-t-circuit-amber rounded-full animate-spin" /></div>
              ) : citizenHistory.complaints.length === 0 ? (
                <p className="text-center text-sm text-wire-slate py-8">{t('noComplaintsFound')}</p>
              ) : (
                citizenHistory.complaints.map((c) => (
                  <div key={c._id} className="bg-paper rounded-xl p-3.5 shadow-card border border-haze/50">
                    <div className="flex justify-between items-start gap-2 mb-1.5">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <span className="font-mono text-[11px] bg-surface-container px-2 py-0.5 rounded text-wire-slate">{faultId(c)}</span>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${c.urgencyScore >= 6 ? 'bg-error-container text-on-error-container' : c.urgencyScore >= 3 ? 'bg-secondary-fixed/70 text-on-secondary-container' : 'bg-surface-container-high text-wire-slate'}`}>
                          {c.urgencyScore >= 6 ? t('critical') : c.urgencyScore >= 3 ? t('high') : t('normal')}
                        </span>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${c.status === 'registered' ? 'bg-circuit-amber/15 text-circuit-amber' : c.status === 'working' ? 'bg-secondary-container text-on-secondary-container' : 'bg-signal-green/15 text-signal-green'}`}>
                          {c.status === 'registered' ? t('dispatching') : c.status === 'working' ? t('inProgress') : t('filterResolved')}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-wire-slate shrink-0">{new Date(c.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span>
                    </div>
                    {c.photoUrl && <img src={photoUrl(c.photoUrl)} alt="" className="w-full h-28 object-cover rounded-lg border border-haze mt-1 mb-2" loading="lazy" />}
                    <p className="text-sm font-medium text-ink-navy capitalize flex items-center gap-1.5">
                      <Icon name={VARIANT_GLYPH[c.problemVariant] || 'bolt'} fill className="text-circuit-amber text-base shrink-0" />
                      <span className="truncate">{String(c.problemVariant || '').replace(/-/g, ' ')}</span>
                    </p>
                    <p className="text-xs text-on-surface-variant line-clamp-2 mt-0.5">{c.description || '—'}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[11px] font-mono text-wire-slate">
                      {c.etaMinutes ? <span className="bg-ink-navy text-white px-2 py-0.5 rounded-full">{t('etaPrefix')} {c.etaMinutes < 60 ? c.etaMinutes + 'm' : Math.round(c.etaMinutes / 60) + 'h'}</span> : null}
                      {c.genuinenessScore != null && <span className={c.genuinenessScore < 0.4 ? 'text-fault-red font-bold' : 'text-wire-slate'}>{c.genuinenessScore < 0.4 ? 'Flagged' : c.genuinenessScore > 0.7 ? 'Genuine' : 'Review'}</span>}
                      {c.duplicateConfidence != null && c.isDuplicateOf ? <span>dup {Math.round(c.duplicateConfidence * 100)}%</span> : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {/* Technician History Modal — opened by clicking the technician ID below a problem */}
      {techHistory.open && (
        <div className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center bg-ink-navy/60 backdrop-blur-sm p-0 sm:p-6" onClick={() => setTechHistory((p) => ({ ...p, open: false }))}>
          <div className="bg-surface w-full sm:max-w-3xl max-h-[88vh] sm:max-h-[85vh] rounded-t-3xl sm:rounded-3xl shadow-raised flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-haze bg-paper shrink-0">
              <div className="min-w-0">
                <h3 className="font-display font-bold text-ink-navy text-sm sm:text-base flex items-center gap-2"><Icon name="engineering" className="text-base text-signal-green" />{t('techHistoryTitle')}</h3>
                {techHistory.tech && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] font-mono text-wire-slate mt-0.5">
                    <span className="font-semibold text-ink-navy" style={{fontFamily:'JetBrains Mono, IBM Plex Mono, monospace'}}>{techHistory.tech.name || 'Technician'}</span>
                    {techHistory.tech.technicianId && <span>ID: {techHistory.tech.technicianId}</span>}
                    {techHistory.tech.phone && <span>📞 {techHistory.tech.phone}</span>}
                    {techHistory.tech.status && <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ${techHistory.tech.status === 'on-task' ? 'bg-circuit-amber/15 text-circuit-amber' : techHistory.tech.status === 'available' ? 'bg-signal-green/15 text-signal-green' : 'bg-surface-container-high text-wire-slate'}`}>{techHistory.tech.status}</span>}
                  </div>
                )}
              </div>
              <button onClick={() => setTechHistory((p) => ({ ...p, open: false }))} className="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center text-wire-slate shrink-0" aria-label="Close"><Icon name="close" /></button>
            </div>
            <div className="overflow-y-auto p-4 space-y-2.5">
              {techHistory.loading ? (
                <div className="flex items-center justify-center py-8"><div className="w-8 h-8 border-2 border-haze border-t-circuit-amber rounded-full animate-spin" /></div>
              ) : techHistory.complaints.length === 0 ? (
                <p className="text-center text-sm text-wire-slate py-8">{t('noJobsFound')}</p>
              ) : (
                techHistory.complaints.map((c) => (
                  <div key={c._id} className="bg-paper rounded-xl p-3.5 shadow-card border border-haze/50">
                    <div className="flex justify-between items-start gap-2 mb-1.5">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <span className="font-mono text-[11px] bg-surface-container px-2 py-0.5 rounded text-wire-slate">{faultId(c)}</span>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${c.status === 'registered' ? 'bg-circuit-amber/15 text-circuit-amber' : c.status === 'working' ? 'bg-secondary-container text-on-secondary-container' : 'bg-signal-green/15 text-signal-green'}`}>
                          {c.status === 'registered' ? t('dispatching') : c.status === 'working' ? t('inProgress') : t('filterResolved')}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-wire-slate shrink-0">{new Date(c.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span>
                    </div>
                    <p className="text-sm font-medium text-ink-navy capitalize flex items-center gap-1.5">
                      <Icon name={VARIANT_GLYPH[c.problemVariant] || 'bolt'} fill className="text-circuit-amber text-base shrink-0" />
                      <span className="truncate">{String(c.problemVariant || '').replace(/-/g, ' ')}</span>
                    </p>
                    <p className="text-xs text-on-surface-variant line-clamp-2 mt-0.5">{c.description || '—'}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[11px] font-mono text-wire-slate">
                      {c.etaMinutes ? <span className="bg-ink-navy text-white px-2 py-0.5 rounded-full">{t('etaPrefix')} {c.etaMinutes < 60 ? c.etaMinutes + 'm' : Math.round(c.etaMinutes / 60) + 'h'}</span> : null}
                      {c.citizenId?.meterNumber && <span className="text-circuit-amber">MTR {c.citizenId.meterNumber}</span>}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
