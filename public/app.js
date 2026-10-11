/* ============================================================
   MUZORA AI — app logic (real backend: auth, audio, persistence)
   ============================================================ */

/* ---------------- API client ---------------- */
const API = {
  token: localStorage.getItem("muzora_token") || null,
  async call(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(API.token ? { Authorization: "Bearer " + API.token } : {}),
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/api/auth/me") {
      // session expired
      API.token = null;
      localStorage.removeItem("muzora_token");
    }
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  },
  setToken(t) {
    API.token = t;
    if (t) localStorage.setItem("muzora_token", t);
    else localStorage.removeItem("muzora_token");
  },
};

/* ---------------- Client-side mood palette ---------------- */
const MOODS = {
  calm:     {label:"Calm",     m1:"#22d3ee", m2:"#10b981", emoji:"🌙", desc:"unwinding · slow tempo · soft focus"},
  focus:    {label:"Focus",    m1:"#818cf8", m2:"#6366f1", emoji:"🎯", desc:"deep work · steady rhythm · no vocals"},
  happy:    {label:"Happy",    m1:"#f59e0b", m2:"#fb923c", emoji:"☀️", desc:"bright tempo · major keys · uplift"},
  energetic:{label:"Energetic",m1:"#ec4899", m2:"#f43f5e", emoji:"⚡", desc:"high BPM · drops · momentum"},
  dreamy:   {label:"Dreamy",   m1:"#a78bfa", m2:"#8b5cf6", emoji:"✨", desc:"floating textures · reverb · nostalgia"},
  sleep:    {label:"Sleep",    m1:"#4f46e5", m2:"#312e81", emoji:"💤", desc:"drone · decay · 60bpm heartbeat"},
};

/* Featured playlists are derived from the catalog client-side */
const FEATURED_DEF = [
  {name:"Neon Nights",      mood:"energetic", c1:"#8b5cf6", c2:"#22d3ee", desc:"Synthwave for the late drive"},
  {name:"Monsoon Study",    mood:"focus",     c1:"#818cf8", c2:"#22d3ee", desc:"Lo-fi + ambient focus"},
  {name:"Himalaya Sunrise", mood:"happy",     c1:"#f59e0b", c2:"#34d399", desc:"Acoustic mornings"},
  {name:"Voltage Room",     mood:"calm",      c1:"#22d3ee", c2:"#10b981", desc:"Unwind · rain-soaked calm"},
];

/* ---------------- State ---------------- */
const state = {
  user: null,
  songs: [],            // full catalog (normalized)
  queue: [],            // current play queue
  qi: 0,
  playing: false,
  shuffle: false,
  repeat: false,
  favorites: new Set(),
  userPlaylists: [],
  recent: [],
  stats: {plays: 0, minutes: 0, mixes: 0},
  session: null,        // AI generated session
  libTab: "playlists",
  worldById: new Map(), // world (iTunes) tracks currently rendered
  charts: [],           // world chart entries
  chartStore: "in",
};

const $  = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];

