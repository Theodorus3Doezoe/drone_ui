#!/usr/bin/env node
// Start de hele ground-station met één commando:
//   npm run dev                      → bridge + dashboard (browser opent)
//   npm run dev -- --tx-port /dev/ttyUSB0 --fc-port /dev/ttyACM0
//   npm run dev -- --no-open         → zonder browser
// Extra argumenten gaan naar de backend (bridge).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const isWin = process.platform === "win32";

const passthrough = process.argv.slice(2);
const open = !passthrough.includes("--no-open");
const bridgeArgs = passthrough.filter((a) => a !== "--no-open");

const colors = { build: "\x1b[90m", backend: "\x1b[36m", ui: "\x1b[35m", reset: "\x1b[0m" };
const children = [];
let shuttingDown = false;

function prefixStream(stream, label, color) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`${color}[${label}]${colors.reset} ${line}\n`);
  });
  stream.on("end", () => {
    if (buf) process.stdout.write(`${color}[${label}]${colors.reset} ${buf}\n`);
  });
}

function run(name, cmd, args, cwd, color) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    prefixStream(child.stdout, name, color);
    prefixStream(child.stderr, name, color);
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
    children.push(child);
  });
}

function start(name, cmd, args, cwd, color) {
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  prefixStream(child.stdout, name, color);
  prefixStream(child.stderr, name, color);
  child.on("error", (err) => fail(`${name} kon niet starten: ${err.message}`));
  child.on("exit", (code) => fail(`${name} is gestopt (code ${code ?? "?"}).`));
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) c.kill(isWin ? undefined : "SIGTERM");
  }
  setTimeout(() => process.exit(code), 300).unref();
}

function fail(msg) {
  if (shuttingDown) return;
  console.error(`\n${msg}`);
  shutdown(1);
}

process.on("SIGINT", () => {
  console.log("\nStoppen…");
  shutdown(0);
});
process.on("SIGTERM", () => shutdown(0));

// 1. shared + backend compileren (frontend doet Vite zelf)
console.log("Bouwen van shared + backend…");
const buildCode = await run("build", npm, ["run", "build", "-w", "@ground-station/shared", "-w", "@ground-station/backend"], root, colors.build);
if (buildCode !== 0) {
  fail("Build mislukt; backend niet gestart.");
  process.exit(1);
}

// 2. backend (bridge) + 3. frontend (Vite dev server)
console.log("Starten van bridge en dashboard…\n");
start("backend", process.execPath, [path.join(root, "backend/dist/index.js"), ...bridgeArgs], root, colors.backend);
start("ui", npm, ["run", "dev", "-w", "@ground-station/frontend", "--", ...(open ? ["--open"] : [])], root, colors.ui);
