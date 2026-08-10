(() => {
  "use strict";

  const dataset = window.MCPHERSON_CARD_DATA;
  const questionContainer = document.getElementById("questionContainer");

  if (!dataset || !Array.isArray(dataset.cards) || !Array.isArray(dataset.sections)) {
    questionContainer.innerHTML = `
      <div class="error-state" role="alert">
        Card data could not be loaded. Run the manuscript importer and refresh this page.
      </div>
    `;
    return;
  }

  const originalCards = dataset.cards.slice();
  const sections = dataset.sections;
  const validCardIds = new Set(originalCards.map((card) => card.id));

  const storageKeys = {
    stack: "mcpherson_flashcards_v2_stack",
    results: "mcpherson_flashcards_v2_results",
    filters: "mcpherson_flashcards_v2_filters",
    mode: "mcpherson_flashcards_v2_mode",
    responses: "mcpherson_flashcards_v2_responses",
  };

  const tabIconSources = {
    "head-neck": "Assets/L1344_760013-TabCardSection1.png?v=20260804-4",
    "lumbar-region": "Assets/L1344_760069-TabCardSection2.png?v=20260804-4",
    "thorax-abdomen": "Assets/L1344_760078-TabCardSection3.png?v=20260804-4",
    "pelvic-bones": "Assets/L1344_760099-TabCardSection4.png?v=20260804-4",
    "upper-extremity": "Assets/L1344_760137-TabCardSection5.png?v=20260804-4",
    "lower-extremity": "Assets/L1344_760187-TabCardSection6.png?v=20260804-4",
  };

  // Production artwork is being introduced one section at a time. Sections
  // not listed here continue to use the thumbnails imported from the DOCX.
  const productionArtworkDirectories = {
    "head-neck": "Assets/images",
    "lumbar-region": "Assets/images",
    "thorax-abdomen": "Assets/images",
    "pelvic-bones": "Assets/images",
    "upper-extremity": "Assets/images",
    "lower-extremity": "Assets/images",
  };

  const unavailableProductionArtwork = new Set(["L1344_760107"]);

  const state = {
    cards: originalCards.slice(),
    selectedSections: new Set(),
    search: "",
    cardTypeFilter: "all",
    mode: loadString(storageKeys.mode, "all") === "stack" ? "stack" : "all",
    currentIndex: 0,
    stack: loadJSON(storageKeys.stack, []).filter((id) => validCardIds.has(id)),
    results: loadJSON(storageKeys.results, {}),
    responses: loadJSON(storageKeys.responses, {}),
    answerShown: false,
    selectedDragChoice: null,
    blankFeedback: {},
  };

  const elements = {
    tabs: document.getElementById("tabs"),
    searchInput: document.getElementById("searchInput"),
    cardTypeFilter: document.getElementById("cardTypeFilter"),
    viewAllBtn: document.getElementById("viewAllBtn"),
    viewStackBtn: document.getElementById("viewStackBtn"),
    clearFiltersBtn: document.getElementById("clearFiltersBtn"),
    shuffleCurrentBtn: document.getElementById("shuffleCurrentBtn"),
    resetAppBtn: document.getElementById("resetAppBtn"),
    stackContent: document.getElementById("stackContent"),
    progressText: document.getElementById("progressText"),
    correctCount: document.getElementById("correctCount"),
    incorrectCount: document.getElementById("incorrectCount"),
    draftCount: document.getElementById("draftCount"),
    stackCount: document.getElementById("stackCount"),
    stackCountBadge: document.getElementById("stackCountBadge"),
    shuffleStackBtn: document.getElementById("shuffleStackBtn"),
    clearStackBtn: document.getElementById("clearStackBtn"),
    zoomDialog: document.getElementById("zoomDialog"),
    zoomTitle: document.getElementById("zoomTitle"),
    zoomFrame: document.getElementById("zoomFrame"),
    zoomFileName: document.getElementById("zoomFileName"),
    closeZoomBtn: document.getElementById("closeZoomBtn"),
    liveRegion: document.getElementById("liveRegion"),
  };

  loadFilters();
  elements.searchInput.value = state.search;
  elements.cardTypeFilter.value = state.cardTypeFilter;

  function loadJSON(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function loadString(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // The app remains usable if storage is unavailable.
    }
  }

  function saveString(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // The app remains usable if storage is unavailable.
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function textToHtml(value) {
    return escapeHtml(value).replaceAll("\n", "<br />");
  }

  function normalizeAnswer(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function announce(message) {
    elements.liveRegion.textContent = "";
    window.setTimeout(() => {
      elements.liveRegion.textContent = message;
    }, 10);
  }

  function getResponse(cardId) {
    const response = state.responses[cardId];
    return response && typeof response === "object" && !Array.isArray(response)
      ? response
      : {};
  }

  function storeResponse(cardId, response) {
    state.responses[cardId] = response;
    saveJSON(storageKeys.responses, state.responses);
  }

  function hasResponse(card) {
    const response = getResponse(card.id);
    return Object.values(response).some((value) => value !== "" && value !== false);
  }

  function getFilteredCards() {
    const base =
      state.mode === "stack"
        ? state.cards.filter((card) => state.stack.includes(card.id))
        : state.cards;
    const query = state.search.trim().toLowerCase();

    return base.filter((card) => {
      const matchesSection =
        state.selectedSections.size === 0 ||
        state.selectedSections.has(card.sectionId);
      const matchesCardType =
        state.cardTypeFilter === "all" || card.cardType === state.cardTypeFilter;
      const matchesSearch = !query || card.searchText.includes(query);
      return matchesSection && matchesCardType && matchesSearch;
    });
  }

  function clampIndex() {
    const cards = getFilteredCards();
    if (!cards.length) {
      state.currentIndex = 0;
    } else {
      state.currentIndex = Math.max(
        0,
        Math.min(state.currentIndex, cards.length - 1),
      );
    }
  }

  function resultLabel(card) {
    if (!card.ready) return "Draft";
    if (state.results[card.id] === "correct") return "Correct";
    if (state.results[card.id] === "incorrect") return "Review";
    return "Not checked";
  }

  function resultClass(card) {
    if (!card.ready) return "draft";
    return state.results[card.id] || "";
  }

  function titleContainsBlank(card) {
    return card.titleTemplate?.some((segment) => segment.type === "blank");
  }

  function renderTabs() {
    elements.tabs.innerHTML = sections
      .map((section) => {
        const active = state.selectedSections.has(section.id);
        const iconSource = tabIconSources[section.id];
        const tabIcon = iconSource
          ? `<img class="tab-icon" src="${escapeHtml(iconSource)}" alt="" aria-hidden="true" />`
          : "";
        return `
          <button
            class="tab ${escapeHtml(section.colorClass)} ${tabIcon ? "has-icon" : ""}"
            type="button"
            data-section-id="${escapeHtml(section.id)}"
            aria-pressed="${active}"
            aria-label="${active ? "Deselect" : "Select"} ${escapeHtml(section.name)}"
          >
            <span class="tab-name">${escapeHtml(section.name)}</span>
            <span class="tab-count">${section.cardCount} cards</span>
            ${tabIcon}
          </button>
        `;
      })
      .join("");

    elements.tabs.querySelectorAll("[data-section-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const sectionId = button.dataset.sectionId;
        if (state.selectedSections.has(sectionId)) {
          state.selectedSections.delete(sectionId);
        } else {
          state.selectedSections.add(sectionId);
        }
        state.currentIndex = 0;
        state.answerShown = false;
        persistFilters();
        render();
      });
    });
  }

  function renderTemplate(segments, card) {
    const response = getResponse(card.id);
    const cardFeedback = state.blankFeedback[card.id] || {};
    return (segments || [])
      .map((segment) => {
        if (segment.type === "text") return textToHtml(segment.text);

        const blank = card.blanks.find((item) => item.id === segment.id);
        const value = response[segment.id] || "";
        const savedFeedback = cardFeedback[segment.id] || "";
        const isCorrect = blank ? isBlankCorrect(value, blank.answer) : false;
        const gradeClass =
          savedFeedback ||
          (state.answerShown ? (isCorrect ? "correct" : "incorrect") : "");
        const blankNumber = segment.id.split("-").at(-1);
        const statusText =
          gradeClass === "correct"
            ? '<span aria-hidden="true">✓</span> Correct'
            : gradeClass === "incorrect"
              ? '<span aria-hidden="true">×</span> Try again'
              : "";
        return `
          <span class="guided-blank">
            <label class="sr-only" for="${card.id}-${segment.id}">
              Blank ${blankNumber} on card ${escapeHtml(card.id)}
            </label>
            <input
              class="inline-blank ${gradeClass}"
              id="${card.id}-${segment.id}"
              data-blank-id="${segment.id}"
              type="text"
              value="${escapeHtml(value)}"
              autocomplete="off"
              spellcheck="false"
              aria-label="Blank ${blankNumber} on card ${escapeHtml(card.id)}"
            />
            <span
              class="blank-status ${gradeClass}"
              data-blank-status="${segment.id}"
              aria-live="polite"
            >${statusText}</span>
          </span>
        `;
      })
      .join("");
  }

  function isBlankCorrect(value, answer) {
    return (
      normalizeAnswer(value) !== "" &&
      normalizeAnswer(value) === normalizeAnswer(answer)
    );
  }

  function renderCardTitle(card) {
    if (titleContainsBlank(card)) {
      return renderTemplate(card.titleTemplate, card);
    }
    return escapeHtml(card.title);
  }

  function interactionInstruction(card) {
    if (card.interaction === "drag-drop") {
      return "Drag each term—or select it and then choose a lettered target—to match the callouts in the image.";
    }
    if (card.interaction === "fill-blank") {
      return card.ready
        ? "Type each missing term. Press Enter or move to another field to check your answer."
        : "This card is awaiting highlighted answer text in the manuscript.";
    }
    if (card.interaction === "select-all") {
      return titleContainsBlank(card)
        ? "Identify the muscle, then choose every correct option. More than one answer may be correct."
        : "Choose every correct option. More than one answer may be correct.";
    }
    return "This card is awaiting an interaction assignment.";
  }

  function draftMessage(card) {
    if (card.interactionInferred) {
      return "The manuscript does not assign an interaction to this card. Fill-in-the-blank is shown as an editorial inference, and highlighted answer text is still required.";
    }
    if (card.draftReasonCodes?.includes("unexpected_correct_marker")) {
      return "This fill-in card also contains asterisked answers, but asterisks are reserved for Select All That Apply. Confirm the interaction or remove the conflicting markers before grading.";
    }
    if (card.draftReasonCodes?.includes("fill_card_has_no_highlights")) {
      return "This draft card has no highlighted answer text yet. Its manuscript content is visible, but grading is disabled until the author marks the answer text.";
    }
    return "This card contains unresolved manuscript data. Review its import-report entry before enabling grading.";
  }

  function renderArtwork(card) {
    const imageSource = artworkSource(card);
    const safeAlt = titleContainsBlank(card)
      ? `Anatomical reference illustration for card ${card.id}`
      : card.image.alt;

    if (!imageSource) {
      return `
        <div class="image-wrap">
          <div class="empty-state" role="img" aria-label="${escapeHtml(safeAlt)}">
            Artwork is not available for this draft card.
          </div>
        </div>
      `;
    }

    return `
      <div class="image-wrap">
        <button
          class="artwork-button"
          type="button"
          data-action="zoom"
          aria-label="Open a larger view of the card image"
        >
          <img
            class="artwork-image"
            src="${escapeHtml(imageSource)}"
            alt="${escapeHtml(safeAlt)}"
          />
        </button>
      </div>
      <p class="zoom-hint">Select the image to enlarge it.</p>
      <p class="image-source">Source: <code>${escapeHtml(card.image.sourceFile)}</code></p>
    `;
  }

  function artworkSource(card) {
    const productionDirectory = productionArtworkDirectories[card.sectionId];
    if (
      productionDirectory &&
      card.image.sourceFile &&
      !unavailableProductionArtwork.has(card.image.sourceFile)
    ) {
      return `${productionDirectory}/${card.image.sourceFile}.png`;
    }
    return card.image.src;
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (const character of value) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function stableShuffle(items, seedValue) {
    const result = items.slice();
    let seed = stableHash(seedValue) || 1;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };

    for (let index = result.length - 1; index > 0; index -= 1) {
      const target = Math.floor(random() * (index + 1));
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  }

  function renderDragInteraction(card) {
    const response = getResponse(card.id);
    const assignedIds = new Set(Object.values(response));
    const choices = stableShuffle(card.labels, card.id).filter(
      (label) => !assignedIds.has(label.id),
    );
    const selected =
      state.selectedDragChoice?.cardId === card.id
        ? state.selectedDragChoice.choiceId
        : "";

    const bank = choices.length
      ? choices
          .map(
            (label) => `
              <button
                class="drag-chip"
                type="button"
                draggable="true"
                data-choice-id="${escapeHtml(label.id)}"
                aria-pressed="${selected === label.id}"
              >
                ${escapeHtml(label.answer)}
              </button>
            `,
          )
          .join("")
      : "All terms have been placed. Select a filled target to return its term.";

    const targets = card.labels
      .map((label) => {
        const choiceId = response[label.target];
        const choice = card.labels.find((item) => item.id === choiceId);
        const isCorrect = choiceId === label.id;
        const gradeClass = state.answerShown
          ? isCorrect
            ? "correct"
            : "incorrect"
          : "";
        return `
          <button
            class="drop-target ${choice ? "is-filled" : ""} ${gradeClass}"
            type="button"
            data-drop-target="${escapeHtml(label.target)}"
            aria-label="Target ${escapeHtml(label.target)}${
              choice ? `, currently ${escapeHtml(choice.answer)}` : ", empty"
            }"
          >
            <span class="target-key">${escapeHtml(label.target)}</span>
            <span class="target-answer">${
              choice ? escapeHtml(choice.answer) : "Place a term"
            }</span>
          </button>
        `;
      })
      .join("");

    return `
      <h3>Answer bank</h3>
      <p class="response-help">Terms are shuffled. Each term can be used once.</p>
      <div class="answer-bank ${choices.length ? "" : "is-empty"}">${bank}</div>
      <h3>Lettered targets</h3>
      <div class="drop-grid">${targets}</div>
    `;
  }

  function renderFillInteraction(card) {
    const paragraphs = card.paragraphs
      .map((segments) => {
        const { marker, contentSegments } = splitParagraphMarker(segments);
        return `
          <div class="guided-note-row ${marker ? "has-marker" : ""}">
            ${marker ? `<span class="content-marker" aria-hidden="true">${escapeHtml(marker)}.</span>` : ""}
            <p class="guided-note-text">${renderTemplate(contentSegments, card)}</p>
          </div>
        `;
      })
      .join("");

    return `
      <section class="fill-card-sheet" aria-label="Fill-in-the-blank response">
        <div class="guided-notes">${paragraphs || '<p class="empty-state">No card text was found.</p>'}</div>
      </section>
    `;
  }

  function splitParagraphMarker(segments) {
    if (!segments?.length || segments[0].type !== "text") {
      return { marker: "", contentSegments: segments || [] };
    }

    const match = segments[0].text.match(/^([a-z]|\d+)[.)]\s*/i);
    if (!match) return { marker: "", contentSegments: segments };

    const contentSegments = segments.map((segment) => ({ ...segment }));
    contentSegments[0].text = contentSegments[0].text.slice(match[0].length);
    if (!contentSegments[0].text) contentSegments.shift();
    return { marker: match[1], contentSegments };
  }

  function selectOptionGradeClass(option, selected) {
    if (!state.answerShown) return "";
    if (selected && option.correct) return "correct";
    if (selected && !option.correct) return "incorrect";
    if (!selected && option.correct) return "missed";
    return "";
  }

  function selectOptionMark(option, selected) {
    if (!state.answerShown) return "";
    if (selected && option.correct) return "Correct";
    if (selected && !option.correct) return "Not correct";
    if (!selected && option.correct) return "Missed";
    return "";
  }

  function renderSelectInteraction(card) {
    const response = getResponse(card.id);
    const groups = card.groups
      .map((group) => {
        const staticFact = group.staticText
          ? `<p class="static-fact">${escapeHtml(group.staticText)}</p>`
          : "";
        const options = group.options.length
          ? `
            <div class="option-list">
              ${group.options
                .map((option) => {
                  const selected = Boolean(response[option.id]);
                  const gradeClass = selectOptionGradeClass(option, selected);
                  const mark = selectOptionMark(option, selected);
                  return `
                    <label class="select-option ${gradeClass}">
                      <input
                        type="checkbox"
                        data-option-id="${escapeHtml(option.id)}"
                        ${selected ? "checked" : ""}
                      />
                      <span>${escapeHtml(option.text)}</span>
                      ${mark ? `<span class="answer-mark">${mark}</span>` : ""}
                    </label>
                  `;
                })
                .join("")}
            </div>
          `
          : "";

        return `
          <fieldset class="select-group">
            <legend>${escapeHtml(group.label)}</legend>
            ${staticFact}
            ${options}
          </fieldset>
        `;
      })
      .join("");

    return `<div class="select-groups">${groups}</div>`;
  }

  function renderInteraction(card) {
    if (card.interaction === "drag-drop") return renderDragInteraction(card);
    if (card.interaction === "fill-blank") return renderFillInteraction(card);
    if (card.interaction === "select-all") return renderSelectInteraction(card);
    return '<div class="empty-state">This interaction has not been assigned.</div>';
  }

  function feedbackAnswers(card) {
    if (card.interaction === "drag-drop") {
      return card.labels
        .map(
          (label) =>
            `<li><strong>${escapeHtml(label.target.toUpperCase())}.</strong> ${escapeHtml(label.answer)}</li>`,
        )
        .join("");
    }

    if (card.interaction === "fill-blank") {
      return card.blanks
        .map(
          (blank, index) =>
            `<li><strong>Blank ${index + 1}:</strong> ${escapeHtml(blank.answer)}</li>`,
        )
        .join("");
    }

    if (card.interaction === "select-all") {
      const titleAnswer = card.blanks?.length
        ? `<li><strong>Muscle:</strong> ${escapeHtml(card.blanks[0].answer)}</li>`
        : "";
      const groupAnswers = card.groups
        .filter((group) => group.options.length)
        .map((group) => {
          const correct = group.options
            .filter((option) => option.correct)
            .map((option) => option.text)
            .join("; ");
          return `<li><strong>${escapeHtml(group.label)}:</strong> ${escapeHtml(correct)}</li>`;
        })
        .join("");
      return titleAnswer + groupAnswers;
    }

    return "";
  }

  function renderFeedback(card) {
    if (!state.answerShown || !card.ready) return "";
    const result = state.results[card.id];
    const correct = result === "correct";
    return `
      <div class="feedback-box ${correct ? "correct" : "incorrect"}" role="status">
        <h3>${correct ? "Correct — nicely done." : "Not quite. Review the correct responses below."}</h3>
        ${
          correct
            ? "<p>You completed every part of this card correctly.</p>"
            : `<ol class="correct-answer-list">${feedbackAnswers(card)}</ol>`
        }
      </div>
    `;
  }

  function renderQuestion() {
    const filtered = getFilteredCards();
    clampIndex();
    const card = filtered[state.currentIndex];

    if (!card) {
      questionContainer.innerHTML = `
        <div class="empty-state" role="status">
          No cards match the current filters. Clear a filter or switch views to continue.
        </div>
      `;
      return;
    }

    const inStack = state.stack.includes(card.id);
    questionContainer.innerHTML = `
      <article class="question-stage ${escapeHtml(card.sectionColorClass)}">
        <div class="card-heading">
          <div class="question-meta">
            <span class="pill">${escapeHtml(card.sectionName)}</span>
            <span class="pill interaction-pill">${escapeHtml(card.interactionLabel)}</span>
            <span class="pill result-pill ${resultClass(card)}">Status: ${resultLabel(card)}</span>
          </div>
          <h2 class="card-title">
            <span class="card-id">Card ${escapeHtml(card.id)}</span>
            ${renderCardTitle(card)}
          </h2>
          <p class="interaction-instruction">${interactionInstruction(card)}</p>
        </div>

        ${
          card.ready
            ? ""
            : `<div class="draft-notice" role="note"><span>${escapeHtml(draftMessage(card))}</span></div>`
        }

        <div class="study-layout interaction-${escapeHtml(card.interaction)}">
          <div class="image-panel">${renderArtwork(card)}</div>
          <div class="response-panel">
            ${renderInteraction(card)}
            <div class="question-actions">
              <button
                class="primary-button"
                type="button"
                data-action="check"
                ${card.ready ? "" : "disabled"}
              >
                Check answers
              </button>
              <button type="button" data-action="clear-response" ${hasResponse(card) ? "" : "disabled"}>
                Clear response
              </button>
              <button type="button" data-action="toggle-stack">
                ${inStack ? "Remove from study stack" : "Add to study stack"}
              </button>
            </div>
          </div>
        </div>

        ${renderFeedback(card)}

        <div class="nav-actions">
          <button type="button" data-action="previous" ${state.currentIndex === 0 ? "disabled" : ""}>
            Previous
          </button>
          <span class="nav-position">Card ${state.currentIndex + 1} of ${filtered.length}</span>
          <button
            type="button"
            data-action="next"
            ${state.currentIndex >= filtered.length - 1 ? "disabled" : ""}
          >
            Next
          </button>
        </div>
      </article>
    `;

    bindQuestionEvents(card);
  }

  function invalidateResult(cardId, updateVisibleUi = false) {
    if (state.results[cardId]) {
      delete state.results[cardId];
      saveJSON(storageKeys.results, state.results);
    }
    state.answerShown = false;
    questionContainer.querySelector(".feedback-box")?.remove();
    const resultPill = questionContainer.querySelector(".result-pill");
    if (resultPill) {
      resultPill.classList.remove("correct", "incorrect");
      resultPill.textContent = "Status: Not checked";
    }
    if (updateVisibleUi) {
      questionContainer
        .querySelectorAll(".correct, .incorrect, .missed")
        .forEach((element) =>
          element.classList.remove("correct", "incorrect", "missed"),
        );
    }
    renderProgress();
  }

  function assignDragChoice(card, target, choiceId) {
    const response = { ...getResponse(card.id) };
    for (const [existingTarget, existingChoice] of Object.entries(response)) {
      if (existingChoice === choiceId) delete response[existingTarget];
    }
    response[target] = choiceId;
    storeResponse(card.id, response);
    state.selectedDragChoice = null;
    invalidateResult(card.id);
    const answer = card.labels.find((label) => label.id === choiceId)?.answer || "Term";
    announce(`${answer} placed at target ${target.toUpperCase()}.`);
    renderQuestion();
    renderProgress();
  }

  function releaseDragChoice(card, target) {
    const response = { ...getResponse(card.id) };
    const choiceId = response[target];
    if (!choiceId) return;
    const answer = card.labels.find((label) => label.id === choiceId)?.answer || "Term";
    delete response[target];
    storeResponse(card.id, response);
    invalidateResult(card.id);
    announce(`${answer} returned to the answer bank.`);
    renderQuestion();
    renderProgress();
  }

  function bindDragEvents(card) {
    questionContainer.querySelectorAll("[data-choice-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const choiceId = button.dataset.choiceId;
        state.selectedDragChoice =
          state.selectedDragChoice?.cardId === card.id &&
          state.selectedDragChoice.choiceId === choiceId
            ? null
            : { cardId: card.id, choiceId };
        renderQuestion();
      });

      button.addEventListener("dragstart", (event) => {
        const choiceId = button.dataset.choiceId;
        state.selectedDragChoice = { cardId: card.id, choiceId };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", choiceId);
      });
    });

    questionContainer.querySelectorAll("[data-drop-target]").forEach((target) => {
      target.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      });

      target.addEventListener("drop", (event) => {
        event.preventDefault();
        const choiceId =
          event.dataTransfer.getData("text/plain") ||
          state.selectedDragChoice?.choiceId;
        if (choiceId) assignDragChoice(card, target.dataset.dropTarget, choiceId);
      });

      target.addEventListener("click", () => {
        const selected =
          state.selectedDragChoice?.cardId === card.id
            ? state.selectedDragChoice.choiceId
            : "";
        if (selected) {
          assignDragChoice(card, target.dataset.dropTarget, selected);
        } else {
          releaseDragChoice(card, target.dataset.dropTarget);
        }
      });
    });
  }

  function bindFillEvents(card) {
    const inputs = [
      ...questionContainer.querySelectorAll("[data-blank-id]"),
    ];

    inputs.forEach((input, index) => {
      input.addEventListener("input", () => {
        const response = { ...getResponse(card.id) };
        response[input.dataset.blankId] = input.value;
        storeResponse(card.id, response);
        clearBlankFeedback(card, input);
        invalidateResult(card.id);
      });

      input.addEventListener("blur", () => gradeBlank(card, input));

      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        gradeBlank(card, input);
        const nextInput = inputs[index + 1];
        if (nextInput) {
          nextInput.focus();
        } else {
          questionContainer.querySelector('[data-action="check"]')?.focus();
        }
      });
    });
  }

  function gradeBlank(card, input) {
    const blank = card.blanks.find(
      (item) => item.id === input.dataset.blankId,
    );
    if (!blank) return;

    const grade = isBlankCorrect(input.value, blank.answer)
      ? "correct"
      : "incorrect";
    if (!state.blankFeedback[card.id]) state.blankFeedback[card.id] = {};
    state.blankFeedback[card.id][blank.id] = grade;
    applyBlankFeedback(input, grade);
  }

  function clearBlankFeedback(card, input) {
    const blankId = input.dataset.blankId;
    if (state.blankFeedback[card.id]) {
      delete state.blankFeedback[card.id][blankId];
    }
    applyBlankFeedback(input, "");
  }

  function applyBlankFeedback(input, grade) {
    input.classList.remove("correct", "incorrect");
    if (grade) input.classList.add(grade);
    const status = input
      .closest(".guided-blank")
      ?.querySelector("[data-blank-status]");
    if (!status) return;
    status.classList.remove("correct", "incorrect");
    if (grade) status.classList.add(grade);
    status.innerHTML =
      grade === "correct"
        ? '<span aria-hidden="true">✓</span> Correct'
        : grade === "incorrect"
          ? '<span aria-hidden="true">×</span> Try again'
          : "";
  }

  function bindSelectEvents(card) {
    questionContainer.querySelectorAll("[data-option-id]").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        const response = { ...getResponse(card.id) };
        response[checkbox.dataset.optionId] = checkbox.checked;
        storeResponse(card.id, response);
        invalidateResult(card.id, true);
      });
    });
  }

  function bindQuestionEvents(card) {
    questionContainer
      .querySelector('[data-action="zoom"]')
      ?.addEventListener("click", () => openZoom(card));

    questionContainer
      .querySelector('[data-action="check"]')
      ?.addEventListener("click", () => gradeQuestion(card));

    questionContainer
      .querySelector('[data-action="clear-response"]')
      ?.addEventListener("click", () => {
        delete state.responses[card.id];
        delete state.results[card.id];
        delete state.blankFeedback[card.id];
        saveJSON(storageKeys.responses, state.responses);
        saveJSON(storageKeys.results, state.results);
        state.answerShown = false;
        state.selectedDragChoice = null;
        announce(`Response cleared for card ${card.id}.`);
        render();
      });

    questionContainer
      .querySelector('[data-action="toggle-stack"]')
      ?.addEventListener("click", () => toggleStack(card.id));

    questionContainer
      .querySelector('[data-action="previous"]')
      ?.addEventListener("click", () => {
        state.currentIndex -= 1;
        state.answerShown = false;
        state.selectedDragChoice = null;
        render();
        questionContainer.focus({ preventScroll: true });
      });

    questionContainer
      .querySelector('[data-action="next"]')
      ?.addEventListener("click", () => {
        state.currentIndex += 1;
        state.answerShown = false;
        state.selectedDragChoice = null;
        render();
        questionContainer.focus({ preventScroll: true });
      });

    if (card.interaction === "drag-drop") bindDragEvents(card);
    if (card.blanks?.length) bindFillEvents(card);
    if (card.interaction === "select-all") bindSelectEvents(card);
  }

  function isQuestionCorrect(card) {
    const response = getResponse(card.id);

    if (card.interaction === "drag-drop") {
      return card.labels.every((label) => response[label.target] === label.id);
    }

    if (card.interaction === "fill-blank") {
      return card.blanks.every(
        (blank) =>
          normalizeAnswer(response[blank.id]) !== "" &&
          normalizeAnswer(response[blank.id]) === normalizeAnswer(blank.answer),
      );
    }

    if (card.interaction === "select-all") {
      const titleIsCorrect =
        !card.blanks?.length ||
        card.blanks.every((blank) =>
          isBlankCorrect(response[blank.id], blank.answer),
        );
      const groupsAreCorrect = card.groups.every((group) =>
        group.options.every(
          (option) => Boolean(response[option.id]) === Boolean(option.correct),
        ),
      );
      return titleIsCorrect && groupsAreCorrect;
    }

    return false;
  }

  function gradeQuestion(card) {
    if (!card.ready) return;
    const correct = isQuestionCorrect(card);
    if (card.blanks?.length) {
      const response = getResponse(card.id);
      state.blankFeedback[card.id] = Object.fromEntries(
        card.blanks.map((blank) => [
          blank.id,
          isBlankCorrect(response[blank.id], blank.answer)
            ? "correct"
            : "incorrect",
        ]),
      );
    }
    state.results[card.id] = correct ? "correct" : "incorrect";
    saveJSON(storageKeys.results, state.results);
    state.answerShown = true;
    state.selectedDragChoice = null;
    announce(correct ? "All answers are correct." : "Some answers need review.");
    render();
  }

  function toggleStack(cardId) {
    if (state.stack.includes(cardId)) {
      state.stack = state.stack.filter((id) => id !== cardId);
      announce(`Card ${cardId} removed from the study stack.`);
    } else {
      state.stack.push(cardId);
      announce(`Card ${cardId} added to the study stack.`);
    }
    saveJSON(storageKeys.stack, state.stack);
    if (state.mode === "stack") clampIndex();
    render();
  }

  function renderStack() {
    elements.stackCount.textContent = String(state.stack.length);
    elements.stackCountBadge.textContent = String(state.stack.length);
    elements.shuffleStackBtn.disabled = state.stack.length < 2;
    elements.clearStackBtn.disabled = state.stack.length === 0;

    if (!state.stack.length) {
      elements.stackContent.innerHTML = `
        <p class="empty-state">No cards saved yet. Add any card you want to revisit.</p>
      `;
      return;
    }

    const cards = state.stack
      .map((id) => state.cards.find((card) => card.id === id))
      .filter(Boolean);

    elements.stackContent.innerHTML = `
      <ul class="stack-list">
        ${cards
          .map(
            (card) => `
              <li class="stack-item ${escapeHtml(card.sectionColorClass)}">
                <p class="stack-item-title">${escapeHtml(card.title)}</p>
                <p class="stack-item-meta">Card ${escapeHtml(card.id)} · ${escapeHtml(card.interactionLabel)}</p>
                <div class="stack-item-actions">
                  <button type="button" data-stack-open="${escapeHtml(card.id)}">Open</button>
                  <button class="danger-button" type="button" data-stack-remove="${escapeHtml(card.id)}">Remove</button>
                </div>
              </li>
            `,
          )
          .join("")}
      </ul>
    `;

    elements.stackContent.querySelectorAll("[data-stack-open]").forEach((button) => {
      button.addEventListener("click", () => openStackCard(button.dataset.stackOpen));
    });
    elements.stackContent
      .querySelectorAll("[data-stack-remove]")
      .forEach((button) => {
        button.addEventListener("click", () =>
          toggleStack(button.dataset.stackRemove),
        );
      });
  }

  function openStackCard(cardId) {
    state.mode = "stack";
    state.selectedSections.clear();
    state.search = "";
    state.cardTypeFilter = "all";
    elements.searchInput.value = "";
    elements.cardTypeFilter.value = "all";
    persistFilters();
    saveString(storageKeys.mode, state.mode);
    const cards = getFilteredCards();
    const index = cards.findIndex((card) => card.id === cardId);
    state.currentIndex = index >= 0 ? index : 0;
    state.answerShown = false;
    syncViewButtons();
    render();
  }

  function renderProgress() {
    const cards = getFilteredCards();
    const results = cards
      .map((card) => state.results[card.id])
      .filter(Boolean);
    elements.progressText.textContent = cards.length
      ? `${Math.min(state.currentIndex + 1, cards.length)} of ${cards.length}`
      : "0 of 0";
    elements.correctCount.textContent = String(
      results.filter((result) => result === "correct").length,
    );
    elements.incorrectCount.textContent = String(
      results.filter((result) => result === "incorrect").length,
    );
    elements.draftCount.textContent = String(
      cards.filter((card) => !card.ready).length,
    );
    elements.shuffleCurrentBtn.disabled = cards.length < 2;
  }

  function syncViewButtons() {
    const inStack = state.mode === "stack";
    elements.viewAllBtn.classList.toggle("is-active", !inStack);
    elements.viewStackBtn.classList.toggle("is-active", inStack);
    elements.viewAllBtn.setAttribute("aria-pressed", String(!inStack));
    elements.viewStackBtn.setAttribute("aria-pressed", String(inStack));
  }

  function persistFilters() {
    saveJSON(storageKeys.filters, {
      sections: [...state.selectedSections],
      search: state.search,
      cardType: state.cardTypeFilter,
    });
  }

  function loadFilters() {
    const filters = loadJSON(storageKeys.filters, {});
    if (Array.isArray(filters.sections)) {
      const validSections = new Set(sections.map((section) => section.id));
      state.selectedSections = new Set(
        filters.sections.filter((id) => validSections.has(id)),
      );
    }
    if (typeof filters.search === "string") state.search = filters.search;
    if (["all", "bones", "ligaments", "muscles"].includes(filters.cardType)) {
      state.cardTypeFilter = filters.cardType;
    }
  }

  function shuffleArray(items) {
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index -= 1) {
      const target = Math.floor(Math.random() * (index + 1));
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  }

  function shuffleCurrentView() {
    const filtered = getFilteredCards();
    const shuffled = shuffleArray(filtered);
    const filteredIds = new Set(filtered.map((card) => card.id));
    let cursor = 0;
    state.cards = state.cards.map((card) =>
      filteredIds.has(card.id) ? shuffled[cursor++] : card,
    );
    state.currentIndex = 0;
    state.answerShown = false;
    render();
    announce(`Shuffled ${filtered.length} cards.`);
  }

  function openZoom(card) {
    const imageSource = artworkSource(card);
    if (!imageSource) return;
    const safeAlt = titleContainsBlank(card)
      ? `Anatomical reference illustration for card ${card.id}`
      : card.image.alt;
    elements.zoomTitle.textContent = `Card ${card.id} artwork`;
    elements.zoomFrame.innerHTML = `
      <img
        class="zoom-artwork"
        src="${escapeHtml(imageSource)}"
        alt="${escapeHtml(safeAlt)}"
      />
    `;
    elements.zoomFileName.textContent = card.image.sourceFile;
    elements.zoomDialog.showModal();
  }

  function resetApp() {
    if (!window.confirm("Reset all answers, results, filters, and saved study cards?")) {
      return;
    }
    Object.values(storageKeys).forEach((key) => {
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing else is needed when storage is unavailable.
      }
    });
    state.cards = originalCards.slice();
    state.selectedSections.clear();
    state.search = "";
    state.cardTypeFilter = "all";
    state.mode = "all";
    state.currentIndex = 0;
    state.stack = [];
    state.results = {};
    state.responses = {};
    state.answerShown = false;
    state.selectedDragChoice = null;
    state.blankFeedback = {};
    elements.searchInput.value = "";
    elements.cardTypeFilter.value = "all";
    syncViewButtons();
    render();
    announce("Study progress reset.");
  }

  function clearFilters() {
    state.selectedSections.clear();
    state.search = "";
    state.cardTypeFilter = "all";
    state.currentIndex = 0;
    state.answerShown = false;
    elements.searchInput.value = "";
    elements.cardTypeFilter.value = "all";
    persistFilters();
    render();
  }

  function render() {
    clampIndex();
    renderTabs();
    syncViewButtons();
    renderQuestion();
    renderStack();
    renderProgress();
  }

  elements.searchInput.addEventListener("input", () => {
    state.search = elements.searchInput.value;
    state.currentIndex = 0;
    state.answerShown = false;
    persistFilters();
    render();
  });

  elements.cardTypeFilter.addEventListener("change", () => {
    state.cardTypeFilter = elements.cardTypeFilter.value;
    state.currentIndex = 0;
    state.answerShown = false;
    persistFilters();
    render();
  });

  elements.clearFiltersBtn.addEventListener("click", clearFilters);
  elements.shuffleCurrentBtn.addEventListener("click", shuffleCurrentView);
  elements.resetAppBtn.addEventListener("click", resetApp);

  elements.viewAllBtn.addEventListener("click", () => {
    state.mode = "all";
    state.currentIndex = 0;
    state.answerShown = false;
    saveString(storageKeys.mode, state.mode);
    render();
  });

  elements.viewStackBtn.addEventListener("click", () => {
    state.mode = "stack";
    state.currentIndex = 0;
    state.answerShown = false;
    saveString(storageKeys.mode, state.mode);
    render();
  });

  elements.shuffleStackBtn.addEventListener("click", () => {
    state.stack = shuffleArray(state.stack);
    saveJSON(storageKeys.stack, state.stack);
    state.currentIndex = 0;
    render();
    announce("Study stack shuffled.");
  });

  elements.clearStackBtn.addEventListener("click", () => {
    if (!state.stack.length) return;
    if (!window.confirm("Remove every card from the study stack?")) return;
    state.stack = [];
    saveJSON(storageKeys.stack, state.stack);
    if (state.mode === "stack") state.currentIndex = 0;
    render();
    announce("Study stack cleared.");
  });

  elements.closeZoomBtn.addEventListener("click", () =>
    elements.zoomDialog.close(),
  );
  elements.zoomDialog.addEventListener("click", (event) => {
    if (event.target === elements.zoomDialog) elements.zoomDialog.close();
  });

  render();
})();
