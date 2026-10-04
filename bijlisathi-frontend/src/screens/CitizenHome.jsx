import React, { useEffect, useState } from 'react';
import { api, photoUrl, clearAuth, faultId } from '../lib/api';
import { Icon, StatusPill, UrgencyBadge, Spinner, EmptyState, Shell } from '../components/ui';
import { useLang } from '../lib/i18n.jsx';
import ChatAssistant from '../components/ChatAssistant';

export const VARIANT_META = {
  'transformer-fault': { icon: 'electric_bolt', label: 'Sparking / Transformer' },
  'broken-wire': { icon: 'cable', label: 'Wire Down' },
  'meter-fault': { icon: 'electric_meter', label: 'Meter Fault' },
  'no-power': { icon: 'power_off', label: 'No Power' },
  // 'waves' caused WAVE text spill on slow font load — keep Icon SVG fallback for legacy DB rows with 'waves',
  // but new code uses valid 'show_chart' glyph (always in font) to avoid any ligature miss.
  'voltage-fluctuation': { icon: 'show_chart', label: 'Voltage Issue' },
  'streetlight': { icon: 'lightbulb', label: 'Streetlight' },
};

const citizenNav = (go, active, t) => [
  { icon: 'home', label: t('navHome'), mobile: true, active: active === 'home', onClick: () => go('#/home') },
  { icon: 'add_circle', label: t('navReport'), mobile: true, active: active === 'report', onClick: () => go('#/report') },
  { icon: 'person', label: t('navProfile'), mobile: true, active: active === 'profile', onClick: () => go('#/profile') },
  { icon: 'logout', label: t('navLogout'), mobile: false, footer: true, onClick: () => { try { clearAuth(); } catch (e) {} go('#/'); } },
];

