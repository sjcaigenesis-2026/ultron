// Vercel serverless function: POST /api/chat  { message } -> { answer }
// The Gemini key lives only in the GEMINI_API_KEY environment variable.

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const UPSTREAM_TIMEOUT_MS = 15000;
const MAX_MESSAGE_CHARS = 1000;

// Best-effort rate limit. Serverless instances do not share memory, so this
// slows down casual abuse but is NOT a hard guarantee.
const RATE_LIMIT = 10;          // requests
const RATE_WINDOW_MS = 60_000;  // per minute, per IP, per instance
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) {
    for (const [key, times] of hits) {
      if (!times.some(t => now - t < RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return recent.length > RATE_LIMIT;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false; // browsers always send Origin on same-origin POST
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (host === req.headers.host) return true;
  // Optional: ALLOWED_ORIGINS="https://my-domain.com,https://www.my-domain.com"
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

function readMessage(req) {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return null; }
  }
  const message = body?.message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > MAX_MESSAGE_CHARS) return null;
  return trimmed;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  if (!originAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed." });
  }

  if (!String(req.headers["content-type"] || "").includes("application/json")) {
    return res.status(415).json({ error: "Send JSON." });
  }

  const ip =
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (rateLimited(ip)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Too many requests. Wait a minute." });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "AI key is not configured." });
  }

  const message = readMessage(req);
  if (!message) {
    return res.status(400).json({
      error: `Enter a message of up to ${MAX_MESSAGE_CHARS} characters.`
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text:
                "You are Ultron Orb, a helpful, friendly voice assistant. " +
                "Reply in plain spoken sentences: no markdown, no lists, no emoji. " +
                "Keep answers under about 60 words unless asked for more. " +
                "Do not claim to perform actions you have not performed."
            }]
          },
          contents: [{ role: "user", parts: [{ text: message }] }],
          generationConfig: { maxOutputTokens: 250, temperature: 0.7 }
        })
      }
    );

    if (!response.ok) {
      // Status only. Never log the key or the user's message.
      console.error("Gemini request failed with status", response.status);
      const quota = response.status === 429;
      return res.status(quota ? 429 : 502).json({
        error: quota
          ? "The AI quota is used up for now. Try again later."
          : "The AI service is temporarily unavailable."
      });
    }

    const data = await response.json();
    const answer = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!answer) {
      return res.status(502).json({ error: "The AI returned an empty response." });
    }

    return res.status(200).json({ answer });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    console.error("AI request failed:", timedOut ? "timeout" : error?.message);
    return res.status(timedOut ? 504 : 500).json({
      error: timedOut
        ? "The AI took too long to answer."
        : "Could not connect to the AI service."
    });
  } finally {
    clearTimeout(timer);
  }
}
