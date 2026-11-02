import { readFileSync } from "node:fs";

const prompt = process.env.DOUBAO_PROMPT_FILE
  ? readFileSync(process.env.DOUBAO_PROMPT_FILE, "utf8")
  : "";
const timeoutMs = Number(process.env.DOUBAO_TIMEOUT_MS || 1200000);
const port = process.env.DOUBAO_CDP_PORT || "39224";
if (!prompt) throw new Error("DOUBAO_PROMPT_FILE is required");

async function targets() {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
}

let available = [];
const targetDeadline = Date.now() + 30000;
while (Date.now() < targetDeadline) {
  try {
    available = await targets();
    if (available.some((entry) => entry.type === "page" && entry.url?.includes("doubaowork-chat"))) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const loginTarget = available.find((entry) => entry.type === "page" && entry.url?.includes("client-login"));
const chatTarget = available.find(
  (entry) => entry.type === "page" && entry.title?.includes("豆包工作") && entry.url?.includes("doubaowork-chat"),
);
if (!chatTarget) {
  console.log(JSON.stringify({
    state: loginTarget ? "login-required" : "unavailable",
    error: loginTarget
      ? "豆包工作需要先在应用中完成登录"
      : "未找到豆包工作聊天页面",
  }));
  process.exit(0);
}

const socket = new WebSocket(chatTarget.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result?.value;
}

async function waitFor(expression, waitMs = 45000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
await send("Runtime.enable");

const before = await evaluate(`document.body?.innerText || ""`);
const focused = await evaluate(`(() => {
  const input = document.querySelector('[contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"]');
  if (!input) return false;
  input.focus();
  const range = document.createRange();
  range.selectNodeContents(input);
  range.collapse(false);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
})()`);
if (!focused) {
  console.log(JSON.stringify({ state: loginTarget ? "login-required" : "unavailable", error: "豆包工作输入框不可用" }));
  process.exit(0);
}

for (const event of [
  { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
  { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
  { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
]) {
  await send("Input.dispatchKeyEvent", event);
}
await send("Input.insertText", { text: prompt });

const sendRect = await waitFor(`(() => {
  const button = document.querySelector('[data-testid="chat_input_send_button"]');
  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return null;
  const rect = button.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0
    ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    : null;
})()`, 5000);
if (!sendRect) {
  console.log(JSON.stringify({ state: loginTarget ? "login-required" : "failed", error: "豆包工作发送按钮不可用" }));
  process.exit(0);
}
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: sendRect.x, y: sendRect.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: sendRect.x, y: sendRect.y, button: "left", clickCount: 1 });

const deadline = Date.now() + Math.min(timeoutMs, 1200000);
let previous = "";
let stableSince = 0;
let submitted = false;
while (Date.now() < deadline) {
  const state = await evaluate(`(() => ({
    text: document.body?.innerText || "",
    composer: document.querySelector('[contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"]')?.innerText || "",
    busy: Boolean(document.querySelector('[data-testid="chat_input_stop_button"], [aria-label*="停止"], [aria-label*="Stop"]'))
  }))()`);
  if (state.composer.trim() !== "" || state.busy || state.text !== before) submitted = true;
  if (submitted && !state.busy && state.text === previous) {
    if (!stableSince) stableSince = Date.now();
    if (Date.now() - stableSince >= 2500) {
      const marker = state.text.lastIndexOf(prompt);
      const answer = marker >= 0 ? state.text.slice(marker + prompt.length).trim() : state.text.trim();
      console.log(JSON.stringify({ state: "completed", answer }));
      socket.close();
      process.exit(0);
    }
  } else {
    stableSince = 0;
  }
  previous = state.text;
  await new Promise((resolve) => setTimeout(resolve, 400));
}

console.log(JSON.stringify({
  state: submitted ? "handed-off" : (loginTarget ? "login-required" : "failed"),
  error: submitted ? "豆包工作未在运行时限内返回稳定回答" : "豆包工作没有接受任务，可能需要先登录",
}));
socket.close();
