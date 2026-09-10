/* ---------------------------------------------------------------------
   Adaptateur de stockage local (localStorage), compatible navigateur.
   Remplace l'API window.storage qui n'existe que dans l'aperçu Claude.ai.
   Même interface asynchrone (get/set/delete) pour ne rien changer au
   reste du code, qui utilise déjà await un peu partout.
--------------------------------------------------------------------- */
const storage = {
  async get(key){
    const v = localStorage.getItem(key);
    return v !== null ? { key, value: v } : null;
  },
  async set(key, value){
    localStorage.setItem(key, value);
    return { key, value };
  },
  async delete(key){
    localStorage.removeItem(key);
    return { key, deleted: true };
  },
  async list(prefix){
    const keys = Object.keys(localStorage).filter(k => !prefix || k.startsWith(prefix));
    return { keys };
  }
};

/* ---------------------------------------------------------------------
   Chargement des icônes personnalisées (assets/icones/) avec repli
   automatique sur Material Symbols si le fichier est absent ou cassé.
   Chaque élément marqué data-icon-src="..." dans le HTML est rempli ici :
   on crée l'<img> en JS et on attache le listener d'erreur AVANT de fixer
   le src, pour ne jamais manquer l'événement 'error' (pas de course
   possible avec un onerror inline).
--------------------------------------------------------------------- */
function loadIcon(wrap){
  const src = wrap.dataset.iconSrc;
  const fallbackGlyph = wrap.dataset.iconFallback || 'circle';
  const size = wrap.dataset.iconSize || '24';
  if(!src) return;
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.style.width = size + 'px';
  img.style.height = size + 'px';
  img.style.objectFit = 'contain';
  img.style.display = 'block';
  img.addEventListener('error', () => {
    img.remove();
    wrap.classList.add('icon-fallback');
    const span = document.createElement('span');
    span.className = 'material-symbols-outlined';
    span.style.fontSize = size + 'px';
    span.style.lineHeight = '1';
    span.textContent = fallbackGlyph;
    wrap.appendChild(span);
  }, { once: true });
  img.src = src;
  wrap.appendChild(img);
}
function initIcons(){
  document.querySelectorAll('[data-icon-src]').forEach(wrap => {
    wrap.innerHTML = '';
    wrap.classList.remove('icon-fallback');
    loadIcon(wrap);
  });
}

/* ===================== STATE ===================== */
const now_ = new Date();
const TODAY = new Date(now_.getFullYear(), now_.getMonth(), now_.getDate()); // vraie date du jour, à minuit local
let state = null;

function pad(n){ return String(n).padStart(2,'0'); }
function dstr(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function uid(){ return Math.random().toString(36).slice(2,9); }
function addDays(d,n){ const r=new Date(d); r.setDate(r.getDate()+n); return r; }
function startOfWeek(d){ const day=(d.getDay()+6)%7; return addDays(d,-day); } // Monday start
function isoWeekNumber(d){
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNr = (target.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = target - firstThursday;
  return 1 + Math.round(diff / (7*24*60*60*1000));
}

function emptyState(account){
  return {
    user: { name: account.name, email: account.email, plan: 'Compte gratuit', memberSince: formatMemberSince(account.createdAt), initials: initialsOf(account.name) },
    settings: { dailyGoal: 6, focusMinutes: 25, remindersEnabled: true, calendarView: 'Semaine', theme: 'Fuchsia Noir' },
    selectedDate: dstr(TODAY),
    tasks: [],
    events: [],
    activeGoalId: null,
    goals: []
  };
}
function initialsOf(name){ const p = (name||'').trim().split(/\s+/).filter(Boolean); return (p.map(w=>w[0]).slice(0,2).join('') || '??').toUpperCase(); }
function formatMemberSince(dateStr){ try{ const d = new Date(dateStr+'T00:00:00'); return capitalize(d.toLocaleDateString('fr-FR',{month:'short', year:'numeric'})); }catch(e){ return ''; } }
function simpleHash(str){ let h = 0; for(let i=0;i<str.length;i++){ h = (h<<5)-h + str.charCodeAt(i); h |= 0; } return 'h'+h; }

// Anciennes sauvegardes stockaient les événements sous forme { 'YYYY-MM-DD': [...] }.
// On migre vers un tableau plat d'événements (avec date d'ancrage), nécessaire
// pour supporter la récurrence sans dupliquer les données.
function migrateEventsIfNeeded(){
  if(!state.events){ state.events = []; return; }
  if(Array.isArray(state.events)) return;
  const flat = [];
  Object.keys(state.events).forEach(dateKey => {
    (state.events[dateKey] || []).forEach(ev => {
      flat.push({ ...ev, date: dateKey, recurrence: null, exceptions: [], allDay: false, location: ev.location || '' });
    });
  });
  state.events = flat;
}

function dateDiffDays(dateStrA, dateStrB){
  const a = new Date(dateStrA + 'T00:00:00Z');
  const b = new Date(dateStrB + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}
function recurrenceLabel(r){
  if(!r) return '';
  const unit = { daily: 'jour', weekly: 'semaine', monthly: 'mois', yearly: 'an' }[r.freq];
  const unitPlural = { daily: 'jours', weekly: 'semaines', monthly: 'mois', yearly: 'ans' }[r.freq];
  const n = r.interval || 1;
  return n > 1 ? `Tous les ${n} ${unitPlural}` : `Tous les ${r.freq==='daily'?'jours':r.freq==='weekly'?'semaines':r.freq==='monthly'?'mois':'ans'}`;
}
// Retourne les occurrences d'événements (récurrents compris) pour une date donnée.
function getEventsForDate(dateStr){
  const out = [];
  (state.events || []).forEach(ev => {
    if(ev.exceptions && ev.exceptions.includes(dateStr)) return;
    if(!ev.recurrence){
      if(ev.date === dateStr) out.push({ ...ev, occurrenceDate: dateStr });
      return;
    }
    if(dateStr < ev.date) return;
    if(ev.recurrence.until && dateStr > ev.recurrence.until) return;
    const interval = ev.recurrence.interval || 1;
    const diff = dateDiffDays(ev.date, dateStr);
    let matches = false;
    if(ev.recurrence.freq === 'daily'){
      matches = diff % interval === 0;
    } else if(ev.recurrence.freq === 'weekly'){
      matches = diff % 7 === 0 && (diff / 7) % interval === 0;
    } else if(ev.recurrence.freq === 'monthly'){
      const start = new Date(ev.date + 'T00:00:00');
      const cur = new Date(dateStr + 'T00:00:00');
      if(start.getDate() === cur.getDate()){
        const monthsDiff = (cur.getFullYear()-start.getFullYear())*12 + (cur.getMonth()-start.getMonth());
        matches = monthsDiff >= 0 && monthsDiff % interval === 0;
      }
    } else if(ev.recurrence.freq === 'yearly'){
      const start = new Date(ev.date + 'T00:00:00');
      const cur = new Date(dateStr + 'T00:00:00');
      if(start.getDate() === cur.getDate() && start.getMonth() === cur.getMonth()){
        const yearsDiff = cur.getFullYear() - start.getFullYear();
        matches = yearsDiff >= 0 && yearsDiff % interval === 0;
      }
    }
    if(matches) out.push({ ...ev, occurrenceDate: dateStr });
  });
  return out;
}
function deleteEventSeries(masterId){
  state.events = state.events.filter(e => e.id !== masterId);
  saveState();
}
function deleteEventOccurrence(masterId, occurrenceDate){
  const master = state.events.find(e => e.id === masterId);
  if(!master) return;
  if(!master.recurrence){ deleteEventSeries(masterId); return; }
  if(!master.exceptions) master.exceptions = [];
  master.exceptions.push(occurrenceDate);
  saveState();
}
// Clic sur "supprimer" un événement : demande la portée (cette occurrence /
// toute la série) si l'événement est récurrent, sinon supprime directement.
function handleDeleteEventClick(masterId, occurrenceDate){
  const master = state.events.find(e => e.id === masterId);
  if(!master) return;
  if(!master.recurrence){
    deleteEventSeries(masterId);
    renderCurrentPage(); toast('Événement supprimé');
    return;
  }
  openModal(`
    <h3 class="font-headline-md text-headline-md text-on-surface mb-1">Supprimer l'événement</h3>
    <p class="font-body-md text-body-md text-on-surface-variant mb-4">Cet événement fait partie d'une série récurrente (${recurrenceLabel(master.recurrence)}).</p>
    <div class="flex flex-col gap-2">
      <button id="btn-del-occurrence" class="w-full py-3 rounded-xl bg-surface-container-high text-on-surface font-body-md text-body-md text-left px-4">Seulement cet événement</button>
      <button id="btn-del-series" class="w-full py-3 rounded-xl bg-error/15 text-error font-body-md text-body-md text-left px-4 font-semibold">Toute la série</button>
      <button data-action="close" class="w-full py-3 rounded-xl text-on-surface-variant font-body-md text-body-md">Annuler</button>
    </div>
  `);
  document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
  document.getElementById('btn-del-occurrence').addEventListener('click', () => {
    deleteEventOccurrence(masterId, occurrenceDate);
    closeModal(); renderCurrentPage(); toast('Occurrence supprimée');
  });
  document.getElementById('btn-del-series').addEventListener('click', () => {
    deleteEventSeries(masterId);
    closeModal(); renderCurrentPage(); toast('Série supprimée');
  });
}
function openEventDetailModal(masterId, occurrenceDate){
  const master = state.events.find(e => e.id === masterId);
  if(!master) return;
  const d = new Date(occurrenceDate + 'T00:00:00');
  openModal(`
    <div class="flex items-center justify-between mb-3">
      <span class="px-2 py-0.5 rounded-full ${catBadge(master.category)} font-label-sm text-label-sm font-semibold uppercase">${master.category}</span>
      <button data-action="close" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[18px]">close</span></button>
    </div>
    <h3 class="font-headline-lg text-headline-lg text-on-surface mb-1">${master.title}</h3>
    <p class="font-label-md text-label-md text-on-surface-variant capitalize mb-2">${d.toLocaleDateString('fr-FR',{weekday:'long', day:'numeric', month:'long'})} · ${master.allDay ? 'Toute la journée' : `${master.start} - ${master.end}`}</p>
    ${master.location ? `<p class="font-body-md text-body-md text-on-surface-variant flex items-center gap-1.5 mb-1"><span class="material-symbols-outlined text-[16px]">location_on</span>${master.location}</p>` : ''}
    ${master.desc ? `<p class="font-body-md text-body-md text-on-surface-variant mt-2">${master.desc}</p>` : ''}
    ${master.recurrence ? `<p class="font-label-sm text-label-sm text-primary flex items-center gap-1.5 mt-3"><span class="material-symbols-outlined text-[14px]">repeat</span>${recurrenceLabel(master.recurrence)}${master.recurrence.until ? ` · jusqu'au ${formatDueDate(master.recurrence.until)}` : ''}</p>` : ''}
    <div class="flex gap-2 mt-5">
      <button id="btn-edit-event" class="flex-1 py-3 rounded-xl bg-surface-container-high text-on-surface font-body-md text-body-md font-semibold">Modifier</button>
      <button id="btn-delete-event" class="flex-1 py-3 rounded-xl bg-error/15 text-error font-body-md text-body-md font-semibold">Supprimer</button>
    </div>
  `);
  document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
  document.getElementById('btn-edit-event').addEventListener('click', () => {
    closeModal();
    openAddEventModal(occurrenceDate, masterId);
  });
  document.getElementById('btn-delete-event').addEventListener('click', () => {
    closeModal();
    handleDeleteEventClick(masterId, occurrenceDate);
  });
}

/* ----- account / session storage (client-side demo auth, no real backend) ----- */
const ACCOUNTS_KEY = 'listmax_accounts_v1';
const SESSION_KEY = 'listmax_session_v1';
function stateKeyFor(email){ return 'listmax_state__' + email; }
let currentEmail = null;

async function loadAccounts(){
  try{ const res = await storage.get(ACCOUNTS_KEY); if(res && res.value) return JSON.parse(res.value); }catch(e){}
  return [];
}
async function saveAccounts(accounts){
  try{ await storage.set(ACCOUNTS_KEY, JSON.stringify(accounts)); }catch(e){}
}
async function loadSession(){
  try{ const res = await storage.get(SESSION_KEY); if(res && res.value) return res.value; }catch(e){}
  return null;
}
async function saveSession(email){
  try{ if(email) await storage.set(SESSION_KEY, email); else await storage.delete(SESSION_KEY); }catch(e){}
}
async function loadUserState(email){
  try{ const res = await storage.get(stateKeyFor(email)); if(res && res.value) return JSON.parse(res.value); }catch(e){}
  return null;
}
async function saveState(){
  if(!currentEmail) return;
  try{ await storage.set(stateKeyFor(currentEmail), JSON.stringify(state)); }catch(e){ /* storage unavailable */ }
}
async function deleteUserState(email){
  try{ await storage.delete(stateKeyFor(email)); }catch(e){}
}

async function loginAs(account){
  currentEmail = account.email;
  await saveSession(currentEmail);
  const loaded = await loadUserState(currentEmail);
  state = loaded || emptyState(account);
  if(state.activeGoalId === undefined) state.activeGoalId = null;
  migrateEventsIfNeeded();
  syncLongTermDueTasks();
  await saveState();
  showApp();
  setActivePage('home');
  toast(`Bienvenue, ${account.name.split(' ')[0]} !`);
}

async function logout(){
  await saveSession(null);
  currentEmail = null;
  state = null;
  showLogin();
}

function showApp(){
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-header').classList.remove('hidden');
  const mainEl = document.getElementById('app-main');
  mainEl.classList.remove('hidden'); mainEl.classList.add('flex');
  document.getElementById('app-nav').classList.remove('hidden');
}
function showLogin(){
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-header').classList.add('hidden');
  const mainEl = document.getElementById('app-main');
  mainEl.classList.add('hidden'); mainEl.classList.remove('flex');
  document.getElementById('app-nav').classList.add('hidden');
  setAuthMode('login');
  document.getElementById('auth-form').reset();
  hideAuthError();
}

/* ----- auth UI ----- */
let authMode = 'login';
function initAuthUI(){
  document.getElementById('tab-login').addEventListener('click', () => setAuthMode('login'));
  document.getElementById('tab-signup').addEventListener('click', () => setAuthMode('signup'));
  document.getElementById('toggle-pw').addEventListener('click', () => {
    const pw = document.getElementById('auth-password');
    const btn = document.getElementById('toggle-pw');
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    btn.querySelector('span').textContent = show ? 'visibility_off' : 'visibility';
  });
  document.getElementById('auth-form').addEventListener('submit', handleAuthSubmit);
  document.getElementById('btn-google').addEventListener('click', handleGoogleAuth);
}
function setAuthMode(mode){
  authMode = mode;
  const loginTab = document.getElementById('tab-login');
  const signupTab = document.getElementById('tab-signup');
  loginTab.classList.toggle('bg-primary-container', mode==='login');
  loginTab.classList.toggle('text-on-primary-container', mode==='login');
  loginTab.classList.toggle('font-semibold', mode==='login');
  loginTab.classList.toggle('text-on-surface-variant', mode!=='login');
  signupTab.classList.toggle('bg-primary-container', mode==='signup');
  signupTab.classList.toggle('text-on-primary-container', mode==='signup');
  signupTab.classList.toggle('font-semibold', mode==='signup');
  signupTab.classList.toggle('text-on-surface-variant', mode!=='signup');
  document.getElementById('auth-name').classList.toggle('hidden', mode!=='signup');
  document.getElementById('auth-title').textContent = mode==='login' ? 'Bon retour' : 'Créer un compte';
  document.getElementById('auth-subtitle').textContent = mode==='login' ? 'Connecte-toi pour retrouver tes tâches, ton agenda et tes objectifs.' : 'Crée ton compte pour commencer à organiser tes journées.';
  document.getElementById('auth-submit').textContent = mode==='login' ? 'Se connecter' : 'Créer mon compte';
  hideAuthError();
}
function showAuthError(msg){ const e = document.getElementById('auth-error'); e.textContent = msg; e.classList.remove('hidden'); }
function hideAuthError(){ document.getElementById('auth-error').classList.add('hidden'); }

async function handleAuthSubmit(e){
  e.preventDefault();
  hideAuthError();
  const email = document.getElementById('auth-email').value.trim().toLowerCase();
  const password = document.getElementById('auth-password').value;
  const name = document.getElementById('auth-name').value.trim();
  if(!email || !password){ showAuthError('Merci de remplir tous les champs.'); return; }
  const accounts = await loadAccounts();
  if(authMode === 'signup'){
    if(!name){ showAuthError('Merci d\u2019indiquer ton nom.'); return; }
    if(password.length < 4){ showAuthError('Le mot de passe doit faire au moins 4 caractères.'); return; }
    if(accounts.find(a => a.email === email)){ showAuthError('Un compte existe déjà avec cet e-mail. Connecte-toi plutôt.'); return; }
    const account = { name, email, passwordHash: simpleHash(password), provider: 'email', createdAt: dstr(TODAY) };
    accounts.push(account);
    await saveAccounts(accounts);
    await loginAs(account);
  } else {
    const account = accounts.find(a => a.email === email);
    if(!account || account.passwordHash !== simpleHash(password)){ showAuthError('E-mail ou mot de passe incorrect.'); return; }
    await loginAs(account);
  }
}

async function handleGoogleAuth(){
  openModal(`
    <div class="text-center py-2">
      <h3 class="font-headline-md text-headline-md text-on-surface mb-1">Connexion Google</h3>
      <p class="font-body-md text-body-md text-on-surface-variant mb-4">Aucune vraie authentification Google n'est reliée à ce prototype : indique le nom et l'e-mail du compte à utiliser pour simuler la connexion.</p>
      <div class="flex flex-col gap-3 text-left">
        <input id="g-auth-name" type="text" placeholder="Nom complet" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
        <input id="g-auth-email" type="email" placeholder="prenom.nom@gmail.com" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
      </div>
      <button id="g-auth-confirm" class="mt-4 w-full py-3.5 rounded-xl bg-primary text-on-primary font-headline-md text-headline-md font-semibold active:scale-[0.98] transition-all">Continuer</button>
    </div>
  `);
  document.getElementById('g-auth-confirm').addEventListener('click', async () => {
    const name = document.getElementById('g-auth-name').value.trim();
    const email = document.getElementById('g-auth-email').value.trim().toLowerCase();
    if(!name || !email){ toast('Nom et e-mail requis'); return; }
    const accounts = await loadAccounts();
    let account = accounts.find(a => a.email === email);
    if(!account){
      account = { name, email, passwordHash: null, provider: 'google', createdAt: dstr(TODAY) };
      accounts.push(account);
      await saveAccounts(accounts);
    }
    closeModal();
    await loginAs(account);
  });
}

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('opacity-0'); t.classList.add('opacity-100');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=>{ t.classList.add('opacity-0'); t.classList.remove('opacity-100'); }, 1800);
}

/* ===================== NAV ===================== */
const PAGE_TITLES = { home: 'Home', todo: 'To Do List', calendar: 'Calendar', goals: 'Life Goals', settings: 'Settings' };
let currentPage = 'home';

function setActivePage(page){
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[page];
  document.querySelectorAll('.nav-btn').forEach(b => {
    const active = b.dataset.nav === page;
    b.classList.toggle('text-primary', active);
    b.classList.toggle('font-bold', active);
    b.classList.toggle('text-on-surface-variant', !active);
    b.querySelector('.nav-dot').classList.toggle('opacity-100', active);
  });
  renderCurrentPage();
  window.scrollTo(0,0);
}
document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => setActivePage(b.dataset.nav)));
document.getElementById('btn-profile').addEventListener('click', () => setActivePage('settings'));

