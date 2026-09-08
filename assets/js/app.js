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
    events: {},
    reminders: [],
    goals: []
  };
}
function initialsOf(name){ const p = (name||'').trim().split(/\s+/).filter(Boolean); return (p.map(w=>w[0]).slice(0,2).join('') || '??').toUpperCase(); }
function formatMemberSince(dateStr){ try{ const d = new Date(dateStr+'T00:00:00'); return capitalize(d.toLocaleDateString('fr-FR',{month:'short', year:'numeric'})); }catch(e){ return ''; } }
function simpleHash(str){ let h = 0; for(let i=0;i<str.length;i++){ h = (h<<5)-h + str.charCodeAt(i); h |= 0; } return 'h'+h; }

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
  if(!state.reminders) state.reminders = [];
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

function renderHome(){
  const todays = state.tasks.filter(t => t.list === 'today');
  const done = todays.filter(t => t.done).length;
  const pending = todays.filter(t => !t.done);
  const score = Math.min(100, Math.round((done / Math.max(1, state.settings.dailyGoal)) * 100));
  const current = pending[0];
  const dateFmt = TODAY.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long' }).toUpperCase();
  const weekNum = isoWeekNumber(TODAY);

  const el = document.getElementById('page-home');
  el.innerHTML = `
    <div class="flex items-center justify-between pt-2 pb-1">
      <span class="font-label-sm text-label-sm text-primary font-bold flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-primary inline-block"></span>${dateFmt}</span>
      <span class="px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface-variant font-label-sm text-label-sm">Semaine ${weekNum}</span>
    </div>
    <h1 class="font-display text-display text-on-surface mt-1">Bonjour, ${state.user.name.split(' ')[0]}</h1>
    <p class="font-body-lg text-body-lg text-on-surface-variant mt-1 mb-5">Prête à maximiser ta journée ?</p>

    <div class="rounded-[20px] bg-surface-container p-card-padding border border-white/[0.06]">
      <div class="flex items-start justify-between">
        <div>
          <span class="font-label-sm text-label-sm text-on-surface-variant tracking-wider">SCORE D'ACCOMPLISSEMENT</span>
          <div class="flex items-baseline gap-1.5 mt-1">
            <span class="font-display text-display text-on-surface">${score}</span>
            <span class="font-headline-md text-headline-md text-on-surface-variant">/100</span>
            <span class="ml-1 px-2 py-0.5 rounded-full bg-primary-container/20 text-primary font-label-sm text-label-sm font-semibold">↗ ${done}/${state.settings.dailyGoal} tâches</span>
          </div>
        </div>
        <div class="w-11 h-11 rounded-full bg-surface-container-high flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-primary text-[22px]">insights</span>
        </div>
      </div>
      <div class="mt-4">
        <div class="flex items-center justify-between mb-1.5">
          <span class="font-label-md text-label-md text-on-surface-variant">Objectif quotidien</span>
          <span class="font-label-md text-label-md text-on-surface font-semibold">${score}%</span>
        </div>
        <div class="h-1.5 w-full rounded-full bg-surface-container-highest overflow-hidden">
          <div class="h-full rounded-full bg-gradient-to-r from-primary to-secondary" style="width:${score}%"></div>
        </div>
      </div>
      <div class="mt-4 pt-4 border-t border-white/[0.06] grid grid-cols-3 gap-2 text-center">
        <div><span class="font-label-sm text-label-sm text-on-surface-variant block mb-0.5">Terminées</span><span class="font-headline-md text-headline-md text-on-surface font-bold">${done}</span></div>
        <div><span class="font-label-sm text-label-sm text-on-surface-variant block mb-0.5">Restantes</span><span class="font-headline-md text-headline-md text-primary font-bold">${pending.length}</span></div>
        <div><span class="font-label-sm text-label-sm text-on-surface-variant block mb-0.5">Focus</span><span class="font-headline-md text-headline-md text-on-surface font-bold">${state.settings.focusMinutes}min</span></div>
      </div>
    </div>

    <div class="flex items-center justify-between mt-6 mb-2">
      <span class="font-label-sm text-label-sm text-on-surface-variant tracking-wider">EN CE MOMENT</span>
      <span class="font-label-sm text-label-sm text-primary flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-primary"></span>${current ? 'En cours' : 'Journée libre'}</span>
    </div>
    ${current ? `
    <div class="rounded-[20px] bg-surface-container-high p-card-padding border border-primary/25 shadow-[0_0_24px_rgba(255,31,143,0.08)]">
      <div class="flex items-center gap-1.5 mb-1.5">
        <span class="px-2 py-0.5 rounded-full bg-primary-container/25 text-primary font-label-sm text-label-sm font-semibold uppercase">${priorityLabel(current.priority)}</span>
        <span class="font-label-sm text-label-sm text-on-surface-variant">${current.category}</span>
      </div>
      <h3 class="font-headline-md text-headline-md text-on-surface">${current.text}</h3>
      <div class="flex items-center gap-1.5 mt-2 text-on-surface-variant">
        <span class="material-symbols-outlined text-[16px]">schedule</span>
        <span class="font-label-md text-label-md">${current.time || 'Sans horaire'}</span>
      </div>
      <div class="flex gap-2 mt-4">
        <button data-action="snooze-task" data-id="${current.id}" class="flex-1 py-2.5 rounded-xl bg-surface-container text-on-surface-variant font-body-md text-body-md flex items-center justify-center gap-1.5 active:scale-95 transition-transform"><span class="material-symbols-outlined text-[18px]">history</span>Reporter</button>
        <button data-action="complete-task" data-id="${current.id}" class="flex-1 py-2.5 rounded-xl bg-primary text-on-primary font-body-md text-body-md font-semibold flex items-center justify-center gap-1.5 active:scale-95 transition-transform"><span class="material-symbols-outlined text-[18px]">check</span>Terminer</button>
      </div>
    </div>` : `
    <div class="rounded-[20px] bg-surface-container p-card-padding text-center">
      ${todays.length === 0 ? `
      <p class="font-body-md text-body-md text-on-surface-variant mb-3">Aucune tâche pour l'instant. Ajoute ta première tâche pour lancer ta journée.</p>
      <button data-action="open-add-task" class="px-4 py-2 rounded-xl bg-primary text-on-primary font-body-md text-body-md font-semibold inline-flex items-center gap-1.5"><span class="material-symbols-outlined text-[16px]">add</span>Ajouter une tâche</button>
      ` : `<p class="font-body-md text-body-md text-on-surface-variant">Toutes les tâches du jour sont terminées. Belle journée !</p>`}
    </div>`}

    <div class="grid grid-cols-3 gap-2.5 mt-5">
      <button data-nav-to="todo" class="quick-nav rounded-2xl bg-surface-container p-3 flex flex-col gap-2 active:scale-95 transition-transform text-left">
        <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-primary"><span class="material-symbols-outlined text-[18px]">task_alt</span></div>
        <span class="font-label-sm text-label-sm text-on-surface-variant">Tâches</span>
        <span class="font-headline-md text-headline-md text-on-surface leading-tight">${pending.length} resta...</span>
      </button>
      <button data-nav-to="calendar" class="quick-nav rounded-2xl bg-surface-container p-3 flex flex-col gap-2 active:scale-95 transition-transform text-left">
        <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-tertiary"><span class="material-symbols-outlined text-[18px]">event</span></div>
        <span class="font-label-sm text-label-sm text-on-surface-variant">Agenda</span>
        <span class="font-headline-md text-headline-md text-on-surface leading-tight">${(state.events[dstr(TODAY)]||[])[0]?.start || '--:--'}</span>
      </button>
      <button data-action="start-focus" class="quick-nav rounded-2xl bg-surface-container p-3 flex flex-col gap-2 active:scale-95 transition-transform text-left">
        <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-secondary"><span class="material-symbols-outlined text-[18px]">timer</span></div>
        <span class="font-label-sm text-label-sm text-on-surface-variant">Pomodoro</span>
        <span class="font-headline-md text-headline-md text-on-surface leading-tight">Lancer focus</span>
      </button>
    </div>

    <div class="flex items-center justify-between mt-6 mb-2">
      <span class="font-label-sm text-label-sm text-on-surface-variant tracking-wider">RAPPELS PRIORITAIRES</span>
      ${state.reminders.length ? `<button data-nav-to="todo" class="font-label-sm text-label-sm text-primary">Voir tout (${state.reminders.length})</button>` : ''}
    </div>
    ${state.reminders.length === 0 ? `
    <div class="rounded-2xl bg-surface-container p-4 text-center">
      <p class="font-label-sm text-label-sm text-on-surface-variant">Aucun rappel pour l'instant. Les tâches à échéance proche apparaîtront ici.</p>
    </div>` : `
    <div class="flex flex-col gap-2.5">
      ${state.reminders.map(r => `
      <div class="rounded-2xl bg-surface-container p-3.5 flex items-center gap-3">
        <input type="checkbox" data-action="dismiss-reminder" data-id="${r.id}" class="task-check w-5 h-5 rounded-full border-2 border-outline-variant shrink-0 cursor-pointer"/>
        <div class="min-w-0 flex-1">
          <p class="font-body-md text-body-md text-on-surface truncate">${r.text}</p>
          <p class="font-label-sm text-label-sm text-on-surface-variant mt-0.5">${r.when} · ${r.tag}</p>
        </div>
        <span class="px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant font-label-sm text-label-sm shrink-0">${r.badge}</span>
      </div>`).join('')}
    </div>`}

    <button data-action="open-add-task" class="mt-6 w-full py-3.5 rounded-xl bg-primary text-on-primary font-headline-md text-headline-md font-semibold flex items-center justify-center gap-2 shadow-[0_4px_24px_rgba(255,176,201,0.25)] active:scale-[0.98] transition-all">
      <span class="material-symbols-outlined text-[22px]">add</span><span>Nouvelle tâche</span>
    </button>
  `;

  el.querySelectorAll('[data-nav-to]').forEach(b => b.addEventListener('click', () => setActivePage(b.dataset.navTo)));
  el.querySelectorAll('[data-action="open-add-task"]').forEach(b => b.addEventListener('click', () => openAddTaskModal('today')));
  el.querySelector('[data-action="start-focus"]')?.addEventListener('click', () => toast(`Session focus de ${state.settings.focusMinutes} min lancée`));
  el.querySelectorAll('[data-action="complete-task"]').forEach(b => b.addEventListener('click', () => { toggleTask(b.dataset.id); }));
  el.querySelectorAll('[data-action="snooze-task"]').forEach(b => b.addEventListener('click', () => { toast('Tâche reportée de 30 min'); }));
  el.querySelectorAll('[data-action="dismiss-reminder"]').forEach(b => b.addEventListener('click', () => {
    state.reminders = state.reminders.filter(r => r.id !== b.dataset.id);
    saveState(); renderHome(); toast('Rappel traité');
  }));
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

function renderTodo(){
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

    <div class="flex gap-2 mt-5 overflow-x-auto no-scrollbar">
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
    <div class="flex items-center justify-between mt-2.5">
      <div class="flex items-center gap-2">
        <span class="font-label-sm text-label-sm text-on-surface-variant">Priorité:</span>
        <button data-newp="haute" class="new-p-dot w-5 h-5 rounded-full bg-primary ring-2 ring-offset-2 ring-offset-surface ring-primary transition-all"></button>
        <button data-newp="normale" class="new-p-dot w-5 h-5 rounded-full bg-tertiary ring-2 ring-offset-2 ring-offset-surface ring-transparent transition-all"></button>
        <button data-newp="basse" class="new-p-dot w-5 h-5 rounded-full bg-outline-variant ring-2 ring-offset-2 ring-offset-surface ring-transparent transition-all"></button>
      </div>
      <button id="btn-add-task" class="w-10 h-10 rounded-xl bg-primary text-on-primary flex items-center justify-center active:scale-90 transition-transform"><span class="material-symbols-outlined text-[20px]">add</span></button>
    </div>

    <div class="flex items-center justify-between mt-6 mb-2">
      <span class="font-label-sm text-label-sm text-on-surface-variant tracking-wider">${todoTab==='today' ? "À FAIRE AUJOURD'HUI" : todoTab==='longterme' ? 'OBJECTIFS LONG TERME' : 'TERMINÉES AUJOURD\u2019HUI'}</span>
      <span class="font-label-sm text-label-sm text-on-surface-variant">${list.length} ${todoTab==='done' ? 'tâches' : 'restantes'}</span>
    </div>
    <div class="flex flex-col gap-2.5" id="task-list">
      ${list.length === 0 ? `<div class="rounded-2xl bg-surface-container p-6 text-center"><p class="font-body-md text-body-md text-on-surface-variant">Rien ici pour l'instant.</p></div>` : list.map(t => `
      <div class="rounded-2xl bg-surface-container p-3.5 flex items-center gap-3">
        <button data-action="toggle" data-id="${t.id}" class="w-6 h-6 rounded-full border-2 ${t.done ? 'bg-primary border-primary' : 'border-outline-variant'} flex items-center justify-center shrink-0 transition-colors">
          ${t.done ? '<span class="material-symbols-outlined text-on-primary text-[16px]">check</span>' : ''}
        </button>
        <div class="min-w-0 flex-1">
          <p class="font-body-md text-body-md ${t.done ? 'line-through text-on-surface-variant' : 'text-on-surface'} truncate">${t.text}</p>
          <div class="flex items-center gap-1.5 mt-0.5">
            <span class="w-1.5 h-1.5 rounded-full ${priorityDot(t.priority)} inline-block"></span>
            <span class="font-label-sm text-label-sm text-on-surface-variant">${priorityLabel(t.priority)}</span>
            ${t.category ? `<span class="font-label-sm text-label-sm text-on-surface-variant">·</span><span class="px-1.5 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant font-label-sm text-label-sm">${t.category}</span>` : ''}
          </div>
        </div>
        ${t.time ? `<span class="px-2 py-1 rounded-full bg-surface-container-high text-on-surface-variant font-label-sm text-label-sm shrink-0">${t.time}</span>` : ''}
        <button data-action="delete" data-id="${t.id}" class="w-7 h-7 rounded-full flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[16px]">close</span></button>
      </div>`).join('')}
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
  function addFromInput(){
    const input = document.getElementById('new-task-input');
    const text = input.value.trim();
    if(!text) return;
    state.tasks.push({ id: uid(), text, priority: newPriority, category: '', time: '', done: false, list: todoTab==='longterme' ? 'longterme' : 'today', date: dstr(TODAY) });
    input.value = '';
    saveState(); renderTodo(); toast('Tâche ajoutée');
  }
  el.querySelector('#btn-add-task').addEventListener('click', addFromInput);
  el.querySelector('#new-task-input').addEventListener('keydown', (e) => { if(e.key==='Enter') addFromInput(); });
  el.querySelectorAll('[data-action="toggle"]').forEach(b => b.addEventListener('click', () => toggleTask(b.dataset.id)));
  el.querySelectorAll('[data-action="delete"]').forEach(b => b.addEventListener('click', () => {
    state.tasks = state.tasks.filter(t => t.id !== b.dataset.id);
    saveState(); renderTodo(); toast('Tâche supprimée');
  }));
}

function openAddTaskModal(){
  setActivePage('todo');
  setTimeout(() => document.getElementById('new-task-input')?.focus(), 50);
}

/* ===================== CALENDAR ===================== */
function renderCalendar(){
  const el = document.getElementById('page-calendar');
  const view = state.settings.calendarView;
  const selected = new Date(state.selectedDate + 'T00:00:00');

  let headerLabel, bodyHtml;
  if(view === 'Jour'){
    headerLabel = capitalize(selected.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));
    bodyHtml = renderDayStrip([selected], selected) + renderDaySummary(selected) + renderTimeline(selected);
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
  el.querySelectorAll('[data-action="del-event"]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.date || dstr(selected);
    state.events[key] = (state.events[key]||[]).filter(e => e.id !== b.dataset.id);
    saveState(); renderCalendar(); toast('Événement supprimé');
  }));
  el.querySelectorAll('[data-action="go-to-date"]').forEach(b => b.addEventListener('click', () => {
    state.selectedDate = b.dataset.date;
    state.settings.calendarView = 'Jour';
    saveState(); renderCalendar();
  }));
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
          const hasEvents = (state.events[dstr(d)]||[]).length > 0;
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
          const hasEvents = (state.events[dstr(d)]||[]).length > 0;
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
  const dayEvents = (state.events[dstr(selected)] || []);
  const totalMinutes = dayEvents.reduce((acc,e) => acc + (toMin(e.end)-toMin(e.start)), 0);
  return `
    <div class="rounded-2xl bg-surface-container-low p-3.5 flex items-center justify-between mb-5">
      <div class="flex items-center gap-2.5">
        <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-primary"><span class="material-symbols-outlined text-[18px]">insights</span></div>
        <div>
          <p class="font-headline-md text-headline-md text-on-surface capitalize">${selected.toLocaleDateString('fr-FR',{weekday:'long', day:'numeric', month:'long'})}</p>
          <p class="font-label-sm text-label-sm text-on-surface-variant">${dayEvents.length} événements · ${(totalMinutes/60).toFixed(1)}h réservées</p>
        </div>
      </div>
      <span class="px-2.5 py-1 rounded-full bg-primary/15 text-primary font-label-sm text-label-sm font-semibold">${dstr(selected)===dstr(TODAY) ? 'ACTIF' : ''}</span>
    </div>`;
}

