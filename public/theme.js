// Run before styles/first paint. Appearance is a device preference, independent
// of household/member authentication; storage can be unavailable in WebViews.
(() => {
  const key = 'bathjun.appearance';
  const choices = ['system', 'light', 'dark'];
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => choices.includes(value) ? value : 'system';
  let preference = 'system';
  try { preference = valid(localStorage.getItem(key)); } catch {}

  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#171c19' : '#f6f5f0');
    document.querySelectorAll('[data-theme-preference]').forEach(select => { select.value = preference; });
    document.dispatchEvent(new Event('bathjun:themechange'));
  }
  window.BathjunTheme = {
    get preference() { return preference; },
    setPreference(value) {
      preference = valid(value);
      try { localStorage.setItem(key, preference); } catch {}
      apply();
    },
  };
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      try { preference = valid(localStorage.getItem(key)); } catch { return; }
      apply();
    }
  });
  document.addEventListener('change', event => {
    if (event.target.matches('[data-theme-preference]')) window.BathjunTheme.setPreference(event.target.value);
  });
  apply();
})();
