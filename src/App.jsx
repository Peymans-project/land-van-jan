import { useEffect, useMemo, useRef, useState } from 'react';
import { HeartHandshake, Leaf, Pause, Play, UsersRound } from 'lucide-react';
import { imageManifest, pageContent, responsiveSource, routeMeta } from './content.jsx';

const HOME_TIMELINE = [
  { title: 'Het land', date: 'Nu', image: 'land-hero', text: 'We beheren het land, planten, testen en leren.' },
  { title: 'De basis', date: '2024 – 2025', image: 'buitenplek', text: 'Structuur aanbrengen, kas en voorzieningen opzetten.' },
  { title: 'De groei', date: '2026 – 2027', image: 'kas-detail', text: 'Meer oogst, meer mensen, meer verbinding.' },
  { title: 'De plek', date: 'Toekomstbeeld', image: 'toekomst', text: 'Een plek voor groei, ontmoeting en inspiratie.' },
];

const STATUS_LABELS = {
  active: 'Actief', trialing: 'Proefperiode', past_due: 'Betaling nodig', unpaid: 'Onbetaald',
  paused: 'Gepauzeerd', canceled: 'Beëindigd', incomplete: 'Nog niet voltooid', inactive: 'Nog niet actief', pending: 'Wordt verwerkt',
};
const PRIVACY_NOTICE_VERSION = '2026-08-02';
const MARKETING_CONSENT_VERSION = '2026-08-02';
const ACTIVITY_TIME_ZONE = 'Europe/Amsterdam';
const BILLING_READY_STATES = new Set(['ready', 'ready_with_warning', 'ready_cleanup_pending']);
const PORTAL_MEMBERSHIP_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);
const PAYMENT_RECONCILE_DELAYS_MS = [0, 900, 1500, 2200, 3000];

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { credentials: 'include', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.message || 'De server kon deze aanvraag niet verwerken.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function currentPath() {
  const value = window.location.pathname.replace(/\/+$/, '') || '/';
  return routeMeta[value] ? value : '/404';
}

function setMeta(path) {
  const meta = routeMeta[path] || {
    title: 'Pagina niet gevonden | Land van Jan',
    description: 'Deze pagina bestaat niet of is verplaatst.',
    index: false,
  };
  document.title = meta.title;
  const renderedCanonical = document.head.querySelector('link[rel="canonical"]')?.getAttribute('href');
  let publicOrigin = window.location.origin;
  try { publicOrigin = new URL(renderedCanonical || window.location.href, window.location.href).origin; } catch { /* keep the serving origin */ }
  const canonical = `${publicOrigin}${path === '/404' ? window.location.pathname : path}`;
  const upsertMeta = (selector, attributes) => {
    let element = document.head.querySelector(selector);
    if (!element) {
      element = document.createElement('meta');
      document.head.appendChild(element);
    }
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  };
  upsertMeta('meta[name="description"]', { name: 'description', content: meta.description });
  upsertMeta('meta[name="robots"]', { name: 'robots', content: meta.index ? 'index,follow,max-image-preview:large' : 'noindex,nofollow' });
  upsertMeta('meta[property="og:title"]', { property: 'og:title', content: meta.title });
  upsertMeta('meta[property="og:description"]', { property: 'og:description', content: meta.description });
  upsertMeta('meta[property="og:url"]', { property: 'og:url', content: canonical });
  upsertMeta('meta[property="og:type"]', { property: 'og:type', content: 'website' });
  upsertMeta('meta[property="og:image"]', { property: 'og:image', content: `${publicOrigin}/images/land-hero.jpeg` });
  upsertMeta('meta[name="twitter:title"]', { name: 'twitter:title', content: meta.title });
  upsertMeta('meta[name="twitter:description"]', { name: 'twitter:description', content: meta.description });
  upsertMeta('meta[name="twitter:image"]', { name: 'twitter:image', content: `${publicOrigin}/images/land-hero.jpeg` });
  let canonicalLink = document.head.querySelector('link[rel="canonical"]');
  if (!canonicalLink) {
    canonicalLink = document.createElement('link');
    canonicalLink.rel = 'canonical';
    document.head.appendChild(canonicalLink);
  }
  canonicalLink.href = canonical;
}

function AppLink({ to, navigate, className = '', children, onClick, ...props }) {
  const handleClick = (event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} className={className} onClick={handleClick} {...props}>{children}</a>;
}

function LandImage({ imageKey, alt, className = '', eager = false, sizes = '100vw' }) {
  const image = imageManifest[imageKey];
  return <picture className={`land-image ${className}`.trim()}>
    <source type="image/webp" srcSet={responsiveSource(imageKey)} sizes={sizes} />
    <img
      src={image.src}
      alt={alt ?? image.alt}
      width={image.width}
      height={image.height}
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={eager ? 'high' : 'auto'}
      decoding="async"
      style={{ objectPosition: image.focalPoint }}
    />
  </picture>;
}

function Header({ path, member, authReady, navigate, openLogin }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const solid = ['/leden', '/beheer', '/privacy', '/404'].includes(path);
  const go = (to) => { setMenuOpen(false); navigate(to); };
  const links = [['/over-het-land', 'Over het land'], ['/agenda', 'Agenda'], ['/verhalen', 'Verhalen'], ['/contact', 'Contact']];
  return <header className={`site-header ${solid ? 'site-header-solid' : ''}`}>
    <AppLink to="/" navigate={go} className="wordmark" aria-label="Land van Jan, beginpagina">
      <span>LAND VAN JAN</span><small>HUISSEN</small>
    </AppLink>
    <button className="menu-toggle" type="button" aria-expanded={menuOpen} aria-controls="main-navigation" onClick={() => setMenuOpen((value) => !value)}>
      <span>{menuOpen ? 'Sluit' : 'Menu'}</span>
    </button>
    <nav id="main-navigation" className={menuOpen ? 'is-open' : ''} aria-label="Hoofdnavigatie">
      {links.map(([to, label]) => <AppLink key={to} to={to} navigate={go} className={path === to ? 'active' : ''} aria-current={path === to ? 'page' : undefined}>{label}</AppLink>)}
      <a href="/#doneer" onClick={() => setMenuOpen(false)}>Doneer</a>
      {authReady && member
        ? <AppLink to="/leden" navigate={go} className={path === '/leden' ? 'member-link active' : 'member-link'}>{member.name || 'Mijn account'}</AppLink>
        : <button className="member-link" type="button" disabled={!authReady} onClick={() => { setMenuOpen(false); openLogin(); }}>{authReady ? 'Inloggen' : 'Laden…'}</button>}
    </nav>
  </header>;
}

