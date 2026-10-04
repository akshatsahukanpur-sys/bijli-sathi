import React, { useEffect, useState } from 'react';
import { api, photoUrl, faultId } from '../lib/api';
import { Icon, StatusPill, UrgencyBadge, Spinner, EmptyState, Shell } from '../components/ui';
import { useLang } from '../lib/i18n.jsx';
import { VARIANT_META } from './CitizenHome';

export default function MyComplaints({ go }) {
  const { t } = useLang();
  const [list, setList] = useState([]);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    api('/api/complaints/my').then((r) => setList(r.complaints || [])).catch(() => setList([]));
  }, []);

  const filtered = (list || []).filter((c) => filter === 'all' || c.status === filter);
  const TABS = [['all', t('filterAll')], ['registered', t('filterRegistered')], ['working', t('filterWorking')], ['resolved', t('filterResolved')]];

  return (
    <Shell navLinks={[
      { icon: 'home', label: t('navHome'), onClick: () => go('#/home') },
      { icon: 'add_circle', label: t('navReport'), onClick: () => go('#/report') },
      { icon: 'assignment_late', label: t('myComplaints'), active: true },
      { icon: 'person', label: t('navProfile'), onClick: () => go('#/profile') },
    ]}>
      <h1 className="font-display text-xl xs:text-2xl md:text-3xl font-bold text-ink-navy mb-1 leading-tight break-words w-full max-w-full">{t('myComplaints')}</h1>
      <p className="text-xs xs:text-sm text-wire-slate mb-4 xs:mb-5 break-words w-full max-w-full">{t('myComplaintsSub')}</p>

      {/* Filter tabs */}
      <div className="flex gap-1.5 xs:gap-2 mb-4 xs:mb-6 overflow-x-auto hide-scrollbar pb-1 -mx-3 xs:mx-0 px-3 xs:px-0 snap-x w-full max-w-full min-w-0 box-border overflow-hidden">
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`px-3 xs:px-4 py-1.5 xs:py-2 rounded-full text-xs xs:text-sm font-semibold whitespace-nowrap transition-all snap-start shrink-0 box-border ${filter === k ? 'bg-ink-navy text-white shadow-card' : 'bg-paper border border-haze text-wire-slate hover:border-circuit-amber hover:text-ink-navy'}`}>
            {l} {k !== 'all' && list && <span className="opacity-60">({list.filter((c) => c.status === k).length})</span>}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="inbox" title={t('emptyNothing')} sub={filter === 'all' ? t('emptyReportFirst') : t('emptyNoFilter')} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 xs:gap-4 w-full max-w-full min-w-0 box-border overflow-hidden">
          {filtered.map((c) => (
            <button key={c._id} onClick={() => go(`#/track/${c._id}`)}
              className="bg-paper rounded-xl xs:rounded-2xl p-3 xs:p-4 shadow-card border border-haze/60 text-left hover:border-circuit-amber hover:shadow-raised hover:-translate-y-0.5 transition-all w-full max-w-full min-w-0 box-border overflow-hidden">
              <div className="flex justify-between items-center gap-2 mb-2 xs:mb-3 min-w-0 w-full max-w-full overflow-hidden">
                <span className="font-mono text-[10px] xs:text-[11px] bg-surface-container px-1.5 xs:px-2 py-0.5 rounded text-wire-slate shrink-0 max-w-[45%] truncate">{faultId(c)}</span>
                <span className="shrink-0 max-w-[55%] flex justify-end overflow-hidden"><StatusPill status={c.status} /></span>
              </div>
              <div className="flex items-start gap-2.5 xs:gap-3 min-w-0 w-full max-w-full overflow-hidden">
                {c.photoUrl ? (
                  <img src={photoUrl(c.photoUrl)} alt="" className="w-14 h-14 xs:w-16 xs:h-16 rounded-lg xs:rounded-xl object-cover border border-haze shrink-0" />
                ) : (
                  <div className="w-14 h-14 xs:w-16 xs:h-16 rounded-lg xs:rounded-xl bg-surface-container-high flex items-center justify-center shrink-0"><Icon name={VARIANT_META[c.problemVariant]?.icon || 'bolt'} className="text-wire-slate text-lg xs:text-xl" /></div>
                )}
                <div className="min-w-0 flex-1 max-w-full overflow-hidden">
                  <p className="font-semibold text-xs xs:text-sm text-ink-navy leading-tight break-words overflow-wrap-anywhere">{VARIANT_META[c.problemVariant]?.label || c.problemVariant}</p>
                  {c.description && <p className="text-[11px] xs:text-xs text-on-surface-variant line-clamp-2 mt-0.5 leading-relaxed break-words overflow-wrap-anywhere w-full max-w-full">{c.description}</p>}
                </div>
              </div>
              {c.isDuplicateOf && <p className="text-[10px] xs:text-[11px] text-circuit-amber mt-2 flex items-center gap-1 max-w-full overflow-hidden"><Icon name="join_full" className="text-xs xs:text-sm shrink-0" /> <span className="truncate">{t('mergedCluster')}</span></p>}
              <div className="flex items-center justify-between mt-2.5 xs:mt-3 pt-2.5 xs:pt-3 border-t border-haze/50 gap-2 min-w-0 w-full max-w-full overflow-hidden">
                <span className="shrink-0 min-w-0 overflow-hidden"><UrgencyBadge score={c.urgencyScore} /></span>
                <span className="text-[9px] xs:text-[10px] font-mono text-wire-slate truncate min-w-0 max-w-[50%] text-right shrink-0">{new Date(c.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </Shell>
  );
}
