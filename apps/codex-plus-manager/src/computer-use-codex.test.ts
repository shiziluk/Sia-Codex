import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./ComputerUsePage.tsx", import.meta.url), "utf8");

test("Codex 不在接入列表里，页面也不再引导用命令行接入 Codex", () => {
  const targetIds = page.match(/const targetIds: CuTargetId\[\] = \[([^\]]*)\]/);
  assert.ok(targetIds, "targetIds should exist");
  assert.ok(!targetIds[1].includes("\"codex\""));
  assert.ok(!page.includes("install codex"));
});

test("Codex 里有残留条目时提示并只提供移除", () => {
  assert.ok(page.includes("status?.targets?.codex?.registered === true"));
  assert.ok(page.includes("mutateTarget(\"codex\", \"uninstall\")"));
  assert.ok(!page.includes("mutateTarget(\"codex\", \"install\")"));
});

test("macOS 与 Windows 使用原生 Computer Use 页面，其它平台不探测运行时", () => {
  assert.match(page, /computerUsePlatform === "macos" \|\| computerUsePlatform === "windows"/);
  assert.match(page, /return computerUseSupported \? <ComputerUseNativePage onOpenWorkers=\{onOpenWorkers\} \/> : <ComputerUseUnsupported \/>;/);
  const unsupported = page.slice(page.indexOf("function ComputerUseUnsupported"), page.indexOf("function ComputerUseNativePage"));
  assert.ok(unsupported.includes("当前平台暂不支持 Computer Use"));
  assert.ok(!unsupported.includes("invoke("), "不支持的平台不应调用后端探测");
  assert.ok(page.includes("disabled={locked || computerUseIsWindows}"));
  assert.ok(page.includes("{!computerUseIsWindows ? <label className=\"cu-setting\">"));
});

test("browser extension management detects Chrome and Edge and links to worker management", () => {
  assert.match(page, /type CuExtensionBrowser/);
  assert.match(page, /computer_use_browser_extension_status/);
  assert.match(page, /computer_use_open_extension_store", \{ browser \}/);
  assert.match(page, /browser\.family === "edge" \? "Microsoft Edge" : "Google Chrome"/);
  assert.match(page, /chrome 与 edge|Chrome \/ Edge/i);
  assert.match(page, /cu-extension-browsers/);
  assert.match(page, /cu-capability-summary/);
  assert.match(page, /onOpenWorkers/);
});