function App() {
  const [path, setPath] = useState(currentPath);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginMode, setLoginMode] = useState('login');
  const [notice, setNotice] = useState('');
  const [member, setMember] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  const navigate = (to) => {
    const target = to || '/';
    if (`${window.location.pathname}${window.location.search}` !== target) window.history.pushState({}, '', target);
    setPath(currentPath());
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  useEffect(() => {
    const sync = () => setPath(currentPath());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  useEffect(() => {
    setMeta(path);
    const heading = document.querySelector('#main-content h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }, [path]);
  useEffect(() => {
    if (path !== '/lid-worden') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('betaling') !== 'geannuleerd') return;
    params.delete('betaling');
    const search = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
    setNotice('De betaling is geannuleerd. Er is niets afgeschreven en je kunt later opnieuw beginnen.');
  }, [path]);
  useEffect(() => {
    if (path !== '/') return;
    const params = new URLSearchParams(window.location.search);
    const donation = params.get('donatie');
    if (donation !== 'bedankt' && donation !== 'geannuleerd') return;
    params.delete('donatie');
    const search = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}#doneer`);
    setNotice(donation === 'bedankt'
      ? 'Dank je wel voor je bijdrage aan Land van Jan.'
      : 'De donatie is geannuleerd. Er is niets afgeschreven.');
  }, [path]);
  useEffect(() => {
    let active = true;
    api('/api/auth/me').then(({ user }) => { if (active) setMember(user || null); }).catch(() => { if (active) setMember(null); }).finally(() => { if (active) setAuthReady(true); });
    return () => { active = false; };
  }, []);

  const openLogin = (mode = 'login') => { setLoginMode(mode); setLoginOpen(true); };
  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); }
    finally {
      setMember(null);
      setLoginOpen(false);
      navigate('/');
      setNotice('Je bent veilig uitgelogd.');
    }
  };
  const handleAuthenticated = (user) => {
    setMember(user);
    setLoginOpen(false);
    navigate('/leden');
    setNotice(`Welkom ${user.name || 'terug'}.`);
  };

  return <>
    <a className="skip-link" href="#main-content">Ga naar de inhoud</a>
    <Header path={path} member={member} authReady={authReady} navigate={navigate} openLogin={openLogin} />
    <main id="main-content" className={path === '/' ? 'home-page' : ['/leden', '/beheer', '/privacy', '/404'].includes(path) ? 'utility-page' : 'inner-page'}>
      {path === '/' && <Home navigate={navigate} member={member} openLogin={openLogin} />}
      {pageContent[path] && <EditorialPage path={path} content={pageContent[path]} navigate={navigate} member={member} openLogin={openLogin} setNotice={setNotice} />}
      {path === '/privacy' && <PrivacyPage navigate={navigate} />}
      {path === '/leden' && (!member ? <ProtectedGate openLogin={openLogin} /> : <MemberDashboard member={member} setMember={setMember} logout={logout} setNotice={setNotice} navigate={navigate} />)}
      {path === '/beheer' && (!member ? <ProtectedGate admin openLogin={openLogin} /> : <AdminDashboard member={member} />)}
      {path === '/404' && <NotFound navigate={navigate} />}
    </main>
    <Footer navigate={navigate} member={member} openLogin={openLogin} />
    {loginOpen && <LoginModal initialMode={loginMode} close={() => setLoginOpen(false)} onAuthenticated={handleAuthenticated} navigate={navigate} />}
    {notice && <Notice close={() => setNotice('')}>{notice}</Notice>}
  </>;
}

function Home({ navigate, member, openLogin }) {
  return <>
    <section className="hero hero-land" aria-labelledby="hero-title">
      <LandImage imageKey="land-hero" eager sizes="100vw" />
      <div className="hero-wash" />
      <div className="hero-copy">
        <h1 id="hero-title"><span>Land</span><span>van Jan</span><em>En alle man</em></h1>
        <p>Een levend project in Huissen.<br />Waar kas, boomgaard en gemeenschap samen groeien.</p>
      </div>
      <div className="paths" aria-label="Kies een route">
        <RouteCard icon="visit" title={<>Bezoek<br />het land</>} text="Kom langs, kijk rond, voel de plek." to="/contact" navigate={navigate} />
        <RouteCard icon="member" title={<>Word<br />lid</>} text="Sluit je aan bij de community en ontvang voordelen." to="/lid-worden" navigate={navigate} />
        <RouteCard icon="donate" title={<>Doneer<br />vrijblijvend</>} text="Kies zelf een bedrag en betaal veilig via Stripe." href="/#doneer" />
      </div>
    </section>
    <section className="route section" aria-labelledby="route-title">
      <div className="route-heading">
        <div><p className="eyebrow">EEN OPEN PROCES</p><h2 id="route-title">Van land<br />naar <em>plek.</em></h2></div>
        <div><p>Een open proces. Geen blauwdruk, wel een richting. Dit is waar we nu staan en waar we naartoe werken.</p><AppLink to="/over-het-land" navigate={navigate} className="text-link">Volg het proces <span aria-hidden="true">→</span></AppLink></div>
      </div>
      <div className="timeline">
        {HOME_TIMELINE.map((item) => <Timeline key={item.image} {...item} />)}
      </div>
    </section>
    <LandFilms />
    <ActivityFeed compact member={member} openLogin={openLogin} navigate={navigate} />
    <DonationSection />
    <section className="membership" aria-labelledby="member-title">
      <div><p className="eyebrow light">LEDENROUTE</p><h2 id="member-title">Draag een plek<br />mee die groeit.</h2><p>Voor leden: toegang tot updates, activiteiten en de community. Een lidmaatschap begint klein en blijft dichtbij het land.</p><AppLink to="/lid-worden" navigate={navigate} className="button button-rust">Ontdek lidmaatschap <span aria-hidden="true">→</span></AppLink></div>
      <LandImage imageKey="gemeenschap" sizes="(max-width: 800px) 100vw, 45vw" />
    </section>
  </>;
}

function RouteIcon({ type }) {
  const Icon = type === 'visit' ? Leaf : type === 'member' ? UsersRound : HeartHandshake;
  return <Icon className="route-icon" aria-hidden="true" focusable="false" strokeWidth={1.6} />;
}

function RouteCard({ icon, title, text, to, href, navigate }) {
  const content = <>
    <RouteIcon type={icon} />
    <strong>{title}</strong>
    <span>{text}</span>
    <b aria-hidden="true">→</b>
  </>;
  return href
    ? <a href={href} className="route-card">{content}</a>
    : <AppLink to={to} navigate={navigate} className="route-card">{content}</AppLink>;
}

function donationAmountToCents(value) {
  const normalized = String(value || '').trim().replace(',', '.');
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  return Number.isSafeInteger(cents) && cents >= 100 && cents <= 500_000 ? cents : null;
}

function DonationSection() {
  const [amount, setAmount] = useState('25');
  const [state, setState] = useState('idle');
  const [message, setMessage] = useState('');
  const submit = async (event) => {
    event.preventDefault();
    const amountCents = donationAmountToCents(amount);
    if (!amountCents) {
      setMessage('Vul een bedrag in tussen €1 en €5.000, met maximaal twee decimalen.');
      return;
    }
    setState('loading');
    setMessage('Stripe Checkout wordt veilig geopend…');
    try {
      const data = await api('/api/billing/donation-checkout', { method: 'POST', body: JSON.stringify({ amountCents }) });
      window.location.assign(data.checkoutUrl);
    } catch (error) {
      setState('idle');
      setMessage(error.message);
    }
  };
  return <section className="donation section" id="doneer" aria-labelledby="donation-title">
    <div className="donation-copy">
      <p className="eyebrow">VRIJBLIJVEND STEUNEN</p>
      <h2 id="donation-title">Geef het land<br /><em>ruimte om te groeien.</em></h2>
      <p>Met een eenmalige bijdrage help je mee aan de kas, boomgaard, materialen en activiteiten. Je kiest zelf het bedrag; er ontstaat geen abonnement.</p>
    </div>
    <form className="donation-form" onSubmit={submit}>
      <label htmlFor="donation-amount">Jouw bedrag</label>
      <div className="donation-amount"><span aria-hidden="true">€</span><input id="donation-amount" name="amount" type="text" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} aria-describedby="donation-help" required /></div>
      <small id="donation-help">Eenmalig · minimaal €1 · veilig verwerkt door Stripe</small>
      <button className="button button-rust" type="submit" disabled={state === 'loading'}>{state === 'loading' ? 'Even wachten…' : 'Doneer via Stripe'} <span aria-hidden="true">→</span></button>
      {message && <p className="donation-status" role="status">{message}</p>}
    </form>
  </section>;
}

