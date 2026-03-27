// TheorieTestHelper — service worker
// Proxies OpenAI API calls so the API key is never exposed to page JS.

"use strict";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL      = "o4-mini";       // JSON tasks: translation, word-translate
const MODEL_CHAT = "gpt-4o-mini";   // default chat model
const MODEL_2    = "gpt-4o";        // escalated chat (@gpt4o)

// ── API call helper ───────────────────────────────────────────────────────

async function callOpenAI(apiKey, content) {
  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content }],
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

function buildImageContent(imageBase64) {
  if (!imageBase64) return null;
  const url = /^https?:\/\//.test(imageBase64)
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;
  return { type: "image_url", image_url: { url } };
}

async function handleTranslateText({ question, answers, imageBase64 }) {
  const { apiKey, enabled } = await chrome.storage.local.get(["apiKey", "enabled"]);
  if (!enabled) throw new Error("TheorieTestHelper is disabled.");
  if (!apiKey) throw new Error("No API key set. Click the extension icon to configure.");

  const promptText = answers.length
    ? `Translate this German driving theory question and its answers to English. Keep answers in the same order.
Question: ${question}
Answers:
${answers.map((a, i) => `${i + 1}. ${a}`).join("\n")}
Respond ONLY as valid JSON (no markdown): { "question": "...", "answers": ["...", "..."], "glossary": {"GermanWord": "English meaning", ...} }
The glossary must cover every meaningful content word (nouns, verbs, adjectives, adverbs) that appears in the question and answers, exactly as written. Omit articles, prepositions, and conjunctions.`
    : `Translate this German driving theory question to English.
Question: ${question}
Respond ONLY as valid JSON (no markdown): { "question": "...", "answers": [], "glossary": {"GermanWord": "English meaning", ...} }
The glossary must cover every meaningful content word (nouns, verbs, adjectives, adverbs) that appears in the question, exactly as written. Omit articles, prepositions, and conjunctions.`;

  const imgContent = buildImageContent(imageBase64);
  const content = imgContent ? [imgContent, { type: "text", text: promptText }] : promptText;

  return callOpenAI(apiKey, content);
}

async function handleChat({ systemContext, history, imageBase64, model }) {
  const { apiKey, enabled } = await chrome.storage.local.get(["apiKey", "enabled"]);
  if (!enabled) throw new Error("TheorieTestHelper is disabled.");
  if (!apiKey) throw new Error("No API key set. Click the extension icon to configure.");

  const messages = [{ role: "system", content: systemContext }];
  history.forEach((msg, i) => {
    if (i === 0 && imageBase64 && msg.role === "user") {
      messages.push({
        role: "user",
        content: [
          buildImageContent(imageBase64),
          { type: "text", text: msg.content },
        ],
      });
    } else {
      messages.push(msg);
    }
  });

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: model || MODEL_CHAT, messages }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content ?? "";
  return { reply };
}


async function handleCaptureTab(sender) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(
      sender.tab.windowId,
      { format: "jpeg", quality: 85 },
      (dataUrl) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve({ dataUrl: dataUrl.split(",")[1] });
      }
    );
  });
}

// ── Flashcard + word-translate handlers ───────────────────────────────────

async function handleTranslateSolution({ text }) {
  const { apiKey, enabled } = await chrome.storage.local.get(["apiKey", "enabled"]);
  if (!enabled) throw new Error("TheorieTestHelper is disabled.");
  if (!apiKey) throw new Error("No API key set.");
  const prompt = `Translate this German driving theory explanation to English. Respond ONLY as valid JSON: { "solution": "..." }\n\n${text}`;
  return callOpenAI(apiKey, prompt);
}

async function handleWordTranslate({ word, germanContext, englishContext }) {
  const { apiKey, enabled } = await chrome.storage.local.get(["apiKey", "enabled"]);
  if (!enabled) throw new Error("TheorieTestHelper is disabled.");
  if (!apiKey) throw new Error("No API key set.");
  const prompt = (germanContext && englishContext)
    ? `In this German driving theory sentence: "${germanContext}" (which translates to: "${englishContext}"), what does the word "${word}" mean in English? Give a concise translation or definition. Reply with valid JSON only: {"translation": "..."}`
    : `Translate the German word or phrase "${word}" to English. Reply with valid JSON only: {"translation": "..."}`;
  return callOpenAI(apiKey, prompt);
}

async function handleAddFlashcard({ german, english }) {
  const { flashcards = [] } = await chrome.storage.local.get("flashcards");
  const duplicate = flashcards.some(c => c.german === german);
  if (!duplicate) {
    flashcards.push({ german, english });
    await chrome.storage.local.set({ flashcards });
  }
  return { duplicate };
}

async function handleGetFlashcards() {
  const { flashcards = [] } = await chrome.storage.local.get("flashcards");
  return { flashcards };
}

async function handleRemoveFlashcard({ german }) {
  const { flashcards = [] } = await chrome.storage.local.get("flashcards");
  await chrome.storage.local.set({ flashcards: flashcards.filter(c => c.german !== german) });
  return {};
}

// ── Listener ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    switch (message.type) {
      case "translate":
        return handleTranslateText(message);
      case "chat":
        return handleChat(message);
      case "capture-tab":
        return handleCaptureTab(sender);
      case "translate-solution": return handleTranslateSolution(message);
      case "word-translate":    return handleWordTranslate(message);
      case "add-flashcard":     return handleAddFlashcard(message);
      case "get-flashcards":    return handleGetFlashcards();
      case "remove-flashcard":  return handleRemoveFlashcard(message);
      case "enyo-toggle":
        // Fire the Enyo tap event from the t24qachk sub-component in the page's
        // main world. This replicates a real user click exactly: the ontap on
        // t24qachk calls toggleCheckmark() on t24answer, then bubbles up to
        // CoreTestingDisplay.tapButtonChkboxAnswer() which calls saveUserAnswer().
        await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
          world: "MAIN",
          func: (compId) => {
            try {
              var c = typeof enyo !== "undefined" && enyo.$ && enyo.$[compId];
              if (c && c.$ && c.$.t24qachk && typeof c.$.t24qachk.bubble === "function") {
                c.$.t24qachk.bubble("ontap", {});
              }
            } catch (e) {}
          },
          args: [message.compId],
        });
        return {};
      case "enyo-btn-tap":
        // Fire an Enyo ontap event on an action button (Abbrechen / ★ / Auflösung)
        // from the page's main world. .click() is insufficient — Enyo synthesizes
        // tap from mousedown+mouseup, not from click events.
        await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
          world: "MAIN",
          func: (compId) => {
            try {
              var c = typeof enyo !== "undefined" && enyo.$ && enyo.$[compId];
              if (c && typeof c.bubble === "function") c.bubble("ontap", {});
            } catch (e) {}
          },
          args: [message.compId],
        });
        return {};
      default:
        throw new Error("Unknown message type: " + message.type);
    }
  };

  handle()
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));

  return true;
});
