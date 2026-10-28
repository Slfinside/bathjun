self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(
      data.title || "おふろを予約する番です ♨",
      {
        body: data.body || "好きな時間を選んでください。",
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: data.tag || "bath-turn",
        data: { day: data.day },
      },
    ),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const day = event.notification.data?.day;
  const path =
    typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)
      ? `/?day=${day}`
      : "/";
  const url = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows)
        if (new URL(client.url).origin === self.location.origin) {
          await client.navigate(url);
          return client.focus();
        }
      return self.clients.openWindow(url);
    })(),
  );
});
