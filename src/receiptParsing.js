function parseAmountFromReceiptText(text) {
  const lines = text.split("\n");
  const numRegex = /[\d.,]{4,}/g;
  const totalLine = lines.find(l => /total|jumlah|bayar/i.test(l));
  if (totalLine) {
    const nums = totalLine.match(numRegex);
    if (nums) {
      const val = Number(nums[nums.length - 1].replace(/[.,]/g, ""));
      if (Number.isFinite(val) && val > 0) return val;
    }
  }
  const allNums = (text.match(numRegex) || [])
    .map(n => Number(n.replace(/[.,]/g, "")))
    .filter(n => Number.isFinite(n) && n > 100);
  return allNums.length ? Math.max(...allNums) : null;
}

const BOILERPLATE = /transaction|summary|delivered|details|benefit|gostar|join|level up|download|repeat|need help|purchase item|without cutlery|handling|discount|price|paid with|payment|invoice|receipt/i;

function guessMerchantFromReceiptText(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const labelIdx = lines.findIndex(l => /restaurant location|merchant|store name/i.test(l));
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

module.exports = { parseAmountFromReceiptText, guessMerchantFromReceiptText, guessAccountFromReceiptText };