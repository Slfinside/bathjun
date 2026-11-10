export const profileColors = [
  ['#77a66b','緑'],['#43a594','青緑'],['#55aaa9','水色'],['#579ac7','青'],
  ['#737ac4','藍色'],['#9c7bc6','紫'],['#bf80b0','赤紫'],['#da8ba4','ピンク'],
  ['#d67f79','赤'],['#db9870','オレンジ'],['#d7b45c','黄色'],['#adae61','黄緑'],
  ['#9ba37d','オリーブ'],['#a48e77','茶色'],['#8e9aa6','青灰色'],['#a5a8a1','灰色'],
];
export const profileEmoji = ['🐶','🐱','🐰','🐼','🐻','🦊','🐨','🐸','🐧','🐣','🦉','🦋','🐬','🐳','🦕','🦖','🌷','🌻','🌸','🌼','🍀','🌿','🌵','🍄','🍎','🍊','🍋','🍐','🍑','🍓','🍇','🍉','🍒','🥝','🍍','🥑','🌙','⭐','☀️','🌈','❄️','🔥','🎵','🎮','⚽','🏀','🚀','🛁'];
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function renderProfilePicker(profile={}) {
  const emoji=profile.emoji||'', color=/^#[0-9a-f]{6}$/i.test(profile.color||'')?profile.color:'';
  const choices=emoji&&!profileEmoji.includes(emoji)?[emoji,...profileEmoji]:profileEmoji;
  return `<div class="profile-picker"><div class="profile-preview"><span class="avatar" data-profile-preview>?</span><span>アイコンを選択</span></div><fieldset><legend>絵文字</legend><div class="emoji-options">${choices.map(value=>`<label class="emoji-choice"><input type="radio" name="emoji" value="${escape(value)}" aria-label="${escape(value)}" ${value===emoji?'checked':''} required><span>${escape(value)}</span></label>`).join('')}</div></fieldset><fieldset><legend>色</legend><input type="hidden" name="color" value="${color}"><div class="color-options">${profileColors.map(([value,name])=>`<button type="button" class="color-choice" data-swatch="${value}" aria-label="${name}" aria-pressed="${value===color}"></button>`).join('')}<label class="custom-color" title="自由な色を指定"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m15 3 6 6m-3-6 3 3-13 13-5 2 2-5Z"/></svg><input type="color" name="customColor" value="${color||'#77a66b'}" aria-label="自由な色を指定"></label></div><label class="hex-color">自由な色（カラーコード）<input name="colorHex" type="text" maxlength="7" placeholder="#77a66b" value="${color}" pattern="#[0-9a-fA-F]{6}" autocomplete="off" autocapitalize="off"></label></fieldset></div>`;
}
export function initializeProfilePicker(container) {
  const picker=container.querySelector('.profile-picker');
  const input=picker.querySelector('[name=color]'),custom=picker.querySelector('[name=customColor]'),hex=picker.querySelector('[name=colorHex]');
  function update() {
    const selected=picker.querySelector('[name=emoji]:checked');
    const preview=picker.querySelector('[data-profile-preview]');
    preview.textContent=selected?.value||'?';preview.style.backgroundColor=input.value||'#e1e3df';
    for(const button of picker.querySelectorAll('[data-swatch]')) {button.style.backgroundColor=button.dataset.swatch;button.setAttribute('aria-pressed',String(input.value===button.dataset.swatch));}
  }
  function color(value) {if(!/^#[0-9a-f]{6}$/i.test(value))return;input.value=value.toLowerCase();custom.value=input.value;hex.value=input.value;update();}
  picker.addEventListener('click',event=>{const button=event.target.closest('[data-swatch]');if(button)color(button.dataset.swatch);});
  picker.addEventListener('change',update);
  custom.addEventListener('input',()=>color(custom.value));hex.addEventListener('input',()=>color(hex.value));
  update();
}