function Timeline({ title, date, image, text }) {
  const generated = imageManifest[image].generated;
  return <article>
    <div className="timeline-label"><b>{title}</b><em>{date}</em></div>
    <figure className="timeline-visual"><LandImage imageKey={image} sizes="(max-width: 430px) 100vw, (max-width: 800px) 50vw, 25vw" />{generated && <span>TOEKOMSTVISUALISATIE</span>}</figure>
    <p>{text}</p>
  </article>;
}

function LandVideo({ src, poster, label, className = '' }) {
  const videoRef = useRef(null);
  const [paused, setPaused] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || paused) return;
    video.play().catch(() => setPaused(true));
  }, []);
  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().then(() => setPaused(false)).catch(() => setPaused(true));
    else { video.pause(); setPaused(true); }
  };
  return <figure className={`land-film ${className}`.trim()}>
    <video ref={videoRef} autoPlay={!paused} muted loop playsInline preload="metadata" poster={poster} aria-label={label} onPlay={() => setPaused(false)} onPause={() => setPaused(true)}>
      <source src={src} type="video/mp4" />
    </video>
    <button type="button" className="film-control" onClick={toggle} aria-label={paused ? `${label} afspelen` : `${label} pauzeren`}>
      {paused ? <Play aria-hidden="true" fill="currentColor" /> : <Pause aria-hidden="true" fill="currentColor" />}
      <span>{paused ? 'Afspelen' : 'Pauze'}</span>
    </button>
  </figure>;
}

function LandFilms() {
  return <section className="land-films section" aria-labelledby="films-title">
    <div className="motion-heading"><div><p className="eyebrow light">VAN HET LAND</p><h2 id="films-title">De plek<br /><em>in beweging.</em></h2></div><p>Een korte blik over het erf. Stil afgespeeld, zonder afleiding—precies zoals het land op dat moment was.</p></div>
    <div className="motion-grid">
      <LandVideo className="landscape" src="/videos/optimized/land-video-02.mp4" poster="/videos/optimized/land-video-02-poster.jpg" label="Brede blik door de boomgaard van Land van Jan" />
    </div>
  </section>;
}

function EditorialPage({ path, content, navigate, member, openLogin, setNotice }) {
  return <>
    <section className="page-hero" aria-labelledby="page-title">
      <LandImage imageKey={content.hero} eager sizes="100vw" />
      <div className="page-hero-shade" />
      <div className="page-hero-copy"><p className="eyebrow light">{content.eyebrow}</p><h1 id="page-title">{content.title}</h1><p>{content.text}</p>
        {path === '/contact' && <a className="button" href="#contact-form">Stuur een bericht <span aria-hidden="true">→</span></a>}
        {path === '/lid-worden' && <button className="button" type="button" onClick={() => member ? navigate('/leden') : openLogin('register')}>{member ? 'Naar mijn lidmaatschap' : 'Maak een account'} <span aria-hidden="true">→</span></button>}
        {!['/contact', '/lid-worden', '/agenda'].includes(path) && <AppLink to="/contact" navigate={navigate} className="button">Neem contact op <span aria-hidden="true">→</span></AppLink>}
      </div>
    </section>
    {path === '/agenda' && <ActivityFeed member={member} openLogin={openLogin} navigate={navigate} />}
    <section className="page-story section">
      <div><p className="eyebrow">{content.eyebrow}</p><h2>{content.heading}</h2><p>{content.body}</p><ul>{content.points.map((point) => <li key={point}>{point}</li>)}</ul></div>
      <figure><LandImage imageKey={content.detail} sizes="(max-width: 800px) 100vw, 55vw" /></figure>
    </section>
    {path === '/contact' && <ContactForm navigate={navigate} setNotice={setNotice} />}
    <PageGallery content={content} />
    <section className="page-quote"><p>“{content.quote}”</p><span>LAND VAN JAN · HUISSEN</span></section>
  </>;
}

function PageGallery({ content }) {
  return <section className="page-gallery section" aria-labelledby="gallery-title">
    <div className="section-intro"><div><p className="eyebrow">VAN HET LAND</p><h2 id="gallery-title">Ruimte voor<br /><em>wat ontstaat.</em></h2></div><p>Elk seizoen laat een andere kant van de plek zien: buiten werken, iets maken, samenkomen en weer verder groeien.</p></div>
    <div className="gallery-grid">{content.gallery.map((image, index) => <figure key={`${image}-${index}`}><LandImage imageKey={image} sizes="(max-width: 800px) 100vw, 34vw" /><figcaption>{content.labels[index]}</figcaption></figure>)}</div>
  </section>;
}

function formatActivity(activity) {
  const start = new Date(activity.startsAt);
  const end = new Date(activity.endsAt);
  if (Number.isNaN(start.getTime())) return { day: 'DATUM', date: '—', month: '', time: 'Tijd volgt' };
  const day = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', timeZone: ACTIVITY_TIME_ZONE }).format(start).replace('.', '').toUpperCase();
  const date = new Intl.DateTimeFormat('nl-NL', { day: '2-digit', timeZone: ACTIVITY_TIME_ZONE }).format(start);
  const month = new Intl.DateTimeFormat('nl-NL', { month: 'short', timeZone: ACTIVITY_TIME_ZONE }).format(start).replace('.', '').toUpperCase();
  const startTime = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: ACTIVITY_TIME_ZONE }).format(start);
  const endTime = Number.isNaN(end.getTime()) ? '' : new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: ACTIVITY_TIME_ZONE }).format(end);
  return { day, date, month, time: endTime ? `${startTime} – ${endTime}` : startTime };
}

function formatActivityDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Datum volgt';
  return new Intl.DateTimeFormat('nl-NL', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: ACTIVITY_TIME_ZONE,
  }).format(date);
}

