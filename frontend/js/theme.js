/**
 * Theme management module for light/dark mode
 */

const ThemeManager = {
  STORAGE_KEY: 'facto-theme',

  /**
   * Initialize theme management
   */
  init() {
    const saved = localStorage.getItem(this.STORAGE_KEY);
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (systemPrefersDark ? 'dark' : 'light');
    this.setTheme(theme, false);

    // Listen for system preference changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem(this.STORAGE_KEY)) {
        this.setTheme(e.matches ? 'dark' : 'light', false);
      }
    });
  },

  /**
   * Set the current theme
   * @param {string} theme - 'dark' or 'light'
   * @param {boolean} save - Whether to save to localStorage
   */
  setTheme(theme, save = true) {
    document.documentElement.setAttribute('data-theme', theme);
    this.updateToggleIcon(theme);
    this.updateCodeMirrorTheme(theme);

    if (save) {
      localStorage.setItem(this.STORAGE_KEY, theme);
    }
  },

  /**
   * Toggle between light and dark theme
   */
  toggle() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    this.setTheme(next);
  },

  /**
   * Get the current theme
   * @returns {string} 'dark' or 'light'
   */
  getTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  },

  /**
   * Update the toggle button icon visibility
   * @param {string} theme - 'dark' or 'light'
   */
  updateToggleIcon(theme) {
    const darkIcon = document.querySelector('.theme-icon-dark');
    const lightIcon = document.querySelector('.theme-icon-light');

    if (darkIcon) {
      darkIcon.classList.toggle('hidden', theme === 'light');
    }
    if (lightIcon) {
      lightIcon.classList.toggle('hidden', theme === 'dark');
    }
  },

  /**
   * Update CodeMirror theme based on current theme
   * @param {string} theme - 'dark' or 'light'
   */
  updateCodeMirrorTheme(theme) {
    const wrapper = document.querySelector('.CodeMirror');
    if (wrapper) {
      wrapper.classList.toggle('cm-s-facto-light', theme === 'light');
      wrapper.classList.toggle('cm-s-facto', theme === 'dark');
    }
  }
};

// Export for use in other modules
window.ThemeManager = ThemeManager;
