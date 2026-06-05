// Query the running daemon's /api/update endpoint so the CLI can surface the
// same "update available" verdict the server computes for the game splash. The
// server is the single source of truth (it checks on the configured interval);
// the CLI just reads its cached snapshot over localhost.
import { get } from "node:http";

export interface UpdateStatus {
  enabled: boolean;
  intervalHours: number;
  repo: string;
  updateAvailable: boolean;
  current: { version: string; sha: string | null; committedAt: string | null };
  latest: { tag: string; name: string; url: string; publishedAt: string } | null;
  checkedAt: number;
  error?: string;
}

/** Fetch /api/update from the local daemon; resolves null if unreachable. */
export function fetchUpdateStatus(port: number, timeoutMs = 1500): Promise<UpdateStatus | null> {
  return new Promise((resolve) => {
    const req = get(
      { host: "127.0.0.1", port, path: "/api/update", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(body) as UpdateStatus);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}