function ActivityFeed({ compact = false, member, openLogin, navigate }) {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');
  const [registered, setRegistered] = useState(new Set());
  const load = async () => {
    try {
      const data = await api('/api/activities');
      setItems((data.activities || []).filter((item) => item.status === 'published').slice(0, compact ? 3 : 100));
      setStatus('ready');
    } catch { setStatus('offline'); }
  };
  useEffect(() => { load(); }, [compact]);
  useEffect(() => {
    if (!member) { setRegistered(new Set()); return; }
    api('/api/member/registrations').then((data) => setRegistered(new Set((data.registrations || []).map((item) => item.activity?.id).filter(Boolean)))).catch(() => setRegistered(new Set()));
  }, [member]);
  const toggleRegistration = async (activity) => {
    if (!member) return openLogin('login');
    setMessage('');
    const isRegistered = registered.has(activity.id);
    try {
      await api(`/api/activities/${activity.id}/register`, { method: isRegistered ? 'DELETE' : 'POST' });
      setRegistered((current) => {
        const next = new Set(current);
        if (isRegistered) next.delete(activity.id); else next.add(activity.id);
        return next;
      });
      setMessage(isRegistered ? 'Je aanmelding is geannuleerd.' : 'Je bent aangemeld. Tot op het land.');
      load();
    } catch (error) { setMessage(error.message); }
  };
  return <section className={`programme section ${compact ? 'programme-home' : ''}`} aria-labelledby={compact ? 'home-agenda-title' : 'agenda-list-title'}>
    <div className="section-intro"><p className="eyebrow">AGENDA</p><h2 id={compact ? 'home-agenda-title' : 'agenda-list-title'}>{compact ? <>Wat er de komende<br />tijd te doen is.</> : <>Doe mee op<br />jouw manier.</>}</h2></div>
    {message && <p className="form-status" role="status">{message}</p>}
    {status === 'loading' && <DashboardLoading label="Agenda laden…" />}
    {status === 'offline' && <div className="empty-state"><h3>De live agenda is even niet bereikbaar.</h3><p>Probeer het later opnieuw of neem contact op voor de eerstvolgende activiteit.</p><AppLink to="/contact" navigate={navigate} className="text-link">Neem contact op <span aria-hidden="true">→</span></AppLink></div>}
    {status === 'ready' && !items.length && <div className="empty-state"><h3>Nieuwe momenten volgen binnenkort.</h3><p>Het programma beweegt mee met het seizoen. Laat een bericht achter als je op de hoogte wilt blijven.</p><AppLink to="/contact" navigate={navigate} className="text-link">Laat van je horen <span aria-hidden="true">→</span></AppLink></div>}
    {status === 'ready' && Boolean(items.length) && <div className="activity-list">{items.map((activity) => {
      const display = formatActivity(activity);
      const isRegistered = registered.has(activity.id);
      const full = Number(activity.registeredCount || 0) >= Number(activity.capacity || Infinity);
      return <article className={`activity activity-${activity.accentColor || 'green'} align-${activity.textAlign || 'left'}`} key={activity.id}>
        <div className="date"><span>{display.day}</span><strong>{display.date}</strong><span>{display.month}</span></div>
        <p className="time">{display.time}</p>
        <div className="activity-copy">{activity.imageUrl && <img className="activity-media" src={activity.imageUrl} alt="" loading="lazy" />}{activity.videoUrl && <video className="activity-media" src={activity.videoUrl} controls preload="metadata" playsInline />}<h3>{activity.title}</h3><p>{activity.description}</p><small>{activity.location}{activity.source === 'hipsy' ? ' · via Hipsy' : activity.capacity ? ` · ${Math.max(0, activity.capacity - (activity.registeredCount || 0))} plekken vrij` : ''}</small></div>
        {activity.ticketUrl ? <a className="text-button" href={activity.ticketUrl} target="_blank" rel="noreferrer">Tickets <span aria-hidden="true">→</span></a> : <button className="text-button" type="button" disabled={full && !isRegistered} onClick={() => toggleRegistration(activity)}>{isRegistered ? 'Afmelden' : full ? 'Vol' : member ? 'Aanmelden' : 'Log in'} <span aria-hidden="true">→</span></button>}
      </article>;
    })}</div>}
    {!compact && <a className="underlined calendar-link" href="/api/calendar.ics">Abonneer op de kalender <span aria-hidden="true">↗</span></a>}
    {compact && <AppLink to="/agenda" navigate={navigate} className="underlined">Bekijk volledig overzicht <span aria-hidden="true">→</span></AppLink>}
  </section>;
}

function ContactForm({ navigate, setNotice }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const submit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true); setStatus('');
    try {
      await api('/api/contact', { method: 'POST', body: JSON.stringify({
        name: data.get('name'), email: data.get('email'), subject: data.get('subject'), message: data.get('message'),
        privacyAccepted: data.get('privacyAccepted') === 'on', privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        website: data.get('website'),
      }) });
      form.reset();
      setStatus('Bedankt. Je bericht is veilig ontvangen.');
      setNotice('Je bericht is ontvangen.');
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  };
  return <section id="contact-form" className="contact-section section" aria-labelledby="contact-form-title">
    <div><p className="eyebrow light">LAAT VAN JE HOREN</p><h2 id="contact-form-title">Begin met<br /><em>een bericht.</em></h2><p>We gebruiken je gegevens alleen om op dit bericht te reageren. Er staan geen marketingcookies op deze site.</p></div>
    <form onSubmit={submit}>
      <div className="form-row"><label>Naam<input name="name" autoComplete="name" maxLength="80" required /></label><label>E-mailadres<input name="email" type="email" autoComplete="email" maxLength="254" required /></label></div>
      <label>Waar gaat je bericht over?<input name="subject" maxLength="160" required /></label>
      <label>Bericht<textarea name="message" rows="6" maxLength="5000" required /></label>
      <label className="honeypot" aria-hidden="true">Website<input name="website" tabIndex="-1" autoComplete="off" /></label>
      <label className="check-label"><input name="privacyAccepted" type="checkbox" required /><span>Ik heb de <AppLink to="/privacy" navigate={navigate}>privacyverklaring</AppLink> gelezen en begrijp hoe mijn bericht wordt verwerkt.</span></label>
      {status && <p className="form-status" role="status">{status}</p>}
      <button className="button" type="submit" disabled={busy}>{busy ? 'Versturen…' : 'Verstuur bericht'} <span aria-hidden="true">→</span></button>
    </form>
  </section>;
}

function ProtectedGate({ openLogin, admin = false }) {
  return <section className="dashboard-gate"><p className="eyebrow">{admin ? 'BEHEER' : 'LEDENOMGEVING'}</p><h1>{admin ? <>Beheer begint<br /><em>met inloggen.</em></> : <>Je eigen<br /><em>plek op het land.</em></>}</h1><p>Log in met je beveiligde account om deze omgeving te openen.</p><button className="button" type="button" onClick={() => openLogin('login')}>Inloggen <span aria-hidden="true">→</span></button></section>;
}

