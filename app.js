/**
 * AI Imagination Studio — uses local server proxy (/api/image)
 * Requires: python server.py  (NOT python -m http.server)
 */

const FETCH_TIMEOUT_MS = 180_000;

/** Size scale + placeholdr.dev style (Pollinations often returns 402) */
const SPEED_PRESETS = {
  fast: { model: 'turbo', style: 'photographic', scale: 1 },
  balanced: { model: 'turbo', style: 'artistic', scale: 1.25 },
  quality: { model: 'flux', style: 'oil-painting', scale: 1.5 },
};

const ASPECT_BASE = {
  '1:1': { w: 384, h: 384 },
  '16:9': { w: 448, h: 252 },
  '9:16': { w: 252, h: 448 },
};

const elements = {
  promptInput: document.getElementById('prompt-input'),
  generateBtn: document.getElementById('generate-btn'),
  accordionToggle: document.getElementById('accordion-toggle'),
  accordionPanel: document.getElementById('advanced-panel'),
  accordionChevron: document.getElementById('accordion-chevron'),
  previewContainer: document.getElementById('preview-container'),
  emptyState: document.getElementById('empty-state'),
  loadingState: document.getElementById('loading-state'),
  errorState: document.getElementById('error-state'),
  errorMessage: document.getElementById('error-message'),
  loadingStatus: document.getElementById('loading-status'),
  resultImage: document.getElementById('result-image'),
};

const state = {
  isGenerating: false,
  currentRequestId: 0,
  objectUrl: null,
  loadingTimer: null,
  loadingStartedAt: 0,
};

const UI = {
  setAccordionOpen(open) {
    elements.accordionToggle.setAttribute('aria-expanded', String(open));
    elements.accordionPanel.setAttribute('aria-hidden', String(!open));
    elements.accordionPanel.classList.toggle('is-open', open);
  },

  showEmpty() {
    elements.emptyState.classList.remove('hidden');
    elements.loadingState.classList.add('hidden');
    elements.loadingState.classList.remove('flex');
    elements.errorState.classList.add('hidden');
    elements.errorState.classList.remove('flex');
    elements.previewContainer.classList.remove('is-loading', 'has-image');
    this.hideImage();
  },

  showLoading() {
    elements.emptyState.classList.add('hidden');
    elements.errorState.classList.add('hidden');
    elements.errorState.classList.remove('flex');
    elements.loadingState.classList.remove('hidden');
    elements.loadingState.classList.add('flex');
    elements.previewContainer.classList.add('is-loading');
    elements.previewContainer.classList.remove('has-image');
    this.startLoadingTimer();
  },

  startLoadingTimer() {
    this.stopLoadingTimer();
    state.loadingStartedAt = Date.now();
    const tick = () => {
      const sec = Math.floor((Date.now() - state.loadingStartedAt) / 1000);
      if (elements.loadingStatus) {
        elements.loadingStatus.textContent = `Generating… ${sec}s (usually 15–45s on Fast mode)`;
      }
    };
    tick();
    state.loadingTimer = setInterval(tick, 1000);
  },

  stopLoadingTimer() {
    if (state.loadingTimer) {
      clearInterval(state.loadingTimer);
      state.loadingTimer = null;
    }
  },

  showError(message) {
    this.stopLoadingTimer();
    elements.emptyState.classList.add('hidden');
    elements.loadingState.classList.add('hidden');
    elements.loadingState.classList.remove('flex');
    elements.errorState.classList.remove('hidden');
    elements.errorState.classList.add('flex');
    elements.errorMessage.textContent = message;
    elements.previewContainer.classList.remove('is-loading');
    this.hideImage();
  },

  revokeObjectUrl() {
    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = null;
    }
  },

  hideImage() {
    const img = elements.resultImage;
    img.onload = null;
    img.onerror = null;
    img.classList.add('hidden');
    img.classList.remove('is-visible');
    img.style.opacity = '0';
    img.removeAttribute('src');
    this.revokeObjectUrl();
  },

  revealImage() {
    this.stopLoadingTimer();
    const img = elements.resultImage;
    img.classList.remove('hidden');
    elements.previewContainer.classList.remove('is-loading');
    elements.previewContainer.classList.add('has-image');
    elements.loadingState.classList.add('hidden');
    elements.loadingState.classList.remove('flex');
    requestAnimationFrame(() => {
      img.classList.add('is-visible');
      img.style.opacity = '1';
    });
  },

  setGenerateDisabled(disabled) {
    elements.generateBtn.disabled = disabled;
  },
};

