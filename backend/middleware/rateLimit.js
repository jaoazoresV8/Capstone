// Very simple in-memory rate limiter for development/LAN use.
// Limits requests per IP + path within a window.

const buckets = new Map();

export function createRateLimit({ windowMs = 60000, max = 10 } = {}) {
  return function rateLimit(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }

    // Remove old entries
    while (bucket.length && bucket[0] <= windowStart) {
      bucket.shift();
    }

    if (bucket.length >= max) {
      return res
        .status(429)
        .json({ message: "Too many requests. Please wait a moment and try again." });
    }

    bucket.push(now);
    next();
  };
}