function MemberDashboard({ member, setMember, logout, setNotice, navigate }) {
  const [paymentReturn] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('betaling');
    return value === 'geslaagd' || value === 'geannuleerd' ? value : '';
  });
  const [profile, setProfile] = useState(null);
  const [registrations, setRegistrations] = useState([]);
  const [setup, setSetup] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [paymentReconciliation, setPaymentReconciliation] = useState(paymentReturn === 'geslaagd' ? 'checking' : paymentReturn === 'geannuleerd' ? 'cancelled' : 'idle');
  const load = async () => {
    setState('loading');
    try {
      const [profileData, registrationData, setupData] = await Promise.all([
        api('/api/member/profile'), api('/api/member/registrations'), api('/api/setup/status').catch(() => ({ billing: 'not_configured' })),
      ]);
      setProfile(profileData.profile);
      setRegistrations(registrationData.registrations || []);
      setSetup(setupData);
      setState('ready');
    } catch (loadError) { setError(loadError.message); setState('error'); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!paymentReturn) return undefined;
    const params = new URLSearchParams(window.location.search);
    params.delete('betaling');
    const search = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);

    if (paymentReturn === 'geannuleerd') {
      setMessage('De betaling is geannuleerd. Er is niets afgeschreven en je kunt later opnieuw beginnen.');
      return undefined;
    }

    let active = true;
    let timer = null;
    setMessage('Betaling gelukt. We controleren nu je lidmaatschap; dit duurt meestal maar enkele seconden.');

    const pollProfile = async (attempt) => {
      if (!active) return;
      try {
        const profileData = await api('/api/member/profile');
        if (!active) return;
        setProfile(profileData.profile);
        if (PORTAL_MEMBERSHIP_STATUSES.has(profileData.profile?.membershipStatus)) {
          setPaymentReconciliation('confirmed');
          setMessage('Je betaling is bevestigd en je lidmaatschap is bijgewerkt.');
          return;
        }
      } catch {
        // A short transient API failure should not turn a successful Stripe return into an error state.
      }

      if (attempt >= PAYMENT_RECONCILE_DELAYS_MS.length - 1) {
        setPaymentReconciliation('pending');
        setMessage('Je betaling is gelukt en wordt nog verwerkt. Start geen tweede betaling; controleer de status over enkele ogenblikken.');
        return;
      }
      timer = window.setTimeout(() => pollProfile(attempt + 1), PAYMENT_RECONCILE_DELAYS_MS[attempt + 1]);
    };

    pollProfile(0);
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [paymentReturn]);

  const refreshPaymentStatus = async () => {
    setPaymentReconciliation('checking');
    setMessage('We controleren je betaalstatus opnieuw…');
    try {
      const profileData = await api('/api/member/profile');
      setProfile(profileData.profile);
      if (PORTAL_MEMBERSHIP_STATUSES.has(profileData.profile?.membershipStatus)) {
        setPaymentReconciliation('confirmed');
        setMessage('Je betaling is bevestigd en je lidmaatschap is bijgewerkt.');
      } else {
        setPaymentReconciliation('pending');
        setMessage('Stripe verwerkt je betaling nog. Start geen tweede betaling en probeer de status over enkele ogenblikken opnieuw.');
      }
    } catch (refreshError) {
      setPaymentReconciliation('pending');
      setMessage(`De betaalstatus kon nog niet worden opgehaald. ${refreshError.message}`);
    }
  };
  const manageMembership = async () => {
    setBusy('billing'); setMessage('');
    try {
      const usePortal = PORTAL_MEMBERSHIP_STATUSES.has(profile?.membershipStatus);
      const data = await api(usePortal ? '/api/billing/portal' : '/api/billing/checkout', { method: 'POST', body: '{}' });
      window.location.assign(data.portalUrl || data.checkoutUrl);
    } catch (billingError) { setMessage(billingError.message); setBusy(''); }
  };
  const updateProfile = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy('profile'); setMessage('');
    try {
      const result = await api('/api/member/profile', { method: 'PATCH', body: JSON.stringify({
        name: data.get('name'),
        marketingConsent: data.get('marketingConsent') === 'on',
        marketingConsentVersion: MARKETING_CONSENT_VERSION,
      }) });
      setProfile(result.profile); setMember(result.profile); setMessage('Je voorkeuren zijn opgeslagen.');
    } catch (updateError) { setMessage(updateError.message); }
    finally { setBusy(''); }
  };
  const cancelRegistration = async (activityId) => {
    setBusy(activityId); setMessage('');
    try { await api(`/api/activities/${activityId}/register`, { method: 'DELETE' }); setMessage('Je aanmelding is geannuleerd.'); await load(); }
    catch (cancelError) { setMessage(cancelError.message); }
    finally { setBusy(''); }
  };
  const deleteAccount = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const confirmation = data.get('confirmation');
    const password = data.get('password');
    setBusy('delete'); setMessage('');
    try { await api('/api/member/account', { method: 'DELETE', body: JSON.stringify({ confirmation, password }) }); setMember(null); navigate('/'); setNotice('Je account en bijbehorende gegevens zijn verwijderd.'); }
    catch (deleteError) { setMessage(deleteError.message); setBusy(''); }
  };
  const billingReady = BILLING_READY_STATES.has(setup?.billing);
  const useBillingPortal = PORTAL_MEMBERSHIP_STATUSES.has(profile?.membershipStatus);
  const paymentNeedsReconciliation = paymentReconciliation === 'checking' || paymentReconciliation === 'pending';
  const membershipActionLabel = paymentReconciliation === 'checking'
    ? 'Betaalstatus controleren…'
    : paymentReconciliation === 'pending'
      ? 'Controleer betaalstatus'
      : useBillingPortal ? 'Beheer lidmaatschap' : 'Start lidmaatschap';
  return <section className="dashboard-content">
    <div className="dashboard-kicker"><p className="eyebrow">LEDENOMGEVING</p><span>Beveiligde sessie</span></div>
    <div className="dashboard-title-row"><h1>Welkom,<br /><em>{member.name || 'lid'}.</em></h1><div>{member.role === 'admin' && <AppLink to="/beheer" navigate={navigate} className="text-link">Open beheer <span aria-hidden="true">→</span></AppLink>}<button type="button" className="text-button" onClick={logout}>Uitloggen <span aria-hidden="true">→</span></button></div></div>
    {state === 'loading' && <DashboardLoading />}
    {state === 'error' && <DashboardError message={error} />}
    {state === 'ready' && <>
      {message && <p className="form-status" role="status">{message}</p>}
      <div className="dashboard-grid">
        <article><p className="eyebrow">JOUW PROFIEL</p><h2>{profile.name}</h2><p>{profile.email}</p><span className="privacy-note">Alleen zichtbaar voor jou en beheerders.</span></article>
        <article><p className="eyebrow">LIDMAATSCHAP</p><h2>{STATUS_LABELS[profile.membershipStatus] || profile.membershipStatus}</h2><p>{paymentNeedsReconciliation ? 'Stripe rondt je betaling af. Je hoeft niet opnieuw te betalen.' : billingReady ? 'Beheer je maandelijkse bijdrage veilig via Stripe.' : 'De betaalomgeving wacht nog op de veilige Stripe-configuratie.'}</p><button className="text-button" type="button" onClick={paymentNeedsReconciliation ? refreshPaymentStatus : manageMembership} disabled={busy === 'billing' || paymentReconciliation === 'checking' || !billingReady}>{busy === 'billing' ? 'Even wachten…' : membershipActionLabel} <span aria-hidden="true">→</span></button></article>
        <article><p className="eyebrow">PRIVACY</p><h2>{profile.marketingConsent ? 'Updates aan' : 'Updates uit'}</h2><p>Je kunt toestemming op ieder moment wijzigen.</p></article>
      </div>
      <section className="settings-panel"><div><p className="eyebrow">PROFIEL & VOORKEUREN</p><h2>Houd het<br /><em>persoonlijk.</em></h2></div><form onSubmit={updateProfile}><label>Naam<input name="name" defaultValue={profile.name} maxLength="80" required /></label><label className="check-label"><input name="marketingConsent" type="checkbox" defaultChecked={Boolean(profile.marketingConsent)} /><span>Ik wil incidentele updates en uitnodigingen per e-mail ontvangen.</span></label><button className="button" disabled={busy === 'profile'}>{busy === 'profile' ? 'Opslaan…' : 'Voorkeuren opslaan'}</button></form></section>
      <section className="dashboard-agenda"><div><p className="eyebrow">JOUW AANMELDINGEN</p><h2>Op het land.</h2></div><div>{registrations.length ? registrations.map((item) => <article key={item.id}><b>{formatActivity(item.activity).date} {formatActivity(item.activity).month}</b><span>{item.activity.title}<small>{item.activity.location}</small></span><button type="button" className="text-button" disabled={busy === item.activity.id} onClick={() => cancelRegistration(item.activity.id)}>Afmelden</button></article>) : <p className="empty-copy">Je hebt nog geen komende aanmeldingen. <AppLink to="/agenda" navigate={navigate}>Bekijk de agenda.</AppLink></p>}</div></section>
      <details className="danger-zone"><summary>Account en gegevens verwijderen</summary><div><p>Dit verwijdert je account, actieve sessies en aanmeldingen. Een Stripe-lidmaatschap moet je eerst via het betaalportaal beëindigen.</p><form onSubmit={deleteAccount}><label>Huidig wachtwoord<input name="password" type="password" autoComplete="current-password" minLength="12" maxLength="128" required /></label><label>Typ exact VERWIJDER om te bevestigen<input name="confirmation" required pattern="VERWIJDER" autoComplete="off" autoCapitalize="none" /></label><button type="submit" className="danger-button" disabled={busy === 'delete'}>{busy === 'delete' ? 'Verwijderen…' : 'Verwijder mijn account'}</button></form></div></details>
    </>}
  </section>;
}

