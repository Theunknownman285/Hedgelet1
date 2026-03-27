import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// ─── Discord Bridge (always-on in production) ────────────────────────────────
// In the deployed environment the bridge runs as a supervised child process so
// application DMs and moderation commands are always available even when no one
// has the Replit editor open. In development the bridge runs as its own
// separate workflow instead, so we skip spawning it here to avoid duplicates.

if (process.env["NODE_ENV"] === "production") {
  // process.cwd() is the workspace root in production
  const bridgeDir = path.resolve(process.cwd(), "artifacts/discord-bridge");
  const bridgeEntry = path.join(bridgeDir, "src/index.ts");
  let bridgeProc: ChildProcess | null = null;
  let bridgeStopping = false;

  function startBridge() {
    if (bridgeStopping) return;

    logger.info({ bridgeDir }, "Starting Discord bridge");

    // Use Node's built-in TypeScript stripping (Node 22+) — no pnpm/tsx needed
    bridgeProc = spawn(process.execPath, ["--experimental-strip-types", bridgeEntry], {
      cwd: bridgeDir,
      stdio: "inherit",
      env: process.env,
    });

    bridgeProc.on("error", (err) => {
      logger.error({ err }, "Discord bridge process error");
    });

    bridgeProc.on("exit", (code, signal) => {
      if (bridgeStopping) return;
      logger.warn({ code, signal }, "Discord bridge exited — restarting in 5s");
      setTimeout(startBridge, 5000);
    });
  }

  startBridge();

  // Graceful shutdown: stop bridge when API server stops
  process.on("SIGTERM", () => {
    bridgeStopping = true;
    bridgeProc?.kill("SIGTERM");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    bridgeStopping = true;
    bridgeProc?.kill("SIGTERM");
    process.exit(0);
  });
}
