// Paint an 80px fade over scrollable content; no footer or extra scroll space.
export function observeDialogFades(document) {
  let frame;
  const watched = new Set();
  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }
  const resize = new ResizeObserver(schedule);
  function update() {
    frame = null;
    for (const dialog of watched) if (!dialog.isConnected) { resize.unobserve(dialog); dialog.removeEventListener("scroll", schedule); watched.delete(dialog); }
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      if (!watched.has(dialog)) {
        watched.add(dialog);resize.observe(dialog);
        dialog.addEventListener('scroll', schedule, {passive: true});
      }
      const style = getComputedStyle(dialog);
      for (const [name, value] of [['left', style.paddingLeft], ['right', style.paddingRight], ['bottom', style.paddingBottom]]) {
        const key = '--fade-padding-' + name;
        if (dialog.style.getPropertyValue(key) !== value) dialog.style.setProperty(key, value);
      }
      dialog.toggleAttribute('data-scroll-fade', dialog.scrollHeight - dialog.clientHeight - dialog.scrollTop > 2);
    }
  }
  new MutationObserver(schedule).observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden']});
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  document.addEventListener('load', schedule, true);
  document.fonts?.addEventListener('loadingdone', schedule);
  schedule();
}

// Keep the browser's reload behavior, but protect unsaved settings with the
// same in-page modal style as the rest of the client.
export function confirmReload(document) {
  return new Promise(resolve => {
    const modal = document.createElement('dialog');
    modal.setAttribute('aria-labelledby', 'reload-title');
    modal.innerHTML = '<h2 id="reload-title">再読み込みしますか？</h2><p>保存していない設定の変更は失われます。</p><button type="button" class="primary" data-reload-confirm>再読み込み</button><button type="button" class="secondary" data-reload-cancel>キャンセル</button>';
    modal.querySelector('[data-reload-confirm]').onclick = () => modal.close('reload');
    modal.querySelector('[data-reload-cancel]').onclick = () => modal.close();
    modal.addEventListener('close', () => {
      const value = modal.returnValue === 'reload';
      modal.remove(); document.querySelector('.profile-button')?.focus(); resolve(value);
    }, {once: true});
    document.body.append(modal); modal.showModal();
  });
}
