// Resolve CLI options from parsed flags, environment overrides, and defaults.
// `*Explicit` flags record whether the user actually passed --dir/--port, so
// `serve` can prefer the saved install record over a bare default.
import { defaultAppDir } from "./paths.js";

const DEFAULT_REPO = "https://github.com/agustinkassis/gorilator-rpg.git";
// "latest" = track the newest published GitHub release (resolved at install/update
// time, with a prebuilt-dist fast path). Pass --ref main (or any branch/tag) to pin.
const DEFAULT_REF = "latest";
const DEFAULT_PORT = 2567;
const DEFAULT_CLIENT_PORT = 0;

/** The subset of parseArgs values this CLI consumes. */
export interface RawFlags {
  repo?: string;
  ref?: string;
  dir?: string;
  port?: string;
  "client-port"?: string;
  yes?: boolean;
  "skip-service"?: boolean;
  "skip-tunnel"?: boolean;
  "local-cli"?: string;
  "keep-files"?: boolean;
  "keep-command"?: boolean;
  "keep-tunnel"?: boolean;
}

export interface Options {
  repo: string;
  ref: string;
  appDir: string;
  dirExplicit: boolean;
  port: number;
  portExplicit: boolean;
  clientPort: number;
  yes: boolean;
  noService: boolean;
  noTunnel: boolean;
  localCli?: string;
  keepFiles: boolean;
  keepCommand: boolean;
  keepTunnel: boolean;
}

export function resolveOptions(v: RawFlags): Options {
  const env = process.env;
  const dirFlag = v.dir ?? env.GORILATOR_DIR;
  const portFlag = v.port ?? env.GAME_SERVER_PORT;
  const port = Number(portFlag);
  const clientPort = Number(v["client-port"] ?? env.CLIENT_PORT);
  return {
    repo: v.repo ?? env.GORILATOR_REPO ?? DEFAULT_REPO,
    ref: v.ref ?? env.GORILATOR_REF ?? DEFAULT_REF,
    appDir: dirFlag ?? defaultAppDir(),
    dirExplicit: dirFlag !== undefined,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    portExplicit: portFlag !== undefined && Number.isFinite(port) && port > 0,
    clientPort: Number.isFinite(clientPort) && clientPort > 0 ? clientPort : DEFAULT_CLIENT_PORT,
    yes: Boolean(v.yes) || env.GORILATOR_YES === "1",
    noService: Boolean(v["skip-service"]),
    noTunnel: Boolean(v["skip-tunnel"]),
    localCli: v["local-cli"] ?? env.GORILATOR_LOCAL_CLI,
    keepFiles: Boolean(v["keep-files"]),
    keepCommand: Boolean(v["keep-command"]),
    keepTunnel: Boolean(v["keep-tunnel"]),
  };
}