function renderCurrentPage(){
  if(currentPage === 'home') renderHome();
  else if(currentPage === 'todo') renderTodo();
  else if(currentPage === 'calendar') renderCalendar();
  else if(currentPage === 'goals') renderGoals();
  else if(currentPage === 'settings') renderSettings();
}

/* ===================== MODAL ===================== */
function openModal(html){
  document.getElementById('modal-panel').innerHTML = html;
  document.getElementById('modal-backdrop').classList.add('active');
}
function closeModal(){
  document.getElementById('modal-backdrop').classList.remove('active');
}
document.getElementById('modal-backdrop').addEventListener('click', (e)=>{
  if(e.target.id === 'modal-backdrop') closeModal();
});

/* ===================== HOME ===================== */
function priorityDot(p){
  return p === 'haute' ? 'bg-primary' : p === 'normale' ? 'bg-tertiary' : 'bg-outline-variant';
}
function priorityLabel(p){
  return p === 'haute' ? 'Priorité Haute' : p === 'normale' ? 'Normale' : 'Basse';
}

/* ---- Home helpers: greeting, score, "next" highlight ---- */
const GREETINGS_MORNING = ['Prête à commencer la journée ?', 'Ta journée démarre maintenant.', 'Voici ton programme du matin.'];
const GREETINGS_DAY = ["Voici ton programme d'aujourd'hui.", 'Encore un pas vers tes objectifs.', 'Ça avance bien aujourd\u2019hui.'];
const GREETINGS_EVENING = ['Encore quelques efforts avant ce soir.', 'La journée touche à sa fin, en beauté.', 'Un dernier coup d\u2019œil sur ta journée.'];
function pickGreeting(){
  const h = new Date().getHours();
  const pool = h < 12 ? GREETINGS_MORNING : (h < 18 ? GREETINGS_DAY : GREETINGS_EVENING);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Score sur 100 : moyenne uniquement des catégories pour lesquelles il existe
// vraiment une donnée aujourd'hui (tâches du jour créées, et/ou un objectif
// actif défini). Une catégorie vide est ignorée, jamais comptée comme "ratée" —
// donc null (pas 0) si rien n'existe encore à évaluer.
function computeHomeScore(){
  const todays = state.tasks.filter(t => t.list === 'today');
  const parts = [];
  if(todays.length) parts.push(todays.filter(t => t.done).length / todays.length);
  const focusGoal = state.activeGoalId ? state.goals.find(g => g.id === state.activeGoalId) : null;
  if(focusGoal) parts.push((focusGoal.progress || 0) / 100);
  if(!parts.length) return null;
  return Math.round((parts.reduce((a,b) => a+b, 0) / parts.length) * 100);
}
function homeScoreNote(score){
  if(score === null) return "Ajoute une tâche ou définis un objectif actif pour voir ton score.";
  if(score >= 80) return 'Belle journée, continue comme ça !';
  if(score >= 50) return 'Bien avancé — encore un peu de chemin.';
  return 'La journée ne fait que commencer.';
}
function parseTaskTimeToMinutes(str){
  if(!str) return null;
  const m = /^(\d{1,2})h(\d{2})$/.exec(str.trim());
  if(!m) return null;
  return parseInt(m[1],10)*60 + parseInt(m[2],10);
}
// Prochain élément à venir aujourd'hui parmi les tâches du jour (avec horaire,
// non terminées) et les événements du calendrier — tous mélangés et triés par
// heure. Retourne null s'il n'y a plus rien de prévu pour la suite de la journée.
function pickNextHighlight(){
  const now = new Date();
  const nowMinutes = now.getHours()*60 + now.getMinutes();
  const candidates = [];
  state.tasks.filter(t => t.list === 'today' && !t.done && t.time).forEach(t => {
    const mins = parseTaskTimeToMinutes(t.time);
    if(mins !== null) candidates.push({ kind: 'task', id: t.id, title: t.text, timeLabel: t.time, minutes: mins, tab: 'todo' });
  });
  getEventsForDate(dstr(TODAY)).filter(e => !e.allDay).forEach(e => {
    candidates.push({ kind: 'event', id: e.id, title: e.title, timeLabel: e.start, minutes: toMin(e.start), tab: 'calendar' });
  });
  const upcoming = candidates.filter(c => c.minutes >= nowMinutes).sort((a,b) => a.minutes - b.minutes);
  if(!upcoming.length) return null;
  const chosen = upcoming[0];
  return { ...chosen, imminent: (chosen.minutes - nowMinutes) <= 60 };
}

function renderHome(){
  const todays = state.tasks.filter(t => t.list === 'today');
  const done = todays.filter(t => t.done).length;
  const pending = todays.filter(t => !t.done);
  const score = computeHomeScore();
  const scorePct = score === null ? 0 : score;
  const focusGoal = state.activeGoalId ? state.goals.find(g => g.id === state.activeGoalId) : null;
  const todaysEventCount = getEventsForDate(dstr(TODAY)).length;
  const next = pickNextHighlight();
  const dateFmt = TODAY.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long' }).toUpperCase();
  const weekNum = isoWeekNumber(TODAY);

  const el = document.getElementById('page-home');
  el.innerHTML = `
    <div class="flex items-center justify-between pt-2 pb-1">
      <span class="font-label-sm text-label-sm text-primary font-bold flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-primary inline-block"></span>${dateFmt}</span>
      <span class="px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface-variant font-label-sm text-label-sm">Semaine ${weekNum}</span>
    </div>
    <h1 class="font-display text-display text-on-surface mt-1">Bonjour, ${state.user.name.split(' ')[0]}</h1>
    <p class="font-body-lg text-body-lg text-on-surface-variant mt-1 mb-5">${pickGreeting()}</p>

    <div class="rounded-[20px] bg-surface-container p-card-padding border border-white/[0.06]">
      <div class="flex items-start justify-between">
        <div>
          <span class="font-label-sm text-label-sm text-on-surface-variant tracking-wider">SCORE D'ACCOMPLISSEMENT</span>
          <div class="flex items-baseline gap-1.5 mt-1">
            <span class="font-display text-display text-on-surface">${score === null ? '—' : score}</span>
            ${score !== null ? '<span class="font-headline-md text-headline-md text-on-surface-variant">/100</span>' : ''}
          </div>
          <p class="font-label-md text-label-md text-on-surface-variant mt-1">${homeScoreNote(score)}</p>
        </div>
        <div class="w-11 h-11 rounded-full bg-surface-container-high flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-primary text-[22px]">insights</span>
        </div>
      </div>
      <div class="h-1.5 w-full rounded-full bg-surface-container-highest overflow-hidden mt-4">
        <div class="h-full rounded-full bg-gradient-to-r from-primary to-secondary" style="width:${scorePct}%"></div>
      </div>
      <div class="mt-4 pt-4 border-t border-white/[0.06] grid grid-cols-3 gap-2 text-center">
        <div><span class="font-label-sm text-label-sm text-on-surface-variant block mb-0.5">Terminées</span><span class="font-headline-md text-headline-md text-on-surface font-bold">${done}${todays.length ? `/${state.settings.dailyGoal}` : ''}</span></div>
        <div><span class="font-label-sm text-label-sm text-on-surface-variant block mb-0.5">Restantes</span><span class="font-headline-md text-headline-md text-primary font-bold">${pending.length}</span></div>
        <div><span class="font-label-sm text-label-sm text-on-surface-variant block mb-0.5">Focus</span><span class="font-headline-md text-headline-md text-on-surface font-bold">${state.settings.focusMinutes}min</span></div>
      </div>
    </div>

    ${next ? `
    <div class="mt-5 rounded-[20px] bg-surface-container-high p-card-padding border border-primary/25 shadow-[0_0_24px_rgba(255,31,143,0.08)] cursor-pointer" data-action="go-next" data-tab="${next.tab}">
      <div class="flex items-center gap-1.5 mb-1.5">
        <span class="px-2 py-0.5 rounded-full bg-primary-container/25 text-primary font-label-sm text-label-sm font-semibold uppercase">Next</span>
        <span class="font-label-sm text-label-sm text-on-surface-variant">${next.kind === 'task' ? 'Tâche' : 'Événement'}</span>
      </div>
      <h3 class="font-headline-md text-headline-md text-on-surface">${next.title}</h3>
      <div class="flex items-center gap-1.5 mt-2 text-on-surface-variant">
        <span class="material-symbols-outlined text-[16px]">schedule</span>
        <span class="font-label-md text-label-md">Aujourd'hui · ${next.timeLabel}</span>
      </div>
      ${next.kind === 'task' ? `
      <div class="flex gap-2 mt-4">
        <button data-action="snooze-task" data-id="${next.id}" class="flex-1 py-2.5 rounded-xl bg-surface-container text-on-surface-variant font-body-md text-body-md flex items-center justify-center gap-1.5 active:scale-95 transition-transform"><span class="material-symbols-outlined text-[18px]">history</span>Reporter</button>
        <button data-action="complete-task" data-id="${next.id}" class="flex-1 py-2.5 rounded-xl bg-primary text-on-primary font-body-md text-body-md font-semibold flex items-center justify-center gap-1.5 active:scale-95 transition-transform"><span class="material-symbols-outlined text-[18px]">check</span>Terminer</button>
      </div>` : ''}
    </div>
    ${next.imminent && state.settings.remindersEnabled ? `
    <div class="mt-2.5 rounded-2xl bg-primary/10 border border-primary/25 p-3.5 flex items-center gap-2.5">
      <span class="material-symbols-outlined text-primary text-[18px]">notifications_active</span>
      <p class="font-label-md text-label-md text-on-surface">C'est bientôt : <strong>${next.title}</strong> à ${next.timeLabel}.</p>
    </div>` : ''}
    ` : todays.length === 0 ? `
    <div class="mt-5 rounded-[20px] bg-surface-container p-card-padding text-center">
      <p class="font-body-md text-body-md text-on-surface-variant mb-3">Aucune tâche pour l'instant. Ajoute ta première tâche pour lancer ta journée.</p>
      <button data-action="open-add-task" class="px-4 py-2 rounded-xl bg-primary text-on-primary font-body-md text-body-md font-semibold inline-flex items-center gap-1.5"><span class="material-symbols-outlined text-[16px]">add</span>Ajouter une tâche</button>
    </div>` : `
    <div class="mt-5 rounded-[20px] bg-surface-container p-card-padding text-center">
      <p class="font-body-md text-body-md text-on-surface-variant">Rien de prévu pour la suite de la journée. Belle journée !</p>
    </div>`}

    <div class="flex items-center justify-between mt-6 mb-2">
      <span class="font-label-sm text-label-sm text-on-surface-variant tracking-wider">AUJOURD'HUI</span>
    </div>
    <div class="flex flex-col gap-2 rounded-2xl bg-surface-container overflow-hidden divide-y divide-white/[0.06]">
      <button data-nav-to="todo" class="w-full p-3.5 flex items-center gap-3 text-left active:bg-surface-container-high transition-colors">
        <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-primary shrink-0"><span class="material-symbols-outlined text-[18px]">task_alt</span></div>
        <div class="min-w-0 flex-1">
          <p class="font-body-md text-body-md text-on-surface">${todays.length ? `${done}/${todays.length} tâches terminées` : 'Aucune tâche aujourd\u2019hui'}</p>
        </div>
        <span class="material-symbols-outlined text-on-surface-variant text-[18px]">chevron_right</span>
      </button>
      <button data-nav-to="goals" class="w-full p-3.5 flex items-center gap-3 text-left active:bg-surface-container-high transition-colors">
        <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-tertiary shrink-0"><span class="material-symbols-outlined text-[18px]">track_changes</span></div>
        <div class="min-w-0 flex-1">
          <p class="font-body-md text-body-md text-on-surface truncate">${focusGoal ? focusGoal.title : 'Aucun objectif actif — en choisir un'}</p>
        </div>
        ${focusGoal ? `<span class="font-label-md text-label-md text-on-surface-variant shrink-0">${focusGoal.progress}%</span>` : ''}
        <span class="material-symbols-outlined text-on-surface-variant text-[18px]">chevron_right</span>
      </button>
      <button data-nav-to="calendar" class="w-full p-3.5 flex items-center gap-3 text-left active:bg-surface-container-high transition-colors">
        <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-secondary shrink-0"><span class="material-symbols-outlined text-[18px]">event</span></div>
        <div class="min-w-0 flex-1">
          <p class="font-body-md text-body-md text-on-surface">${todaysEventCount ? `${todaysEventCount} événement${todaysEventCount>1?'s':''} aujourd'hui` : 'Rien dans l\u2019agenda aujourd\u2019hui'}</p>
        </div>
        <span class="material-symbols-outlined text-on-surface-variant text-[18px]">chevron_right</span>
      </button>
    </div>

    <div class="flex items-center justify-between mt-6 mb-2">
      <span class="font-label-sm text-label-sm text-on-surface-variant tracking-wider">ACTIONS RAPIDES</span>
    </div>
    <div class="grid grid-cols-3 gap-2.5">
      <button data-action="open-add-task" class="quick-nav rounded-2xl bg-surface-container p-3 flex flex-col gap-2 active:scale-95 transition-transform text-left">
        <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-primary"><span class="material-symbols-outlined text-[18px]">add_task</span></div>
        <span class="font-label-sm text-label-sm text-on-surface-variant leading-tight">Nouvelle tâche</span>
      </button>
      <button data-action="quick-add-event" class="quick-nav rounded-2xl bg-surface-container p-3 flex flex-col gap-2 active:scale-95 transition-transform text-left">
        <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-tertiary"><span class="material-symbols-outlined text-[18px]">event</span></div>
        <span class="font-label-sm text-label-sm text-on-surface-variant leading-tight">Nouvel événement</span>
      </button>
      <button data-action="start-focus" class="quick-nav rounded-2xl bg-surface-container p-3 flex flex-col gap-2 active:scale-95 transition-transform text-left">
        <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-secondary"><span class="material-symbols-outlined text-[18px]">timer</span></div>
        <span class="font-label-sm text-label-sm text-on-surface-variant leading-tight">Lancer focus</span>
      </button>
    </div>
  `;

  el.querySelectorAll('[data-nav-to]').forEach(b => b.addEventListener('click', () => setActivePage(b.dataset.navTo)));
  el.querySelectorAll('[data-action="open-add-task"]').forEach(b => b.addEventListener('click', () => openAddTaskModal('today')));
  el.querySelector('[data-action="quick-add-event"]')?.addEventListener('click', () => openAddEventModal(dstr(TODAY)));
  el.querySelector('[data-action="start-focus"]')?.addEventListener('click', () => toast(`Session focus de ${state.settings.focusMinutes} min lancée`));
  el.querySelector('[data-action="go-next"]')?.addEventListener('click', (e) => {
    if(e.target.closest('[data-action="complete-task"]') || e.target.closest('[data-action="snooze-task"]')) return;
    setActivePage(e.currentTarget.dataset.tab);
  });
  el.querySelectorAll('[data-action="complete-task"]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); toggleTask(b.dataset.id); }));
  el.querySelectorAll('[data-action="snooze-task"]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); toast('Tâche reportée de 30 min'); }));
}

function toggleTask(id){
  const t = state.tasks.find(t => t.id === id);
  if(!t) return;
  t.done = !t.done;
  saveState();
  renderCurrentPage();
  toast(t.done ? 'Tâche terminée' : 'Tâche réactivée');
}

/* ===================== TODO ===================== */
let todoTab = 'today'; // today | longterme | done
let todoPriorityFilter = 'toutes';
let todoSearch = '';
let expandedTasks = new Set();

// Fait basculer automatiquement vers "Aujourd'hui" toute tâche Long Terme
// dont l'échéance est arrivée (aujourd'hui ou dépassée). Appelé au chargement,
// à chaque ouverture de l'onglet, et périodiquement (voir setInterval en bas).
function syncLongTermDueTasks(){
  const todayStr = dstr(TODAY);
  let moved = 0;
  state.tasks.forEach(t => {
    if(t.list === 'longterme' && t.dueDate && t.dueDate <= todayStr){
      t.list = 'today';
      t.date = todayStr;
      moved++;
    }
  });
  if(moved) saveState();
  return moved;
}
function formatDueDate(d){
  try{ const dt = new Date(d + 'T00:00:00'); return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }); }
  catch(e){ return d; }
}
function escapeAttr(s){ return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
function timeToInputVal(t){ if(!t) return ''; const m = /^(\d{1,2})h(\d{2})$/.exec(t); return m ? `${m[1].padStart(2,'0')}:${m[2]}` : ''; }
function inputValToTime(v){ if(!v) return ''; const [h,m] = v.split(':'); return `${parseInt(h,10)}h${m}`; }

function moveTaskInList(visibleList, id, dir){
  const pos = visibleList.findIndex(t => t.id === id);
  const targetPos = pos + dir;
  if(pos === -1 || targetPos < 0 || targetPos >= visibleList.length) return;
  const idxA = state.tasks.findIndex(t => t.id === visibleList[pos].id);
  const idxB = state.tasks.findIndex(t => t.id === visibleList[targetPos].id);
  if(idxA === -1 || idxB === -1) return;
  [state.tasks[idxA], state.tasks[idxB]] = [state.tasks[idxB], state.tasks[idxA]];
  saveState(); renderTodo();
}
function addSubtask(taskId, text){
  const t = state.tasks.find(x => x.id === taskId);
  if(!t || !text.trim()) return;
  if(!t.subtasks) t.subtasks = [];
  t.subtasks.push({ id: uid(), text: text.trim(), done: false });
  saveState(); renderTodo();
}
function toggleSubtask(taskId, subId){
  const t = state.tasks.find(x => x.id === taskId);
  const s = t && (t.subtasks || []).find(s => s.id === subId);
  if(!s) return;
  s.done = !s.done; saveState(); renderTodo();
}
function delSubtask(taskId, subId){
  const t = state.tasks.find(x => x.id === taskId);
  if(!t) return;
  t.subtasks = (t.subtasks || []).filter(s => s.id !== subId);
  saveState(); renderTodo();
}

function subtaskPanelHtml(t){
  const subs = t.subtasks || [];
  return `
    <div class="px-3.5 pb-3.5 pt-1">
      ${subs.map(s => `
      <div class="flex items-center gap-2 py-1.5 pl-8">
        <button data-action="toggle-subtask" data-task="${t.id}" data-sub="${s.id}" class="w-5 h-5 rounded-full border-2 ${s.done ? 'bg-primary border-primary' : 'border-outline-variant'} flex items-center justify-center shrink-0 transition-colors">
          ${s.done ? '<span class="material-symbols-outlined text-on-primary text-[12px]">check</span>' : ''}
        </button>
        <span class="font-label-md text-label-md flex-1 ${s.done ? 'line-through text-on-surface-variant' : 'text-on-surface'}">${s.text}</span>
        <button data-action="del-subtask" data-task="${t.id}" data-sub="${s.id}" class="w-6 h-6 rounded-full flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[14px]">close</span></button>
      </div>`).join('')}
      <div class="flex items-center gap-2 mt-1 pl-8">
        <input type="text" data-subtask-input="${t.id}" placeholder="Ajouter une sous-tâche..." class="flex-1 bg-surface-container-highest/50 rounded-lg px-2.5 py-1.5 outline-none font-label-md text-label-md text-on-surface placeholder:text-on-surface-variant"/>
        <button data-action="add-subtask" data-task="${t.id}" class="w-7 h-7 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[16px]">add</span></button>
      </div>
    </div>`;
}

function taskRowHtml(t, idx, list){
  const subs = t.subtasks || [];
  const expanded = expandedTasks.has(t.id);
  return `
  <div class="rounded-2xl bg-surface-container overflow-hidden">
    <div class="p-3.5 flex items-center gap-2">
      <div class="flex flex-col gap-0.5 shrink-0">
        <button data-action="move-up" data-id="${t.id}" ${idx===0?'disabled':''} class="w-5 h-4 rounded flex items-center justify-center text-on-surface-variant ${idx===0?'opacity-30':'active:scale-90'} transition-transform"><span class="material-symbols-outlined text-[14px]">keyboard_arrow_up</span></button>
        <button data-action="move-down" data-id="${t.id}" ${idx===list.length-1?'disabled':''} class="w-5 h-4 rounded flex items-center justify-center text-on-surface-variant ${idx===list.length-1?'opacity-30':'active:scale-90'} transition-transform"><span class="material-symbols-outlined text-[14px]">keyboard_arrow_down</span></button>
      </div>
      <button data-action="toggle" data-id="${t.id}" class="w-6 h-6 rounded-full border-2 ${t.done ? 'bg-primary border-primary' : 'border-outline-variant'} flex items-center justify-center shrink-0 transition-colors">
        ${t.done ? '<span class="material-symbols-outlined text-on-primary text-[16px]">check</span>' : ''}
      </button>
      <div class="min-w-0 flex-1">
        <p class="font-body-md text-body-md ${t.done ? 'line-through text-on-surface-variant' : 'text-on-surface'} truncate">${t.text}</p>
        <div class="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <span class="w-1.5 h-1.5 rounded-full ${priorityDot(t.priority)} inline-block"></span>
          <span class="font-label-sm text-label-sm text-on-surface-variant">${priorityLabel(t.priority)}</span>
          ${t.category ? `<span class="font-label-sm text-label-sm text-on-surface-variant">·</span><span class="px-1.5 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant font-label-sm text-label-sm">${t.category}</span>` : ''}
          ${t.list === 'longterme' && t.dueDate ? `<span class="font-label-sm text-label-sm text-on-surface-variant">·</span><span class="px-1.5 py-0.5 rounded-full bg-tertiary-container/25 text-tertiary font-label-sm text-label-sm flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">event</span>${formatDueDate(t.dueDate)}</span>` : ''}
          <button data-action="toggle-expand" data-id="${t.id}" class="ml-auto flex items-center gap-0.5 text-on-surface-variant font-label-sm text-label-sm shrink-0">
            ${subs.length ? `${subs.filter(s=>s.done).length}/${subs.length}` : ''}
            <span class="material-symbols-outlined text-[16px]">${expanded ? 'expand_less' : 'expand_more'}</span>
          </button>
        </div>
      </div>
      ${t.time ? `<span class="px-2 py-1 rounded-full bg-surface-container-high text-on-surface-variant font-label-sm text-label-sm shrink-0">${t.time}</span>` : ''}
      <button data-action="edit-task" data-id="${t.id}" class="w-7 h-7 rounded-full flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[16px]">edit</span></button>
      <button data-action="delete" data-id="${t.id}" class="w-7 h-7 rounded-full flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[16px]">close</span></button>
    </div>
    ${expanded ? subtaskPanelHtml(t) : ''}
  </div>`;
}

function openEditTaskModal(id){
  const t = state.tasks.find(x => x.id === id);
  if(!t) return;
  const isLongterme = t.list === 'longterme';
  let editedPriority = t.priority;
  openModal(`
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-headline-lg text-headline-lg text-on-surface">Modifier la tâche</h3>
      <button data-action="close" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[18px]">close</span></button>
    </div>
    <div class="flex flex-col gap-3">
      <input id="et-text" type="text" value="${escapeAttr(t.text)}" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
      <input id="et-category" type="text" value="${escapeAttr(t.category||'')}" placeholder="Catégorie (optionnel)" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
      <div class="flex items-center gap-2">
        <span class="font-label-sm text-label-sm text-on-surface-variant">Priorité:</span>
        <button data-etp="haute" class="et-p-dot w-6 h-6 rounded-full bg-primary ring-2 ring-offset-2 ring-offset-surface-container-low ${t.priority==='haute'?'ring-primary':'ring-transparent'}"></button>
        <button data-etp="normale" class="et-p-dot w-6 h-6 rounded-full bg-tertiary ring-2 ring-offset-2 ring-offset-surface-container-low ${t.priority==='normale'?'ring-tertiary':'ring-transparent'}"></button>
        <button data-etp="basse" class="et-p-dot w-6 h-6 rounded-full bg-outline-variant ring-2 ring-offset-2 ring-offset-surface-container-low ${t.priority==='basse'?'ring-outline-variant':'ring-transparent'}"></button>
      </div>
      ${!isLongterme ? `
      <div>
        <label class="font-label-sm text-label-sm text-on-surface-variant block mb-1.5">Heure (optionnel)</label>
        <input id="et-time" type="time" value="${timeToInputVal(t.time)}" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
      </div>` : `
      <div>
        <label class="font-label-sm text-label-sm text-on-surface-variant block mb-1.5">Échéance</label>
        <input id="et-due" type="date" value="${t.dueDate||''}" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
      </div>`}
      <button id="btn-save-task-edit" class="mt-2 w-full py-3.5 rounded-xl bg-primary text-on-primary font-headline-md text-headline-md font-semibold active:scale-[0.98] transition-all">Enregistrer</button>
    </div>
  `);
  document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
  document.querySelectorAll('.et-p-dot').forEach(b => b.addEventListener('click', () => {
    editedPriority = b.dataset.etp;
    document.querySelectorAll('.et-p-dot').forEach(x => x.classList.remove('ring-primary','ring-tertiary','ring-outline-variant'));
    document.querySelectorAll('.et-p-dot').forEach(x => x.classList.add('ring-transparent'));
    b.classList.remove('ring-transparent');
    b.classList.add(editedPriority==='haute'?'ring-primary':editedPriority==='normale'?'ring-tertiary':'ring-outline-variant');
  }));
  document.getElementById('btn-save-task-edit').addEventListener('click', () => {
    const newText = document.getElementById('et-text').value.trim();
    if(!newText){ toast('Le titre ne peut pas être vide'); return; }
    t.text = newText;
    t.category = document.getElementById('et-category').value.trim();
    t.priority = editedPriority;
    if(!isLongterme){
      const timeVal = document.getElementById('et-time').value;
      t.time = timeVal ? inputValToTime(timeVal) : '';
    } else {
      t.dueDate = document.getElementById('et-due').value || '';
    }
    saveState();
    syncLongTermDueTasks();
    closeModal(); renderTodo(); toast('Tâche mise à jour');
  });
}

function renderTodo(){
  syncLongTermDueTasks();
  const el = document.getElementById('page-todo');
  const allToday = state.tasks.filter(t => t.list === 'today');
  const inProgress = allToday.filter(t => !t.done).length;
  const completed = allToday.filter(t => t.done).length;
  const pct = Math.round((completed/Math.max(1, allToday.length))*100);

  let list;
  if(todoTab === 'today') list = allToday.filter(t => !t.done);
  else if(todoTab === 'longterme') list = state.tasks.filter(t => t.list === 'longterme');
  else list = allToday.filter(t => t.done);

  if(todoPriorityFilter !== 'toutes') list = list.filter(t => t.priority === todoPriorityFilter);
  if(todoSearch.trim()) list = list.filter(t => t.text.toLowerCase().includes(todoSearch.trim().toLowerCase()));

  el.innerHTML = `
    <div class="pt-2">
      <h1 class="font-headline-lg text-headline-lg text-on-surface">Mes Tâches</h1>
      <div class="flex items-center gap-2 mt-1">
        <span class="px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant font-label-sm text-label-sm">${inProgress} en cours</span>
        <span class="font-label-sm text-label-sm text-on-surface-variant">·</span>
        <span class="font-label-sm text-label-sm text-on-surface-variant">${completed} terminées</span>
      </div>
      <p class="font-body-lg text-body-lg text-on-surface-variant mt-1">Gérez vos priorités du jour avec précision.</p>
      <div class="h-1 w-full rounded-full bg-surface-container-highest overflow-hidden mt-4">
        <div class="h-full rounded-full bg-primary" style="width:${pct}%"></div>
      </div>
    </div>

    <div class="mt-4 rounded-2xl bg-surface-container p-3 flex items-center gap-2.5">
      <span class="material-symbols-outlined text-on-surface-variant text-[20px]">search</span>
      <input id="todo-search" type="text" value="${escapeAttr(todoSearch)}" placeholder="Rechercher une tâche..." class="flex-1 bg-transparent outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant"/>
      ${todoSearch ? `<button id="btn-clear-search" class="w-6 h-6 rounded-full flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[16px]">close</span></button>` : ''}
    </div>

    <div class="flex gap-2 mt-3 overflow-x-auto no-scrollbar">
      ${['today','longterme','done'].map(k => `
        <button data-tab="${k}" class="todo-tab px-4 py-2 rounded-full font-label-md text-label-md whitespace-nowrap transition-colors ${todoTab===k ? 'bg-surface-container-highest text-on-surface font-semibold' : 'bg-surface-container text-on-surface-variant'}">
          ${k==='today'?"Aujourd'hui":k==='longterme'?'Long Terme':'Terminées'}
        </button>`).join('')}
    </div>

    <div class="flex gap-2 mt-3 overflow-x-auto no-scrollbar">
      ${[['toutes','Toutes',''],['haute','Haute','bg-primary'],['normale','Normale','bg-tertiary'],['basse','Basse','bg-outline-variant']].map(([k,label,dot]) => `
        <button data-pf="${k}" class="pf-btn px-3.5 py-1.5 rounded-full font-label-md text-label-md whitespace-nowrap flex items-center gap-1.5 transition-colors ${todoPriorityFilter===k ? 'bg-surface-container-highest text-on-surface' : 'bg-surface-container text-on-surface-variant'}">
          ${dot ? `<span class="w-1.5 h-1.5 rounded-full ${dot} inline-block"></span>` : ''}${label}
        </button>`).join('')}
    </div>

    <div class="mt-4 rounded-2xl bg-surface-container p-3.5 flex items-center gap-2.5">
      <span class="material-symbols-outlined text-primary text-[20px]">add_task</span>
      <input id="new-task-input" type="text" placeholder="Ajouter une tâche..." class="flex-1 bg-transparent outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant"/>
    </div>
    <div class="flex items-center justify-between mt-2.5 gap-2">
      <div class="flex items-center gap-2">
        <span class="font-label-sm text-label-sm text-on-surface-variant">Priorité:</span>
        <button data-newp="haute" class="new-p-dot w-5 h-5 rounded-full bg-primary ring-2 ring-offset-2 ring-offset-surface ring-primary transition-all"></button>
        <button data-newp="normale" class="new-p-dot w-5 h-5 rounded-full bg-tertiary ring-2 ring-offset-2 ring-offset-surface ring-transparent transition-all"></button>
        <button data-newp="basse" class="new-p-dot w-5 h-5 rounded-full bg-outline-variant ring-2 ring-offset-2 ring-offset-surface ring-transparent transition-all"></button>
      </div>
      ${todoTab === 'longterme' ? `<input id="new-task-due" type="date" title="Échéance (obligatoire)" class="bg-surface-container-highest/60 border border-white/10 rounded-lg px-2 py-1.5 outline-none font-label-md text-label-md text-on-surface focus:border-primary"/>` : ''}
      <button id="btn-add-task" class="w-10 h-10 rounded-xl bg-primary text-on-primary flex items-center justify-center active:scale-90 transition-transform shrink-0"><span class="material-symbols-outlined text-[20px]">add</span></button>
    </div>
    ${todoTab === 'longterme' ? `<p class="font-label-sm text-label-sm text-on-surface-variant mt-1.5">Une échéance est requise — la tâche rejoindra automatiquement "Aujourd'hui" le jour J.</p>` : ''}

    <div class="flex items-center justify-between mt-6 mb-2">
      <span class="font-label-sm text-label-sm text-on-surface-variant tracking-wider">${todoTab==='today' ? "À FAIRE AUJOURD'HUI" : todoTab==='longterme' ? 'OBJECTIFS LONG TERME' : 'TERMINÉES AUJOURD\u2019HUI'}</span>
      <span class="font-label-sm text-label-sm text-on-surface-variant">${list.length} ${todoTab==='done' ? 'tâches' : 'restantes'}</span>
    </div>
    <div class="flex flex-col gap-2.5" id="task-list">
      ${list.length === 0 ? `<div class="rounded-2xl bg-surface-container p-6 text-center"><p class="font-body-md text-body-md text-on-surface-variant">${todoSearch ? 'Aucun résultat pour cette recherche.' : "Rien ici pour l'instant."}</p></div>` : list.map((t, idx) => taskRowHtml(t, idx, list)).join('')}
    </div>
  `;

  let newPriority = 'haute';
  el.querySelectorAll('.todo-tab').forEach(b => b.addEventListener('click', () => { todoTab = b.dataset.tab; renderTodo(); }));
  el.querySelectorAll('.pf-btn').forEach(b => b.addEventListener('click', () => { todoPriorityFilter = b.dataset.pf; renderTodo(); }));
  el.querySelectorAll('.new-p-dot').forEach(b => b.addEventListener('click', () => {
    newPriority = b.dataset.newp;
    el.querySelectorAll('.new-p-dot').forEach(x => x.classList.remove('ring-primary','ring-tertiary','ring-outline-variant'));
    el.querySelectorAll('.new-p-dot').forEach(x => x.classList.add('ring-transparent'));
    b.classList.remove('ring-transparent');
    b.classList.add(newPriority==='haute'?'ring-primary':newPriority==='normale'?'ring-tertiary':'ring-outline-variant');
  }));

  let searchDebounce;
  el.querySelector('#todo-search').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    const val = e.target.value;
    searchDebounce = setTimeout(() => { todoSearch = val; renderTodo(); setTimeout(() => { const inp = document.getElementById('todo-search'); if(inp){ inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }, 0); }, 250);
  });
  el.querySelector('#btn-clear-search')?.addEventListener('click', () => { todoSearch = ''; renderTodo(); });

  function addFromInput(){
    const input = document.getElementById('new-task-input');
    const text = input.value.trim();
    if(!text) return;
    let dueDate = '';
    if(todoTab === 'longterme'){
      const dueInput = document.getElementById('new-task-due');
      dueDate = dueInput ? dueInput.value : '';
      if(!dueDate){ toast('Ajoute une échéance pour cette tâche long terme'); return; }
    }
    state.tasks.push({ id: uid(), text, priority: newPriority, category: '', time: '', dueDate, subtasks: [], done: false, list: todoTab==='longterme' ? 'longterme' : 'today', date: dstr(TODAY) });
    input.value = '';
    saveState();
    syncLongTermDueTasks();
    renderTodo(); toast('Tâche ajoutée');
  }
  el.querySelector('#btn-add-task').addEventListener('click', addFromInput);
  el.querySelector('#new-task-input').addEventListener('keydown', (e) => { if(e.key==='Enter') addFromInput(); });

  el.querySelectorAll('[data-action="toggle"]').forEach(b => b.addEventListener('click', () => toggleTask(b.dataset.id)));
  el.querySelectorAll('[data-action="delete"]').forEach(b => b.addEventListener('click', () => {
    state.tasks = state.tasks.filter(t => t.id !== b.dataset.id);
    expandedTasks.delete(b.dataset.id);
    saveState(); renderTodo(); toast('Tâche supprimée');
  }));
  el.querySelectorAll('[data-action="edit-task"]').forEach(b => b.addEventListener('click', () => openEditTaskModal(b.dataset.id)));
  el.querySelectorAll('[data-action="move-up"]').forEach(b => b.addEventListener('click', () => moveTaskInList(list, b.dataset.id, -1)));
  el.querySelectorAll('[data-action="move-down"]').forEach(b => b.addEventListener('click', () => moveTaskInList(list, b.dataset.id, 1)));
  el.querySelectorAll('[data-action="toggle-expand"]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.id;
    if(expandedTasks.has(id)) expandedTasks.delete(id); else expandedTasks.add(id);
    renderTodo();
  }));
  el.querySelectorAll('[data-action="toggle-subtask"]').forEach(b => b.addEventListener('click', () => toggleSubtask(b.dataset.task, b.dataset.sub)));
  el.querySelectorAll('[data-action="del-subtask"]').forEach(b => b.addEventListener('click', () => delSubtask(b.dataset.task, b.dataset.sub)));
  el.querySelectorAll('[data-action="add-subtask"]').forEach(b => b.addEventListener('click', () => {
    const input = el.querySelector(`[data-subtask-input="${b.dataset.task}"]`);
    if(input && input.value.trim()){ addSubtask(b.dataset.task, input.value); }
  }));
  el.querySelectorAll('[data-subtask-input]').forEach(inp => inp.addEventListener('keydown', (e) => {
    if(e.key === 'Enter' && inp.value.trim()) addSubtask(inp.dataset.subtaskInput, inp.value);
  }));
}

function openAddTaskModal(){
  setActivePage('todo');
  setTimeout(() => document.getElementById('new-task-input')?.focus(), 50);
}

/* ===================== CALENDAR ===================== */
let calendarSearch = '';
const DAY_ROW_HEIGHT = 52; // px par heure dans la grille "Jour"

function renderCalendar(){
  const el = document.getElementById('page-calendar');
  const view = state.settings.calendarView;
  const selected = new Date(state.selectedDate + 'T00:00:00');

  let headerLabel, bodyHtml;
  if(view === 'Jour'){
    headerLabel = capitalize(selected.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));
    bodyHtml = renderDaySummary(selected) + renderDayTimeGrid(selected);
  } else if(view === 'Mois'){
    headerLabel = capitalize(selected.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));
    bodyHtml = renderMonthGrid(selected) + renderDaySummary(selected) + renderTimeline(selected);
  } else if(view === 'Liste'){
    headerLabel = 'Tous les événements';
    bodyHtml = renderEventsList();
  } else { // Semaine
    const weekStart = startOfWeek(selected);
    const days = Array.from({length:7}, (_,i) => addDays(weekStart, i));
    headerLabel = capitalize(selected.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));
    bodyHtml = renderDayStrip(days, selected) + renderDaySummary(selected) + renderTimeline(selected);
  }

  el.innerHTML = `
    <div class="pt-2 flex items-center justify-between">
      <div class="flex items-center gap-element-margin">
        <h2 class="font-headline-lg text-headline-lg text-on-surface tracking-tight capitalize">${headerLabel}</h2>
        <button id="btn-today" class="px-2.5 py-1 rounded-full bg-surface-container-high text-tertiary font-label-sm text-label-sm uppercase tracking-wider active:scale-95 transition-transform">Aujourd'hui</button>
      </div>
      ${view !== 'Liste' ? `
      <div class="flex items-center gap-tight-margin">
        <button id="btn-prev" class="w-8 h-8 rounded-full bg-surface-container flex items-center justify-center text-on-surface-variant active:scale-90 transition-transform"><span class="material-symbols-outlined text-[18px]">chevron_left</span></button>
        <button id="btn-next" class="w-8 h-8 rounded-full bg-surface-container flex items-center justify-center text-on-surface-variant active:scale-90 transition-transform"><span class="material-symbols-outlined text-[18px]">chevron_right</span></button>
      </div>` : ''}
    </div>

    <div class="mt-3 p-1 rounded-full bg-surface-container-lowest flex items-center justify-between">
      ${['Jour','Semaine','Mois','Liste'].map(v => `<button data-view="${v}" class="view-pill flex-1 py-1.5 rounded-full text-center font-label-md text-label-md transition-all ${view===v ? 'bg-primary-container text-on-primary-container font-semibold shadow-sm' : 'text-on-surface-variant'}">${v}</button>`).join('')}
    </div>

    ${bodyHtml}

    <div class="mt-8 flex justify-center w-full">
      <button id="btn-new-event" class="w-full py-3.5 px-6 rounded-xl bg-primary text-on-primary font-headline-md text-headline-md font-semibold flex items-center justify-center gap-2 shadow-[0_4px_24px_rgba(255,176,201,0.25)] active:scale-[0.98] transition-all">
        <span class="material-symbols-outlined text-[22px]">add</span><span>Nouvel événement</span>
      </button>
    </div>
  `;

  el.querySelectorAll('.view-pill').forEach(b => b.addEventListener('click', () => { state.settings.calendarView = b.dataset.view; saveState(); renderCalendar(); }));
  el.querySelectorAll('.day-card').forEach(b => b.addEventListener('click', () => { state.selectedDate = b.dataset.day; saveState(); renderCalendar(); }));
  el.querySelectorAll('.month-cell').forEach(b => b.addEventListener('click', () => { state.selectedDate = b.dataset.day; saveState(); renderCalendar(); }));
  el.querySelector('#btn-today')?.addEventListener('click', () => { state.selectedDate = dstr(TODAY); saveState(); renderCalendar(); });
  el.querySelector('#btn-prev')?.addEventListener('click', () => navigateCalendar(view, selected, -1));
  el.querySelector('#btn-next')?.addEventListener('click', () => navigateCalendar(view, selected, 1));
  el.querySelector('#btn-new-event')?.addEventListener('click', () => openAddEventModal(dstr(selected)));
  el.querySelectorAll('[data-action="del-event"]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    handleDeleteEventClick(b.dataset.master, b.dataset.date);
  }));
  el.querySelectorAll('[data-action="view-event"]').forEach(b => b.addEventListener('click', () => openEventDetailModal(b.dataset.master, b.dataset.date)));
  el.querySelectorAll('[data-action="go-to-date"]').forEach(b => b.addEventListener('click', () => {
    state.selectedDate = b.dataset.date;
    state.settings.calendarView = 'Jour';
    saveState(); renderCalendar();
  }));
  let searchDebounce;
  el.querySelector('#cal-search')?.addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    const val = e.target.value;
    searchDebounce = setTimeout(() => { calendarSearch = val; renderCalendar(); setTimeout(() => { const inp = document.getElementById('cal-search'); if(inp){ inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }, 0); }, 250);
  });
  el.querySelector('#btn-clear-cal-search')?.addEventListener('click', () => { calendarSearch = ''; renderCalendar(); });
}

function navigateCalendar(view, selected, dir){
  if(view === 'Jour') state.selectedDate = dstr(addDays(selected, dir));
  else if(view === 'Mois'){ const d = new Date(selected); d.setMonth(d.getMonth()+dir); state.selectedDate = dstr(d); }
  else state.selectedDate = dstr(addDays(selected, dir*7)); // Semaine
  saveState(); renderCalendar();
}

function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

function renderDayStrip(days, selected){
  const dayLabels = ['LUN','MAR','MER','JEU','VEN','SAM','DIM'];
  return `
    <div class="w-full mt-5 mb-6">
      <div class="flex items-center justify-between gap-tight-margin overflow-x-auto no-scrollbar py-1">
        ${days.map(d => {
          const isSel = dstr(d) === dstr(selected);
          const hasEvents = getEventsForDate(dstr(d)).length > 0;
          return `
          <button data-day="${dstr(d)}" class="day-card ${days.length===1 ? 'w-28' : 'flex-1 min-w-[44px]'} py-2.5 rounded-xl ${isSel ? 'bg-primary-container text-on-primary-container shadow-[0_0_20px_rgba(255,72,152,0.4)] scale-105' : 'bg-surface-container'} flex flex-col items-center justify-center gap-tight-margin transition-all">
            <span class="font-label-sm text-label-sm ${isSel ? 'text-on-primary-container font-bold' : 'text-on-surface-variant font-medium'}">${dayLabels[(d.getDay()+6)%7]}</span>
            <span class="font-headline-md text-headline-md ${isSel ? 'font-bold text-on-primary-container' : 'text-on-surface'}">${d.getDate()}</span>
            <span class="w-1.5 h-1.5 rounded-full ${isSel ? 'bg-on-primary-container' : hasEvents ? 'bg-primary' : 'bg-outline-variant'}"></span>
          </button>`;
        }).join('')}
      </div>
    </div>`;
}

function renderMonthGrid(selected){
  const year = selected.getFullYear(), month = selected.getMonth();
  const gridStart = startOfWeek(new Date(year, month, 1));
  const cells = Array.from({length:42}, (_,i) => addDays(gridStart, i));
  return `
    <div class="w-full mt-5 mb-6">
      <div class="grid grid-cols-7 gap-1 mb-1.5">
        ${['L','M','M','J','V','S','D'].map(l => `<span class="text-center font-label-sm text-label-sm text-on-surface-variant">${l}</span>`).join('')}
      </div>
      <div class="grid grid-cols-7 gap-1">
        ${cells.map(d => {
          const inMonth = d.getMonth() === month;
          const isSel = dstr(d) === dstr(selected);
          const isToday = dstr(d) === dstr(TODAY);
          const hasEvents = getEventsForDate(dstr(d)).length > 0;
          return `
          <button data-day="${dstr(d)}" class="month-cell aspect-square rounded-lg flex flex-col items-center justify-center gap-0.5 ${isSel ? 'bg-primary-container text-on-primary-container' : isToday ? 'bg-surface-container-highest' : 'bg-surface-container/60'} ${!inMonth ? 'opacity-30' : ''} transition-all">
            <span class="font-label-md text-label-md ${isSel ? 'text-on-primary-container font-bold' : 'text-on-surface'}">${d.getDate()}</span>
            <span class="w-1 h-1 rounded-full ${isSel ? 'bg-on-primary-container' : hasEvents ? 'bg-primary' : 'bg-transparent'}"></span>
          </button>`;
        }).join('')}
      </div>
    </div>`;
}

function renderDaySummary(selected){
  const dayEvents = getEventsForDate(dstr(selected));
  const timed = dayEvents.filter(e => !e.allDay);
  const totalMinutes = timed.reduce((acc,e) => acc + (toMin(e.end)-toMin(e.start)), 0);
  return `
    <div class="rounded-2xl bg-surface-container-low p-3.5 flex items-center justify-between mb-5 mt-5">
      <div class="flex items-center gap-2.5">
        <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-primary"><span class="material-symbols-outlined text-[18px]">insights</span></div>
        <div>
          <p class="font-headline-md text-headline-md text-on-surface capitalize">${selected.toLocaleDateString('fr-FR',{weekday:'long', day:'numeric', month:'long'})}</p>
          <p class="font-label-sm text-label-sm text-on-surface-variant">${dayEvents.length} événement${dayEvents.length>1?'s':''} · ${(totalMinutes/60).toFixed(1)}h réservées</p>
        </div>
      </div>
      <span class="px-2.5 py-1 rounded-full bg-primary/15 text-primary font-label-sm text-label-sm font-semibold">${dstr(selected)===dstr(TODAY) ? 'ACTIF' : ''}</span>
    </div>`;
}

function eventCardHtml(ev){
  return `
      <div class="flex gap-stack-gap">
        <div class="w-11 pt-1 text-right shrink-0"><span class="font-label-sm text-label-sm text-on-surface-variant font-medium">${ev.allDay ? '' : ev.start}</span></div>
        <button data-action="view-event" data-master="${ev.id}" data-date="${ev.occurrenceDate}" class="flex-1 relative bg-surface-container rounded-xl p-card-padding overflow-hidden text-left">
          <div class="absolute left-0 top-0 bottom-0 w-1 ${catColor(ev.category)}"></div>
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-tight-margin mb-1 flex-wrap">
                <span class="px-2 py-0.5 rounded-full ${catBadge(ev.category)} font-label-sm text-label-sm font-semibold tracking-wide uppercase">${ev.category}</span>
                <span class="font-label-sm text-label-sm text-on-surface-variant">${ev.allDay ? 'Toute la journée' : `${ev.start} - ${ev.end}`}</span>
                ${ev.recurrence ? `<span class="material-symbols-outlined text-on-surface-variant text-[14px]">repeat</span>` : ''}
              </div>
              <h3 class="font-headline-md text-headline-md text-on-surface truncate">${ev.title}</h3>
              ${ev.location ? `<p class="font-label-sm text-label-sm text-on-surface-variant truncate mt-0.5 flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">location_on</span>${ev.location}</p>` : ''}
              ${ev.desc ? `<p class="font-body-md text-body-md text-on-surface-variant truncate mt-0.5">${ev.desc}</p>` : ''}
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <div class="w-7 h-7 rounded-full bg-surface-container-high flex items-center justify-center ${catText(ev.category)}"><span class="material-symbols-outlined text-[16px]">${ev.icon}</span></div>
              <span data-action="del-event" data-master="${ev.id}" data-date="${ev.occurrenceDate}" class="w-7 h-7 rounded-full flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[16px]">close</span></span>
            </div>
          </div>
        </button>
      </div>`;
}

function renderTimeline(selected){
  const dayEvents = getEventsForDate(dstr(selected)).sort((a,b) => (a.allDay?-1:0) - (b.allDay?-1:0) || a.start.localeCompare(b.start));
  return `
    <div class="flex flex-col gap-4" id="events-timeline">
      ${dayEvents.length === 0 ? `<div class="rounded-2xl bg-surface-container p-6 text-center"><p class="font-body-md text-body-md text-on-surface-variant">Aucun événement ce jour.</p></div>` : dayEvents.map(eventCardHtml).join('')}
    </div>`;
}

// Grille horaire proportionnelle pour la vue "Jour" : les événements sont
// positionnés et dimensionnés selon leur heure/durée réelle.
function renderDayTimeGrid(selected){
  const dateStr = dstr(selected);
  const dayEvents = getEventsForDate(dateStr);
  const allDay = dayEvents.filter(e => e.allDay);
  const timed = dayEvents.filter(e => !e.allDay);
  const isToday = dateStr === dstr(TODAY);
  const now = new Date();
  const nowTop = (now.getHours()*60 + now.getMinutes()) / 60 * DAY_ROW_HEIGHT;

  const allDayHtml = allDay.length ? `
    <div class="flex flex-wrap gap-1.5 mb-4">
      ${allDay.map(ev => `
        <button data-action="view-event" data-master="${ev.id}" data-date="${ev.occurrenceDate}" class="px-2.5 py-1.5 rounded-full ${catBadge(ev.category)} font-label-sm text-label-sm font-semibold flex items-center gap-1.5">
          ${ev.recurrence ? '<span class="material-symbols-outlined text-[12px]">repeat</span>' : ''}${ev.title}
        </button>`).join('')}
    </div>` : '';

  const gridHtml = `
    <div class="relative rounded-2xl bg-surface-container-low overflow-hidden" style="height:${24*DAY_ROW_HEIGHT}px">
      ${Array.from({length:24}).map((_,h) => `
        <div class="absolute left-0 right-0 border-t border-white/[0.06]" style="top:${h*DAY_ROW_HEIGHT}px">
          <span class="absolute -top-2.5 left-2 font-label-sm text-label-sm text-on-surface-variant/60">${String(h).padStart(2,'0')}h</span>
        </div>`).join('')}
      ${isToday ? `
        <div class="absolute left-0 right-0 z-20 flex items-center" style="top:${nowTop}px">
          <span class="w-2 h-2 rounded-full bg-primary -ml-1"></span>
          <span class="flex-1 h-[2px] bg-primary"></span>
        </div>` : ''}
      ${timed.map(ev => {
        const top = toMin(ev.start) / 60 * DAY_ROW_HEIGHT;
        const height = Math.max(30, (toMin(ev.end) - toMin(ev.start)) / 60 * DAY_ROW_HEIGHT);
        return `
        <button data-action="view-event" data-master="${ev.id}" data-date="${ev.occurrenceDate}" class="absolute rounded-lg ${catBadge(ev.category)} border-l-2 ${catColor(ev.category)} px-2 py-1 text-left overflow-hidden z-10" style="top:${top}px; height:${height}px; left:52px; right:10px;">
          <p class="font-label-sm text-label-sm font-semibold truncate leading-tight">${ev.title}</p>
          <p class="font-label-sm text-label-sm opacity-80 truncate leading-tight">${ev.start} - ${ev.end}</p>
        </button>`;
      }).join('')}
    </div>`;

  return `<div class="mt-5 mb-6">${allDayHtml}${timed.length === 0 && allDay.length === 0 ? `<div class="rounded-2xl bg-surface-container p-6 text-center mb-4"><p class="font-body-md text-body-md text-on-surface-variant">Aucun événement ce jour.</p></div>` : ''}<div class="overflow-y-auto no-scrollbar" style="max-height:60vh">${gridHtml}</div></div>`;
}

// Vue "Liste" : chaque événement (série récurrente comprise) apparaît une
// seule fois, daté par son ancrage, avec la recherche.
function renderEventsList(){
  let entries = (state.events || []).slice().sort((a,b) => a.date === b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date));
  const q = calendarSearch.trim().toLowerCase();
  if(q) entries = entries.filter(e => e.title.toLowerCase().includes(q) || (e.location||'').toLowerCase().includes(q) || (e.desc||'').toLowerCase().includes(q));

  const searchBar = `
    <div class="mt-5 rounded-2xl bg-surface-container p-3 flex items-center gap-2.5">
      <span class="material-symbols-outlined text-on-surface-variant text-[20px]">search</span>
      <input id="cal-search" type="text" value="${escapeAttr(calendarSearch)}" placeholder="Rechercher un événement..." class="flex-1 bg-transparent outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant"/>
      ${calendarSearch ? `<button id="btn-clear-cal-search" class="w-6 h-6 rounded-full flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[16px]">close</span></button>` : ''}
    </div>`;

  if(entries.length === 0){
    return `${searchBar}<div class="mt-4 rounded-2xl bg-surface-container p-6 text-center"><p class="font-body-md text-body-md text-on-surface-variant">${q ? 'Aucun résultat pour cette recherche.' : 'Aucun événement planifié.'}</p></div>`;
  }

  let lastDate = null;
  let html = `${searchBar}<div class="mt-4 flex flex-col gap-4" id="events-timeline">`;
  entries.forEach(ev => {
    if(ev.date !== lastDate){
      lastDate = ev.date;
      const d = new Date(ev.date + 'T00:00:00');
      html += `<button data-action="go-to-date" data-date="${ev.date}" class="text-left font-label-sm text-label-sm text-primary tracking-wider mt-1 first:mt-0 capitalize">${d.toLocaleDateString('fr-FR',{weekday:'long', day:'numeric', month:'long'})}${ev.date===dstr(TODAY)?' · Aujourd\u2019hui':''}</button>`;
    }
    html += eventCardHtml({ ...ev, occurrenceDate: ev.date });
  });
  html += `</div>`;
  return html;
}

function toMin(t){ const [h,m] = t.split(':').map(Number); return h*60+m; }
function catColor(c){ return { 'Travail':'bg-primary', 'Personnel':'bg-tertiary', 'Focus':'bg-primary', 'Santé':'bg-secondary' }[c] || 'bg-outline-variant'; }
function catBadge(c){ return { 'Travail':'bg-primary-container/20 text-primary', 'Personnel':'bg-tertiary-container/30 text-tertiary', 'Focus':'bg-primary-container/20 text-primary', 'Santé':'bg-secondary-container text-on-secondary-container' }[c] || 'bg-surface-container-high text-on-surface-variant'; }
function catText(c){ return { 'Travail':'text-primary', 'Personnel':'text-tertiary', 'Focus':'text-primary', 'Santé':'text-secondary' }[c] || 'text-on-surface-variant'; }

// dateKey : date d'ancrage utilisée pour un NOUVEL événement.
// editMasterId : si fourni, on modifie l'événement (et donc toute sa série si récurrent) au lieu d'en créer un.
function openAddEventModal(dateKey, editMasterId){
  const existing = editMasterId ? state.events.find(e => e.id === editMasterId) : null;
  const icons = { 'Travail':'groups', 'Personnel':'restaurant', 'Focus':'bolt', 'Santé':'fitness_center' };
  const freq = existing?.recurrence?.freq || 'none';

  openModal(`
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-headline-lg text-headline-lg text-on-surface">${existing ? "Modifier l'événement" : 'Nouvel événement'}</h3>
      <button data-action="close" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[18px]">close</span></button>
    </div>
    ${existing?.recurrence ? `<p class="font-label-sm text-label-sm text-primary mb-3 flex items-center gap-1.5"><span class="material-symbols-outlined text-[14px]">repeat</span>Modifie toute la série récurrente</p>` : ''}
    <div class="flex flex-col gap-3">
      <input id="ev-title" type="text" value="${escapeAttr(existing?.title)}" placeholder="Titre de l'événement" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
      <input id="ev-desc" type="text" value="${escapeAttr(existing?.desc)}" placeholder="Description (optionnel)" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
      <input id="ev-location" type="text" value="${escapeAttr(existing?.location)}" placeholder="Lieu (optionnel)" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>

      <label class="flex items-center gap-2.5 py-1">
        <input id="ev-allday" type="checkbox" ${existing?.allDay ? 'checked' : ''} class="w-5 h-5 rounded border-2 border-outline-variant accent-[#ffb0c9]"/>
        <span class="font-body-md text-body-md text-on-surface">Toute la journée</span>
      </label>
      <div id="ev-time-row" class="flex gap-3 ${existing?.allDay ? 'hidden' : ''}">
        <input id="ev-start" type="time" value="${existing?.start || '09:00'}" class="flex-1 bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
        <input id="ev-end" type="time" value="${existing?.end || '10:00'}" class="flex-1 bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
      </div>

      <select id="ev-category" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary">
        ${['Travail','Personnel','Focus','Santé'].map(c => `<option value="${c}" ${existing?.category===c?'selected':''}>${c}</option>`).join('')}
      </select>

      <div>
        <label class="font-label-sm text-label-sm text-on-surface-variant block mb-1.5">Récurrence</label>
        <select id="ev-recurrence" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary">
          <option value="none" ${freq==='none'?'selected':''}>Aucune</option>
          <option value="daily" ${freq==='daily'?'selected':''}>Tous les jours</option>
          <option value="weekly" ${freq==='weekly'?'selected':''}>Toutes les semaines</option>
          <option value="monthly" ${freq==='monthly'?'selected':''}>Tous les mois</option>
          <option value="yearly" ${freq==='yearly'?'selected':''}>Tous les ans</option>
        </select>
      </div>
      <div id="ev-until-row" class="${freq==='none' ? 'hidden' : ''}">
        <label class="font-label-sm text-label-sm text-on-surface-variant block mb-1.5">Jusqu'au (optionnel)</label>
        <input id="ev-until" type="date" value="${existing?.recurrence?.until || ''}" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
      </div>

      <button id="btn-save-event" class="mt-2 w-full py-3.5 rounded-xl bg-primary text-on-primary font-headline-md text-headline-md font-semibold active:scale-[0.98] transition-all">${existing ? 'Enregistrer' : "Ajouter à l'agenda"}</button>
    </div>
  `);
  document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
  document.getElementById('ev-allday').addEventListener('change', (e) => {
    document.getElementById('ev-time-row').classList.toggle('hidden', e.target.checked);
  });
  document.getElementById('ev-recurrence').addEventListener('change', (e) => {
    document.getElementById('ev-until-row').classList.toggle('hidden', e.target.value === 'none');
  });
  document.getElementById('btn-save-event').addEventListener('click', () => {
    const title = document.getElementById('ev-title').value.trim();
    if(!title){ toast('Ajoute un titre'); return; }
    const allDay = document.getElementById('ev-allday').checked;
    const cat = document.getElementById('ev-category').value;
    const recFreq = document.getElementById('ev-recurrence').value;
    const recurrence = recFreq === 'none' ? null : { freq: recFreq, interval: 1, until: document.getElementById('ev-until').value || null };
    const payload = {
      title,
      desc: document.getElementById('ev-desc').value.trim(),
      location: document.getElementById('ev-location').value.trim(),
      allDay,
      start: allDay ? '00:00' : document.getElementById('ev-start').value,
      end: allDay ? '23:59' : document.getElementById('ev-end').value,
      category: cat,
      icon: icons[cat],
      recurrence
    };
    if(existing){
      Object.assign(existing, payload);
    } else {
      state.events.push({ id: uid(), date: dateKey, exceptions: [], ...payload });
    }
    saveState(); closeModal(); renderCalendar(); toast(existing ? 'Événement mis à jour' : 'Événement ajouté');
  });
}

/* ===================== GOALS ===================== */
let goalsFilter = 'Tous';
let expandedGoals = new Set();

function goalStatusLabel(progress){
  if(progress >= 100) return 'Atteint';
  if(progress === 0) return 'À démarrer';
  if(progress < 50) return 'En cours';
  return 'Bien avancé';
}
function goalStatusBadge(progress){
  if(progress >= 100) return 'bg-primary text-on-primary';
  if(progress === 0) return 'bg-surface-container-high text-on-surface-variant';
  return 'bg-tertiary-container/25 text-tertiary';
}
function formatGoalDeadline(d){
  if(!d) return '';
  try{ const dt = new Date(d + 'T00:00:00'); return capitalize(dt.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })); }
  catch(e){ return d; }
}
function recomputeGoalProgress(g){
  if(g.milestones && g.milestones.length){
    g.progress = Math.round(g.milestones.filter(m => m.done).length / g.milestones.length * 100);
  }
}
function addGoalMilestone(goalId, text){
  const g = state.goals.find(x => x.id === goalId);
  if(!g || !text.trim()) return;
  if(!g.milestones) g.milestones = [];
  g.milestones.push({ id: uid(), text: text.trim(), done: false });
  recomputeGoalProgress(g);
  saveState(); renderGoals();
}
function toggleGoalMilestone(goalId, msId){
  const g = state.goals.find(x => x.id === goalId);
  const m = g && (g.milestones || []).find(m => m.id === msId);
  if(!m) return;
  m.done = !m.done;
  recomputeGoalProgress(g);
  saveState(); renderGoals();
}
function delGoalMilestone(goalId, msId){
  const g = state.goals.find(x => x.id === goalId);
  if(!g) return;
  g.milestones = (g.milestones || []).filter(m => m.id !== msId);
  recomputeGoalProgress(g);
  saveState(); renderGoals();
}
function milestonePanelHtml(g){
  const ms = g.milestones || [];
  return `
    <div class="px-1 pb-1 pt-2">
      ${ms.map(m => `
      <div class="flex items-center gap-2 py-1.5">
        <button data-action="toggle-milestone" data-goal="${g.id}" data-ms="${m.id}" class="w-5 h-5 rounded-full border-2 ${m.done ? 'bg-primary border-primary' : 'border-outline-variant'} flex items-center justify-center shrink-0 transition-colors">
          ${m.done ? '<span class="material-symbols-outlined text-on-primary text-[12px]">check</span>' : ''}
        </button>
        <span class="font-label-md text-label-md flex-1 ${m.done ? 'line-through text-on-surface-variant' : 'text-on-surface'}">${m.text}</span>
        <button data-action="del-milestone" data-goal="${g.id}" data-ms="${m.id}" class="w-6 h-6 rounded-full flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[14px]">close</span></button>
      </div>`).join('')}
      <div class="flex items-center gap-2 mt-1">
        <input type="text" data-milestone-input="${g.id}" placeholder="Ajouter une étape..." class="flex-1 bg-surface-container-highest/50 rounded-lg px-2.5 py-1.5 outline-none font-label-md text-label-md text-on-surface placeholder:text-on-surface-variant"/>
        <button data-action="add-milestone" data-goal="${g.id}" class="w-7 h-7 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[16px]">add</span></button>
      </div>
    </div>`;
}

function renderGoals(){
  const el = document.getElementById('page-goals');
  const cats = ['Tous', ...Array.from(new Set(state.goals.map(g => g.category)))];
  const filtered = goalsFilter === 'Tous' ? state.goals : state.goals.filter(g => g.category === goalsFilter);
  const globalProgress = Math.round(state.goals.reduce((a,g) => a+g.progress,0) / Math.max(1,state.goals.length));
  const byCat = (name) => {
    const g = state.goals.filter(x => x.category.startsWith(name));
    if(!g.length) return null;
    return Math.round(g.reduce((a,x)=>a+x.progress,0)/g.length);
  };
  const career = byCat('Carrière'); const health = byCat('Santé'); const finance = byCat('Finances');
  const active = state.goals.filter(g => g.progress < 100).length;
  const reached = state.goals.filter(g => g.progress >= 100).length;
  const todayStr = dstr(TODAY);

  el.innerHTML = `
    <div class="pt-2 flex items-center justify-between">
      <div>
        <span class="font-label-sm text-label-sm text-primary font-bold flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-primary inline-block"></span>VISION & TRAJECTOIRE</span>
        <h1 class="font-headline-lg text-headline-lg text-on-surface mt-1">Objectifs de vie</h1>
      </div>
      <span class="px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface-variant font-label-sm text-label-sm whitespace-nowrap">${active} actifs · ${reached} atteints</span>
    </div>
    <p class="font-body-lg text-body-lg text-on-surface-variant mt-1 mb-4">Définissez et mesurez vos grandes ambitions.</p>

    <div class="flex gap-2.5 mb-5">
      <button id="btn-new-goal" class="flex-1 py-2.5 rounded-xl bg-primary text-on-primary font-body-md text-body-md font-semibold flex items-center justify-center gap-1.5 active:scale-95 transition-transform"><span class="material-symbols-outlined text-[18px]">add</span>Nouvel objectif</button>
      <button id="btn-goals-overview" class="flex-1 py-2.5 rounded-xl bg-surface-container-high text-on-surface font-body-md text-body-md flex items-center justify-center gap-1.5 active:scale-95 transition-transform"><span class="material-symbols-outlined text-[18px]">summarize</span>Aperçu</button>
    </div>

    <div class="rounded-[20px] bg-surface-container p-card-padding border border-white/[0.06]">
      <div class="flex items-center justify-between">
        <div>
          <span class="font-label-sm text-label-sm text-on-surface-variant tracking-wider flex items-center gap-1.5"><span class="material-symbols-outlined text-[16px]">insights</span>INDICATEUR CLÉ</span>
          <p class="font-headline-md text-headline-md text-on-surface mt-1">Progression globale</p>
        </div>
        <span class="font-display text-display text-primary">${globalProgress}<span class="text-headline-md">%</span></span>
      </div>
      <div class="h-1.5 w-full rounded-full bg-surface-container-highest overflow-hidden mt-3">
        <div class="h-full rounded-full bg-gradient-to-r from-primary to-secondary" style="width:${globalProgress}%"></div>
      </div>
      <div class="mt-4 grid grid-cols-3 gap-2.5">
        <div class="rounded-xl bg-surface-container-high p-2.5"><span class="font-label-sm text-label-sm text-on-surface-variant block">Carrière</span><span class="font-headline-md text-headline-md text-on-surface">${career ?? '--'}${career!==null?'%':''}</span></div>
        <div class="rounded-xl bg-surface-container-high p-2.5"><span class="font-label-sm text-label-sm text-on-surface-variant block">Santé</span><span class="font-headline-md text-headline-md text-on-surface">${health ?? '--'}${health!==null?'%':''}</span></div>
        <div class="rounded-xl bg-surface-container-high p-2.5"><span class="font-label-sm text-label-sm text-on-surface-variant block">Finances</span><span class="font-headline-md text-headline-md text-on-surface">${finance ?? '--'}${finance!==null?'%':''}</span></div>
      </div>
    </div>

    <div class="flex gap-2 mt-5 overflow-x-auto no-scrollbar">
      ${cats.map(c => `<button data-cat="${c}" class="cat-pill px-3.5 py-1.5 rounded-full font-label-md text-label-md whitespace-nowrap transition-colors ${goalsFilter===c ? 'bg-primary text-on-primary font-semibold' : 'bg-surface-container text-on-surface-variant'}">${c}${c==='Tous'?` (${state.goals.length})`:''}</button>`).join('')}
    </div>

    <div class="flex flex-col gap-3 mt-4">
      ${filtered.length===0 ? `<div class="rounded-2xl bg-surface-container p-6 text-center"><p class="font-body-md text-body-md text-on-surface-variant">Aucun objectif dans cette catégorie.</p></div>` : filtered.map(g => {
        const ms = g.milestones || [];
        const overdue = g.deadline && g.deadline < todayStr && g.progress < 100;
        const expanded = expandedGoals.has(g.id);
        return `
      <div class="rounded-2xl bg-surface-container p-card-padding ${g.progress>=100 ? 'border border-primary/25' : ''}">
        <div class="flex items-center justify-between mb-2 flex-wrap gap-1.5">
          <span class="px-2 py-0.5 rounded-full ${catBadge(g.category.startsWith('Carrière')?'Travail':g.category.startsWith('Santé')?'Santé':g.category.startsWith('Finances')?'Focus':'Personnel')} font-label-sm text-label-sm font-semibold">${g.category}</span>
          ${g.deadline ? `<span class="font-label-sm text-label-sm ${overdue ? 'text-error' : 'text-on-surface-variant'} flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">event</span>${overdue ? 'En retard' : formatGoalDeadline(g.deadline)}</span>` : ''}
          <span class="px-2 py-0.5 rounded-full ${goalStatusBadge(g.progress)} font-label-sm text-label-sm font-semibold ml-auto">${goalStatusLabel(g.progress)}</span>
        </div>
        <h3 class="font-headline-md text-headline-md text-on-surface">${g.title}</h3>
        <div class="flex items-center justify-between mt-2 mb-1.5">
          <span class="font-label-md text-label-md text-on-surface-variant">${g.metric}</span>
          <span class="font-label-md text-label-md text-on-surface font-semibold">${g.progress}%</span>
        </div>
        <div class="h-1.5 w-full rounded-full bg-surface-container-highest overflow-hidden">
          <div class="h-full rounded-full bg-gradient-to-r from-primary to-secondary" style="width:${g.progress}%"></div>
        </div>

        <button data-action="toggle-goal-expand" data-id="${g.id}" class="mt-2.5 flex items-center gap-1 text-on-surface-variant font-label-sm text-label-sm">
          ${ms.length ? `<span class="font-semibold text-on-surface">${ms.filter(m=>m.done).length}/${ms.length}</span> étapes` : 'Ajouter des étapes'}
          <span class="material-symbols-outlined text-[16px]">${expanded ? 'expand_less' : 'expand_more'}</span>
        </button>
        ${expanded ? milestonePanelHtml(g) : ''}

        <div class="mt-3">
          ${g.id === state.activeGoalId
            ? `<span class="px-2.5 py-1 rounded-full bg-primary-container/20 text-primary font-label-sm text-label-sm font-semibold inline-flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">check_circle</span>Objectif actif</span>`
            : `<button data-action="set-active-goal" data-id="${g.id}" class="px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface-variant font-label-sm text-label-sm">Définir comme objectif actif</button>`}
        </div>
        <div class="flex items-center gap-2 mt-3">
          ${ms.length === 0 ? `
          <button data-action="dec" data-id="${g.id}" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant active:scale-90 transition-transform"><span class="material-symbols-outlined text-[16px]">remove</span></button>
          <button data-action="inc" data-id="${g.id}" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant active:scale-90 transition-transform"><span class="material-symbols-outlined text-[16px]">add</span></button>
          ` : ''}
          <button data-action="edit-goal" data-id="${g.id}" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant active:scale-90 transition-transform"><span class="material-symbols-outlined text-[16px]">edit</span></button>
          <button data-action="del-goal" data-id="${g.id}" class="ml-auto w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[16px]">delete</span></button>
        </div>
      </div>`;}).join('')}
    </div>

    ${state.goals.length > 0 ? `
    <div class="mt-5 rounded-2xl bg-surface-container-low p-3.5 flex items-start gap-3">
      <div class="w-8 h-8 rounded-full bg-tertiary-container/30 flex items-center justify-center text-tertiary shrink-0"><span class="material-symbols-outlined text-[16px]">tips_and_updates</span></div>
      <div>
        <p class="font-label-md text-label-md text-on-surface font-semibold flex items-center gap-1.5">Conseil LISTMAX <span class="w-1.5 h-1.5 rounded-full bg-primary inline-block"></span></p>
        <p class="font-body-md text-body-md text-on-surface-variant mt-0.5">${goalsTip(state.goals)}</p>
      </div>
    </div>` : ''}

    <button id="btn-add-ambition" class="mt-5 w-full py-3.5 rounded-xl bg-primary text-on-primary font-headline-md text-headline-md font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-all">
      <span class="material-symbols-outlined text-[22px]">add</span><span>Ajouter une nouvelle grande ambition</span>
    </button>
  `;

  el.querySelectorAll('.cat-pill').forEach(b => b.addEventListener('click', () => { goalsFilter = b.dataset.cat; renderGoals(); }));
  el.querySelector('#btn-new-goal').addEventListener('click', () => openGoalModal());
  el.querySelector('#btn-add-ambition').addEventListener('click', () => openGoalModal());
  el.querySelector('#btn-goals-overview').addEventListener('click', () => openGoalsOverviewModal());
  el.querySelectorAll('[data-action="inc"]').forEach(b => b.addEventListener('click', () => adjustGoal(b.dataset.id, 5)));
  el.querySelectorAll('[data-action="dec"]').forEach(b => b.addEventListener('click', () => adjustGoal(b.dataset.id, -5)));
  el.querySelectorAll('[data-action="edit-goal"]').forEach(b => b.addEventListener('click', () => openGoalModal(b.dataset.id)));
  el.querySelectorAll('[data-action="toggle-goal-expand"]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.id;
    if(expandedGoals.has(id)) expandedGoals.delete(id); else expandedGoals.add(id);
    renderGoals();
  }));
  el.querySelectorAll('[data-action="toggle-milestone"]').forEach(b => b.addEventListener('click', () => toggleGoalMilestone(b.dataset.goal, b.dataset.ms)));
  el.querySelectorAll('[data-action="del-milestone"]').forEach(b => b.addEventListener('click', () => delGoalMilestone(b.dataset.goal, b.dataset.ms)));
  el.querySelectorAll('[data-action="add-milestone"]').forEach(b => b.addEventListener('click', () => {
    const input = el.querySelector(`[data-milestone-input="${b.dataset.goal}"]`);
    if(input && input.value.trim()) addGoalMilestone(b.dataset.goal, input.value);
  }));
  el.querySelectorAll('[data-milestone-input]').forEach(inp => inp.addEventListener('keydown', (e) => {
    if(e.key === 'Enter' && inp.value.trim()) addGoalMilestone(inp.dataset.milestoneInput, inp.value);
  }));
  el.querySelectorAll('[data-action="set-active-goal"]').forEach(b => b.addEventListener('click', () => {
    state.activeGoalId = b.dataset.id;
    saveState(); renderGoals(); toast('Objectif actif mis à jour');
  }));
  el.querySelectorAll('[data-action="del-goal"]').forEach(b => b.addEventListener('click', () => {
    state.goals = state.goals.filter(g => g.id !== b.dataset.id);
    if(state.activeGoalId === b.dataset.id) state.activeGoalId = null;
    expandedGoals.delete(b.dataset.id);
    saveState(); renderGoals(); toast('Objectif supprimé');
  }));
}
function adjustGoal(id, delta){
  const g = state.goals.find(g => g.id === id);
  if(!g || (g.milestones && g.milestones.length)) return;
  g.progress = Math.max(0, Math.min(100, g.progress + delta));
  saveState(); renderGoals();
}
function goalsTip(goals){
  const best = goals.slice().sort((a,b) => b.progress - a.progress)[0];
  const worst = goals.slice().sort((a,b) => a.progress - b.progress)[0];
  if(goals.length === 1) return `"${best.title}" est à ${best.progress}%. Continue sur ta lancée !`;
  if(best.id === worst.id) return `Tous tes objectifs avancent au même rythme (${best.progress}%). Belle régularité.`;
  return `"${best.title}" avance bien (${best.progress}%). "${worst.title}" pourrait profiter d'un peu plus d'attention (${worst.progress}%).`;
}
// Aperçu basé sur les vraies données (pas d'IA réelle dans ce prototype
// front-end sans backend) : un résumé honnête plutôt qu'un label trompeur.
function openGoalsOverviewModal(){
  const todayStr = dstr(TODAY);
  const lines = state.goals.map(g => {
    const overdue = g.deadline && g.deadline < todayStr && g.progress < 100;
    let note;
    if(g.progress >= 100) note = 'Atteint 🎉';
    else if(overdue) note = 'Échéance dépassée — à revoir';
    else if(g.progress === 0) note = "Pas encore démarré";
    else note = `${g.progress}% — ${goalStatusLabel(g.progress).toLowerCase()}`;
    return `<div class="flex items-center justify-between py-2 border-b border-white/[0.06] last:border-0"><span class="font-body-md text-body-md text-on-surface truncate pr-2">${g.title}</span><span class="font-label-sm text-label-sm text-on-surface-variant shrink-0">${note}</span></div>`;
  }).join('');
  openModal(`
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-headline-lg text-headline-lg text-on-surface">Aperçu des objectifs</h3>
      <button data-action="close" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[18px]">close</span></button>
    </div>
    ${state.goals.length ? `<div class="flex flex-col">${lines}</div>` : `<p class="font-body-md text-body-md text-on-surface-variant">Aucun objectif pour l'instant.</p>`}
  `);
  document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
}
// editId fourni -> modifie l'objectif existant, sinon en crée un nouveau.
function openGoalModal(editId){
  const existing = editId ? state.goals.find(g => g.id === editId) : null;
  openModal(`
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-headline-lg text-headline-lg text-on-surface">${existing ? "Modifier l'objectif" : 'Nouvel objectif'}</h3>
      <button data-action="close" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[18px]">close</span></button>
    </div>
    <div class="flex flex-col gap-3">
      <input id="g-title" type="text" value="${escapeAttr(existing?.title)}" placeholder="Titre de l'objectif" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
      <input id="g-metric" type="text" value="${escapeAttr(existing?.metric)}" placeholder="Indicateur (ex: 20 000 CHF épargnés)" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
      <div class="flex gap-3">
        <input id="g-category" type="text" value="${escapeAttr(existing?.category)}" placeholder="Catégorie" class="flex-1 bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
        <input id="g-deadline" type="date" value="${existing?.deadline || ''}" class="flex-1 bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
      </div>
      <button id="btn-save-goal" class="mt-2 w-full py-3.5 rounded-xl bg-primary text-on-primary font-headline-md text-headline-md font-semibold active:scale-[0.98] transition-all">${existing ? 'Enregistrer' : "Créer l'objectif"}</button>
    </div>
  `);
  document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
  document.getElementById('btn-save-goal').addEventListener('click', () => {
    const title = document.getElementById('g-title').value.trim();
    if(!title){ toast('Ajoute un titre'); return; }
    const payload = {
      title,
      category: document.getElementById('g-category').value.trim() || 'Perso',
      deadline: document.getElementById('g-deadline').value || '',
      metric: document.getElementById('g-metric').value.trim() || 'Progression'
    };
    if(existing){
      Object.assign(existing, payload);
    } else {
      state.goals.push({ id: uid(), progress: 0, milestones: [], ...payload });
    }
    saveState(); closeModal(); renderGoals(); toast(existing ? 'Objectif mis à jour' : 'Objectif créé');
  });
}

/* ===================== SETTINGS ===================== */
function renderSettings(){
  const el = document.getElementById('page-settings');
  el.innerHTML = `
    <div class="pt-2 rounded-[20px] bg-gradient-to-br from-primary-container/25 to-surface-container p-card-padding flex items-center gap-3.5">
      <div class="w-14 h-14 rounded-full bg-surface-container-high flex items-center justify-center font-headline-md text-headline-md text-primary font-bold shrink-0">${state.user.initials}</div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <p class="font-headline-md text-headline-md text-on-surface truncate">${state.user.name}</p>
          <span class="px-2 py-0.5 rounded-full bg-primary text-on-primary font-label-sm text-label-sm font-bold">${state.user.plan}</span>
        </div>
        <p class="font-body-md text-body-md text-on-surface-variant truncate">${state.user.email}</p>
        <p class="font-label-sm text-label-sm text-on-surface-variant mt-0.5 flex items-center gap-1"><span class="material-symbols-outlined text-[13px]">verified</span>Membre depuis ${state.user.memberSince}</p>
      </div>
    </div>

    <span class="font-label-sm text-label-sm text-primary tracking-wider mt-6 mb-2 flex items-center gap-1.5"><span class="material-symbols-outlined text-[15px]">bolt</span>PRÉFÉRENCES DE PRODUCTIVITÉ</span>
    <div class="rounded-2xl bg-surface-container divide-y divide-white/[0.06]">
      <div class="p-card-padding flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[18px]">task_alt</span></div>
          <div class="min-w-0"><p class="font-body-md text-body-md text-on-surface">Objectif quotidien</p><p class="font-label-sm text-label-sm text-on-surface-variant">Rythme optimal de concentration</p></div>
        </div>
        <select id="set-daily-goal" class="bg-surface-container-high rounded-lg px-2.5 py-1.5 font-label-md text-label-md text-on-surface outline-none shrink-0">
          ${[4,6,8,10,12].map(n => `<option value="${n}" ${state.settings.dailyGoal===n?'selected':''}>${n} tâches / jour</option>`).join('')}
        </select>
      </div>
      <div class="p-card-padding flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[18px]">timer</span></div>
          <div class="min-w-0"><p class="font-body-md text-body-md text-on-surface">Mode Focus par défaut</p><p class="font-label-sm text-label-sm text-on-surface-variant">Protocole Pomodoro standard</p></div>
        </div>
        <select id="set-focus" class="bg-surface-container-high rounded-lg px-2.5 py-1.5 font-label-md text-label-md text-on-surface outline-none shrink-0">
          ${[15,20,25,45,60].map(n => `<option value="${n}" ${state.settings.focusMinutes===n?'selected':''}>${n} min</option>`).join('')}
        </select>
      </div>
      <div class="p-card-padding flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[18px]">notifications</span></div>
          <div class="min-w-0"><p class="font-body-md text-body-md text-on-surface">Rappels intelligents</p><p class="font-label-sm text-label-sm text-on-surface-variant">Alertes discrètes avant échéances</p></div>
        </div>
        <button id="toggle-reminders" class="toggle-track w-12 h-7 rounded-full ${state.settings.remindersEnabled?'bg-primary':'bg-surface-container-highest'} relative shrink-0">
          <span class="toggle-dot absolute top-0.5 ${state.settings.remindersEnabled?'left-[22px]':'left-0.5'} w-6 h-6 rounded-full bg-white flex items-center justify-center">${state.settings.remindersEnabled?'<span class="material-symbols-outlined text-[14px] text-primary">check</span>':''}</span>
        </button>
      </div>
    </div>

    <span class="font-label-sm text-label-sm text-primary tracking-wider mt-6 mb-2 flex items-center gap-1.5"><span class="material-symbols-outlined text-[15px]">palette</span>AFFICHAGE & INTERFACE</span>
    <div class="rounded-2xl bg-surface-container divide-y divide-white/[0.06]">
      <div class="p-card-padding flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[18px]">dark_mode</span></div>
          <div class="min-w-0"><p class="font-body-md text-body-md text-on-surface">Thème de couleur</p><p class="font-label-sm text-label-sm text-on-surface-variant">Obsidian Luxe</p></div>
        </div>
        <span class="px-2.5 py-1.5 rounded-lg bg-surface-container-high font-label-md text-label-md text-on-surface flex items-center gap-1.5 shrink-0"><span class="w-2 h-2 rounded-full bg-primary inline-block"></span>${state.settings.theme}</span>
      </div>
      <div class="p-card-padding flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[18px]">calendar_view_week</span></div>
          <div class="min-w-0"><p class="font-body-md text-body-md text-on-surface">Vue calendrier par défaut</p><p class="font-label-sm text-label-sm text-on-surface-variant">Horizon de planification</p></div>
        </div>
        <select id="set-cal-view" class="bg-surface-container-high rounded-lg px-2.5 py-1.5 font-label-md text-label-md text-on-surface outline-none shrink-0">
          ${['Jour','Semaine','Mois','Liste'].map(v => `<option value="${v}" ${state.settings.calendarView===v?'selected':''}>${v}</option>`).join('')}
        </select>
      </div>
    </div>

    <span class="font-label-sm text-label-sm text-primary tracking-wider mt-6 mb-2 flex items-center gap-1.5"><span class="material-symbols-outlined text-[15px]">sync</span>DONNÉES</span>
    <div class="rounded-2xl bg-surface-container divide-y divide-white/[0.06]">
      <div class="p-card-padding flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[18px]">smartphone</span></div>
          <div class="min-w-0"><p class="font-body-md text-body-md text-on-surface">Stockage local</p><p class="font-label-sm text-label-sm text-on-surface-variant">Enregistré uniquement dans ce navigateur</p></div>
        </div>
        <span class="px-2 py-1 rounded-full bg-surface-container-high font-label-sm text-label-sm text-on-surface-variant flex items-center gap-1 shrink-0"><span class="w-1.5 h-1.5 rounded-full bg-primary inline-block"></span>${nowTime()}</span>
      </div>
      <button id="btn-export" class="w-full p-card-padding flex items-center justify-between gap-3 text-left">
        <div class="flex items-center gap-3 min-w-0"><span class="material-symbols-outlined text-on-surface-variant text-[18px]">download</span><span class="font-body-md text-body-md text-on-surface">Exporter mes données (.json)</span></div>
        <span class="material-symbols-outlined text-on-surface-variant text-[18px]">chevron_right</span>
      </button>
      <button id="btn-import" class="w-full p-card-padding flex items-center justify-between gap-3 text-left">
        <div class="flex items-center gap-3 min-w-0"><span class="material-symbols-outlined text-on-surface-variant text-[18px]">upload</span><span class="font-body-md text-body-md text-on-surface">Importer une sauvegarde (.json)</span></div>
        <span class="material-symbols-outlined text-on-surface-variant text-[18px]">chevron_right</span>
      </button>
      <input id="import-file-input" type="file" accept="application/json" class="hidden"/>
    </div>

    <span class="font-label-sm text-label-sm text-primary tracking-wider mt-6 mb-2 flex items-center gap-1.5"><span class="material-symbols-outlined text-[15px]">shield</span>COMPTE & SÉCURITÉ</span>
    <div class="rounded-2xl bg-surface-container divide-y divide-white/[0.06]">
      <button id="btn-change-name" class="w-full p-card-padding flex items-center justify-between gap-3 text-left">
        <div class="flex items-center gap-3"><span class="material-symbols-outlined text-on-surface-variant text-[18px]">badge</span><span class="font-body-md text-body-md text-on-surface">Modifier le profil</span></div>
        <span class="material-symbols-outlined text-on-surface-variant text-[18px]">chevron_right</span>
      </button>
      <button id="btn-privacy" class="w-full p-card-padding flex items-center justify-between gap-3 text-left">
        <div class="flex items-center gap-3"><span class="material-symbols-outlined text-on-surface-variant text-[18px]">lock</span><span class="font-body-md text-body-md text-on-surface">Confidentialité & stockage</span></div>
        <span class="material-symbols-outlined text-on-surface-variant text-[18px]">chevron_right</span>
      </button>
      <button id="btn-logout" class="w-full p-card-padding flex items-center gap-3 text-left">
        <span class="material-symbols-outlined text-on-surface-variant text-[18px]">logout</span><span class="font-body-md text-body-md text-on-surface">Se déconnecter</span>
      </button>
    </div>

    <div class="mt-6 rounded-2xl border border-error/25 bg-error-container/10 p-card-padding">
      <p class="font-body-md text-body-md text-error font-semibold flex items-center gap-1.5"><span class="material-symbols-outlined text-[18px]">warning</span>Zone de danger</p>
      <p class="font-label-sm text-label-sm text-on-surface-variant mt-1.5">La suppression de votre compte effacera instantanément l'ensemble de vos listes, historiques et sauvegardes synchronisées.</p>
      <button id="btn-delete-account" class="mt-3 w-full py-3 rounded-xl bg-error/15 text-error font-body-md text-body-md font-semibold flex items-center justify-center gap-1.5 active:scale-95 transition-transform"><span class="material-symbols-outlined text-[16px]">delete_forever</span>Supprimer définitivement le compte</button>
    </div>

    <p class="text-center font-label-sm text-label-sm text-on-surface-variant/60 mt-6">LISTMAX Engine v4.2.0 · Build Obsidian<br/>Édition Haute Précision</p>
  `;

  el.querySelector('#set-daily-goal').addEventListener('change', (e) => { state.settings.dailyGoal = Number(e.target.value); saveState(); toast('Objectif mis à jour'); });
  el.querySelector('#set-focus').addEventListener('change', (e) => { state.settings.focusMinutes = Number(e.target.value); saveState(); toast('Durée de focus mise à jour'); });
  el.querySelector('#set-cal-view').addEventListener('change', (e) => { state.settings.calendarView = e.target.value; saveState(); toast('Vue calendrier mise à jour'); });
  el.querySelector('#toggle-reminders').addEventListener('click', () => { state.settings.remindersEnabled = !state.settings.remindersEnabled; saveState(); renderSettings(); });
  el.querySelector('#btn-export').addEventListener('click', () => {
    try{
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'listmax-export.json';
      document.body.appendChild(a); a.click(); a.remove();
      toast('Export généré');
    }catch(e){ toast('Export indisponible dans cet aperçu'); }
  });
  el.querySelector('#btn-import').addEventListener('click', () => document.getElementById('import-file-input').click());
  el.querySelector('#import-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try{ parsed = JSON.parse(reader.result); }
      catch(err){ toast('Fichier invalide : ce n\u2019est pas un JSON lisible'); return; }
      if(!parsed || typeof parsed !== 'object' || !parsed.tasks || !parsed.goals || !parsed.settings || !parsed.user){
        toast('Ce fichier ne ressemble pas à une sauvegarde LISTMAX');
        return;
      }
      openModal(`
        <div class="text-center py-2">
          <div class="w-14 h-14 rounded-full bg-tertiary-container/20 text-tertiary flex items-center justify-center mx-auto mb-3"><span class="material-symbols-outlined text-[26px]">upload</span></div>
          <h3 class="font-headline-md text-headline-md text-on-surface">Importer cette sauvegarde ?</h3>
          <p class="font-body-md text-body-md text-on-surface-variant mt-1.5">Toutes tes données actuelles (tâches, agenda, objectifs) seront remplacées par le contenu de ce fichier. Cette action est irréversible.</p>
          <div class="flex gap-2.5 mt-5">
            <button data-action="close" class="flex-1 py-3 rounded-xl bg-surface-container-high text-on-surface font-body-md text-body-md">Annuler</button>
            <button id="btn-confirm-import" class="flex-1 py-3 rounded-xl bg-primary text-on-primary font-body-md text-body-md font-semibold">Importer</button>
          </div>
        </div>
      `);
      document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
      document.getElementById('btn-confirm-import').addEventListener('click', () => {
        const keepUser = state.user;
        state = parsed;
        state.user = keepUser; // le compte connecté reste celui-ci, seules les données (tâches/agenda/objectifs) changent
        migrateEventsIfNeeded();
        if(state.activeGoalId === undefined) state.activeGoalId = null;
        if(!Array.isArray(state.tasks)) state.tasks = [];
        if(!Array.isArray(state.goals)) state.goals = [];
        syncLongTermDueTasks();
        saveState();
        closeModal(); renderSettings(); toast('Sauvegarde importée');
      });
    };
    reader.readAsText(file);
    e.target.value = '';
  });
  el.querySelector('#btn-privacy').addEventListener('click', () => {
    openModal(`
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-headline-lg text-headline-lg text-on-surface">Confidentialité & stockage</h3>
        <button data-action="close" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[18px]">close</span></button>
      </div>
      <div class="flex flex-col gap-3 font-body-md text-body-md text-on-surface-variant">
        <p><strong class="text-on-surface">Où vivent tes données ?</strong> Uniquement dans le stockage local de ce navigateur, sur cet appareil. LISTMAX n'a pas de serveur : rien n'est envoyé ni stocké ailleurs.</p>
        <p><strong class="text-on-surface">Et si je change d'appareil ou de navigateur ?</strong> Tes données ne te suivront pas automatiquement. Utilise "Exporter mes données" puis "Importer une sauvegarde" sur l'autre appareil pour les transférer.</p>
        <p><strong class="text-on-surface">Et si je vide le cache / l'historique du navigateur ?</strong> Tes données peuvent être supprimées définitivement. Pense à exporter régulièrement une sauvegarde si elles comptent pour toi.</p>
        <p><strong class="text-on-surface">Mon mot de passe est-il sécurisé ?</strong> C'est un prototype : le mot de passe est vérifié localement avec un hash simple, pas un algorithme cryptographique robuste. Évite d'y mettre un mot de passe que tu utilises ailleurs.</p>
      </div>
    `);
    document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
  });
  el.querySelector('#btn-change-name').addEventListener('click', openEditProfileModal);
  el.querySelector('#btn-logout').addEventListener('click', () => {
    openModal(`
      <div class="text-center py-2">
        <div class="w-14 h-14 rounded-full bg-surface-container-high text-on-surface-variant flex items-center justify-center mx-auto mb-3"><span class="material-symbols-outlined text-[26px]">logout</span></div>
        <h3 class="font-headline-md text-headline-md text-on-surface">Se déconnecter ?</h3>
        <p class="font-body-md text-body-md text-on-surface-variant mt-1.5">Tes données restent sauvegardées, tu pourras te reconnecter à tout moment avec ${state.user.email}.</p>
        <div class="flex gap-2.5 mt-5">
          <button data-action="close" class="flex-1 py-3 rounded-xl bg-surface-container-high text-on-surface font-body-md text-body-md">Annuler</button>
          <button id="btn-confirm-logout" class="flex-1 py-3 rounded-xl bg-primary text-on-primary font-body-md text-body-md font-semibold">Se déconnecter</button>
        </div>
      </div>
    `);
    document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
    document.getElementById('btn-confirm-logout').addEventListener('click', async () => {
      closeModal();
      await logout();
      toast('Déconnecté(e)');
    });
  });
  el.querySelector('#btn-delete-account').addEventListener('click', () => {
    openModal(`
      <div class="text-center py-2">
        <div class="w-14 h-14 rounded-full bg-error-container/20 text-error flex items-center justify-center mx-auto mb-3"><span class="material-symbols-outlined text-[26px]">warning</span></div>
        <h3 class="font-headline-md text-headline-md text-on-surface">Supprimer le compte ?</h3>
        <p class="font-body-md text-body-md text-on-surface-variant mt-1.5">Cette action supprime définitivement le compte ${state.user.email} et toutes ses données LISTMAX. Elle est irréversible.</p>
        <div class="flex gap-2.5 mt-5">
          <button data-action="close" class="flex-1 py-3 rounded-xl bg-surface-container-high text-on-surface font-body-md text-body-md">Annuler</button>
          <button id="btn-confirm-delete" class="flex-1 py-3 rounded-xl bg-error text-on-error font-body-md text-body-md font-semibold">Supprimer</button>
        </div>
      </div>
    `);
    document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
    document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
      const email = currentEmail;
      const accounts = await loadAccounts();
      await saveAccounts(accounts.filter(a => a.email !== email));
      await deleteUserState(email);
      await saveSession(null);
      currentEmail = null;
      state = null;
      closeModal();
      showLogin();
      toast('Compte supprimé');
    });
  });
}
function nowTime(){ const d = new Date(); return `À ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
async function openEditProfileModal(){
  const accounts = await loadAccounts();
  const account = accounts.find(a => a.email === currentEmail);
  const hasPassword = !!(account && account.passwordHash);
  openModal(`
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-headline-lg text-headline-lg text-on-surface">Modifier le profil</h3>
      <button data-action="close" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[18px]">close</span></button>
    </div>
    <div id="p-error" class="hidden mb-3 px-3.5 py-2.5 rounded-xl bg-error-container/15 border border-error/25 text-error font-label-md text-label-md"></div>
    <div class="flex flex-col gap-3">
      <input id="p-name" type="text" value="${escapeAttr(state.user.name)}" placeholder="Nom complet" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
      <input id="p-email" type="email" value="${escapeAttr(state.user.email)}" placeholder="E-mail" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
      <div class="mt-1 pt-3 border-t border-white/[0.06]">
        <p class="font-label-sm text-label-sm text-on-surface-variant mb-2">Changer le mot de passe (optionnel)</p>
        <div class="flex flex-col gap-2.5">
          ${hasPassword ? `<input id="p-current-pw" type="password" placeholder="Mot de passe actuel" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>` : ''}
          <input id="p-new-pw" type="password" placeholder="Nouveau mot de passe" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
          <input id="p-confirm-pw" type="password" placeholder="Confirmer le nouveau mot de passe" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
        </div>
      </div>
      <button id="btn-save-profile" class="mt-2 w-full py-3.5 rounded-xl bg-primary text-on-primary font-headline-md text-headline-md font-semibold active:scale-[0.98] transition-all">Enregistrer</button>
    </div>
  `);
  document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
  document.getElementById('btn-save-profile').addEventListener('click', async () => {
    const errEl = document.getElementById('p-error');
    const showErr = (msg) => { errEl.textContent = msg; errEl.classList.remove('hidden'); };
    errEl.classList.add('hidden');

    const name = document.getElementById('p-name').value.trim();
    const newEmail = document.getElementById('p-email').value.trim().toLowerCase();
    if(!name || !newEmail){ showErr('Le nom et l\u2019e-mail sont obligatoires.'); return; }

    const accountsNow = await loadAccounts();
    const acc = accountsNow.find(a => a.email === currentEmail);
    if(!acc){ toast('Erreur interne : compte introuvable'); return; }
    if(newEmail !== currentEmail && accountsNow.some(a => a.email === newEmail)){
      showErr('Cet e-mail est déjà utilisé par un autre compte.');
      return;
    }

    const newPw = document.getElementById('p-new-pw').value;
    const confirmPw = document.getElementById('p-confirm-pw').value;
    if(newPw || confirmPw){
      if(newPw.length < 4){ showErr('Le nouveau mot de passe doit faire au moins 4 caractères.'); return; }
      if(newPw !== confirmPw){ showErr('Les deux mots de passe ne correspondent pas.'); return; }
      if(hasPassword){
        const curPw = document.getElementById('p-current-pw').value;
        if(simpleHash(curPw) !== acc.passwordHash){ showErr('Mot de passe actuel incorrect.'); return; }
      }
      acc.passwordHash = simpleHash(newPw);
    }

    const oldEmail = currentEmail;
    acc.name = name;
    acc.email = newEmail;
    await saveAccounts(accountsNow);

    state.user.name = name;
    state.user.email = newEmail;
    state.user.initials = initialsOf(name);

    if(newEmail !== oldEmail){
      // Le compte change d'e-mail : on déplace ses données sous la nouvelle clé
      // de stockage et on met à jour la session, sinon la prochaine connexion échouerait.
      await storage.set(stateKeyFor(newEmail), JSON.stringify(state));
      await storage.delete(stateKeyFor(oldEmail));
      await saveSession(newEmail);
      currentEmail = newEmail;
    } else {
      await saveState();
    }
    closeModal(); renderSettings(); toast('Profil mis à jour');
  });
}

/* ===================== INIT ===================== */
(async function init(){
  initIcons();
  initAuthUI();
  const session = await loadSession();
  if(session){
    const accounts = await loadAccounts();
    const account = accounts.find(a => a.email === session);
    if(account){
      currentEmail = account.email;
      const loaded = await loadUserState(currentEmail);
      state = loaded || emptyState(account);
      if(state.activeGoalId === undefined) state.activeGoalId = null;
      migrateEventsIfNeeded();
      syncLongTermDueTasks();
      showApp();
      setActivePage('home');
      return;
    }
  }
  showLogin();
})();

// Vérifie périodiquement si une tâche Long Terme a atteint son échéance
// (utile si l'app reste ouverte à minuit) et rafraîchit l'écran si besoin.
setInterval(() => {
  if(!state || !currentEmail) return;
  const moved = syncLongTermDueTasks();
  if(moved && (currentPage === 'todo' || currentPage === 'home')) renderCurrentPage();
}, 60000);
