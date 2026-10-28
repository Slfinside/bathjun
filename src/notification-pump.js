// No periodic wakeups while idle. SQLite owns the durable queue and retry times.
export function createNotificationPump(
  app,
  {
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onError = () => {},
  } = {},
) {
  let timer = null,
    running = false,
    closed = false;
  function schedule() {
    if (closed || running) return;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const due = app.notificationDueAt();
    if (due === null) return;
    timer = setTimer(
      () => {
        timer = null;
        void pump();
      },
      Math.max(0, Math.min(2147483647, due - now())),
    );
    timer.unref?.();
  }
  async function pump() {
    if (closed || running) return;
    running = true;
    let failed = false;
    try {
      await app.flushNotifications();
    } catch (error) {
      failed = true;
      onError(error);
    } finally {
      running = false;
      if (!closed) {
        if (failed) {
          timer = setTimer(() => {
            timer = null;
            void pump();
          }, 30000);
          timer.unref?.();
        } else schedule();
      }
    }
  }
  return {
    wake: schedule,
    start: () => void pump(),
    close: () => {
      closed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
