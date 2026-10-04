/*
 * Aller Studio — proxy for the quote assistant (allerbruno.github.io/aller-widget).
 *
 * Why it exists: the Anthropic API key and the Make webhook must never be visible in the browser.
 * The widget only ever talks to this server, and this server decides exactly what is sent onwards.
 *
 * Protections:
 * - Only Aller Studio's own sites may call it (CORS + Origin check).
 * - /chat does NOT forward whatever the browser sends: it builds the AI request itself
 *   (fixed model, short answer, fixed instructions). The browser only sends the visitor's answer.
 * - Requests are small (8 KB max) and answers are capped.
 * - Each visitor (IP) has a usage limit, plus a global daily cap on AI calls.
 * - /lead forwards leads to Make. The webhook URL lives only in Render (MAKE_WEBHOOK_URL).
 *
 * Environment variables on Render:
 *   ANTHROPIC_API_KEY   (already set)
 *   MAKE_WEBHOOK_URL    the NEW Make webhook (after rotating the old one)
 *   MAKE_API_KEY        the API key set on that webhook in Make (sent as x-make-apikey)
 *   ALLOWED_ORIGINS     optional, comma-separated; defaults to the list below
 *   DAILY_AI_LIMIT      optional, max AI calls per day for everyone together (default 300)
 */
const express = require("express");
const cors = require("cors");

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy: use the visitor's real IP

const ALLOWED = (
  process.env.ALLOWED_ORIGINS ||
  "https://allerbruno.github.io,https://allerstudio.com,https://www.allerstudio.com,https://aller-studio-website.vercel.app"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const isAllowed = (origin) => !!origin && ALLOWED.includes(origin);

app.use(cors({ origin: (origin, cb) => cb(null, isAllowed(origin)), methods: ["POST"] }));
app.use(express.json({ limit: "8kb" }));

// Reject anything that doesn't come from our own pages (CORS alone only protects browsers)
app.use((req, res, next) => {
  if (req.method === "POST" && !isAllowed(req.get("origin"))) return res.status(403).json({ error: "forbidden" });
  next();
});

/* ── Simple in-memory rate limits ─────────────────────────── */
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return res.status(429).json({ error: "too_many_requests" });
    next();
  };
}
const chatLimit = limiter(20, 60 * 60 * 1000); // 20 AI calls per visitor per hour (a full chat uses 2)
const leadLimit = limiter(5, 60 * 60 * 1000); // 5 leads per visitor per hour

const DAILY_AI_LIMIT = Number(process.env.DAILY_AI_LIMIT || 300);
let aiToday = 0;
let day = new Date().toDateString();

/* ── /chat: one short acknowledgment sentence ─────────────── */
const PROMPT = {
  es: (a) =>
    `Eres el asistente de Aller Studio (estudio de diseño y desarrollo para startups tech). El usuario acaba de responder: "${a}". Escribe SOLO una oración corta (máx 15 palabras) reconociendo su respuesta de forma específica e inteligente. Tono directo, seguro, "Experto Visionario" — sin relleno, sin "¡Genial!", sin preguntas, sin saludos, sin emojis. Si no hay nada interesante que decir, responde con un string vacío. RESPONDE SOLO CON LA ORACIÓN, sin comillas ni texto extra.`,
  en: (a) =>
    `You are the Aller Studio assistant (design & dev studio for tech startups). The user just answered: "${a}". Write ONLY one short sentence (max 15 words) acknowledging their answer in a specific, sharp way. Direct, confident, "Experto Visionario" tone — no filler, no "Great!", no questions, no greetings, no emojis. If there's nothing interesting to say, reply with an empty string. RESPOND WITH ONLY THE SENTENCE, no quotes, no extra text.`,
};

app.post("/chat", chatLimit, async (req, res) => {
  const lang = req.body && req.body.lang === "es" ? "es" : "en";
  const answer = String((req.body && req.body.answer) || "")
    .slice(0, 500)
    .trim();
  if (!answer) return res.json({ text: "" });

  if (new Date().toDateString() !== day) {
    day = new Date().toDateString();
    aiToday = 0;
  }
  if (aiToday >= DAILY_AI_LIMIT) return res.json({ text: "" }); // the widget simply skips the acknowledgment
  aiToday++;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // A one-sentence acknowledgment: the small, inexpensive model is plenty
        model: "claude-haiku-4-5-20251001",
        max_tokens: 60,
        system: PROMPT[lang](answer),
        messages: [{ role: "user", content: answer }],
      }),
    });
    if (!response.ok) return res.json({ text: "" });
    const data = await response.json();
    const text = (data.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim()
      .slice(0, 200);
    res.json({ text });
  } catch {
    res.json({ text: "" });
  }
});

/* ── /lead: forwards the brief to Make ────────────────────── */
const LEAD_FIELDS = [
  "name", "location", "project", "services", "branding", "product", "competitors", "budgetText",
  "timeline", "email", "vertical", "match", "estimate", "lang", "source", "ts", "transcript",
];

app.post("/lead", leadLimit, async (req, res) => {
  const url = process.env.MAKE_WEBHOOK_URL;
  if (!url) return res.status(503).json({ error: "not_configured" });
  const body = req.body || {};
  const email = String(body.email || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "invalid_email" });

  // Only known fields, as plain text, each with a size cap
  const lead = {};
  for (const k of LEAD_FIELDS) {
    const v = body[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) lead[k] = v.map((x) => String(x).slice(0, 100)).slice(0, 10);
    else if (typeof v === "boolean") lead[k] = v;
    else lead[k] = String(v).slice(0, k === "transcript" ? 4000 : 500);
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.MAKE_API_KEY) headers["x-make-apikey"] = process.env.MAKE_API_KEY;
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(lead) });
    if (!r.ok) {
      // Visible in Render → Logs. Never logs the URL or the key, only Make's answer.
      console.error("Make rejected the lead:", r.status, (await r.text()).slice(0, 200));
      return res.status(502).json({ error: "forward_failed", status: r.status });
    }
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "forward_failed" });
  }
});

app.get("/", (_req, res) => res.send("ok"));

app.listen(process.env.PORT || 3000, () => console.log("Proxy running"));