/* ---------------- Helpers ---------------- */
const fmt = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;
const norm = s => ({...s, c1: s.colors[0], c2: s.colors[1], dur: s.duration});
const cur = () => state.queue[state.qi];
const byId = id => state.songs.find(t => t.id === id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toast(msg){
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(()=>t.classList.remove("show"), 2200);
}

function setMoodVars(moodKey){
  const m = MOODS[moodKey] || MOODS.dreamy;
  const app = $("#app");
  app.style.setProperty("--m1", m.m1);
  app.style.setProperty("--m2", m.m2);
}

/* Waveform bar heights */
const WAVE = [22,38,55,40,70,52,88,64,45,78,95,60,42,72,58,90,48,66,38,82,55,44,76,62,35,68,50,86,58,40,74,64,46,80,54,34,60,48,72,66,52,44];
function renderWave(el, n, playing, progress=0){
  el.innerHTML = "";
  const step = Math.max(1, Math.floor(WAVE.length / n));
  for(let i=0;i<n;i++){
    const b = document.createElement("b");
    const h = WAVE[(i*step) % WAVE.length];
    b.style.height = h + "%";
    b.style.animationDelay = ((i%8)*0.09) + "s";
    if(progress){
      b.style.setProperty("--p", Math.min(100, progress*100) + "%");
    }
    el.appendChild(b);
  }
}

/* ---------------- Navigation ---------------- */
const TABS = ["home","search","ai","library","profile"];
let activeTab = "home";

function show(id){
  $$(".scr").forEach(s=>s.classList.remove("active"));
  $("#scr-"+id).classList.add("active");
  if(TABS.includes(id)){
    activeTab = id;
    $$(".tab").forEach(t=>t.classList.toggle("on", t.dataset.goto===id));
    if(id==="library") refreshLibrary();
  }
  const chromeVisible = id!=="splash" && id!=="auth";
  $("#mini").style.display = chromeVisible ? "flex" : "none";
  $("#tabbar").style.display = chromeVisible ? "flex" : "none";
  $("#mini").classList.toggle("lifted", id==="ai");
}

function closeOverlay(){
  show(activeTab);
}

/* Single consolidated click-delegation handler */
document.addEventListener("click", e=>{
  const fav = e.target.closest("[data-fav]");
  if(fav){
    e.stopImmediatePropagation();
    toggleFav(+fav.dataset.fav);
    return;
  }

  const toastBtn = e.target.closest("[data-toast]");
  if(toastBtn){ toast(toastBtn.dataset.toast); return; }

  const goto = e.target.closest("[data-goto]");
  if(goto){ show(goto.dataset.goto); return; }

  const close = e.target.closest("[data-close]");
  if(close){ closeOverlay(); return; }

  const aiBtn = e.target.closest("[data-ai]");
  if(aiBtn){
    show("ai");
    setTimeout(()=>handleAiPrompt(aiBtn.dataset.ai), 250);
    return;
  }

  const libTab = e.target.closest("[data-libtab]");
  if(libTab){
    setLibTab(libTab.dataset.libtab);
    return;
  }

  const chTab = e.target.closest("[data-charts]");
  if(chTab){ loadCharts(chTab.dataset.charts); return; }

  const pc = e.target.closest("[data-pl]");
  if(pc){ openPlaylistByRef(pc.dataset.pl); return; }

  const chRow = e.target.closest("[data-chart-idx]");
  if(chRow){ playChart(+chRow.dataset.chartIdx); return; }

  const wRow = e.target.closest(".track.world[data-wid]");
  if(wRow){
    const t = state.worldById.get(wRow.dataset.wid);
    if(t) playWorld(t);
    return;
  }

  const rt = e.target.closest(".rail-track");
  if(rt && rt.dataset.tid){
    playSong(+rt.dataset.tid);
    toast("▶ " + cur().title);
    return;
  }

  const row = e.target.closest(".track");
  if(row && row.dataset.tid){
    playSong(+row.dataset.tid);
    show("player");
  }
});

/* ---------------- Auth ---------------- */
let authMode = "login";

$$("#authSeg button").forEach(b=>{
  b.addEventListener("click", ()=>{
    $$("#authSeg button").forEach(x=>x.classList.remove("on"));
    b.classList.add("on");
    authMode = b.dataset.auth;
    $("#authSeg").classList.toggle("reg", authMode==="register");
    $("#authName").style.display = authMode==="register" ? "block" : "none";
    $("#btnAuth").textContent = authMode==="register" ? "Create account" : "Enter Muzora";
    authError("");
  });
});

function authError(msg){
  const el = $("#authError");
  el.textContent = msg;
  el.classList.toggle("show", !!msg);
}

$("#btnAuth").addEventListener("click", async ()=>{
  const email = $("#inpEmail").value.trim();
  const pass = $("#inpPass").value;
  const name = $("#inpName").value.trim();
  authError("");
  $("#btnAuth").textContent = "…";
  try{
    let r;
    if(authMode==="register"){
      if(name.length < 2) throw new Error("Please enter your name.");
      r = await API.call("/api/auth/register", {method:"POST", body: JSON.stringify({name, email, password: pass})});
    }else{
      r = await API.call("/api/auth/login", {method:"POST", body: JSON.stringify({email, password: pass})});
    }
    API.setToken(r.token);
    await enterApp(r.user);
  }catch(err){
    authError(err.message);
  }finally{
    $("#btnAuth").textContent = authMode==="register" ? "Create account" : "Enter Muzora";
  }
});

$("#inpPass").addEventListener("keydown", e=>{ if(e.key==="Enter") $("#btnAuth").click(); });

$("#btnLogout").addEventListener("click", ()=>{
  audio.pause();
  API.setToken(null);
  state.user = null;
  location.reload();
});

/* ---------------- Audio player ---------------- */
const audio = new Audio();
audio.preload = "auto";

audio.addEventListener("play",  ()=>{ state.playing = true;  renderTrackUI(); });
audio.addEventListener("pause", ()=>{ state.playing = false; renderTrackUI(); });
audio.addEventListener("loadedmetadata", ()=>{ if(cur()) $("#tDur").textContent = fmt(audio.duration || cur().dur); });
audio.addEventListener("timeupdate", ()=>{
  const t = cur();
  if(!t) return;
  const dur = audio.duration || t.dur;
  const p = (audio.currentTime / dur) || 0;
  $("#tCur").textContent = fmt(audio.currentTime);
  renderWave($("#lpWave"), 42, state.playing, p);
  renderWave($("#heroWave"), 26, state.playing, p);
});
audio.addEventListener("ended", ()=>{
  if(state.repeat){ audio.currentTime = 0; audio.play(); return; }
  nextTrack(true);
});

function renderTrackUI(){
  const t = cur();
  if(!t) return;
  const app = $("#app");
  app.style.setProperty("--c1", t.c1);
  app.style.setProperty("--c2", t.c2);

  $("#heroTitle").textContent = t.title;
  $("#heroArtist").textContent = `${t.artist} · ${t.genre}`;
  $("#heroArt").style.background = t.cover ? `center/cover no-repeat url("${t.cover}")` : `linear-gradient(135deg,${t.c1},${t.c2})`;
  const dur = audio.duration || t.dur;
  renderWave($("#heroWave"), 26, state.playing, audio.currentTime/dur);

  $("#miniTitle").textContent = t.title;
  $("#miniArtist").textContent = t.artist;
  $("#miniArt").style.background = t.cover ? `center/cover no-repeat url("${t.cover}")` : `linear-gradient(135deg,${t.c1},${t.c2})`;
  renderWave($("#miniWave"), 7, state.playing);
  $("#mini").classList.toggle("playing", state.playing);

  $("#lpTitle").textContent = t.title;
  $("#lpArtist").textContent = `${t.artist} · ${t.genre}`;
  $("#tDur").textContent = fmt(dur);
  $("#tCur").textContent = fmt(audio.currentTime);
  $("#lpFav").classList.toggle("on", state.favorites.has(t.id));
  $("#lpFav").style.display = t.world ? "none" : "";
  renderWave($("#lpWave"), 42, state.playing, audio.currentTime/dur);
  $("#scr-player").classList.toggle("playing", state.playing);

  const next = state.queue[(state.qi+1) % state.queue.length] || t;
  $("#unTitle").textContent = `${next.title} — ${next.artist}`;
  $("#unArt").style.background = next.cover ? `center/cover no-repeat url("${next.cover}")` : `linear-gradient(135deg,${next.c1},${next.c2})`;

  $$(".track").forEach(el=>el.classList.toggle("now", +el.dataset.tid === t.id));
}

function playQueue(list, index){
  state.userPlayed = true;
  state.queue = list.length ? list : state.songs;
  state.qi = Math.max(0, Math.min(index, state.queue.length-1));
  loadCurrent(true);
}

function playSong(id){
  state.userPlayed = true;
  const i = state.queue.findIndex(t=>t.id===id);
  if(i>=0 && state.queue[i]){ state.qi = i; loadCurrent(true); }
  else {
    const t = byId(id);
    if(t) playQueue([t], 0);
  }
}

function loadCurrent(autoplay){
  const t = cur();
  if(!t) return;
  audio.src = t.audio;
  if(autoplay){
    audio.play().then(()=>{
      if(!t.world) recordHistory(t.id);
    }).catch(()=>{ /* autoplay blocked */ });
  }
  renderTrackUI();
}

function setPlaying(on){
  if(on) audio.play().catch(()=>{});
  else audio.pause();
}

function nextTrack(){
  if(state.shuffle) state.qi = Math.floor(Math.random()*state.queue.length);
  else state.qi = (state.qi+1) % state.queue.length;
  loadCurrent(true);
}
function prevTrack(){
  if(audio.currentTime > 3){ audio.currentTime = 0; return; }
  state.qi = (state.qi-1+state.queue.length) % state.queue.length;
  loadCurrent(true);
}

let historyBusy = false;
async function recordHistory(id){
  if(!API.token || historyBusy) return;
  historyBusy = true;
  try{
    await API.call("/api/history", {method:"POST", body: JSON.stringify({songId: id})});
    await loadRecent(); // refresh recent rail + stats quietly
  }catch{ /* offline-tolerant */ }
  finally{ historyBusy = false; }
}

$("#btnPlay").addEventListener("click", ()=>setPlaying(!state.playing));
$("#miniPlay").addEventListener("click", e=>{ e.stopPropagation(); setPlaying(!state.playing); });
$("#miniNext").addEventListener("click", e=>{ e.stopPropagation(); nextTrack(); toast("Skipped → " + (cur()?cur().title:"")); });
$("#btnNext").addEventListener("click", nextTrack);
$("#btnPrev").addEventListener("click", prevTrack);
$("#btnShuffle").addEventListener("click", e=>{ state.shuffle=!state.shuffle; e.currentTarget.classList.toggle("on", state.shuffle); toast(state.shuffle?"Shuffle on":"Shuffle off"); });
$("#btnRepeat").addEventListener("click", e=>{ state.repeat=!state.repeat; e.currentTarget.classList.toggle("on", state.repeat); toast(state.repeat?"Repeat one":"Repeat off"); });
$("#mini").addEventListener("click", ()=>show("player"));
$("#lpFav").addEventListener("click", ()=>{ const t = cur(); if(t) toggleFav(t.id); });

/* Seek on waveform click */
$("#lpWave").addEventListener("click", e=>{
  const r = e.currentTarget.getBoundingClientRect();
  const t = cur();
  if(!t) return;
  const dur = audio.duration || t.dur;
  audio.currentTime = Math.max(0, Math.min(1,(e.clientX-r.left)/r.width)) * dur;
});

/* ---------------- Favorites ---------------- */
async function toggleFav(id){
  const wasFav = state.favorites.has(id);
  // optimistic
  if(wasFav) state.favorites.delete(id); else state.favorites.add(id);
  renderFavorites(); renderLibraryLists(); renderTrackUI();
  try{
    const r = await API.call(`/api/favorites/${id}`, {method:"POST"});
    toast(r.favorited ? "Added to favorites ♥" : "Removed from favorites");
    if(!r.favorited) state.favorites.delete(id); else state.favorites.add(id);
  }catch(err){
    // revert on failure
    if(wasFav) state.favorites.add(id); else state.favorites.delete(id);
    toast(err.message);
  }
  renderFavorites(); renderLibraryLists(); renderTrackUI();
}

/* ---------------- Track list rendering ---------------- */
function trackRow(t, ctx){
  const isNow = cur() && t.id === cur().id;
  if(t.world){
    return `
    <div class="track world ${isNow?'now':''}" data-wid="${t.id}" data-ctx="${ctx}">
      <div class="t-art" style="background-image:url('${t.cover}')"></div>
      <div class="t-meta"><b>${escapeHtml(t.title)}</b><span>${escapeHtml(t.artist)} · ${escapeHtml(t.genre)}</span></div>
      <span class="t-world">WORLD</span>
      <span class="t-dur">${fmt(t.dur)}</span>
    </div>`;
  }
  const fav = state.favorites.has(t.id);
  return `
  <div class="track ${isNow?'now':''}" data-tid="${t.id}" data-ctx="${ctx}">
    <div class="t-art" style="--c1:${t.c1};--c2:${t.c2}"></div>
    <div class="t-meta"><b>${t.title}</b><span>${t.artist} · ${t.genre}</span></div>
    ${isNow && state.playing
      ? `<div class="t-eq"><b></b><b></b><b></b></div>`
      : `<button class="t-fav ${fav?'on':''}" data-fav="${t.id}">${fav?'♥':'♡'}</button>`}
    <span class="t-dur">${fmt(t.dur)}</span>
  </div>`;
}

/* ---------------- Home ---------------- */
function renderHome(){
  renderMixRail($("#moodDial").value);
  renderRecentRail();
  renderFeatured();
}

async function loadHome(){
  try{
    const r = await API.call("/api/recommendations");
    state.reco = (r.recommendations||[]).map(norm);
    // prime the queue + hero with the top recommendation until the user plays something
    if(state.reco.length && !state.playing && audio.currentTime === 0 && !state.userPlayed){
      state.queue = state.reco;
      state.qi = 0;
      renderTrackUI();
    }
  }catch{ /* fall back to catalog order */ }
}

function renderRecentRail(){
  const recent = state.recent.length ? state.recent : state.songs.slice(0,5);
  $("#railRecent").innerHTML = recent.slice(0,8).map(t=>`
    <button class="rail-track" data-tid="${t.id}" style="--c1:${t.c1};--c2:${t.c2}">
      <div class="art"><div class="peq"><b style="height:40%"></b><b style="height:75%"></b><b style="height:55%"></b></div></div>
      <b>${t.title}</b><span>${t.artist}</span>
    </button>`).join("");
}

function renderFeatured(){
  const featured = FEATURED_DEF.map(f=>{
    const tracks = state.songs.filter(t=>t.mood===f.mood).slice(0,6);
    return {...f, tracks};
  }).filter(f=>f.tracks.length);
  $("#gridFeatured").innerHTML = featured.map(p=>`
    <button class="pl-card" data-pl="f:${p.name}" style="--c1:${p.c1};--c2:${p.c2}">
      <div class="plc-art"></div>
      <div class="plc-body"><b>${p.name}</b><span>${p.tracks.length} tracks · Muzora</span></div>
    </button>`).join("");
  // stash for detail view
  state.featured = featured;
}

function moodFromDial(v){
  if(v<20) return "calm";
  if(v<40) return "focus";
  if(v<60) return "dreamy";
  if(v<80) return "happy";
  return "energetic";
}

function renderMixRail(v){
  const key = moodFromDial(+v);
  const m = MOODS[key];
  $("#dialState").innerHTML = `${m.label} <em>· tuned mix</em>`;
  $("#mixTitle").textContent = `${m.label} Mix`;
  setMoodVars(key);
  let mix = state.songs.filter(t=>t.mood===key).slice(0,6);
  if(mix.length<4) mix.push(...state.songs.filter(t=>t.mood!==key).slice(0,4-mix.length));
  $("#railMix").innerHTML = mix.map(t=>`
    <button class="rail-track" data-tid="${t.id}" style="--c1:${t.c1};--c2:${t.c2}">
      <div class="art"><div class="peq"><b style="height:40%"></b><b style="height:75%"></b><b style="height:55%"></b></div></div>
      <b>${t.title}</b><span>${t.artist}</span>
    </button>`).join("");
}

$("#moodDial").addEventListener("input", e=>renderMixRail(e.target.value));

/* ---------------- Search ---------------- */
let searchTimer = null;
$("#searchInput").addEventListener("input", e=>{
  const q = e.target.value.trim();
  $("#searchClear").style.display = q ? "block" : "none";
  clearTimeout(searchTimer);
  if(!q){
    $("#searchResults").style.display="none";
    $("#searchBrowse").style.display="block";
    return;
  }
  searchTimer = setTimeout(()=>runSearch(q), 280);
});
$("#searchClear").addEventListener("click", ()=>{
  $("#searchInput").value="";
  $("#searchClear").style.display="none";
  $("#searchResults").style.display="none";
  $("#searchBrowse").style.display="block";
});
$$("#searchChips .chip").forEach(c=>{
  c.addEventListener("click", ()=>{
    $("#searchInput").value = c.dataset.q;
    $("#searchClear").style.display="block";
    runSearch(c.dataset.q);
  });
});

async function runSearch(q){
  try{
    const r = await API.call("/api/search?q=" + encodeURIComponent(q));
    const res = (r.songs||[]).map(norm);
    $("#searchBrowse").style.display="none";
    $("#searchResults").style.display="block";
    $("#searchCount").textContent = `${res.length} result${res.length!==1?"s":""} for “${q}”`;
    $("#searchList").innerHTML = res.length
      ? res.map(t=>trackRow(t,"search")).join("")
      : `<p class="no-res">Nothing in Muzora Originals — check worldwide results below.</p>`;
    runWorldSearch(q);
  }catch(err){
    toast(err.message);
  }
}

/* Worldwide results (iTunes proxy) */
async function runWorldSearch(q){
  $("#worldWrap").style.display="none";
  $("#worldList").innerHTML = `<p class="no-res">Searching worldwide…</p>`;
  try{
    const r = await API.call("/api/world/search?q=" + encodeURIComponent(q));
    const songs = r.songs||[];
    state.worldById = new Map(songs.map(s=>[s.id, s]));
    if(songs.length){
      $("#worldWrap").style.display="block";
      $("#worldList").innerHTML = songs.map(t=>trackRow(t,"world")).join("");
    }else{
      $("#worldList").innerHTML = "";
    }
  }catch{
    $("#worldList").innerHTML = "";
  }
}

/* World charts (India / Global) */
async function loadCharts(store){
  state.chartStore = store;
  $$("[data-charts]").forEach(b=>b.classList.toggle("on", b.dataset.charts===store));
  $("#railCharts").innerHTML = `<p class="no-res">Loading charts…</p>`;
  try{
    const r = await API.call("/api/world/charts?store=" + store);
    state.charts = r.songs||[];
  }catch{ state.charts = []; }
  $("#railCharts").innerHTML = state.charts.map((c,i)=>`
    <button class="rail-track chart-track" data-chart-idx="${i}">
      <div class="art" style="background-image:url('${c.cover}')"><b class="chart-rank">${i+1}</b></div>
      <b>${escapeHtml(c.title)}</b><span>${escapeHtml(c.artist)}</span>
    </button>`).join("") || `<p class="no-res">Charts unavailable right now.</p>`;
  renderWorldHitsRail();
}

function renderWorldHitsRail(){
  const rail = $("#railWorldHits");
  if(!rail) return;
  if(!state.charts.length){ rail.innerHTML = `<p class="no-res">Loading worldwide hits…</p>`; return; }
  rail.innerHTML = state.charts.slice(0,10).map((c,i)=>`
    <button class="rail-track chart-track" data-chart-idx="${i}">
      <div class="art" style="background-image:url('${c.cover}')"><b class="chart-rank">${i+1}</b></div>
      <b>${escapeHtml(c.title)}</b><span>${escapeHtml(c.artist)}</span>
    </button>`).join("");
}

/* ---------------- World playback ---------------- */
function playWorld(t){
  state.userPlayed = true;
  state.queue = [t];
  state.qi = 0;
  loadCurrent(true);
  toast("▶ " + t.title + " · 30s preview");
}

async function playChart(idx){
  const c = state.charts[idx];
  if(!c) return;
  toast("Finding " + c.title + "…");
  try{
    const r = await API.call("/api/world/resolve?title=" + encodeURIComponent(c.title) + "&artist=" + encodeURIComponent(c.artist));
    playWorld(r.song);
  }catch(err){ toast(err.message); }
}

/* Artists rail from catalog */
function renderArtists(){
  const seen = new Map();
  state.songs.forEach(t=>{ if(!seen.has(t.artist)) seen.set(t.artist, t); });
  $("#railArtists").innerHTML = [...seen.entries()].map(([name, t])=>`
    <button class="rail-track" data-toast="Artist radio: ${name}" style="--c1:${t.c1};--c2:${t.c2}">
      <div class="art"></div><b>${name}</b><span>artist</span>
    </button>`).join("");
}

/* ---------------- Library ---------------- */
function setLibTab(tab){
  state.libTab = tab;
  $$("#libTabs button").forEach(b=>b.classList.toggle("on", b.dataset.libtab===tab));
  $("#libPlaylists").style.display  = tab==="playlists" ? "block":"none";
  $("#libFavorites").style.display  = tab==="favorites" ? "block":"none";
  $("#libRecent").style.display     = tab==="recent"    ? "block":"none";
  renderLibraryLists();
}
$$("#libTabs button").forEach(b=>b.addEventListener("click", ()=>setLibTab(b.dataset.libtab)));

async function refreshLibrary(){
  try{
    const [pl, hist] = await Promise.all([
      API.call("/api/playlists"),
      API.call("/api/history"),
    ]);
    state.userPlaylists = (pl.playlists||[]).map(p=>({
      id:"u:"+p.id, name:p.name, desc:p.description,
      tracks:(p.songs||[]).map(norm), source:p.source,
    }));
    state.recent = (hist.songs||[]).map(norm);
    state.stats = hist.stats || state.stats;
  }catch{ /* keep cached */ }
  renderPlaylistCards();
  renderLibraryLists();
  renderStats();
}

async function loadRecent(){
  try{
    const hist = await API.call("/api/history");
    state.recent = (hist.songs||[]).map(norm);
    state.stats = hist.stats || state.stats;
  }catch{ /* ignore */ }
  renderRecentRail();
  renderStats();
}

function renderLibraryLists(){
  const favs = state.songs.filter(t=>state.favorites.has(t.id));
  $("#favList").innerHTML = favs.map(t=>trackRow(t,"lib")).join("") || `<p class="no-res">No favorites yet — tap ♡ on any track.</p>`;
  $("#recentList").innerHTML = state.recent.map(t=>trackRow(t,"lib")).join("") || `<p class="no-res">Nothing played yet — spin a track!</p>`;
}

function renderFavorites(){
  const favs = state.songs.filter(t=>state.favorites.has(t.id));
  const html = favs.map(t=>trackRow(t,"fav")).join("") || `<p class="no-res">No favorites yet — tap ♡ on any track.</p>`;
  $("#favList2").innerHTML = html;
  $("#favCount").textContent = favs.length;
  $("#favCount2").textContent = favs.length;
  $("#libTabs button[data-libtab='playlists'] i").textContent = state.userPlaylists.length;
}

function renderStats(){
  $("#statMin").textContent = state.stats.minutes || 0;
  $("#statSongs").textContent = state.stats.plays || 0;
  $("#statMix").textContent = state.stats.mixes || 0;
}

/* Playlist cards + details */
let currentPl = null;

function renderPlaylistCards(){
  const pls = state.userPlaylists;
  $("#plCards").innerHTML = pls.length ? pls.map(p=>{
    const dur = p.tracks.reduce((a,t)=>a+t.dur,0);
    const c = p.tracks[0] || {c1:"#8b5cf6", c2:"#22d3ee"};
    return `
    <button class="pl-row" data-pl="${p.id}" style="--c1:${c.c1};--c2:${c.c2}">
      <div class="plr-art"></div>
      <div><b>${p.name}</b><span>${p.tracks.length} tracks · ${Math.round(dur/60)} min${p.source==="ai"?" · AI":""}</span></div>
      <span class="plr-play">▶</span>
    </button>`;
  }).join("") : `<p class="no-res">No playlists yet — generate an AI session and tap Save.</p>`;
}

function openPlaylistByRef(ref){
  if(ref.startsWith("f:")){
    const p = state.featured.find(x=>"f:"+x.name === ref);
    if(p) openPlaylist(p);
  }else{
    const p = state.userPlaylists.find(x=>x.id === ref);
    if(p) openPlaylist(p);
  }
}

function openPlaylist(p){
  currentPl = p;
  const app = $("#app");
  app.style.setProperty("--c1", p.c1);
  app.style.setProperty("--c2", p.c2);
  $("#plTitle").textContent = p.name;
  const dur = p.tracks.reduce((a,t)=>a+t.dur,0);
  $("#plMeta").textContent = `${p.tracks.length} tracks · ${Math.round(dur/60)} min`;
  $("#plList").innerHTML = p.tracks.map(t=>trackRow(t,"pl")).join("");
  show("playlist");
}

document.addEventListener("click", e=>{
  const pp = e.target.closest("[data-playlist-play]");
  if(pp && currentPl){
    playQueue(currentPl.tracks, 0);
    show("player");
  }
});

/* ---------------- AI Assistant ---------------- */
let aiBusy = false;

function addMsg(role, html){
  const chat = $("#chat");
  const el = document.createElement("div");
  el.className = "msg " + role;
  if(role==="ai"){
    el.innerHTML = `<div class="msg-ava"><img src="assets/muzora-logo.png" alt=""></div>${html}`;
  }else{
    el.innerHTML = html;
  }
  chat.appendChild(el);
  el.scrollIntoView({behavior:"smooth", block:"end"});
  return el;
}

async function handleAiPrompt(text, {silent=false} = {}){
  if(aiBusy || !text.trim()) return;
  aiBusy = true;
  if(!silent) addMsg("user", `<div class="msg-bubble">${escapeHtml(text)}</div>`);
  const think = addMsg("ai", `<div class="msg-bubble typing"><b></b><b></b><b></b></div>`);

  try{
    const r = await API.call("/api/ai/mood", {method:"POST", body: JSON.stringify({prompt: text})});
    const m = MOODS[r.mood] || MOODS.dreamy;

    setMoodVars(r.mood);
    $("#orbRead").textContent = `${r.emoji}  ${r.moodLabel.toLowerCase()} · ${m.desc}`;
    $$("#moodRing button").forEach(b=>b.classList.toggle("on", b.dataset.mood===r.mood));

    await sleep(500);
    think.querySelector(".msg-bubble").innerHTML = `Reading your mood… <b style="color:${m.m2}">${r.moodLabel.toLowerCase()}</b> detected. Tuning tempo, texture and energy.`;
    await sleep(900);

    // real worldwide tracks first, local catalog as fallback
    const worldPicks = (r.worldTracks||[]);
    worldPicks.forEach(t=>{ t.dur = t.duration; state.worldById.set(t.id, t); });
    const picks = worldPicks.length ? worldPicks : (r.tracks||[]).map(norm);
    const dur = picks.reduce((a,t)=>a+(t.dur||t.duration||0),0);
    const mins = Math.max(1, Math.round(dur/60));
    state.session = {prompt:text, mood:r.mood, label:r.moodLabel, emoji:r.emoji, tracks:picks, dur, colors:r.colors};

    const card = document.createElement("div");
    card.className = "msg ai";
    card.innerHTML = `
      <div class="msg-ava"><img src="assets/muzora-logo.png" alt=""></div>
      <div class="msg-bubble session-card" style="border-color:${m.m1}55">
        <div class="sc-head"><i style="background:${m.m1};box-shadow:0 0 10px ${m.m1}"></i><b>${r.emoji} ${r.moodLabel} Session</b></div>
        <div class="session-tracks">
          ${picks.slice(0,4).map(t=>`<div class="st" style="--c1:${t.c1};--c2:${t.c2};${t.cover?`background:center/cover no-repeat url('${t.cover}')`:''}"></div>`).join("")}
        </div>
        <div class="sc-tags">
          <span>${picks.length} tracks</span><span>${mins} min</span><span>${r.moodLabel.toLowerCase()} energy</span>${worldPicks.length?"<span>· worldwide</span>":""}${r.personalized&&!worldPicks.length?"<span>· for you</span>":""}
        </div>
        <div class="sc-actions">
          <button class="sc-play">▶ Play session</button>
          <button class="sc-ghost">View</button>
        </div>
      </div>`;
    think.querySelector(".msg-bubble").innerHTML = `Here's your <b style="color:${m.m2}">${r.moodLabel}</b> session — ${picks.length} tracks, ${mins} minutes.`;
    $("#chat").appendChild(card);
    card.scrollIntoView({behavior:"smooth", block:"end"});

    card.querySelector(".sc-play").addEventListener("click", ()=>{
      playQueue(state.session.tracks, 0);
      openMoodScreen();
    });
    card.querySelector(".sc-ghost").addEventListener("click", openMoodScreen);
  }catch(err){
    think.querySelector(".msg-bubble").innerHTML = `⚠️ ${escapeHtml(err.message)}`;
  }
  aiBusy = false;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function openMoodScreen(){
  if(!state.session) return;
  const s = state.session;
  const m = MOODS[s.mood];
  const app = $("#app");
  app.style.setProperty("--c1", m.m1);
  app.style.setProperty("--c2", m.m2);
  $("#moodTitle").textContent = `${s.label} Session`;
  $("#moodMeta").textContent = `${s.tracks.length} tracks · ${Math.round(s.dur/60)} min · generated by Muzora AI`;
  $("#moodTags").innerHTML = `<span>#${s.label.toLowerCase()}</span><span>#${m.desc.split("·")[0].trim()}</span><span>#muzora-ai</span>`;
  $("#moodList").innerHTML = s.tracks.map(t=>trackRow(t,"mood")).join("");
  show("mood");
}

$("#aiSend").addEventListener("click", sendAi);
$("#aiInput").addEventListener("keydown", e=>{ if(e.key==="Enter") sendAi(); });
function sendAi(){
  const v = $("#aiInput").value.trim();
  if(!v) return;
  $("#aiInput").value = "";
  handleAiPrompt(v);
}
$$("#quickChips button").forEach(b=>b.addEventListener("click", ()=>handleAiPrompt(b.dataset.ai)));

$("#btnPlaySession").addEventListener("click", ()=>{
  if(!state.session) return;
  playQueue(state.session.tracks, 0);
  show("player");
});

$("#btnSaveSession").addEventListener("click", async ()=>{
  const s = state.session;
  if(!s || !s.tracks.length) return;
  const localIds = s.tracks.filter(t=>!t.world).map(t=>t.id);
  if(!localIds.length){ toast("Worldwide previews can't be saved to Library"); return; }
  try{
    await API.call("/api/playlists", {method:"POST", body: JSON.stringify({
      name: `${s.label} Session`,
      description: `AI ${s.label.toLowerCase()} mix · "${s.prompt}"`,
      source: "ai",
      songIds: localIds,
    })});
    toast(localIds.length < s.tracks.length ? "Saved (local tracks only) ♥" : "Saved to your Library ♥");
    await refreshLibrary();
  }catch(err){ toast(err.message); }
});

$("#btnRegen").addEventListener("click", ()=>{
  if(!state.session || aiBusy) return;
  const prompt = state.session.prompt;
  handleAiPrompt(prompt, {silent:true}).then(()=>{
    if(state.session) openMoodScreen();
  });
});

/* mood ring buttons set orb state without chat */
$$("#moodRing button").forEach(b=>{
  b.addEventListener("click", ()=>{
    const mk = b.dataset.mood;
    setMoodVars(mk);
    const m = MOODS[mk];
    $("#orbRead").textContent = `${m.emoji}  ${m.label.toLowerCase()} · ${m.desc}`;
    $$("#moodRing button").forEach(x=>x.classList.toggle("on", x===b));
  });
});

/* ---------------- Boot ---------------- */
async function enterApp(user){
  state.user = user;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  $("#hdrHi").textContent = greet;
  $("#hdrName").textContent = user.name.split(" ")[0];
  $("#pfName").textContent = user.name;
  $("#pfEmail").textContent = user.email;
  $("#chatIntro").innerHTML = `Hey ${escapeHtml(user.name.split(" ")[0])} — tell me a feeling, an activity, or just a vibe. I'll shape the sound around it. <span class="wave-emoji">🎶</span>`;

  // load catalog
  const songsR = await API.call("/api/songs");
  state.songs = (songsR.songs||[]).map(norm);

  // load favorites
  try{
    const favR = await API.call("/api/favorites");
    state.favorites = new Set((favR.songs||[]).map(s=>s.id));
  }catch{ state.favorites = new Set(); }

  // idle queue = full catalog
  state.queue = state.songs;
  state.qi = 0;

  renderHome();
  renderArtists();
  renderPlaylistCards();
  renderFavorites();
  renderLibraryLists();
  renderTrackUI();
  show("home");
  loadHome();      // recommendations in background
  loadRecent();    // history + stats in background
  loadCharts("in"); // worldwide charts in background
}

async function boot(){
  renderWave($("#splashWave"), 16, true);
  setMoodVars("calm");

  if(API.token){
    try{
      const r = await API.call("/api/auth/me");
      setTimeout(async ()=>{
        try{ await enterApp(r.user); }catch{ show("auth"); }
      }, 1800);
      return;
    }catch{
      API.setToken(null);
    }
  }
  setTimeout(()=>show("auth"), 2600);
}

boot();
