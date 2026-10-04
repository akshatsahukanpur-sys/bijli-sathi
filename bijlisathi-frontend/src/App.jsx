import React, { useEffect, useState, lazy, Suspense, startTransition } from 'react';
import { getAuth, setAuth, clearAuth } from './lib/api';
const Landing = lazy(() => import('./screens/Landing'));
const Login = lazy(() => import('./screens/Login'));
// Lazy-load heavy screens - keeps initial JS ~60KB gz (Landing+Login now lazy too)
const CitizenHome = lazy(() => import('./screens/CitizenHome'));
const ReportComplaint = lazy(() => import('./screens/ReportComplaint'));
const TrackComplaint = lazy(() => import('./screens/TrackComplaint'));
const TechTasks = lazy(() => import('./screens/TechTasks'));
const KescoDashboard = lazy(() => import('./screens/KescoDashboard'));
const KescoTracking = lazy(() => import('./screens/KescoTracking'));
const Profile = lazy(() => import('./screens/Profile'));

function ScreenLoader() {
  return (
    <div className="min-h-screen bg-porcelain flex flex-col items-center justify-center gap-3 p-6">
      <div className="w-10 h-10 rounded-full border-4 border-haze border-t-circuit-amber animate-spin" />
      <p className="text-sm font-bold text-ink-navy">Loading BijliSathi…</p>
    </div>
  );
}

function useHash() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const fn = () => startTransition(() => { setHash(window.location.hash || '#/'); window.scrollTo(0, 0); });
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  const go = (h) => startTransition(() => { window.location.hash = h; });
  return [hash, go];
}

