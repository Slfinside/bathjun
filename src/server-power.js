import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export function acquireServerPower({
  platform = process.platform,
  load = () =>
    require(
      fileURLToPath(new URL("../../bin/Bathjun-Power.node", import.meta.url)),
    ),
} = {}) {
  let binding,
    held = false,
    errorCode = null;
  const lease = {
    get protected() {
      return held;
    },
    get errorCode() {
      return errorCode;
    },
    renew,
    close,
  };
  function close() {
    try {
      binding?.release();
    } finally {
      held = false;
    }
  }
  function renew() {
    if (platform !== "win32") return false;
    try {
      close();
      binding ||= load();
      if (binding.version !== 1) throw new Error("Unsupported power guard");
      const state = binding.acquire();
      held =
        state?.protected === true &&
        state.system === true &&
        state.execution === true &&
        state.thread === true;
      errorCode = state?.errorCode ?? null;
      if (!held) close();
    } catch {
      try {
        close();
      } catch {}
      held = false;
      errorCode = "unavailable";
    }
    return held;
  }
  renew();
  return lease;
}
