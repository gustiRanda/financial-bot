const logger = require("./logger");

// ---------------------------------------------------------------------------
// What kind of failure was it?
//   quota      429 — daily/minute limit used up. NOT temporary: retrying the same model is pointless.
//   overloaded 503 "high demand" — usually passes quickly, worth a retry.
//   timeout    our own cut-off when Gemini doesn't answer in time.
//   notfound   the model name doesn't exist / isn't supported.
//   other      bad request, bad key, ... — another model won't help.
// ---------------------------------------------------------------------------
function errText(err) {
  return String(err?.message || err);
}

function classifyError(err) {
  const msg = errText(err).toLowerCase();
  if (/timed out after/.test(msg)) return "timeout";
  if (/\b429\b/.test(msg) || msg.includes("exceeded your current quota") || msg.includes("resource_exhausted")) return "quota";
  if (/\b503\b/.test(msg) || msg.includes("high demand") || msg.includes("overloaded") || msg.includes("unavailable")) return "overloaded";
  if (/\b404\b/.test(msg) && (msg.includes("not found") || msg.includes("not supported"))) return "notfound";
  return "other";
}

// Google says how long to wait: `"retryDelay":"9217s"` or "Please retry in 2h33m37.46s".
function retryAfterMs(err) {
  const msg = errText(err);
  let m = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Math.round(Number(m[1]) * 1000);
  m = msg.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
  if (m && (m[1] || m[2] || m[3])) {
    return Math.round(((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000);
  }
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// One model: a hard timeout per attempt, quick retries for temporary trouble, a total time budget.
// A quota error is thrown straight away (no retry).
async function callGemini(fn, opts = {}) {
  const {
    label = "Gemini",
    maxRetries = 2,
    attemptTimeoutMs = 15000,
    totalBudgetMs = 35000,
    retryDelayMs = 1000,
    minRetryWindowMs = 2000,
    retryOnTimeout = true
  } = opts;

  const started = Date.now();
  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const remaining = totalBudgetMs - (Date.now() - started);
    if (remaining <= 0) break;

    try {
      return await withTimeout(fn(), Math.min(attemptTimeoutMs, remaining), label);
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);
      const retryable = kind === "overloaded" || (kind === "timeout" && retryOnTimeout);
      const delay = retryDelayMs * (attempt + 1);
      const windowLeft = totalBudgetMs - (Date.now() - started) - delay;

      if (attempt < maxRetries && retryable && windowLeft > minRetryWindowMs) {
        logger.warn(`${label}: ${kind === "timeout" ? "timed out" : "temporary error"} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, errText(err).slice(0, 160));
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error(`${label}: no time budget left`);
}

// ---------------------------------------------------------------------------
// Several models, in priority order.
//   GEMINI_MODEL            main model (default gemini-3.6-flash)
//   GEMINI_FALLBACK_MODELS  comma-separated backups, e.g. "gemini-3.6-flash,some-other-model"
// Free-tier quota is counted per model, so every backup model has its own daily allowance.
// ---------------------------------------------------------------------------
function getModelList() {
  const primary = (process.env.GEMINI_MODEL || "gemini-4-hydrogen").trim();
  const extra = (process.env.GEMINI_FALLBACK_MODELS || "gemini-3.8-flash")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return [...new Set([primary, ...extra])];
}

// A model that just failed is skipped for a while so the next message doesn't waste time on it.
const cooldownUntil = new Map();
function coolDown(model, ms) {
  cooldownUntil.set(model, Date.now() + ms);
}
function isCoolingDown(model) {
  const until = cooldownUntil.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    cooldownUntil.delete(model);
    return false;
  }
  return true;
}

const HOUR = 3600 * 1000;

// makeCall(modelName) must perform the request and return its promise.
// Returns { result, model }. All models share ONE time budget (opts.totalBudgetMs).
async function callGeminiWithFallback(models, makeCall, opts = {}) {
  const { label = "Gemini", totalBudgetMs = 35000, maxRetries = 2 } = opts;
  const started = Date.now();

  let candidates = models.filter(m => !isCoolingDown(m));
  if (!candidates.length) {
    logger.warn(`${label}: every model is cooling down — trying them anyway`);
    candidates = [...models];
  }

  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    const remaining = totalBudgetMs - (Date.now() - started);
    if (remaining < 1500) break;

    const isLast = i === candidates.length - 1;
    try {
      const result = await callGemini(() => makeCall(model), {
        ...opts,
        label: `${label} [${model}]`,
        totalBudgetMs: remaining,
        // With a backup waiting, switch models sooner instead of retrying the same one for long.
        maxRetries: isLast ? maxRetries : 1,
        retryOnTimeout: isLast
      });
      if (model !== models[0]) logger.info(`${label}: answered by backup model ${model}`);
      return { result, model };
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);

      if (kind === "quota") {
        const waitMs = Math.min(retryAfterMs(err) ?? HOUR, 24 * HOUR);
        coolDown(model, waitMs);
        logger.warn(`${label}: ${model} is out of quota (resets in about ${Math.round(waitMs / 60000)} min)${isLast ? "" : " — trying the next model"}`);
      } else if (kind === "notfound") {
        coolDown(model, 24 * HOUR);
        logger.error(`${label}: model "${model}" wasn't found — check GEMINI_MODEL / GEMINI_FALLBACK_MODELS`);
      } else if (kind === "overloaded" || kind === "timeout") {
        coolDown(model, 30 * 1000);
        logger.warn(`${label}: ${model} is ${kind === "timeout" ? "too slow" : "overloaded"}${isLast ? "" : " — trying the next model"}`);
      } else {
        throw err; // bad request / bad key: another model won't fix it
      }
    }
  }
  throw lastErr || new Error(`${label}: no time left`);
}

// Reads a millisecond setting from the environment, but never lets it go above `max`.
// Why a ceiling: Vercel stops the webhook function at 150s (see vercel.json), and the AI time
// plus downloading the file and reading the sheet has to fit inside that.
function envMs(name, fallback, max) {
  const raw = Number(process.env[name]);
  if (!raw) return fallback;
  if (raw > max) {
    logger.warn(`${name}=${raw} is above the safe maximum, using ${max}ms instead (the function is stopped at 150s).`);
    return max;
  }
  return raw;
}

module.exports = {
  callGemini,
  callGeminiWithFallback,
  getModelList,
  envMs,
  classifyError,
  retryAfterMs
};