function getSpeedSettings() {
  const speed =
    document.querySelector('input[name="speed"]:checked')?.value ?? 'fast';
  return SPEED_PRESETS[speed] ?? SPEED_PRESETS.fast;
}

function getDimensions() {
  const aspect =
    document.querySelector('input[name="aspect-ratio"]:checked')?.value ?? '1:1';
  const base = ASPECT_BASE[aspect] ?? ASPECT_BASE['1:1'];
  const { scale, model, style } = getSpeedSettings();
  return {
    width: Math.round(base.w * scale),
    height: Math.round(base.h * scale),
    model,
    style,
  };
}

function buildProxyUrl(prompt) {
  const { width, height, model, style } = getDimensions();

  const params = new URLSearchParams({
    prompt: prompt.trim(),
    width: String(width),
    height: String(height),
    model,
    style,
    seed: String(Date.now()),
  });

  return `/api/image?${params}`;
}

async function fetchImageFromProxy(url, requestId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      let msg = `Server error (${response.status})`;
      if (response.status === 404) {
        msg =
          'Wrong server running. Stop it and run: python server.py — then open http://localhost:8765';
      } else {
        try {
          const body = await response.json();
          msg = body.error || msg;
        } catch {
          /* keep msg */
        }
      }
      throw new Error(msg);
    }

    const blob = await response.blob();
    if (!blob.type.startsWith('image/') && blob.size < 1000) {
      throw new Error('Server did not return a valid image.');
    }

    if (requestId !== state.currentRequestId) return null;
    return URL.createObjectURL(blob);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Timed out after 3 minutes. Try a shorter prompt.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

const Generator = {
  validatePrompt(prompt) {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return { valid: false, message: 'Please enter a prompt to generate an image.' };
    }
    if (trimmed.length > 2000) {
      return { valid: false, message: 'Prompt is too long. Please shorten it and try again.' };
    }
    return { valid: true, prompt: trimmed };
  },

  async generate() {
    if (state.isGenerating) return;

    if (window.location.protocol === 'file:') {
      UI.showError(
        'Do not open the HTML file directly. Run "python server.py" then open http://localhost:8765'
      );
      elements.emptyState.classList.add('hidden');
      return;
    }

    const validation = this.validatePrompt(elements.promptInput.value);
    if (!validation.valid) {
      UI.showError(validation.message);
      elements.emptyState.classList.add('hidden');
      return;
    }

    const requestId = ++state.currentRequestId;
    state.isGenerating = true;
    UI.setGenerateDisabled(true);
    UI.showLoading();

    const img = elements.resultImage;
    img.alt = `AI generated: ${validation.prompt.slice(0, 120)}`;
    const proxyUrl = buildProxyUrl(validation.prompt);

    try {
      const objectUrl = await fetchImageFromProxy(proxyUrl, requestId);
      if (!objectUrl || requestId !== state.currentRequestId) return;

      UI.revokeObjectUrl();
      state.objectUrl = objectUrl;

      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to display image.'));
        img.src = objectUrl;
      });

      if (requestId !== state.currentRequestId) return;
      state.isGenerating = false;
      UI.setGenerateDisabled(false);
      UI.revealImage();
    } catch (err) {
      if (requestId !== state.currentRequestId) return;
      state.isGenerating = false;
      UI.setGenerateDisabled(false);
      UI.showError(err.message || 'Generation failed. Please try again.');
    }
  },
};

elements.generateBtn.addEventListener('click', () => Generator.generate());
elements.promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    Generator.generate();
  }
});
elements.accordionToggle.addEventListener('click', () => {
  const isOpen = elements.accordionToggle.getAttribute('aria-expanded') === 'true';
  UI.setAccordionOpen(!isOpen);
});

UI.showEmpty();
