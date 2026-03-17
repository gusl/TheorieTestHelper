// TheorieTestHelper — content script
// Injected into theorie24.de pages (all frames). Only the frame that contains
// the question element will activate the sidebar.

(function () {
  "use strict";

  const SIDEBAR_ID = "tth-sidebar";

  // ── DOM selectors ─────────────────────────────────────────────────────────
  const SEL_QUESTION = "#app_TestingPage_CoreTestingDisplay_t24qtext";
  // Each answer row has a <span id="..._answertext"> with the clean answer text
  const SEL_ANSWERS  = "[id$='_answertext']";

  // ── Guard: only run in the frame that has the question ────────────────────
  // Other iframes on the page should stay dormant.
  function isQuestionFrame() {
    return !!document.querySelector(SEL_QUESTION);
  }

  // ── Sidebar helpers ───────────────────────────────────────────────────────

  function createSidebar() {
    if (document.getElementById(SIDEBAR_ID)) return document.getElementById(SIDEBAR_ID);

    // Toggle tab
    const toggle = document.createElement("button");
    toggle.id = "tth-toggle";
    toggle.textContent = "EN ▲";
    document.body.appendChild(toggle);

    // Panel
    const sidebar = document.createElement("div");
    sidebar.id = SIDEBAR_ID;
    sidebar.innerHTML = `
      <div id="tth-header">
        <span id="tth-title">TheorieTestHelper</span>
        <button id="tth-close" title="Close">▼</button>
      </div>
      <div id="tth-body">
        <div id="tth-spinner" class="tth-spinner">Translating…</div>
        <div id="tth-content"></div>
        <div id="tth-error" style="display:none;" class="tth-error"></div>
      </div>
    `;
    document.body.appendChild(sidebar);

    function openPanel() {
      sidebar.classList.add("tth-open");
      toggle.textContent = "EN ▼";
    }
    function closePanel() {
      sidebar.classList.remove("tth-open");
      toggle.textContent = "EN ▲";
    }

    toggle.addEventListener("click", () =>
      sidebar.classList.contains("tth-open") ? closePanel() : openPanel()
    );
    document.getElementById("tth-close").addEventListener("click", closePanel);

    return sidebar;
  }

  function showSpinner() {
    const sidebar = createSidebar();
    sidebar.classList.add("tth-open");
    document.getElementById("tth-toggle").textContent = "EN ▼";
    document.getElementById("tth-spinner").style.display = "block";
    document.getElementById("tth-content").style.display = "none";
    document.getElementById("tth-error").style.display = "none";
  }

  function showTranslation(question, answers) {
    createSidebar();
    document.getElementById("tth-spinner").style.display = "none";
    document.getElementById("tth-error").style.display = "none";
    const content = document.getElementById("tth-content");
    const answersHtml = answers
      .map((a, i) => `<li class="tth-answer"><span class="tth-answer-label">${String.fromCharCode(65 + i)}.</span> ${escapeHtml(a)}</li>`)
      .join("");
    content.innerHTML = `<p class="tth-question">${escapeHtml(question)}</p><ul class="tth-answers">${answersHtml}</ul>`;
    content.style.display = "";
  }

  function showError(msg) {
    createSidebar();
    document.getElementById("tth-spinner").style.display = "none";
    document.getElementById("tth-content").style.display = "none";
    const err = document.getElementById("tth-error");
    err.textContent = msg;
    err.style.display = "block";
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── DOM parsing ───────────────────────────────────────────────────────────

  function parseQuestion() {
    const questionEl = document.querySelector(SEL_QUESTION);
    if (!questionEl) return null;

    const questionText = questionEl.textContent.trim();
    // "Fragentext?" is a placeholder shown before the real question loads
    if (!questionText || questionText === "Fragentext?") return null;

    const answerEls = document.querySelectorAll(SEL_ANSWERS);
    if (!answerEls.length) return null;

    return {
      question: questionText,
      answers: Array.from(answerEls).map(el => el.textContent.trim()).filter(Boolean),
    };
  }

  // ── Main translation flow ─────────────────────────────────────────────────

  // Retry parsing up to MAX_RETRIES times (500 ms apart) in case answers
  // haven't rendered yet when the question element first appears.
  const MAX_RETRIES = 6;

  async function translate() {
    showSpinner();

    let parsed = null;
    for (let i = 0; i < MAX_RETRIES; i++) {
      parsed = parseQuestion();
      if (parsed) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (!parsed) {
      showError("Could not find question/answers in the page DOM.");
      return;
    }

    chrome.runtime.sendMessage(
      { type: "translate", question: parsed.question, answers: parsed.answers },
      (response) => {
        if (chrome.runtime.lastError) {
          showError("Extension error: " + chrome.runtime.lastError.message);
          return;
        }
        if (response && response.error) {
          showError("Translation error: " + response.error);
          return;
        }
        showTranslation(response.question, response.answers);
      }
    );
  }

  // ── MutationObserver — detect SPA question changes ────────────────────────

  let debounceTimer = null;
  let lastQuestionText = null;

  function onMutation() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const questionEl = document.querySelector(SEL_QUESTION);
      if (!questionEl) return;
      const text = questionEl.textContent.trim();
      if (!text || text === lastQuestionText) return;
      lastQuestionText = text;
      translate();
    }, 400);
  }

  function startObserver() {
    const observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  if (isQuestionFrame()) {
    translate();
    startObserver();
  } else {
    // Not the question frame — watch in case the question is injected later
    const waitObserver = new MutationObserver(() => {
      if (isQuestionFrame()) {
        waitObserver.disconnect();
        translate();
        startObserver();
      }
    });
    waitObserver.observe(document.body || document.documentElement,
      { childList: true, subtree: true });
  }
})();
