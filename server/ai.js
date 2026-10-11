// Muzora AI — mood parsing + recommendation engine
// Stage 1: rule-based filtering (mood/genre/artist/keyword)
// Stage 2: personalization via listening history and favorites

const MOODS = {
  calm:      { label: "Calm",      emoji: "🌊", desc: "peaceful · soft · unwind",       m1: "#22d3ee", m2: "#10b981" },
  focus:     { label: "Focus",     emoji: "🎯", desc: "deep work · study · flow",       m1: "#818cf8", m2: "#22d3ee" },
  happy:     { label: "Happy",     emoji: "☀️", desc: "bright · joyful · uplift",       m1: "#f59e0b", m2: "#ec4899" },
  energetic: { label: "Energetic", emoji: "⚡", desc: "high BPM · momentum · power",    m1: "#ec4899", m2: "#f43f5e" },
  dreamy:    { label: "Dreamy",    emoji: "🌙", desc: "floaty · nostalgic · hazy",      m1: "#a78bfa", m2: "#22d3ee" },
  sleep:     { label: "Sleep",     emoji: "🛌", desc: "drift · slow · deep rest",       m1: "#4f46e5", m2: "#312e81" },
};

// order matters: specific/energetic intents first so "workout" beats "work"
const MOOD_WORDS = [
  ["energetic", ["energetic", "energy", "workout", "gym", "run", "pump", "hype", "dance", "cardio", "high bpm", "party"]],
  ["calm",      ["calm", "peaceful", "relax", "chill", "unwind", "late-night", "quiet", "soft", "rain"]],
  ["focus",     ["focus", "study", "work", "concentration", "deep", "exam", "coding", "productive"]],
  ["happy",     ["happy", "joy", "good mood", "sunshine", "celebrate", "feel-good", "cheerful"]],
  ["dreamy",    ["dream", "dreamy", "float", "nostalgia", "wander", "wonder", "hazy"]],
  ["sleep",     ["sleep", "sleepy", "bed", "night", "drift", "insomnia", "wind down"]],
];

function detectMood(text) {
  const t = String(text || "").toLowerCase();
  for (const [mood, words] of MOOD_WORDS) {
    if (words.some((w) => t.includes(w))) return mood;
  }
  return null;
}

// extract duration hints like "2 hours", "90 minutes", "30 min"
function detectDuration(text) {
  const t = String(text || "").toLowerCase();
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
  if (m) return Math.round(parseFloat(m[1]) * 60);
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/);
  if (m) return Math.round(parseFloat(m[1]));
  return null;
}

function parsePrompt(text) {
  const mood = detectMood(text);
  const minutes = detectDuration(text);
  const t = String(text || "").toLowerCase();

  // genre / artist keyword extraction against catalog
  let genre = null;
  for (const g of ["dream pop", "synthwave", "lo-fi", "lofi", "ambient", "indie", "edm", "acoustic", "chilltrap", "city pop", "techno", "folktronica", "fusion"]) {
    if (t.includes(g)) { genre = g === "lofi" ? "lo-fi" : g; break; }
  }
  return { mood, minutes, genre };
}

/**
 * Build a ranked session.
 * rows: catalog rows (from db), historyCounts: {songId: plays}, favSet: Set(songId)
 */
function buildSession({ rows, mood, genre, minutes, historyCounts, favSet }) {
  let pool = rows;
  if (genre) pool = pool.filter((r) => r.genre.toLowerCase() === genre);
  if (mood) {
    const scored = pool.map((r) => {
      let s = 0;
      if (r.mood === mood) s += 10;
      // neighboring moods get partial credit
      const NEAR = {
        energetic: { happy: 3, focus: 1 },
        happy:     { energetic: 3, dreamy: 1 },
        focus:     { calm: 3, dreamy: 1 },
        calm:      { focus: 2, dreamy: 2, sleep: 2 },
        dreamy:    { calm: 2, sleep: 2, focus: 1 },
        sleep:     { calm: 3, dreamy: 2 },
      };
      s += (NEAR[mood] && NEAR[mood][r.mood]) || 0;
      // Stage 2 personalization
      const plays = (historyCounts && historyCounts[r.id]) || 0;
      s += Math.min(plays, 5) * 1.5;
      if (favSet && favSet.has(r.id)) s += 2;
      return { r, s };
    });
    scored.sort((a, b) => b.s - a.s || a.r.id - b.r.id);
    pool = scored.map((x) => x.r);
  } else {
    pool = [...pool].sort((a, b) => a.id - b.id);
  }

  // duration target: default 30 min
  const target = (minutes || 30) * 60;
  const out = [];
  let total = 0;
  const seen = new Set();
  let i = 0;
  while (total < target && out.length < pool.length) {
    const r = pool[i % pool.length];
    i += 1;
    if (seen.has(r.id)) break;
    seen.add(r.id);
    out.push(r);
    total += r.duration;
    if (i > 60) break;
  }
  return { tracks: out, totalMinutes: Math.round(total / 60) };
}

module.exports = { MOODS, detectMood, parsePrompt, buildSession };