function renderTimeline(selected){
  const dayEvents = (state.events[dstr(selected)] || []).slice().sort((a,b) => a.start.localeCompare(b.start));
  return `
    <div class="flex flex-col gap-4" id="events-timeline">
      ${dayEvents.length === 0 ? `<div class="rounded-2xl bg-surface-container p-6 text-center"><p class="font-body-md text-body-md text-on-surface-variant">Aucun événement ce jour.</p></div>` : dayEvents.map(ev => `
      <div class="flex gap-stack-gap">
        <div class="w-11 pt-1 text-right shrink-0"><span class="font-label-sm text-label-sm text-on-surface-variant font-medium">${ev.start}</span></div>
        <div class="flex-1 relative bg-surface-container rounded-xl p-card-padding overflow-hidden">
          <div class="absolute left-0 top-0 bottom-0 w-1 ${catColor(ev.category)}"></div>
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-tight-margin mb-1 flex-wrap">
                <span class="px-2 py-0.5 rounded-full ${catBadge(ev.category)} font-label-sm text-label-sm font-semibold tracking-wide uppercase">${ev.category}</span>
                <span class="font-label-sm text-label-sm text-on-surface-variant">${ev.start} - ${ev.end}</span>
              </div>
              <h3 class="font-headline-md text-headline-md text-on-surface truncate">${ev.title}</h3>
              <p class="font-body-md text-body-md text-on-surface-variant truncate mt-0.5">${ev.desc}</p>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <div class="w-7 h-7 rounded-full bg-surface-container-high flex items-center justify-center ${catText(ev.category)}"><span class="material-symbols-outlined text-[16px]">${ev.icon}</span></div>
              <button data-action="del-event" data-id="${ev.id}" data-date="${dstr(selected)}" class="w-7 h-7 rounded-full flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[16px]">close</span></button>
            </div>
          </div>
        </div>
      </div>`).join('')}
    </div>`;
}

