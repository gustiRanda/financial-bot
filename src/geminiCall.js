const logger = require("./logger");

// ---------------------------------------------------------------------------
// What kind of failure was it?
//   quota      429 — daily/minute limit used up. NOT temporary: retrying the same model is pointless.
//   overloaded 503 "high demand" — usually passes quickly.
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
//   GEMINI_FALLBACK_MODELS  comma-separated backups, e.g. "gemini-3.8-flash"
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

// A model that just failed is moved aside for a while, so the next messages don't wait on it and
// don't spend free-tier quota on it (a request we gave up on STILL counts against the daily quota).
//   quota / notfound : skipped completely (it would only fail again)
//   overloaded / slow: tried LAST (it may have recovered, but nobody should wait for it)
// On Vercel every request can land on a different server instance, so memory alone forgets this.
// The state is therefore also kept in Upstash Redis (the one already used for sessions);
// if Redis isn't configured or is down, it quietly falls back to this instance's memory.
const cooldowns = new Map(); // model -> { until, kind }  (this instance's memory)
const inflightWrites = new Set();
let redisClient = null;
let redisChecked = false;

function getRedis() {
  if (redisChecked) return redisClient;
  redisChecked = true;
  try {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      const { Redis } = require("@upstash/redis");
      redisClient = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN
      });
    }
  } catch (err) {
    logger.warn("Shared model cooldowns are off (Redis unavailable):", err.message);
  }
  return redisClient;
}

const cooldownKey = model => `gem:cd:${model}`;

function track(promise, what) {
  const p = Promise.resolve(promise)
    .catch(err => logger.warn(`Couldn't ${what} in Redis:`, err.message))
    .finally(() => inflightWrites.delete(p));
  inflightWrites.add(p);
}

function coolDown(model, ms, kind) {
  const until = Date.now() + ms;
  cooldowns.set(model, { until, kind });
  const redis = getRedis();
  if (redis) track(redis.set(cooldownKey(model), { kind, until }, { ex: Math.max(1, Math.ceil(ms / 1000)) }), "save a model cooldown");
}

function clearCooldown(model) {
  cooldowns.delete(model);
  const redis = getRedis();
  if (redis) track(redis.del(cooldownKey(model)), "clear a model cooldown");
}

function cooldownKind(model) {
  const c = cooldowns.get(model);
  if (!c) return null;
  if (Date.now() >= c.until) {
    cooldowns.delete(model);
    return null;
  }
  return c.kind;
}

// Pull in what other server instances have recorded (one Redis round trip for all models).
async function loadSharedCooldowns(models) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const values = await redis.mget(...models.map(cooldownKey));
    values.forEach((v, i) => {
      if (v && v.kind && Number(v.until) > Date.now()) cooldowns.set(models[i], { until: Number(v.until), kind: v.kind });
    });
  } catch (err) {
    logger.warn("Couldn't read shared model cooldowns (using this instance's memory):", err.message);
  }
}

async function flushWrites() {
  if (inflightWrites.size) await Promise.allSettled([...inflightWrites]);
}

function orderModels(models) {
  const usable = [];
  const demoted = [];
  const blocked = [];
  for (const m of models) {
    const k = cooldownKind(m);
    if (!k) usable.push(m);
    else if (k === "quota" || k === "notfound") blocked.push(m);
    else demoted.push(m);
  }
  const ordered = [...usable, ...demoted];
  if (demoted.length || blocked.length) {
    const aside = [
      ...demoted.map(m => `${m} (${cooldownKind(m)}, tried last)`),
      ...blocked.map(m => `${m} (${cooldownKind(m)}, skipped)`)
    ];
    logger.info(`Model order: ${(ordered.length ? ordered : models).join(" → ")}  |  set aside: ${aside.join(", ")}`);
  }
  if (ordered.length) return ordered;
  logger.warn("Every model is out of quota or missing — trying them anyway");
  return blocked.length ? blocked : [...models];
}

const HOUR = 3600 * 1000;
const SLOW_COOLDOWN_MS = Number(process.env.GEMINI_SLOW_COOLDOWN_MS) || 15 * 60 * 1000;

function noteFailure(label, model, kind, err, isLast, extra = "") {
  if (kind === "quota") {
    const waitMs = Math.min(retryAfterMs(err) ?? HOUR, 24 * HOUR);
    coolDown(model, waitMs, "quota");
    logger.warn(`${label}: ${model} is out of quota (resets in about ${Math.round(waitMs / 60000)} min)${isLast ? "" : " — using the next model"}`);
  } else if (kind === "notfound") {
    coolDown(model, 24 * HOUR, "notfound");
    logger.error(`${label}: model "${model}" wasn't found — check GEMINI_MODEL / GEMINI_FALLBACK_MODELS`);
  } else if (kind === "overloaded") {
    coolDown(model, 60 * 1000, "overloaded");
    logger.warn(`${label}: ${model} is overloaded${isLast ? "" : " — using the next model"}${extra}`);
  } else if (kind === "timeout") {
    coolDown(model, SLOW_COOLDOWN_MS, "slow");
    logger.warn(`${label}: ${model} gave no answer in time${isLast ? "" : " — using the next model"}${extra}`);
  }
}

