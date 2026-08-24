const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error("❌ GEMINI_API_KEY is not set in environment variables.");
  process.exit(1);
}

const MODEL = "models/gemini-3.6-flash"; // Use exactly as returned by ListModels(this is the usable modelfor free users)

// List available models
async function listModels() {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`
    );
    if (!res.ok) {
      console.error(`❌ Failed to list models: ${res.status} ${res.statusText}`);
      console.error(await res.text());
      return;
    }
    const data = await res.json();
    console.log("✅ Available models:");
    data.models.forEach(m => console.log(`- ${m.name}`));
  } catch (err) {
    console.error("❌ Connection error:", err.message);
  }
}

// Test a specific model
async function testGeminiKey() {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${MODEL}:generateContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Hello Gemini" }] }]
        })
      }
    );

    if (!res.ok) {
      console.error(`❌ API request failed: ${res.status} ${res.statusText}`);
      console.error(await res.text());
      return;
    }

    const data = await res.json();
    console.log("✅ API key works. Response:");
    console.dir(data, { depth: null });
  } catch (err) {
    console.error("❌ Connection error:", err.message);
  }
}

// Run both
listModels().then(() => testGeminiKey());