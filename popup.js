// TheorieTestHelper — popup script

"use strict";

const toggle = document.getElementById("enabled-toggle");
const apiKeyInput = document.getElementById("api-key");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

// Load saved settings
chrome.storage.local.get(["apiKey", "enabled"], ({ apiKey, enabled }) => {
  // Default enabled to true on first install
  toggle.checked = enabled !== false;
  if (apiKey) apiKeyInput.value = apiKey;
});

saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  chrome.storage.local.set({ apiKey: key, enabled: toggle.checked }, () => {
    statusEl.textContent = "Saved!";
    setTimeout(() => { statusEl.textContent = ""; }, 1500);
  });
});
