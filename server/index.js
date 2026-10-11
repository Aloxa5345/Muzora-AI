// Muzora AI — Your Mood. Your Music.  Full-stack app server.
const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");
const { db, getSong, getAllSongs } = require("./db");
const { signToken, auth, optionalAuth, rateLimit, validEmail, clean } = require("./middleware");
const { MOODS, parsePrompt, buildSession } = require("./ai");
const { worldSearch, worldCharts, resolveChartTrack, worldMoodMix } = require("./world");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

// ---------------- static ----------------
const PUB = path.join(__dirname, "..", "public");
app.use(express.static(PUB, { index: "index.html", extensions: ["html"] }));
app.use("/audio", express.static(path.join(__dirname, "..", "audio"), { maxAge: "1d" }));

// generated SVG covers (gradient + wave motif, per-track colors)
app.get("/api/cover/:id.svg", (req, res) => {
  const s = getSong(Number(req.params.id));
  if (!s) return res.status(404).type("image/svg+xml").send("<svg xmlns='http://www.w3.org/2000/svg'/>");
  const [c1, c2] = s.colors;
  const bars = Array.from({ length: 7 }, (_, i) => {
    const h = 12 + ((i * 37) % 30);
    return `<rect x='${22 + i * 8}' y='${64 - h}' width='5' height='${h}' rx='2.5' fill='rgba(255,255,255,.85)'/>`;
  }).join("");
  res.type("image/svg+xml").send(
    `<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs>` +
    `<rect width='96' height='96' rx='18' fill='url(#g)'/>` +
    `<circle cx='48' cy='44' r='17' fill='none' stroke='rgba(255,255,255,.55)' stroke-width='2'/>` +
    `<circle cx='48' cy='44' r='4' fill='#fff'/>${bars}</svg>`
  );
});

// ---------------- helpers ----------------
const SONG_BASE = `SELECT s.id, s.title, a.name AS artist, s.genre, s.mood, s.c1, s.c2, s.audio_file, s.duration, s.plays
  FROM songs s JOIN artists a ON a.id = s.artist_id`;
const mapRow = (r) => ({
  id: r.id, title: r.title, artist: r.artist, genre: r.genre, mood: r.mood,
  colors: [r.c1, r.c2], cover: `/api/cover/${r.id}.svg`, audio: `/audio/${r.audio_file}`,
  duration: Math.round(r.duration), plays: r.plays,
});
const query = (sql, ...args) => db.prepare(sql).all(...args).map(mapRow);

const historyCounts = (userId) => {
  const rows = db.prepare(
    `SELECT song_id, COUNT(*) AS n FROM listening_history WHERE user_id = ? GROUP BY song_id`
  ).all(userId);
  return Object.fromEntries(rows.map((r) => [r.song_id, r.n]));
};
const favSet = (userId) =>
  new Set(db.prepare(`SELECT song_id FROM favorites WHERE user_id = ?`).all(userId).map((r) => r.song_id));

