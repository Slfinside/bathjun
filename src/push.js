import webpush from "web-push";

export function validateSubscription(subscription) {
  try {
    if (
      !subscription ||
      typeof subscription.endpoint !== "string" ||
      subscription.endpoint.length > 2048
    )
      return false;
    const url = new URL(subscription.endpoint);
    const allowed =
      url.hostname === "web.push.apple.com" ||
      url.hostname.endsWith(".push.apple.com") ||
      url.hostname === "fcm.googleapis.com" ||
      url.hostname === "updates.push.services.mozilla.com";
    const { p256dh, auth } = subscription.keys || {};
    return (
      allowed &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!url.port || url.port === "443") &&
      typeof p256dh === "string" &&
      /^[A-Za-z0-9_-]+$/.test(p256dh) &&
      Buffer.from(p256dh, "base64url").length === 65 &&
      Buffer.from(p256dh, "base64url")[0] === 4 &&
      typeof auth === "string" &&
      /^[A-Za-z0-9_-]+$/.test(auth) &&
      Buffer.from(auth, "base64url").length === 16
    );
  } catch {
    return false;
  }
}
export const sendPush = (subscription, payload, keys, {ttl=3600} = {}) =>
  webpush.sendNotification(subscription, JSON.stringify(payload), {
    vapidDetails: {
      subject: "https://github.com/Slfinside/bathjun",
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    },
    TTL: ttl,
    urgency: "high",
    timeout: 10000,
  });
export const generateKeys = () => webpush.generateVAPIDKeys();
