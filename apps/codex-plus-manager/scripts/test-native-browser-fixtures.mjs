import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const managerRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(managerRoot, "..", "..");
const require = createRequire(import.meta.url);
const { inspectService } = require(path.join(repoRoot, "assets/native-browser/inspect-service.cjs"));

const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const roots = [
  path.join(localAppData, "OpenAI", "Codex", "runtimes"),
  path.join(codexHome, "plugins", "cache", "openai-bundled", "unified-computer-use"),
];
const maxVisitedEntries = 50_000;
let visitedEntries = 0;

function findServices(root) {
  if (!existsSync(root)) return [];
  const services = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visitedEntries > maxVisitedEntries) {
        throw new Error(`Fixture discovery exceeded ${maxVisitedEntries} filesystem entries`);
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name === "browser-service.mjs") {
        services.push(fullPath);
      }
    }
  }
  return services;
}

function packageContext(servicePath) {
  let current = path.dirname(servicePath);
  for (let index = 0; index < 8; index += 1) {
    const packagePath = path.join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
        if (typeof manifest.name === "string" && manifest.name.startsWith("@oai/")) {
          return `${manifest.name}@${manifest.version ?? "unknown"}`;
        }
      } catch {
        // Ignore malformed optional metadata and report the service path only.
      }
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "unknown package";
}

const candidates = [...new Set(roots.flatMap(findServices).map((servicePath) => {
  try {
    return realpathSync(servicePath);
  } catch {
    return path.resolve(servicePath);
  }
}))];

if (candidates.length === 0) {
  console.error("No local browser-service.mjs files were found.");
  process.exit(1);
}

const compatible = [];
for (const servicePath of candidates) {
  const source = readFileSync(servicePath, "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  try {
    const binding = inspectService(source);
    compatible.push(servicePath);
    console.log(`PASS ${packageContext(servicePath)} sha256=${digest} policy=${binding.policy}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`SKIP ${packageContext(servicePath)} sha256=${digest} ${message}`);
  }
}

if (compatible.length === 0) {
  console.error("No discovered local browser service matches the supported structural contract.");
  process.exit(1);
}

const child = spawn(process.execPath, [
  "--test",
  "src/native-browser-contract.test.ts",
], {
  cwd: managerRoot,
  env: {
    ...process.env,
    CPP_BROWSER_SERVICE_FIXTURES: JSON.stringify(compatible),
  },
  stdio: "inherit",
  windowsHide: true,
});
child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Native-browser contract test stopped by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
