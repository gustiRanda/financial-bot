// chatParser.js — understands free-form chat messages locally (no AI, no network).
//
//   parseIndoAmount("7jt")        -> 7000000
//   parseIndoAmount("2k" / "2rb") -> 2000
//   parseIndoAmount("1,5jt")      -> 1500000
//   parseIndoAmount("Rp 5.000")   -> 5000
//   parseFreeText("Cash 5000 gorengan", accounts)
//       -> { amount: 5000, account: "Cash", description: "Gorengan", ... }
//
// Anything it can't resolve safely (two different amounts, no amount, ...) is
// reported as such, so the caller can hand the message to the AI instead of guessing.

const SUFFIX_MULTIPLIER = { jt: 1e6, juta: 1e6, rb: 1e3, ribu: 1e3, k: 1e3, miliar: 1e9, milyar: 1e9 };
const SUFFIX_PATTERN = "jt|juta|rb|ribu|k|miliar|milyar";

// Parses ONE money expression. Returns a whole-rupiah number, or null.
function parseIndoAmount(input) {
  if (input === null || input === undefined) return null;
  const s = String(input)
    .toLowerCase()
    .trim()
    .replace(/^(?:rp|idr)\.?\s*/, "")
    .replace(/\s+/g, "");

  const m = s.match(new RegExp(`^(\\d+(?:[.,]\\d+)*)(${SUFFIX_PATTERN})?$`));
  if (!m) return null;
  const [, numStr, suffix] = m;

  let value;
  if (suffix) {
    // With a suffix, "." or "," is a decimal point: 1,5jt = 1.5 million.
    value = Number(numStr.replace(",", ".")) * SUFFIX_MULTIPLIER[suffix];
  } else {
    const bankStyle = numStr.match(/^(\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/); // 5.000 / 1.500.000 / 23.000,00
    if (bankStyle) value = Number(bankStyle[1].replace(/\./g, ""));
    else if (/^\d{1,3}(?:,\d{3})+$/.test(numStr)) value = Number(numStr.replace(/,/g, "")); // 5,000
    else if (/^\d+$/.test(numStr)) value = Number(numStr);
    else return null; // ambiguous like "2.5" or "1,5" with no suffix
  }

  value = Math.round(value);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const AMOUNT_RE = new RegExp(
  `(?<![a-z0-9.,])(?:(?:rp|idr)\\.?\\s*)?\\d+(?:[.,]\\d+)*\\s*(?:${SUFFIX_PATTERN})?(?![a-z0-9])`,
  "gi"
);

// Finds the one money amount hiding anywhere in a sentence.
function findAmount(text) {
  const candidates = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const raw = m[0].trim();
    const hasMarker = /^(?:rp|idr)/i.test(raw) || /[a-z]$/i.test(raw); // "Rp" prefix or jt/rb/k suffix
    const digits = raw.replace(/\D/g, "");
    const value = parseIndoAmount(raw);
    if (value === null) continue;
    if (!hasMarker) {
      if (value < 100) continue; // quantities like "2 kopi"
      if (/^0/.test(digits) && digits.length >= 8) continue; // phone numbers
      if (digits.length >= 11) continue; // IDs / long numbers
    }
    candidates.push({ value, hasMarker, index: m.index, length: m[0].length });
  }

  // Explicit amounts (7jt, 25rb, Rp 5.000) beat bare numbers.
  const pool = candidates.some(c => c.hasMarker) ? candidates.filter(c => c.hasMarker) : candidates;
  const distinct = [...new Set(pool.map(c => c.value))];
  if (distinct.length === 0) return { amount: null, ambiguous: false };
  if (distinct.length > 1) return { amount: null, ambiguous: true };
  return { amount: pool[0].value, ambiguous: false, index: pool[0].index, length: pool[0].length };
}

const ACCOUNT_ALIASES = { tunai: "cash", spay: "shopeepay" };

// Words that are just glue around the real description ("dari", "pake", "hari ini", ...).
const EDGE_NOISE = new Set([
  "dari", "pake", "pakai", "pakek", "via", "lewat", "dengan", "from", "with", "using",
  "sebesar", "sebanyak", "seharga", "tadi", "barusan", "hari", "ini", "di", "ke", "untuk",
  "masuk", "rp", "idr"
]);

const INCOME_CUE =
  /\b(?:gaji|gajian|salary|payroll|thr|bonus|lembur|overtime|cashback|refund|reimburse|dividen|dividend|bunga|pemasukan|income|terima|nerima|menerima|dapet|dapat|dikasih)\b/i;

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// Looks for account names anywhere in the tokens, in any order, tolerating
// spacing/case differences ("sea bank" = SeaBank, "digi cash" = digi Cash).
function findAccounts(tokens, accounts) {
  const byNorm = new Map(accounts.map(a => [norm(a), a]));
  for (const [alias, target] of Object.entries(ACCOUNT_ALIASES)) {
    if (byNorm.has(target) && !byNorm.has(alias)) byNorm.set(alias, byNorm.get(target));
  }

  const used = new Array(tokens.length).fill(false);
  const found = [];
  for (let n = 3; n >= 1; n--) {
    // longest match first, so "digi cash" wins over a lone "cash"
    for (let i = 0; i + n <= tokens.length; i++) {
      if (used.slice(i, i + n).some(Boolean)) continue;
      const key = norm(tokens.slice(i, i + n).join(""));
      if (key && byNorm.has(key)) {
        for (let j = i; j < i + n; j++) used[j] = true;
        const name = byNorm.get(key);
        if (!found.includes(name)) found.push(name);
      }
    }
  }
  return { found, used };
}

function parseFreeText(text, accounts = []) {
  const original = String(text || "").trim();
  const amountInfo = findAmount(original);

  let rest = original;
  if (amountInfo.amount !== null) {
    rest = original.slice(0, amountInfo.index) + " " + original.slice(amountInfo.index + amountInfo.length);
  }

  const tokens = rest.split(/[\s,;:!?()]+/).filter(Boolean);
  const { found, used } = findAccounts(tokens, accounts);

  const descTokens = tokens.filter((_, i) => !used[i]);
  while (descTokens.length && EDGE_NOISE.has(descTokens[0].toLowerCase())) descTokens.shift();
  while (descTokens.length && EDGE_NOISE.has(descTokens[descTokens.length - 1].toLowerCase())) descTokens.pop();

  let description = descTokens.join(" ").trim();
  if (description) description = description.charAt(0).toUpperCase() + description.slice(1);

  return {
    amount: amountInfo.amount,
    ambiguousAmount: amountInfo.ambiguous,
    account: found.length === 1 ? found[0] : null,
    multipleAccounts: found.length > 1 ? found : null,
    description,
    incomeCue: INCOME_CUE.test(original)
  };
}

// Cheap pre-check so random chatter ("hi", "thanks") never costs an AI call.
function looksLikeMoney(text) {
  return /\d|ribu|juta|\brb\b|\bjt\b|setengah|ratus|seceng|goceng|ceban|noban|goban|gocap/i.test(String(text || ""));
}

module.exports = { parseIndoAmount, parseFreeText, looksLikeMoney };
