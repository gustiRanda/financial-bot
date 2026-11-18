const { google } = require("googleapis");
const logger = require("./logger");
const { parseIndoAmount } = require("./chatParser");

// Columns in the AutoTransactions tab (header in row 1):
// A ID | B Type | C Description | D Amount | E Category | F Account | G Day of Month | H Active | I Chat ID | J Last Run

let sheetsClient = null;
function getSheets() {
  if (!sheetsClient) {
    const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
    // Same auth logic as sheets.js: env var when deployed, credentials.json for local dev.
    const authConfig = process.env.GOOGLE_CREDENTIALS_JSON
      ? { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON), scopes }
      : { keyFile: "credentials.json", scopes };
    sheetsClient = google.sheets({ version: "v4", auth: new google.auth.GoogleAuth(authConfig) });
  }
  return sheetsClient;
}

const RANGE = "AutoTransactions!A2:J1000";

// The Amount cell may be formatted as currency ("Rp6,261,506"). We ask Sheets for raw
// values so it arrives as a number, and fall back to parsing the text just in case.
function toAmount(v) {
  if (typeof v === "number") return v;
  return parseIndoAmount(v) || 0;
}

// "Last Run" as YYYY-MM-DD whether the cell holds text, or a real date (serial number).
function toIsoDate(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "number") {
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  return String(v).trim();
}

async function listAutoTransactions() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: RANGE,
    valueRenderOption: "UNFORMATTED_VALUE", // numbers stay numbers, whatever the cell format
    dateTimeRenderOption: "FORMATTED_STRING" // dates stay readable text, e.g. 2026-09-25
  });
  const rows = res.data.values || [];
  return rows
    .map((r, i) => ({
      rowIndex: i + 2,
      id: r[0] === undefined || r[0] === "" ? "" : String(r[0]),
      type: String(r[1] || "").trim().toLowerCase(),
      description: r[2] === undefined ? "" : String(r[2]),
      amount: toAmount(r[3]),
      category: r[4] === undefined ? "" : String(r[4]),
      account: r[5] === undefined ? "" : String(r[5]),
      dayOfMonth: Number(r[6]),
      active: String(r[7]).trim().toLowerCase() === "true",
      chatId: r[8],
      lastRun: toIsoDate(r[9])
    }))
    .filter(r => r.id);
}

async function addAutoTransaction({ type, description, amount, category, account, dayOfMonth, chatId }) {
  const sheets = getSheets();
  const id = Date.now().toString(36);
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "AutoTransactions!A:J",
    valueInputOption: "USER_ENTERED",
    resource: { values: [[id, type, description, amount, category, account, dayOfMonth, "TRUE", chatId, ""]] }
  });
  logger.info("Auto-transaction added:", { id, type, description, amount, category, account, dayOfMonth });
  return id;
}

async function getSheetIdByTitle(sheets, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID });
  const tab = meta.data.sheets.find(s => s.properties.title === title);
  if (!tab) throw new Error(`Sheet tab "${title}" not found — did you create it?`);
  return tab.properties.sheetId;
}

async function deleteAutoTransaction(id) {
  const all = await listAutoTransactions();
  const target = all.find(a => a.id === String(id));
  if (!target) return false;
  const sheets = getSheets();
  const sheetId = await getSheetIdByTitle(sheets, "AutoTransactions");
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    resource: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId, dimension: "ROWS", startIndex: target.rowIndex - 1, endIndex: target.rowIndex }
          }
        }
      ]
    }
  });
  logger.info("Auto-transaction deleted:", id);
  return true;
}

async function setActive(id, active) {
  const all = await listAutoTransactions();
  const target = all.find(a => a.id === String(id));
  if (!target) return false;
  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `AutoTransactions!H${target.rowIndex}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [[active ? "TRUE" : "FALSE"]] }
  });
  return true;
}

async function markRun(id, dateStr) {
  const all = await listAutoTransactions();
  const target = all.find(a => a.id === String(id));
  if (!target) return false;
  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `AutoTransactions!J${target.rowIndex}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [[dateStr]] }
  });
  return true;
}

module.exports = { listAutoTransactions, addAutoTransaction, deleteAutoTransaction, setActive, markRun };
