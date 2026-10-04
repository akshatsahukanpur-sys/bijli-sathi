import React from 'react';
import { LanguageToggle, useLang } from '../lib/i18n.jsx';

export function Icon({ name, className = '', fill = false, style }) {
  // Voltage fluctuation — SVG fallback so "waves" never renders as raw WAVE text,
  // even if Material Symbols font fails, is blocked, or glyph is missing.
  // Keeps the glitch from ever covering card titles across CitizenHome / MyComplaints / TechTasks / KESCO.
  if (name === 'waves') {
    return (
      <span
        className={`icon-waves-svg ${className} leading-none overflow-hidden`}
        style={{ lineHeight: 1, width: '1em', height: '1em', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden', ...style }}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          {/* Sine-like voltage wave */}
          <path d="M2 12.5 H4.2 C4.9 12.5 5.2 8 6.4 8 C7.6 8 7.9 17 9.2 17 C10.5 17 10.6 8 12 8 C13.4 8 13.5 17 14.8 17 C16.1 17 16.3 8 17.6 8 C18.9 8 19.1 12.5 19.8 12.5 H22" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={`material-symbols-outlined ${fill ? 'icon-fill' : ''} ${className} leading-none overflow-hidden`}
      style={{ lineHeight: 1, width: '1em', height: '1em', maxWidth: '1em', maxHeight: '1em', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden', ...style }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}

/* ---------- Status ---------- */
export function StatusPill({ status }) {
  const { t } = useLang();
  const map = {
    registered: { label: t('statusRegistered'), dot: 'bg-wire-slate', cls: 'bg-surface-container-high text-on-surface-variant border border-haze' },
    working: { label: t('statusWorking'), dot: 'bg-circuit-amber pulse-dot', cls: 'bg-secondary-container text-on-secondary-container' },
    resolved: { label: t('statusResolved'), dot: 'bg-signal-green', cls: 'bg-signal-green/15 text-signal-green border border-signal-green/25' },
  };
  const s = map[status] || map.registered;
  return (
    <span className={`${s.cls} px-2 xs:px-2.5 sm:px-3 py-1 rounded-full text-[10px] xs:text-xs font-semibold flex items-center gap-1 xs:gap-1.5 whitespace-nowrap shrink-0`}>
      <span className={`w-1.5 h-1.5 xs:w-2 xs:h-2 rounded-full ${s.dot} shrink-0`} />
      <span className="hidden xs:inline">{s.label}</span><span className="xs:hidden">{s.label.slice(0,4)}</span>
    </span>
  );
}

export function UrgencyBadge({ score }) {
  const { t } = useLang();
  if (!score && score !== 0) return null;
  const level = score >= 6 ? [t('urgencyUrgent'), 'bg-error-container text-on-error-container'] : score >= 3 ? [t('urgencyHigh'), 'bg-secondary-fixed/60 text-on-secondary-container'] : [t('urgencyLow'), 'bg-surface-container-high text-wire-slate'];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${level[1]}`}>
      <Icon name="local_fire_department" className="text-xs" /> {level[0]} {score}/10
    </span>
  );
}

/* ---------- Tracker ---------- */
export function PulseTracker({ stage }) {
  const { t } = useLang();
  const done = stage === 'working' || stage === 'resolved';
  const allDone = stage === 'resolved';
  const Node = ({ idx, label }) => {
    const isDone = idx === 0 ? true : idx === 1 ? allDone || stage === 'working' : allDone;
    const isActive = idx === 1 ? stage === 'working' : false;
    return (
      <div className="relative z-10 flex flex-col items-center gap-1.5 xs:gap-2 min-w-[64px] xs:min-w-[72px] flex-1">
        <div className={
          isDone
            ? 'w-8 h-8 xs:w-9 xs:h-9 rounded-full flex items-center justify-center bg-circuit-amber text-white shadow-glow-amber animate-pop-in'
            : isActive
              ? 'w-8 h-8 xs:w-9 xs:h-9 rounded-full bg-paper border-2 border-circuit-amber pulse-dot flex items-center justify-center'
              : 'w-8 h-8 xs:w-9 xs:h-9 rounded-full bg-surface-container border-2 border-haze flex items-center justify-center'
        } style={isDone ? { animationDelay: `${idx * 80}ms` } : undefined}>
          {isDone ? <Icon name="check" className="text-sm xs:text-base" /> : <span className={`w-2.5 h-2.5 xs:w-3 xs:h-3 rounded-full ${isActive ? 'bg-circuit-amber' : 'bg-wire-slate'}`} />}
        </div>
        <span className={`text-[11px] xs:text-xs font-semibold text-center leading-tight px-1 ${allDone ? 'text-signal-green font-bold' : isDone ? 'text-ink-navy' : isActive ? 'text-circuit-amber font-bold' : 'text-wire-slate'}`}>{label}</span>
      </div>
    );
  };
  return (
    <div className="relative flex justify-between items-start px-1 xs:px-2 mt-6 xs:mt-8 mb-5 xs:mb-6">
      <div className="absolute top-4 left-8 xs:left-10 right-8 xs:right-10 h-1 -translate-y-1/2 z-0 flex rounded-full overflow-hidden">
        <div className={`w-1/2 h-full transition-colors duration-700 ${done ? 'bg-circuit-amber' : 'bg-haze'}`} />
        <div className={`w-1/2 h-full ${allDone ? 'bg-circuit-amber' : 'pulse-line'}`} />
      </div>
      <Node idx={0} label={t('pulseRegistered')} />
      <Node idx={1} label={t('pulseWorking')} />
      <Node idx={2} label={t('pulseResolved')} />
    </div>
  );
}

/* ---------- OTP ---------- */
export function OTPBoxes({ onComplete, error, loading }) {
  const [vals, setVals] = React.useState(['', '', '', '', '', '']);
  const refs = React.useRef([]);

  React.useEffect(() => {
    if (loading) setVals(['', '', '', '', '', '']);
  }, [loading]);

  const handleChange = (i, v) => {
    if (!/^\d?$/.test(v)) return;
    const next = [...vals];
    next[i] = v;
    setVals(next);
    if (v && i < 5) refs.current[i + 1]?.focus();
    if (next.every((x) => x !== '')) onComplete(next.join(''));
  };
  const handleKey = (i, e) => {
    if (e.key === 'Backspace' && !vals[i] && i > 0) refs.current[i - 1]?.focus();
  };
  const handlePaste = (e) => {
    const text = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!text) return;
    e.preventDefault();
    setVals(text.padEnd(6, '').split('').slice(0, 6));
    if (text.length === 6) onComplete(text);
  };

  return (
    <div className="w-full max-w-[360px] mx-auto">
      <div className="flex justify-center gap-1.5 xs:gap-2 sm:gap-3" onPaste={handlePaste}>
        {vals.map((v, i) => (
          <input
            key={i}
            ref={(el) => (refs.current[i] = el)}
            value={v}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKey(i, e)}
            inputMode="numeric"
            maxLength={1}
            className={`flex-1 min-w-0 max-w-[48px] aspect-[0.85] sm:aspect-auto sm:w-12 sm:h-14 h-12 xs:h-13 text-center font-mono text-lg sm:text-xl border-2 rounded-lg sm:rounded-xl bg-surface focus:outline-none focus:border-circuit-amber focus:shadow-glow-amber transition-all ${error ? 'border-fault-red shake' : 'border-haze'}`}
          />
        ))}
      </div>
      {error && <p className="text-xs text-fault-red text-center mt-3 px-2 break-words">{error}</p>}
    </div>
  );
}

/* ---------- Feedback ---------- */
export function Spinner({ label }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-3">
      <div className="relative w-10 h-10">
        <div className="absolute inset-0 rounded-full border-4 border-haze" />
        <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-circuit-amber animate-spin" />
      </div>
      {label && <p className="text-sm text-wire-slate">{label}</p>}
    </div>
  );
}

export function EmptyState({ icon = 'inbox', title, sub, action }) {
  return (
    <div className="text-center py-14 px-6">
      <div className="w-20 h-20 mx-auto rounded-full bg-surface-container flex items-center justify-center mb-4 relative">
        <span className="absolute inset-0 rounded-full bg-circuit-amber/10 blur-md" />
        <Icon name={icon} className="text-wire-slate text-[34px]" />
      </div>
      <p className="font-display font-semibold text-ink-navy">{title}</p>
      {sub && <p className="text-sm text-wire-slate mt-1 max-w-sm mx-auto">{sub}</p>}
      {action}
    </div>
  );
}

/* ---------- Data viz ---------- */
const TINTS = {
  amber: { fg: 'text-circuit-amber', bg: 'bg-circuit-amber/10', glow: 'rgba(242,169,59,0.14)' },
  green: { fg: 'text-signal-green', bg: 'bg-signal-green/10', glow: 'rgba(46,158,107,0.14)' },
  red: { fg: 'text-fault-red', bg: 'bg-fault-red/10', glow: 'rgba(214,69,69,0.12)' },
  slate: { fg: 'text-wire-slate', bg: 'bg-surface-container-high', glow: 'rgba(90,107,140,0.12)' },
};

export function StatCard({ icon, tint = 'amber', label, value, sub, large = false, className = '' }) {
  const t = TINTS[tint] || TINTS.amber;
  return (
    <div className={`relative overflow-hidden bg-paper rounded-xl sm:rounded-2xl p-4 sm:p-5 shadow-card border border-haze/50 hover:shadow-raised hover:-translate-y-0.5 transition-all group ${large ? 'col-span-2 lg:col-span-1' : ''} ${className}`}>
      <div className="absolute -right-6 -top-6 w-20 h-20 sm:w-28 sm:h-28 rounded-full blur-2xl opacity-70 group-hover:opacity-100 transition-opacity pointer-events-none" style={{ background: t.glow }} />
      <div className="flex items-center justify-between mb-3 sm:mb-4 relative z-10">
        <div className={`w-8 h-8 sm:w-9 sm:h-9 rounded-lg sm:rounded-xl flex items-center justify-center ${t.bg} ${t.fg}`}>
          <Icon name={icon} className="text-base sm:text-lg" />
        </div>
        {tint === 'amber' && <span className="w-2 h-2 rounded-full bg-circuit-amber pulse-dot" />}
      </div>
      <div className="relative z-10">
        <p className={`font-display font-bold text-ink-navy leading-none tracking-tight tabular-nums ${large ? 'text-3xl xs:text-[36px] sm:text-[42px] md:text-5xl' : 'text-2xl xs:text-[28px] sm:text-[32px]'}`}>{value ?? '—'}</p>
        <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-wire-slate mt-2 sm:mt-2.5 leading-tight">{label}</p>
        {sub && <p className="text-[10px] sm:text-[11px] text-on-surface-variant/80 mt-0.5 leading-tight">{sub}</p>}
      </div>
    </div>
  );
}

export function MiniBars({ data, height = 'h-28' }) {
  const { t } = useLang();
  // data: [{ _id: 'YYYY-MM-DD', count }]
  const max = Math.max(1, ...(data || []).map((d) => d.count));
  const days = data?.length ? data : [];
  return (
    <div className={`${height} flex items-end gap-1.5`}>
      {days.length === 0 && <p className="text-xs text-wire-slate m-auto">{t('noActivityYet')}</p>}
      {days.map((d) => (
        <div key={d._id} className="flex-1 flex flex-col items-center gap-1 group/bar">
          <span className="text-[9px] font-mono text-wire-slate opacity-0 group-hover/bar:opacity-100 transition-opacity">{d.count}</span>
          <div className="w-full rounded-t-md bg-gradient-to-t from-circuit-amber/50 to-circuit-amber transition-all duration-500 hover:from-circuit-amber hover:to-spark-ember" style={{ height: `${Math.max(6, (d.count / max) * 100)}%` }} />
          <span className="text-[9px] font-mono text-wire-slate">{d._id.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- Nav shells - Bottom bar: INITIAL MOBILE LAYOUT — thumb bar, 52dp, max-w-md centered ---------- */
/* MOBILE ONLY: fixed thumb bar — prevents layout shift/shaking when KESCO dashboard polls */
export function BottomNav({ items }) {
  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 w-full max-w-full overflow-hidden box-border z-30 bg-paper border-t border-haze/70 shadow-[0_-4px_16px_rgba(10,27,51,0.06)] flex justify-around items-center px-1.5 xs:px-2 sm:px-4 pt-2 xs:pt-2.5 pb-2.5 xs:pb-3 gap-1 safe-bottom" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
      <div className="flex justify-around items-center w-full max-w-full min-w-0 mx-auto gap-0.5 xs:gap-1 overflow-hidden box-border">
      {items.map((it) => (
        <button
          key={it.label}
          onClick={() => { try { navigator.vibrate && navigator.vibrate(8); } catch (e) {} it.onClick && it.onClick(); }}
          className={`relative flex flex-col items-center justify-center min-w-0 flex-1 max-w-[96px] xs:max-w-[110px] sm:max-w-[120px] py-1.5 xs:py-2 px-1.5 xs:px-2 rounded-xl transition-all duration-200 select-none pressable box-border overflow-hidden ${
            it.active
              ? 'bg-ink-navy text-white shadow-card'
              : 'text-wire-slate active:scale-95 hover:text-ink-navy hover:bg-surface'
          }`}
          style={{ minHeight: '44px' }}
        >
          <Icon name={it.icon} fill={it.active} className={`text-[18px] xs:text-[20px] leading-none ${it.active ? 'text-circuit-amber' : ''} transition-colors shrink-0`} />
          <span className={`text-[10px] xs:text-[11px] mt-1 font-semibold leading-none truncate w-full max-w-full text-center block overflow-hidden ${it.active ? 'text-white font-bold' : 'text-wire-slate'}`}>{it.label}</span>
        </button>
      ))}
      </div>
    </nav>
  );
}

export function TopBar({ title, onBack, right }) {
  return (
    <header className="sticky top-0 z-40 w-full max-w-full overflow-hidden">
      {/* Desktop slim header — DO NOT TOUCH FOR MOBILE */}
      <div className="hidden lg:flex absolute top-4 right-6 z-50 flex items-center gap-2">{right}<LanguageToggle /></div>
      {/* Mobile — LARGE LOGO: 56-64px clearly visible, no notch overlap */}
      <div className="lg:hidden bg-paper border-b border-haze/60 shadow-sm header-safe w-full max-w-full overflow-hidden box-border">
        <div className="flex items-center gap-1.5 xs:gap-2 px-3 xs:px-4 sm:px-6 h-14 xs:h-16 sm:h-16 max-w-6xl mx-auto w-full max-w-full min-w-0 box-border overflow-hidden">
          {onBack ? (
            <button onClick={onBack} className="w-9 h-9 xs:w-10 xs:h-10 -ml-1 xs:-ml-2 rounded-full hover:bg-surface-container flex items-center justify-center text-ink-navy active:scale-95 shrink-0" aria-label="Back">
              <Icon name="arrow_back" className="text-lg xs:text-xl" />
            </button>
          ) : (
            <div className="shrink-0 flex items-center -ml-1 min-w-0 max-w-[200px] xs:max-w-[240px] sm:max-w-[260px]">
              <img src="/logo.png" alt="BijliSathi" className="h-16 xs:h-20 sm:h-20 w-auto max-w-[180px] xs:max-w-[220px] sm:max-w-[240px] object-contain shrink-0" style={{ imageRendering: '-webkit-optimize-contrast' }} />
            </div>
          )}
          <h1 className="font-display text-[13px] xs:text-[14px] sm:text-[15px] font-bold text-ink-navy truncate flex-1 min-w-0 text-center px-1.5 xs:px-2 leading-tight hidden sm:block">{title}</h1>
          <h1 className="font-display text-xs xs:text-[13px] font-bold text-ink-navy truncate flex-1 min-w-0 text-center px-1.5 xs:px-2 leading-tight sm:hidden">{title}</h1>
          <div className="shrink-0 flex items-center gap-1 scale-90 xs:scale-95 sm:scale-100 origin-right max-w-full">
            <LanguageToggle />
          </div>
        </div>
      </div>
    </header>
  );
}

export function BrandMark({ light = false, size }) {
  // VERY LARGE BRAND — optimum visible at every breakpoint — mobile/tablet/desktop
  const imgH = size === 'sm' ? 'h-14 xs:h-16 sm:h-16' : size === 'lg' ? 'h-20 xs:h-24 sm:h-24 md:h-28' : size === 'xl' ? 'h-28 xs:h-32 sm:h-36 md:h-40' : 'h-16 xs:h-20 sm:h-20 md:h-24';
  const maxW = size === 'sm' ? 'max-w-[260px] xs:max-w-[300px]' : size === 'lg' ? 'max-w-[380px] xs:max-w-[420px]' : size === 'xl' ? 'max-w-[380px] xs:max-w-[420px] sm:max-w-[460px]' : 'max-w-[320px] xs:max-w-[360px] sm:max-w-[400px]';
  return (
    <div className="flex items-center select-none shrink-0">
      <img
        src="/logo.png"
        alt="Bijli Sathi — Aapke har unit ka saathi | KESCO Kanpur"
        className={`${imgH} ${maxW} w-auto object-contain bg-transparent`}
        style={{ imageRendering: '-webkit-optimize-contrast' }}
        loading="eager"
        decoding="async"
        fetchPriority="high"
      />
    </div>
  );
}

/* Desktop sidebar — clean, no extra decorative wire */
export function SideNav({ brandLight = false, links, footerLink }) {
  const mainLinks = links.filter((l) => !l.footer);
  return (
    <aside className={`hidden lg:flex fixed left-0 top-0 h-screen w-64 xl:w-72 flex-col z-40 ${brandLight ? 'bg-ink-navy' : 'bg-paper border-r border-haze'}`}>
      <div className="px-4 xl:px-5 py-4 flex items-center justify-start"><BrandMark light={brandLight} /></div>
      <div className="mx-3 h-px bg-haze/40" />
      <nav className="flex-1 px-3 pt-3 space-y-1 overflow-y-auto hide-scrollbar">
        {mainLinks.map((l) => (
          <button
            key={l.label}
            onClick={l.onClick}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
              l.active
                ? brandLight ? 'bg-circuit-amber text-ink-navy shadow-card' : 'bg-ink-navy text-white shadow-card'
                : brandLight ? 'text-white/70 hover:bg-white/10 hover:text-white' : 'text-on-surface-variant hover:bg-surface-container hover:text-ink-navy'
            }`}
          >
            <Icon name={l.icon} fill={l.active} className="text-[20px]" /> {l.label}
          </button>
        ))}
      </nav>
      <div className="p-3 space-y-2 border-t border-haze/30">
        <LanguageToggle className="w-full justify-center" />
        {footerLink && (
          <button
            onClick={footerLink.onClick}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${brandLight ? 'bg-white/10 text-white hover:bg-white/15 border border-white/10' : 'bg-surface-container-high text-ink-navy hover:bg-surface-container border border-haze'}`}
          >
            <Icon name={footerLink.icon} className="text-[20px]" /> {footerLink.label}
          </button>
        )}
      </div>
    </aside>
  );
}

export function Shell({ navLinks, children, brandDark = false, wide = false }) {  const footerLink = navLinks.find((l) => l.footer);
  return (
    <div className={`min-h-screen w-full max-w-[100vw] overflow-x-hidden box-border ${brandDark ? 'bg-[#0d1526]' : 'bg-surface'} flex flex-col`}>
      {/* Desktop sidebar — mirrored on mobile via responsive header + bottom nav */}
      <SideNav brandLight={brandDark} links={navLinks} footerLink={footerLink} />
      {/* Mobile — Android 360 compact TopBar */}
      {navLinks.length > 0 && (
        <div className="lg:hidden sticky top-0 z-30 w-full max-w-full overflow-hidden box-border">
          <TopBar />
        </div>
      )}
      <main className={`flex-1 w-full max-w-full min-w-0 overflow-x-hidden box-border lg:pb-10 lg:pl-64 xl:pl-72`}>
        <div className={`mx-auto w-full max-w-full min-w-0 box-border overflow-hidden ${wide ? 'lg:max-w-7xl' : 'lg:max-w-5xl'} px-3 xs:px-4 sm:px-6 lg:px-8 pt-3 xs:pt-4 lg:pt-8 pb-28 sm:pb-6 lg:pb-8`}>{children}</div>
        {/* Mobile bottom bar — Android 44dp */}
        {navLinks.length > 0 && <BottomNav items={navLinks.filter(l => l.mobile !== false)} />}
      </main>
    </div>
  );
}

/* ---------- Call / WhatsApp choice sheet ---------- */
// Normalize to wa.me digits (India default). Returns null when unusable.
export function waNumber(phone) {
  if (!phone) return null;
  let d = String(phone).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return d;
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) return '91' + d;
  if (d.length >= 10 && d.length <= 15) return d;
  return null;
}

// Bottom sheet shown when any Call button is tapped: normal call + WhatsApp.
// Normal call → tel: opens the phone dial pad (mobile) / prompts dialer (desktop).
// WhatsApp → wa.me opens WhatsApp app / web with prefilled complaint text — tap call icon inside to voice/video call.
export function CallSheet({ phone, name, onClose, waText }) {
  const wa = waNumber(phone);
  const tel = phone ? String(phone).replace(/[^+0-9]/g, '') : '';
  const defaultWaText = waText || `Namaste${name ? ` ${name}` : ''}, regarding BijliSathi complaint — `;
  const waLink = wa ? `https://wa.me/${wa}?text=${encodeURIComponent(defaultWaText)}` : '';
  const dialNow = () => {
    // Open native dial pad with number prefilled
    try {
      window.location.href = `tel:${tel}`;
    } catch (e) {
      try {
        const a = document.createElement('a');
        a.href = `tel:${tel}`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { a.remove(); } catch (e2) {} }, 800);
      } catch (e2) {}
    }
    try { if (navigator.clipboard && tel) navigator.clipboard.writeText(tel); } catch (e) {}
    onClose && onClose();
  };
  const openWa = () => {
    // Open WhatsApp app (mobile) / WhatsApp Web (desktop) for call or chat
    try { window.open(waLink, '_blank', 'noopener'); } catch (e) {}
    onClose && onClose();
  };
  return (
    <div className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-ink-navy/60 backdrop-blur-sm p-0 sm:p-6" onClick={onClose}>
      <div className="bg-paper w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl shadow-raised overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-4 pb-2 text-center">
          <div className="w-10 h-1 rounded-full bg-haze mx-auto mb-3" />
          <p className="font-display font-bold text-ink-navy">{name || 'Contact'}</p>
          <p className="text-xs font-mono text-wire-slate mt-0.5">{tel || ''}</p>
        </div>
        <div className="p-4 space-y-2.5">
          <button onClick={dialNow} className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-signal-green text-white font-bold text-sm active:scale-[0.98] transition-all">
            <span className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0"><Icon name="call" fill /></span>
            <span className="text-left">Normal call<span className="block text-[11px] font-medium text-white/80">Open dial pad with number</span></span>
          </button>
          {waLink ? (
            <button onClick={openWa} className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-[#25D366] text-white font-bold text-sm active:scale-[0.98] transition-all">
              <span className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0"><Icon name="chat" fill /></span>
              <span className="text-left">WhatsApp call<span className="block text-[11px] font-medium text-white/80">Open WhatsApp app to call or chat</span></span>
            </button>
          ) : null}
          <button onClick={onClose} className="w-full py-3 rounded-2xl border border-haze text-wire-slate text-sm font-bold active:scale-[0.98] transition-all">Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Email choice sheet ---------- */
// Bottom sheet shown when any Message button is tapped: device email app +
// Gmail web (mailto: does nothing on desktops without a mail client set up).
export function MailSheet({ to, subject, body, onClose }) {
  const mailto = `mailto:${to || ''}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to || '')}&su=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body || '')}`;
  const openApp = () => {
    try {
      const a = document.createElement('a');
      a.href = mailto;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); } catch (e) {} }, 800);
    } catch (e) {}
    onClose && onClose();
  };
  const openGmail = () => {
    try {
      const w = window.open(gmail, '_blank', 'noopener');
      if (!w) window.location.href = gmail; // popup blocked → open in same tab
    } catch (e) {
      try { window.location.href = gmail; } catch (e2) {}
    }
    onClose && onClose();
  };
  return (
    <div className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-ink-navy/60 backdrop-blur-sm p-0 sm:p-6" onClick={onClose}>
      <div className="bg-paper w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl shadow-raised overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-4 pb-2 text-center">
          <div className="w-10 h-1 rounded-full bg-haze mx-auto mb-3" />
          <p className="font-display font-bold text-ink-navy">Message</p>
          <p className="text-xs font-mono text-wire-slate mt-0.5 break-all">{to || ''}</p>
        </div>
        <div className="p-4 space-y-2.5">
          <button onClick={openApp} className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-ink-navy text-white font-bold text-sm active:scale-[0.98] transition-all">
            <span className="w-10 h-10 rounded-full bg-white/15 flex items-center justify-center shrink-0"><Icon name="mail" fill /></span>
            <span className="text-left">Email app<span className="block text-[11px] font-medium text-white/70">Open in phone / computer mail app</span></span>
          </button>
          <button onClick={openGmail} className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-[#EA4335] text-white font-bold text-sm active:scale-[0.98] transition-all">
            <span className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0 font-display font-black text-lg">G</span>
            <span className="text-left">Gmail web<span className="block text-[11px] font-medium text-white/80">Full compose in browser</span></span>
          </button>
          <button onClick={onClose} className="w-full py-3 rounded-2xl border border-haze text-wire-slate text-sm font-bold active:scale-[0.98] transition-all">Cancel</button>
        </div>
      </div>
    </div>
  );
}
