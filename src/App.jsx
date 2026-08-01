import { useEffect, useState } from 'react';

const MEMBER_STORE_KEY = 'land-van-jan-members-v1';
const MEMBER_SESSION_KEY = 'land-van-jan-session-v1';

function readMembers() {
  try { return JSON.parse(localStorage.getItem(MEMBER_STORE_KEY) || '[]'); } catch { return []; }
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(MEMBER_SESSION_KEY) || 'null'); } catch { return null; }
}

async function passwordHash(password, salt) {
  const bytes = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const activities = [
  { day: 'ZA', date: '24', month: 'MEI', title: 'Zaaidag in de kas', time: '10:00 – 13:00', text: 'Samen zaaien, verzorgen en leren van het seizoen.' },
  { day: 'ZO', date: '01', month: 'JUNI', title: 'Rondleiding & proeverij', time: '14:00 – 16:00', text: 'Een eerste kennismaking met het land, de oogst en elkaar.' },
  { day: 'ZA', date: '14', month: 'JUNI', title: 'Bodemdag', time: '10:00 – 15:00', text: 'Praktisch werken met grond, planten en nieuwe ideeën.' },
];

const pages = {
  '/': { title: 'Land van Jan Huissen | Kas, boomgaard & gemeenschap', description: 'Land van Jan is een levend landproject in Huissen waar kas, boomgaard, makers en gemeenschap samen groeien.' },
  '/over-het-land': { title: 'Over het land | Land van Jan Huissen', description: 'Lees over het land, de kas, boomgaard en de richting van Land van Jan in Huissen.' },
  '/agenda': { title: 'Agenda | Land van Jan Huissen', description: 'Ontdek komende activiteiten op Land van Jan: zaaien, rondleidingen en bodemdagen.' },
  '/verhalen': { title: 'Verhalen | Land van Jan Huissen', description: 'Verhalen over makers, natuur, muziek en groei op Land van Jan.' },
  '/contact': { title: 'Contact | Land van Jan Huissen', description: 'Neem contact op met Land van Jan in Huissen voor een bezoek, activiteit of bijdrage.' },
  '/lid-worden': { title: 'Word lid | Land van Jan Huissen', description: 'Steun Land van Jan en word onderdeel van de community.' },
};

function App() {
  const [path, setPath] = useState(window.location.pathname in pages ? window.location.pathname : '/');
  const [loginOpen, setLoginOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [member, setMember] = useState(() => readSession());

  const navigate = (to) => { window.history.pushState({}, '', to); setPath(to); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  useEffect(() => {
    const sync = () => setPath(window.location.pathname in pages ? window.location.pathname : '/');
    window.addEventListener('popstate', sync); return () => window.removeEventListener('popstate', sync);
  }, []);
  useEffect(() => { document.title = pages[path].title; document.querySelector('meta[name="description"]')?.setAttribute('content', pages[path].description); }, [path]);
  const authenticate = async ({ mode, name, email, password, consent }) => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || password.length < 10) throw new Error('Gebruik een geldig e-mailadres en een wachtwoord van minimaal 10 tekens.');
    const members = readMembers();
    if (mode === 'register') {
      if (!consent) throw new Error('Bevestig dat je de ledeninformatie wilt opslaan op dit apparaat.');
      if (members.some(account => account.email === normalizedEmail)) throw new Error('Voor dit e-mailadres bestaat al een lokale ledenaccount. Log in.');
      const salt = crypto.randomUUID();
      const account = { id: crypto.randomUUID(), name: name.trim() || 'Lid', email: normalizedEmail, salt, passwordHash: await passwordHash(password, salt), createdAt: new Date().toISOString(), termsAcceptedAt: new Date().toISOString() };
      localStorage.setItem(MEMBER_STORE_KEY, JSON.stringify([...members, account]));
      const session = { id: account.id, name: account.name, email: account.email };
      localStorage.setItem(MEMBER_SESSION_KEY, JSON.stringify(session));
      setMember(session); setNotice(`Welkom ${account.name}. Je lokale ledenomgeving is klaar.`); return;
    }
    const account = members.find(candidate => candidate.email === normalizedEmail);
    if (!account || await passwordHash(password, account.salt) !== account.passwordHash) throw new Error('E-mailadres of wachtwoord klopt niet.');
    const session = { id: account.id, name: account.name, email: account.email };
    localStorage.setItem(MEMBER_SESSION_KEY, JSON.stringify(session));
    setMember(session); setNotice(`Welkom terug, ${account.name}.`);
  };
  const logout = () => { localStorage.removeItem(MEMBER_SESSION_KEY); setMember(null); setLoginOpen(false); setNotice('Je bent uitgelogd op dit apparaat.'); };
  const link = (to, children, className = '') => <button className={className} onClick={() => navigate(to)}>{children}</button>;

  const header = <header className="site-header"><button className="wordmark" onClick={() => navigate('/')} aria-label="Land van Jan, beginpagina"><span>LAND VAN JAN</span><small>HUISSEN</small></button><nav aria-label="Hoofdnavigatie">{link('/over-het-land', 'Over het land', path === '/over-het-land' ? 'active' : '')}{link('/agenda', 'Agenda', path === '/agenda' ? 'active' : '')}{link('/verhalen', 'Verhalen', path === '/verhalen' ? 'active' : '')}{link('/contact', 'Contact', path === '/contact' ? 'active' : '')}<button className="member-link" onClick={() => setLoginOpen(true)}>{member ? member.name : 'Inloggen'}</button></nav></header>;

  if (path !== '/') return <main className="inner-page">{header}<Page path={path} navigate={navigate} setNotice={setNotice} setLoginOpen={setLoginOpen} />{loginOpen && <Login close={() => setLoginOpen(false)} authenticate={authenticate} member={member} logout={logout} />} {notice && <Notice close={() => setNotice('')}>{notice}</Notice>}</main>;

  return <main>{header}
    <section className="hero hero-land" aria-labelledby="hero-title"><img src="/images/land-hero.jpeg" alt="Het erf van Land van Jan in Huissen met wielbarrow, kas en buitenplek" /><div className="hero-shade" /><div className="hero-copy"><h1 id="hero-title"><span>Land</span><span>van Jan</span></h1><p>Een levend project in Huissen.<br />Waar kas, boomgaard en gemeenschap samen groeien.</p></div><div className="paths" aria-label="Kies een route"><button onClick={() => navigate('/contact')}><strong>Bezoek<br />het land</strong><span>Kom langs, kijk rond, voel de plek.</span><b>→</b></button><button onClick={() => navigate('/lid-worden')}><strong>Word<br />lid</strong><span>Sluit je aan bij de community en ontvang voordelen.</span><b>→</b></button><button onClick={() => navigate('/contact')}><strong>Bouw<br />mee</strong><span>Draag bij met tijd, kennis of middelen.</span><b>→</b></button></div></section>
    <section className="route section" aria-labelledby="route-title"><div className="route-heading"><div><p className="eyebrow">EEN OPEN PROCES</p><h2 id="route-title">Van land<br />naar <em>plek.</em></h2></div><div><p>Geen blauwdruk, wel een richting. Dit is waar we nu staan en waar we naartoe werken.</p></div></div><div className="timeline"><Timeline title="Het land" date="Nu" image="/images/land-hero.jpeg" alt="Het land nu" text="We beheren het land, planten, testen en leren." /><Timeline title="De basis" date="2024 – 2025" image="/images/buitenplek.jpeg" alt="Buitenplek tussen bomen" text="Structuur aanbrengen, kas en voorzieningen opzetten." /><Timeline title="De groei" date="2026 – 2027" image="/images/kas-detail.jpeg" alt="Kas in groei" text="Meer oogst, meer mensen, meer verbinding." /><Timeline title="De plek" date="Toekomstbeeld" image="/images/toekomstvisualisatie.png" alt="Toekomstvisualisatie van het land" text="Een plek voor groei, ontmoeting en inspiratie." future /></div></section>
    <section className="programme section" aria-labelledby="agenda-title"><div className="section-intro"><p className="eyebrow">AGENDA</p><h2 id="agenda-title">Wat er de komende<br />tijd te doen is.</h2></div><div className="activity-list">{activities.map((activity) => <article className="activity" key={activity.title}><div className="date"><span>{activity.day}</span><strong>{activity.date}</strong><span>{activity.month}</span></div><p className="time">{activity.time}</p><div><h3>{activity.title}</h3><p>{activity.text}</p></div><button className="text-button" onClick={() => navigate('/agenda')}>Meer info <span>→</span></button></article>)}</div>{link('/agenda', <>Bekijk volledig overzicht <span>→</span></>, 'underlined')}</section>
    <section className="membership" aria-labelledby="member-title"><div><p className="eyebrow light">LEDEN ROUTE</p><h2 id="member-title">Draag een plek<br />mee die groeit.</h2><p>Voor leden: toegang tot updates, voordelen en de community. Een lidmaatschap begint klein en blijft dichtbij het land.</p>{link('/lid-worden', <>Ontdek lidmaatschap <span>→</span></>, 'button button-rust')}</div><img src="/images/gemeenschap-hd.jpeg" alt="Mensen samen op het land in Huissen" /></section>
    <Footer navigate={navigate} login={() => setLoginOpen(true)} member={member} />{loginOpen && <Login close={() => setLoginOpen(false)} authenticate={authenticate} member={member} logout={logout} />}{notice && <Notice close={() => setNotice('')}>{notice}</Notice>}</main>;
}

function Timeline({ title, date, image, alt, text, future }) { return <article><div className="timeline-label"><b>{title}</b><em>{date}</em></div><figure className={future ? 'timeline-visual future-visual' : 'timeline-visual'}><img src={image} alt={alt} />{future && <span>TOEKOMSTVISUALISATIE</span>}</figure><p>{text}</p></article>; }

function Page({ path, navigate, setNotice, setLoginOpen }) {
  const content = {
    '/over-het-land': { eyebrow: 'OVER HET LAND', title: <>Een open plek<br />om te maken,<br /><em>te delen</em> en<br />te groeien.</>, text: 'Kas, boomgaard, muziek en een tafel buiten. Land van Jan is geen eindproduct: het groeit met de mensen die hier komen.', image: '/images/buitenplek.jpeg', alt: 'Buitenplek bij Land van Jan', detail: '/images/kas-binnen-hd.jpeg', heading: 'Tussen rivierland en boomgaard', body: 'Huissen ligt in het landschap rond de Nederrijn: een plek van rivierklei, dijken, teelt en oude routes. Op dit erf ontstaat stap voor stap een plek waar grond, voedsel en ontmoeting samenkomen.', points: ['Kas en moestuin als plek om te leren', 'Fruitbomen, stekjes en seizoenswerk', 'Ruimte voor makers, rust en ontmoeting'], gallery: ['/images/kas-buiten-hd.jpeg', '/images/boomgaard-hd.jpeg', '/images/werkplaats-hd.jpeg'], labels: ['De kas', 'De boomgaard', 'Werk & maken'], quote: 'We bouwen niet alleen aan een terrein, maar aan een ritme waarin mensen en seizoenen samenkomen.' },
    '/agenda': { eyebrow: 'AGENDA', title: <>Tijd om samen<br /><em>naar buiten</em> te gaan.</>, text: 'Kleine activiteiten met aandacht voor het seizoen, de plek en elkaar.', image: '/images/kas-binnen-hd.jpeg', alt: 'Planten in de kas', detail: '/images/land-hero.jpeg', heading: 'Wat je kunt verwachten', body: 'De agenda beweegt mee met het seizoen. Sommige dagen zijn praktisch, andere dagen zijn rustig, creatief of gericht op samen eten en luisteren.', points: ['Zaaien, oogsten en werken met de bodem', 'Rondleidingen en kleine proeverijen', 'Muziek, creatieve middagen en retraites'], gallery: ['/images/kas-buiten-hd.jpeg', '/images/gemeenschap-hd.jpeg', '/images/boomgaard-hd.jpeg'], labels: ['Werken in het groen', 'Samen aan tafel', 'De seizoenen volgen'], quote: 'Kom zoals je bent. Je hoeft niets te kunnen om mee te doen.' },
    '/verhalen': { eyebrow: 'VERHALEN', title: <>Makers, muziek<br />en <em>natuur.</em></>, text: 'Op het land krijgen ritueel, handwerk, voedsel en ontmoeting een plek.', image: '/images/boomgaard-hd.jpeg', alt: 'Scherp sfeerbeeld van de boomgaard op het land', detail: '/images/gemeenschap-hd.jpeg', heading: 'Dingen die hier betekenis krijgen', body: 'Een handgemaakt object, een instrument, een oogst uit de kas of een gesprek aan tafel: de verhalen van het land gaan over aandacht en vakmanschap.', points: ['Handgemaakte kunst en symboliek', 'Muziek en klank in de buitenlucht', 'Voedsel, planten en verhalen uit het seizoen'], gallery: ['/images/ankh-kunst.jpeg', '/images/boomgaard-hd.jpeg', '/images/kas-binnen-hd.jpeg'], labels: ['Kunst & symboliek', 'Vruchten van het land', 'Aandacht voor groei'], quote: 'Een plek wordt bijzonder door de verhalen die mensen er samen aan toevoegen.' },
    '/contact': { eyebrow: 'CONTACT', title: <>Kom kijken.<br /><em>Of bouw mee.</em></>, text: 'Wil je langskomen, een activiteit organiseren of bijdragen met tijd, kennis of materiaal? Laat van je horen.', image: '/images/land-hero.jpeg', alt: 'Land van Jan in Huissen', detail: '/images/kas-buiten-hd.jpeg', heading: 'Een eerste stap is genoeg', body: 'Je hoeft niet alles al te weten. Laat weten wat je aanspreekt: een bezoek, een idee, een vaardigheid, een workshop of gewoon nieuwsgierigheid.', points: ['Kom langs voor een eerste kennismaking', 'Denk mee over activiteiten of het programma', 'Draag bij met tijd, kennis of materiaal'], gallery: ['/images/gemeenschap-hd.jpeg', '/images/boomgaard-hd.jpeg', '/images/werkplaats-hd.jpeg'], labels: ['Ontmoeten', 'Rondkijken', 'Samen bouwen'], quote: 'Een kort bericht is genoeg om de eerste stap te zetten.' },
    '/lid-worden': { eyebrow: 'WORD LID', title: <>Samen dragen,<br /><em>samen doen.</em></>, text: 'Voor €5 per maand help je het land onderhouden en ontvang je updates, activiteiten en vier bijeenkomsten per jaar.', image: '/images/gemeenschap-hd.jpeg', alt: 'Mensen op het land', detail: '/images/ankh-kunst.jpeg', heading: 'Een klein bedrag, een gezamenlijke basis', body: 'Een lidmaatschap helpt het land onderhouden en maakt ruimte voor mensen die niet vanzelf financiële ruimte hebben. Je ontvangt updates en uitnodigingen om aan te haken.', points: ['€5 per maand als bijdrage aan het land', 'Updates, uitnodigingen en online inspiratie', 'Vier bijeenkomsten per jaar op het land'], gallery: ['/images/kas-binnen-hd.jpeg', '/images/boomgaard-hd.jpeg', '/images/buitenplek.jpeg'], labels: ['De plek verzorgen', 'De oogst delen', 'Samen aanwezig zijn'], quote: 'Lid zijn betekent niet alleen ontvangen, maar ook samen ruimte mogelijk maken.' },
  }[path];
  return <><section className="page-hero"><img src={content.image} alt={content.alt} /><div /><div><p className="eyebrow light">{content.eyebrow}</p><h1>{content.title}</h1><p>{content.text}</p>{path === '/contact' ? <button className="button" onClick={() => setNotice('Bedankt — de echte contact- en aanmeldflow wordt in de volgende technische stap gekoppeld.')}>Stuur een bericht <span>→</span></button> : path === '/lid-worden' ? <button className="button" onClick={() => setLoginOpen(true)}>Start lidmaatschap <span>→</span></button> : <button className="button" onClick={() => navigate('/contact')}>Neem contact op <span>→</span></button>}</div></section><section className="page-story section"><div><p className="eyebrow">{content.eyebrow}</p><h2>{content.heading}</h2><p>{content.body}</p><ul>{content.points.map(point => <li key={point}>{point}</li>)}</ul></div><figure><img src={content.detail} alt="Sfeerbeeld van Land van Jan" /></figure></section>{path === '/agenda' && <section className="programme section"><div className="section-intro"><p className="eyebrow">KOMENDE MOMENTEN</p><h2>Doe mee op<br />jouw manier.</h2></div><div className="activity-list">{activities.map(a => <article className="activity" key={a.title}><div className="date"><span>{a.day}</span><strong>{a.date}</strong><span>{a.month}</span></div><p className="time">{a.time}</p><div><h3>{a.title}</h3><p>{a.text}</p></div><button className="text-button" onClick={() => setNotice('Aanmelden wordt hier gekoppeld zodra de agenda live wordt beheerd.')}>Aanmelden <span>→</span></button></article>)}</div></section>}<PageGallery content={content} /><section className="page-quote"><p>“{content.quote}”</p><span>LAND VAN JAN · HUISSEN</span></section><Footer navigate={navigate} login={() => setLoginOpen(true)} /></>;
}

function PageGallery({ content }) { return <section className="page-gallery section" aria-label="Beelden van het land"><div className="section-intro"><div><p className="eyebrow">VAN HET LAND</p><h2>Ruimte voor<br /><em>wat ontstaat.</em></h2></div><p>Elk seizoen laat een andere kant van de plek zien: buiten werken, iets maken, samenkomen en weer verder groeien.</p></div><div className="gallery-grid">{content.gallery.map((image, index) => <figure key={image}><img src={image} alt={content.labels[index]} loading="lazy" /><figcaption><span>0{index + 1}</span>{content.labels[index]}</figcaption></figure>)}</div></section>; }

function Login({ close, authenticate, member, logout }) {
  const [mode, setMode] = useState('login');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setStatus('');
    try {
      await authenticate({ mode, name: form.get('name') || '', email: form.get('email') || '', password: form.get('password') || '', consent: form.get('consent') === 'on' });
      close();
    } catch (error) { setStatus(error.message || 'Er ging iets mis.'); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={close}><section className="login-panel" role="dialog" aria-modal="true" aria-labelledby="login-title" onMouseDown={e => e.stopPropagation()}><button className="close" aria-label="Sluiten" onClick={close}>×</button>{member ? <><p className="eyebrow">LEDENOMGEVING</p><h2 id="login-title">Welkom, {member.name}.</h2><p>Je bent op dit apparaat ingelogd als <strong>{member.email}</strong>.</p><div className="member-card"><b>Lokale preview</b><p>Deze omgeving werkt alleen in deze browser. Er is nog geen centrale ledenlijst, betaalstatus of e-mailkoppeling.</p></div><button className="button" onClick={logout}>Uitloggen <span>→</span></button></> : <><p className="eyebrow">LEDENOMGEVING</p><div className="login-tabs"><button className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setStatus(''); }}>Inloggen</button><button className={mode === 'register' ? 'selected' : ''} onClick={() => { setMode('register'); setStatus(''); }}>Account maken</button></div><h2 id="login-title">{mode === 'login' ? 'Welkom terug.' : 'Sluit je aan.'}</h2><p>{mode === 'login' ? 'Log in om je lokale ledenomgeving te openen.' : 'Maak een ledenaccount voor deze lokale preview.'}</p><form onSubmit={submit}>{mode === 'register' && <label>Voornaam<input name="name" autoComplete="given-name" required placeholder="Je voornaam" /></label>}<label>E-mailadres<input name="email" type="email" autoComplete="email" required placeholder="naam@email.nl" /></label><label>Wachtwoord<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength="10" required placeholder="Minimaal 10 tekens" /></label>{mode === 'register' && <><label className="consent"><input name="consent" type="checkbox" required />Ik begrijp dat deze lokale preview mijn account alleen op dit apparaat bewaart.</label><div className="kyc-note"><b>Identiteitscontrole / KYC</b><p>Er wordt hier geen identiteit gecontroleerd en je moet geen ID-document uploaden. Echte KYC vraagt later om een gekozen, gecertificeerde provider en een privacy- en bewaarbeleid.</p></div></>}{status && <p className="form-status" role="alert">{status}</p>}<button className="button" type="submit" disabled={busy}>{busy ? 'Even wachten…' : mode === 'login' ? 'Inloggen' : 'Account maken'} <span>→</span></button></form></>}</section></div>;
}
function Notice({ children, close }) { return <button className="notice" onClick={close}>{children}<span>Sluiten</span></button>; }
function Footer({ navigate, login, member }) { return <footer className="site-footer"><div className="footer-top"><button className="footer-mark" onClick={() => navigate('/')}>LAND<br />VAN JAN<span>HUISSEN</span></button><div className="footer-intro"><p className="eyebrow light">EEN LEVEND PROJECT</p><p>Een plek voor grond, groei, makers<br />en echte ontmoeting.</p></div><button className="footer-member" onClick={login}>{member ? `${member.name} · ledenomgeving` : 'Ledenomgeving'} <span>→</span></button></div><div className="footer-bottom"><div className="footer-nav"><button onClick={() => navigate('/over-het-land')}>Over het land</button><button onClick={() => navigate('/agenda')}>Agenda</button><button onClick={() => navigate('/verhalen')}>Verhalen</button><button onClick={() => navigate('/contact')}>Contact</button></div><p>Huissen · Gelderland</p><p>© {new Date().getFullYear()} Land van Jan</p></div></footer>; }
export { App };
