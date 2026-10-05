import React, { useState, useRef, useEffect } from 'react';
import { api } from '../lib/api';
import { Icon } from './ui';

/**
 * Sathi — BijliSathi's AI assistant. Opens like the Gemini MOBILE app:
 * full-screen takeover on mobile, elegant popup on desktop.
 * Chat list scrolls freely up/down (reel-like momentum) to see full history.
 */
const GRAD = 'linear-gradient(100deg, #FDBC01, #F2A93B, #FE7801, #FF8C00, #FDBC01)';

const shimmerStyle = { background: GRAD, backgroundSize: '200% auto', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', animation: 'bs-gradient-shift 4.5s ease infinite' };

export default function ChatAssistant({ complaintId, title = 'Sathi — Your AI Assistant', collapsedLabel = 'Sathi', raise = false, audience = '' }) {
  const isKescoCommander = audience === 'kesco' || (title || '').toLowerCase().includes('kesco');
  const isTech = audience === 'technician';

  const welcomeMsg = () => ({
    role: 'assistant',
    welcome: true,
    title: isKescoCommander ? 'Namaste, Controller!' : isTech ? 'Namaste, Technician!' : 'Namaste! I\u2019m Sathi',
    content: isKescoCommander
      ? 'Connected to live global search + KESCO grid data. Ask me about faults, dispatch, hotspots, helplines — I\u2019ll give you the right answer, every time.'
      : isTech
      ? 'Your on-field AI work partner with live global search connected. Ask me safety steps, fault-fixing guidance, helplines — anything on the job.'
      : complaintId
      ? 'Your personal complaint assistant with live global search connected. Ask me \u201cwhen will it fix?\u201d, \u201cwho is my technician?\u201d — I\u2019ll give you the exact answer.'
      : 'Your AI assistant, connected to global search engines — answers always accurate and up to date. Ask me anything!',
  });

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState(() => [welcomeMsg()]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [bloom, setBloom] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [unread, setUnread] = useState(0);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) {
      setBloom(true);
      const t = setTimeout(() => setBloom(false), 950);
      return () => clearTimeout(t);
    }
  }, [open ]);

  const scrollToBottom = (smooth = true) => {
    const el = listRef.current;
    if (!el) return;
    try {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    } catch {
      el.scrollTop = el.scrollHeight;
    }
    setShowJump(false);
    setUnread(0);
  };

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 90;
    if (nearBottom) {
      if (showJump) setShowJump(false);
      if (unread !== 0) setUnread(0);
    } else if (!showJump && messages.length > 1) {
      setShowJump(true);
    }
  };

  // Smart auto-scroll: follow new messages only when user is already at bottom.
  // When user is reading history up top, keep position and show "Latest" pill instead.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !open) return;
    if (messages.length <= 1) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 140) {
      const t = setTimeout(() => scrollToBottom(true), 60);
      return () => clearTimeout(t);
    }
    setUnread((u) => Math.min(u + 1, 9));
    setShowJump(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, open]);

  // When Sathi opens, settle at latest (or top hero when fresh)
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => scrollToBottom(false), 120);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep pinned to bottom while assistant is typing, only if user hasn't scrolled up
  useEffect(() => {
    if (!busy || !open) return;
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 140) {
      const t = setTimeout(() => scrollToBottom(true), 80);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, open]);

  const send = async (preset) => {
    const text = String(preset ?? input).trim();
    if (!text || busy) return;
    const history = messages.slice(-8).map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setInput('');
    setBusy(true);
    // Jump to latest immediately for the user's own message
    setTimeout(() => scrollToBottom(true), 50);
    try {
      const path = complaintId ? `/api/chat/complaint/${complaintId}` : '/api/chat/ask';
      const res = await api(path, { method: 'POST', body: { message: text, history } });
      setMessages((m) => [...m, { role: 'assistant', content: res.answer || '\u2014', provider: res.provider }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: `Sorry \u2014 ${e.message}. Please try again.`, error: true }]);
    }
    setBusy(false);
  };

  const clearChat = () => {
    setMessages([welcomeMsg()]);
    setUnread(0);
    setShowJump(false);
    setTimeout(() => scrollToBottom(false), 60);
  };

  const quickPrompts = (complaintId
    ? [['schedule', 'When will it fix?'], ['engineering', 'Who is my technician?'], ['support_agent', 'KESCO helpline number'], ['health_and_safety', 'Safety tips']]
    : isKescoCommander
    ? [['pending_actions', 'Pending complaints'], ['radar', 'City fault hotspots'], ['support_agent', 'KESCO helpline'], ['receipt_long', 'Billing issue help']]
    : isTech
    ? [['health_and_safety', 'Safety: live wires'], ['build', 'Transformer fix steps'], ['bolt', 'Voltage issue help'], ['support_agent', 'KESCO helpline']]
    : [['power_off', 'Power cut in my area?'], ['support_agent', 'KESCO helpline number'], ['receipt_long', 'How to pay my bill?'], ['add_circle', 'Report a fault']]
  );

  const btnPos = raise ? 'bottom-[calc(5.75rem+env(safe-area-inset-bottom))] lg:bottom-[6rem] right-3 xs:right-4 lg:right-6' : 'bottom-[calc(5.75rem+env(safe-area-inset-bottom))] sm:bottom-[calc(6rem+env(safe-area-inset-bottom))] lg:bottom-[1.5rem] right-3 xs:right-4 lg:right-6';
  const panelPos = raise ? 'sm:bottom-[10rem] lg:bottom-[6rem] sm:right-3 lg:right-6' : 'sm:bottom-[10.5rem] lg:bottom-[6rem] sm:right-3 lg:right-6';

  const Orb = ({ size = 36, spin = 3, ring = false }) => (
    <span className="relative rounded-full flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      {ring && <span className="absolute -inset-1.5 rounded-full border border-circuit-amber/40 pointer-events-none" style={{ animation: 'bs-orb-pulse 2.2s ease-in-out infinite' }} />}
      <span className="absolute inset-0 rounded-full" style={{ background: 'conic-gradient(from 0deg, #FDBC01, #F2A93B, #FE7801, #FF8C00, #FDBC01)', animation: `bs-orb-spin ${spin}s linear infinite` }} />
      <span className="absolute rounded-full bg-[#0A1B33] flex items-center justify-center" style={{ inset: size > 50 ? 4 : 2.5 }}>
        <Icon name="auto_awesome" fill style={{ color: '#F2A93B' }} className={size > 50 ? 'text-2xl' : size > 30 ? 'text-base' : 'text-sm'} />
      </span>
    </span>
  );

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open Sathi AI assistant"
        className={`fixed z-[60] ${btnPos} group flex items-center gap-2.5 pl-1.5 pr-4 py-1.5 rounded-full bg-ink-navy text-white shadow-raised border border-white/10 hover:bg-grid-navy active:scale-95 transition-all max-w-[calc(100vw-24px)] box-border overflow-hidden shrink-0`}
        style={{ maxWidth: 'calc(100vw - 24px)' }}
      >
        <Orb size={40} spin={4} ring />
        <span className="flex flex-col items-start leading-none min-w-0 overflow-hidden">
          <span className="text-sm font-bold tracking-tight truncate" style={shimmerStyle}>{collapsedLabel} <span className="text-[9px] align-middle ml-0.5 px-1.5 py-0.5 rounded-full font-bold shrink-0" style={{ background: 'rgba(242,169,59,0.18)', color: '#F2A93B' }}>AI</span></span>
        </span>
      </button>
    );
  }

  const fresh = messages.length === 1 && messages[0].welcome;
  const chat = messages.filter((m) => !m.welcome);

  return (
    <div
      className={`fixed inset-0 z-[80] flex flex-col h-[100dvh] sm:inset-auto sm:h-[620px] sm:max-h-[calc(100dvh-150px)] sm:w-[400px] sm:max-w-[94vw] ${panelPos}`}
      style={{ transformOrigin: 'bottom right', animation: 'bs-open-app 0.5s cubic-bezier(0.2, 0.9, 0.3, 1) both' }}
    >
      <div className="flex flex-col flex-1 min-h-0 h-full sm:m-[1.5px] sm:rounded-[26px] sm:p-[1.5px] sm:shadow-raised sm:overflow-hidden relative" style={{ background: GRAD, backgroundSize: '300% 300%', animation: 'bs-gradient-shift 7s ease infinite' }}>
        <div className="relative flex flex-col flex-1 min-h-0 h-full sm:rounded-[25px] overflow-hidden sm:border" style={{ background: '#0A1B33', borderColor: 'rgba(255,255,255,0.08)' }}>
          {bloom && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ animation: 'bs-bloom 0.9s ease-out both' }}>
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[150%] aspect-square rounded-full" style={{ background: 'radial-gradient(circle, rgba(253,188,1,0.35) 0%, rgba(242,169,59,0.30) 30%, rgba(254,120,1,0.25) 55%, rgba(255,140,0,0.15) 75%, transparent 85%)', filter: 'blur(8px)' }} />
            </div>
          )}

          {/* Top bar — status + actions */}
          <div className="flex items-center gap-2.5 px-3 py-2.5 shrink-0 border-b border-white/10 relative z-10 bg-[#0A1B33]/95 backdrop-blur" style={{ animation: 'bs-header-in 0.45s cubic-bezier(0.2,0.9,0.3,1) both' }}>
            <button onClick={() => setOpen(false)} aria-label="Back" className="w-9 h-9 rounded-full hover:bg-white/10 active:scale-90 flex items-center justify-center text-white/90 transition-all shrink-0">
              <Icon name="arrow_back" className="text-[22px] sm:hidden" />
              <Icon name="close" className="text-[22px] hidden sm:block" />
            </button>
            <span className="relative shrink-0">
              <Orb size={36} spin={3} />
              <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-[#0A1B33]" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-extrabold leading-tight flex items-center gap-1.5" style={shimmerStyle}>Sathi <span className="text-[9px] align-middle px-1.5 py-0.5 rounded-full font-bold" style={{ background: 'rgba(242,169,59,0.15)', color: '#F2A93B' }}>AI</span></p>
            </div>
            {!fresh && (
              <button onClick={clearChat} title="Start new chat" aria-label="Start new chat" className="w-9 h-9 rounded-full hover:bg-white/10 active:scale-90 flex items-center justify-center text-white/70 hover:text-white transition-all shrink-0">
                <Icon name="refresh" className="text-[19px]" />
              </button>
            )}
          </div>

          {/* Scroll zone wrapper — definite height so inner list can overflow + scroll */}
          <div className="relative flex-1 min-h-0 flex flex-col">
            {/* soft background glows */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
              <div className="absolute -top-10 -left-16 w-56 h-56 rounded-full" style={{ background: 'radial-gradient(circle, rgba(242,169,59,0.16), transparent 65%)', filter: 'blur(6px)', animation: 'bs-aurora 9s ease-in-out infinite alternate' }} />
              <div className="absolute bottom-0 -right-16 w-64 h-64 rounded-full" style={{ background: 'radial-gradient(circle, rgba(254,120,1,0.13), transparent 65%)', filter: 'blur(8px)', animation: 'bs-aurora 12s ease-in-out infinite alternate-reverse' }} />
              <div className="absolute top-1/3 left-1/2 w-72 h-72 rounded-full" style={{ background: 'radial-gradient(circle, rgba(253,188,1,0.07), transparent 65%)', filter: 'blur(12px)', animation: 'bs-aurora 14s ease-in-out infinite alternate' }} />
            </div>

            <div
              ref={listRef}
              onScroll={handleScroll}
              className="sathi-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-4 pt-4 pb-3 space-y-3.5 relative z-10"
              style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y', overscrollBehavior: 'contain', scrollBehavior: 'smooth' }}
            >
              {fresh ? (
                <div className="min-h-full flex flex-col items-center justify-center text-center py-8" style={{ animation: 'bs-hero-in 0.75s cubic-bezier(0.2,0.9,0.3,1) 0.15s both' }}>
                  <span className="relative" style={{ animation: 'bs-float 4s ease-in-out infinite' }}>
                    <span className="absolute -inset-6 rounded-full" style={{ background: 'radial-gradient(circle, rgba(242,169,59,0.32), transparent 65%)', filter: 'blur(10px)', animation: 'bs-orb-pulse 3s ease-in-out infinite' }} />
                    <Orb size={88} spin={4} ring />
                  </span>
                  <p className="font-display font-extrabold text-[30px] leading-tight mt-6" style={shimmerStyle}>{messages[0].title}</p>
                  <p className="text-white/60 text-sm mt-2.5 font-semibold">How can I help you today?</p>
                  <p className="text-white/35 text-[12px] mt-1.5 max-w-[290px] leading-relaxed">{messages[0].content}</p>
                </div>
              ) : (
                <>
                  <div className="flex justify-center pt-1">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-white/40 bg-white/[0.05] border border-white/10 rounded-full px-3 py-1">Today</span>
                  </div>
                </>
              )}
              {chat.map((m, i) => (
                <div key={i} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`} style={{ animation: `bs-msg-pop 0.38s cubic-bezier(0.2,0.9,0.3,1.2) ${Math.min(i, 6) * 0.05}s both` }}>
                  {m.role === 'assistant' && <span className="mt-0.5 shrink-0"><Orb size={27} spin={5} /></span>}
                  <div
                    className={`max-w-[84%] px-3.5 py-2.5 text-[13.5px] leading-relaxed break-words ${
                      m.role === 'user'
                        ? 'text-[#0A1B33] rounded-2xl rounded-br-md font-semibold shadow-[0_6px_18px_rgba(242,169,59,0.35)]'
                        : m.error
                        ? 'bg-red-500/10 border border-red-400/30 text-red-200 rounded-2xl rounded-bl-md'
                        : 'bg-white/[0.07] border border-white/10 text-white/90 rounded-2xl rounded-bl-md backdrop-blur shadow-[0_4px_16px_rgba(0,0,0,0.25)]'
                    }`}
                    style={m.role === 'user' ? { background: GRAD, backgroundSize: '250% auto', animation: 'bs-gradient-shift 6s ease infinite' } : undefined}
                  >
                    <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  </div>
                </div>
              ))}
              {busy && (
                <div className="flex gap-2 justify-start items-center" style={{ animation: 'bs-msg-in 0.3s ease both' }}>
                  <Orb size={27} spin={1.6} />
                  <div className="bg-white/[0.07] border border-white/10 rounded-2xl rounded-bl-md px-4 py-2.5 flex items-center gap-2 backdrop-blur">
                    <span className="text-[11px] text-white/55 font-semibold">Sathi is thinking…</span>
                    <span className="flex gap-1">
                      {['#FDBC01', '#F2A93B', '#FE7801', '#FF8C00'].map((c, k) => (
                        <span key={k} className="w-1.5 h-1.5 rounded-full" style={{ background: c, animation: `bs-dot 1.2s ease-in-out ${k * 0.15}s infinite` }} />
                      ))}
                    </span>
                  </div>
                </div>
              )}
              {/* spacer so last bubble never hides behind jump pill */}
              <div className="h-2" />
            </div>

            {/* Jump to latest — appears when user scrolls up to read history */}
            {showJump && !fresh && (
              <button
                onClick={() => scrollToBottom(true)}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 pl-3 pr-3.5 py-2 rounded-full text-[12px] font-extrabold text-[#0A1B33] shadow-[0_8px_24px_rgba(242,169,59,0.45)] active:scale-95 transition-all border border-white/30"
                style={{ background: GRAD, backgroundSize: '250% auto', animation: 'bs-gradient-shift 6s ease infinite' }}
              >
                <Icon name="arrow_downward" className="text-[16px]" />
                Latest {unread > 0 && <span className="min-w-[20px] h-5 px-1 rounded-full bg-[#0A1B33] text-white text-[11px] font-extrabold flex items-center justify-center">{unread}</span>}
              </button>
            )}
          </div>

          {/* Bottom — input + horizontally scrolling suggestions (saves vertical space for chats) */}
          <div className="shrink-0 px-3 pt-2 pb-[max(0.9rem,env(safe-area-inset-bottom))] relative z-10 bg-gradient-to-t from-[#0A1B33] via-[#0A1B33]/95 to-transparent" style={{ animation: 'bs-fade-up 0.5s ease 0.4s both' }}>
            <div className="flex items-center gap-2 rounded-[20px] pl-1 pr-1.5 py-1.5 border backdrop-blur transition-all focus-within:shadow-[0_0_0_2px_rgba(242,169,59,0.45),0_8px_24px_rgba(242,169,59,0.20)]" style={{ background: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.14)' }}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={complaintId ? 'Ask about your complaint…' : 'Ask Sathi anything…'}
                className="flex-1 bg-transparent px-3 py-2.5 text-[14px] text-white placeholder-white/35 focus:outline-none min-w-0"
              />
              <button
                onClick={() => send()}
                disabled={busy || !input.trim()}
                aria-label="Send"
                className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-35 active:scale-90 hover:scale-110 transition-all text-white shadow-lg"
                style={input.trim() ? { background: GRAD, backgroundSize: '250% auto', animation: 'bs-gradient-shift 6s ease infinite, bs-send-pulse 1.8s ease-in-out infinite', boxShadow: '0 0 18px rgba(242,169,59,0.65)' } : { background: GRAD, backgroundSize: '250% auto', animation: 'bs-gradient-shift 6s ease infinite' }}
              >
                <Icon name="arrow_upward" className="text-lg" />
              </button>
            </div>
            <div className="sathi-no-scrollbar mt-2 flex gap-2 overflow-x-auto pb-1 snap-x">
              {quickPrompts.map(([icon, label], qi) => (
                <button
                  key={label}
                  onClick={() => send(label)}
                  className="snap-start shrink-0 flex items-center gap-1.5 rounded-full pl-2.5 pr-3.5 py-2 text-left text-[12px] font-bold text-white/85 border border-white/10 hover:border-[rgba(242,169,59,0.6)] hover:bg-[rgba(242,169,59,0.14)] hover:shadow-[0_4px_16px_rgba(242,169,59,0.25)] hover:-translate-y-0.5 active:scale-[0.96] transition-all bg-white/[0.04]"
                  style={{ animation: `bs-fade-up 0.5s ease ${0.45 + qi * 0.08}s both` }}
                >
                  <Icon name={icon} className="text-[16px]" style={{ color: '#F2A93B' }} />
                  <span className="whitespace-nowrap">{label}</span>
                </button>
              ))}
              <span className="shrink-0 w-1" aria-hidden />
            </div>
          </div>
        </div>
      </div>
      <style>{`
        .sathi-scroll { scrollbar-width: thin; scrollbar-color: rgba(242,169,59,0.55) transparent; }
        .sathi-scroll::-webkit-scrollbar { width: 6px; }
        .sathi-scroll::-webkit-scrollbar-track { background: transparent; }
        .sathi-scroll::-webkit-scrollbar-thumb { background: linear-gradient(180deg, #FDBC01, #FE7801); border-radius: 999px; }
        .sathi-no-scrollbar::-webkit-scrollbar { display: none; }
        .sathi-no-scrollbar { scrollbar-width: none; -ms-overflow-style: none; }
        @keyframes bs-gradient-shift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        @keyframes bs-orb-spin { to { transform: rotate(360deg); } }
        @keyframes bs-orb-pulse { 0%, 100% { transform: scale(1); opacity: 0.9; } 50% { transform: scale(1.18); opacity: 0.3; } }
        @keyframes bs-open-app { from { opacity: 0; transform: translateY(26px) scale(0.94); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes bs-msg-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes bs-msg-pop { from { opacity: 0; transform: translateY(12px) scale(0.94); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes bs-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-9px); } }
        @keyframes bs-aurora { from { transform: translate(0,0) scale(1); } to { transform: translate(26px,18px) scale(1.12); } }
        @keyframes bs-hint-bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        @keyframes bs-send-pulse { 0%, 100% { box-shadow: 0 0 12px rgba(242,169,59,0.45); } 50% { box-shadow: 0 0 24px rgba(242,169,59,0.8); } }
        @keyframes bs-dot { 0%, 100% { transform: translateY(0); opacity: 0.5; } 50% { transform: translateY(-3px); opacity: 1; } }
        @keyframes bs-bloom { 0% { opacity: 0.95; transform: scale(0.25); } 100% { opacity: 0; transform: scale(2.4); } }
        @keyframes bs-header-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes bs-hero-in { from { opacity: 0; transform: translateY(16px) scale(0.92); filter: blur(5px); } to { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); } }
        @keyframes bs-fade-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}