function App() {
  const [hash, go] = useHash();
  const [auth, setAuthState] = useState(() => getAuth());

  // Permanent sync: pending offline complaints → backend when online with real token
  useEffect(() => {
    const syncPending = async () => {
      try {
        const pending = JSON.parse(localStorage.getItem('bs_pending_complaints') || '[]');
        if (!pending.length) return;
        const a = getAuth();
        if (!a?.token || String(a.token).includes('offline-mock')) return;
        if (!navigator.onLine) return;
        const { api } = await import('./lib/api');
        const syncedIdx = new Set();
        for (let i = 0; i < Math.min(pending.length, 3); i++) {
          const p = pending[i];
          try {
            const fd = new FormData();
            fd.append('problemVariant', p.problemVariant);
            fd.append('description', p.description || '');
            fd.append('location', JSON.stringify({ lat: p.location.lat, lng: p.location.lng }));
            await api('/api/complaints', { method: 'POST', body: fd, isForm: true });
            syncedIdx.add(i);
          } catch (e) { console.warn('[Sync] pending failed', e.message); break; }
        }
        // Keep unsent items queued for next retry — never wipe failures
        const remaining = pending.filter((_, i) => !syncedIdx.has(i));
        localStorage.setItem('bs_pending_complaints', JSON.stringify(remaining));
      } catch {}
    };
    syncPending();
    window.addEventListener('online', syncPending);
    const it = setInterval(syncPending, 30000);
    return () => { window.removeEventListener('online', syncPending); clearInterval(it); };
  }, []);

  // Keep auth reactive: on hash change, storage change, or custom event from Login
  useEffect(() => {
    const sync = () => setAuthState(getAuth());
    window.addEventListener('hashchange', sync);
    window.addEventListener('storage', sync);
    window.addEventListener('bs_auth_change', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('storage', sync);
      window.removeEventListener('bs_auth_change', sync);
    };
  }, []);

  const logout = () => {
    setAuth(null);
    setAuthState(null);
    // Clear any stale per-user caches
    try { sessionStorage.clear(); } catch (e) {}
    window.dispatchEvent(new Event('bs_auth_change'));
    go('#/');
  };

  // Sync setAuth calls from Login: wrap global
  useEffect(() => {
    const origSet = setAuth;
    // Monkey-patch not needed; we rely on hashchange + bs_auth_change
  }, []);

  // Route guard: redirect to landing when hitting protected routes without auth — useEffect to update hash
  const protectedPrefixes = ['#/home', '#/report', '#/complaints', '#/track', '#/profile', '#/tasks', '#/tech', '#/kesco'];
  useEffect(() => {
    if (!auth && protectedPrefixes.some((p) => hash.startsWith(p))) {
      go('#/');
    }
    if (auth && (hash === '#' || hash === '#/' || hash === '')) {
      const r = String(auth.userType || '').toLowerCase();
      if (r === 'citizen') go('#/home');
      else if (r === 'technician') go('#/tasks');
      else if (r === 'kesco') go('#/kesco');
    }
  }, [hash, auth]);
  if (!auth && protectedPrefixes.some((p) => hash.startsWith(p))) {
    return <Suspense fallback={<ScreenLoader />}><Landing go={go} /></Suspense>;
  }

  // If logged in, never show Landing/Login as home — redirect handled by useEffect above
  const norm = (v) => String(v || '').toLowerCase();
  const isCitizenPre = norm(auth?.userType) === 'citizen';
  const isTechPre = norm(auth?.userType) === 'technician';
  const isKescoPre = norm(auth?.userType) === 'kesco';
  if (auth && hash.startsWith('#/login/')) {
    const loginRole = norm(hash.split('/')[2]);
    if (loginRole === 'citizen' && isCitizenPre) return <Suspense fallback={<ScreenLoader />}><CitizenHome go={go} /></Suspense>;
    if (loginRole === 'technician' && isTechPre) return <Suspense fallback={<ScreenLoader />}><TechTasks go={go} /></Suspense>;
    if (loginRole === 'kesco' && isKescoPre) return <Suspense fallback={<ScreenLoader />}><KescoDashboard go={go} /></Suspense>;
  }

  // Public
  if (hash === '#' || hash === '#/' || hash === '') return <Suspense fallback={<ScreenLoader />}><Landing go={go} /></Suspense>;
  if (hash.startsWith('#/login/')) {
    const raw = hash.split('/')[2] || '';
    const role = norm(raw);
    const validRoles = ['citizen', 'technician', 'kesco'];
    const safeRole = validRoles.includes(role) ? role : 'citizen';
    if (!validRoles.includes(role)) {
      // normalize without replaceState loop — use go
      setTimeout(() => go('#/login/citizen'), 0);
      return <Suspense fallback={<ScreenLoader />}><Login role={safeRole} go={go} onAuthChange={() => setAuthState(getAuth())} /></Suspense>;
    }
    return <Suspense fallback={<ScreenLoader />}><Login role={safeRole} go={go} onAuthChange={() => setAuthState(getAuth())} /></Suspense>;
  }

  // Role isolation: block cross-role page access — case-insensitive
  const isCitizen = norm(auth?.userType) === 'citizen';
  const isTech = norm(auth?.userType) === 'technician';
  const isKesco = norm(auth?.userType) === 'kesco';

  // Citizen — complaints merged into home (lazy) + 404 handling
  if (isCitizen) {
    if (hash.startsWith('#/tasks') || hash.startsWith('#/tech') || hash.startsWith('#/kesco')) {
      return <Suspense fallback={<ScreenLoader />}><CitizenHome go={go} /></Suspense>;
    }
    if (hash.startsWith('#/report')) return <Suspense fallback={<ScreenLoader />}><ReportComplaint go={go} /></Suspense>;
    if (hash.startsWith('#/complaints')) return <Suspense fallback={<ScreenLoader />}><CitizenHome go={go} /></Suspense>;
    if (hash.startsWith('#/track/')) return <Suspense fallback={<ScreenLoader />}><TrackComplaint id={hash.split('/track/')[1]} go={go} /></Suspense>;
    if (hash.startsWith('#/profile')) return <Suspense fallback={<ScreenLoader />}><Profile role="citizen" go={go} onLogout={logout} /></Suspense>;
    if (hash.startsWith('#/home') || hash === '#/' || hash === '#') return <Suspense fallback={<ScreenLoader />}><CitizenHome go={go} /></Suspense>;
    return <div className="min-h-screen flex items-center justify-center p-6 text-center"><div><p className="font-bold text-ink-navy">Page not found</p><button onClick={() => go('#/home')} className="mt-3 bg-circuit-amber text-ink-navy px-5 py-2 rounded-xl font-bold">Go Home</button></div></div>;
  }

  // Technician (lazy)
  if (isTech) {
    if (hash.startsWith('#/kesco') || hash.startsWith('#/home') || hash.startsWith('#/report') || hash.startsWith('#/complaints') || hash.startsWith('#/track')) {
      return <Suspense fallback={<ScreenLoader />}><TechTasks go={go} /></Suspense>;
    }
    if (hash.startsWith('#/tech/profile') || hash.startsWith('#/profile')) return <Suspense fallback={<ScreenLoader />}><Profile role="technician" go={go} onLogout={logout} /></Suspense>;
    if (hash.startsWith('#/tasks') || hash === '#/' || hash === '#') return <Suspense fallback={<ScreenLoader />}><TechTasks go={go} /></Suspense>;
    return <div className="min-h-screen flex items-center justify-center p-6 text-center"><div><p className="font-bold text-ink-navy">Page not found</p><button onClick={() => go('#/tasks')} className="mt-3 bg-circuit-amber text-ink-navy px-5 py-2 rounded-xl font-bold">Go Tasks</button></div></div>;
  }

  // KESCO (lazy)
  if (isKesco) {
    if (hash.startsWith('#/home') || hash.startsWith('#/report') || hash.startsWith('#/tasks') || hash.startsWith('#/tech')) {
      return <Suspense fallback={<ScreenLoader />}><KescoDashboard go={go} /></Suspense>;
    }
    if (hash.startsWith('#/kesco/tracking')) return <Suspense fallback={<ScreenLoader />}><KescoTracking go={go} /></Suspense>;
    if (hash.startsWith('#/kesco/profile') || hash.startsWith('#/profile')) return <Suspense fallback={<ScreenLoader />}><Profile role="kesco" go={go} onLogout={logout} /></Suspense>;
    if (hash.startsWith('#/kesco') || hash === '#/' || hash === '#') return <Suspense fallback={<ScreenLoader />}><KescoDashboard go={go} /></Suspense>;
    return <div className="min-h-screen flex items-center justify-center p-6 text-center"><div><p className="font-bold text-ink-navy">Page not found</p><button onClick={() => go('#/kesco')} className="mt-3 bg-circuit-amber text-ink-navy px-5 py-2 rounded-xl font-bold">Go Dashboard</button></div></div>;
  }

  // Fallback — if auth exists but role unknown, force logout
  if (auth) {
    clearAuth();
    return <Suspense fallback={<ScreenLoader />}><Landing go={go} /></Suspense>;
  }
  return <Suspense fallback={<ScreenLoader />}><Landing go={go} /></Suspense>;
}

export default App;
