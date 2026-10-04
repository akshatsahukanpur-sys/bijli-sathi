import React, { useEffect, useRef, useState } from 'react';
import { api, faultId } from '../lib/api';
import { Icon, StatusPill, PulseTracker, Spinner, Shell, CallSheet } from '../components/ui';
import { useLang } from '../lib/i18n.jsx';
import MapView, { pinIcon } from '../components/Map';
import ChatAssistant from '../components/ChatAssistant';

export default function TrackComplaint({ id, go }) {
  const { t } = useLang();
  const [c, setC] = useState(null);
  const [ai, setAi] = useState(null);
  const [error, setError] = useState('');
  const [slow, setSlow] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const loadRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setC(null); setAi(null); setError(''); setSlow(false);
    const loadOffline = () => {
      try {
        const sid = String(id);
        // Check any offline storage for this ID (covers local_*, offline_*, and even real IDs that were queued)
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || (!k.startsWith('bs_offline_complaints') && k !== 'bs_pending_complaints')) continue;
          try {
            const list = JSON.parse(localStorage.getItem(k) || '[]');
            const found = Array.isArray(list) ? list.find(x => String(x._id) === sid || String(x._id).slice(-8) === sid.slice(-8)) : null;
            if (found) return found;
          } catch {}
        }
        return null;
      } catch { return null; }
    };
    const load = async () => {
      // Offline/local complaints (queued when submit succeeded locally but not yet in DB) — show immediately
      const offline = loadOffline();
      if (offline) {
        if (alive) {
          setC({ ...offline, status: offline.status || 'registered', aiPhotoAnalysis: offline.aiPhotoAnalysis || { isRelevant: true, confidence: 0.75, reasoning: 'Queued offline — will sync to KESCO when online' } });
          setAi({ genuinenessScore: offline.genuinenessScore ?? 0.85, urgencyScore: offline.urgencyScore ?? 5, etaMinutes: 45, etaLabel: '~45 mins', estimatedResolutionAt: new Date(Date.now()+45*60000).toISOString(), isDuplicate: false, photoAnalysis: offline.aiPhotoAnalysis || { isRelevant: true, confidence: 0.75, reasoning: 'Queued offline — AI will re-analyze after sync' } });
          setError(''); setSlow(false);
        }
        return;
      }
      try {
        const res = await api(`/api/complaints/${id}`);
        if (!res.complaint) throw new Error('Complaint not found');
        if (alive) { setC(res.complaint); setError(''); setSlow(false); }
        try {
          const a = await api(`/api/complaints/${id}/ai-status`);
          if (alive) setAi(a.ai);
        } catch (e) {}
      }
      catch (e) {
        // Always try offline fallback — ensures live tracking never stays on “Loading…” even if backend 404/500
        const fb = loadOffline();
        if (fb && alive) {
          setC({ ...fb, status: fb.status || 'registered', location: fb.location || { type: 'Point', coordinates: [80.3319, 26.4499] } });
          setAi({ genuinenessScore: fb.genuinenessScore ?? 0.85, urgencyScore: fb.urgencyScore ?? 5, etaMinutes: 45, etaLabel: '~45 mins', estimatedResolutionAt: new Date(Date.now()+45*60000).toISOString(), isDuplicate: !!fb.isDuplicateOf, photoAnalysis: fb.aiPhotoAnalysis || { isRelevant: true, confidence: 0.75, reasoning: 'Queued offline — AI will re-analyze after sync to KESCO. You can still track here.' } });
          setError('');
        } else if (alive) {
          // Show helpful error with ID so citizen can report it
          setError(`${e.message} — ID: ${String(id).slice(-8)} • Try Home → My Complaints → tap the card again, or re-submit. If offline, it will sync when online.`);
        }
      }
    };
    loadRef.current = load;
    load();
    const tmr = setInterval(load, 6000);
    // Slow network: just a hint under the spinner — data still loads and takes over when ready
    const fallback = setTimeout(() => { if (alive) setSlow(true); }, 6000);
    const onAuth = () => { setC(null); setAi(null); setError(''); setSlow(false); load(); };
    window.addEventListener('bs_auth_change', onAuth);
    return () => { alive = false; clearInterval(tmr); clearTimeout(fallback); window.removeEventListener('bs_auth_change', onAuth); };
  }, [id]);

  if (!c && error) return (
    <Shell navLinks={[]}>
      <div className="text-center py-20"><Icon name="error" className="text-fault-red text-4xl mb-3" /><p className="text-fault-red px-4">{error}</p>
        <div className="mt-5 flex flex-col sm:flex-row items-center justify-center gap-3 px-4">
          <button onClick={() => { setError(''); setSlow(false); loadRef.current && loadRef.current(); }} className="bg-circuit-amber text-ink-navy font-bold px-6 py-3 rounded-xl active:scale-95 shadow-glow-amber flex items-center gap-2"><Icon name="refresh" /> {t('retryNow')}</button>
          <button onClick={() => go('#/complaints')} className="text-circuit-amber font-semibold">← {t('backToComplaints')}</button>
        </div>
      </div>
    </Shell>
  );
  if (!c) return (
    <Shell navLinks={[]}>
      <div className="flex flex-col items-center justify-center py-20 gap-2">
        <Spinner label={t('loadingLiveStatus')} />
        {slow && <p className="text-xs text-wire-slate text-center px-6">{t('slowNetwork')}</p>}
      </div>
    </Shell>
  );

  const tech = typeof c.assignedTechnicianId === 'object' ? c.assignedTechnicianId : null;
  const faultPos = c.location?.coordinates ? [c.location.coordinates[1], c.location.coordinates[0]] : null;
  const techPos = tech?.currentLocation?.coordinates ? [tech.currentLocation.coordinates[1], tech.currentLocation.coordinates[0]] : null;
  const distanceKm = (() => {
    if (!faultPos || !techPos) return null;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(techPos[0] - faultPos[0]);
    const dLng = toRad(techPos[1] - faultPos[1]);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(faultPos[0])) * Math.cos(toRad(techPos[0])) * Math.sin(dLng / 2) ** 2;
    return (6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1);
  })();
  const techPhone = tech?.phone || '';
  const isFalseComplaint = (ai?.genuinenessScore ?? 1) < 0.4;
  // Message (Gmail) — auto-filled receiver + subject + body from the submitted complaint
  const mailTo = tech?.email || 'support@bijlisathi.in';
  const mailSubject = `BijliSathi complaint ${faultId(c)} — ${String(c.problemVariant || '').replace(/-/g, ' ')} [${c.status}]`;
  const mailBody = `Namaste ${tech?.name || 'Technician'},\n\nRegarding my BijliSathi complaint:\n• Complaint ID: ${faultId(c)}\n• Problem: ${String(c.problemVariant || '').replace(/-/g, ' ')}\n• Status: ${c.status}\n• Reported: ${c.createdAt ? new Date(c.createdAt).toLocaleString('en-IN') : ''}\n• Description: ${c.description || '-'}\n• Location: ${c.location?.coordinates ? `${c.location.coordinates[1].toFixed(5)}, ${c.location.coordinates[0].toFixed(5)}` : '-'}\n\nPlease update me on the repair status.\n\nDhanyavaad,`;
  // WhatsApp prefill — includes complaint context so technician knows which fault
  const waPrefill = `Namaste ${tech?.name || ''}, regarding BijliSathi complaint ${faultId(c)} (${String(c.problemVariant || '').replace(/-/g, ' ')}) — `;

  return (
    <Shell navLinks={[
      { icon: 'home', label: t('navHome'), onClick: () => go('#/home') },
      { icon: 'add_circle', label: t('navReport'), onClick: () => go('#/report') },
      { icon: 'timeline', label: t('trackComplaint'), active: true },
      { icon: 'person', label: t('navProfile'), onClick: () => go('#/profile') },
    ]} wide>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 xs:gap-3 mb-4 xs:mb-5">
        <div className="flex items-center gap-2.5 xs:gap-3 min-w-0 flex-1">
          <button onClick={() => go('#/complaints')} className="hidden lg:flex w-10 h-10 rounded-xl bg-paper border border-haze items-center justify-center text-ink-navy hover:border-circuit-amber transition-colors shrink-0"><Icon name="arrow_back" /></button>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-xl xs:text-2xl md:text-3xl font-bold text-ink-navy capitalize leading-tight truncate">{c.problemVariant.replace(/-/g, ' ')}</h1>
            <p className="text-[11px] xs:text-xs font-mono text-wire-slate truncate">{faultId(c)} • {new Date(c.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</p>
          </div>
        </div>
        <div className="shrink-0 self-start sm:self-auto"><StatusPill status={c.status} /></div>
      </div>

      <div className="grid lg:grid-cols-5 gap-4 xs:gap-6 items-start">
        {/* Map + tracker — INITIAL MOBILE: stacked, 18px radius cards, swipe-friendly */}
        <div className={`${isFalseComplaint ? 'lg:col-span-5' : 'lg:col-span-3'} space-y-3 xs:space-y-4`}>
          <div className="bg-paper rounded-[18px] xs:rounded-2xl shadow-card border border-white/60 sm:border-haze/60 p-4 xs:p-5">
            {(ai?.genuinenessScore ?? 1) < 0.4 ? (
              <div className="bg-error-container/60 border border-fault-red/25 rounded-xl p-4 text-left">
                <p className="text-sm font-bold text-on-error-container flex items-center gap-1.5"><Icon name="gpp_maybe" className="text-base" /> {t('falseNotRegisteredTitle')}</p>
                <p className="text-xs text-on-surface-variant mt-1.5 leading-relaxed">{t('falseStrictMsg')}</p>
              </div>
            ) : (
              <PulseTracker stage={c.status} />
            )}
            {/* Technician-set ETA — citizen sees the fix time given by the accepted lineman */}
            {ai?.etaMinutes != null && c.status === 'working' && (
              <div className="flex items-start gap-3 bg-ink-navy rounded-xl p-3 mt-3 text-white shadow-card">
                <div className="w-9 h-9 rounded-full bg-circuit-amber flex items-center justify-center shrink-0">
                  <Icon name="schedule" className="text-ink-navy text-lg" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-circuit-amber">{t('techEtaTitle')}</p>
                  <p className="text-sm font-bold leading-tight mt-0.5">
                    {ai.estimatedResolutionAt ? new Date(ai.estimatedResolutionAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ai.etaLabel}
                    <span className="font-normal text-white/80"> • {ai.etaLabel}</span>
                  </p>
                  <p className="text-[11px] text-white/60 mt-1 leading-snug">
                    {t('techEtaDesc')}
                  </p>
                </div>
              </div>
            )}
            {!isFalseComplaint && !ai?.etaMinutes && c.status !== 'resolved' && !tech && (
              <div className="flex items-start gap-2 bg-circuit-amber/12 border border-circuit-amber/30 rounded-xl p-3 mt-3">
                <Icon name="engineering" className="text-circuit-amber shrink-0 mt-0.5 text-base" />
                <div>
                  <p className="text-xs font-bold text-ink-navy">{t('awaitingAssignment')}</p>
                  <p className="text-xs text-on-surface-variant leading-relaxed">
                    Once assigned, the technician will read your description &amp; photo and provide an estimated resolution time.
                  </p>
                </div>
              </div>
            )}
            {!isFalseComplaint && ai?.isDuplicate && (
              <div className="flex items-start gap-2 bg-circuit-amber/12 border border-circuit-amber/30 rounded-xl p-3 mt-3">
                <Icon name="join_full" className="text-circuit-amber shrink-0 mt-0.5 text-base" />
                <div>
                  <p className="text-xs font-bold text-ink-navy">{t('aiDuplicateTitle')}</p>
                  <p className="text-xs text-on-surface-variant leading-relaxed">
                    {t('aiDuplicateDesc')}
                  </p>
                </div>
              </div>
            )}
            {ai?.genuinenessScore != null && ai.genuinenessScore < 0.4 && (
              <div className="flex items-start gap-2 bg-surface-container border border-haze rounded-xl p-3 mt-3">
                <Icon name="gpp_maybe" className="text-wire-slate shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-bold text-ink-navy">{t('aiHeldTitle')}</p>
                  <p className="text-xs text-wire-slate leading-relaxed">
                    {t('falseStrictMsg')}
                  </p>
                </div>
              </div>
            )}
            {!ai?.photoAnalysis && c.isDuplicateOf && (
              <div className="flex items-start gap-2 bg-secondary-fixed/30 border border-circuit-amber/25 rounded-xl p-3 mt-2">
                <Icon name="join_full" className="text-circuit-amber shrink-0 mt-0.5 text-base" />
                <p className="text-xs text-on-surface-variant leading-relaxed">{t('nearbyMerged')}</p>
              </div>
            )}
            {!isFalseComplaint && c.status !== 'resolved' && c.safetyPrecautions && (
              <div className="rounded-xl border border-error-container bg-error-container/30 p-3.5 mt-3">
                <p className="text-[11px] font-extrabold uppercase tracking-widest text-fault-red flex items-center gap-1.5 mb-2">
                  <Icon name="warning" className="text-sm" /> {t('safetyPrecautionsTitle')} <span className="text-[9px] normal-case font-bold text-wire-slate">AI</span>
                </p>
                <ul className="space-y-1.5">
                  {String(c.safetyPrecautions).split('\n').filter(Boolean).map((s, i) => (
                    <li key={i} className="text-[11px] xs:text-xs text-on-surface-variant leading-snug flex gap-1.5"><span className="text-fault-red shrink-0 mt-0.5">•</span>{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {!isFalseComplaint && (
          <div className="bg-paper rounded-[18px] xs:rounded-2xl shadow-card border border-white/60 sm:border-haze/60 overflow-hidden relative z-0">
            <MapView
              center={faultPos || undefined}
              zoom={15}
              height={techPos ? 'h-[300px] xs:h-[360px] sm:h-[420px]' : 'h-[260px] xs:h-[300px] sm:h-[380px]'}
              markers={[
                ...(faultPos ? [{ lat: faultPos[0], lng: faultPos[1], icon: pinIcon({ color: '#0A1B33', glyph: 'home' }) }] : []),
                ...(techPos && c.status === 'working' ? [{ lat: techPos[0], lng: techPos[1], icon: pinIcon({ color: '#F2A93B', glyph: 'engineering', ping: true }) }] : []),
              ]}
              paths={faultPos && techPos && c.status === 'working' ? [{ from: techPos, to: faultPos, color: '#F2A93B' }] : []}
              fitStrategy={techPos ? 'once' : 'always'}
            />
          </div>
          )}
        </div>

        {/* Right rail — hidden for false complaints: nothing proceeds, only the warning above */}
        {!isFalseComplaint && (
        <div className="lg:col-span-2 space-y-4">
          {/* What happens next — the response: outcome steps only, no verification internals */}
          <div className="bg-paper rounded-[18px] sm:rounded-2xl shadow-card border border-white/60 sm:border-haze/60 p-5 xs:p-6 rise">
            <h3 className="font-display font-bold text-ink-navy mb-4 flex items-center gap-1.5"><Icon name="route" className="text-circuit-amber" />{t('nextStepsTitle')}</h3>
            <div className="space-y-3">
              {(() => {
                const isHeld = (ai?.genuinenessScore ?? 1) < 0.4;
                const triaged = !!ai;
                const steps = isHeld
                  ? [
                      { label: t('stepReported'), state: 'done' },
                      { label: t('stepReview'), state: 'current' },
                    ]
                  : [
                      { label: t('stepReported'), state: 'done' },
                      { label: t('stepVerified'), state: triaged ? 'done' : 'current' },
                      { label: t('stepAssigned'), state: tech ? 'done' : triaged ? 'current' : 'todo' },
                      { label: t('stepRepair'), state: c.status === 'resolved' ? 'done' : c.status === 'working' ? 'current' : 'todo' },
                      { label: t('stepResolved'), state: c.status === 'resolved' ? 'done' : 'todo' },
                    ];
                return steps.map((s) => (
                  <div key={s.label} className="flex items-center gap-3">
                    <span className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${s.state === 'done' ? 'bg-signal-green text-white' : s.state === 'current' ? 'bg-circuit-amber text-ink-navy' : 'bg-surface-container-high text-wire-slate'}`}>
                      {s.state === 'done' ? <Icon name="check" className="text-sm" /> : s.state === 'current' ? <span className="w-2 h-2 rounded-full bg-ink-navy pulse-dot" /> : <span className="w-1.5 h-1.5 rounded-full bg-wire-slate/50" />}
                    </span>
                    <p className={`text-xs ${s.state === 'todo' ? 'text-wire-slate' : 'font-bold text-ink-navy'}`}>{s.label}</p>
                  </div>
                ));
              })()}
            </div>
          </div>
          {tech ? (
            <div className="bg-paper rounded-[18px] sm:rounded-2xl shadow-card border border-white/60 sm:border-haze/60 p-5 xs:p-6 rise">
              <h3 className="font-display font-bold text-ink-navy mb-1 flex items-center gap-1.5"><Icon name="engineering" fill className="text-circuit-amber" />{t('yourTechLive')}</h3>
              <p className="text-[11px] text-wire-slate mb-4">{t('assignedByKesco')}</p>
              <div className="flex items-center gap-4">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full bg-surface-container-high border-2 border-circuit-amber flex items-center justify-center overflow-hidden">
                    <Icon name="engineering" fill className="text-circuit-amber text-3xl" />
                  </div>
                  {c.status === 'working' && <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-signal-green rounded-full border-2 border-paper" title={t('onTask')} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-display font-bold text-lg text-ink-navy truncate">{tech.name || 'KESCO Lineman'}</p>
                  <p className="text-xs text-wire-slate truncate">{tech.technicianId || tech._id?.slice(-6) || ''} • {tech.status === 'on-task' ? t('onTheWay') : tech.status}</p>
                  {techPhone && <p className="text-xs font-mono text-ink-navy mt-0.5">📞 {techPhone}</p>}
                  {distanceKm && <p className="text-[11px] text-circuit-amber font-bold mt-0.5">~{distanceKm} {t('kmAway')}</p>}
                </div>
              </div>
              {/* Live location details */}
              {(techPos || faultPos) && (
                <div className="mt-4 space-y-2 text-xs">
                  {techPos && (
                    <div className="flex items-center gap-2 bg-signal-green/10 border border-signal-green/20 rounded-xl px-3 py-2.5">
                      <span className="w-2 h-2 rounded-full bg-signal-green pulse-dot shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="font-bold text-signal-green">{t('liveLocationSharing')}</span>
                        <span className="block font-mono text-wire-slate text-[11px]">{techPos[0].toFixed(5)}, {techPos[1].toFixed(5)} {distanceKm ? `• ${distanceKm} ${t('kmAway')}` : ''} • updates every 6s</span>
                      </span>
                      <a href={`https://www.google.com/maps/search/?api=1&query=${techPos[0]},${techPos[1]}`} target="_blank" rel="noreferrer" className="text-[11px] font-bold text-ink-navy bg-paper border border-haze px-2 py-1 rounded-full hover:border-circuit-amber shrink-0">{t('mapsBtn')}</a>
                    </div>
                  )}
                  {faultPos && (
                    <div className="flex items-center gap-2 bg-surface-container-low rounded-xl px-3 py-2.5 border border-haze/50">
                      <Icon name="location_on" fill className="text-circuit-amber text-base shrink-0" />
                      <span className="font-mono text-wire-slate text-[11px] truncate">{t('faultLabel')} {faultPos[0].toFixed(5)}, {faultPos[1].toFixed(5)}</span>
                      <a href={`https://www.google.com/maps/search/?api=1&query=${faultPos[0]},${faultPos[1]}`} target="_blank" rel="noreferrer" className="ml-auto text-[11px] font-bold text-ink-navy bg-paper border border-haze px-2 py-1 rounded-full hover:border-circuit-amber shrink-0">{t('mapsBtn')}</a>
                    </div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2.5 mt-4 pt-4 border-t border-haze/60">
                <div className="bg-surface-container-low rounded-xl p-3.5 text-center">
                  <p className="font-mono text-[10px] text-wire-slate tracking-wider mb-1">{t('statusLabel')}</p>
                  <p className="font-bold text-ink-navy text-sm capitalize">{tech.status === 'on-task' ? t('onTask') : tech.status}</p>
                </div>
                <div className="bg-surface-container-low rounded-xl p-3.5 text-center">
                  <p className="font-mono text-[10px] text-wire-slate tracking-wider mb-1">{t('liveGpsLabel')}</p>
                  <p className={`font-bold text-sm ${c.status === 'working' && techPos ? 'text-signal-green' : 'text-wire-slate'}`}>{c.status === 'working' && techPos ? t('liveSharing') : c.status === 'working' ? t('starting') : t('idle')}</p>
                </div>
              </div>
              <div className="mt-4 flex gap-2.5">
                {techPhone ? (
                  <button onClick={() => setCallOpen(true)} className="flex-1 bg-signal-green text-white text-sm font-bold py-3.5 rounded-xl shadow-card flex items-center justify-center gap-2 active:scale-[0.98] transition-transform">
                    <Icon name="call" fill /> {t('callLabel')} {tech.name?.split(' ')[0] || t('callTechShort')}
                  </button>
                ) : (
                  <span className="flex-1 bg-surface-container border border-haze text-wire-slate text-xs font-semibold py-3.5 rounded-xl flex items-center justify-center">{t('phoneNotOnFile')}</span>
                )}
                <button onClick={() => {
                  // Directly open Gmail web compose with auto-filled receiver / subject / body
                  const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(mailTo)}&su=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(mailBody)}`;
                  try {
                    const w = window.open(url, '_blank', 'noopener');
                    if (!w) window.location.href = url;
                  } catch (e) { try { window.location.href = url; } catch (e2) {} }
                }} className="flex-1 bg-surface-container border border-haze text-ink-navy text-sm font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 hover:bg-haze/40 active:scale-[0.98] transition-all">
                  <Icon name="chat" /> {t('messageBtn')}
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-paper rounded-2xl shadow-card p-8 border border-dashed border-haze text-center">
              <div className="w-16 h-16 mx-auto rounded-full bg-surface-container flex items-center justify-center mb-3">
                <Icon name="hourglass_top" className="text-circuit-amber text-3xl" />
              </div>
              <p className="font-semibold text-ink-navy">{t('awaitingAssignment')}</p>
              <p className="text-xs text-wire-slate mt-1.5 leading-relaxed">{t('assignWaitDesc')}</p>
            </div>
          )}

          {/* Complaint details — citizen response only: ETA + location, no verification internals */}
          <div className="bg-paper rounded-2xl shadow-card border border-haze/60 p-5">
            <h3 className="font-semibold text-ink-navy text-sm mb-3 flex items-center gap-2"><Icon name="receipt_long" className="text-circuit-amber text-base" /> {t('reportSummary')}</h3>
            {c.description && <p className="text-sm text-on-surface-variant leading-relaxed mb-3">{c.description}</p>}
            <div className="space-y-2 text-xs">
              {ai?.etaMinutes != null && <Row k={t('eta')} v={`${ai.etaLabel} • ${ai.estimatedResolutionAt ? new Date(ai.estimatedResolutionAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''}`} />}
              {c.estimatedResolutionAt && !ai?.etaMinutes && <Row k={t('eta')} v={new Date(c.estimatedResolutionAt).toLocaleString('en-IN', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })} />}
              {faultPos && <Row k={t('coordinates')} v={`${faultPos[0].toFixed(4)}, ${faultPos[1].toFixed(4)}`} mono />}
            </div>
          </div>

          {c.status === 'resolved' && (
            <div className="bg-signal-green/[0.08] border border-signal-green/25 rounded-2xl p-6 text-center rise">
              <div className="w-14 h-14 mx-auto rounded-full bg-signal-green text-white flex items-center justify-center mb-2 shadow-card"><Icon name="check" /></div>
              <p className="font-display font-bold text-ink-navy">{t('markedResolved')}</p>
              {c.resolutionNotes && <p className="text-xs text-wire-slate mt-1">"{c.resolutionNotes}"</p>}
              <div className="mt-4 flex gap-2 justify-center">
                <button className="text-xs px-4 py-2 rounded-full border border-haze bg-paper text-ink-navy active:scale-95">{t('reopenBtn')}</button>
                <button className="text-xs px-4 py-2 rounded-full bg-signal-green text-white active:scale-95">{t('confirmBtn')}</button>
              </div>
            </div>
          )}
        </div>
        )}
      </div>
      {/* ChatGPT-type assistant — hidden for false complaints */}
      {!isFalseComplaint && <ChatAssistant complaintId={c._id} title="Sathi — Complaint Assistant" collapsedLabel="Sathi" />}
      {callOpen && techPhone ? <CallSheet phone={techPhone} name={tech?.name || 'Technician'} waText={waPrefill} onClose={() => setCallOpen(false)} /> : null}
    </Shell>
  );
}

function Row({ k, v, mono }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-wire-slate uppercase tracking-wide text-[10px] font-semibold mt-0.5">{k}</span>
      <span className={`text-ink-navy font-medium text-right ${mono ? 'font-mono' : ''}`}>{v}</span>
    </div>
  );
}
