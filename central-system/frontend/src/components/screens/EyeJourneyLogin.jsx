import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './EyeJourneyLogin.css';
import { centralApi } from '../../api/centralApiClient';
import { USE_MOCK_DATA } from '../../config';

// Load fonts
try {
  import('@fontsource/instrument-serif');
  import('@fontsource-variable/inter');
} catch (e) {
  // Fonts optional
}

// Lazy load the animation engine (which itself imports three.js lazily)
const loadEngine = () => import('../../animation/intro.js');
const loadAnatomy = () => import('../../animation/anatomy.js');
const loadFrame = () => import('../../animation/frame.js');
const loadTextures = () => import('../../animation/textures.js');
const loadMath = () => import('../../animation/math.js');

const SCREENS = 7; // Extended for a more deliberate journey
const CHAPTERS = [
  { s: 0, label: 'The eye' },
  { s: 1.6, label: 'Anatomy' },
  { s: 3.5, label: 'Structure' },
  { s: 5.2, label: 'The retina' },
  { s: SCREENS, label: 'Enter' },
];

export const EyeJourneyLogin = ({ onLogin }) => {
  const { t } = useTranslation();
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [anatomyState, setAnatomyState] = useState('idle'); // idle | building | ready | fallback

  // Auth state — ported from LoginScreen
  const [hoveredRole, setHoveredRole] = useState(null);
  const [selectedRole, setSelectedRole] = useState(null);
  const [activeAuthRole, setActiveAuthRole] = useState(null);

  // Live mode starts empty (the seeded demo accounts' credentials are printed
  // once by scripts/seed-demo.js); mock mode keeps its demo pre-fill.
  const [adminUsername, setAdminUsername] = useState(USE_MOCK_DATA ? 'admin' : '');
  const [adminPassword, setAdminPassword] = useState(USE_MOCK_DATA ? 'admin123' : '');
  const [adminError, setAdminError] = useState(null);
  const [adminLoading, setAdminLoading] = useState(false);

  const [ophthUsername, setOphthUsername] = useState(USE_MOCK_DATA ? 'doctor' : '');
  const [ophthPassword, setOphthPassword] = useState(USE_MOCK_DATA ? 'doctor123' : '');
  const [ophthError, setOphthError] = useState(null);
  const [ophthLoading, setOphthLoading] = useState(false);

  const ROLES = [
    {
      id: 'ophthalmologist',
      title: t('central.login.roles.ophthalmologist.title', 'OPHTHALMOLOGIST'),
      subtitle: t('central.login.roles.ophthalmologist.subtitle', 'Case Review & Diagnosis'),
      description: t('central.login.roles.ophthalmologist.desc', 'Review AI-graded retinal scans, confirm or override diagnoses, and manage the review queue.'),
      icon: '◉',

    },
    {
      id: 'admin',
      title: t('central.login.roles.admin.title', 'DISTRICT WORKER'),
      subtitle: t('central.login.roles.admin.subtitle', 'Analytics & Oversight'),
      description: t('central.login.roles.admin.desc', 'Monitor PHC performance, track referrals, view screening analytics, and manage district-wide operations.'),
      icon: '⬡',

    },
  ];

  // DOM refs
  const containerRef = useRef(null);
  const inkRef = useRef(null);
  const glRef = useRef(null);
  const veilRef = useRef(null);
  const brandRef = useRef(null);
  const labelsRef = useRef(null);
  const leadersRef = useRef(null);
  const cueRef = useRef(null);
  const engineRef = useRef(null);

  // Auth handlers
  const handleRoleClick = (roleId) => {
    setSelectedRole(roleId);
    setActiveAuthRole(roleId);
    setAdminError(null);
    setOphthError(null);
  };

  const handleBackToRoles = () => {
    setActiveAuthRole(null);
    setSelectedRole(null);
    setAdminError(null);
    setOphthError(null);
  };

  const skipAnimation = (e) => {
    e?.preventDefault();
    if (engineRef.current?.intro) engineRef.current.intro.finish();
    // Wait a tick for the track to be scrollable, then scroll to bottom
    requestAnimationFrame(() => {
      const maxY = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: maxY, behavior: 'instant' });
    });
    // Also force show the auth as a fallback
    document.documentElement.style.setProperty('--enter-o', '1');
    const enterEl = document.getElementById('auth-overlay');
    if (enterEl) enterEl.classList.add('is-open');
  };

  /**
   * Live mode: POST /api/v1/auth/login with email + password. The server's
   * answer decides the role -- the card the user picked is only a hint, and
   * an account of the other role is told so rather than let in under it.
   * Mock mode: the old client-side demo check, behind the DEMO DATA banner.
   */
  const submitLogin = async ({ cardRole, email, password, setError, setLoading, demoCheck, demoHint }) => {
    if (!email.trim() || !password.trim()) {
      setError(t('central.login.auth.errorEmpty', 'Please enter both email and password.'));
      return;
    }
    setLoading(true);
    setError(null);

    if (USE_MOCK_DATA) {
      setTimeout(() => {
        if (demoCheck()) {
          setIsTransitioning(true);
          setTimeout(() => onLogin(cardRole, email), 400);
        } else {
          setError(demoHint);
          setLoading(false);
        }
      }, 400);
      return;
    }

    try {
      const session = await centralApi.login(email.trim(), password);
      const serverRole = session.user.role === 'district_admin' ? 'admin' : 'ophthalmologist';
      if (serverRole !== cardRole) {
        await centralApi.logout().catch(() => {});
        setError(`This account is a ${session.user.role.replace('_', ' ')} account. Go back and choose that role.`);
        setLoading(false);
        return;
      }
      setIsTransitioning(true);
      setTimeout(() => onLogin(serverRole, session.user.email, session.user), 400);
    } catch (err) {
      setError(err.status === 401
        ? t('central.login.auth.errorInvalid', 'Email or password is incorrect.')
        : err.message);
      setLoading(false);
    }
  };

  const handleAdminSubmit = (e) => {
    e.preventDefault();
    submitLogin({
      cardRole: 'admin', email: adminUsername, password: adminPassword,
      setError: setAdminError, setLoading: setAdminLoading,
      demoCheck: () => (adminUsername.toLowerCase() === 'admin' && adminPassword === 'admin123') || adminPassword.length >= 4,
      demoHint: 'INVALID CREDENTIALS. USE DEMO: admin / admin123',
    });
  };

  const handleOphthSubmit = (e) => {
    e.preventDefault();
    submitLogin({
      cardRole: 'ophthalmologist', email: ophthUsername, password: ophthPassword,
      setError: setOphthError, setLoading: setOphthLoading,
      demoCheck: () => (ophthUsername.toLowerCase() === 'doctor' && ophthPassword === 'doctor123') || ophthPassword.length >= 4,
      demoHint: 'INVALID CREDENTIALS. USE DEMO: doctor / doctor123',
    });
  };

  // --- Animation Orchestration ---
  useEffect(() => {
    let cancel = false;
    let rafId = null;
    const cleanupFns = [];

    async function init() {
      // 1. Check WebGL support
      let hasGL = false;
      try {
        const c = document.createElement('canvas');
        hasGL = !!(c.getContext('webgl2') || c.getContext('webgl'));
      } catch (e) {}

      // Reduced motion: no scroll-driven journey. Show the static background and
      // the sign-in form straight away, so the form is never behind an animation
      // the visitor asked not to see (same path as a browser without WebGL).
      let reducedMotion = false;
      try { reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

      if (!hasGL || reducedMotion) {
        setAnatomyState('fallback');
        document.documentElement.style.setProperty('--enter-o', '1');
        const enterEl = document.getElementById('auth-overlay');
        if (enterEl) enterEl.classList.add('is-open');
        return;
      }

      // 2. Load the intro engine + utilities
      const [introMod, math, frameMod, textures] = await Promise.all([
        loadEngine(), loadMath(), loadFrame(), loadTextures()
      ]);
      if (cancel) return;

      const { createIntro, T } = introMod;
      const { clamp, smoothDamp, smoothstep, ease, mixHex, phase } = math;
      const { frontMetrics } = frameMod;

      let intro;
      try {
        intro = createIntro({ ink: inkRef.current, reduced: false });
      } catch (err) {
        console.error('[EyeJourney] Failed to create intro:', err);
        setAnatomyState('fallback');
        document.documentElement.style.setProperty('--enter-o', '1');
        const enterEl = document.getElementById('auth-overlay');
        if (enterEl) enterEl.classList.add('is-open');
        return;
      }

      engineRef.current = { intro };

      let anatomy = null;
      let fundusTex = null;
      let flatRetina = null;

      // 3. Size
      let size = { w: 0, h: 0 };
      function fit(force = false) {
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (w < 2 || h < 2) return;
        if (!force && w === size.w && Math.abs(h - size.h) < 140) return;
        size = { w, h };
        intro.resize(w, h);
        anatomy?.resize(w, h);
        if (veilRef.current) {
          const hyp = Math.hypot(w, h);
          veilRef.current.style.background = `radial-gradient(circle at 50% 50%, rgba(120,36,18,0) ${hyp * 0.34}px, rgba(74,20,10,0.3) ${hyp * 0.46}px, rgba(30,10,6,0.78) ${hyp * 0.62}px)`;
        }
      }
      fit(true);
      const onResize = () => fit();
      window.addEventListener('resize', onResize);
      cleanupFns.push(() => window.removeEventListener('resize', onResize));

      // 4. Input & Scroll
      const pointer = { x: 0, y: 0, active: false };
      const onPointerMove = (e) => {
        if (e.pointerType !== 'mouse') return;
        pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
        pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
        pointer.active = true;
      };
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      cleanupFns.push(() => window.removeEventListener('pointermove', onPointerMove));
      const onMouseLeave = () => { pointer.active = false; };
      document.documentElement.addEventListener('mouseleave', onMouseLeave);
      cleanupFns.push(() => document.documentElement.removeEventListener('mouseleave', onMouseLeave));

      const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const scrollS = () => clamp(window.scrollY / maxScroll()) * SCREENS;

      // Accelerate intro on interaction
      const onHurry = () => intro.hurry();
      window.addEventListener('wheel', onHurry, { passive: true });
      window.addEventListener('touchstart', onHurry, { passive: true });
      cleanupFns.push(() => {
        window.removeEventListener('wheel', onHurry);
        window.removeEventListener('touchstart', onHurry);
      });

      // 5. Build 3D (lazy — triggered by scroll/intro progress)
      let building = false;
      let aState = 'idle';
      async function buildAnatomy() {
        if (aState !== 'idle' || building) return;
        building = true;
        setAnatomyState('building');
        aState = 'building';
        try {
          const anatMod = await loadAnatomy();
          fundusTex = textures.fundusCanvas(1024);
          anatomy = await anatMod.createAnatomy({
            host: glRef.current,
            labelsEl: labelsRef.current,
            leadersEl: leadersRef.current,
            quality: 'mid',
            fundus: fundusTex
          });
          anatomy.resize(size.w, size.h);
          setAnatomyState('ready');
          aState = 'ready';
        } catch (err) {
          console.error('[EyeJourney] 3D build failed:', err);
          setAnatomyState('fallback');
          aState = 'fallback';
        }
        building = false;
      }

      // 6. Animation loop
      const storySpring = { v: 0 };
      const par = { x: 0, y: 0, vx: { v: 0 }, vy: { v: 0 } };
      let last = performance.now();
      let clock = 0;
      let story = 0;

      // Style cache to avoid redundant DOM writes
      const written = new WeakMap();
      const put = (el, name, value) => {
        if (!el) return;
        let m = written.get(el);
        if (!m) written.set(el, m = new Map());
        if (m.get(name) === value) return;
        m.set(name, value);
        if (name.startsWith('--')) el.style.setProperty(name, value);
        else el.style[name] = value;
      };

      function tick(now) {
        if (cancel) return;
        if (!size.w) { fit(true); if (!size.w) { rafId = requestAnimationFrame(tick); return; } }

        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        clock += dt;

        const introT = intro.t;
        const raw = scrollS();
        if (raw > 0.02) intro.hurry();
        const introDone = introT >= T.done;

        // Start building 3D early
        if (introT > 1.0 || raw > 0.2) buildAnatomy();

        const target = introDone ? raw : 0;
        story = smoothDamp(story, target, storySpring, 0.45, dt, 3.5);

        const live = pointer.active;
        par.x = smoothDamp(par.x, live ? pointer.x : 0, par.vx, 0.7, dt);
        par.y = smoothDamp(par.y, live ? pointer.y : 0, par.vy, 0.7, dt);

        const s = story;
        const { w: W, h: H } = size;
        const fallback = aState === 'fallback';
        const ready = aState === 'ready';

        // h = handoff progress from 2D→3D (first scroll screen)
        const h = clamp(s / 1.0);
        const hold = !ready && !fallback;

        // While on the intro or holding for 3D to build
        if (s < 1.1 || hold) {
          const M = frontMetrics(W, H);
          const w = M.limbusPx / 0.205;
          intro.update(dt, {
            handoff: hold ? Math.min(h, 0.84) : h,
            threeReady: ready,
            fallback,
            target: { x: W / 2, y: H / 2 - 0.012 * w, w, globeR: M.globePx },
            gaze: live && s < 0.05 ? pointer : null,
          });
          put(inkRef.current, 'visibility', '');
          put(inkRef.current, 'opacity', fallback ? (1 - smoothstep(3.0, 3.8, s)).toFixed(3) : '1');
        } else {
          put(inkRef.current, 'visibility', 'hidden');
        }

        // 3D anatomy rendering
        let r = 0, f = 0;
        if (ready && s > 0.4) {
          const res = anatomy.update(s, clock, {
            dt,
            pointer: par,
            hover: pointer.active ? { x: pointer.x, y: -pointer.y } : null,
            adapt: true,
          });
          r = res.r;
          f = res.f;
        } else if (fallback) {
          r = ease.smoother(clamp((s - 4.6) / 1.2));
          f = ease.smoother(clamp((s - 5.5) / 1.4));
          if (s > 1 && !flatRetina && fundusTex) {
            flatRetina = fundusTex;
            flatRetina.className = 'layer flat-retina';
            glRef.current?.appendChild(flatRetina);
          }
          if (flatRetina) put(flatRetina, 'opacity', r.toFixed(3));
        }
        put(glRef.current, 'opacity', ready ? smoothstep(0.4, 0.8, h).toFixed(3) : fallback ? '1' : '0');

        // Background colour transitions
        const dark = smoothstep(0.1, 0.7, h);
        const bg = r > 0 ? mixHex('#16100b', '#2E1008', r) : mixHex('#1a1008', '#16100b', dark);
        put(containerRef.current, 'background', bg);
        const stageEl = containerRef.current?.querySelector('.stage');
        if (stageEl) put(stageEl, 'background', bg);

        put(veilRef.current, 'opacity', (smoothstep(0.3, 1, f) * 0.52).toFixed(3));

        // Brand fades out as we scroll into 3D
        const brandO = 1 - smoothstep(0.2, 0.8, s);
        put(brandRef.current, 'opacity', brandO.toFixed(3));

        // Auth overlay — appears at the end of the scroll journey (screen 6-7)
        const roles = smoothstep(6.0, 6.8, s);
        put(document.documentElement, '--enter-o', roles.toFixed(3));
        const enterEl = document.getElementById('auth-overlay');
        if (enterEl) {
          if (roles > 0.02) enterEl.classList.add('is-open');
          else enterEl.classList.remove('is-open');
        }

        // Rail (chapter dots)
        const railOn = introDone && s > 0.05 && s < 6.5;
        put(document.documentElement, '--rail-o', railOn ? '1' : '0');
        const railEl = document.getElementById('chapter-rail');
        if (railEl) {
          if (railOn) railEl.classList.add('is-on');
          else railEl.classList.remove('is-on');
        }

        // Scroll cue + skip button
        const cueO = phase(introT, T.cue, 0.8, ease.inOutSine) * (1 - smoothstep(0, 0.12, s));
        put(document.documentElement, '--cue-o', cueO.toFixed(3));
        const skipO = 0.7 * phase(introT, 1.2, 1, ease.inOutSine) * (1 - roles);
        put(document.documentElement, '--skip-o', skipO.toFixed(3));

        rafId = requestAnimationFrame(tick);
      }

      rafId = requestAnimationFrame(tick);
    }

    init();

    return () => {
      cancel = true;
      if (rafId) cancelAnimationFrame(rafId);
      cleanupFns.forEach(fn => fn());
      document.documentElement.style.removeProperty('--enter-o');
      document.documentElement.style.removeProperty('--rail-o');
      document.documentElement.style.removeProperty('--cue-o');
      document.documentElement.style.removeProperty('--skip-o');
    };
  }, []);


  // --- Auth UI ---
  const renderAuthCard = (role) => {
    const isAdmin = role === 'admin';
    const roleLabel = isAdmin ? t('central.login.roles.admin.title', 'DISTRICT WORKER') : t('central.login.roles.ophthalmologist.title', 'OPHTHALMOLOGIST');
    const username = isAdmin ? adminUsername : ophthUsername;
    const setUsername = isAdmin ? setAdminUsername : setOphthUsername;
    const password = isAdmin ? adminPassword : ophthPassword;
    const setPassword = isAdmin ? setAdminPassword : setOphthPassword;
    const error = isAdmin ? adminError : ophthError;
    const loading = isAdmin ? adminLoading : ophthLoading;
    const handleSubmit = isAdmin ? handleAdminSubmit : handleOphthSubmit;

    return (
      <div className={`login-auth-container ${isTransitioning ? 'login-auth-container--exit' : ''}`}>
        <div className="login-auth-topbar">
          <span style={{ fontWeight: 600 }}>AUTHENTICATING AS: {roleLabel}</span>
          <button type="button" className="login-auth-back-btn" onClick={handleBackToRoles}>
            ← BACK
          </button>
        </div>
        <div className="login-auth-box">
          <form onSubmit={handleSubmit}>
            {error && <div className="login-auth-error"><span>⚠</span><span>{error}</span></div>}
            <div className="login-auth-field">
              <label className="login-auth-label">{USE_MOCK_DATA ? 'USERNAME' : 'EMAIL'}</label>
              <input
                type={USE_MOCK_DATA ? 'text' : 'email'}
                autoComplete={USE_MOCK_DATA ? 'username' : 'email'}
                className="login-auth-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="login-auth-field">
              <label className="login-auth-label">PASSWORD</label>
              <input
                type="password"
                className="login-auth-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button type="submit" className="login-auth-submit" disabled={loading}>
              {loading ? 'AUTHENTICATING...' : 'INITIATE SESSION ✦'}
            </button>
          </form>
        </div>
      </div>
    );
  };

  return (
    <div className="eye-journey" ref={containerRef}>
      {/* Cybernetic corner frame */}
      <div className="frame-corner frame-corner--tl" aria-hidden="true"></div>
      <div className="frame-corner frame-corner--tr" aria-hidden="true"></div>
      <div className="frame-corner frame-corner--bl" aria-hidden="true"></div>
      <div className="frame-corner frame-corner--br" aria-hidden="true"></div>

      {/* System HUD */}
      <div className="hud" aria-hidden="true">
        SYS::NETRA_SETU<br />
        NETRASETU ACTIVE
      </div>

      <a className="skip" href="#auth-overlay" onClick={skipAnimation} data-skip>
        SKIP →
      </a>

      {/* The 3D Stage — fixed viewport overlay */}
      <div className="stage" aria-hidden="true">
        {/* Iris fibres and perimetry rings behind the model, so the exploded
            view sits inside the eye rather than in empty black. */}
        <div className="layer stage-field"></div>
        <div className="layer" id="gl-host" ref={glRef}></div>
        <div className="layer retina-veil" id="veil" ref={veilRef}></div>
        <canvas className="layer" id="ink" ref={inkRef}></canvas>
        <svg className="layer" id="leaders" ref={leadersRef}></svg>
        <div className="layer" id="labels" ref={labelsRef}></div>
      </div>

      <main id="story">
        <header className="brand" id="brand" ref={brandRef}>
          <h1 className="brand__name">
            NETRA<span className="accent">SETU</span>
          </h1>
          <p className="brand__tagline">
            EXPLAINABLE AI FOR DIABETIC RETINOPATHY
          </p>
        </header>

        <p className={`status ${anatomyState === 'building' ? 'is-visible' : ''}`} id="status">
          {anatomyState === 'building' ? '◈ LOADING 3D ANATOMY MODEL…' : ''}
        </p>
        <p className="cue" id="cue" ref={cueRef} aria-hidden="true">
          <span className="cue__line"></span>
          <span>SCROLL TO EXPLORE</span>
        </p>
        <p className="sr-only">A journey into the eye.</p>

        {/* Auth Overlay — reveals at scroll end */}
        <section className="enter" id="auth-overlay">
          <div className="enter__content">
            {activeAuthRole ? (
              renderAuthCard(activeAuthRole)
            ) : (
              <>
                <p className="enter__title">SELECT YOUR ROLE TO PROCEED</p>
                <div className="enter__roles">
                  {ROLES.map((role) => (
                    <button
                      key={role.id}
                      className="enter__role"
                      onClick={() => handleRoleClick(role.id)}
                      disabled={isTransitioning}
                    >
                      <div className="enter__role-icon">{role.icon}</div>
                      <div className="enter__role-title">{role.title}</div>
                      <div className="enter__role-sub">{role.subtitle}</div>
                      <div className="enter__role-desc">{role.description}</div>

                      <div className="enter__role-arrow">→</div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>

        {/* The tall scroll track — this creates 700vh of scrollable space */}
        <div className="track" id="track" aria-hidden="true"></div>
      </main>

      <nav className="rail" id="chapter-rail" aria-label="Story chapters">
        {CHAPTERS.map((c, i) => (
          <button key={i} type="button" onClick={() => {
            if (engineRef.current?.intro) engineRef.current.intro.finish();
            const maxY = document.documentElement.scrollHeight - window.innerHeight;
            window.scrollTo({ top: (c.s / SCREENS) * maxY, behavior: 'smooth' });
          }}>
            <span className="rail__label">{c.label}</span>
            <span className="rail__dot" aria-hidden="true"></span>
          </button>
        ))}
      </nav>
    </div>
  );
};
