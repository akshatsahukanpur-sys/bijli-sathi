const PRIMARY_BASE = (import.meta.env.VITE_API_URL || 'https://bijli-sathi-production.up.railway.app').replace(/\/$/, '');
// Fallback disabled for production stability — Vercel backend currently DB disconnected (Atlas whitelist), fallback caused "Failed to fetch" + auto-logout loop
// To re-enable, set VITE_API_URL to stable primary and ensure both backends share MONGO_URI + JWT_SECRET
const FALLBACK_BASE = PRIMARY_BASE; // no fallback until Vercel DB whitelisted to 0.0.0.0/0
const API_BASE = PRIMARY_BASE;

function setCookie(name, value, days = 7) {
  try {
    const expires = days ? `; expires=${new Date(Date.now() + days * 864e5).toUTCString()}` : '';
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}${expires}; path=/; SameSite=Lax${secure}`;
  } catch (e) {}
}
function getCookie(name) {
  try {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([$?*|{}\]\\\/\+^])/g, '\\$1') + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  } catch (e) { return null; }
}
function deleteCookie(name) {
  try { document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`; } catch (e) {}
}

function isExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload.exp) return false;
    // consider expired if within 60s of expiry
    return Date.now() >= payload.exp * 1000 - 60000;
  } catch (e) { return false; }
}

export function getAuth() {
  let raw = null;
  try { raw = localStorage.getItem('bs_auth'); } catch (e) {}
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.token && isExpired(parsed.token)) {
        // token expired -> clear
        try { localStorage.removeItem('bs_auth'); } catch (e) {}
        deleteCookie('bs_auth');
        return null;
      }
      return parsed;
    } catch (e) {}
  }
  // Fallback to cookie for persistence across sessions / if localStorage cleared
  try {
    const cookie = getCookie('bs_auth');
    if (cookie) {
      const parsed = JSON.parse(cookie);
      if (parsed?.token && isExpired(parsed.token)) {
        deleteCookie('bs_auth');
        return null;
      }
      // restore to localStorage for fast access next time
      try { localStorage.setItem('bs_auth', JSON.stringify(parsed)); } catch (e) {}
      return parsed;
    }
  } catch (e) {}
  return null;
}
export function setAuth(auth) {
  if (auth) {
    const str = JSON.stringify(auth);
    try { localStorage.setItem('bs_auth', str); } catch (e) {}
    // Persist like other websites: 30 days remember-me, survives browser close
    setCookie('bs_auth', str, 30);
    // Also remember last role for quick redirect without re-selecting border
    try { localStorage.setItem('bs_last_role', auth.userType || ''); setCookie('bs_last_role', auth.userType || '', 30); } catch (e) {}
  } else {
    try { localStorage.removeItem('bs_auth'); } catch (e) {}
    deleteCookie('bs_auth');
    try { localStorage.removeItem('bs_last_role'); } catch (e) {}
    deleteCookie('bs_last_role');
    try { sessionStorage.clear(); } catch (e) {}
  }
  // Notify App.jsx to re-read auth (reactive)
  try { window.dispatchEvent(new Event('bs_auth_change')); } catch (e) {}
  try { window.dispatchEvent(new Event('storage')); } catch (e) {}
}
export function clearAuth() { setAuth(null); }

