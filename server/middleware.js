// Muzora AI — auth middleware, input validation, rate limiting
const jwt = require("jsonwebtoken");

function loadSecret() {
  const path = require("path");
  const fs = require("fs");
  const envPath = path.join(__dirname, "..", ".env-secret");
  if (fs.existsSync(envPath)) return fs.readFileSync(envPath, "utf8").trim();
  const secret = require("crypto").randomBytes(48).toString("hex");
  fs.writeFileSync(envPath, secret, { flag: "wx" });
  fs.writeFileSync(
    path.join(__dirname, "..", ".gitignore"),
    "node_modules/\ndata/\n.env-secret\n"
  );
  return secret;
}
const JWT_SECRET = loadSecret();

function signToken(user) {
  return jwt.sign({ sub: user.id, name: user.name }, JWT_SECRET, {
    expiresIn: "7d",
  });
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

function optionalAuth(req, _res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch {
      /* anonymous */
    }
  }
  next();
}

// simple in-memory limiter (per process) — enough for a self-hosted MVP
const buckets = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of buckets) if (v.last < cutoff) buckets.delete(k);
}, 60 * 1000).unref();

function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = req.ip + ":" + (req.path || "");
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.last > windowMs) {
      b = { count: 0, last: now };
      buckets.set(key, b);
    }
    b.count += 1;
    b.last = now;
    if (b.count > max) {
      return res.status(429).json({ error: "Too many requests — slow down." });
    }
    next();
  };
}

function validEmail(e) {
  return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;
}
function clean(s, max) {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

module.exports = { signToken, auth, optionalAuth, rateLimit, validEmail, clean };
