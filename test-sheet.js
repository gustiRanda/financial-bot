require("dotenv").config();

const { google } = require("googleapis");

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets"
    ]
  });

  const sheets = google.sheets({
    version: "v4",
    auth
  });
  const meta =
 await sheets.spreadsheets.get({
   spreadsheetId:
   process.env.GOOGLE_SHEET_ID
 });

console.log(
 JSON.stringify(
  meta.data.sheets,
  null,
  2
 )
);

  const result =
    await sheets.spreadsheets.get({
      spreadsheetId:
        process.env.GOOGLE_SHEET_ID
    });

  console.log(
    "Spreadsheet:",
    result.data.properties.title
  );

  console.log(
    "Sheets:"
  );

  result.data.sheets.forEach(
    sheet => {
      console.log(
        "-",
        sheet.properties.title
      );
    }
  );
}

main().catch(console.error);