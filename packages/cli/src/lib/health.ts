// Tiny HTTP health probe against the daemon's /healthz endpoint.
import { get } from "node:http";

export function probeHealth(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get(
      // "localhost" so the probe works whether the server bound IPv4 or IPv6 ::1.
      { host: "localhost", port, path: "/healthz", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve(res.statusCode === 200 && body.trim().toLowerCase() === "ok"),
        );
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll /healthz until it answers ok or the timeout elapses. */
export async function waitForHealth(port: number, totalMs = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    if (await probeHealth(port)) return true;
    await sleep(500);
  }
  return false;
}
