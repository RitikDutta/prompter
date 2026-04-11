/**
 * Center-word reading prompter.
 * - Normalizes pasted script text, tokenizes it into words, and builds
 *   punctuation-aware chunks of 1 to 3 words.
 * - Advances through those chunks with a time-based playback engine driven by
 *   the active words-per-minute setting.
 * - The playback engine is intentionally isolated so speech-recognition based
 *   progression can later hook into the same `advanceFromExternalSignal()`
 *   path instead of relying only on timer scheduling.
 */

const STORAGE_KEY = "center-word-prompter-settings";

const DEFAULT_SETTINGS = {
  wordsPerMinute: 170,
  fontSize: 76,
  verticalOffset: 0,
  chunkSize: 2,
  theme: "dark",
};

const SETTING_LIMITS = {
  wordsPerMinute: { min: 80, max: 260 },
  fontSize: { min: 10, max: 120 },
  verticalOffset: { min: -2400, max: 2400 },
  chunkSize: { min: 1, max: 3 },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatDurationFromWords(wordCount, wordsPerMinute) {
  if (!wordCount || !wordsPerMinute) {
    return "0:00";
  }

  const totalSeconds = Math.max(0, Math.round((wordCount / wordsPerMinute) * 60));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatVerticalOffset(offset, bounds = null) {
  if (!offset) {
    return "Centered";
  }

  if (bounds) {
    if (offset <= bounds.min) {
      return "Top edge";
    }

    if (offset >= bounds.max) {
      return "Bottom edge";
    }
  }

  return `${Math.abs(offset)} px ${offset < 0 ? "up" : "down"}`;
}

function formatLibraryTitle(fileName) {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildLibraryPreview(text, maxLength = 160) {
  const normalizedText = ScriptParser.normalize(text || "");

  if (normalizedText.length <= maxLength) {
    return normalizedText;
  }

  return `${normalizedText.slice(0, maxLength - 1).trimEnd()}…`;
}

function loadSettings() {
  try {
    const savedSettings = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");

    return {
      wordsPerMinute: clamp(
        Number(savedSettings.wordsPerMinute) || DEFAULT_SETTINGS.wordsPerMinute,
        SETTING_LIMITS.wordsPerMinute.min,
        SETTING_LIMITS.wordsPerMinute.max
      ),
      fontSize: clamp(
        Number(savedSettings.fontSize) || DEFAULT_SETTINGS.fontSize,
        SETTING_LIMITS.fontSize.min,
        SETTING_LIMITS.fontSize.max
      ),
      verticalOffset: clamp(
        Number(savedSettings.verticalOffset) || DEFAULT_SETTINGS.verticalOffset,
        SETTING_LIMITS.verticalOffset.min,
        SETTING_LIMITS.verticalOffset.max
      ),
      chunkSize: clamp(
        Number(savedSettings.chunkSize) || DEFAULT_SETTINGS.chunkSize,
        SETTING_LIMITS.chunkSize.min,
        SETTING_LIMITS.chunkSize.max
      ),
      theme: savedSettings.theme === "light" ? "light" : "dark",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage failures so the app still works in restricted contexts.
  }
}

class ScriptParser {
  static normalize(text) {
    return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  static tokenize(text) {
    const normalizedText = ScriptParser.normalize(text || "");
    return normalizedText ? normalizedText.split(" ") : [];
  }

  static buildChunks(tokens, chunkSize) {
    const safeChunkSize = clamp(Number(chunkSize) || DEFAULT_SETTINGS.chunkSize, 1, 3);
    const chunks = [];
    let currentWords = [];
    let startWordIndex = 0;

    tokens.forEach((token, tokenIndex) => {
      if (currentWords.length === 0) {
        startWordIndex = tokenIndex;
      }

      currentWords.push(token);

      const reachedTargetSize = currentWords.length >= safeChunkSize;
      const strongBoundary = /[.!?]["')\]]*$/.test(token);
      const softBoundary =
        /[,;:]["')\]]*$/.test(token) &&
        currentWords.length >= Math.max(2, safeChunkSize - 1);

      if (reachedTargetSize || strongBoundary || softBoundary) {
        chunks.push({
          text: currentWords.join(" "),
          wordCount: currentWords.length,
          startWordIndex,
          endWordIndex: tokenIndex,
        });

        currentWords = [];
      }
    });

    if (currentWords.length > 0) {
      chunks.push({
        text: currentWords.join(" "),
        wordCount: currentWords.length,
        startWordIndex,
        endWordIndex: tokens.length - 1,
      });
    }

    return chunks;
  }
}

class PrompterEngine {
  constructor(onChange) {
    this.onChange = onChange;
    this.sourceText = "";
    this.tokens = [];
    this.chunks = [];
    this.currentIndex = 0;
    this.chunkSize = DEFAULT_SETTINGS.chunkSize;
    this.wordsPerMinute = DEFAULT_SETTINGS.wordsPerMinute;
    this.isPlaying = false;
    this.isFinished = false;
    this.timerId = null;
  }

  loadScript(text, { chunkSize, wordsPerMinute }) {
    this.clearTimer();
    this.sourceText = text;
    this.tokens = ScriptParser.tokenize(text);
    this.chunkSize = chunkSize;
    this.wordsPerMinute = wordsPerMinute;
    this.isPlaying = false;
    this.isFinished = false;
    this.currentIndex = 0;
    this.rebuildChunks(0);
    this.emitChange();
  }

  hasScript() {
    return this.chunks.length > 0;
  }

  setWordsPerMinute(wordsPerMinute) {
    this.wordsPerMinute = clamp(
      Number(wordsPerMinute) || DEFAULT_SETTINGS.wordsPerMinute,
      SETTING_LIMITS.wordsPerMinute.min,
      SETTING_LIMITS.wordsPerMinute.max
    );
    this.emitChange();

    if (this.isPlaying) {
      this.scheduleNextChunk();
    }
  }

  setChunkSize(chunkSize) {
    this.chunkSize = clamp(
      Number(chunkSize) || DEFAULT_SETTINGS.chunkSize,
      SETTING_LIMITS.chunkSize.min,
      SETTING_LIMITS.chunkSize.max
    );

    if (!this.tokens.length) {
      this.emitChange();
      return;
    }

    const anchorWordIndex = this.getCurrentChunk()?.startWordIndex || 0;
    this.rebuildChunks(anchorWordIndex);
    this.emitChange();

    if (this.isPlaying) {
      this.scheduleNextChunk();
    }
  }

  play() {
    if (!this.hasScript()) {
      return;
    }

    if (this.isFinished) {
      this.currentIndex = 0;
      this.isFinished = false;
    }

    if (this.isPlaying) {
      return;
    }

    this.isPlaying = true;
    this.emitChange();
    this.scheduleNextChunk();
  }

  pause() {
    this.isPlaying = false;
    this.clearTimer();
    this.emitChange();
  }

  restart() {
    const shouldResume = this.isPlaying || this.isFinished;

    this.clearTimer();
    this.currentIndex = 0;
    this.isPlaying = false;
    this.isFinished = false;
    this.emitChange();

    if (shouldResume) {
      this.play();
    }
  }

  previous() {
    if (!this.hasScript()) {
      return;
    }

    this.clearTimer();
    this.isFinished = false;
    this.currentIndex = Math.max(0, this.currentIndex - 1);
    this.emitChange();

    if (this.isPlaying) {
      this.scheduleNextChunk();
    }
  }

  next() {
    if (!this.hasScript()) {
      return;
    }

    if (this.currentIndex >= this.chunks.length - 1) {
      this.clearTimer();
      this.isPlaying = false;
      this.isFinished = true;
      this.emitChange();
      return;
    }

    this.clearTimer();
    this.isFinished = false;
    this.currentIndex += 1;
    this.emitChange();

    if (this.isPlaying) {
      this.scheduleNextChunk();
    }
  }

  advanceFromExternalSignal() {
    this.advance();
  }

  rebuildChunks(anchorWordIndex = 0) {
    this.chunks = ScriptParser.buildChunks(this.tokens, this.chunkSize);
    this.currentIndex = this.findChunkIndexByWord(anchorWordIndex);

    if (this.currentIndex >= this.chunks.length) {
      this.currentIndex = Math.max(0, this.chunks.length - 1);
    }

    this.isFinished = false;
  }

  findChunkIndexByWord(wordIndex) {
    if (!this.chunks.length) {
      return 0;
    }

    const matchIndex = this.chunks.findIndex(
      (chunk) => wordIndex >= chunk.startWordIndex && wordIndex <= chunk.endWordIndex
    );

    return matchIndex === -1 ? 0 : matchIndex;
  }

  getCurrentChunk() {
    return this.chunks[this.currentIndex] || null;
  }

  calculateChunkDuration(chunk) {
    if (!chunk) {
      return 0;
    }

    const baseDuration = Math.max(
      260,
      (chunk.wordCount / this.wordsPerMinute) * 60000
    );

    let multiplier = 1;
    let punctuationPadding = 0;

    if (/[.!?]["')\]]*$/.test(chunk.text)) {
      multiplier = 1.25;
      punctuationPadding = 170;
    } else if (/[,;:]["')\]]*$/.test(chunk.text)) {
      multiplier = 1.12;
      punctuationPadding = 90;
    }

    return Math.round(baseDuration * multiplier + punctuationPadding);
  }

  scheduleNextChunk() {
    this.clearTimer();

    if (!this.isPlaying) {
      return;
    }

    const currentChunk = this.getCurrentChunk();

    if (!currentChunk) {
      this.isPlaying = false;
      this.emitChange();
      return;
    }

    this.timerId = window.setTimeout(() => {
      this.timerId = null;
      this.advance();
    }, this.calculateChunkDuration(currentChunk));
  }

  advance() {
    if (!this.hasScript()) {
      return;
    }

    if (this.currentIndex >= this.chunks.length - 1) {
      this.clearTimer();
      this.isPlaying = false;
      this.isFinished = true;
      this.emitChange();
      return;
    }

    this.currentIndex += 1;
    this.emitChange();

    if (this.isPlaying) {
      this.scheduleNextChunk();
    }
  }

  clearTimer() {
    if (this.timerId) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  emitChange() {
    const totalChunks = this.chunks.length;
    const displayIndex = totalChunks ? this.currentIndex + 1 : 0;

    this.onChange?.({
      chunk: this.getCurrentChunk(),
      currentIndex: this.currentIndex,
      displayIndex,
      totalChunks,
      progressPercent: totalChunks ? (displayIndex / totalChunks) * 100 : 0,
      isPlaying: this.isPlaying,
      isFinished: this.isFinished,
      wordsPerMinute: this.wordsPerMinute,
      chunkSize: this.chunkSize,
    });
  }
}

class PrompterApp {
  constructor() {
    this.settings = loadSettings();
    this.libraryItems = [];
    this.activeScriptView = "editor";
    this.engine = new PrompterEngine((snapshot) => this.renderReader(snapshot));

    this.elements = {
      body: document.body,
      scriptInput: document.getElementById("scriptInput"),
      scriptSourceLabel: document.getElementById("scriptSourceLabel"),
      wordCountLabel: document.getElementById("wordCountLabel"),
      chunkCountLabel: document.getElementById("chunkCountLabel"),
      runtimeLabel: document.getElementById("runtimeLabel"),
      speedInput: document.getElementById("speedInput"),
      speedValue: document.getElementById("speedValue"),
      fontSizeInput: document.getElementById("fontSizeInput"),
      fontSizeValue: document.getElementById("fontSizeValue"),
      positionInput: document.getElementById("positionInput"),
      positionValue: document.getElementById("positionValue"),
      chunkSizeValue: document.getElementById("chunkSizeValue"),
      startButton: document.getElementById("startButton"),
      validationMessage: document.getElementById("validationMessage"),
      readerView: document.getElementById("readerView"),
      chunkDisplay: document.getElementById("chunkDisplay"),
      readerStatus: document.getElementById("readerStatus"),
      progressLabel: document.getElementById("progressLabel"),
      progressPercent: document.getElementById("progressPercent"),
      progressFill: document.getElementById("progressFill"),
      playButton: document.getElementById("playButton"),
      pauseButton: document.getElementById("pauseButton"),
      restartButton: document.getElementById("restartButton"),
      previousButton: document.getElementById("previousButton"),
      nextButton: document.getElementById("nextButton"),
      backButton: document.getElementById("backButton"),
      fullscreenButton: document.getElementById("fullscreenButton"),
      readerSpeedValue: document.getElementById("readerSpeedValue"),
      readerFontValue: document.getElementById("readerFontValue"),
      readerPositionValue: document.getElementById("readerPositionValue"),
      libraryList: document.getElementById("libraryList"),
      libraryStatus: document.getElementById("libraryStatus"),
      themeToggles: [...document.querySelectorAll("[data-theme-toggle]")],
      scriptViewButtons: [...document.querySelectorAll("[data-script-view]")],
      scriptViewPanels: [...document.querySelectorAll("[data-script-view-panel]")],
      chunkButtons: [...document.querySelectorAll("[data-chunk-size]")],
      speedStepButtons: [...document.querySelectorAll("[data-speed-step]")],
      fontStepButtons: [...document.querySelectorAll("[data-font-step]")],
      positionStepButtons: [...document.querySelectorAll("[data-position-step]")],
    };

    this.bindEvents();
    this.applySettingsToUI();
    this.setScriptView(this.activeScriptView);
    this.loadLibraryItems();
    this.updateScriptMetrics();
    this.renderReader({
      chunk: null,
      displayIndex: 0,
      totalChunks: 0,
      progressPercent: 0,
      isPlaying: false,
      isFinished: false,
      wordsPerMinute: this.settings.wordsPerMinute,
      chunkSize: this.settings.chunkSize,
    });
  }

  bindEvents() {
    this.elements.scriptInput.addEventListener("input", () => {
      this.setScriptSourceLabel("Editing draft");
      this.clearValidationMessage();
      this.updateScriptMetrics();
    });

    this.elements.scriptViewButtons.forEach((button) => {
      button.addEventListener("click", () => {
        this.setScriptView(button.dataset.scriptView);
      });
    });

    this.elements.libraryList.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-library-index]");

      if (!trigger) {
        return;
      }

      const libraryItem = this.libraryItems[Number(trigger.dataset.libraryIndex)];

      if (libraryItem) {
        this.loadLibraryItem(libraryItem);
      }
    });

    this.elements.speedInput.addEventListener("input", (event) => {
      this.updateWordsPerMinute(Number(event.target.value));
    });

    this.elements.fontSizeInput.addEventListener("input", (event) => {
      this.updateFontSize(Number(event.target.value));
    });

    this.elements.positionInput.addEventListener("input", (event) => {
      this.updateVerticalOffset(Number(event.target.value));
    });

    this.elements.chunkButtons.forEach((button) => {
      button.addEventListener("click", () => {
        this.updateChunkSize(Number(button.dataset.chunkSize));
      });
    });

    this.elements.speedStepButtons.forEach((button) => {
      button.addEventListener("click", () => {
        this.updateWordsPerMinute(this.settings.wordsPerMinute + Number(button.dataset.speedStep));
      });
    });

    this.elements.fontStepButtons.forEach((button) => {
      button.addEventListener("click", () => {
        this.updateFontSize(this.settings.fontSize + Number(button.dataset.fontStep));
      });
    });

    this.elements.positionStepButtons.forEach((button) => {
      button.addEventListener("click", () => {
        this.updateVerticalOffset(
          this.settings.verticalOffset + Number(button.dataset.positionStep)
        );
      });
    });

    this.elements.startButton.addEventListener("click", () => this.startReading());
    this.elements.playButton.addEventListener("click", () => this.engine.play());
    this.elements.pauseButton.addEventListener("click", () => this.engine.pause());
    this.elements.restartButton.addEventListener("click", () => this.engine.restart());
    this.elements.previousButton.addEventListener("click", () => this.engine.previous());
    this.elements.nextButton.addEventListener("click", () => this.engine.next());
    this.elements.backButton.addEventListener("click", () => this.exitReadingMode());
    this.elements.fullscreenButton.addEventListener("click", () => this.toggleFullscreen());

    this.elements.themeToggles.forEach((button) => {
      button.addEventListener("click", () => this.toggleTheme());
    });

    document.addEventListener("keydown", (event) => this.handleKeyboardShortcuts(event));
    document.addEventListener("fullscreenchange", () => this.handleViewportChange());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && !this.elements.readerView.hidden && this.engine.isPlaying) {
        this.engine.pause();
      }
    });
    window.addEventListener("resize", () => this.handleViewportChange());
  }

  setScriptSourceLabel(label) {
    this.elements.scriptSourceLabel.textContent = label;
  }

  setScriptView(viewName) {
    this.activeScriptView = viewName === "library" ? "library" : "editor";

    this.elements.scriptViewButtons.forEach((button) => {
      const isActive = button.dataset.scriptView === this.activeScriptView;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });

    this.elements.scriptViewPanels.forEach((panel) => {
      panel.hidden = panel.dataset.scriptViewPanel !== this.activeScriptView;
    });
  }

  loadLibraryItems() {
    const rawLibraryItems = Array.isArray(window.PROMPTER_LIBRARY)
      ? window.PROMPTER_LIBRARY
      : [];

    this.libraryItems = rawLibraryItems
      .map((item, index) => {
        if (!item || typeof item.content !== "string") {
          return null;
        }

        const content = item.content.trim();

        if (!content) {
          return null;
        }

        const fileName =
          typeof item.fileName === "string" && item.fileName.trim()
            ? item.fileName.trim()
            : `script-${index + 1}.txt`;

        return {
          title:
            typeof item.title === "string" && item.title.trim()
              ? item.title.trim()
              : formatLibraryTitle(fileName),
          fileName,
          description:
            typeof item.description === "string" && item.description.trim()
              ? item.description.trim()
              : "Saved text file",
          content,
          preview: buildLibraryPreview(content),
          wordCount: ScriptParser.tokenize(content).length,
        };
      })
      .filter(Boolean);

    this.renderLibraryItems();
  }

  renderLibraryItems() {
    this.elements.libraryList.textContent = "";

    if (!this.libraryItems.length) {
      const emptyState = document.createElement("div");
      emptyState.className = "library-empty";
      emptyState.textContent = "No saved scripts have been added yet.";
      this.elements.libraryList.append(emptyState);
      this.elements.libraryStatus.textContent = "0 saved scripts";
      return;
    }

    this.libraryItems.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "library-item";
      button.dataset.libraryIndex = String(index);

      const copy = document.createElement("span");
      copy.className = "library-item-copy";

      const title = document.createElement("span");
      title.className = "library-item-title";
      title.textContent = item.title;

      const fileName = document.createElement("span");
      fileName.className = "library-item-file";
      fileName.textContent = item.fileName;

      const description = document.createElement("span");
      description.className = "library-item-description";
      description.textContent = item.description;

      const preview = document.createElement("span");
      preview.className = "library-item-preview";
      preview.textContent = item.preview;

      const meta = document.createElement("span");
      meta.className = "library-item-meta";
      meta.textContent = `${item.wordCount} ${item.wordCount === 1 ? "word" : "words"}`;

      const action = document.createElement("span");
      action.className = "library-item-action";
      action.textContent = "Load";

      copy.append(title, fileName, description, preview);
      button.append(copy, meta, action);
      this.elements.libraryList.append(button);
    });

    this.elements.libraryStatus.textContent = `${this.libraryItems.length} saved ${
      this.libraryItems.length === 1 ? "script" : "scripts"
    }`;
  }

  loadLibraryItem(item) {
    this.elements.scriptInput.value = item.content;
    this.setScriptSourceLabel(`Library: ${item.fileName}`);
    this.updateScriptMetrics();
    this.elements.validationMessage.textContent = `Loaded ${item.fileName}. You can edit it or press Load Script.`;
    this.elements.libraryStatus.textContent = `Loaded ${item.fileName} into the editor.`;
    this.setScriptView("editor");
    this.elements.scriptInput.focus();
  }

  updateWordsPerMinute(wordsPerMinute) {
    this.settings.wordsPerMinute = clamp(
      Number(wordsPerMinute) || DEFAULT_SETTINGS.wordsPerMinute,
      SETTING_LIMITS.wordsPerMinute.min,
      SETTING_LIMITS.wordsPerMinute.max
    );
    this.applySettingsToUI();
    this.updateScriptMetrics();
    saveSettings(this.settings);
    this.engine.setWordsPerMinute(this.settings.wordsPerMinute);
  }

  updateFontSize(fontSize) {
    this.settings.fontSize = clamp(
      Number(fontSize) || DEFAULT_SETTINGS.fontSize,
      SETTING_LIMITS.fontSize.min,
      SETTING_LIMITS.fontSize.max
    );
    this.applySettingsToUI();
    saveSettings(this.settings);
  }

  updateVerticalOffset(verticalOffset) {
    const bounds = this.getVerticalOffsetBounds();
    this.settings.verticalOffset = clamp(
      Number(verticalOffset) || DEFAULT_SETTINGS.verticalOffset,
      bounds.min,
      bounds.max
    );
    this.applySettingsToUI();
    saveSettings(this.settings);
  }

  updateChunkSize(chunkSize) {
    this.settings.chunkSize = clamp(
      Number(chunkSize) || DEFAULT_SETTINGS.chunkSize,
      SETTING_LIMITS.chunkSize.min,
      SETTING_LIMITS.chunkSize.max
    );
    this.applySettingsToUI();
    this.updateScriptMetrics();
    saveSettings(this.settings);
    this.engine.setChunkSize(this.settings.chunkSize);
  }

  toggleTheme() {
    this.settings.theme = this.settings.theme === "dark" ? "light" : "dark";
    this.applySettingsToUI();
    saveSettings(this.settings);
  }

  applySettingsToUI() {
    const verticalOffsetBounds = this.syncVerticalOffsetBounds();

    this.elements.body.dataset.theme = this.settings.theme;
    document.documentElement.style.setProperty(
      "--reader-font-size",
      `${this.settings.fontSize}px`
    );
    document.documentElement.style.setProperty(
      "--reader-offset-y",
      `${this.settings.verticalOffset}px`
    );

    this.elements.speedInput.value = String(this.settings.wordsPerMinute);
    this.elements.fontSizeInput.value = String(this.settings.fontSize);
    this.elements.positionInput.value = String(this.settings.verticalOffset);

    this.elements.speedValue.textContent = `${this.settings.wordsPerMinute} WPM`;
    this.elements.readerSpeedValue.textContent = `${this.settings.wordsPerMinute} WPM`;
    this.elements.fontSizeValue.textContent = `${this.settings.fontSize} px`;
    this.elements.readerFontValue.textContent = `${this.settings.fontSize} px`;
    this.elements.positionValue.textContent = formatVerticalOffset(
      this.settings.verticalOffset,
      verticalOffsetBounds
    );
    this.elements.readerPositionValue.textContent = formatVerticalOffset(
      this.settings.verticalOffset,
      verticalOffsetBounds
    );
    this.elements.chunkSizeValue.textContent = `${this.settings.chunkSize} ${
      this.settings.chunkSize === 1 ? "word" : "words"
    }`;

    this.elements.chunkButtons.forEach((button) => {
      const isActive = Number(button.dataset.chunkSize) === this.settings.chunkSize;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });

    this.elements.themeToggles.forEach((button) => {
      button.textContent = this.settings.theme === "dark" ? "Light View" : "Dark View";
    });

    this.updateFullscreenButtonLabel();
  }

  getVerticalOffsetBounds() {
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight || 0;
    const estimatedHalfTextHeight = Math.max(10, this.settings.fontSize * 0.58);
    const availableTravel = Math.max(
      0,
      viewportHeight / 2 - estimatedHalfTextHeight
    );
    const snappedTravel = Math.floor(availableTravel / 4) * 4;

    return {
      min: -snappedTravel,
      max: snappedTravel,
    };
  }

  syncVerticalOffsetBounds() {
    const bounds = this.getVerticalOffsetBounds();

    this.settings.verticalOffset = clamp(
      this.settings.verticalOffset,
      bounds.min,
      bounds.max
    );
    this.elements.positionInput.min = String(bounds.min);
    this.elements.positionInput.max = String(bounds.max);

    return bounds;
  }

  handleViewportChange() {
    this.applySettingsToUI();
    saveSettings(this.settings);
  }

  updateScriptMetrics() {
    const tokens = ScriptParser.tokenize(this.elements.scriptInput.value);
    const chunks = ScriptParser.buildChunks(tokens, this.settings.chunkSize);
    const hasScript = tokens.length > 0;

    this.elements.wordCountLabel.textContent = `${tokens.length} ${
      tokens.length === 1 ? "word" : "words"
    }`;
    this.elements.chunkCountLabel.textContent = `${chunks.length} ${
      chunks.length === 1 ? "chunk" : "chunks"
    }`;
    this.elements.runtimeLabel.textContent = `${formatDurationFromWords(
      tokens.length,
      this.settings.wordsPerMinute
    )} read time`;

    this.elements.startButton.disabled = !hasScript;

    if (!hasScript) {
      this.elements.validationMessage.textContent = "Paste a script to load it into reading mode.";
    } else {
      this.clearValidationMessage();
    }
  }

  clearValidationMessage() {
    if (ScriptParser.tokenize(this.elements.scriptInput.value).length > 0) {
      this.elements.validationMessage.textContent =
        "Load the reader first, then press Play when you are ready.";
    }
  }

  startReading() {
    const scriptText = this.elements.scriptInput.value;
    const tokens = ScriptParser.tokenize(scriptText);

    if (!tokens.length) {
      this.elements.validationMessage.textContent = "Paste a script before loading the reader.";
      this.elements.scriptInput.focus();
      return;
    }

    this.engine.loadScript(scriptText, {
      chunkSize: this.settings.chunkSize,
      wordsPerMinute: this.settings.wordsPerMinute,
    });

    if (!this.engine.hasScript()) {
      this.elements.validationMessage.textContent = "The script does not contain readable words yet.";
      return;
    }

    this.elements.readerView.hidden = false;
    this.elements.body.classList.add("reader-active");
  }

  exitReadingMode() {
    this.engine.pause();
    this.elements.readerView.hidden = true;
    this.elements.body.classList.remove("reader-active");

    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      Promise.resolve()
        .then(() => document.exitFullscreen())
        .catch(() => {});
    }
  }

  renderReader(snapshot) {
    const currentText = snapshot.chunk?.text || "Ready";

    if (this.elements.chunkDisplay.textContent !== currentText) {
      this.elements.chunkDisplay.classList.remove("is-swapping");
      this.elements.chunkDisplay.textContent = currentText;
      void this.elements.chunkDisplay.offsetWidth;
      this.elements.chunkDisplay.classList.add("is-swapping");
    }

    this.elements.progressLabel.textContent = `${snapshot.displayIndex} / ${snapshot.totalChunks}`;
    this.elements.progressPercent.textContent = `${Math.round(snapshot.progressPercent)}%`;
    this.elements.progressFill.style.width = `${snapshot.progressPercent}%`;

    if (!snapshot.totalChunks) {
      this.elements.readerStatus.textContent = "Ready";
    } else if (snapshot.isFinished) {
      this.elements.readerStatus.textContent = "Finished";
    } else if (snapshot.isPlaying) {
      this.elements.readerStatus.textContent = `Playing at ${snapshot.wordsPerMinute} WPM`;
    } else {
      this.elements.readerStatus.textContent = "Paused";
    }

    this.elements.playButton.disabled = !snapshot.totalChunks || snapshot.isPlaying;
    this.elements.pauseButton.disabled = !snapshot.totalChunks || !snapshot.isPlaying;
    this.elements.restartButton.disabled = !snapshot.totalChunks;
    this.elements.previousButton.disabled = snapshot.displayIndex <= 1;
    this.elements.nextButton.disabled =
      !snapshot.totalChunks || snapshot.displayIndex >= snapshot.totalChunks;
  }

  handleKeyboardShortcuts(event) {
    const activeElement = document.activeElement;
    const isTyping =
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLInputElement;

    if (isTyping) {
      return;
    }

    const isReaderVisible = !this.elements.readerView.hidden;

    if (!isReaderVisible) {
      return;
    }

    if (event.code === "Space") {
      event.preventDefault();
      if (this.engine.isPlaying) {
        this.engine.pause();
      } else {
        this.engine.play();
      }
      return;
    }

    if (event.code === "ArrowLeft") {
      event.preventDefault();
      this.engine.previous();
      return;
    }

    if (event.code === "ArrowRight") {
      event.preventDefault();
      this.engine.next();
      return;
    }

    if (event.code === "ArrowUp") {
      event.preventDefault();
      this.updateWordsPerMinute(this.settings.wordsPerMinute + 5);
      return;
    }

    if (event.code === "ArrowDown") {
      event.preventDefault();
      this.updateWordsPerMinute(this.settings.wordsPerMinute - 5);
    }
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      if (typeof this.elements.readerView.requestFullscreen === "function") {
        Promise.resolve()
          .then(() => this.elements.readerView.requestFullscreen())
          .catch(() => {});
      }
      return;
    }

    if (typeof document.exitFullscreen === "function") {
      Promise.resolve()
        .then(() => document.exitFullscreen())
        .catch(() => {});
    }
  }

  updateFullscreenButtonLabel() {
    this.elements.fullscreenButton.textContent = document.fullscreenElement
      ? "Exit Fullscreen"
      : "Fullscreen";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new PrompterApp();
});
