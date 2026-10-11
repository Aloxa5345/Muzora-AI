// Muzora AI — world catalog via the public iTunes Search API + top-songs RSS.
// Real songs worldwide (Bollywood + international), official 30s previews.
const { MOODS } = require("./ai");

const UA = "MuzoraAI/1.0 (music app prototype)";
const FETCH_TIMEOUT = 9000;

const MOOD_BY_GENRE = [
  [/bollywood|bhangra|punjabi|indian pop|dance|edm|house|techno|hip.?hop|rap|drill|metal|punk|electronic|k-pop/i, "energetic"],
  [/bhajan|classical|ghazal|qawwali|ambient|instrumental|jazz|lounge|new age|devotional|sleep|meditation/i, "calm"],
  [/soundtrack|score|film|dream|chillout|downtempo/i, "dreamy"],
  [/lo-?fi|study|focus/i, "focus"],
  [/pop|indie|folk|singer-?songwriter|latin|country|r&b|soul|romantic|love/i, "happy"],
];

function moodForGenre(genre) {
  const g = genre || "";
  for (const [re, mood] of MOOD_BY_GENRE) if (re.test(g)) return mood;
  return "happy";
}

function toWorldSong(r) {
  const mood = moodForGenre(r.primaryGenreName);
  const m = MOODS[mood];
  return {
    id: "w" + r.trackId,
    world: true,
    title: r.trackName,
    artist: r.artistName,
    album: r.collectionName || "",
    genre: r.primaryGenreName || "Music",
    mood,
    c1: m.m1,
    c2: m.m2,
    cover: (r.artworkUrl100 || "").replace("100x100bb", "300x300bb").replace("100x100", "300x300"),
    audio: r.previewUrl,
    duration: Math.round((r.trackTimeMillis || 30000) / 1000),
    plays: 0,
  };
}

async function itunesFetch(url) {
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ac.signal });
    if (!res.ok) throw new Error("upstream " + res.status);
    return await res.json();
  } finally {
    clearTimeout(kill);
  }
}

async function worldSearch(term, limit = 24) {
  const url =
    "https://itunes.apple.com/search?term=" + encodeURIComponent(term) +
    "&entity=song&limit=" + Math.min(50, Math.max(1, limit));
  const data = await itunesFetch(url);
  return (data.results || [])
    .filter((r) => r.previewUrl && r.trackName)
    .map(toWorldSong);
}

// ---------------- charts (top songs per storefront, cached 10 min) ----------------
const chartsCache = new Map(); // store -> { at, songs }

function chartEntry(e) {
  const images = (e["im:image"] || []).map((i) => i.label);
  const cover = (images[images.length - 1] || "").replace(/\/\d+x\d+bb/, "/340x340bb");
  return {
    id: "c" + (e.id?.attributes?.["im:id"] || (e["im:name"]?.label || "") + (e["im:artist"]?.label || "")),
    chart: true,
    title: e["im:name"]?.label || "",
    artist: e["im:artist"]?.label || "",
    genre: e.category?.attributes?.label || "Music",
    cover,
  };
}

async function worldCharts(store, limit = 12) {
  const s = store === "us" ? "us" : "in";
  const cached = chartsCache.get(s);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.songs;
  const url = `https://itunes.apple.com/${s}/rss/topsongs/limit=${Math.min(25, Math.max(5, limit))}/json`;
  const data = await itunesFetch(url);
  const songs = (data?.feed?.entry || []).map(chartEntry).filter((x) => x.title && x.artist);
  chartsCache.set(s, { at: Date.now(), songs });
  return songs;
}

// ---------------- lazy preview resolution for chart rows ----------------
const resolveCache = new Map(); // "title|artist" -> song | null

async function resolveChartTrack(title, artist) {
  const key = title + "|" + artist;
  if (resolveCache.has(key)) return resolveCache.get(key);
  const url =
    "https://itunes.apple.com/search?term=" + encodeURIComponent(title + " " + artist) +
    "&entity=song&limit=5";
  let song = null;
  try {
    const data = await itunesFetch(url);
    const hit = (data.results || []).find((r) => r.previewUrl && r.trackName);
    if (hit) song = toWorldSong(hit);
  } catch {
    song = null;
  }
  if (resolveCache.size > 500) resolveCache.clear();
  resolveCache.set(key, song);
  return song;
}

// ---------------- real mood mixes (AI sessions) ----------------
const MOOD_TERMS = {
  calm:      ["peaceful acoustic", "chill relaxation", "soft instrumental"],
  focus:     ["lofi study beats", "focus instrumental", "deep work music"],
  happy:     ["feel good hits", "happy songs", "uplifting pop"],
  energetic: ["party dance hits", "bollywood dance hits", "edm energy"],
  dreamy:    ["dreamy ambient", "aesthetic chill", "ethereal pop"],
  sleep:     ["sleep music", "ambient relaxation", "deep sleep sounds"],
};
const WORLD_GENRES = [
  "bollywood", "punjabi", "hindi", "indian", "k-?pop", "j-?pop", "latin", "reggaeton",
  "classical", "ghazal", "sufi", "qawwali", "bhajan", "devotional",
  "jazz", "rock", "metal", "punk", "blues", "country", "folk", "reggae",
  "hip.?hop", "rap", "edm", "techno", "house", "trance", "dubstep",
  "lo-?fi", "ambient", "acoustic", "arabic", "turkish", "afrobeats", "african",
];
const moodCache = new Map(); // "mood[:genre]" -> { at, songs }

function shufflePick(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function worldGenreFromText(text) {
  const t = String(text || "").toLowerCase();
  for (const g of WORLD_GENRES) {
    if (new RegExp("\\b" + g + "\\b", "i").test(t)) return g.replace("?-", "-");
  }
  return null;
}

async function worldMoodMix(mood, rawText, limit = 12) {
  const key = MOOD_TERMS[mood] ? mood : "happy";
  const genre = worldGenreFromText(rawText);
  const cacheKey = genre ? key + ":" + genre : key;
  const cached = moodCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000 && cached.songs.length >= limit) {
    return shufflePick(cached.songs, limit);
  }
  const genreTerms = genre ? [`${genre} music`, genre] : [];
  const terms = [...new Set([...genreTerms, ...MOOD_TERMS[key]])].slice(0, 4);
  const results = await Promise.allSettled(terms.map((t) => worldSearch(t, 25)));
  const seen = new Set();
  const songs = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const fromGenre = i < genreTerms.length;
    for (const s of r.value) {
      if (!s.audio || seen.has(s.id)) continue;
      seen.add(s.id);
      songs.push({ s, fromGenre });
    }
  });
  // genre matches first, then tracks whose genre fits the mood, then the rest
  const groups = [
    songs.filter((x) => x.fromGenre),
    songs.filter((x) => !x.fromGenre && x.s.mood === key),
    songs.filter((x) => !x.fromGenre && x.s.mood !== key),
  ];
  const merged = groups.flatMap((g) => shufflePick(g, g.length)).map((x) => x.s);
  if (merged.length) moodCache.set(cacheKey, { at: Date.now(), songs: merged });
  if (moodCache.size > 12) moodCache.clear();
  return merged.slice(0, limit);
}

module.exports = { worldSearch, worldCharts, resolveChartTrack, worldMoodMix };
