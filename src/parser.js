function parseMessage(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return null;

  const account = parts[parts.length - 1];
  const amount = parseInt(parts[parts.length - 2].replace(/[.,]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const description = parts.slice(0, parts.length - 2).join(" ");
  if (!description) return null;

  return { description, amount, account };
}

module.exports = { parseMessage };