// TheorieTestHelper — content script (runs in all frames)
//
// QUESTION FRAME role: parse the DOM, call background.js for translation,
//   post results up to the parent frame via postMessage.
//
// PARENT FRAME role: listen for postMessages from the question iframe,
//   inject and manage the translation panel in the parent DOM (outside the iframe).

(function () {
  "use strict";

  const SEL_QUESTION       = "#app_TestingPage_CoreTestingDisplay_t24qtext";
  const SEL_ANSWERS        = "[id$='_answertext']";
  const SEL_ANSWER_STEM    = "#app_TestingPage_CoreTestingDisplay_t24qhint1";
  const SEL_QUESTION_IMAGE = "#app_TestingPage_CoreTestingDisplay_t24qpic img";
  // Solution/explanation text shown after clicking Auflösung — selector TBD, tries multiple candidates
  const SEL_SOLUTION_CANDIDATES = [
    "#app_TestingPage_CoreTestingDisplay_t24qhint2",
    "#app_TestingPage_CoreTestingDisplay_t24solution",
    "#app_TestingPage_CoreTestingDisplay_t24qerkl",
    "[id*='solution']:not([id*='btn']):not([id*='button'])",
    "[id*='erkl']:not([id*='btn'])",
  ];
  const MSG_PREFIX   = "tth-";

  // ── Utilities ─────────────────────────────────────────────────────────────

  function isQuestionFrame() {
    return !!document.querySelector(SEL_QUESTION);
  }

  function isTopFrame() {
    return window.parent === window;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PARENT FRAME — Shadow DOM panel (immune to page CSS)
  // ══════════════════════════════════════════════════════════════════════════

  let _shadow = null;
  let _questionFrameWindow = null;
  let _lastTranslation = null;
  let _chatHistory = [];      // [{role, content}, …]
  let _chatContext  = "";     // system-message text built from current question
  let _chatModel   = "gpt-4o-mini"; // escalates to "gpt-4o" when user tags @gpt4o

  function getShadow() {
    if (_shadow) return _shadow;

    const host = document.createElement("div");
    host.id = "tth-host";
    host.style.cssText = "all:initial;position:fixed;bottom:0;right:0;z-index:2147483647;";
    document.body.appendChild(host);

    _shadow = host.attachShadow({ mode: "open" });

    _shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        #tth-toggle {
          display: block;
          background: #3b82f6;
          color: #fff;
          border: none;
          border-radius: 6px 6px 0 0;
          padding: 6px 14px;
          font: 600 12px/1 system-ui, sans-serif;
          cursor: pointer;
          letter-spacing: .4px;
        }
        #tth-sidebar {
          display: none;
          flex-direction: column;
          width: 500px;
          max-width: calc(100vw - 24px);
          height: 420px;
          background: #fff;
          border: 2px solid #3b82f6;
          border-radius: 8px 8px 0 0;
          box-shadow: 0 4px 20px rgba(0,0,0,.25);
          overflow: clip;
          font: 14px/1.4 system-ui, sans-serif;
          color: #1f2937;
        }
        #tth-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: #3b82f6;
          color: #fff;
          padding: 7px 14px;
          flex-shrink: 0;
        }
        #tth-title { font: 600 13px/1 system-ui, sans-serif; color: #fff; }
        #tth-close { background: none; border: none; color: #fff; cursor: pointer; font-size: 16px; opacity: .85; }
        #tth-body {
          flex: 1;
          overflow-y: auto;
          padding: 10px 14px;
          display: flex;
          flex-direction: row;
          gap: 16px;
          align-items: flex-start;
          background: #fff;
          min-height: 0;
          color: #1f2937;
        }
        #tth-spinner {
          color: #6b7280;
          font-style: italic;
          align-self: center;
          width: 100%;
          text-align: center;
          font-size: 13px;
        }
        #tth-content {
          display: none;
          flex: 1;
          flex-direction: row;
          gap: 14px;
          min-width: 0;
          overflow: hidden;
          height: 100%;
        }
        #tth-error {
          display: none;
          color: #dc2626;
          background: #fef2f2;
          border: 1px solid #fecaca;
          border-radius: 6px;
          padding: 8px 10px;
          font-size: 12px;
          line-height: 1.5;
          width: 100%;
        }
        #tth-question {
          flex: 0 0 38%;
          padding-right: 14px;
          border-right: 1px solid #e5e7eb;
          overflow-y: auto;
          font: 500 13px/1.5 system-ui, sans-serif;
          color: #1f2937;
          margin: 0;
        }
        #tth-answers {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
          flex: 1;
          overflow-y: auto;
        }
        #tth-answers li {
          background: #f3f4f6;
          border: 1px solid #e5e7eb;
          border-radius: 5px;
          padding: 5px 9px;
          font: 12px/1.4 system-ui, sans-serif;
          color: #1f2937;
        }
        .ans-label { font-weight: 700; color: #3b82f6; margin-right: 4px; }
        #tth-answers li { cursor: pointer; }
        #tth-answers li:hover { background: #e0e7ff; border-color: #a5b4fc; }
        #tth-answers li.tth-checked { background: #dcfce7; border-color: #86efac; }
        .tth-ans-cb { margin-right: 6px; pointer-events: none; }
        #tth-action-btns { display: flex; gap: 6px; margin-top: 6px; }
        .tth-action-btn { border: none; border-radius: 5px; padding: 5px 10px; font: 600 12px/1 system-ui, sans-serif; cursor: pointer; }
        #tth-cancel-btn { background: #ef4444; color: #fff; }
        #tth-mark-btn { background: #f59e0b; color: #fff; }
        #tth-solution-btn { background: #22c55e; color: #fff; }
        #tth-solution {
          display: none; padding: 8px 14px; background: #f0fdf4;
          border-top: 1px solid #86efac; font: 12px/1.5 system-ui, sans-serif;
          color: #166534; flex-shrink: 0; overflow-y: auto; max-height: 120px;
        }
        #tth-explanation {
          display: none; padding: 8px 14px; background: #eff6ff;
          border-top: 1px solid #bfdbfe; font: 12px/1.5 system-ui, sans-serif;
          color: #1e40af; flex-shrink: 0; overflow-y: auto; max-height: 120px;
        }
        #tth-footer {
          display: none;
          border-top: 1px solid #e5e7eb;
          padding: 8px 14px;
          background: #f9fafb;
          flex-shrink: 0;
          gap: 8px;
        }
        .tth-ask-btn {
          background: #3b82f6;
          color: #fff;
          border: none;
          border-radius: 5px;
          padding: 5px 12px;
          font: 600 12px/1 system-ui, sans-serif;
          cursor: pointer;
        }
        .tth-ask-btn:disabled { opacity: .6; cursor: default; }
        /* ── Chat view ── */
        #tth-chat {
          display: none;
          flex-direction: column;
          flex: 1;
          min-height: 0;
        }
        #tth-chat-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 5px 14px;
          background: #eff6ff;
          border-bottom: 1px solid #bfdbfe;
          flex-shrink: 0;
        }
        #tth-back-btn {
          background: none;
          border: none;
          color: #3b82f6;
          font: 600 12px/1 system-ui, sans-serif;
          cursor: pointer;
          padding: 0;
        }
        #tth-chat-label {
          font: 600 12px/1 system-ui, sans-serif;
          color: #1e40af;
        }
        #tth-chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 10px 14px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-height: 0;
        }
        .tth-msg {
          max-width: 88%;
          border-radius: 10px;
          padding: 7px 11px;
          font: 12px/1.5 system-ui, sans-serif;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .tth-msg-user {
          align-self: flex-end;
          background: #3b82f6;
          color: #fff;
          border-bottom-right-radius: 3px;
        }
        .tth-msg-ai {
          align-self: flex-start;
          background: #f3f4f6;
          color: #1f2937;
          border-bottom-left-radius: 3px;
        }
        .tth-msg-ai2 {
          align-self: flex-start;
          background: #f0fdf4;
          color: #14532d;
          border: 1px solid #bbf7d0;
          border-bottom-left-radius: 3px;
        }
        .tth-msg-ai2::before {
          content: "gpt-4o · ";
          font-weight: 700;
          opacity: .6;
        }
        .tth-msg-thinking {
          align-self: flex-start;
          background: #f3f4f6;
          color: #9ca3af;
          font-style: italic;
          border-bottom-left-radius: 3px;
        }
        .tth-msg-context {
          align-self: stretch;
          background: #eff6ff;
          border: 1px solid #bfdbfe;
          color: #1e3a5f;
          border-radius: 6px;
          font-size: 12px;
          line-height: 1.6;
          max-width: 100%;
        }
        .tth-msg-context .ctx-question {
          font-weight: 600;
          margin-bottom: 4px;
          display: block;
        }
        .tth-msg-context .ctx-answer { display: block; }
        .tth-msg-context .ctx-label { font-weight: 700; margin-right: 4px; }
        #tth-chat-quick {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          padding: 6px 14px 0;
          flex-shrink: 0;
        }
        .tth-quick-btn {
          background: #f3f4f6;
          color: #374151;
          border: 1px solid #d1d5db;
          border-radius: 12px;
          padding: 3px 10px;
          font: 11px/1.4 system-ui, sans-serif;
          cursor: pointer;
        }
        .tth-quick-btn:hover { background: #e5e7eb; }
        .tth-quick-btn:disabled { opacity: .5; cursor: default; }
        #tth-chat-input-row {
          display: flex;
          gap: 6px;
          padding: 8px 14px;
          border-top: 1px solid #e5e7eb;
          flex-shrink: 0;
          background: #fff;
        }
        #tth-chat-input {
          flex: 1;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          padding: 6px 10px;
          font: 13px/1 system-ui, sans-serif;
          color: #1f2937;
          outline: none;
        }
        #tth-chat-input:focus { border-color: #3b82f6; }
        #tth-chat-send {
          background: #3b82f6;
          color: #fff;
          border: none;
          border-radius: 6px;
          padding: 6px 14px;
          font: 600 12px/1 system-ui, sans-serif;
          cursor: pointer;
          flex-shrink: 0;
        }
        #tth-chat-send:disabled { opacity: .5; cursor: default; }
        /* ── Cards button ── */
        #tth-cards-btn {
          background: rgba(255,255,255,.2); border: 1px solid rgba(255,255,255,.5);
          color: #fff; border-radius: 4px; padding: 2px 8px;
          font: 600 11px/1 system-ui; cursor: pointer;
          margin-left: auto; margin-right: 8px;
        }
        /* ── Flashcard panel ── */
        #tth-flashcards {
          display: none; flex-direction: column; flex: 1; min-height: 0;
        }
        #tth-fc-bar {
          display: flex; align-items: center; gap: 8px; padding: 5px 14px;
          background: #eff6ff; border-bottom: 1px solid #bfdbfe; flex-shrink: 0;
        }
        #tth-fc-back {
          background: none; border: none; color: #3b82f6;
          font: 600 12px/1 system-ui; cursor: pointer; padding: 0;
        }
        #tth-fc-label { font: 600 12px/1 system-ui; color: #1e40af; }
        #tth-fc-list {
          flex: 1; overflow-y: auto; padding: 10px 14px;
          display: flex; flex-direction: column; gap: 6px;
        }
        .tth-fc-row {
          display: flex; align-items: center; gap: 8px;
          background: #f3f4f6; border: 1px solid #e5e7eb;
          border-radius: 5px; padding: 5px 9px;
          font: 12px/1.4 system-ui;
        }
        .tth-fc-de { font-weight: 700; color: #1f2937; }
        .tth-fc-en { color: #6b7280; flex: 1; }
        .tth-fc-del {
          background: none; border: none; color: #dc2626;
          font-size: 14px; cursor: pointer; padding: 0 2px; flex-shrink: 0;
        }
        .tth-fc-empty { color: #9ca3af; font-style: italic; font-size: 13px; text-align: center; padding-top: 20px; }
        #tth-fc-search-row {
          padding: 6px 14px; flex-shrink: 0; border-bottom: 1px solid #e5e7eb;
        }
        #tth-fc-search {
          width: 100%; box-sizing: border-box; padding: 4px 8px;
          border: 1px solid #d1d5db; border-radius: 4px;
          font: 12px/1.4 system-ui; outline: none;
        }
        #tth-fc-search:focus { border-color: #3b82f6; }
      </style>
      <button id="tth-toggle">EN ▲</button>
      <div id="tth-sidebar">
        <div id="tth-header">
          <span id="tth-title">TheorieTestHelper</span>
          <button id="tth-cards-btn">Cards</button>
          <button id="tth-close">▼</button>
        </div>
        <div id="tth-body">
          <div id="tth-spinner">Translating…</div>
          <div id="tth-content"></div>
          <div id="tth-error"></div>
        </div>
        <div id="tth-footer">
          <button id="tth-ask-ai" class="tth-ask-btn">Ask the AI</button>
          <div id="tth-action-btns" style="display:none">
            <button id="tth-cancel-btn" class="tth-action-btn">Cancel</button>
            <button id="tth-mark-btn" class="tth-action-btn">★</button>
            <button id="tth-solution-btn" class="tth-action-btn">Show Solution</button>
          </div>
        </div>
        <div id="tth-solution"></div>
        <div id="tth-explanation"></div>
        <div id="tth-chat">
          <div id="tth-chat-bar">
            <button id="tth-back-btn">← Back</button>
            <span id="tth-chat-label">Chat with AI</span>
          </div>
          <div id="tth-chat-messages"></div>
          <div id="tth-chat-quick">
            <button class="tth-quick-btn" id="tth-quick-en">Ask in English</button>
            <button class="tth-quick-btn" id="tth-quick-de">Auf Deutsch fragen</button>
          </div>
          <div id="tth-chat-input-row">
            <input id="tth-chat-input" type="text" placeholder="Ask a follow-up… (or add @gpt4o)">
            <button id="tth-chat-send">Send</button>
          </div>
        </div>
        <div id="tth-flashcards">
          <div id="tth-fc-bar">
            <button id="tth-fc-back">← Back</button>
            <span id="tth-fc-label">Flashcards</span>
          </div>
          <div id="tth-fc-search-row">
            <input id="tth-fc-search" type="search" placeholder="Search German or English…">
          </div>
          <div id="tth-fc-list"></div>
        </div>
      </div>
    `;

    const toggle = _shadow.getElementById("tth-toggle");
    const panel  = _shadow.getElementById("tth-sidebar");

    const openPanel  = () => { panel.style.display = "flex"; toggle.textContent = "EN ▼"; };
    const closePanel = () => { panel.style.display = "none"; toggle.textContent = "EN ▲"; };

    toggle.addEventListener("click", () =>
      panel.style.display === "none" ? openPanel() : closePanel()
    );
    _shadow.getElementById("tth-close").addEventListener("click", closePanel);

    // ── Chat helpers ────────────────────────────────────────────────────────

    function appendMsg(role, text) {
      const s = _shadow;
      const msgs = s.getElementById("tth-chat-messages");
      const div = document.createElement("div");
      div.className = "tth-msg tth-msg-" + role;
      div.textContent = text;
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
      return div;
    }

    function setChatInputBusy(busy) {
      _shadow.getElementById("tth-chat-input").disabled = busy;
      _shadow.getElementById("tth-chat-send").disabled = busy;
      _shadow.getElementById("tth-quick-en").disabled = busy;
      _shadow.getElementById("tth-quick-de").disabled = busy;
    }

    function openChat() {
      if (!_lastTranslation) return;
      const { question, answers } = _lastTranslation;
      _chatHistory = [];
      _chatModel = "gpt-4o-mini";
      _chatContext = `You are a German driving theory expert helping a student.
Question: ${question}
Answer options:
${answers.map((a, i) => `${String.fromCharCode(65 + i)}. ${a}`).join("\n")}
One or more answers may be correct; at least one is always correct. Base your answers on the German traffic manual (Straßenverkehrs-Ordnung and Fahrschule guidelines). Be concise. If the user tells you your answer is wrong, trust them and revise your explanation accordingly. Respond in whatever language the user writes in.
In your very first response, start with either "I can see the image." or "I don't see an image." on its own line. Then on a new line add exactly: "Tip: add @gpt4o to any message to escalate to GPT-4o."`;

      // Switch views
      _shadow.getElementById("tth-body").style.display = "none";
      _shadow.getElementById("tth-footer").style.display = "none";
      const msgs = _shadow.getElementById("tth-chat-messages");
      msgs.innerHTML = "";

      // Render the translation as a pinned context card at the top of the chat
      const card = document.createElement("div");
      card.className = "tth-msg tth-msg-context";
      card.innerHTML =
        `<span class="ctx-question">${escapeHtml(question)}</span>` +
        answers.map((a, i) =>
          `<span class="ctx-answer"><span class="ctx-label">${String.fromCharCode(65 + i)}.</span>${escapeHtml(a)}</span>`
        ).join("");
      msgs.appendChild(card);

      _shadow.getElementById("tth-chat").style.display = "flex";
      _shadow.getElementById("tth-chat-input").value = "";
      _shadow.getElementById("tth-chat-input").focus();
    }

    function closeChat() {
      _shadow.getElementById("tth-chat").style.display = "none";
      _shadow.getElementById("tth-body").style.display = "flex";
      if (_lastTranslation) _shadow.getElementById("tth-footer").style.display = "block";
      _chatHistory = [];
    }

    function dispatchChatMessage(text) {
      if (/@gpt4o/i.test(text) && _chatModel !== "gpt-4o") {
    _chatModel = "gpt-4o";
    _chatHistory = []; // start fresh so GPT-4o focuses on the current question
  }
      const contentText = text.replace(/@gpt4o/gi, "").trim() || text;
      appendMsg("user", text);
      _chatHistory.push({ role: "user", content: contentText });
      setChatInputBusy(true);
      const thinking = appendMsg("thinking", _chatModel === "gpt-4o" ? "Thinking (GPT-4o)…" : "Thinking…");
      chrome.runtime.sendMessage(
        { type: "chat", systemContext: _chatContext, history: _chatHistory,
          imageBase64: _lastTranslation?.imageBase64, model: _chatModel },
        (response) => {
          thinking.remove();
          setChatInputBusy(false);
          const bubbleClass = _chatModel === "gpt-4o" ? "ai2" : "ai";
          if (chrome.runtime.lastError || response?.error) {
            appendMsg(bubbleClass, "Error: " + (response?.error || chrome.runtime.lastError.message));
          } else {
            const reply = response.reply || "";
            appendMsg(bubbleClass, reply);
            _chatHistory.push({ role: "assistant", content: reply });
          }
          _shadow.getElementById("tth-chat-input").focus();
        }
      );
    }

    _shadow.getElementById("tth-ask-ai").addEventListener("click", () => openChat());
    _shadow.getElementById("tth-back-btn").addEventListener("click", closeChat);
    _shadow.getElementById("tth-quick-en").addEventListener("click", () =>
      dispatchChatMessage("Which answer(s) are correct, and why?"));
    _shadow.getElementById("tth-quick-de").addEventListener("click", () =>
      dispatchChatMessage("Welche Antwort(en) sind richtig, und warum?"));

    // ── Flashcard panel ─────────────────────────────────────────────────────

    function openFlashcards() {
      _shadow.getElementById("tth-body").style.display = "none";
      _shadow.getElementById("tth-footer").style.display = "none";
      _shadow.getElementById("tth-chat").style.display = "none";
      _shadow.getElementById("tth-flashcards").style.display = "flex";
      _shadow.getElementById("tth-fc-search").value = "";
      renderFlashcards();
    }

    function closeFlashcards() {
      _shadow.getElementById("tth-flashcards").style.display = "none";
      _shadow.getElementById("tth-body").style.display = "flex";
      if (_lastTranslation) _shadow.getElementById("tth-footer").style.display = "block";
    }

    function renderFlashcards() {
      const list = _shadow.getElementById("tth-fc-list");
      const query = (_shadow.getElementById("tth-fc-search").value || "").trim().toLowerCase();
      list.innerHTML = "";
      chrome.runtime.sendMessage({ type: "get-flashcards" }, (res) => {
        const allCards = res?.flashcards || [];
        const cards = query
          ? allCards.filter(({ german, english }) =>
              german.toLowerCase().includes(query) || english.toLowerCase().includes(query))
          : allCards;
        if (!allCards.length) {
          list.innerHTML = '<div class="tth-fc-empty">No flashcards yet.<br>Click a German word on the page to add one.</div>';
          return;
        }
        if (!cards.length) {
          list.innerHTML = '<div class="tth-fc-empty">No matches.</div>';
          return;
        }
        cards.forEach(({ german, english }) => {
          const row = document.createElement("div");
          row.className = "tth-fc-row";
          row.innerHTML = `<span class="tth-fc-de">${escapeHtml(german)}</span><span class="tth-fc-en">${escapeHtml(english)}</span><button class="tth-fc-del" title="Remove">✕</button>`;
          row.querySelector(".tth-fc-del").addEventListener("click", () => {
            chrome.runtime.sendMessage({ type: "remove-flashcard", german }, () => renderFlashcards());
          });
          list.appendChild(row);
        });
      });
    }

    _shadow.getElementById("tth-cards-btn").addEventListener("click", openFlashcards);
    _shadow.getElementById("tth-fc-back").addEventListener("click", closeFlashcards);
    _shadow.getElementById("tth-fc-search").addEventListener("input", renderFlashcards);

    const inputEl = _shadow.getElementById("tth-chat-input");
    const sendBtn = _shadow.getElementById("tth-chat-send");
    function submitInput() {
      const text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = "";
      dispatchChatMessage(text);
    }
    sendBtn.addEventListener("click", submitInput);
    inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") submitInput(); });

    return _shadow;
  }

  function showSpinner() {
    const s = getShadow();
    s.getElementById("tth-sidebar").style.display = "flex";
    s.getElementById("tth-toggle").textContent = "EN ▼";
    s.getElementById("tth-chat").style.display = "none";
    s.getElementById("tth-body").style.display = "flex";
    s.getElementById("tth-spinner").style.display = "block";
    s.getElementById("tth-content").style.display = "none";
    s.getElementById("tth-error").style.display = "none";
    s.getElementById("tth-footer").style.display = "none";
  }

  function showTranslation(question, answers, imageBase64) {
    const s = getShadow();
    s.getElementById("tth-spinner").style.display = "none";
    s.getElementById("tth-error").style.display = "none";
    s.getElementById("tth-solution").style.display = "none";
    s.getElementById("tth-explanation").style.display = "none";
    // Show footer with Ask button only for MC questions; reset any prior ask result
    const footer = s.getElementById("tth-footer");
    // Close chat if open (new question arrived)
    s.getElementById("tth-chat").style.display = "none";
    s.getElementById("tth-body").style.display = "flex";
    if (answers.length) {
      _lastTranslation = { question, answers, imageBase64 };
      _chatHistory = [];
      footer.style.display = "block";
    } else {
      _lastTranslation = null;
      footer.style.display = "none";
    }
    const content = s.getElementById("tth-content");
    if (answers.length) {
      const answersHtml = answers
        .map((a, i) => `<li data-idx="${i}"><input type="checkbox" class="tth-ans-cb"><span class="ans-label">${String.fromCharCode(65 + i)}.</span>${escapeHtml(a)}</li>`)
        .join("");
      content.innerHTML = `<p id="tth-question">${escapeHtml(question)}</p><ul id="tth-answers">${answersHtml}</ul>`;
      s.getElementById("tth-action-btns").style.display = "flex";
    } else {
      content.innerHTML = `<p id="tth-question" style="flex:1;border-right:none;">${escapeHtml(question)}</p>
                           <p id="tth-numeric-note" style="font-style:italic;color:#6b7280;font-size:12px;align-self:center;">(numeric answer)</p>`;
      s.getElementById("tth-action-btns").style.display = "none";
    }
    content.style.display = "flex";
  }

  function showInfo(msg) {
    const s = getShadow();
    s.getElementById("tth-sidebar").style.display = "flex";
    s.getElementById("tth-toggle").textContent = "EN ▼";
    s.getElementById("tth-chat").style.display = "none";
    s.getElementById("tth-body").style.display = "flex";
    s.getElementById("tth-spinner").style.display = "none";
    s.getElementById("tth-content").style.display = "none";
    s.getElementById("tth-footer").style.display = "none";
    const err = s.getElementById("tth-error");
    err.style.cssText = "display:block;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:8px 10px;font-size:12px;line-height:1.5;width:100%;";
    err.textContent = msg;
  }

  function showError(msg) {
    const s = getShadow();
    s.getElementById("tth-spinner").style.display = "none";
    s.getElementById("tth-content").style.display = "none";
    s.getElementById("tth-footer").style.display = "none";
    const err = s.getElementById("tth-error");
    err.textContent = msg;
    err.style.display = "block";
  }

  const PANEL_W = 514;

  function pushContentLeft() {
    function applyShift() {
      // Walk every element in body; shift anything that is centered via fixed/absolute
      const allEls = [document.documentElement, document.body,
                      ...document.body.querySelectorAll("*")];
      for (const el of allEls) {
        if (!el || el.closest?.("#tth-host")) continue;
        const cs = window.getComputedStyle(el);
        const pos = cs.position;
        if (pos === "fixed" || pos === "absolute") {
          const rect = el.getBoundingClientRect();
          if (rect.width < 100) continue; // skip tiny elements (icons, tooltips)
          const centerX = rect.left + rect.width / 2;
          const viewMid = window.innerWidth / 2;
          if (Math.abs(centerX - viewMid) < viewMid * 0.25) {
            // This element is roughly horizontally centered — push it left
            el.style.setProperty("left", "0", "important");
            el.style.setProperty("right", PANEL_W + "px", "important");
            el.style.setProperty("width", "auto", "important");
            el.style.setProperty("transform", "none", "important");
          }
        } else if (pos === "static" || pos === "relative") {
          const rect = el.getBoundingClientRect();
          if (rect.width > window.innerWidth * 0.5 && el !== document.documentElement) {
            el.style.setProperty("margin-left", "0", "important");
            el.style.setProperty("margin-right", PANEL_W + "px", "important");
            el.style.setProperty("max-width", `calc(100vw - ${PANEL_W}px)`, "important");
            el.style.setProperty("box-sizing", "border-box", "important");
          }
        }
      }
    }
    applyShift();
    setTimeout(applyShift, 500);
    setTimeout(applyShift, 1500);
  }

  function minimizePanel() {
    if (!_shadow) return;
    _shadow.getElementById("tth-sidebar").style.display = "none";
    _shadow.getElementById("tth-toggle").textContent = "EN ▲";
  }

  function postToQuestionFrame(msg) {
    if (_questionFrameWindow) {
      try { _questionFrameWindow.postMessage(msg, "*"); return; } catch(_) {}
    }
    // Fallback: broadcast to all iframes
    document.querySelectorAll("iframe").forEach(f => {
      try { f.contentWindow.postMessage(msg, "*"); } catch(_) {}
    });
  }

  function updateEnglishCheckboxes(states) {
    const s = getShadow();
    s.querySelectorAll("#tth-answers li[data-idx]").forEach(li => {
      const checked = !!states[+li.dataset.idx];
      li.querySelector(".tth-ans-cb").checked = checked;
      li.classList.toggle("tth-checked", checked);
    });
  }

  function showSolutionTranslation(germanText) {
    const s = getShadow();
    const el = s.getElementById("tth-solution");
    el.style.display = "block";
    el.textContent = "Translating solution…";
    chrome.runtime.sendMessage({ type: "translate-solution", text: germanText }, resp => {
      if (chrome.runtime.lastError || resp?.error) {
        el.textContent = "(Could not translate solution)";
      } else {
        el.textContent = "💡 " + (resp.solution ?? germanText);
      }
    });
  }

  function showExplanationTranslation(germanText) {
    const s = getShadow();
    const el = s.getElementById("tth-explanation");
    el.style.display = "block";
    el.textContent = "Translating explanation…";
    chrome.runtime.sendMessage({ type: "translate-solution", text: germanText }, resp => {
      if (!el.isConnected) return;
      if (chrome.runtime.lastError || resp?.error) {
        el.textContent = "(Could not translate explanation)";
      } else {
        el.textContent = "📖 " + (resp.solution ?? germanText);
      }
    });
  }

  function initParentFrame() {
    pushContentLeft();
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data?.type?.startsWith(MSG_PREFIX)) return;
      _questionFrameWindow = event.source;
      switch (data.type) {
        case "tth-spinner":     showSpinner(); break;
        case "tth-translation": showTranslation(data.question, data.answers, data.imageBase64); break;
        case "tth-info":        showInfo(data.message); break;
        case "tth-error":       showError(data.message); break;
        case "tth-minimize":    minimizePanel(); break;
        case "tth-check-state":   updateEnglishCheckboxes(data.states); break;
        case "tth-solution-text": showSolutionTranslation(data.text); break;
        case "tth-explanation":   showExplanationTranslation(data.text); break;
        case "tth-btn-label":
          s.getElementById("tth-solution-btn").textContent =
            data.label === "next" ? "Next Question" : "Show Solution";
          break;
      }
    });

    const s = getShadow();
    s.getElementById("tth-body").addEventListener("click", e => {
      const li = e.target.closest("li[data-idx]");
      if (!li) return;
      const idx = +li.dataset.idx;
      // Optimistic toggle
      const cb = li.querySelector(".tth-ans-cb");
      const nowChecked = !cb.checked;
      cb.checked = nowChecked;
      li.classList.toggle("tth-checked", nowChecked);
      postToQuestionFrame({ type: "tth-cmd", action: "click-answer", index: idx });
    });
    s.getElementById("tth-cancel-btn").addEventListener("click", () => {
      postToQuestionFrame({ type: "tth-cmd", action: "abbrechen" });
    });
    s.getElementById("tth-mark-btn").addEventListener("click", () => {
      postToQuestionFrame({ type: "tth-cmd", action: "markieren" });
    });
    s.getElementById("tth-solution-btn").addEventListener("click", () => {
      postToQuestionFrame({ type: "tth-cmd", action: "aufloesung" });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // QUESTION FRAME — DOM parsing + translation
  // ══════════════════════════════════════════════════════════════════════════

  function postToParent(msg) {
    window.parent.postMessage(msg, "*");
  }

  async function captureVisual() {
    // Photo question
    const img = document.querySelector(SEL_QUESTION_IMAGE);
    console.log("[TTH] captureVisual img:", img, "complete:", img?.complete, "naturalWidth:", img?.naturalWidth, "src:", img?.src);
    if (img && img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width > 0) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        const b64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
        console.log("[TTH] captureVisual: canvas success, b64 length:", b64?.length);
        return b64;
      } catch (e) {
        // Canvas tainted (cross-origin) — take a tab screenshot instead
        console.log("[TTH] captureVisual: canvas tainted, requesting tab screenshot");
        const res = await Promise.race([
          new Promise(resolve => chrome.runtime.sendMessage({ type: "capture-tab" }, resolve)),
          new Promise(resolve => setTimeout(() => resolve(null), 5000)),
        ]);
        return res?.dataUrl || null;
      }
    }
    console.log("[TTH] captureVisual: no image found or not loaded");
    // Video question — capture last frame
    const video = document.querySelector("video");
    if (video && video.videoWidth > 0) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
      } catch (e) {
        console.log("[TTH] captureVisual: video canvas tainted, requesting tab screenshot");
        const res = await Promise.race([
          new Promise(resolve => chrome.runtime.sendMessage({ type: "capture-tab" }, resolve)),
          new Promise(resolve => setTimeout(() => resolve(null), 5000)),
        ]);
        return res?.dataUrl || null;
      }
    }
    return null;
  }

  function parseQuestion() {
    const questionEl = document.querySelector(SEL_QUESTION);
    if (!questionEl) return null;
    const questionText = questionEl.textContent.trim();
    if (!questionText || questionText === "Fragentext?") return null;
    const answerEls = document.querySelectorAll(SEL_ANSWERS);
    const stemEl = document.querySelector(SEL_ANSWER_STEM);
    const stem = stemEl?.textContent.trim() || "";
    return {
      question: questionText,
      answers: Array.from(answerEls)
        .filter(el => {
          if (el.hidden) return false;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
          if (el.getBoundingClientRect().height === 0) return false;
          return true;
        })
        .map(el => el.textContent.trim())
        .filter(Boolean)
        .map(a => stem ? stem + " " + a : a),
      // answers may be empty — that's OK for numeric questions
    };
  }

  const MAX_RETRIES = 6;

  // Video questions show an instruction to watch the film before the real question appears.
  // Detect this so we don't burn an API call on the instruction text.
  function isVideoInstruction(text) {
    return /bitte starten sie den film|video starten|film starten/i.test(text);
  }

  async function translate() {
    const seq = ++_translateSeq;
    postToParent({ type: "tth-spinner" });
    try {
      // Wait for the question text itself
      let parsed = null;
      for (let i = 0; i < MAX_RETRIES; i++) {
        parsed = parseQuestion();
        if (parsed) break;
        await new Promise(r => setTimeout(r, 500));
      }

      if (!parsed) {
        postToParent({ type: "tth-error", message: "Could not find question in the page DOM." });
        return;
      }

      if (isVideoInstruction(parsed.question)) {
        postToParent({ type: "tth-info", message: "Watch the video — the question will appear automatically once it loads." });
        return;
      }

      // If no answers yet, wait briefly to see if they appear (multiple-choice loads async)
      // but don't wait forever — numeric questions have no answers at all.
      // Snapshot existing answer elements first — they may be leftovers from the previous question.
      if (!parsed.answers.length) {
        const preWaitEls = new Set(Array.from(document.querySelectorAll(SEL_ANSWERS)));
        await new Promise(r => setTimeout(r, 800));
        const reParsed = parseQuestion();
        if (reParsed?.answers.length > 0) {
          // Only accept answers if at least one element is NEW (not a pre-existing leftover)
          const hasNewEl = Array.from(document.querySelectorAll(SEL_ANSWERS)).some(el => !preWaitEls.has(el));
          if (hasNewEl) parsed = reParsed;
        }
      }

      const imageBase64 = await captureVisual();

      _lastGerman = { question: parsed.question, answers: parsed.answers };
      _lastEnglish = null;

      chrome.runtime.sendMessage(
        { type: "translate", question: parsed.question, answers: parsed.answers, imageBase64 },
        (response) => {
          if (seq !== _translateSeq) return;
          if (chrome.runtime.lastError) {
            postToParent({ type: "tth-error", message: "Extension error: " + chrome.runtime.lastError.message });
            return;
          }
          if (response?.error) {
            postToParent({ type: "tth-error", message: "Translation error: " + response.error });
            return;
          }
          _lastEnglish = { question: response.question, answers: response.answers };
          _wordGlossary = response.glossary || {};
          postToParent({ type: "tth-translation", question: response.question, answers: response.answers, imageBase64 });
        }
      );
    } catch (err) {
      if (seq === _translateSeq) {
        postToParent({ type: "tth-error", message: "Unexpected error: " + err.message });
      }
    }
  }

  let debounceTimer = null;
  let minimizeTimer = null;
  let lastQuestionText = null;
  let _translateSeq = 0;     // incremented on each translate() call; guards stale callbacks
  let _lastGerman  = null;   // { question, answers } — raw German text from last parse
  let _lastEnglish = null;   // { question, answers } — English translation of same question
  let _wordGlossary = {};    // { GermanWord: "English meaning" } from last translation

  function onMutation() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const el = document.querySelector(SEL_QUESTION);
      if (!el) {
        minimizeTimer = minimizeTimer || setTimeout(() => {
          postToParent({ type: "tth-minimize" });
          minimizeTimer = null;
        }, 2000);
        return;
      }
      clearTimeout(minimizeTimer);
      minimizeTimer = null;
      const text = el.textContent.trim();
      if (!text || text === "Fragentext?") return;
      if (text === lastQuestionText && !isVideoInstruction(text)) return;
      lastQuestionText = text;
      translate();
    }, 400);
  }

  function startObserver() {
    const observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ── Word-click tooltip ──────────────────────────────────────────────────

  function injectTooltipStyles() {
    if (document.getElementById("tth-tooltip-style")) return;
    const s = document.createElement("style");
    s.id = "tth-tooltip-style";
    s.textContent = `
      #tth-word-tooltip {
        position: fixed; z-index: 2147483647;
        background: #fff; border: 1px solid #3b82f6; border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,.2);
        padding: 10px 14px; min-width: 160px; max-width: 260px;
        font: 13px/1.4 system-ui, sans-serif; color: #1f2937;
      }
      #tth-word-tooltip .ttw-word  { font-weight: 700; font-size: 14px; display: block; margin-bottom: 4px; }
      #tth-word-tooltip .ttw-trans {
        display: block; width: 100%; margin-bottom: 10px; box-sizing: border-box;
        border: 1px solid #d1d5db; border-radius: 4px; padding: 3px 6px;
        font: 13px/1.4 system-ui, sans-serif; color: #374151;
      }
      #tth-word-tooltip .ttw-trans:disabled {
        background: transparent; border-color: transparent; color: #6b7280; padding-left: 0;
      }
      #tth-word-tooltip .ttw-add   {
        background: #3b82f6; color: #fff; border: none; border-radius: 5px;
        padding: 4px 10px; font: 600 12px/1 system-ui; cursor: pointer;
      }
      #tth-word-tooltip .ttw-add:disabled { opacity:.6; cursor:default; }
      #tth-word-tooltip .ttw-close {
        position: absolute; top: 6px; right: 8px;
        background: none; border: none; color: #9ca3af; font-size: 14px; cursor: pointer;
      }
    `;
    document.head.appendChild(s);
  }

  function wordAt(x, y) {
    const range = document.caretRangeFromPoint(x, y);
    if (!range) return "";
    if (range.startContainer?.parentElement?.closest("button, input, select, textarea, a, img, video")) return "";
    try { range.expand("word"); } catch (e) { return ""; }
    return range.toString().replace(/[^A-Za-zÄÖÜäöüß\-]/g, "").trim();
  }

  function removeWordTooltip() {
    document.getElementById("tth-word-tooltip")?.remove();
  }

  function showWordTooltip(word, x, y) {
    removeWordTooltip();
    injectTooltipStyles();
    const tip = document.createElement("div");
    tip.id = "tth-word-tooltip";
    tip.innerHTML = `
      <button class="ttw-close">✕</button>
      <span class="ttw-word">${word.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</span>
      <input class="ttw-trans" type="text" placeholder="Translating…" disabled>
      <button class="ttw-add" disabled>Add to flashcards</button>
    `;
    const vw = window.innerWidth, vh = window.innerHeight;
    tip.style.left = Math.min(x + 12, vw - 280) + "px";
    tip.style.top  = Math.min(y + 12, vh - 120) + "px";
    document.body.appendChild(tip);

    tip.querySelector(".ttw-close").addEventListener("click", removeWordTooltip);

    // Find the German sentence containing the word and its English equivalent
    let germanContext = null, englishContext = null;
    if (_lastGerman) {
      const parts = [_lastGerman.question, ..._lastGerman.answers];
      const idx = parts.findIndex(p => p.toLowerCase().includes(word.toLowerCase()));
      if (idx >= 0) {
        germanContext = parts[idx];
        const englishParts = _lastEnglish ? [_lastEnglish.question, ..._lastEnglish.answers] : [];
        englishContext = englishParts[idx] || null;
      }
    }

    // Glossary lookup first — instant, no API call
    const glossaryKey = Object.keys(_wordGlossary).find(
      k => k.toLowerCase() === word.toLowerCase()
    );

    function populateTooltip(translation) {
      if (!tip.isConnected) return;
      const transInput = tip.querySelector(".ttw-trans");
      transInput.value = translation;
      transInput.disabled = false;
      const addBtn = tip.querySelector(".ttw-add");
      addBtn.disabled = false;
      addBtn.addEventListener("click", () => {
        const english = transInput.value.trim();
        chrome.runtime.sendMessage({ type: "add-flashcard", german: word, english }, (r) => {
          if (r?.duplicate) {
            addBtn.textContent = "Already saved";
            addBtn.disabled = true;
          } else {
            removeWordTooltip();
          }
        });
      });
    }

    if (glossaryKey) {
      populateTooltip(_wordGlossary[glossaryKey]);
    } else {
      chrome.runtime.sendMessage({ type: "word-translate", word, germanContext, englishContext }, (res) => {
        if (!tip.isConnected) return;
        if (res?.error || !res?.translation) {
          tip.querySelector(".ttw-trans").placeholder = res?.error || "Translation failed.";
          return;
        }
        populateTooltip(res.translation);
      });
    }
  }

  function findButtonByText(text) {
    return Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(el => el.textContent.trim() === text);
  }

  function visibleAnswerEls() {
    return Array.from(document.querySelectorAll(SEL_ANSWERS)).filter(el => {
      if (el.hidden) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
      if (el.getBoundingClientRect().height === 0) return false;
      return true;
    });
  }

  function getCheckedStates() {
    return visibleAnswerEls().map(el => {
      let cur = el;
      for (let i = 0; i < 4 && cur; i++) {
        const input = cur.querySelector?.("input[type='checkbox'], input[type='radio']");
        if (input) return input.checked;
        if (cur.tagName === "INPUT") return cur.checked;
        if (cur.getAttribute?.("aria-checked") === "true") return true;
        if (cur.getAttribute?.("aria-selected") === "true") return true;
        const cl = cur.classList;
        if (cl?.contains("checked") || cl?.contains("selected") || cl?.contains("active") ||
            cl?.contains("correct") || cl?.contains("chosen") || cl?.contains("marked")) return true;
        // theorie24.de / Enyo: checked state is shown via background GIF on a sibling .t24qachk element
        const t24chk = cur.querySelector?.(".t24qachk");
        if (t24chk) {
          const bg = t24chk.getAttribute?.("style") || "";
          const m  = bg.match(/btn_optquestion_(\d+)\.gif/);
          if (m) return parseInt(m[1], 10) > 1;
        }
        cur = cur.parentElement;
      }
      return false;
    });
  }

  function postCheckState() {
    postToParent({ type: "tth-check-state", states: getCheckedStates() });
  }

  function initQuestionFrame() {
    // Override user-select:none so caretRangeFromPoint works on question text
    const usSel = document.createElement("style");
    usSel.textContent = "* { user-select: text !important; -webkit-user-select: text !important; }";
    (document.head || document.documentElement).appendChild(usSel);

    translate();
    startObserver();

    // Poll t24btnnext for "Auflösung" ↔ "Weiter" label changes.
    // MutationObserver is unreliable here because Enyo mutates in the main world.
    {
      let lastBtnLabel = null;
      setInterval(() => {
        const nextBtnEl = document.getElementById("app_TestingPage_CoreTestingDisplay_t24btnnext");
        if (!nextBtnEl) return;
        const span = nextBtnEl.querySelector("span");
        const label = (span?.textContent || nextBtnEl.textContent || "").trim();
        if (!label || label === lastBtnLabel) return;
        lastBtnLabel = label;
        if (label === "Weiter") postToParent({ type: "tth-btn-label", label: "next" });
        else if (label === "Auflösung") postToParent({ type: "tth-btn-label", label: "solution" });
      }, 300);
    }

    // Poll for "Erklärung zur Frage" explanation dialog visibility.
    // Polling is more reliable than MutationObserver here because Enyo mutates
    // the DOM in the main world; attribute changes on #alert may not fire
    // observers in the isolated content-script world.
    {
      let lastExplText = null;
      setInterval(() => {
        const alertEl = document.getElementById("alert");
        if (!alertEl || getComputedStyle(alertEl).display === "none") {
          lastExplText = null; // reset so re-opening the dialog re-triggers translation
          return;
        }
        const alertMsg = document.getElementById("alert_message");
        if (!alertMsg) return;
        const raw = alertMsg.innerText || "";
        const text = raw
          .split("\n")
          .map(l => l.trim())
          .filter(l => l && l !== "Erklärung zur Frage" && !/^[Ss]chliessen$/.test(l))
          .join("\n")
          .trim();
        if (!text || text.length < 5 || text === lastExplText) return;
        lastExplText = text;
        postToParent({ type: "tth-explanation", text });
      }, 500);
    }

    // Listen for commands from the parent frame (English sidebar)
    window.addEventListener("message", e => {
      if (e.data?.type !== "tth-cmd") return;
      const { action, index } = e.data;
      if (action === "click-answer") {
        const els = visibleAnswerEls();
        const el = els[index];
        if (el) {
          // theorie24.de uses Enyo.js: no native inputs, state lives in the Enyo
          // component API. Content scripts run in an isolated world and cannot
          // access window.enyo directly. Ask the background service worker to
          // call chrome.scripting.executeScript with world:"MAIN" instead.
          const compId = el.id.replace(/_answertext$/, '');
          chrome.runtime.sendMessage({ type: "enyo-toggle", compId });
          // Do NOT call postCheckState here: the optimistic English update already
          // reflects the intended state; German→English sync for real clicks is
          // handled by the trusted-click listener below.
        }
      } else if (action === "abbrechen") {
        chrome.runtime.sendMessage({
          type: "enyo-btn-tap",
          compId: "app_TestingPage_CoreTestingDisplay_t24btneval",
        });
      } else if (action === "markieren") {
        chrome.runtime.sendMessage({
          type: "enyo-btn-tap",
          compId: "app_TestingPage_CoreTestingDisplay_t24btnmark",
        });
      } else if (action === "aufloesung") {
        chrome.runtime.sendMessage(
          { type: "enyo-btn-tap", compId: "app_TestingPage_CoreTestingDisplay_t24btnnext" },
          () => {
            setTimeout(postCheckState, 300);
            setTimeout(() => {
              const text = SEL_SOLUTION_CANDIDATES
                .map(sel => document.querySelector(sel)?.textContent?.trim())
                .find(t => t && t.length > 5);
              if (text) postToParent({ type: "tth-solution-text", text });
            }, 600);
          }
        );
      }
    });

    // Sync English checkboxes when user clicks German answers directly
    document.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      if (visibleAnswerEls().length > 0) setTimeout(postCheckState, 50);
    }, true);

    // pointerdown: handles both dismiss and show.
    // Dismiss first (before any early-return) so clicking outside always closes.
    // For word clicks, preventDefault() suppresses the click event chain so the
    // page's checkbox-toggle handler never runs.
    document.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (!e.isTrusted) return; // ignore synthetic pointerdowns we dispatch ourselves
      const existing = document.getElementById("tth-word-tooltip");
      if (existing && !existing.contains(e.target)) removeWordTooltip();
      if (!isQuestionFrame()) return;
      if (e.target.closest("button, input, select, textarea, a, img, video, [role='button']")) return;
      const word = wordAt(e.clientX, e.clientY);
      if (!word || word.length < 2) return;
      if (word.toLowerCase() === "schliessen") return;
      e.preventDefault(); // suppresses mousedown → mouseup → click
      showWordTooltip(word, e.clientX, e.clientY);
    }, true);
    window.addEventListener("beforeunload", () => {
      postToParent({ type: "tth-minimize" });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INIT — decide role based on which frame we're in
  // ══════════════════════════════════════════════════════════════════════════

  if (isTopFrame()) {
    // Top frame always hosts the panel
    initParentFrame();
  } else if (isQuestionFrame()) {
    // Sub-frame with the question — parse and post results up
    initQuestionFrame();
  } else {
    // Other sub-frame — watch in case question loads later
    const waitObserver = new MutationObserver(() => {
      if (isQuestionFrame()) {
        waitObserver.disconnect();
        initQuestionFrame();
      }
    });
    waitObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
})();
