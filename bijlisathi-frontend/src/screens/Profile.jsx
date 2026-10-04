import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon, Shell } from '../components/ui';
import { useLang } from '../lib/i18n.jsx';

export default function Profile({ role, go, onLogout }) {
  const { t } = useLang();
  const PROFILES = {
    citizen: { title: t('myProfileTitle'), icon: 'person', endpoint: '/api/auth/profile', home: '#/home', nav: (go) => [
      { icon: 'home', label: t('navHome'), onClick: () => go('#/home') },
      { icon: 'add_circle', label: t('navReport'), onClick: () => go('#/report') },
      { icon: 'assignment_late', label: t('myComplaints'), onClick: () => go('#/complaints') },
      { icon: 'person', label: t('navProfile'), active: true },
    ]},
    technician: { title: t('techProfileTitle'), icon: 'engineering', endpoint: '/api/auth/profile', home: '#/tasks', nav: (go) => [
      { icon: 'bolt', label: t('navTasks'), onClick: () => go('#/tasks') },
      { icon: 'person', label: t('navProfile'), active: true },
    ]},
    kesco: { title: t('kescoOfficerTitle'), icon: 'monitoring', endpoint: '/api/auth/profile', home: '#/kesco', nav: (go) => [
      { icon: 'space_dashboard', label: t('navDashboard'), onClick: () => go('#/kesco') },
      { icon: 'radar', label: t('navFleet'), onClick: () => go('#/kesco/tracking') },
      { icon: 'person', label: t('navOfficer'), active: true },
    ]},
  };
  const cfg = PROFILES[role];
  const [data, setData] = useState(null);

  useEffect(() => {
    api(cfg.endpoint).then((r) => {
      let profile = r.profile || r.technician || r.admin;
      // Fallback: if backend hasn't returned phone yet but user just entered it during login, show the locally saved one
      if (profile && !profile.phone) {
        try {
          const email = String(profile.email || '').toLowerCase();
          const fallbackPhone = localStorage.getItem(`bs_last_phone_${email}`) || JSON.parse(localStorage.getItem(`bs_offline_user_${email}`) || 'null')?.phone;
          if (fallbackPhone) profile = { ...profile, phone: fallbackPhone };
        } catch (e) {}
      }
      setData(profile);
    }).catch(() => {
      // Offline / mock login — build a minimal profile from localStorage so phone still shows
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith('bs_offline_user_')) {
            const v = JSON.parse(localStorage.getItem(k) || 'null');
            if (v?.email && v?.phone) { setData({ email: v.email, phone: v.phone, name: v.name || '' }); break; }
          }
        }
        // Also try last phone directly
        if (!data) {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith('bs_last_phone_')) {
              const phone = localStorage.getItem(k);
              const email = k.replace('bs_last_phone_', '');
              if (phone) { setData({ email, phone, name: '' }); break; }
            }
          }
        }
      } catch (e) {}
    });
  }, [role]);

  const formatDate = (v) => {
    try { return new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return String(v ?? '—'); }
  };
  // Build explicit account rows per role so KESCO/Technician always show something meaningful in "Account Info"
  const rows = (() => {
    if (!data) return [];
    const out = [];
    const push = (label, val) => { if (val != null && String(val).trim() !== '') out.push([label, String(val)]); };
    if (role === 'citizen') {
      push('Meter Number', data.meterNumber);
      push('Name', data.name);
      push('Email', data.email);
      push('Phone', data.phone);
      if (data.createdAt) push('Member Since', formatDate(data.createdAt));
    } else if (role === 'technician') {
      push('Technician ID', data.technicianId);
      push('Name', data.name);
      push('Email', data.email);
      push('Phone', data.phone);
      if (data.status) push('Status', String(data.status).replace(/-/g, ' '));
      if (data.createdAt) push('Member Since', formatDate(data.createdAt));
    } else if (role === 'kesco') {
      push('Registration Number', data.registrationNumber);
      push('Name', data.name);
      push('Email', data.email);
      push('Phone', data.phone);
      if (data.role) push('Role', data.role);
      if (data.createdAt) push('Member Since', formatDate(data.createdAt));
    }
    // Include any other untracked fields (e.g., ward, division) without duplicating
    const seen = new Set(out.map(([k]) => k.toLowerCase()));
    Object.entries(data).forEach(([k, v]) => {
      if (['_id','__v','assignedComplaints','complaints','savedLocations','currentLocation','password','otp','__t'].includes(k)) return;
      if (v == null || String(v).trim() === '') return;
      const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
      if (seen.has(label.toLowerCase())) return;
      // Skip if already covered by explicit pushes (check raw key)
      if (['meterNumber','technicianId','registrationNumber','name','email','phone','status','role','createdAt'].includes(k)) return;
      out.push([label, String(v)]);
      seen.add(label.toLowerCase());
    });
    return out;
  })();

  return (
    <Shell navLinks={[...cfg.nav(go), { icon: 'logout', label: t('navLogout'), mobile: false, footer: true, onClick: onLogout }]}>
      <div className={role === 'kesco' ? 'font-kesco antialiased' : ''}>
      {/* Header band — mobile: more rounded, thumb-friendly */}
      <div className="bg-ink-navy rounded-[18px] xs:rounded-2xl sm:rounded-3xl p-5 xs:p-7 sm:p-8 relative overflow-hidden mb-6 xs:mb-8">
        <div className="absolute inset-0 bg-gradient-to-br from-ink-navy via-grid-navy to-[#061023]" />
        <div className="absolute inset-0 grid-lines opacity-[0.06]" />
        <div className="relative z-10 flex items-center gap-3 xs:gap-4">
          <button onClick={() => go(cfg.home)} className="w-10 h-10 xs:w-10 xs:h-10 rounded-full bg-white text-ink-navy hover:bg-porcelain flex items-center justify-center transition-colors shadow-card shrink-0 active:scale-95">
            <Icon name="arrow_back" className="text-lg xs:text-xl" />
          </button>
          <div className="min-w-0">
            <h1 className="font-display text-xl xs:text-2xl md:text-3xl font-extrabold text-white tracking-tight leading-tight truncate">{cfg.title}</h1>
            <p className="text-xs xs:text-sm font-medium text-white/70 mt-1">{t('accountSession')}</p>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 xs:gap-6 items-start max-w-4xl mx-auto">
        {/* Identity card — mobile: friendly, bigger avatar */}
        <div className="bg-paper rounded-[18px] sm:rounded-2xl shadow-raised border border-white/60 sm:border-haze/60 p-6 xs:p-7 pt-0 flex flex-col items-center lg:sticky lg:top-8 -mt-2">
          <div className="w-24 h-24 xs:w-28 xs:h-28 rounded-full bg-gradient-to-br from-circuit-amber to-[#fdb244] shadow-glow-amber flex items-center justify-center mb-5 -mt-12 xs:-mt-14 border-4 border-paper">
            <Icon name={cfg.icon} fill className="text-[42px] xs:text-[48px] text-ink-navy" />
          </div>
          <h2 className="font-display text-xl font-extrabold text-ink-navy tracking-tight text-center">{data?.name || t('bijliUserDefault')}</h2>
          {(data?.technicianId || data?.meterNumber || data?.registrationNumber) && (
            <span className="mt-2 bg-surface-container-high px-3 py-1.5 rounded-full border border-haze flex items-center gap-1.5">
              <Icon name="badge" className="text-sm text-wire-slate" />
              <span className="font-mono text-xs text-wire-slate">{data.technicianId || data.meterNumber || data.registrationNumber}</span>
            </span>
          )}
           {data?.email && (
            <div className="mt-4 w-full bg-surface rounded-xl p-3.5 flex items-center gap-3 border border-haze">
              <div className="w-9 h-9 rounded-lg bg-circuit-amber flex items-center justify-center shrink-0"><Icon name="mail" className="text-ink-navy text-base" /></div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-wire-slate font-bold">{t('registeredEmail')}</p>
                <p className="text-sm text-ink-navy font-semibold truncate">{data.email}</p>
              </div>
            </div>
          )}
          {data?.phone ? (
            <div className="mt-3 w-full bg-surface rounded-xl p-3.5 flex items-center gap-3 border border-haze">
              <div className="w-9 h-9 rounded-lg bg-signal-green flex items-center justify-center shrink-0"><Icon name="call" fill className="text-white text-base" /></div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-widest text-wire-slate font-bold">{t('phoneNumberLabel')}</p>
                <p className="text-sm text-ink-navy font-semibold font-mono truncate">{data.phone}</p>
              </div>
              <a href={`tel:${data.phone}`} className="w-9 h-9 rounded-full bg-signal-green text-white flex items-center justify-center shrink-0 hover:bg-signal-green/90 active:scale-95 transition-all" aria-label="Call">
                <Icon name="call" fill className="text-base" />
              </a>
            </div>
          ) : (
            <div className="mt-3 w-full bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-2.5">
              <Icon name="info" className="text-amber-600 text-base shrink-0" />
              <p className="text-xs text-amber-800 leading-snug">{t('noPhoneYet')}</p>
            </div>
          )}
          <button onClick={onLogout} className="w-full mt-6 flex items-center justify-center gap-2 py-3.5 bg-fault-red text-white rounded-xl font-bold hover:bg-[#b93a3a] transition-colors active:scale-[0.98] shadow-card">
            <Icon name="logout" /> {t('profileLogout')}
          </button>
        </div>

        {/* Details */}
        <div className="lg:col-span-2 bg-paper rounded-2xl shadow-raised border border-haze/60 divide-y divide-haze/60 overflow-hidden">
          <div className="px-6 py-4 bg-ink-navy"><p className="text-xs font-extrabold uppercase tracking-widest text-white">{t('accountInfo')}</p></div>
          {rows.length > 0 ? rows.map(([k, v]) => (
            <div key={k} className="flex justify-between items-center px-5 py-3.5 hover:bg-surface-container-low/50 transition-colors">
              <span className="text-xs uppercase tracking-wide text-wire-slate font-semibold">{k.replace(/([A-Z])/g, ' $1')}</span>
              <span className="text-sm font-medium text-ink-navy font-mono break-all text-right max-w-[55%]">{String(v ?? '') || '—'}</span>
            </div>
          )) : (
            <div className="px-5 py-10 text-sm text-wire-slate text-center">{t('detailsAppear')}</div>
          )}
        </div>
      </div>
      </div>
    </Shell>
  );
}
