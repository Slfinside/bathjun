// Native inputs keep the control UI on the user's OS/browser.
export function clockInput(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0) return '';
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
export function bookingMinute(value, cutoff) {
  const match = /^(\d{2}):(\d{2})(?::00)?$/.exec(value);
  if (!match || +match[1] > 23 || +match[2] > 59) return null;
  const clock = +match[1] * 60 + +match[2];
  return clock < cutoff ? clock + 1440 : clock;
}
export function createBookingInputs(dialog, {context, isFuture, ticketAllowed, available, format, checkIcon}) {
  const startInput = () => dialog.querySelector('#start');
  const duration = () => Number(dialog.querySelector('[name="duration"]').value);
  const selectedStart = () => bookingMinute(startInput().value, context().bathStart);
  const canChoose = (start, length) => isFuture(start) && ticketAllowed(start, length) && (context().wish || available(start, length));
  function validate() {
    const input = startInput(), rule = context(), untimed = !!dialog.querySelector('[name="untimed"]:checked');
    const start = selectedStart(), save = dialog.querySelector('#save-booking'), hint = dialog.querySelector('#start-hint');
    let error = '';
    if (!untimed) {
      if (start === null) error = '開始時刻を選んでください。';
      else if (start % rule.step) error = `${rule.step}分刻みで選んでください。`;
      else if (start < rule.bathStart || start >= rule.bathEnd) error = 'この日分の予約時間外です。';
      else if (!isFuture(start)) error = '開始時刻を過ぎています。';
      else if (!ticketAllowed(start, duration())) error = 'アイテムの使用条件に合わない時刻です。';
      else if (!rule.wish && !available(start, duration())) error = 'ほかの予約と重なっています。';
    }
    input.setCustomValidity(error);
    input.setAttribute('aria-invalid', String(!!error));
    hint.textContent = error || (!untimed && start >= 1440 ? '翌日の時刻です。' : '');
    hint.classList.toggle('form-error', !!error);
    save.disabled = !!error;
    dialog.querySelector('#end-time').textContent = start === null ? '—' : format(start + duration());
    return !error;
  }
  function update(preferred) {
    const input = startInput(), rule = context(), untimed = !!dialog.querySelector('[name="untimed"]:checked');
    input.step = String(rule.step * 60);
    input.required = !untimed; input.hidden = untimed; input.disabled = untimed;
    dialog.querySelector('.end-summary').hidden = untimed;
    dialog.querySelector('#start-hint').hidden = untimed;
    const negotiation = dialog.querySelector('.negotiation-choice');
    if (negotiation) negotiation.hidden = untimed;
    const save = dialog.querySelector('#save-booking');
    save.innerHTML = (untimed ? '使う時間を共有する' : save.dataset.timedLabel) + checkIcon;
    if (Number.isInteger(preferred)) {
      input.value = preferred >= rule.bathStart && preferred < rule.bathEnd &&
        preferred % rule.step === 0 && canChoose(preferred, duration()) ? clockInput(preferred) : '';
    }
    if (!input.value && !untimed) {
      for (let start = rule.bathStart; start < rule.bathEnd; start += rule.step) {
        if (canChoose(start, duration())) { input.value = clockInput(start); break; }
      }
    }
    validate();
  }
  return {update, validate, selectedStart, duration};
}