const EMPTY_ACTIVITY = { id: '', title: '', description: '', location: 'Land van Jan, Huissen', startsAt: '', endsAt: '', capacity: 12, status: 'draft', accentColor: 'green', textAlign: 'left', imageUrl: '', videoUrl: '' };

function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: ACTIVITY_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function AdminDashboard({ member }) {
  const authorized = member.role === 'admin';
  const [members, setMembers] = useState([]);
  const [activities, setActivities] = useState([]);
  const [messages, setMessages] = useState([]);
  const [setup, setSetup] = useState(null);
  const [hipsy, setHipsy] = useState(null);
  const [editing, setEditing] = useState(EMPTY_ACTIVITY);
  const [attendees, setAttendees] = useState(null);
  const [state, setState] = useState('loading');
  const [notice, setNotice] = useState('');
  const load = async () => {
    setState('loading');
    const results = await Promise.allSettled([
      api('/api/admin/members'), api('/api/admin/activities'), api('/api/admin/contact-messages'), api('/api/setup/status'), api('/api/admin/hipsy/status'),
    ]);
    if (results[0].status === 'rejected' || results[1].status === 'rejected') { setNotice(results.find((item) => item.status === 'rejected')?.reason?.message || 'Beheer kon niet laden.'); setState('error'); return; }
    setMembers(results[0].value.members || []);
    setActivities(results[1].value.activities || []);
    setMessages(results[2].status === 'fulfilled' ? results[2].value.messages || [] : []);
    setSetup(results[3].status === 'fulfilled' ? results[3].value : null);
    setHipsy(results[4].status === 'fulfilled' ? results[4].value : null);
    setState('ready');
  };
  useEffect(() => { if (authorized) load(); }, [authorized]);
  const saveActivity = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = {
      title: data.get('title'), description: data.get('description'), location: data.get('location'),
      startsAt: data.get('startsAt'), endsAt: data.get('endsAt'),
      capacity: Number(data.get('capacity')), status: data.get('status'), accentColor: data.get('accentColor'), textAlign: data.get('textAlign'),
      imageUrl: data.get('imageUrl'), videoUrl: data.get('videoUrl'),
    };
    setNotice('Opslaan…');
    try {
      await api(editing.id ? `/api/admin/activities/${editing.id}` : '/api/admin/activities', { method: editing.id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      setEditing(EMPTY_ACTIVITY); setNotice(editing.id ? 'Activiteit bijgewerkt.' : 'Activiteit aangemaakt.'); await load();
    } catch (error) { setNotice(error.message); }
  };
  const syncHipsy = async () => {
    setNotice('Hipsy-agenda synchroniseren…');
    try { const result = await api('/api/admin/hipsy/sync', { method: 'POST' }); setNotice(`${result.imported} Hipsy-activiteiten gesynchroniseerd.`); await load(); }
    catch (error) { setNotice(error.message); }
  };
  const showAttendees = async (activity) => {
    setNotice('');
    try { const data = await api(`/api/admin/activities/${activity.id}/registrations`); setAttendees({ activity, rows: data.registrations || [] }); }
    catch (error) { setNotice(error.message); }
  };
  const transferAdmin = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setNotice('Beheer veilig overdragen…');
    try {
      const result = await api('/api/admin/transfer', {
        method: 'POST',
        body: JSON.stringify({ email: data.get('email'), password: data.get('password'), confirmation: data.get('confirmation') }),
      });
      form.reset();
      setNotice(`${result.member.name || result.member.email} is nu ook beheerder. Je kunt je eigen account daarna veilig verwijderen.`);
      await load();
    } catch (error) { setNotice(error.message); }
  };
  if (!authorized) return <section className="dashboard-gate"><p className="eyebrow">BEHEER</p><h1>Geen toegang.</h1><p>Deze omgeving is alleen beschikbaar voor geautoriseerde beheerders.</p></section>;
  return <section className="dashboard-content admin-dashboard">
    <div className="dashboard-kicker"><p className="eyebrow">BEHEERDERSOMGEVING</p><span>Privé · server-side autorisatie</span></div><h1>Leden &<br /><em>activiteiten.</em></h1>
    {notice && <p className="form-status" role="status">{notice}</p>}
    {state === 'loading' && <DashboardLoading />}{state === 'error' && <DashboardError message={notice} />}
    {state === 'ready' && <>
      <section className="admin-stats"><article><b>{members.length}</b><span>leden</span></article><article><b>{activities.filter((item) => item.status === 'published').length}</b><span>gepubliceerde activiteiten</span></article><article><b>{messages.length}</b><span>contactberichten</span></article><article><b>{BILLING_READY_STATES.has(setup?.billing) ? 'Gereed' : 'Actie'}</b><span>betaalconfiguratie</span></article></section>
      <section className="calendar-integration"><div><p className="eyebrow">KALENDERKOPPELING</p><h2>Hipsy & iCal</h2><p>{hipsy?.state === 'ready' ? 'Hipsy is gekoppeld en wordt automatisch bijgewerkt.' : hipsy?.state === 'not_configured' ? 'Zet één keer HIPSY_API_KEY in Railway om Hipsy automatisch te koppelen.' : 'De koppeling wordt voorbereid.'}</p></div><div><button className="button" type="button" onClick={syncHipsy} disabled={hipsy?.state === 'not_configured'}>Nu synchroniseren</button><a className="text-link" href="/api/calendar.ics">Open iCal-feed →</a></div></section>
      <section className="manager-grid">
        <form className="manager-form" onSubmit={saveActivity} key={editing.id || 'new'}>
          <div className="table-title"><h2>{editing.id ? 'Activiteit bewerken' : 'Nieuwe activiteit'}</h2>{editing.id && <button className="text-button" type="button" onClick={() => setEditing(EMPTY_ACTIVITY)}>Annuleren</button>}</div>
          <label>Titel<input name="title" defaultValue={editing.title} maxLength="160" required /></label>
          <label>Locatie<input name="location" defaultValue={editing.location} maxLength="180" required /></label>
          <div className="form-row"><label>Start<input name="startsAt" type="datetime-local" defaultValue={toLocalInput(editing.startsAt)} required /></label><label>Einde<input name="endsAt" type="datetime-local" defaultValue={toLocalInput(editing.endsAt)} required /></label></div>
          <div className="form-row"><label>Capaciteit<input name="capacity" type="number" min="1" max="10000" defaultValue={editing.capacity} required /></label><label>Status<select name="status" defaultValue={editing.status}><option value="draft">Concept</option><option value="published">Gepubliceerd</option><option value="cancelled">Geannuleerd</option></select></label></div>
          <div className="form-row"><label>Kleur<select name="accentColor" defaultValue={editing.accentColor || 'green'}><option value="green">Landgroen</option><option value="rust">Terracotta</option><option value="sand">Zand</option><option value="gold">Goud</option><option value="plum">Pruim</option></select></label><label>Tekst<select name="textAlign" defaultValue={editing.textAlign || 'left'}><option value="left">Links</option><option value="center">Gecentreerd</option></select></label></div>
          <label>Beschrijving<textarea name="description" rows="10" maxLength="10000" defaultValue={editing.description} required /><small>Gebruik witregels om de tekst rustig op te delen.</small></label>
          <div className="media-fields"><label>Foto-URL<input name="imageUrl" type="url" defaultValue={editing.imageUrl || ''} placeholder="https://…" /></label><label>Video-URL<input name="videoUrl" type="url" defaultValue={editing.videoUrl || ''} placeholder="https://…" /></label><p>Gebruik permanente https-links. Foto's worden responsive gecropt; video krijgt alleen nette afspeelbediening.</p></div>
          <button className="button" type="submit">{editing.id ? 'Wijzigingen opslaan' : 'Activiteit maken'} <span aria-hidden="true">→</span></button>
        </form>
        <div className="manager-list"><h2>Bestaande activiteiten</h2>{activities.length ? activities.map((item) => <article key={item.id}><div><b>{item.title}</b><span>{formatActivityDateTime(item.startsAt)} · {item.registeredCount}/{item.capacity} · {item.status}</span></div><div><button className="text-button" type="button" onClick={() => setEditing(item)}>Bewerk</button><button className="text-button" type="button" onClick={() => showAttendees(item)}>Deelnemers</button></div></article>) : <p className="empty-copy">Nog geen activiteiten aangemaakt.</p>}</div>
      </section>
      {attendees && <section className="attendee-list"><div className="table-title"><div><p className="eyebrow">DEELNEMERS</p><h2>{attendees.activity.title}</h2></div><button className="text-button" type="button" onClick={() => setAttendees(null)}>Sluiten</button></div>{attendees.rows.length ? attendees.rows.map((row) => <article key={row.id}><b>{row.member.name}</b><span>{row.member.email}</span><small>{new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium' }).format(new Date(row.createdAt))}</small></article>) : <p className="empty-copy">Nog geen deelnemers.</p>}</section>}
      <section className="member-table"><div className="table-title"><div><p className="eyebrow">LEDEN</p><h2>Minimale gegevens</h2></div><p>Wachtwoorden en betaalgegevens worden nooit getoond.</p></div><div className="table-wrap"><table><thead><tr><th>Naam</th><th>E-mail</th><th>Updates</th><th>Lidmaatschap</th><th>Rol</th></tr></thead><tbody>{members.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.email}</td><td>{item.marketingConsent ? 'Ja' : 'Nee'}</td><td>{STATUS_LABELS[item.membershipStatus] || item.membershipStatus}</td><td>{item.role}</td></tr>)}</tbody></table></div></section>
      <section className="admin-transfer"><div className="table-title"><div><p className="eyebrow">BEHEER OVERDRAGEN</p><h2>Wijs een tweede beheerder aan</h2></div><p>De nieuwe beheerder moet eerst zelf een ledenaccount maken. Je huidige wachtwoord en de exacte bevestiging voorkomen een onbedoelde overdracht.</p></div><form className="manager-form" onSubmit={transferAdmin}><label>E-mailadres nieuwe beheerder<input name="email" type="email" autoComplete="off" maxLength="254" required /></label><label>Jouw huidige wachtwoord<input name="password" type="password" autoComplete="current-password" minLength="12" maxLength="128" required /></label><label>Typ BEHEER OVERDRAGEN<input name="confirmation" autoComplete="off" pattern="BEHEER OVERDRAGEN" required /></label><button className="button" type="submit">Maak beheerder <span aria-hidden="true">→</span></button></form></section>
      <section className="message-list"><div className="table-title"><div><p className="eyebrow">CONTACT</p><h2>Recente berichten</h2></div><p>Automatische verwijdering na de bewaartermijn.</p></div>{messages.length ? messages.map((item) => <article key={item.id}><div><b>{item.subject}</b><span>{item.name} · {item.email}</span></div><p>{item.message}</p><small>{new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))}</small></article>) : <p className="empty-copy">Geen openstaande berichten.</p>}</section>
    </>}
  </section>;
}