// ---------------------------------------------------------------------------
// HEDGED (default when there are 2+ models and hedgeAfterMs > 0):
//   t=0            ask the first model — and keep waiting for it until the deadline (never cut short)
//   it fails       start the next model immediately
//   still silent
//   after hedgeAfterMs   start the next model as well, WITHOUT cancelling the first
//   first valid answer wins; the other request is simply ignored.
// A model that has a backup is not retried (each retry costs free-tier quota); the last one may retry.
// ---------------------------------------------------------------------------
function hedgedFallback(candidates, allModels, makeCall, opts) {
  const { label = "Gemini", totalBudgetMs = 35000, hedgeAfterMs, maxRetries = 2 } = opts;
  const started = Date.now();
  const deadline = started + totalBudgetMs;

  return new Promise((resolve, reject) => {
    let settled = false;
    let nextIndex = 0;
    let running = 0;
    let lastErr = null;
    let hedgeTimer = null;
    let masterTimer = null;
    const launched = []; // { model, startedAt, done }

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(masterTimer);
      fn(value);
    };

    masterTimer = setTimeout(
      () => finish(reject, lastErr || new Error(`${label} timed out after ${totalBudgetMs}ms`)),
      totalBudgetMs
    );

    const scheduleHedge = () => {
      clearTimeout(hedgeTimer);
      if (settled || nextIndex >= candidates.length) return;
      hedgeTimer = setTimeout(() => {
        if (settled) return;
        const silent = launched.filter(l => !l.done).map(l => l.model).join(", ");
        logger.info(`${label}: ${silent} still silent after ${Math.round(hedgeAfterMs / 1000)}s — also asking ${candidates[nextIndex]} (the first answer wins)`);
        launch();
      }, hedgeAfterMs);
    };

    const launch = () => {
      if (settled || nextIndex >= candidates.length) return false;
      const remaining = deadline - Date.now();
      if (remaining < 1500) return false;

      const model = candidates[nextIndex++];
      const isLast = nextIndex >= candidates.length;
      const entry = { model, startedAt: Date.now(), done: false };
      launched.push(entry);
      running++;

      callGemini(() => makeCall(model), {
        ...opts,
        label: `${label} [${model}]`,
        attemptTimeoutMs: remaining, // a racing model may use all the time left — never cut short early
        totalBudgetMs: remaining,
        maxRetries: isLast ? maxRetries : 0, // protect the small free-tier quota
        retryOnTimeout: false
      })
        .then(result => {
          entry.done = true;
          running--;
          const secs = ((Date.now() - entry.startedAt) / 1000).toFixed(1);
          if (settled) {
            logger.info(`${label}: ${model} also answered (after ${secs}s) but another model was first — ignored`);
            return;
          }
          // Models that were still silent when this one won: try them last for a few minutes.
          for (const other of launched) {
            if (!other.done && other.model !== model) {
              coolDown(other.model, SLOW_COOLDOWN_MS, "slow");
              logger.warn(`${label}: ${other.model} was still silent after ${((Date.now() - other.startedAt) / 1000).toFixed(0)}s when ${model} answered — it will be tried last for ${Math.round(SLOW_COOLDOWN_MS / 60000)} min`);
            }
          }
          if (cooldownKind(model)) clearCooldown(model);
          if (model !== allModels[0]) logger.info(`${label}: answered by backup model ${model}`);
          finish(resolve, { result, model });
        })
        .catch(err => {
          entry.done = true;
          running--;
          lastErr = err;
          const kind = classifyError(err);
          noteFailure(label, model, kind, err, isLast);
          if (settled) return;
          if (kind === "other") return finish(reject, err); // bad request / key: another model won't help
          if (!launch() && running === 0) finish(reject, lastErr); // nothing left to try
        });

      scheduleHedge();
      return true;
    };

    launch();
  });
}

// ---------------------------------------------------------------------------
// SEQUENTIAL (hedgeAfterMs = 0, or only one model): one model at a time, each with a fair share
// of the time budget, moving on after a failure or a timeout.
// ---------------------------------------------------------------------------
async function sequentialFallback(candidates, allModels, makeCall, opts) {
  const { label = "Gemini", totalBudgetMs = 35000, maxRetries = 2 } = opts;
  const started = Date.now();

  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    const remaining = totalBudgetMs - (Date.now() - started);
    if (remaining < 1500) break;

    const isLast = i === candidates.length - 1;
    const share = Math.floor(remaining / (candidates.length - i));
    try {
      const result = await callGemini(() => makeCall(model), {
        ...opts,
        label: `${label} [${model}]`,
        totalBudgetMs: share,
        maxRetries: isLast ? maxRetries : 1,
        retryOnTimeout: isLast
      });
      if (cooldownKind(model)) clearCooldown(model);
      if (model !== allModels[0]) logger.info(`${label}: answered by backup model ${model}`);
      return { result, model };
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);
      if (kind === "other") throw err;
      noteFailure(label, model, kind, err, isLast, kind === "timeout" ? ` (it had ${Math.round(share / 1000)}s)` : "");
    }
  }
  throw lastErr || new Error(`${label}: no time left`);
}

// makeCall(modelName) must perform the request and return its promise.
// Returns { result, model }.  opts.totalBudgetMs is ONE budget shared by all models.
async function callGeminiWithFallback(models, makeCall, opts = {}) {
  await loadSharedCooldowns(models);
  const ordered = orderModels(models);
  const hedge = Number(opts.hedgeAfterMs) || 0;
  try {
    if (ordered.length > 1 && hedge > 0) {
      return await hedgedFallback(ordered, models, makeCall, { ...opts, hedgeAfterMs: hedge });
    }
    return await sequentialFallback(ordered, models, makeCall, opts);
  } finally {
    await flushWrites(); // don't let the function end before the Redis writes have landed
  }
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

// Same, but 0 is a real value (0 = "off").
function envMsAllowZero(name, fallback, max) {
  const text = process.env[name];
  if (text === undefined || text === "") return fallback;
  const raw = Number(text);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.min(raw, max);
}

module.exports = {
  callGemini,
  callGeminiWithFallback,
  getModelList,
  envMs,
  envMsAllowZero,
  classifyError,
  retryAfterMs
};
