// Muzora AI — SQLite database layer (better-sqlite3)
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { CATALOG } = require("./catalog");

const DATA_DIR = path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "muzora.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS artists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  genre TEXT NOT NULL,
  mood TEXT NOT NULL,
  c1 TEXT NOT NULL,
  c2 TEXT NOT NULL,
  audio_file TEXT NOT NULL,
  duration REAL NOT NULL,
  plays INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS playlist_songs (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  song_id INTEGER NOT NULL REFERENCES songs(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, song_id)
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  song_id INTEGER NOT NULL REFERENCES songs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, song_id)
);
CREATE TABLE IF NOT EXISTS listening_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  song_id INTEGER NOT NULL REFERENCES songs(id),
  played_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  moods TEXT NOT NULL DEFAULT '[]',
  genres TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_history_user ON listening_history(user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_songs_mood ON songs(mood);
`);

// ---- seed catalog ----
const seed = db.transaction(() => {
  const artistCount = db.prepare("SELECT COUNT(*) AS n FROM artists").get().n;
  if (artistCount === 0) {
    const insArtist = db.prepare("INSERT OR IGNORE INTO artists (name) VALUES (?)");
    const names = [...new Set(CATALOG.map((t) => t.artist))].sort();
    names.forEach((n) => insArtist.run(n));
    const artistId = {};
    db.prepare("SELECT id, name FROM artists").all().forEach((r) => (artistId[r.name] = r.id));

    const insSong = db.prepare(`INSERT INTO songs
      (id, title, artist_id, genre, mood, c1, c2, audio_file, duration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of CATALOG) {
      const dur = DURATIONS[t.id] ?? t.dur ?? 180;
      insSong.run(t.id, t.title, artistId[t.artist], t.genre, t.mood, t.c1, t.c2, t.file, dur);
    }
  }
});

// real durations come from audio/manifest.json (written by the generator)
let DURATIONS = {};
try {
  const mf = path.join(__dirname, "..", "audio", "manifest.json");
  if (fs.existsSync(mf)) {
    DURATIONS = Object.fromEntries(
      JSON.parse(fs.readFileSync(mf, "utf8")).map((m) => [m.id, m.duration])
    );
  }
} catch {
  // durations fall back to placeholder until audio is generated
}

seed();

const SONG_BASE = `
    SELECT s.id, s.title, a.name AS artist, s.genre, s.mood, s.c1, s.c2,
           s.audio_file, s.duration, s.plays
    FROM songs s JOIN artists a ON a.id = s.artist_id`;

function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    genre: row.genre,
    mood: row.mood,
    colors: [row.c1, row.c2],
    cover: `/api/cover/${row.id}.svg`,
    audio: `/audio/${row.audio_file}`,
    duration: Math.round(row.duration),
    plays: row.plays,
  };
}

function getSong(id) {
  const row = db.prepare(`${SONG_BASE} WHERE s.id = ?`).get(id);
  return row ? toApi(row) : null;
}

function getAllSongs() {
  return db.prepare(`${SONG_BASE} ORDER BY s.id`).all().map(toApi);
}

module.exports = { db, getSong, getAllSongs, toApi, SONG_BASE };
