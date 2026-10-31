// Accept only origin-form request targets. A leading // is interpreted as a
// hostname by WHATWG URL, and malformed hostnames can throw before authentication.
export function requestUrl(target) {
  try {
    if (
      typeof target !== "string" ||
      !target.startsWith("/") ||
      target.startsWith("//") ||
      target.includes("\\")
    )
      throw new Error();
    return new URL(target, "http://localhost");
  } catch {
    throw Object.assign(new Error("リクエストのURLを確認してください。"), {
      status: 400,
    });
  }
}