function renderEventsList(){
  const entries = [];
  Object.keys(state.events).sort().forEach(dateKey => {
    (state.events[dateKey]||[]).forEach(ev => entries.push({ dateKey, ev }));
  });
  entries.sort((a,b) => a.dateKey === b.dateKey ? a.ev.start.localeCompare(b.ev.start) : a.dateKey.localeCompare(b.dateKey));
  if(entries.length === 0) return `<div class="mt-5 rounded-2xl bg-surface-container p-6 text-center"><p class="font-body-md text-body-md text-on-surface-variant">Aucun événement planifié.</p></div>`;
  let lastDate = null;
  let html = `<div class="mt-5 flex flex-col gap-4" id="events-timeline">`;
  entries.forEach(({dateKey, ev}) => {
    if(dateKey !== lastDate){
      lastDate = dateKey;
      const d = new Date(dateKey + 'T00:00:00');
      html += `<button data-action="go-to-date" data-date="${dateKey}" class="text-left font-label-sm text-label-sm text-primary tracking-wider mt-1 first:mt-0 capitalize">${d.toLocaleDateString('fr-FR',{weekday:'long', day:'numeric', month:'long'})}${dateKey===dstr(TODAY)?' · Aujourd\u2019hui':''}</button>`;
    }
    html += `
      <div class="flex gap-stack-gap">
        <div class="w-11 pt-1 text-right shrink-0"><span class="font-label-sm text-label-sm text-on-surface-variant font-medium">${ev.start}</span></div>
        <div class="flex-1 relative bg-surface-container rounded-xl p-card-padding overflow-hidden">
          <div class="absolute left-0 top-0 bottom-0 w-1 ${catColor(ev.category)}"></div>
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-tight-margin mb-1 flex-wrap">
                <span class="px-2 py-0.5 rounded-full ${catBadge(ev.category)} font-label-sm text-label-sm font-semibold tracking-wide uppercase">${ev.category}</span>
                <span class="font-label-sm text-label-sm text-on-surface-variant">${ev.start} - ${ev.end}</span>
              </div>
              <h3 class="font-headline-md text-headline-md text-on-surface truncate">${ev.title}</h3>
              <p class="font-body-md text-body-md text-on-surface-variant truncate mt-0.5">${ev.desc}</p>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <div class="w-7 h-7 rounded-full bg-surface-container-high flex items-center justify-center ${catText(ev.category)}"><span class="material-symbols-outlined text-[16px]">${ev.icon}</span></div>
              <button data-action="del-event" data-id="${ev.id}" data-date="${dateKey}" class="w-7 h-7 rounded-full flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[16px]">close</span></button>
            </div>
          </div>
        </div>
      </div>`;
  });
  html += `</div>`;
  return html;
}

