/**
 * Main application logic
 */

(function() {
  'use strict';
  
  // Storage keys for localStorage
  const STORAGE_KEYS = {
    editorContent: 'facto-editor-content'
  };
  
  // DOM Elements
  let editor;
  const elements = {
    compileBtn: document.getElementById('compile-btn'),
    btnText: document.querySelector('.btn-text'),
    btnIcon: document.querySelector('.btn-icon'),
    btnSpinner: document.querySelector('.btn-spinner'),
    exampleSelect: document.getElementById('example-select'),
    clearEditorBtn: document.getElementById('clear-editor'),
    blueprintName: document.getElementById('blueprint-name'),
    powerPoles: document.getElementById('power-poles'),
    logLevel: document.getElementById('log-level'),
    noOptimize: document.getElementById('no-optimize'),
    logOutput: document.getElementById('log-output'),
    blueprintStatus: document.getElementById('blueprint-status'),
    blueprintOutput: document.getElementById('blueprint-output'),
    blueprintText: document.getElementById('blueprint-text'),
    copyBlueprint: document.getElementById('copy-blueprint'),
    downloadBlueprint: document.getElementById('download-blueprint'),
    // JSON tab elements
    jsonStatus: document.getElementById('json-status'),
    jsonOutputContainer: document.getElementById('json-output-container'),
    jsonText: document.getElementById('json-text'),
    copyJson: document.getElementById('copy-json'),
    downloadJson: document.getElementById('download-json'),
    // Modal elements
    confirmModal: document.getElementById('confirm-modal'),
    modalCancel: document.getElementById('modal-cancel'),
    modalConfirm: document.getElementById('modal-confirm'),
    // Accordion elements
    accordionToggle: document.getElementById('accordion-toggle'),
    accordionContent: document.getElementById('accordion-content'),
    // Theme toggle
    themeToggle: document.getElementById('theme-toggle'),
    // Other
    tabBtns: document.querySelectorAll('.tab-btn'),
    toastContainer: document.getElementById('toast-container'),
    statusIndicator: document.getElementById('status-indicator'),
    statusDot: document.querySelector('#status-indicator .status-dot')
  };
  
  // State
  let isCompiling = false;
  let serverConnected = false;
  let healthCheckInterval = null;
  let lastCompiledSource = null;
  
  /**
   * Debounce utility function
   */
  function debounce(fn, delay) {
    let timeoutId;
    return (...args) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn(...args), delay);
    };
  }
  
  /**
   * Save editor content to localStorage
   */
  function saveEditorContent() {
    const content = editor.getValue();
    if (content.trim()) {
      localStorage.setItem(STORAGE_KEYS.editorContent, content);
    } else {
      localStorage.removeItem(STORAGE_KEYS.editorContent);
    }
  }
  
  /**
   * Load editor content from localStorage
   */
  function loadEditorContent() {
    return localStorage.getItem(STORAGE_KEYS.editorContent);
  }
  
  // Debounced save function
  const debouncedSave = debounce(saveEditorContent, 1000);
  
  /**
   * Initialize the application
   */
  async function init() {
    // Initialize theme manager first
    if (window.ThemeManager) {
      window.ThemeManager.init();
    }
    
    // Initialize CodeMirror editor
    editor = window.FactoEditor.init('code-editor');
    
    // Get the first example key as default
    const exampleKeys = Object.keys(window.FactoEditor.examples);
    const defaultExampleKey = exampleKeys[0] || 'blinker';
    
    // Load saved content or default example
    const savedContent = loadEditorContent();
    let loadedExampleKey = null;
    
    if (savedContent) {
      editor.setValue(savedContent);
      // Try to match saved content to an example
      for (const key of exampleKeys) {
        if (window.FactoEditor.examples[key] === savedContent) {
          loadedExampleKey = key;
          break;
        }
      }
    } else {
      editor.setValue(window.FactoEditor.examples[defaultExampleKey]);
      loadedExampleKey = defaultExampleKey;
    }
    
    // Listen for changes and save (also reset lastCompiledSource)
    editor.on('change', () => {
      debouncedSave();
      lastCompiledSource = null;
    });
    
    // Update CodeMirror theme based on current theme
    if (window.ThemeManager) {
      window.ThemeManager.updateCodeMirrorTheme(window.ThemeManager.getTheme());
    }
    
    // Bind event listeners
    bindEvents();
    
    // Populate example dropdown with built-in examples
    populateExampleDropdown(loadedExampleKey);
    
    // Start health checks
    startHealthChecks();
  }
  
  /**
   * Bind all event listeners
   */
  function bindEvents() {
    // Compile button
    elements.compileBtn.addEventListener('click', handleCompile);
    
    // Keyboard shortcut (Ctrl+Enter)
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleCompile();
      }
      // Close modal on Escape
      if (e.key === 'Escape' && !elements.confirmModal.classList.contains('hidden')) {
        hideConfirmModal();
      }
    });
    
    // Example select dropdown
    elements.exampleSelect.addEventListener('change', handleExampleSelect);
    
    // Clear editor button - show confirmation modal
    elements.clearEditorBtn.addEventListener('click', () => {
      if (editor.getValue().trim()) {
        showConfirmModal();
      }
    });
    
    // Modal event handlers
    elements.modalCancel.addEventListener('click', hideConfirmModal);
    elements.modalConfirm.addEventListener('click', () => {
      editor.setValue('');
      editor.focus();
      saveEditorContent();
      hideConfirmModal();
    });
    elements.confirmModal.querySelector('.modal-backdrop').addEventListener('click', hideConfirmModal);
    
    // Accordion toggle for mobile
    if (elements.accordionToggle) {
      elements.accordionToggle.addEventListener('click', toggleAccordion);
    }
    
    // Theme toggle
    if (elements.themeToggle) {
      elements.themeToggle.addEventListener('click', () => {
        if (window.ThemeManager) {
          window.ThemeManager.toggle();
        }
      });
    }
    
    // Tab switching
    elements.tabBtns.forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    
    // Copy blueprint
    elements.copyBlueprint.addEventListener('click', copyBlueprintToClipboard);
    
    // Download blueprint
    elements.downloadBlueprint.addEventListener('click', downloadBlueprint);
    
    // Copy JSON
    if (elements.copyJson) {
      elements.copyJson.addEventListener('click', copyJsonToClipboard);
    }
    
    // Download JSON
    if (elements.downloadJson) {
      elements.downloadJson.addEventListener('click', downloadJson);
    }
  }
  
  /**
   * Show confirmation modal
   */
  function showConfirmModal() {
    elements.confirmModal.classList.remove('hidden');
  }
  
  /**
   * Hide confirmation modal
   */
  function hideConfirmModal() {
    elements.confirmModal.classList.add('hidden');
  }
  
  /**
   * Toggle accordion for mobile
   */
  function toggleAccordion() {
    elements.accordionToggle.classList.toggle('expanded');
    elements.accordionContent.classList.toggle('expanded');
  }
  
  /**
   * Update connection status indicator
   */
  function updateConnectionStatus(status) {
    const statusDot = elements.statusDot;
    const statusIndicator = elements.statusIndicator;
    
    if (!statusDot || !statusIndicator) return;
    
    statusDot.className = 'status-dot';
    
    if (status === 'connected') {
      statusDot.classList.add('connected');
      statusIndicator.title = 'Backend connected';
      serverConnected = true;
    } else if (status === 'connecting') {
      statusDot.classList.add('connecting');
      statusIndicator.title = 'Connecting to backend...';
      serverConnected = false;
    } else {
      statusDot.classList.add('disconnected');
      statusIndicator.title = 'Backend disconnected';
      serverConnected = false;
    }
  }
  
  /**
   * Check if backend is healthy
   */
  async function checkBackendHealth(showNotification = false, recordSession = false) {
    updateConnectionStatus('connecting');
    
    const isHealthy = await window.FactoCompiler.checkHealth();
    
    if (isHealthy) {
      updateConnectionStatus('connected');
      if (recordSession) {
        // Record the session visit (only on first successful connect)
        await window.FactoCompiler.connect();
      }
      if (showNotification) {
        showToast('Connected to server', 'success');
      }
    } else {
      updateConnectionStatus('disconnected');
      if (showNotification) {
        showToast('Backend server is not responding. Check if server is running.', 'error');
      }
    }
    
    return isHealthy;
  }
  
  /**
   * Start periodic health checks
   */
  function startHealthChecks() {
    // Initial check with session recording
    checkBackendHealth(false, true);
    
    // Check every 10 seconds (no session recording)
    healthCheckInterval = setInterval(() => {
      checkBackendHealth(false, false);
    }, 10000);
  }
  
  /**
   * Stop periodic health checks
   */
  function stopHealthChecks() {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
  }
  
  /**
   * Get compilation key for caching
   */
  function getCompilationKey(source, options) {
    return JSON.stringify({
      source: source,
      powerPoles: options.powerPoles,
      blueprintName: options.blueprintName,
      noOptimize: options.noOptimize,
      logLevel: options.logLevel
    });
  }
  
  /**
   * Handle compile button click
   */
  async function handleCompile() {
    if (isCompiling) return;
    
    // Check server connection
    if (!serverConnected) {
      showToast('Server not connected. Checking connection...', 'error');
      const isHealthy = await checkBackendHealth(true);
      if (!isHealthy) {
        return;
      }
    }
    
    const source = editor.getValue().trim();
    
    if (!source) {
      showToast('Please enter some Facto code to compile', 'error');
      return;
    }
    
    // Get options (no more jsonOutput)
    const options = {
      blueprintName: elements.blueprintName.value.trim() || null,
      powerPoles: elements.powerPoles.value || null,
      logLevel: elements.logLevel.value,
      noOptimize: elements.noOptimize.checked
    };
    
    // Check if code is unchanged from last successful compilation
    const currentKey = getCompilationKey(source, options);
    if (lastCompiledSource === currentKey && elements.blueprintText.value) {
      showToast('Code unchanged - showing previous result', 'warning');
      switchTab('blueprint');
      return;
    }
    
    // Update UI
    setCompiling(true);
    clearLog();
    clearJson();
    clearBlueprint();
    switchTab('log');
    
    // Compile with streaming
    let hasError = false;
    try {
      await window.FactoCompiler.compileWithStreaming(source, options, {
        onLog: (message) => appendLog(message, 'info'),
        onBlueprint: (blueprint) => setBlueprint(blueprint),
        onJson: (json) => setJson(json),
        onError: (error) => {
          hasError = true;
          appendLog(error, 'error');
          // Check if server connection lost
          if (error.includes('Failed to fetch') || error.includes('NetworkError')) {
            updateConnectionStatus('disconnected');
            checkBackendHealth(false);
          }
        },
        onStatus: (status) => appendLog(status, 'status'),
        onQueue: (position) => {
          updateQueueDisplay(parseInt(position, 10));
        },
        onComplete: () => {
          setCompiling(false);
          hideQueueDisplay();
          
          // Auto-switch to blueprint tab if successful
          if (elements.blueprintText.value) {
            lastCompiledSource = currentKey;
            switchTab('blueprint');
            showToast('Compilation successful! Blueprint ready to copy.', 'success');
          } else if (hasError) {
            showToast('Compilation failed. Check the log for details.', 'error');
          }
        }
      });
    } catch (error) {
      // Ensure we always stop the spinner even if there's an unexpected error
      setCompiling(false);
      hideQueueDisplay();
      appendLog(`Unexpected error: ${error.message}`, 'error');
      showToast('Compilation failed. Check the log for details.', 'error');
    }
  }
  
  /**
   * Set compiling state
   */
  function setCompiling(compiling) {
    isCompiling = compiling;
    elements.compileBtn.disabled = compiling;
    elements.compileBtn.classList.toggle('compiling', compiling);
    elements.btnText.textContent = compiling ? 'Compiling...' : 'Compile';
  }
  
  /**
   * Update queue display in compile button
   */
  function updateQueueDisplay(position) {
    if (position > 0) {
      elements.btnText.textContent = `Queue: ${position}`;
    } else {
      elements.btnText.textContent = 'Compiling...';
    }
  }
  
  /**
   * Hide queue display
   */
  function hideQueueDisplay() {
    // Reset handled by setCompiling
  }
  
  /**
   * Clear log output
   */
  function clearLog() {
    elements.logOutput.innerHTML = '';
  }
  
  /**
   * Append message to log
   */
  function appendLog(message, type = 'info') {
    // Remove placeholder if present
    const placeholder = elements.logOutput.querySelector('.log-placeholder');
    if (placeholder) {
      placeholder.remove();
    }
    
    const line = document.createElement('div');
    line.className = `log-line log-${type}`;
    line.textContent = message;
    elements.logOutput.appendChild(line);
    
    // Auto-scroll to bottom
    elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
  }
  
  /**
   * Clear blueprint output
   */
  function clearBlueprint() {
    elements.blueprintText.value = '';
    elements.blueprintStatus.classList.remove('hidden');
    elements.blueprintOutput.classList.remove('visible');
  }
  
  /**
   * Set blueprint output
   */
  function setBlueprint(blueprint) {
    elements.blueprintText.value = blueprint;
    elements.blueprintStatus.classList.add('hidden');
    elements.blueprintOutput.classList.add('visible');
  }
  
  /**
   * Clear JSON output
   */
  function clearJson() {
    if (elements.jsonText) {
      elements.jsonText.value = '';
    }
    if (elements.jsonStatus) {
      elements.jsonStatus.classList.remove('hidden');
    }
    if (elements.jsonOutputContainer) {
      elements.jsonOutputContainer.classList.remove('visible');
    }
  }
  
  /**
   * Set JSON output
   */
  function setJson(jsonStr) {
    if (!elements.jsonText) return;
    
    // Pretty print the JSON
    try {
      const parsed = JSON.parse(jsonStr);
      elements.jsonText.value = JSON.stringify(parsed, null, 2);
    } catch {
      elements.jsonText.value = jsonStr;
    }
    
    if (elements.jsonStatus) {
      elements.jsonStatus.classList.add('hidden');
    }
    if (elements.jsonOutputContainer) {
      elements.jsonOutputContainer.classList.add('visible');
    }
  }
  
  /**
   * Copy JSON to clipboard
   */
  async function copyJsonToClipboard() {
    const json = elements.jsonText?.value;
    
    if (!json) {
      showToast('No JSON to copy', 'error');
      return;
    }
    
    try {
      await navigator.clipboard.writeText(json);
      showToast('JSON copied to clipboard!', 'success');
    } catch {
      elements.jsonText.select();
      document.execCommand('copy');
      showToast('JSON copied to clipboard!', 'success');
    }
  }
  
  /**
   * Download JSON as file
   */
  function downloadJson() {
    const json = elements.jsonText?.value;
    
    if (!json) {
      showToast('No JSON to download', 'error');
      return;
    }
    
    const filename = (elements.blueprintName.value.trim() || 'facto-output')
      .replace(/[^a-z0-9]/gi, '_') + '.json';
    
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast(`JSON saved as ${filename}`, 'success');
  }
  
  /**
   * Switch output tab
   */
  function switchTab(tabName) {
    // Update tab buttons
    elements.tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    
    // Update tab content
    document.querySelectorAll('.output-tab').forEach(tab => {
      tab.classList.toggle('active', tab.id === `${tabName}-tab`);
    });
  }
  
  /**
   * Copy blueprint to clipboard
   */
  async function copyBlueprintToClipboard() {
    const blueprint = elements.blueprintText.value;
    
    if (!blueprint) {
      showToast('No blueprint to copy', 'error');
      return;
    }
    
    try {
      await navigator.clipboard.writeText(blueprint);
      showToast('Blueprint copied to clipboard!', 'success');
    } catch (err) {
      // Fallback for older browsers
      elements.blueprintText.select();
      document.execCommand('copy');
      showToast('Blueprint copied to clipboard!', 'success');
    }
  }
  
  /**
   * Download blueprint as file
   */
  function downloadBlueprint() {
    const blueprint = elements.blueprintText.value;
    
    if (!blueprint) {
      showToast('No blueprint to download', 'error');
      return;
    }
    
    const filename = (elements.blueprintName.value.trim() || 'facto-blueprint')
      .replace(/[^a-z0-9]/gi, '_') + '.txt';
    
    const blob = new Blob([blueprint], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast(`Blueprint saved as ${filename}`, 'success');
  }
  
  /**
   * Populate example dropdown with built-in examples
   * @param {string|null} selectedKey - The key of the example to pre-select
   */
  function populateExampleDropdown(selectedKey = null) {
    // Clear existing options except first placeholder
    while (elements.exampleSelect.options.length > 1) {
      elements.exampleSelect.remove(1);
    }
    
    const exampleKeys = Object.keys(window.FactoEditor.examples);
    exampleKeys.forEach(key => {
      const option = document.createElement('option');
      option.value = key;
      // Format name: camelCase -> Title Case
      option.textContent = key.replace(/([A-Z])/g, ' $1').trim();
      option.textContent = option.textContent.charAt(0).toUpperCase() + option.textContent.slice(1);
      elements.exampleSelect.appendChild(option);
    });
    
    // Select the loaded example if provided
    if (selectedKey) {
      elements.exampleSelect.value = selectedKey;
    }
  }
  
  /**
   * Handle example selection from dropdown
   */
  function handleExampleSelect(e) {
    const value = e.target.value;
    if (!value) return;
    
    const code = window.FactoEditor.examples[value];
    if (code) {
      editor.setValue(code);
      saveEditorContent();
    }
    // Keep the selected value to show which example is loaded
  }
  
  /**
   * Show toast notification
   */
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    // Create icon span with safe innerHTML (hardcoded SVGs)
    const iconSpan = document.createElement('span');
    iconSpan.className = 'toast-icon';
    
    let iconSvg;
    if (type === 'success') {
      iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    } else if (type === 'warning') {
      iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
    } else {
      iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
    }
    iconSpan.innerHTML = iconSvg;
    
    // Create message span with textContent (safe - escapes HTML)
    const messageSpan = document.createElement('span');
    messageSpan.className = 'toast-message';
    messageSpan.textContent = message;
    
    toast.appendChild(iconSpan);
    toast.appendChild(messageSpan);
    
    elements.toastContainer.appendChild(toast);
    
    // Remove after 4 seconds
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => toast.remove(), 200);
    }, 4000);
  }
  
  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    stopHealthChecks();
  });
})();
