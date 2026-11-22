// time-models.js — how long does each Gemini model really take to read a receipt?
//
// Run it on YOUR computer (not on Vercel), so we can tell "the model is slow" apart from
// "something about Vercel's connection is the problem":
//
//   node time-models.js path/to/receipt.jpg                      models from your .env
//   node time-models.js receipt.jpg gemini-4-hydrogen gemini-3.8-flash
//   node time-models.js receipt.jpg --runs=3                      repeat each model 3 times
//
// Every run is one real request, and free-tier quota is counted per model per day (your log said
// 20/day), so the default is 2 runs per model. It never calls a model twice at the same time.

try { require("dotenv").config(); } catch (e) { /* dotenv is optional */ }
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const args = process.argv.slice(2);
const runsArg = args.find(a => a.startsWith("--runs="));
const RUNS = runsArg ? Math.max(1, Number(runsArg.split("=")[1]) || 2) : 2;
const positional = args.filter(a => !a.startsWith("--"));
const imagePath = positional[0];

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not set (put it in your .env file or the environment).");
  process.exit(1);
}
if (!imagePath || !fs.existsSync(imagePath)) {
  console.error("Usage: node time-models.js path/to/receipt.jpg [model ...] [--runs=2]");
  process.exit(1);
}

// Models: from the command line, else GEMINI_MODEL + GEMINI_FALLBACK_MODELS (same rule as the bot).
const fromEnv = [
  (process.env.GEMINI_MODEL || "gemini-3.6-flash").trim(),
  ...(process.env.GEMINI_FALLBACK_MODELS || "gemini-3.6-flash").split(",").map(s => s.trim()).filter(Boolean)
];
const models = [...new Set(positional.length > 1 ? positional.slice(1) : fromEnv)];

const mimeType = /\.png$/i.test(imagePath) ? "image/png" : "image/jpeg";
const data = fs.readFileSync(imagePath).toString("base64");
const prompt = 'Read this receipt. Reply with ONLY JSON like {"amount": 12345, "description": "what it was for"}.';
const LIMIT_MS = 120000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer after ${ms / 1000}s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

(async () => {
  const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  console.log(`Image: ${path.basename(imagePath)} (${Math.round(fs.statSync(imagePath).size / 1024)} KB)`);
  console.log(`Models: ${models.join(", ")}   |   ${RUNS} run(s) each, up to ${LIMIT_MS / 1000}s per run\n`);

  const summary = {};
  for (const model of models) {
    summary[model] = [];
    for (let run = 1; run <= RUNS; run++) {
      const t0 = Date.now();
      let outcome;
      try {
        const res = await withTimeout(
          ai.getGenerativeModel({ model }).generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data } }] }]
          }),
          LIMIT_MS
        );
        outcome = `OK    ${res.response.text().trim().replace(/\s+/g, " ").slice(0, 70)}`;
      } catch (err) {
        const msg = String(err.message || err);
        const code = (msg.match(/\b(4\d\d|5\d\d)\b/) || [])[1];
        outcome = `ERROR ${code ? `[${code}] ` : ""}${msg.replace(/\s+/g, " ").slice(0, 70)}`;
      }
      const secs = (Date.now() - t0) / 1000;
      summary[model].push({ secs, ok: outcome.startsWith("OK") });
      console.log(`${model.padEnd(24)} run ${run}: ${secs.toFixed(1).padStart(6)}s  ${outcome}`);
    }
  }

  console.log("\nSummary (successful answers only):");
  for (const model of models) {
    const ok = summary[model].filter(r => r.ok).map(r => r.secs);
    console.log(
      ok.length
        ? `  ${model.padEnd(24)} ${ok.length}/${RUNS} answered, fastest ${Math.min(...ok).toFixed(1)}s, slowest ${Math.max(...ok).toFixed(1)}s`
        : `  ${model.padEnd(24)} 0/${RUNS} answered`
    );
  }
})();