export default function CitizenHome({ go }) {
  const lang = useLang();
  const t = lang?.t ? lang.t : (k) => k;
  const [complaints, setComplaints] = useState([]);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    const mergeOffline = (list) => {
      try {
        const auth = JSON.parse(localStorage.getItem('bs_auth') || 'null');
        const uid = auth?.userId || auth?.id;
        const keys = [`bs_offline_complaints_${uid}`, 'bs_offline_complaints_citizen', 'bs_pending_complaints'];
        let offline = [];
        for (const k of keys) {
          try { const l = JSON.parse(localStorage.getItem(k) || '[]'); if (Array.isArray(l)) offline = offline.concat(l); } catch {}
        }
        // Also scan all bs_offline_complaints_* keys
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('bs_offline_complaints') && !keys.includes(k)) {
            try { const l = JSON.parse(localStorage.getItem(k) || '[]'); if (Array.isArray(l)) offline = offline.concat(l); } catch {}
          }
        }
        if (!offline.length) return list;
        const ids = new Set(list.map(x => String(x._id)));
        const toAdd = offline.filter(x => !ids.has(String(x._id)));
        return [...toAdd, ...list];
      } catch { return list; }
    };
    const load = () => {
      api('/api/complaints/my').then((r) => setComplaints(mergeOffline(r.complaints || []))).catch(() => {
        // Offline: show local only so live tracking still works
        setComplaints(mergeOffline([]));
      });
    };
    load();
    const onAuth = () => load();
    window.addEventListener('bs_auth_change', onAuth);
    window.addEventListener('storage', onAuth);
    return () => { window.removeEventListener('bs_auth_change', onAuth); window.removeEventListener('storage', onAuth); };
  }, []);

  const active = complaints?.find((c) => c.status !== 'resolved');
  const [search, setSearch] = useState('');
  const searchRef = React.useRef(null);
  React.useEffect(() => {
    const h = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const filtered = (complaints || []).filter((c) => filter === 'all' || c.status === filter);
  const searched = (() => {
    const q = search.trim().toLowerCase();
    if (!q) return filtered;
    return filtered.filter((c) => {
      const label = (VARIANT_META[c.problemVariant]?.label || c.problemVariant || '').toLowerCase();
      const desc = (c.description || '').toLowerCase();
      const id = String(c._id || '').toLowerCase();
      const shortId = String(c._id || '').slice(-8).toLowerCase();
      const tid = String(c.ticketId || '').toLowerCase();
      const status = String(c.status || '').toLowerCase();
      const urgency = String(c.urgencyScore ?? '').toLowerCase();
      const date = new Date(c.createdAt).toLocaleString('en-IN').toLowerCase();
      return label.includes(q) || desc.includes(q) || id.includes(q) || shortId.includes(q) || tid.includes(q) || status.includes(q) || urgency.includes(q) || date.includes(q);
    });
  })();
  const TABS = [['all', t('filterAll')], ['registered', t('filterRegistered')], ['working', t('filterWorking')], ['resolved', t('filterResolved')]];

  return (
    <Shell navLinks={citizenNav(go, 'home', t)}>
      {/* Greeting — single report panel lives in main grid only */}
      <div className="rise mb-6 lg:mb-8 w-full max-w-full min-w-0 overflow-hidden box-border">
        <p className="text-[15px] xs:text-base sm:text-lg text-wire-slate font-bold flex items-center gap-2 min-w-0"><span className="w-2 h-2 rounded-full bg-signal-green pulse-dot shrink-0" />{t('namaste')}</p>
        <h1 className="font-display text-[22px] xs:text-2xl sm:text-3xl font-extrabold text-ink-navy leading-tight mt-1 tracking-tight break-words overflow-wrap-anywhere w-full max-w-full">{t('citizenHomeTitle')}</h1>
        <p className="text-xs sm:text-sm text-wire-slate mt-1.5 break-words">{t('myComplaintsSub')}</p>
      </div>

      <div className="grid lg:grid-cols-5 gap-4 xs:gap-6 w-full max-w-full min-w-0 overflow-hidden box-border">
        {/* Left column — when stats visible (no active), share row 3+2, else full width */}
        <div className={`${active ? 'lg:col-span-5' : 'lg:col-span-3'} space-y-4 xs:space-y-5 w-full max-w-full min-w-0 overflow-hidden box-border`}>
          {/* Active tracking hero */}
          {active && (
            <button onClick={() => { try{navigator.vibrate&&navigator.vibrate(10)}catch{} go(`#/track/${active._id}`); }} className="rise rise-d1 w-full max-w-full min-w-0 box-border text-left bg-gradient-to-br from-paper to-surface-container-low rounded-[18px] sm:rounded-2xl p-3.5 sm:p-6 shadow-card border-l-4 border-l-circuit-amber border-y border-r border-haze/50 hover:shadow-glow-amber active:scale-[0.98] transition-all group overflow-hidden pressable">
              <div className="flex flex-col gap-2.5 mb-3 min-w-0 w-full max-w-full overflow-hidden">
                <div className="flex items-start gap-2.5 sm:gap-3 min-w-0 w-full max-w-full">
                  <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-circuit-amber/15 flex items-center justify-center shrink-0 mt-0.5 overflow-hidden">
                    <Icon name={VARIANT_META[active.problemVariant]?.icon || 'bolt'} fill className="text-circuit-amber text-xl sm:text-2xl" />
                  </div>
                  <div className="min-w-0 flex-1 max-w-full overflow-hidden">
                    <p className="font-display font-extrabold text-ink-navy text-sm sm:text-base leading-tight break-words">{VARIANT_META[active.problemVariant]?.label || active.problemVariant}</p>
                    <p className="text-[11px] sm:text-xs font-mono text-wire-slate leading-tight break-all overflow-wrap-anywhere max-w-full">#{faultId(active)} • {new Date(active.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                  <div className="shrink-0 hidden sm:block max-w-full overflow-hidden"><StatusPill status={active.status} /></div>
                </div>
                <div className="sm:hidden flex justify-start min-w-0"><StatusPill status={active.status} /></div>
              </div>
              <div className="flex items-center justify-between bg-ink-navy rounded-full sm:rounded-xl px-3 sm:px-3.5 sm:px-4 py-3 gap-2 min-w-0 w-full max-w-full box-border overflow-hidden">
                <span className="text-xs sm:text-sm text-white font-semibold flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden"><span className="w-2 h-2 rounded-full bg-circuit-amber pulse-dot shrink-0" /> <span className="truncate min-w-0">{t('liveRepairProgress')}</span></span>
                <span className="bg-white/10 rounded-full px-2.5 py-1 text-circuit-amber text-[11px] sm:text-sm font-bold flex items-center gap-1 group-hover:gap-1.5 transition-all shrink-0 whitespace-nowrap max-w-[45%] justify-center">{t('trackBtn')} <Icon name="arrow_forward" className="text-sm sm:text-base shrink-0" /></span>
              </div>
            </button>
          )}

          {/* SINGLE Report Issue panel — one type only, for citizen home */}
          <button onClick={() => { try{navigator.vibrate&&navigator.vibrate(10)}catch{} go('#/report'); }} className="rise rise-d1 w-full bg-gradient-to-br from-circuit-amber to-[#fdb244] rounded-[20px] xs:rounded-2xl p-5 xs:p-6 sm:p-8 shadow-glow-amber hover:-translate-y-0.5 active:scale-[0.97] transition-all group pressable">
            <div className="flex items-center gap-3 xs:gap-5">
              <span className="w-12 h-12 xs:w-14 xs:h-14 rounded-full bg-ink-navy/10 flex items-center justify-center shrink-0">
                <Icon name="report" fill className="text-[28px] xs:text-[32px] sm:text-[36px] text-ink-navy" />
              </span>
              <div className="text-left min-w-0 flex-1">
                <p className="font-display text-lg xs:text-xl md:text-2xl font-extrabold text-ink-navy leading-tight">{t('reportNew')}</p>
                <p className="text-xs xs:text-sm text-ink-navy/70 mt-0.5 leading-tight font-medium">{t('citizenCtaSub')}</p>
              </div>
              <span className="ml-auto w-9 h-9 rounded-full bg-ink-navy text-white hidden sm:flex items-center justify-center shrink-0 group-hover:translate-x-0.5 transition-transform">
                <Icon name="arrow_forward" className="text-lg" />
              </span>
            </div>
          </button>

          {/* My Complaints — with improved search (issue section) */}
          <section className="rise rise-d2 w-full max-w-full min-w-0 overflow-hidden box-border">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2 mb-2">
              <div>
                <h2 className="font-display text-base xs:text-lg font-extrabold text-ink-navy break-words">{t('myComplaints')}</h2>
                <p className="text-xs xs:text-sm text-wire-slate break-words">{t('myComplaintsSub')}</p>
              </div>
              {filtered.length > 0 && <span className="text-[11px] font-mono text-wire-slate bg-surface-container px-2 py-1 rounded-full border border-haze">{searched.length}/{filtered.length}</span>}
            </div>
            {/* Search bar — premium: elevated pill, amber icon, glow focus, responsive */}
            <div className="relative mb-3.5">
              <div className="relative flex items-center gap-2 bg-white rounded-2xl shadow-[0_2px_12px_rgba(10,27,51,0.10)] border border-haze/50 px-3 py-2.5 focus-within:border-circuit-amber focus-within:shadow-[0_4px_20px_rgba(242,169,59,0.25)] focus-within:bg-white transition-all duration-200">
                <span className="w-10 h-10 rounded-xl bg-circuit-amber/15 flex items-center justify-center shrink-0 shadow-sm">
                  <Icon name="search" className="text-circuit-amber text-base" />
                </span>
                <input
                  ref={searchRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setSearch(''); }}
                  placeholder="Search issues — sparking, wire, ID, status, date…"
                  className="flex-1 bg-transparent py-1 text-[15px] text-ink-navy placeholder-wire-slate/50 focus:outline-none min-w-0 font-medium leading-relaxed"
                />
                {search ? (
                  <button onClick={() => setSearch('')} className="w-9 h-9 rounded-full bg-ink-navy text-white hover:bg-grid-navy active:scale-90 flex items-center justify-center shrink-0 transition-all shadow-md" aria-label="Clear search"><Icon name="close" className="text-sm" /></button>
                ) : (
                  <span className="hidden sm:flex items-center gap-1 text-[10px] font-bold tracking-widest uppercase text-wire-slate/70 bg-surface-container-high px-2.5 py-1.5 rounded-full border border-haze/60 shrink-0">Ctrl K</span>
                )}
              </div>
              {search.trim() ? (
                searched.length > 0 ? <p className="text-[11px] text-signal-green mt-2 ml-1 flex items-center gap-1 font-medium"><span className="w-1.5 h-1.5 rounded-full bg-signal-green pulse-dot" />{searched.length} match{searched.length!==1?'es':''} for "{search.trim()}"</p>
                : <p className="text-[11px] text-fault-red mt-2 ml-1 font-medium">No matches — try another keyword</p>
              ) : null}
            </div>
            {/* Filter tabs — INITIAL MOBILE: edge fade + snap + 36dp hit, scroll-fade only <1024px (mobile polish) */}
            <div className="relative scroll-fade mb-4 sm:mb-5 -mx-3 sm:mx-0 px-3 sm:px-0 w-full max-w-full min-w-0 box-border overflow-hidden">
              <div className="flex gap-2 sm:gap-2 overflow-x-auto hide-scrollbar pb-2 snap-x snap-mandatory pr-6 w-full max-w-full min-w-0 box-border">
                {TABS.map(([k, l]) => (
                  <button key={k} onClick={() => { try{navigator.vibrate&&navigator.vibrate(5)}catch{} setFilter(k); }}
                    className={`px-3.5 sm:px-4 py-2 sm:py-2 rounded-full text-xs sm:text-sm font-bold whitespace-nowrap transition-all snap-start shrink-0 min-h-[36px] active:scale-95 box-border ${filter === k ? 'bg-ink-navy text-white shadow-card' : 'bg-paper border border-haze/80 text-wire-slate hover:border-circuit-amber hover:text-ink-navy'}`}>
                    {l} {k !== 'all' && complaints && <span className={`${filter===k?'text-white/70':'opacity-60'} ml-1`}>({complaints.filter((c) => c.status === k).length})</span>}
                  </button>
                ))}
                <span className="shrink-0 w-6 sm:w-0" aria-hidden />
              </div>
            </div>
            {searched.length === 0 ? (
              search.trim() ? (
                <div className="bg-paper border border-haze rounded-2xl p-8 text-center shadow-card">
                  <Icon name="search_off" className="text-wire-slate text-3xl mb-2" />
                  <p className="font-bold text-ink-navy text-sm">No matches for “{search.trim()}”</p>
                  <p className="text-xs text-wire-slate mt-1">Try fault type (sparking, wire), status, or ID • <button onClick={() => setSearch('')} className="text-circuit-amber font-bold hover:underline">Clear search</button></p>
                </div>
              ) : (
                <EmptyState icon="inbox" title={t('emptyNothing')} sub={filter === 'all' ? t('emptyReportFirst') : t('emptyNoFilter')} />
              )
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-3 mobile-stagger w-full max-w-full min-w-0 box-border overflow-hidden">
                {searched.map((c) => (
                  <button key={c._id} onClick={() => go(`#/track/${c._id}`)} className="bg-paper rounded-[16px] sm:rounded-2xl p-3.5 sm:p-4 shadow-card border border-haze/40 text-left hover:border-circuit-amber/50 hover:shadow-raised active:scale-[0.98] transition-all overflow-hidden pressable w-full max-w-full min-w-0 box-border">
                    <div className="flex justify-between items-center gap-2 mb-2.5 sm:mb-3 min-w-0 w-full max-w-full overflow-hidden">
                      <span className="font-mono text-[10px] sm:text-[11px] bg-surface-container px-2 py-1 rounded-full text-wire-slate shrink-0 font-semibold max-w-[45%] truncate">{faultId(c)}</span>
                      <span className="shrink-0 max-w-[55%] flex justify-end overflow-hidden"><StatusPill status={c.status} /></span>
                    </div>
                    <div className="flex items-start gap-3 sm:gap-3 min-w-0 w-full max-w-full overflow-hidden">
                      {c.photoUrl ? (
                        <img src={photoUrl(c.photoUrl)} alt="" className="w-16 h-16 sm:w-16 sm:h-16 rounded-xl object-cover border border-haze/60 shrink-0" />
                      ) : (
                        <div className="w-16 h-16 sm:w-16 sm:h-16 rounded-xl bg-surface-container-high flex items-center justify-center shrink-0 overflow-hidden"><Icon name={VARIANT_META[c.problemVariant]?.icon || 'bolt'} className="text-wire-slate text-xl leading-none" style={{ lineHeight: 1 }} /></div>
                      )}
                      <div className="min-w-0 flex-1 max-w-full overflow-hidden">
                        <p className="font-bold text-sm sm:text-sm text-ink-navy leading-tight break-words overflow-wrap-anywhere">{VARIANT_META[c.problemVariant]?.label || c.problemVariant}</p>
                        {c.description && <p className="text-xs sm:text-xs text-on-surface-variant line-clamp-2 mt-1 leading-relaxed break-words overflow-wrap-anywhere w-full max-w-full">{c.description}</p>}
                      </div>
                    </div>
                    {c.isDuplicateOf && <p className="text-[11px] sm:text-[11px] text-circuit-amber mt-2.5 flex items-center gap-1 font-semibold bg-circuit-amber/10 rounded-full px-2.5 py-1 w-fit max-w-full overflow-hidden"><Icon name="join_full" className="text-sm shrink-0" /> <span className="truncate">{t('merged')}</span></p>}
                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-haze/40 gap-2 min-w-0 w-full max-w-full overflow-hidden">
                      <span className="shrink-0 min-w-0 overflow-hidden"><UrgencyBadge score={c.urgencyScore} /></span>
                      <span className="text-[11px] sm:text-[10px] font-mono text-wire-slate leading-tight whitespace-nowrap shrink-0 truncate min-w-0 max-w-[50%] text-right">{new Date(c.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right rail — fixed: single column on mobile (no squeeze), 3-col only on sm+, vertical on desktop */}
        {!active && (
          <div className="lg:col-span-2 w-full max-w-full min-w-0 overflow-hidden box-border">
            <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-1 gap-3 sm:gap-4 w-full max-w-full min-w-0 box-border">
              <StatCardLite icon="history" label={t('totalReports')} value={complaints?.length ?? '—'} />
              <StatCardLite icon="check_circle" tint="green" label={t('resolvedLabel')} value={complaints?.filter((c) => c.status === 'resolved').length ?? '—'} />
              <StatCardLite icon="schedule" tint="slate" label={t('avgFixTime')} value="45m" sub={t('kescoAvg')} />
            </div>
          </div>
        )}
      </div>
      <ChatAssistant complaintId={active?._id || null} title="Sathi — Your AI Assistant" collapsedLabel="Sathi" />
    </Shell>
  );
}

function StatCardLite({ icon, label, value, sub, tint = 'amber' }) {
  const tints = { amber: 'text-circuit-amber bg-circuit-amber/10', green: 'text-signal-green bg-signal-green/10', slate: 'text-wire-slate bg-surface-container-high' };
  return (
    <div className="bg-paper rounded-2xl p-5 shadow-card border border-haze/50 flex items-center gap-4 w-full max-w-full min-w-0 overflow-hidden box-border">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${tints[tint]}`}><Icon name={icon} /></div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <p className="font-display text-2xl font-bold text-ink-navy leading-none truncate">{value}</p>
        <p className="text-xs text-wire-slate mt-1 break-words leading-tight">{label}{sub && ` • ${sub}`}</p>
      </div>
    </div>
  );
}