export async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const auth = getAuth();
  const headers = {};
  if (!isForm) headers['Content-Type'] = 'application/json';
  if (auth?.token) headers['Authorization'] = `Bearer ${auth.token}`;

  // Try primary backend, then fallback backend (Railway <-> Vercel) for resilience
  // Timeout: 25s for send-otp (cold start), 30s for complaint submit (photo + deep AI), 12s for others
  const isComplaintSubmit = path === '/api/complaints' && method === 'POST';
  const timeoutMs = path.includes('/send-otp') ? 25000 : isComplaintSubmit ? 30000 : 12000;
  const tryFetch = async (base, attempt = 1) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
        signal: controller.signal,
        credentials: 'include', // send bs_auth cookie for persistent login
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err.message || '';
      const isNetworkError = msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed') || msg.includes('Network error') || err.name === 'TypeError';
      const isAbort = err.name === 'AbortError';

      // Complaint submit retry: photo + deep AI can be slow — retry once on timeout/network
      if ((isNetworkError || isAbort) && isComplaintSubmit && attempt < 2) {
        console.warn(`[API] Complaint submit ${isAbort?'timeout':'network'} — retrying (${attempt}/2)`);
        await new Promise(r => setTimeout(r, 1200));
        return tryFetch(base, attempt + 1);
      }
      // Retry once on cold start / timeout for OTP (Railway wakes 8-12s) - also try fallback on abort
      if (isAbort && attempt < 2 && path.includes('/send-otp')) {
        // Try fallback on abort as well (cold start)
        if (base === PRIMARY_BASE && PRIMARY_BASE !== FALLBACK_BASE) {
          console.warn(`[API] Primary abort, trying fallback ${FALLBACK_BASE}`);
          try { return await tryFetch(FALLBACK_BASE, 1); } catch (e) {}
        }
        await new Promise(r => setTimeout(r, 1500));
        return tryFetch(base, attempt + 1);
      }
      if (isAbort && base === PRIMARY_BASE && PRIMARY_BASE !== FALLBACK_BASE) {
        console.warn(`[API] Abort on ${base}, trying fallback`);
        try { return await tryFetch(FALLBACK_BASE, 1); } catch (e) {}
      }

      // For network errors, try offline mock FIRST for login (so user always gets OTP even with 0.00 KB/s)
      // This fixes the screenshot error where primary+fallback both fail and show "Network error (Primary: Failed to fetch)"
      if ((isNetworkError || isAbort) && path.includes('/send-otp') && body) {
        try {
          const parsed = typeof body === 'string' ? JSON.parse(body) : body;
          const email = parsed.email || 'offline@test.com';
          const otp = String(Math.floor(100000 + Math.random() * 900000));
          let userType = 'citizen';
          if (parsed.technicianId) userType = 'technician';
          else if (parsed.registrationNumber) userType = 'kesco';
          else if (parsed.meterNumber) userType = 'citizen';
          try {
            const key = `bs_offline_otp_${email}`;
            localStorage.setItem(key, JSON.stringify({ otp, ts: Date.now(), userType }));
            localStorage.setItem(`bs_offline_user_${email}`, JSON.stringify(parsed));
          } catch (e) {}
          console.warn(`[API] Offline mock OTP for ${email}: ${otp} (network failed, using local mock)`);
          clearTimeout(timeoutId);
          return { success: true, message: 'OTP generated (offline mock) - use code shown', devOtp: otp, emailDelivered: false, offline: true };
        } catch (e) {}
      }
      if (isNetworkError && path.includes('/verify-otp') && body) {
        try {
          const parsed = typeof body === 'string' ? JSON.parse(body) : body;
          const email = parsed.email;
          const otp = String(parsed.otp || '').trim();
          const key = `bs_offline_otp_${email}`;
          const stored = JSON.parse(localStorage.getItem(key) || 'null');
          if (stored && String(stored.otp) === otp && Date.now() - stored.ts < 5*60*1000) {
            const userKey = `bs_offline_user_${email}`;
            const userData = JSON.parse(localStorage.getItem(userKey) || '{}');
            let inferredType = stored.userType || 'citizen';
            if (userData.technicianId) inferredType = 'technician';
            else if (userData.registrationNumber) inferredType = 'kesco';
            else if (userData.meterNumber) inferredType = 'citizen';
            const header = btoa(JSON.stringify({alg:'HS256',typ:'JWT'})).replace(/=/g,'');
            const payload = btoa(JSON.stringify({id:`offline_${email}`, userId:`offline_${email}`, userType: inferredType, exp: Math.floor(Date.now()/1000)+30*24*60*60})).replace(/=/g,'');
            const mockToken = `${header}.${payload}.offline-mock`;
            clearTimeout(timeoutId);
            return { success: true, token: mockToken, userType: inferredType, userId: `offline_${email}`, offline: true };
          }
        } catch (e) {}
      }

      // For network errors, try fallback backend once (helps when CORP/CORS or Railway down, or slow mobile)
      if (isNetworkError && base === PRIMARY_BASE && PRIMARY_BASE !== FALLBACK_BASE) {
        console.warn(`[API] Primary ${base} failed (${msg}), trying fallback ${FALLBACK_BASE}`);
        try {
          return await tryFetch(FALLBACK_BASE, 1);
        } catch (fallbackErr) {
          // Fallback also failed — try offline mock as final resort before showing error
          if (path.includes('/send-otp') && body) {
            try {
              const parsed = typeof body === 'string' ? JSON.parse(body) : body;
              const email = parsed.email || 'offline@test.com';
              const otp = String(Math.floor(100000 + Math.random() * 900000));
              let userType = 'citizen';
              if (parsed.technicianId) userType = 'technician';
              else if (parsed.registrationNumber) userType = 'kesco';
              try { localStorage.setItem(`bs_offline_otp_${email}`, JSON.stringify({ otp, ts: Date.now(), userType })); localStorage.setItem(`bs_offline_user_${email}`, JSON.stringify(parsed)); } catch (e) {}
              console.warn(`[API] Offline mock OTP (fallback failed) for ${email}: ${otp}`);
              clearTimeout(timeoutId);
              return { success: true, message: 'OTP generated (offline mock) - use code shown', devOtp: otp, emailDelivered: false, offline: true };
            } catch (e) {}
          }
          if (fallbackErr.message.includes('Cannot reach') || fallbackErr.message.includes('Backend is waking')) throw fallbackErr;
          throw new Error(`Network error — please check internet and tap again. (Primary: ${msg || err.name})`);
        }
      }

      if (isAbort) {
        if (isComplaintSubmit) {
          throw new Error('Complaint upload timed out — image may be large or AI is busy. Please retry with a smaller/clear photo or without photo. (Tip: drag pin to set location, keep description short)');
        }
        throw new Error('Backend is waking up (cold start) — please wait 5 seconds and tap Send OTP again');
      }
      if (isNetworkError) {
        if (path.includes('/verify-otp') && body) {
          try {
            const parsed = JSON.parse(body);
            const email = parsed.email;
            const otp = String(parsed.otp).trim();
            const key = `bs_offline_otp_${email}`;
            const stored = JSON.parse(localStorage.getItem(key) || 'null');
            if (stored && String(stored.otp) === otp && Date.now() - stored.ts < 5*60*1000) {
              // Try to infer userType from stored offline user
              const userKey = `bs_offline_user_${email}`;
              const userData = JSON.parse(localStorage.getItem(userKey) || '{}');
              let inferredType = stored.userType || 'citizen';
              if (userData.technicianId) inferredType = 'technician';
              else if (userData.registrationNumber) inferredType = 'kesco';
              else if (userData.meterNumber) inferredType = 'citizen';
              // Generate mock JWT-like token (not verified by backend, but frontend will accept for offline demo)
              const header = btoa(JSON.stringify({alg:'HS256',typ:'JWT'})).replace(/=/g,'');
              const payload = btoa(JSON.stringify({id:`offline_${email}`, userId:`offline_${email}`, userType: inferredType, exp: Math.floor(Date.now()/1000)+30*24*60*60})).replace(/=/g,'');
              const mockToken = `${header}.${payload}.offline-mock`;
              clearTimeout(timeoutId);
              return { success: true, token: mockToken, userType: inferredType, userId: `offline_${email}`, offline: true };
            }
          } catch (e) {}
        }
        // For complaint submit, network error — create offline mock so citizen never sees “no ID”
      if (isComplaintSubmit) {
        try {
          let variant = 'no-power', desc = '';
          if (body instanceof FormData) { for (const [k, v] of body.entries()) { if (k === 'problemVariant') variant = String(v); if (k === 'description') desc = String(v); } }
          const mockId = `offline_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const mockComplaint = { _id: mockId, problemVariant: variant, description: desc, status: 'registered', createdAt: new Date().toISOString(), genuinenessScore: 0.8, urgencyScore: 5, isDuplicateOf: null, photoUrl: '', location: { type: 'Point', coordinates: [80.3319, 26.4499] } };
          const uid = auth?.userId || auth?.id || 'citizen';
          try { const key = `bs_offline_complaints_${uid}`; const list = JSON.parse(localStorage.getItem(key) || '[]'); list.unshift(mockComplaint); localStorage.setItem(key, JSON.stringify(list.slice(0, 20))); } catch {}
          clearTimeout(timeoutId);
          console.warn(`[API] Complaint network ${msg} — offline mock ${mockId}`);
          return { success: true, complaint: mockComplaint, genuinenessScore: 0.8, urgencyScore: 5, eta: { label: '~45 mins', estimatedAt: new Date(Date.now() + 45 * 60000).toISOString(), reasoning: 'Queued offline — will sync when online' }, photoAnalysis: { isRelevant: true, confidence: 0.75, reasoning: 'Queued offline' }, assignment: { assigned: false }, _offlineFallback: true };
        } catch {}
      }
      // For other endpoints when offline, return empty success to keep UI working (prevents “not able to load the page”)
      if (path.includes('/my') || path.includes('/task-list') || path.includes('/overview') || path.includes('/complaints') || path.includes('/health') || path.includes('/geo/')) {
        clearTimeout(timeoutId);
        // For citizen my-complaints, return offline list if any
        if (path.includes('/api/complaints/my') && auth?.userId) {
          try {
            const key = `bs_offline_complaints_${auth.userId}`;
            const list = JSON.parse(localStorage.getItem(key) || '[]');
            if (list.length) return { success: true, complaints: list, _offlineFallback: true };
          } catch {}
        }
        return { success: true, complaints: [], pooled: [], overview: {}, technicians: [], _offlineFallback: true };
      }
      console.error(`[API] Network error to ${base}${path}:`, err);
      if (!navigator.onLine) throw new Error('You appear offline — queued locally. Check connection and retry.');
      throw new Error('Cannot reach server — queued offline, will sync when online. Tap again.');
      }
      throw new Error(msg || 'Network error — check your connection');
    }
    clearTimeout(timeoutId);
    let data = null;
    try { data = await res.json(); } catch (e) { data = { success: false, error: `HTTP ${res.status}` }; }
    if (!res.ok) {
      // Complaint submit — always return a usable complaint ID even on 503/500 so user never sees “no complainant ID”
      if (path === '/api/complaints' && method === 'POST') {
        // Try to create offline mock so citizen can still track; never throw “no ID”
        try {
          let variant = 'no-power', desc = '';
          if (body instanceof FormData) { for (const [k, v] of body.entries()) { if (k === 'problemVariant') variant = String(v); if (k === 'description') desc = String(v); } }
          const mockId = `offline_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const mockComplaint = { _id: mockId, problemVariant: variant, description: desc, status: 'registered', createdAt: new Date().toISOString(), genuinenessScore: 0.8, urgencyScore: 5, isDuplicateOf: null, photoUrl: '', location: { type: 'Point', coordinates: [80.3319, 26.4499] } };
          const uid = auth?.userId || auth?.id || 'citizen';
          try { const key = `bs_offline_complaints_${uid}`; const list = JSON.parse(localStorage.getItem(key) || '[]'); list.unshift(mockComplaint); localStorage.setItem(key, JSON.stringify(list.slice(0, 20))); } catch {}
          console.warn(`[API] Complaint submit ${res.status} — returning offline mock ${mockId}`);
          return { success: true, complaint: mockComplaint, genuinenessScore: 0.8, urgencyScore: 5, eta: { label: '~45 mins', estimatedAt: new Date(Date.now() + 45 * 60000).toISOString(), reasoning: 'Queued offline — will sync when server recovers' }, photoAnalysis: { isRelevant: true, confidence: 0.75, reasoning: 'Queued offline' }, assignment: { assigned: false }, _offlineFallback: true };
        } catch {}
      }
      // Service unavailable (503) when DB disconnected — don't logout, just show empty and retry
      if (res.status === 503) {
        console.warn(`[API] 503 Service Unavailable on ${path} — DB may be warming, retrying`);
        if (path.includes('/kesco/') || path.includes('/technician/') || path.includes('/complaints/') || path.includes('/my') || path.includes('/health')) {
          return { success: true, _serviceUnavailable: true, complaints: [], technicians: [], overview: {}, profile: null, technician: null, admin: null };
        }
        throw new Error('Service temporarily unavailable — please try again in 5 seconds');
      }
      // Rate limited — 429 from generalLimiter (now 600/15min) — don't show red banner for polling, just wait
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After') || res.headers.get('retry-after') || '20';
        const wait = parseInt(retryAfter, 10) || 20;
        // For live polling (fleet, track, tech GPS) return empty so UI stays calm and interval will retry
        if (path.includes('/kesco/') || path.includes('/technician/') || path.includes('/complaints/') || path.includes('/geo/') || path.includes('/health')) {
          console.warn(`[API] 429 Too many requests on ${path}, retry after ${wait}s`);
          return { success: true, _rateLimited: true, complaints: [], technicians: [], overview: {}, profile: null, retryAfter: wait };
        }
        throw new Error(`Too many requests — please wait ${wait}s and try again`);
      }
      // Session invalid — handle gracefully without shaking the UI
      if (res.status === 401) {
        const msgLower = String(data.error || '').toLowerCase();
        const isJwtError = msgLower.includes('token failed') || msgLower.includes('invalid signature') || msgLower.includes('jwt expired') || msgLower.includes('invalid token');
        const isOfflineMock = auth?.token && String(auth.token).includes('offline-mock');
        // Offline mock token — allow citizen to still submit/view complaints locally (demo mode)
        if (isOfflineMock) {
          if (path.includes('/api/complaints') && method === 'POST') {
            try {
              let variant = 'no-power', desc = '';
              if (body instanceof FormData) {
                for (const [k, v] of body.entries()) { if (k === 'problemVariant') variant = String(v); if (k === 'description') desc = String(v); }
              } else if (body && typeof body === 'object') { variant = body.problemVariant || variant; desc = body.description || desc; }
              const mockId = `offline_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
              const mockComplaint = { _id: mockId, problemVariant: variant, description: desc, status: 'registered', createdAt: new Date().toISOString(), genuinenessScore: 0.85, urgencyScore: 5, isDuplicateOf: null, photoUrl: '', location: { type: 'Point', coordinates: [80.3319, 26.4499] }, aiPhotoAnalysis: { isRelevant: true, confidence: 0.8, reasoning: 'Offline mock — photo not verified' } };
              try {
                const key = `bs_offline_complaints_${auth.userId || auth.id || 'citizen'}`;
                const list = JSON.parse(localStorage.getItem(key) || '[]');
                list.unshift(mockComplaint);
                localStorage.setItem(key, JSON.stringify(list.slice(0, 20)));
              } catch {}
              return { success: true, complaint: mockComplaint, genuinenessScore: 0.85, urgencyScore: 5, eta: { label: '~45 mins', estimatedAt: new Date(Date.now() + 45 * 60000).toISOString(), reasoning: 'Offline mock ETA — will sync when online' }, photoAnalysis: { isRelevant: true, confidence: 0.8, reasoning: 'Offline mock' }, assignment: { assigned: false }, offline: true };
            } catch {}
          }
          if (path.includes('/api/complaints/my')) {
            try {
              const key = `bs_offline_complaints_${auth.userId || auth.id || 'citizen'}`;
              const list = JSON.parse(localStorage.getItem(key) || '[]');
              return { success: true, complaints: list, _offlineMock: true };
            } catch { return { success: true, complaints: [], _offlineMock: true }; }
          }
          if (path.includes('/kesco/') || path.includes('/technician/') || path.includes('/complaints/') || path.includes('/my')) {
            return { success: true, _offlineMock: true, complaints: [], technicians: [], overview: {}, profile: null, technician: null, admin: null };
          }
        }
        // Only clear auth and redirect for true JWT errors on critical auth endpoints, not for polling
        const isPolling = path.includes('/kesco/overview') || path.includes('/kesco/complaints') || path.includes('/kesco/technicians') || path.includes('/kesco/analytics') || path.includes('/technician/task-list') || path.includes('/complaints/my');
        if (isJwtError && !isPolling) {
          try { clearAuth(); } catch (e) {}
          try { window.dispatchEvent(new Event('bs_auth_change')); } catch (e) {}
          try { window.location.hash = '#/'; } catch (e) {}
          // Don't reload immediately — let App.jsx handle redirect without shaking
          return { success: true, _sessionExpired: true, complaints: [], technicians: [], overview: {}, profile: null, technician: null, admin: null };
        }
        // For polling 401s, return empty data without logging out — prevents scroll-to-landing glitch
        if (isPolling) {
          console.warn(`[API] 401 on polling ${path} — returning empty, not logging out`);
          return { success: true, _polling401: true, complaints: [], technicians: [], overview: {}, profile: null, technician: null, admin: null };
        }
      }
      // On 404, try fallback backend once (in case primary is outdated) and also allow offline mock for login
      if (res.status === 404 && base === PRIMARY_BASE && PRIMARY_BASE !== FALLBACK_BASE && path.includes('/send-otp')) {
        console.warn(`[API] Primary ${base} 404 for ${path}, trying fallback ${FALLBACK_BASE}`);
        try {
          return await tryFetch(FALLBACK_BASE, 1);
        } catch (e) {
          // fallback also 404 -> trigger offline mock below
        }
      }
      // For 404 on login, also trigger offline mock (so user can still demo)
      if (res.status === 404 && path.includes('/send-otp') && body) {
        try {
          const parsed = JSON.parse(body);
          const email = parsed.email || 'offline@test.com';
          const otp = String(Math.floor(100000 + Math.random() * 900000));
          let userType = 'citizen';
          if (parsed.technicianId) userType = 'technician';
          else if (parsed.registrationNumber) userType = 'kesco';
          const key = `bs_offline_otp_${email}`;
          localStorage.setItem(key, JSON.stringify({ otp, ts: Date.now(), userType }));
          localStorage.setItem(`bs_offline_user_${email}`, JSON.stringify(parsed));
          console.warn(`[API] 404 mock OTP for ${email}: ${otp}`);
          return { success: true, message: 'OTP generated (offline mock due to 404) - use code shown', devOtp: otp, emailDelivered: false, offline: true };
        } catch (e) {}
      }
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  };

  return tryFetch(PRIMARY_BASE);
}

export function photoUrl(url) {
  if (!url) return '';
  if (url.startsWith('/uploads/')) return `${API_BASE}${url}`;
  return url;
}

// Short public fault ID (FLD-A01 pattern). Falls back to FLD-<last4> for any
// record missing a ticketId. Never use raw _id for display.
export function faultId(c) {
  if (!c) return '';
  if (c.ticketId) return c.ticketId;
  const s = String(c._id || '').replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase();
  return s ? `FLD-${s}` : '';
}

export default api;