function LoginModal({ initialMode, close, onAuthenticated, navigate }) {
  const [mode, setMode] = useState(initialMode);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const panelRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const inertTargets = [...document.querySelectorAll('.site-header, #main-content, .site-footer')]
      .filter((element) => !element.hasAttribute('inert'));
    inertTargets.forEach((element) => element.setAttribute('inert', ''));
    const onKey = (event) => {
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const controls = [...(panelRef.current?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled])') || [])];
        if (!controls.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    panelRef.current?.querySelector('input')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      inertTargets.forEach((element) => element.removeAttribute('inert'));
      previous?.focus?.();
    };
  }, [close]);
  const submit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setStatus('');
    try {
      const payload = mode === 'register'
        ? {
          name: data.get('name'), email: data.get('email'), password: data.get('password'),
          privacyAccepted: data.get('privacyAccepted') === 'on', privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
          marketingConsent: data.get('marketingConsent') === 'on', marketingConsentVersion: MARKETING_CONSENT_VERSION,
        }
        : { email: data.get('email'), password: data.get('password') };
      const result = await api(mode === 'register' ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
      onAuthenticated(result.user);
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={close}><section ref={panelRef} className="login-panel" role="dialog" aria-modal="true" aria-labelledby="login-title" onMouseDown={(event) => event.stopPropagation()}>
    <button className="close" aria-label="Sluiten" type="button" onClick={close}>×</button><p className="eyebrow">LEDENOMGEVING</p>
    <div className="login-tabs" role="tablist" aria-label="Accounttoegang"><button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setStatus(''); }}>Inloggen</button><button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'selected' : ''} onClick={() => { setMode('register'); setStatus(''); }}>Account maken</button></div>
    <h2 id="login-title">{mode === 'login' ? 'Welkom terug.' : 'Sluit je aan.'}</h2><p>{mode === 'login' ? 'Log in om je profiel, lidmaatschap en activiteiten te beheren.' : 'Maak een beveiligd account. Betalen gebeurt daarna rechtstreeks bij Stripe.'}</p>
    {mode === 'login' && <><a className="google-login" href="/api/auth/google/start"><svg aria-hidden="true" viewBox="0 0 24 24"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.41Z"/><path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.36l-3.24-2.54c-.9.6-2.05.96-3.38.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.39 13.93A6.02 6.02 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.45H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.55l3.35-2.62Z"/><path fill="#EA4335" d="M12 5.94c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.65 9.65 0 0 0 12 2a10 10 0 0 0-8.96 5.45l3.35 2.62C7.18 7.7 9.39 5.94 12 5.94Z"/></svg><span>Doorgaan met Google</span></a><div className="login-divider"><span>of met e-mail</span></div></>}
    <form onSubmit={submit}>{mode === 'register' && <label>Naam<input name="name" autoComplete="name" maxLength="80" required /></label>}<label>E-mailadres<input name="email" type="email" autoComplete="email" maxLength="254" required /></label><label>Wachtwoord<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength="12" maxLength="128" required /><small>Minimaal 12 tekens.</small></label>{mode === 'register' && <><label className="check-label"><input name="privacyAccepted" type="checkbox" required /><span>Ik heb de <AppLink to="/privacy" navigate={navigate} onClick={close}>privacyverklaring</AppLink> gelezen.</span></label><label className="check-label"><input name="marketingConsent" type="checkbox" /><span>Ik wil incidentele updates en uitnodigingen per e-mail ontvangen (optioneel).</span></label></>}{status && <p className="form-status" role="alert">{status}</p>}<button className="button" type="submit" disabled={busy}>{busy ? 'Even wachten…' : mode === 'login' ? 'Inloggen' : 'Account maken'} <span aria-hidden="true">→</span></button></form>
  </section></div>;
}

