// TheorieTestHelper — content script (runs in all frames)
//
// QUESTION FRAME role: parse the DOM, call background.js for translation,
//   post results up to the parent frame via postMessage.
//
// PARENT FRAME role: listen for postMessages from the question iframe,
//   inject and manage the translation panel in the parent DOM (outside the iframe).

(function () {
  "use strict";

  const SEL_QUESTION = "#app_TestingPage_CoreTestingDisplay_t24qtext";
  const SEL_ANSWERS  = "[id$='_answertext']";
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
          height: 210px;
          background: #fff;
          border: 2px solid #3b82f6;
          border-radius: 8px 8px 0 0;
          box-shadow: 0 4px 20px rgba(0,0,0,.25);
          overflow: hidden;
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
      </style>
      <button id="tth-toggle">EN ▲</button>
      <div id="tth-sidebar">
        <div id="tth-header">
          <span id="tth-title">TheorieTestHelper</span>
          <button id="tth-close">▼</button>
        </div>
        <div id="tth-body">
          <div id="tth-spinner">Translating…</div>
          <div id="tth-content"></div>
          <div id="tth-error"></div>
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

    return _shadow;
  }

  function showSpinner() {
    const s = getShadow();
    s.getElementById("tth-sidebar").style.display = "flex";
    s.getElementById("tth-toggle").textContent = "EN ▼";
    s.getElementById("tth-spinner").style.display = "block";
    s.getElementById("tth-content").style.display = "none";
    s.getElementById("tth-error").style.display = "none";
  }

  function showTranslation(question, answers) {
    const s = getShadow();
    s.getElementById("tth-spinner").style.display = "none";
    s.getElementById("tth-error").style.display = "none";
    const content = s.getElementById("tth-content");
    const answersHtml = answers
      .map((a, i) => `<li><span class="ans-label">${String.fromCharCode(65 + i)}.</span>${escapeHtml(a)}</li>`)
      .join("");
    content.innerHTML = `<p id="tth-question">${escapeHtml(question)}</p><ul id="tth-answers">${answersHtml}</ul>`;
    content.style.display = "flex";
  }

  function showError(msg) {
    const s = getShadow();
    s.getElementById("tth-spinner").style.display = "none";
    s.getElementById("tth-content").style.display = "none";
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

  function initParentFrame() {
    pushContentLeft();
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data?.type?.startsWith(MSG_PREFIX)) return;
      switch (data.type) {
        case "tth-spinner":     showSpinner(); break;
        case "tth-translation": showTranslation(data.question, data.answers); break;
        case "tth-error":       showError(data.message); break;
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // QUESTION FRAME — DOM parsing + translation
  // ══════════════════════════════════════════════════════════════════════════

  function postToParent(msg) {
    window.parent.postMessage(msg, "*");
  }

  function parseQuestion() {
    const questionEl = document.querySelector(SEL_QUESTION);
    if (!questionEl) return null;
    const questionText = questionEl.textContent.trim();
    if (!questionText || questionText === "Fragentext?") return null;
    const answerEls = document.querySelectorAll(SEL_ANSWERS);
    if (!answerEls.length) return null;
    return {
      question: questionText,
      answers: Array.from(answerEls).map(el => el.textContent.trim()).filter(Boolean),
    };
  }

  const MAX_RETRIES = 6;

  async function translate() {
    postToParent({ type: "tth-spinner" });

    let parsed = null;
    for (let i = 0; i < MAX_RETRIES; i++) {
      parsed = parseQuestion();
      if (parsed) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (!parsed) {
      postToParent({ type: "tth-error", message: "Could not find question/answers in the page DOM." });
      return;
    }

    chrome.runtime.sendMessage(
      { type: "translate", question: parsed.question, answers: parsed.answers },
      (response) => {
        if (chrome.runtime.lastError) {
          postToParent({ type: "tth-error", message: "Extension error: " + chrome.runtime.lastError.message });
          return;
        }
        if (response?.error) {
          postToParent({ type: "tth-error", message: "Translation error: " + response.error });
          return;
        }
        postToParent({ type: "tth-translation", question: response.question, answers: response.answers });
      }
    );
  }

  let debounceTimer = null;
  let lastQuestionText = null;

  function onMutation() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const el = document.querySelector(SEL_QUESTION);
      if (!el) return;
      const text = el.textContent.trim();
      if (!text || text === lastQuestionText || text === "Fragentext?") return;
      lastQuestionText = text;
      translate();
    }, 400);
  }

  function startObserver() {
    const observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function initQuestionFrame() {
    translate();
    startObserver();
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