function toMin(t){ const [h,m] = t.split(':').map(Number); return h*60+m; }
function catColor(c){ return { 'Travail':'bg-primary', 'Personnel':'bg-tertiary', 'Focus':'bg-primary', 'Santé':'bg-secondary' }[c] || 'bg-outline-variant'; }
function catBadge(c){ return { 'Travail':'bg-primary-container/20 text-primary', 'Personnel':'bg-tertiary-container/30 text-tertiary', 'Focus':'bg-primary-container/20 text-primary', 'Santé':'bg-secondary-container text-on-secondary-container' }[c] || 'bg-surface-container-high text-on-surface-variant'; }
function catText(c){ return { 'Travail':'text-primary', 'Personnel':'text-tertiary', 'Focus':'text-primary', 'Santé':'text-secondary' }[c] || 'text-on-surface-variant'; }

function openAddEventModal(dateKey){
  openModal(`
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-headline-lg text-headline-lg text-on-surface">Nouvel événement</h3>
      <button data-action="close" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[18px]">close</span></button>
    </div>
    <div class="flex flex-col gap-3">
      <input id="ev-title" type="text" placeholder="Titre de l'événement" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
      <input id="ev-desc" type="text" placeholder="Description (optionnel)" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
      <div class="flex gap-3">
        <input id="ev-start" type="time" value="09:00" class="flex-1 bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
        <input id="ev-end" type="time" value="10:00" class="flex-1 bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
      </div>
      <select id="ev-category" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary">
        <option value="Travail">Travail</option>
        <option value="Personnel">Personnel</option>
        <option value="Focus">Focus</option>
        <option value="Santé">Santé</option>
      </select>
      <button id="btn-save-event" class="mt-2 w-full py-3.5 rounded-xl bg-primary text-on-primary font-headline-md text-headline-md font-semibold active:scale-[0.98] transition-all">Ajouter à l'agenda</button>
    </div>
  `);
  document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
  document.getElementById('btn-save-event').addEventListener('click', () => {
    const title = document.getElementById('ev-title').value.trim();
    if(!title){ toast('Ajoute un titre'); return; }
    const cat = document.getElementById('ev-category').value;
    const icons = { 'Travail':'groups', 'Personnel':'restaurant', 'Focus':'bolt', 'Santé':'fitness_center' };
    const ev = { id: uid(), start: document.getElementById('ev-start').value, end: document.getElementById('ev-end').value, title, desc: document.getElementById('ev-desc').value.trim() || 'Aucune description', category: cat, icon: icons[cat] };
    if(!state.events[dateKey]) state.events[dateKey] = [];
    state.events[dateKey].push(ev);
    saveState(); closeModal(); renderCalendar(); toast('Événement ajouté');
  });
}

