import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const WebSocket = require(process.env.TRAE_WS_MODULE_PATH);

const prompt = process.env.TRAE_CHAT_PROMPT_FILE
  ? readFileSync(process.env.TRAE_CHAT_PROMPT_FILE, "utf8")
  : "";
const timeoutMs = Number(process.env.TRAE_CHAT_TIMEOUT_MS || 1200000);
const cdpPort = process.env.TRAE_CDP_PORT || "39222";
const prepareOnly = process.env.TRAE_PREPARE_ONLY === "1";
if (!prompt && !prepareOnly) {
  throw new Error("TRAE_CHAT_PROMPT_FILE is required");
}

const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then(
  (response) => response.json(),
);
const target = targets.find(
  (entry) =>
    entry.type === "page" && entry.url.includes("/workbench/workbench.html"),
);
if (!target) {
  throw new Error(`No Trae workbench target found on port ${cdpPort}`);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (!message.id) {
    return;
  }
  const handler = pending.get(message.id);
  if (!handler) {
    return;
  }
  pending.delete(message.id);
  if (message.error) {
    handler.reject(new Error(JSON.stringify(message.error)));
  } else {
    handler.resolve(message.result);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function bodyText() {
  return evaluate("document.body.innerText");
}

await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

await send("Runtime.enable");
let trusted = false;
for (let attempt = 0; attempt < 3; attempt += 1) {
  const state = await waitFor(`(() => {
    const labels = ['是，我信任此作者', '信任文件夹并启用所有功能'];
    const candidate = [...document.querySelectorAll(
      'button, a, [role="button"], .monaco-button',
    )].find((element) => {
      if (!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)) {
        return false;
      }
      const text = (element.innerText || '').trim();
      return labels.some((label) => text.includes(label));
    });
    if (candidate) {
      candidate.click();
      return 'trusted';
    }
    if (document.body.innerText.includes('信任文件夹并继续')) {
      return 'coordinate-trust';
    }
    if (document.querySelector('[role="textbox"][contenteditable="true"]')) {
      return 'ready';
    }
    return '';
  })()`, 10000);
  if (state === "trusted") {
    trusted = true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    continue;
  }
  if (state === "coordinate-trust") {
    const viewport = await evaluate(`({ width: innerWidth, height: innerHeight })`);
    const x = Math.round(viewport.width * 0.397);
    const y = Math.round(viewport.height * 0.594);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    }
    trusted = true;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    continue;
  }
  if (state === "ready") break;
}
if (prepareOnly) {
  console.log(JSON.stringify({ state: "prepared", trusted }));
  socket.close();
  process.exit(0);
}

const previousTurnIds = await evaluate(`JSON.stringify(
  [...document.querySelectorAll('.ai-chat.chat-session .turn')]
    .map((turn) => turn.getAttribute('data-turn-id'))
    .filter(Boolean)
)`);
const ready = await waitFor(`Boolean(
  document.querySelector('[role="textbox"][contenteditable="true"]')
)`);
if (!ready) throw new Error("Trae chat input was not found");
const focused = await evaluate(`(() => {
  const input = document.querySelector('[role="textbox"][contenteditable="true"]');
  if (!input) return false;
  input.focus();
  return document.activeElement === input;
})()`);
if (!focused) {
  throw new Error("Trae chat input was not found");
}

await send("Input.dispatchKeyEvent", {
  type: "keyDown",
  key: "a",
  code: "KeyA",
  modifiers: 2,
  windowsVirtualKeyCode: 65,
  nativeVirtualKeyCode: 65,
});
await send("Input.dispatchKeyEvent", {
  type: "keyUp",
  key: "a",
  code: "KeyA",
  modifiers: 2,
  windowsVirtualKeyCode: 65,
  nativeVirtualKeyCode: 65,
});
await send("Input.dispatchKeyEvent", {
  type: "keyDown",
  key: "Backspace",
  code: "Backspace",
  windowsVirtualKeyCode: 8,
  nativeVirtualKeyCode: 8,
});
await send("Input.dispatchKeyEvent", {
  type: "keyUp",
  key: "Backspace",
  code: "Backspace",
  windowsVirtualKeyCode: 8,
  nativeVirtualKeyCode: 8,
});
await send("Input.insertText", { text: prompt });
await new Promise((resolve) => setTimeout(resolve, 300));

const inputBeforeSend = await evaluate(
  `document.querySelector('[role="textbox"][contenteditable="true"]')?.innerText || ""`,
);
if (!inputBeforeSend.includes(prompt)) {
  throw new Error("Prompt text did not reach the Trae chat input");
}

const key = {
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
};
await send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });

const startedAt = Date.now();
let latestState = null;
while (Date.now() - startedAt < timeoutMs) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  latestState = await evaluate(`(() => {
    const previous = new Set(${previousTurnIds});
    const turns = [...document.querySelectorAll('.ai-chat.chat-session .turn')];
    const turn = turns.reverse().find((candidate) => {
      const id = candidate.getAttribute('data-turn-id');
      return id && !previous.has(id);
    });
    if (!turn) {
      return { state: 'waiting-for-turn' };
    }
    const finish = turn.querySelector(
      '[data-toolcall-type="finish"] .core-finish-card__summary',
    );
    if (finish) {
      return {
        state: 'completed',
        turnId: turn.getAttribute('data-turn-id'),
        answer: finish.innerText.trim(),
      };
    }
    const error = turn.querySelector(
      '[data-testid*="error"], .chat-error, [class*="error-card"]',
    );
    if (error?.innerText?.trim()) {
      return {
        state: 'failed',
        turnId: turn.getAttribute('data-turn-id'),
        error: error.innerText.trim(),
      };
    }
    return {
      state: 'running',
      turnId: turn.getAttribute('data-turn-id'),
      preview: turn.innerText.slice(-800),
    };
  })()`);
  if (latestState?.state === "completed" || latestState?.state === "failed") {
    break;
  }
}

if (latestState?.state !== "completed") {
  const text = await bodyText();
  console.error(
    JSON.stringify(
      {
        error: latestState?.error || "Timed out waiting for Trae to finish",
        state: latestState,
        body: text.slice(-4000),
      },
      null,
      2,
    ),
  );
  socket.close();
  process.exit(1);
}

console.log(JSON.stringify(latestState));
socket.close();
