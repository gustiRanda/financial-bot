const vision = require("@google-cloud/vision");

const client = new vision.ImageAnnotatorClient({
  keyFilename: "credentials.json"
});

// Grabs the first rupiah-looking amount near a "total" line, falling back
// to the largest number on the receipt if no "total" line is found.
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
  if (!allNums.length) return null;
  return Math.max(...allNums);
}

function guessMerchantFromReceiptText(text) {
  const firstLine = text.split("\n").map(l => l.trim()).find(l => l.length > 2);
  return firstLine || "";
}

async function extractReceiptData(imageUrl) {
  const [result] = await client.textDetection(imageUrl);
  const text = result.fullTextAnnotation?.text;
  if (!text) return { amount: null, description: "" };

  return {
    amount: parseAmountFromReceiptText(text),
    description: guessMerchantFromReceiptText(text)
  };
}

module.exports = { extractReceiptData };