/* ===================== GOALS ===================== */
let goalsFilter = 'Tous';
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
      <button id="btn-ai-eval" class="flex-1 py-2.5 rounded-xl bg-surface-container-high text-on-surface font-body-md text-body-md flex items-center justify-center gap-1.5 active:scale-95 transition-transform"><span class="material-symbols-outlined text-[18px]">auto_awesome</span>Évaluation IA</button>
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
      ${filtered.length===0 ? `<div class="rounded-2xl bg-surface-container p-6 text-center"><p class="font-body-md text-body-md text-on-surface-variant">Aucun objectif dans cette catégorie.</p></div>` : filtered.map(g => `
      <div class="rounded-2xl bg-surface-container p-card-padding">
        <div class="flex items-center justify-between mb-2 flex-wrap gap-1.5">
          <span class="px-2 py-0.5 rounded-full ${catBadge(g.category.startsWith('Carrière')?'Travail':g.category.startsWith('Santé')?'Santé':g.category.startsWith('Finances')?'Focus':'Personnel')} font-label-sm text-label-sm font-semibold">${g.category}</span>
          <span class="font-label-sm text-label-sm text-on-surface-variant flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">event</span>${g.deadline}</span>
          <span class="font-label-sm text-label-sm text-on-surface-variant ml-auto">${g.status}</span>
        </div>
        <h3 class="font-headline-md text-headline-md text-on-surface">${g.title}</h3>
        <div class="flex items-center justify-between mt-2 mb-1.5">
          <span class="font-label-md text-label-md text-on-surface-variant">${g.metric}</span>
          <span class="font-label-md text-label-md text-on-surface font-semibold">${g.progress}%</span>
        </div>
        <div class="h-1.5 w-full rounded-full bg-surface-container-highest overflow-hidden">
          <div class="h-full rounded-full bg-gradient-to-r from-primary to-secondary" style="width:${g.progress}%"></div>
        </div>
        <div class="flex items-center gap-2 mt-3">
          <button data-action="dec" data-id="${g.id}" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant active:scale-90 transition-transform"><span class="material-symbols-outlined text-[16px]">remove</span></button>
          <button data-action="inc" data-id="${g.id}" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant active:scale-90 transition-transform"><span class="material-symbols-outlined text-[16px]">add</span></button>
          <button data-action="del-goal" data-id="${g.id}" class="ml-auto w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[16px]">delete</span></button>
        </div>
      </div>`).join('')}
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
  el.querySelector('#btn-new-goal').addEventListener('click', openAddGoalModal);
  el.querySelector('#btn-add-ambition').addEventListener('click', openAddGoalModal);
  el.querySelector('#btn-ai-eval').addEventListener('click', () => toast(`Progression moyenne: ${globalProgress}% · continue comme ça !`));
  el.querySelectorAll('[data-action="inc"]').forEach(b => b.addEventListener('click', () => adjustGoal(b.dataset.id, 5)));
  el.querySelectorAll('[data-action="dec"]').forEach(b => b.addEventListener('click', () => adjustGoal(b.dataset.id, -5)));
  el.querySelectorAll('[data-action="del-goal"]').forEach(b => b.addEventListener('click', () => {
    state.goals = state.goals.filter(g => g.id !== b.dataset.id);
    saveState(); renderGoals(); toast('Objectif supprimé');
  }));
}
function adjustGoal(id, delta){
  const g = state.goals.find(g => g.id === id);
  if(!g) return;
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
function openAddGoalModal(){
  openModal(`
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-headline-lg text-headline-lg text-on-surface">Nouvel objectif</h3>
      <button data-action="close" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[18px]">close</span></button>
    </div>
    <div class="flex flex-col gap-3">
      <input id="g-title" type="text" placeholder="Titre de l'objectif" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
      <input id="g-metric" type="text" placeholder="Indicateur (ex: 20 000 CHF épargnés)" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
      <div class="flex gap-3">
        <input id="g-category" type="text" placeholder="Catégorie" class="flex-1 bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
        <input id="g-deadline" type="text" placeholder="Échéance" class="flex-1 bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary"/>
      </div>
      <button id="btn-save-goal" class="mt-2 w-full py-3.5 rounded-xl bg-primary text-on-primary font-headline-md text-headline-md font-semibold active:scale-[0.98] transition-all">Créer l'objectif</button>
    </div>
  `);
  document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
  document.getElementById('btn-save-goal').addEventListener('click', () => {
    const title = document.getElementById('g-title').value.trim();
    if(!title){ toast('Ajoute un titre'); return; }
    state.goals.push({ id: uid(), category: document.getElementById('g-category').value.trim() || 'Perso', title, deadline: document.getElementById('g-deadline').value.trim() || 'À définir', status: 'Nouveau', metric: document.getElementById('g-metric').value.trim() || 'Progression', progress: 0 });
    saveState(); closeModal(); renderGoals(); toast('Objectif créé');
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

    <span class="font-label-sm text-label-sm text-primary tracking-wider mt-6 mb-2 flex items-center gap-1.5"><span class="material-symbols-outlined text-[15px]">sync</span>DONNÉES & SYNCHRONISATION</span>
    <div class="rounded-2xl bg-surface-container divide-y divide-white/[0.06]">
      <div class="p-card-padding flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant shrink-0"><span class="material-symbols-outlined text-[18px]">cloud_done</span></div>
          <div class="min-w-0"><p class="font-body-md text-body-md text-on-surface">Sauvegarde Cloud & Local</p><p class="font-label-sm text-label-sm text-on-surface-variant">Chiffrement AES-256 actif</p></div>
        </div>
        <span class="px-2 py-1 rounded-full bg-surface-container-high font-label-sm text-label-sm text-on-surface-variant flex items-center gap-1 shrink-0"><span class="w-1.5 h-1.5 rounded-full bg-primary inline-block"></span>${nowTime()}</span>
      </div>
      <button id="btn-export" class="w-full p-card-padding flex items-center justify-between gap-3 text-left">
        <div class="flex items-center gap-3 min-w-0"><span class="material-symbols-outlined text-on-surface-variant text-[18px]">download</span><span class="font-body-md text-body-md text-on-surface">Exporter toutes mes données (.json)</span></div>
        <span class="material-symbols-outlined text-on-surface-variant text-[18px]">chevron_right</span>
      </button>
    </div>

    <span class="font-label-sm text-label-sm text-primary tracking-wider mt-6 mb-2 flex items-center gap-1.5"><span class="material-symbols-outlined text-[15px]">shield</span>COMPTE & SÉCURITÉ</span>
    <div class="rounded-2xl bg-surface-container divide-y divide-white/[0.06]">
      <button id="btn-change-name" class="w-full p-card-padding flex items-center justify-between gap-3 text-left">
        <div class="flex items-center gap-3"><span class="material-symbols-outlined text-on-surface-variant text-[18px]">badge</span><span class="font-body-md text-body-md text-on-surface">Modifier le profil</span></div>
        <span class="material-symbols-outlined text-on-surface-variant text-[18px]">chevron_right</span>
      </button>
      <button class="w-full p-card-padding flex items-center justify-between gap-3 text-left" onclick="toast('Confidentialité & stockage privé')">
        <div class="flex items-center gap-3"><span class="material-symbols-outlined text-on-surface-variant text-[18px]">lock</span><span class="font-body-md text-body-md text-on-surface">Confidentialité & stockage privé</span></div>
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
function openEditProfileModal(){
  openModal(`
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-headline-lg text-headline-lg text-on-surface">Modifier le profil</h3>
      <button data-action="close" class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[18px]">close</span></button>
    </div>
    <div class="flex flex-col gap-3">
      <input id="p-name" type="text" value="${state.user.name}" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
      <input id="p-email" type="email" value="${state.user.email}" class="w-full bg-surface-container-highest/60 border border-white/10 rounded-xl px-3.5 py-3 outline-none font-body-md text-body-md text-on-surface focus:border-primary"/>
      <button id="btn-save-profile" class="mt-2 w-full py-3.5 rounded-xl bg-primary text-on-primary font-headline-md text-headline-md font-semibold active:scale-[0.98] transition-all">Enregistrer</button>
    </div>
  `);
  document.querySelector('[data-action="close"]').addEventListener('click', closeModal);
  document.getElementById('btn-save-profile').addEventListener('click', () => {
    const name = document.getElementById('p-name').value.trim() || state.user.name;
    state.user.name = name;
    state.user.email = document.getElementById('p-email').value.trim() || state.user.email;
    state.user.initials = name.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
    saveState(); closeModal(); renderSettings(); toast('Profil mis à jour');
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
      if(!state.reminders) state.reminders = [];
      showApp();
      setActivePage('home');
      return;
    }
  }
  showLogin();
})();
