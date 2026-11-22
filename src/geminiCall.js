const logger = require("./logger");

// Temporary Gemini problems worth retrying: 503 "high demand", 429 rate limit, and our own timeouts.
function isRetryableError(err) {
  const msg = String(err?.message || err).toLowerCase();
  return msg.includes("503") || msg.includes("overloaded") || msg.includes("high demand") || msg.includes("429") || msg.includes("rate limit");
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs fn() (a Gemini request) with:
//   - a hard timeout per attempt, so a hung connection can't stall the whole webhook
//   - quick retries for temporary errors
//   - a total time budget, so everything finishes well before Telegram re-sends the update (~60s)
async function callGemini(fn, opts = {}) {
  const {
    label = "Gemini",
    maxRetries = 2,
    attemptTimeoutMs = 15000,
    totalBudgetMs = 35000,
    retryDelayMs = 1000,
    minRetryWindowMs = 2000
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
      const timedOut = /timed out after/.test(String(err?.message));
      const delay = retryDelayMs * (attempt + 1);
      const windowLeft = totalBudgetMs - (Date.now() - started) - delay;

      if (attempt < maxRetries && (timedOut || isRetryableError(err)) && windowLeft > minRetryWindowMs) {
        logger.warn(`${label}: ${timedOut ? "timed out" : "temporary error"} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, err.message);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error(`${label}: no time budget left`);
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

module.exports = { callGemini, envMs };
