import React, { useState, lazy, Suspense } from 'react';
import { Icon } from '../components/ui';
// Heavy Leaflet deps lazy-loaded - prevents 150KB maps chunk from blocking first paint on 50KB/s (screenshot)
// PinIcon is now created inside MapView via iconConfig, so Landing never imports leaflet directly
const MapView = lazy(() => import('../components/Map'));
const LeafletGlobe = lazy(() => import('../components/LeafletGlobe'));

function MapSkeleton({ height = 'h-[240px] xs:h-[260px] sm:h-[300px] lg:h-[340px]' }) {
  return <div className={`rounded-xl xs:rounded-2xl lg:rounded-3xl bg-haze/20 animate-pulse border border-haze flex items-center justify-center ${height}`}><span className="text-xs font-bold text-wire-slate">Loading map…</span></div>;
}
function GlobeSkeleton() {
  return <div className="h-[168px] w-[168px] rounded-full bg-ink-navy/10 animate-pulse border border-white/10 shrink-0" />;
}

const FEATURES = [
  { icon: 'my_location', title: 'One-tap fault reporting', sub: 'GPS pin + photo + problem type. Under 30 seconds.' },
  { icon: 'hub', title: 'AI Triage Engine', sub: 'Clusters duplicate reports within 300m, filters spam, scores urgency 0–10.' },
  { icon: 'radar', title: 'Live tracking', sub: 'Watch your technician move on a live map the moment they accept.' },
  { icon: 'monitoring', title: 'KESCO control room', sub: 'City-wide dashboard: SLAs, clusters, technician GPS, area heat data.' },
];

