import React from 'react';

// Rotating earth globe for hero - pure CSS, no extra deps
// Uses equirectangular earth texture tiled horizontally to simulate rotation
// Keeps vibe of "live grid": global, connected, powered
export default function Globe({ className = '', height = 'h-full' }) {
  // Reliable equirectangular textures (CC-0, CDN)
  const earthTex = 'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg';
  const cloudsTex = 'https://unpkg.com/three-globe@2.31.0/example/img/earth-clouds.png';

  return (
    <div className={`relative overflow-hidden flex items-center justify-center bg-[#0A1B33] ${height} ${className}`}>
      {/* starfield */}
      <div className="absolute inset-0" style={{
        background: `
          radial-gradient(1.2px 1.2px at 18% 22%, rgba(255,255,255,.9) 50%, transparent 55%),
          radial-gradient(1px 1px at 42% 18%, rgba(255,255,255,.7) 50%, transparent 55%),
          radial-gradient(1px 1px at 68% 14%, rgba(255,255,255,.8) 50%, transparent 55%),
          radial-gradient(1.1px 1.1px at 82% 30%, rgba(255,255,255,.6) 50%, transparent 55%),
          radial-gradient(1px 1px at 12% 68%, rgba(255,255,255,.5) 50%, transparent 55%),
          radial-gradient(1px 1px at 88% 72%, rgba(255,255,255,.55) 50%, transparent 55%),
          radial-gradient(1.2px 1.2px at 55% 88%, rgba(255,255,255,.6) 50%, transparent 55%),
          radial-gradient(1px 1px at 28% 88%, rgba(242,169,59,.7) 50%, transparent 55%),
          radial-gradient(1px 1px at 76% 82%, rgba(242,169,59,.5) 50%, transparent 55%),
          linear-gradient(180deg, #0A1B33 0%, #132A4D 45%, #0e2442 100%)
        `
      }} />

      {/* subtle grid lines like hero */}
      <div className="absolute inset-0 opacity-[0.07]" style={{
        backgroundImage: `linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)`,
        backgroundSize: '32px 32px'
      }} />

      {/* atmospheric glow behind globe */}
      <div className="absolute w-[220px] h-[220px] sm:w-[240px] sm:h-[240px] rounded-full blur-[28px] opacity-30 pointer-events-none"
        style={{ background: 'radial-gradient(circle at 50% 50%, rgba(242,169,59,0.55) 0%, rgba(242,169,59,0.15) 35%, transparent 70%)' }} />

      {/* orbit ring */}
      <div className="absolute w-[172px] h-[172px] sm:w-[190px] sm:h-[190px] rounded-full border border-white/10 pointer-events-none" style={{ transform: 'rotateX(66deg) rotateZ(-14deg)' }}>
        <span className="absolute w-1.5 h-1.5 rounded-full bg-circuit-amber shadow-glow-amber top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 dot-orbit" />
      </div>
      <div className="absolute w-[148px] h-[148px] sm:w-[168px] sm:h-[168px] rounded-full border border-circuit-amber/15 pointer-events-none hidden sm:block" style={{ transform: 'rotateX(62deg) rotateZ(18deg)' }} />

      {/* GLOBE sphere */}
      <div className="relative w-[132px] h-[132px] sm:w-[150px] sm:h-[150px] rounded-full overflow-hidden shrink-0 shadow-[0_10px_40px_rgba(0,0,0,.45),inset_0_0_40px_rgba(0,0,0,.6)] border border-white/10 globe-tilt">
        {/* earth texture scrolling */}
        <div
          className="absolute inset-0 rounded-full globe-spin"
          style={{
            backgroundImage: `url(${earthTex})`,
            backgroundSize: 'auto 100%',
            backgroundPosition: '0 0',
            backgroundRepeat: 'repeat-x',
            filter: 'contrast(1.05) saturate(1.15) brightness(1.02)',
          }}
        />
        {/* clouds - slower parallax */}
        <div
          className="absolute inset-0 rounded-full globe-spin-clouds opacity-[0.32] mix-blend-screen pointer-events-none"
          style={{
            backgroundImage: `url(${cloudsTex})`,
            backgroundSize: 'auto 100%',
            backgroundPosition: '0 0',
            backgroundRepeat: 'repeat-x',
          }}
        />
        {/* terminator shading */}
        <div className="absolute inset-0 rounded-full pointer-events-none" style={{
          background: `linear-gradient(90deg, rgba(0,0,0,.55) 0%, transparent 32%, transparent 68%, rgba(0,0,0,.35) 100%)`
        }} />
        {/* inner shadow for depth */}
        <div className="absolute inset-0 rounded-full pointer-events-none" style={{
          boxShadow: 'inset -18px -12px 28px rgba(0,0,0,.75), inset 6px 8px 18px rgba(255,255,255,.12)'
        }} />
        {/* specular highlight */}
        <div className="absolute inset-0 rounded-full pointer-events-none" style={{
          background: 'radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.34) 0%, rgba(255,255,255,.14) 18%, transparent 42%)'
        }} />
        {/* thin rim light */}
        <div className="absolute inset-0 rounded-full pointer-events-none border border-white/12" />

        {/* Kanpur pin on globe surface - approx India region (mid-right) */}
        <div className="absolute left-[62%] top-[42%] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center">
          <span className="relative flex w-2.5 h-2.5">
            <span className="absolute inline-flex w-full h-full rounded-full bg-spark-ember opacity-75 animate-ping" />
            <span className="relative inline-flex w-2.5 h-2.5 rounded-full bg-spark-ember border-2 border-white shadow-[0_0_10px_rgba(255,107,53,.9)]" />
          </span>
          <span className="mt-1 text-[7px] font-extrabold tracking-widest text-white/90 bg-black/45 px-1 py-0.5 rounded backdrop-blur whitespace-nowrap">KANPUR</span>
        </div>
      </div>

      {/* bottom vignette to match hero card depth */}
      <div className="absolute inset-x-0 bottom-0 h-[42%] bg-gradient-to-t from-black/30 to-transparent pointer-events-none" />

      <style>{`
        .globe-tilt { transform: rotate(-12deg); }
        .globe-spin { animation: globeRotate 38s linear infinite; will-change: background-position; }
        .globe-spin-clouds { animation: globeRotateClouds 62s linear infinite; will-change: background-position; }
        .dot-orbit { animation: orbitDot 4s linear infinite; }
        @keyframes globeRotate {
          from { background-position: 0 0; }
          to { background-position: -400% 0; }
        }
        @keyframes globeRotateClouds {
          from { background-position: 40px 0; }
          to { background-position: -440% 0; }
        }
        @keyframes orbitDot {
          from { transform: rotate(0deg) translateX(86px) rotate(0deg); }
          to { transform: rotate(360deg) translateX(86px) rotate(-360deg); }
        }
        @media (min-width: 640px) {
          @keyframes orbitDot {
            from { transform: rotate(0deg) translateX(95px) rotate(0deg); }
            to { transform: rotate(360deg) translateX(95px) rotate(-360deg); }
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .globe-spin, .globe-spin-clouds, .dot-orbit { animation: none; }
        }
      `}</style>
    </div>
  );
}
