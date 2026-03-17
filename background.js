// TheorieTestHelper — service worker
// Proxies OpenAI API calls so the API key is never exposed to page JS.

"use strict";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "o4-mini";

// ── API call helper ───────────────────────────────────────────────────────

async function callOpenAI(apiKey, prompt) {
  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? "";

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in OpenAI response: " + raw);
  return JSON.parse(match[0]);
}

// ── Message handlers ──────────────────────────────────────────────────────

async function handleTranslateText({ question, answers }) {
  const { apiKey, enabled } = await chrome.storage.local.get(["apiKey", "enabled"]);
  if (!enabled) throw new Error("TheorieTestHelper is disabled.");
  if (!apiKey) throw new Error("No API key set. Click the extension icon to configure.");

  const answersText = answers.map((a, i) => `${i + 1}. ${a}`).join("\n");
  const prompt = `Translate this German driving theory question and its answers to English.
Question: ${question}
Answers:
${answersText}
Respond ONLY as valid JSON (no markdown): { "question": "...", "answers": ["...", "..."] }`;

  return callOpenAI(apiKey, prompt);
}

// ── Listener ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    switch (message.type) {
      case "translate":
        return handleTranslateText(message);
      default:
        throw new Error("Unknown message type: " + message.type);
    }
  };

  handle()
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));

  return true;
});