function PrivacyPage({ navigate }) {
  return <article className="legal-page"><header><p className="eyebrow">PRIVACY</p><h1>Zorgvuldig met<br /><em>jouw gegevens.</em></h1><p>Deze verklaring beschrijft welke gegevens Land van Jan gebruikt, waarom dat nodig is en welke keuzes je hebt. Laatst bijgewerkt: 2 augustus 2026.</p></header>
    <div className="legal-grid"><nav aria-label="Privacyonderwerpen"><a href="#verantwoordelijke">Verantwoordelijke</a><a href="#gegevens">Welke gegevens</a><a href="#doelen">Doelen en grondslagen</a><a href="#bewaren">Bewaren</a><a href="#partijen">Dienstverleners</a><a href="#rechten">Jouw rechten</a></nav><div>
      <section id="verantwoordelijke"><h2>Verantwoordelijke</h2><p>Land van Jan in Huissen is de verwerkingsverantwoordelijke voor de persoonsgegevens die via deze website worden verwerkt. Voor privacyvragen of een verzoek kun je het beveiligde contactformulier gebruiken.</p></section>
      <section id="gegevens"><h2>Welke gegevens</h2><p>Voor een ledenaccount verwerken we naam, e-mailadres, een veilig gehashte wachtwoordrepresentatie, sessies, voorkeuren, lidmaatschapsstatus en aanmeldingen. Bij een contactbericht verwerken we naam, e-mailadres, onderwerp en bericht. Stripe verwerkt betaalgegevens voor lidmaatschappen en eenmalige donaties; Land van Jan ontvangt alleen noodzakelijke klant-, betaal-, abonnements- en statusreferenties.</p></section>
      <section id="doelen"><h2>Doelen en grondslagen</h2><p>Account-, leden- en aanmeldgegevens zijn nodig om de ledenovereenkomst en activiteiten uit te voeren. Beveiligingslogs en fraudepreventie steunen op een gerechtvaardigd belang. Marketingupdates worden alleen verstuurd na afzonderlijke, intrekbare toestemming. Contactgegevens gebruiken we uitsluitend om te reageren op je verzoek.</p></section>
      <section id="bewaren"><h2>Bewaartermijnen</h2><p>Sessies verlopen uiterlijk na veertien dagen. Contactberichten worden maximaal 180 dagen bewaard. Activiteitsaanmeldingen worden uiterlijk één jaar na afloop van de activiteit verwijderd. Stripe-webhookregistraties worden na negentig dagen verwijderd en beveiligings- en auditregistraties na maximaal 400 dagen. Je account blijft bestaan totdat je het zelf verwijdert of verwijdering verzoekt.</p></section>
      <section id="partijen"><h2>Dienstverleners</h2><p>De site draait bij Railway, de database bij MongoDB en betalingen lopen via Stripe. Deze partijen verwerken alleen gegevens die nodig zijn voor hun dienst. Er worden geen tijdelijke foto- of privébibliotheeklinks gebruikt: de zichtbare landfoto’s zijn beheerde site-assets.</p></section>
      <section><h2>Cookies en beveiliging</h2><p>De site gebruikt alleen een strikt noodzakelijke, HttpOnly sessiecookie voor ingelogde leden. Er zijn geen advertentie- of trackingcookies. Verkeer loopt via HTTPS; wachtwoorden worden met scrypt en unieke salts gehasht. Beheertoegang wordt ook server-side gecontroleerd.</p></section>
      <section id="rechten"><h2>Jouw rechten</h2><p>Je kunt vragen om inzage, verbetering, verwijdering, beperking van de verwerking en overdraagbaarheid van je gegevens. Je kunt bezwaar maken tegen een verwerking op basis van een gerechtvaardigd belang en eerder gegeven toestemming altijd intrekken. Profiel, marketingtoestemming en accountverwijdering zijn beschikbaar in de ledenomgeving. Voor andere verzoeken kun je het beveiligde contactformulier gebruiken. Ben je niet tevreden over de afhandeling, dan kun je een klacht indienen bij de Autoriteit Persoonsgegevens.</p><AppLink to="/contact" navigate={navigate} className="button">Gebruik het contactformulier <span aria-hidden="true">→</span></AppLink></section>
    </div></div>
  </article>;
}

function NotFound({ navigate }) {
  return <section className="dashboard-gate"><p className="eyebrow">PAGINA NIET GEVONDEN</p><h1>Dit pad loopt<br /><em>niet over het land.</em></h1><p>De pagina bestaat niet of is verplaatst.</p><AppLink to="/" navigate={navigate} className="button">Terug naar het begin <span aria-hidden="true">→</span></AppLink></section>;
}

function DashboardLoading({ label = 'Gegevens laden…' }) { return <div className="dashboard-state" role="status"><span className="loader" aria-hidden="true" />{label}</div>; }
function DashboardError({ message }) { return <div className="dashboard-state error" role="alert"><b>Deze gegevens zijn nu niet beschikbaar.</b><span>{message}</span></div>; }
function Notice({ children, close }) { return <div className="notice" role="status" aria-live="polite"><span>{children}</span><button type="button" onClick={close}>Sluiten</button></div>; }

function Footer({ navigate, member, openLogin }) {
  return <footer className="site-footer"><div className="footer-top"><AppLink to="/" navigate={navigate} className="footer-mark">LAND<br />VAN JAN<span>HUISSEN</span></AppLink><div className="footer-intro"><p className="eyebrow light">EEN LEVEND PROJECT</p><p>Een plek voor grond, groei, makers<br />en echte ontmoeting.</p></div>{member ? <AppLink to="/leden" navigate={navigate} className="footer-member">Mijn ledenomgeving <span aria-hidden="true">→</span></AppLink> : <button className="footer-member" type="button" onClick={() => openLogin('login')}>Ledenomgeving <span aria-hidden="true">→</span></button>}</div><div className="footer-bottom"><nav className="footer-nav" aria-label="Voettekstnavigatie"><AppLink to="/over-het-land" navigate={navigate}>Over het land</AppLink><AppLink to="/agenda" navigate={navigate}>Agenda</AppLink><AppLink to="/verhalen" navigate={navigate}>Verhalen</AppLink><AppLink to="/contact" navigate={navigate}>Contact</AppLink><AppLink to="/privacy" navigate={navigate}>Privacy</AppLink></nav><p>Huissen · Gelderland</p><p>© {new Date().getFullYear()} Land van Jan</p></div></footer>;
}

export { App };