// ---------------- auth ----------------
app.post("/api/auth/register", rateLimit({ windowMs: 60_000, max: 10 }), (req, res) => {
  const name = clean(req.body.name, 40);
  const email = clean(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (name.length < 2) return res.status(400).json({ error: "Name must be at least 2 characters." });
  if (!validEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

  const exists = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (exists) return res.status(409).json({ error: "An account with this email already exists." });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)`).run(name, email, hash);
  db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id) VALUES (?)`).run(info.lastInsertRowid);
  const user = db.prepare(`SELECT id, name, email FROM users WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ token: signToken(user), user });
});

app.post("/api/auth/login", rateLimit({ windowMs: 60_000, max: 10 }), (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const user = db.prepare(`SELECT id, name, email, password_hash FROM users WHERE email = ?`).get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  res.json({ token: signToken(user), user: { id: user.id, name: user.name, email: user.email } });
});

app.get("/api/auth/me", auth, (req, res) => {
  const user = db.prepare(`SELECT id, name, email, created_at FROM users WHERE id = ?`).get(req.user.sub);
  if (!user) return res.status(401).json({ error: "Account not found." });
  res.json({ user });
});

// ---------------- songs / search ----------------
app.get("/api/songs", (req, res) => {
  let sql = SONG_BASE;
  const where = [];
  const args = [];
  if (req.query.mood && MOODS[req.query.mood]) { where.push("s.mood = ?"); args.push(req.query.mood); }
  if (req.query.genre) { where.push("s.genre = ? COLLATE NOCASE"); args.push(String(req.query.genre).slice(0, 30)); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY s.id";
  res.json({ songs: query(sql, ...args) });
});

app.get("/api/songs/:id", (req, res) => {
  const s = getSong(Number(req.params.id));
  if (!s) return res.status(404).json({ error: "Song not found." });
  res.json({ song: s });
});

app.get("/api/search", (req, res) => {
  const q = clean(req.query.q, 60);
  if (!q) return res.json({ songs: [], artists: [], genres: [] });
  const like = `%${q}%`;
  const songs = query(`${SONG_BASE} WHERE s.title LIKE ? OR a.name LIKE ? OR s.genre LIKE ? OR s.mood LIKE ? ORDER BY s.id`, like, like, like, like);
  const artists = db.prepare(`SELECT id, name FROM artists WHERE name LIKE ? ORDER BY name`).all(like)
    .map((a) => ({ ...a, photo: `/api/cover/${(db.prepare(`SELECT MIN(id) AS m FROM songs WHERE artist_id = ?`).get(a.id).m) || 1}.svg` }));
  const genres = [...new Set(query(`${SONG_BASE} WHERE s.genre LIKE ?`, like).map((s) => s.genre))];
  res.json({ songs, artists, genres });
});

// ---------------- world catalog (iTunes proxy) ----------------
app.get("/api/world/search", rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
  const q = clean(req.query.q, 80);
  if (!q) return res.json({ songs: [] });
  try {
    res.json({ songs: await worldSearch(q) });
  } catch {
    res.status(502).json({ error: "World catalog unavailable right now." });
  }
});

app.get("/api/world/charts", async (req, res) => {
  const store = req.query.store === "us" ? "us" : "in";
  const limit = Math.min(15, Math.max(5, Number(req.query.limit) || 12));
  try {
    res.json({ store, songs: await worldCharts(store, limit) });
  } catch {
    res.json({ store, songs: [] });
  }
});

app.get("/api/world/resolve", rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
  const title = clean(req.query.title, 120);
  const artist = clean(req.query.artist, 120);
  if (!title || !artist) return res.status(400).json({ error: "title and artist are required." });
  const song = await resolveChartTrack(title, artist);
  if (!song) return res.status(404).json({ error: "No preview for this track — try another." });
  res.json({ song });
});

// ---------------- favorites ----------------
app.get("/api/favorites", auth, (req, res) => {
  res.json({
    songs: query(`${SONG_BASE} JOIN favorites f ON f.song_id = s.id AND f.user_id = ? ORDER BY f.created_at DESC`, req.user.sub),
  });
});

app.post("/api/favorites/:songId", auth, (req, res) => {
  const songId = Number(req.params.songId);
  if (!getSong(songId)) return res.status(404).json({ error: "Song not found." });
  const exists = db.prepare(`SELECT 1 FROM favorites WHERE user_id = ? AND song_id = ?`).get(req.user.sub, songId);
  if (exists) {
    db.prepare(`DELETE FROM favorites WHERE user_id = ? AND song_id = ?`).run(req.user.sub, songId);
    return res.json({ favorited: false });
  }
  db.prepare(`INSERT INTO favorites (user_id, song_id) VALUES (?, ?)`).run(req.user.sub, songId);
  res.status(201).json({ favorited: true });
});

// ---------------- history ----------------
app.post("/api/history", auth, rateLimit({ windowMs: 60_000, max: 120 }), (req, res) => {
  const songId = Number(req.body.songId);
  if (!getSong(songId)) return res.status(404).json({ error: "Song not found." });
  db.prepare(`INSERT INTO listening_history (user_id, song_id) VALUES (?, ?)`).run(req.user.sub, songId);
  db.prepare(`UPDATE songs SET plays = plays + 1 WHERE id = ?`).run(songId);
  res.status(201).json({ ok: true });
});

app.get("/api/history", auth, (req, res) => {
  const rows = query(
    `${SONG_BASE} JOIN (SELECT song_id, MAX(id) AS hid, COUNT(*) AS n FROM listening_history WHERE user_id = ? GROUP BY song_id ORDER BY hid DESC LIMIT 50) h ON h.song_id = s.id ORDER BY h.hid DESC`,
    req.user.sub
  );
  const plays = db.prepare(`SELECT COUNT(*) AS n FROM listening_history WHERE user_id = ?`).get(req.user.sub).n;
  const minutes = Math.round(
    (db.prepare(`SELECT COALESCE(SUM(s.duration),0) AS m FROM listening_history h JOIN songs s ON s.id = h.song_id WHERE h.user_id = ?`).get(req.user.sub).m) / 60
  );
  const mixes = db.prepare(`SELECT COUNT(*) AS n FROM playlists WHERE user_id = ? AND source = 'ai'`).get(req.user.sub).n;
  res.json({ songs: rows, stats: { plays, minutes, mixes } });
});

// ---------------- playlists ----------------
app.get("/api/playlists", auth, (req, res) => {
  const pls = db.prepare(`SELECT p.id, p.name, p.description, p.source, p.created_at FROM playlists p WHERE p.user_id = ? ORDER BY p.created_at DESC`).all(req.user.sub);
  const out = pls.map((p) => {
    const songs = query(`${SONG_BASE} JOIN playlist_songs ps ON ps.song_id = s.id AND ps.playlist_id = ? ORDER BY ps.position`, p.id);
    return { ...p, songCount: songs.length, songs };
  });
  res.json({ playlists: out });
});

app.post("/api/playlists", auth, (req, res) => {
  const name = clean(req.body.name, 60);
  const description = clean(req.body.description, 200);
  const source = req.body.source === "ai" ? "ai" : "manual";
  const songIds = Array.isArray(req.body.songIds) ? req.body.songIds.slice(0, 100).map(Number).filter((n) => getSong(n)) : [];
  if (name.length < 1) return res.status(400).json({ error: "Playlist name is required." });
  const info = db.prepare(`INSERT INTO playlists (user_id, name, description, source) VALUES (?, ?, ?, ?)`).run(req.user.sub, name, description, source);
  const pid = info.lastInsertRowid;
  const ins = db.prepare(`INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)`);
  songIds.forEach((sid, i) => ins.run(pid, sid, i + 1));
  res.status(201).json({ playlist: { id: pid, name, description, source, songCount: songIds.length, songs: songIds.map(getSong) } });
});

app.delete("/api/playlists/:id", auth, (req, res) => {
  const pid = Number(req.params.id);
  const pl = db.prepare(`SELECT id FROM playlists WHERE id = ? AND user_id = ?`).get(pid, req.user.sub);
  if (!pl) return res.status(404).json({ error: "Playlist not found." });
  db.prepare(`DELETE FROM playlists WHERE id = ?`).run(pid);
  res.json({ ok: true });
});

// ---------------- AI mood + recommendations ----------------
app.post("/api/ai/mood", optionalAuth, rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
  const text = clean(req.body.prompt, 300);
  if (text.length < 2) return res.status(400).json({ error: "Tell me a mood, activity or vibe." });

  const { mood, minutes, genre } = parsePrompt(text);
  const rows = db.prepare(SONG_BASE).all();
  const isAuthed = Boolean(req.user);
  const session = buildSession({
    rows,
    mood: mood || "dreamy",
    genre,
    minutes,
    historyCounts: isAuthed ? historyCounts(req.user.sub) : {},
    favSet: isAuthed ? favSet(req.user.sub) : new Set(),
  });

  // real worldwide tracks for the same mood (upstream failure never breaks the session)
  let worldTracks = [];
  try { worldTracks = await worldMoodMix(mood || "dreamy", text, 12); } catch {}

  const moodInfo = MOODS[mood || "dreamy"];
  const worldMinutes = Math.max(1, Math.round(worldTracks.reduce((a, t) => a + (t.duration || 30), 0) / 60));
  res.json({
    mood: mood || "dreamy",
    moodLabel: moodInfo.label,
    emoji: moodInfo.emoji,
    desc: moodInfo.desc,
    colors: [moodInfo.m1, moodInfo.m2],
    totalMinutes: worldTracks.length ? worldMinutes : session.totalMinutes,
    tracks: session.tracks.map(mapRow),
    worldTracks,
    personalized: isAuthed,
  });
});

app.get("/api/recommendations", optionalAuth, (req, res) => {
  const rows = db.prepare(SONG_BASE).all();
  if (!req.user) {
    // anonymous: surface a balanced mood mix
    const pick = (m) => rows.filter((r) => r.mood === m).slice(0, 2);
    const base = [...pick("energetic"), ...pick("happy"), ...pick("calm"), ...pick("focus"), ...pick("dreamy"), ...pick("sleep")]
      .filter(Boolean).slice(0, 8);
    return res.json({ recommendations: base.map(mapRow), personalized: false });
  }
  const hc = historyCounts(req.user.sub);
  const favs = favSet(req.user.sub);
  const recent = db.prepare(`SELECT DISTINCT song_id FROM listening_history WHERE user_id = ? ORDER BY id DESC LIMIT 20`).all(req.user.sub).map((r) => r.song_id);
  const recentMoods = new Set(rows.filter((r) => recent.includes(r.id)).map((r) => r.mood));

  const scored = rows.map((r) => {
    let s = 0;
    if (recentMoods.has(r.mood)) s += 4;
    s += Math.min(hc[r.id] || 0, 6) * 2;
    if (favs.has(r.id)) s += 3;
    if (recent.slice(0, 3).includes(r.id)) s -= 8; // don't just replay last 3
    return { r, s };
  });
  scored.sort((a, b) => b.s - a.s || a.r.id - b.r.id);
  res.json({ recommendations: scored.slice(0, 8).map((x) => mapRow(x.r)), personalized: true });
});

// SPA fallback (but not for /api)
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(PUB, "index.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on our side." });
});

app.listen(PORT, () => {
  console.log(`Muzora AI listening on http://localhost:${PORT}`);
});
