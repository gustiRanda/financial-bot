function parseAmountFromReceiptText(text) {
  const lines = text.split("\n");
  const numRegex = /[\d.,]{4,}/g;

  const totalLine = lines.find(l => /total|jumlah|bayar/i.test(l));
  if (totalLine) {
    const nums = totalLine.match(numRegex);
    if (nums) {
      const val = parseIDRNumber(nums[nums.length - 1]);
      if (val !== null && val > 0) return val;
    }
  }

  const allNums = (text.match(numRegex) || [])
    .map(n => parseIDRNumber(n))
    .filter(n => n !== null && n > 100);
  return allNums.length ? Math.max(...allNums) : null;


const BOILERPLATE = /transaction|summary|delivered|details|benefit|gostar|join|level up|download|repeat|need help|purchase item|without cutlery|handling|discount|price|paid with|payment|invoice|receipt/i;

function guessMerchantFromReceiptText(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  const labelIdx = lines.findIndex(l => /restaurant location|nama merchant|merchant name|store name/i.test(l));
  if (labelIdx !== -1 && lines[labelIdx + 1]) return lines[labelIdx + 1];
  return lines.find(l => l.length > 3 && !BOILERPLATE.test(l) && !/^\d+$/.test(l)) || "";
}

function guessAccountFromReceiptText(text, accounts = []) {
  const paidWithMatch = text.match(/paid\s*with\s*([a-z0-9\s]+)/i);
  if (paidWithMatch) {
    const candidate = paidWithMatch[1].trim();
    const found = accounts.find(a => candidate.toLowerCase().includes(a.toLowerCase()));
    if (found) return found;
  }
  return accounts.find(a => new RegExp(a, "i").test(text)) || null;
}

// Parses Indonesian-formatted numbers like "23.000,00" → 23000, "33.201" → 33201,
// "6.061.506" → 6061506. Dot = thousands separator, comma = decimal separator.
function parseIDRNumber(raw) {
  let s = raw.trim();
  const commaIdx = s.lastIndexOf(",");
  if (commaIdx !== -1) {
    s = s.slice(0, commaIdx); // drop the decimal/cents part entirely — "00" is not extra digits
  }
  s = s.replace(/\./g, ""); // now safe to strip dots — they're only thousands separators
  const val = Number(s);
  return Number.isFinite(val) ? val : null;
}

module.exports = { parseAmountFromReceiptText, guessMerchantFromReceiptText, guessAccountFromReceiptText };