function useIsMobileDevice() {
  const [isMobile, setIsMobile] = useState(() => {
    try {
      if (typeof window !== 'undefined' && window.innerWidth < 1024) return true;
      if (typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad|iPod/.test(navigator.userAgent)) return true;
    } catch (e) {}
    return false;
  });
  React.useEffect(() => {
    const check = () => {
      try {
        const ua = navigator.userAgent || '';
        const mobileUA = /Mobi|Android|iPhone|iPad|iPod/.test(ua);
        const narrow = window.innerWidth < 1024;
        // Match oxbl desktop hero exactly: desktop = Map, mobile = Globe
        // Use UA + width: if mobile UA or narrow -> mobile, else desktop
        setIsMobile(mobileUA || narrow);
      } catch (e) {}
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return isMobile;
}

export default function Landing({ go }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isMobileDevice = useIsMobileDevice();
  const [heroTilted, setHeroTilted] = useState(true);
  return (
    <div className="min-h-screen bg-surface overflow-x-clip">
      {/* NAV — left aligned big brand logo */}
      <header className="sticky top-0 z-50 bg-paper border-b border-haze/60 shadow-sm header-safe">
          <div className="max-w-[340px] lg:max-w-5xl mx-auto px-2 xs:px-3 lg:px-4 py-1.5 xs:py-2 lg:py-3 flex items-center justify-between gap-1.5 xs:gap-2 lg:gap-4">
          <div className="shrink-0 flex items-center justify-start -ml-1 lg:ml-0"><img src="/logo.png" alt="BijliSathi" className="h-16 xs:h-20 sm:h-20 lg:h-28 xl:h-32 w-auto max-w-[200px] xs:max-w-[240px] sm:max-w-[280px] lg:max-w-[380px] xl:max-w-[420px] object-contain object-left" style={{ imageRendering: '-webkit-optimize-contrast' }} /></div>
          {/* Desktop nav links — medium */}
          <div className="hidden lg:flex items-center gap-1.5 shrink-0">
            <button onClick={() => go('#/login/citizen')} className="text-[13px] font-semibold text-ink-navy hover:text-circuit-amber px-3 py-1.5 transition-colors">Citizen</button>
            <button onClick={() => go('#/login/technician')} className="text-[13px] font-semibold text-ink-navy hover:text-circuit-amber px-3 py-1.5 transition-colors">Technician</button>
            <button onClick={() => { try{navigator.vibrate&&navigator.vibrate(8)}catch{} go('#/login/citizen'); }} className="bg-ink-navy text-white text-[13px] font-bold px-4 py-2 rounded-xl hover:bg-grid-navy active:scale-95 transition-all shadow-card flex items-center gap-1.5 whitespace-nowrap min-h-[36px]">
              Get Started <Icon name="arrow_forward" className="text-[16px]" />
            </button>
          </div>
          {/* Mobile: medium compact */}
          <div className="flex lg:hidden items-center gap-1.5 shrink-0">
            <button
              onClick={() => { try{navigator.vibrate&&navigator.vibrate(6)}catch{}; setMenuOpen(v=>!v); }}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              className="w-8 h-8 rounded-lg bg-surface border border-haze flex items-center justify-center text-ink-navy active:scale-95 transition-transform shrink-0"
            >
              <Icon name={menuOpen ? 'close' : 'menu'} className="text-[18px]" />
            </button>
            <button onClick={() => { try{navigator.vibrate&&navigator.vibrate(8)}catch{} go('#/login/citizen'); }} className="bg-ink-navy text-white text-xs font-bold px-3 py-1.5 rounded-lg hover:bg-grid-navy active:scale-95 transition-all shadow-card flex items-center gap-1 whitespace-nowrap min-h-[32px]">
              Get Started <Icon name="arrow_forward" className="text-[14px]" />
            </button>
          </div>
        </div>
        {/* Mobile dropdown — Android compact */}
        {menuOpen && (
          <div className="lg:hidden border-t border-haze/60 bg-paper shadow-raised animate-slide-up">
            <div className="max-w-5xl mx-auto px-3 xs:px-4 sm:px-6 py-3 flex flex-col gap-2">
              <button onClick={() => { setMenuOpen(false); go('#/login/citizen'); }} className="w-full text-left flex items-center justify-between px-3 xs:px-4 py-2.5 xs:py-3 rounded-xl bg-surface border border-haze/60 hover:border-circuit-amber active:scale-[0.98] transition-all">
                <span className="flex items-center gap-2.5 xs:gap-3 text-xs xs:text-sm font-bold text-ink-navy"><span className="w-8 h-8 xs:w-9 xs:h-9 rounded-lg bg-ink-navy flex items-center justify-center text-circuit-amber shrink-0"><Icon name="person" className="text-base xs:text-lg" /></span> Citizen</span>
                <Icon name="chevron_right" className="text-wire-slate text-base xs:text-lg" />
              </button>
              <button onClick={() => { setMenuOpen(false); go('#/login/technician'); }} className="w-full text-left flex items-center justify-between px-3 xs:px-4 py-2.5 xs:py-3 rounded-xl bg-surface border border-haze/60 hover:border-circuit-amber active:scale-[0.98] transition-all">
                <span className="flex items-center gap-2.5 xs:gap-3 text-xs xs:text-sm font-bold text-ink-navy"><span className="w-8 h-8 xs:w-9 xs:h-9 rounded-lg bg-ink-navy flex items-center justify-center text-circuit-amber shrink-0"><Icon name="engineering" className="text-base xs:text-lg" /></span> Technician</span>
                <Icon name="chevron_right" className="text-wire-slate text-base xs:text-lg" />
              </button>
              <button onClick={() => { setMenuOpen(false); go('#/login/kesco'); }} className="w-full text-left flex items-center justify-between px-3 xs:px-4 py-2.5 xs:py-3 rounded-xl bg-surface border border-haze/60 hover:border-circuit-amber active:scale-[0.98] transition-all">
                <span className="flex items-center gap-2.5 xs:gap-3 text-xs xs:text-sm font-bold text-ink-navy"><span className="w-8 h-8 xs:w-9 xs:h-9 rounded-lg bg-ink-navy flex items-center justify-center text-circuit-amber shrink-0"><Icon name="monitoring" className="text-base xs:text-lg" /></span> KESCO Control</span>
                <Icon name="chevron_right" className="text-wire-slate text-base xs:text-lg" />
              </button>
            </div>
          </div>
        )}
      </header>

      {/* HERO — CLEAN MOBILE REDESIGN | desktop preserved */}
      <section className="relative bg-ink-navy text-white overflow-hidden">
        {/* Background — subtle, not noisy */}
        <div className="absolute inset-0 bg-ink-navy" />
        <div className="absolute inset-0 bg-gradient-to-b from-ink-navy via-ink-navy to-grid-navy" />
        <div className="absolute inset-0 grid-lines opacity-[0.03] lg:opacity-[0.07]" />
        <div className="absolute -top-32 -right-24 w-80 h-80 bg-circuit-amber/[0.06] rounded-full blur-3xl pointer-events-none" />
        <div className="absolute top-[42%] -left-24 w-72 h-72 bg-white/[0.03] rounded-full blur-3xl hidden lg:block pointer-events-none" />

        {/* ========== MOBILE HERO — MINIMAL, NEAT, REPRESENTATIVE ========== */}
        <div className="lg:hidden relative px-4 xs:px-5 pt-6 pb-7">
          {/* Headline — centered, minimal */}
          <div className="text-center mt-2 rise rise-d1">
            <h1 className="font-display font-extrabold tracking-tight leading-[1.0] text-[30px] xs:text-[32px]">
              Power cuts fixed,<br />
              <span className="text-circuit-amber">not just reported.</span>
            </h1>
            <p className="text-[13px] leading-[1.6] text-white/60 font-medium max-w-[300px] mx-auto mt-3">
              Report a fault in 30 sec, track the lineman live — one app for citizens &amp; KESCO.
            </p>
          </div>

          {/* CTA — single primary, representative action */}
          <div className="mt-5 max-w-[340px] mx-auto rise rise-d2">
            <button onClick={() => { try{navigator.vibrate&&navigator.vibrate(12)}catch{} go('#/login/citizen'); }} className="w-full bg-circuit-amber text-ink-navy font-display font-extrabold text-[15px] py-[14px] rounded-2xl shadow-glow-amber hover:bg-[#f5b654] active:scale-[0.98] transition-all flex items-center justify-center gap-2 min-h-[50px]">
              Report an Issue <Icon name="bolt" fill className="text-[20px]" />
            </button>
            <button onClick={() => go('#/login/technician')} className="mt-2.5 w-full text-white/60 text-xs font-semibold flex items-center justify-center gap-1 hover:text-white transition-colors">
              Are you a lineman? <span className="text-circuit-amber font-bold">Go on duty →</span>
            </button>
          </div>

          {/* Visual — BLACK GLOBE ONLY, big for mobile — mockups removed per Image 1 (mobile only) — Leaflet + Google Maps connected */}
          <div className="mt-6 max-w-[360px] mx-auto rise rise-d2">
            <div className="relative flex flex-col items-center">
              <div className="relative w-[280px] h-[280px] xs:w-[300px] xs:h-[300px] sm:w-[320px] sm:h-[320px]">
                <div className="absolute inset-0 rounded-full bg-white/20 blur-[32px] opacity-90 pointer-events-none" />
                <div className="absolute -inset-1 rounded-full bg-circuit-amber/10 blur-[20px] opacity-60 pointer-events-none" />
                <Suspense fallback={<div className="h-full w-full rounded-full bg-white/5 animate-pulse border border-white/20 shrink-0" />}>
                  <LeafletGlobe height="h-full" className="h-full w-full rounded-full overflow-hidden" />
                </Suspense>
              </div>
              <a href="https://www.google.com/maps/search/?api=1&query=26.4499,80.3319" target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-semibold text-white/80 hover:text-white bg-white/10 backdrop-blur border border-white/10 px-4 py-2 rounded-full transition-colors">
                <Icon name="map" className="text-sm text-circuit-amber" /> Open in Google Maps <Icon name="open_in_new" className="text-xs" />
              </a>
            </div>
          </div>
        </div>

        {/* ========== DESKTOP HERO — IMAGE 2 STYLE (desktop only) ========== */}
        <div className="hidden lg:grid relative max-w-6xl mx-auto px-6 xl:px-8 pt-16 pb-16 grid-cols-[1.05fr_0.95fr] gap-10 items-center">
          <div className="rise">
            <span className="inline-flex items-center gap-2 bg-white rounded-full pl-1.5 pr-3 py-1 shadow-card border border-haze/20 mb-4">
              <span className="inline-flex items-center gap-1.5 bg-signal-green text-white text-[11px] font-extrabold tracking-wide px-2 py-1 rounded-full"><span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> LIVE</span>
              <span className="text-[12px] font-bold text-ink-navy">Kanpur Power Grid • Real-time</span>
            </span>
            <h1 className="font-display font-extrabold text-white tracking-tight leading-[0.95] text-[48px] xl:text-[54px] mb-4">
              Power cuts fixed,<br />
              <span className="text-circuit-amber font-extrabold">not just reported.</span>
            </h1>
            <p className="text-[15px] xl:text-[16px] text-white font-semibold leading-relaxed max-w-[520px] mb-7">
              One system connecting citizens, KESCO linemen and<br /> the control room — report a fault in seconds, watch<br /> the repair happen live.
            </p>
            <div className="flex items-center gap-3">
              <button onClick={() => { try{navigator.vibrate&&navigator.vibrate(12)}catch{} go('#/login/citizen'); }} className="bg-circuit-amber text-ink-navy font-display font-extrabold px-6 py-3.5 rounded-2xl shadow-glow-amber hover:bg-[#f5b654] active:scale-[0.97] transition-all flex items-center justify-center gap-2 text-[15px] min-h-[48px] pressable">
                Report an Issue <Icon name="bolt" fill className="text-xl" />
              </button>
              <button onClick={() => go('#/login/technician')} className="bg-white text-ink-navy font-bold px-5 py-3.5 rounded-2xl border border-white shadow-card hover:bg-surface active:scale-[0.97] transition-all flex items-center justify-center gap-2 text-[14px] min-h-[48px] pressable">
                <Icon name="engineering" className="text-[18px]" /> Technician Portal
              </button>
            </div>
          </div>
          <div className="rise rise-d2 flex justify-end">
            <div
              onMouseEnter={() => setHeroTilted(false)}
              onMouseLeave={() => setHeroTilted(true)}
              onClick={() => setHeroTilted(v => !v)}
              onTouchStart={() => setHeroTilted(false)}
              className={`bg-white rounded-[28px] p-3 shadow-[0_20px_50px_rgba(0,0,0,0.35)] border border-white w-[380px] xl:w-[400px] cursor-pointer select-none transition-transform duration-500 ease-out will-change-transform ${heroTilted ? 'rotate-[1.2deg]' : 'rotate-0'}`}>
              <div className="flex items-center justify-between px-2 pt-1 mb-3">
                <p className="font-mono text-[12px] font-bold text-ink-navy tracking-wide">#A7F3K2</p>
                <span className="px-3 py-1 rounded-full text-xs font-extrabold bg-circuit-amber text-ink-navy flex items-center gap-1.5">
                  Working
                </span>
              </div>
              {/* status timeline */}
              <div className="px-2 mb-3">
                <div className="relative h-1 bg-haze/30 rounded-full">
                  <div className="absolute inset-y-0 left-0 w-[52%] bg-circuit-amber rounded-full" />
                  <div className="absolute top-1/2 -translate-y-1/2 left-0 w-5 h-5 rounded-full bg-circuit-amber border-[3px] border-white shadow-card flex items-center justify-center"><Icon name="check" className="text-white text-[12px] font-bold" /></div>
                  <div className="absolute top-1/2 -translate-y-1/2 left-[52%] -translate-x-1/2 w-5 h-5 rounded-full bg-white border-[3px] border-circuit-amber shadow-card" />
                  <div className="absolute top-1/2 -translate-y-1/2 right-0 w-5 h-5 rounded-full bg-white border-[3px] border-haze shadow-card" />
                  {/* dashed remainder */}
                  <div className="absolute top-1/2 -translate-y-1/2 left-[58%] right-[8%] h-0 border-t-2 border-dashed border-haze/60" />
                </div>
                <div className="flex justify-between mt-2 text-[11px] font-bold">
                  <span className="text-ink-navy flex items-center gap-1">Registered <span className="text-signal-green">✓</span></span>
                  <span className="text-circuit-amber">Working</span>
                  <span className="text-wire-slate">Resolved</span>
                </div>
              </div>
              {/* light map */}
              <div className="rounded-[16px] overflow-hidden h-[168px] relative border border-haze/15 bg-[#eef2f6] mx-1">
                <div className="absolute inset-0" style={{
                  backgroundImage: `radial-gradient(circle, #c9d3e0 1.2px, transparent 1.2px)`,
                  backgroundSize: '14px 14px',
                  opacity: 0.45
                }} />
                <div className="absolute inset-0 grid grid-cols-3 grid-rows-2 gap-[1px] bg-haze/20 p-[1px]">
                  {Array.from({length:6}).map((_,i)=> <div key={i} className="bg-[#f1f5f9] relative"><span className={i===0 ? 'absolute top-2 left-2 w-2.5 h-2.5 rounded-full bg-spark-ember border-2 border-white shadow' : i===5 ? 'absolute bottom-2 right-2 w-2.5 h-2.5 rounded-full bg-signal-green border-2 border-white shadow' : 'hidden'} /></div>)}
                </div>
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center">
                  <span className="relative flex w-12 h-12">
                    <span className="absolute inset-0 rounded-full bg-circuit-amber/20 animate-ping" />
                    <span className="absolute inset-1 rounded-full bg-circuit-amber/15 animate-ping" style={{animationDelay:'0.3s'}} />
                    <span className="relative w-12 h-12 rounded-full bg-white border-2 border-circuit-amber shadow-card flex items-center justify-center"><Icon name="two_wheeler" className="text-ink-navy text-[20px]" /></span>
                  </span>
                </div>
                <div className="absolute bottom-2 left-2 bg-ink-navy text-white text-[11px] font-bold px-2.5 py-1 rounded-full shadow flex items-center gap-1.5">
                  Ramesh K. <span className="w-1 h-1 rounded-full bg-white/60" /> 1.2 km away
                </div>
              </div>
              <button onClick={() => go('#/login/citizen')} className="mt-3 w-full bg-ink-navy text-white font-bold py-3 rounded-xl hover:bg-grid-navy active:scale-[0.98] transition-all flex items-center justify-center gap-2 text-[13px] shadow-card">
                <Icon name="location_on" fill className="text-circuit-amber text-[18px]" /> Track live on map
              </button>
            </div>
          </div>
        </div>

        {/* bottom wire */}
        <svg className="block w-full lg:hidden" height="20" preserveAspectRatio="none" viewBox="0 0 1200 28">
          <path d="M0 14 Q 300 26 600 14 T 1200 14" fill="none" stroke="#F2A93B" strokeWidth="1.4" className="draw-wire" opacity="0.9" />
        </svg>
        <svg className="hidden lg:block w-full" height="24" preserveAspectRatio="none" viewBox="0 0 1200 28">
          <path d="M0 14 Q 300 28 600 14 T 1200 14" fill="none" stroke="#F2A93B" strokeWidth="1.5" className="draw-wire" />
        </svg>
      </section>

      {/* Features — Android 2-col compact: 8dp gap, 12px text */}
      <section className="max-w-5xl mx-auto px-3 xs:px-4 sm:px-6 lg:px-5 py-6 xs:py-8 sm:py-12 lg:py-24">
        <p className="text-[10px] xs:text-[11px] lg:text-xs font-bold uppercase tracking-[0.2em] lg:tracking-[0.25em] text-wire-slate lg:text-on-secondary-container mb-1.5 xs:mb-2 text-center">Why BijliSathi</p>
        <h2 className="font-display font-extrabold lg:font-bold text-ink-navy text-center leading-tight text-[18px] xs:text-[20px] sm:text-[22px] lg:text-4xl mb-1.5 xs:mb-2 lg:mb-3">From complaint to cure,<br className="hidden sm:block" /> without the chaos.</h2>
        <p className="text-center text-xs xs:text-[13px] lg:text-base text-wire-slate lg:text-on-surface-variant max-w-sm sm:max-w-xl mx-auto mb-5 xs:mb-6 lg:mb-16 leading-relaxed px-2 xs:px-0">The old way was phone calls and hope. BijliSathi is one connected circuit — every report verified, ranked, tracked and closed.</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 xs:gap-3 sm:gap-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-paper rounded-xl xs:rounded-2xl p-3 xs:p-4 sm:p-6 shadow-card border border-haze/50 lg:border-haze/40 hover:border-circuit-amber/40 lg:hover:border-circuit-amber hover:shadow-glow-amber active:scale-[0.98] transition-all group flex flex-col">
              <div className="w-8 h-8 xs:w-9 xs:h-9 lg:w-12 lg:h-12 rounded-lg xs:rounded-xl bg-ink-navy flex items-center justify-center mb-2 xs:mb-3 shadow-card shrink-0 group-hover:bg-circuit-amber transition-colors">
                <Icon name={f.icon} fill className="text-circuit-amber group-hover:text-ink-navy text-base xs:text-[18px] lg:text-2xl transition-colors" />
              </div>
              <h3 className="font-display font-bold text-ink-navy leading-tight text-xs xs:text-[13px] sm:text-[13px] lg:text-base mb-0.5 xs:mb-1">{f.title}</h3>
              <p className="text-[10px] xs:text-[11px] sm:text-xs lg:text-sm text-wire-slate leading-relaxed">{f.sub}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Map preview — Android h 240→300 */}
      <section className="max-w-5xl mx-auto px-3 xs:px-4 sm:px-6 lg:px-5 pb-6 xs:pb-8 sm:pb-12 lg:pb-20">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 xs:gap-6 lg:gap-8 items-center">
          <div>
            <p className="text-[10px] xs:text-[11px] lg:text-xs font-bold uppercase tracking-[0.2em] text-wire-slate lg:text-on-secondary-container mb-1.5 xs:mb-2">Live Grid Map</p>
            <h2 className="font-display font-extrabold lg:font-bold text-ink-navy leading-tight text-[18px] xs:text-[20px] sm:text-[22px] lg:text-4xl mb-2 xs:mb-3 lg:mb-4">See every outage,<br />street by street.</h2>
            <p className="text-xs xs:text-[13px] lg:text-base text-wire-slate lg:text-on-surface-variant leading-relaxed max-w-md">Active fault clusters, technician positions and resolved zones — plotted on a live OpenStreetMap view of Kanpur. Full access inside your portal.</p>
            <button onClick={() => go('#/login/citizen')} className="mt-3 xs:mt-4 bg-ink-navy text-white font-bold px-4 xs:px-5 py-2.5 xs:py-3 lg:py-3.5 rounded-full hover:bg-grid-navy active:scale-[0.97] transition-all inline-flex items-center justify-center gap-1.5 xs:gap-2 shadow-card text-xs xs:text-[13px] lg:text-sm min-h-[40px] xs:min-h-[44px] lg:min-h-[48px] pressable">
              <Icon name="map" fill className="text-circuit-amber text-sm xs:text-base lg:text-lg" /> View Outage Map
            </button>
          </div>
          <div className="rounded-xl xs:rounded-2xl lg:rounded-3xl overflow-hidden shadow-raised border border-haze relative z-0">
            <Suspense fallback={<MapSkeleton />}>
              <MapView
                center={[26.4499, 80.3319]} zoom={12} height="h-[240px] xs:h-[260px] sm:h-[300px] lg:h-[340px]"
                markers={[
                  { lat: 26.4499, lng: 80.3319, iconConfig: { color: '#FF6B35', glyph: 'bolt', ping: true }, label: 'Active cluster — Sector 5' },
                  { lat: 26.4740, lng: 80.3520, iconConfig: { color: '#F2A93B', glyph: 'engineering', ping: true }, label: 'Technician en route' },
                  { lat: 26.4300, lng: 80.3100, iconConfig: { color: '#2E9E6B', glyph: 'check' }, label: 'Resolved — Shastri Nagar' },
                ]}
              />
            </Suspense>
            <div className="absolute top-1.5 xs:top-2 left-1.5 xs:left-2 z-[500] bg-paper/95 backdrop-blur rounded-lg shadow-card px-2 xs:px-2.5 py-1 xs:py-1.5 flex items-center gap-1 xs:gap-2 text-[9px] xs:text-[10px] font-bold flex-wrap">
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 xs:w-2 xs:h-2 rounded-full bg-spark-ember" />Fault</span>
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 xs:w-2 xs:h-2 rounded-full bg-circuit-amber" />Technician</span>
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 xs:w-2 xs:h-2 rounded-full bg-signal-green" />Resolved</span>
            </div>
          </div>
        </div>
      </section>

      {/* Portals — Android 1-col stacked, 44dp card */}
      <section className="max-w-5xl mx-auto px-3 xs:px-4 sm:px-6 lg:px-5 pb-6 xs:pb-8 sm:pb-12 lg:pb-20">
        <div className="bg-ink-navy rounded-2xl xs:rounded-[24px] lg:rounded-3xl p-4 xs:p-5 sm:p-8 lg:p-12 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-grid-navy via-ink-navy to-[#061023]" />
          <div className="absolute inset-0 grid-lines opacity-[0.06]" />
          <div className="relative z-10">
            <h2 className="font-display font-extrabold text-white text-center tracking-tight text-[18px] xs:text-[20px] sm:text-2xl lg:text-3xl mb-1">Choose your portal</h2>
            <p className="text-center text-white/60 lg:text-haze font-medium text-xs xs:text-[13px] lg:text-sm mb-4 xs:mb-5 lg:mb-8 px-2 xs:px-0">Three doors, one mission — reliable power for Kanpur.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 xs:gap-3 lg:gap-5">
              {[
                { icon: 'person', t: 'Citizens', s: 'Report issues, upload photos & watch repairs live.', to: '#/login/citizen', cta: 'Enter Portal' },
                { icon: 'engineering', t: 'Technicians', s: 'AI-ranked tasks, navigate & share live GPS.', to: '#/login/technician', cta: 'Go On Duty' },
                { icon: 'monitoring', t: 'KESCO Control', s: 'City SLAs, clusters, false flags & GPS.', to: '#/login/kesco', cta: 'Open Dashboard' },
              ].map((p) => (
                <button key={p.t} onClick={() => { try{navigator.vibrate&&navigator.vibrate(8)}catch{} go(p.to); }} className="text-left bg-white rounded-xl xs:rounded-2xl p-4 xs:p-5 lg:p-6 border border-white shadow-raised hover:shadow-glow-amber active:scale-[0.98] transition-all group flex flex-col min-h-[120px] xs:min-h-[140px] lg:min-h-[160px] pressable">
                  <div className="w-9 h-9 xs:w-10 xs:h-10 lg:w-12 lg:h-12 rounded-full bg-circuit-amber flex items-center justify-center shadow-glow-amber group-active:scale-90 transition-transform mb-2.5 xs:mb-3 lg:mb-4">
                    <Icon name={p.icon} fill className="text-ink-navy text-lg xs:text-xl lg:text-2xl" />
                  </div>
                  <h3 className="font-display text-[14px] xs:text-[16px] lg:text-lg font-extrabold text-ink-navy leading-tight">{p.t}</h3>
                  <p className="text-xs xs:text-[13px] lg:text-sm text-wire-slate font-medium leading-relaxed mt-1 mb-2 xs:mb-3 lg:mb-4">{p.s}</p>
                  <span className="flex text-ink-navy text-xs xs:text-[13px] lg:text-sm font-extrabold items-center gap-1 xs:gap-1.5 mt-auto group-hover:gap-2.5 transition-all"> <span className="text-circuit-amber">{p.cta}</span> <Icon name="arrow_forward" className="text-sm xs:text-base text-circuit-amber" /></span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Footer — Clean: Brand logo + Corporate Office + Important Links | Quick Links removed | Official KESCO https://kesco.org.in/ */}
      <footer className="bg-[#0B1E33] text-white relative overflow-x-hidden">
        <div className="absolute inset-0 grid-lines opacity-[0.05]" />
        <div className="relative max-w-6xl mx-auto px-4 xs:px-5 sm:px-6 lg:px-8 py-8 xs:py-10 lg:py-10">
          {/* Clean official style — single column on mobile, 3-col on desktop | no 2-col on mobile */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-6 lg:gap-10">
            {/* Brand — BijliSathi logo — left-aligned clean on both mobile & desktop — no white background — optimum visible */}
            <div className="flex flex-col items-start text-left">
              <img src="/logo.png" alt="BijliSathi" className="h-16 xs:h-20 sm:h-20 lg:h-24 xl:h-28 w-auto max-w-[260px] xs:max-w-[300px] sm:max-w-[320px] lg:max-w-[360px] object-contain mb-4" style={{ imageRendering: '-webkit-optimize-contrast' }} />
              <p className="text-[12px] xs:text-[13px] lg:text-[13.5px] text-[#B0BEC5] leading-relaxed max-w-[320px]">BijliSathi — KESCO’s official partner for Kanpur. Report, track, resolve.</p>
              <a href="https://kesco.org.in/" target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1.5 bg-[#FFC107] text-[#0B1E33] text-[12px] xs:text-[13px] font-extrabold px-4 py-2 rounded-full hover:bg-[#FFD54F] active:scale-95 transition-all shadow-card">
                Official KESCO Website <span className="text-[13px]">↗</span>
              </a>
              <a href="https://kesco.org.in/" target="_blank" rel="noreferrer" className="mt-2 text-[11px] xs:text-xs text-[#CFD8DC] hover:text-white underline break-all">https://kesco.org.in/</a>
            </div>
            {/* Corporate Office — exact details from Image 1 */}
            <div className="text-left">
              <h4 className="font-bold text-[#FFC107] text-[13px] xs:text-sm lg:text-[15px] mb-3 xs:mb-4 tracking-normal">Corporate Office</h4>
              <div className="space-y-1.5 text-[12px] xs:text-[13px] lg:text-[13.5px] leading-relaxed text-[#B0BEC5]">
                <p>Kesa House, 14/71 Civil Lines, Permat,<br />Kanpur, Uttar Pradesh 208001</p>
                <p>Helpline: <a href="tel:1912" className="text-[#CFD8DC] hover:text-white hover:underline">1912</a></p>
                <p>Toll Free: <a href="tel:18004101912" className="text-[#CFD8DC] hover:text-white hover:underline">18004101912</a></p>
                <p><a href="tel:+918287835233" className="text-[#CFD8DC] hover:text-white hover:underline">+91-8287835233</a></p>
                <p><a href="mailto:kescohelpline@kesco.org.in" className="text-[#CFD8DC] hover:text-white hover:underline break-all">kescohelpline@kesco.org.in</a></p>
              </div>
            </div>
            {/* Important Links — clean single column on both mobile & desktop */}
            <div className="text-left">
              <h4 className="font-bold text-[#FFC107] text-[13px] xs:text-sm lg:text-[15px] mb-3 xs:mb-4">Important Links</h4>
              <ul className="space-y-2 text-[12px] xs:text-[13px] lg:text-[13.5px]">
                <li><a href="#" className="text-[#B0BEC5] hover:text-white transition-colors">FAQs</a></li>
                <li><a href="#" className="text-[#B0BEC5] hover:text-white transition-colors">Terms &amp; Conditions</a></li>
                <li><a href="#" className="text-[#B0BEC5] hover:text-white transition-colors">Privacy Policy</a></li>
                <li><a href="#" className="text-[#B0BEC5] hover:text-white transition-colors">Disclaimer</a></li>
                <li><a href="#" className="text-[#B0BEC5] hover:text-white transition-colors">Help</a></li>
                <li><a href="#" className="text-[#B0BEC5] hover:text-white transition-colors">Sitemap</a></li>
                <li><a href="#" className="text-[#B0BEC5] hover:text-white transition-colors">Contact Us</a></li>
              </ul>
            </div>
          </div>
          <div className="mt-8 pt-4 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-2 text-center">
            <p className="text-[11px] font-mono text-white/50">© {new Date().getFullYear()} BijliSathi • KESCO Kanpur • V1</p>
            <p className="text-[11px] text-white/50">Grievance: kescohelpline@kesco.org.in • <a href="https://kesco.org.in/" target="_blank" rel="noreferrer" className="hover:text-white underline">kesco.org.in</a></p>
          </div>
        </div>
      </footer>
    </div>
  );
}
