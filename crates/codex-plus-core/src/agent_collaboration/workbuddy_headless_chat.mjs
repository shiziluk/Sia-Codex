import { readFileSync } from "node:fs";

const prompt = process.env.WORKBUDDY_PROMPT_FILE
  ? readFileSync(process.env.WORKBUDDY_PROMPT_FILE, "utf8")
  : "";
const timeoutMs = Number(process.env.WORKBUDDY_TIMEOUT_MS || 1200000);
const port = process.env.WORKBUDDY_CDP_PORT || "39223";
const requestedModel = process.env.WORKBUDDY_MODEL || "hy3";
const modelLabels = {
  "hy3": "Hy3",
  "hy4-preview": "Hy4 preview",
  "glm-5.3-flash": "GLM-5.3-Flash",
};
if (!prompt) throw new Error("WORKBUDDY_PROMPT_FILE is required");

let target = null;
const targetDeadline = Date.now() + 30000;
while (!target && Date.now() < targetDeadline) {
  try {
    const targets = await fetch(
      `http://127.0.0.1:${port}/json/list`,
    ).then((response) => response.json());
    target = targets.find(
      (entry) => entry.type === "page" && entry.title === "WorkBuddy",
    );
  } catch {}
  if (!target) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
if (!target) throw new Error(`WorkBuddy page target not found on port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  message.error
    ? handler.reject(new Error(JSON.stringify(message.error)))
    : handler.resolve(message.result);
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

async function waitFor(expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function selectModel(model) {
  const label = modelLabels[model];
  if (!label) throw new Error(`Unsupported WorkBuddy model: ${model}`);
  const current = await evaluate(`
    document.querySelector('button.cr-model-selector__trigger')?.innerText || ""
  `);
  if (current.includes(label)) return;
  const opened = await evaluate(`(() => {
    const trigger = document.querySelector('button.cr-model-selector__trigger');
    if (!trigger) return false;
    trigger.click();
    return true;
  })()`);
  if (!opened) throw new Error("WorkBuddy model selector not found");
  const selected = await waitFor(`(() => {
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((element) => (element.innerText || '').includes(${JSON.stringify(label)}));
    if (!option) return false;
    option.click();
    return true;
  })()`);
  if (!selected) throw new Error(`WorkBuddy model option not found: ${label}`);
  const confirmed = await waitFor(`(() => {
    const text = document.querySelector('button.cr-model-selector__trigger')?.innerText || '';
    return text.includes(${JSON.stringify(label)});
  })()`);
  if (!confirmed) throw new Error(`WorkBuddy did not switch to model: ${label}`);
}

async function ensureWorkspace() {
  const current = await evaluate(`
    document.querySelector('.cr-workspace-picker')?.innerText?.trim() || ""
  `);
  if (current && !current.includes("选择工作空间")) return current;
  const opened = await evaluate(`(() => {
    const trigger = document.querySelector('.cr-workspace-picker');
    if (!trigger) return false;
    trigger.click();
    return true;
  })()`);
  if (!opened) throw new Error("WorkBuddy workspace picker not found");
  const selected = await waitFor(`(() => {
    const option = [...document.querySelectorAll(
      '.cr-workspace-picker-dropdown [role="menuitemradio"]',
    )].find((element) => {
      const text = (element.innerText || '').trim();
      return text &&
        text !== '新建工作空间' &&
        text !== '打开本地文件夹' &&
        !/^\\d{4}-\\d{2}-\\d{2}/.test(text);
    });
    if (!option) return '';
    const label = (option.innerText || '').trim();
    option.click();
    return label;
  })()`);
  if (!selected) throw new Error("WorkBuddy has no saved workspace to select");
  const confirmed = await waitFor(`(() => {
    const text = document.querySelector('.cr-workspace-picker')?.innerText || '';
    return text.includes(${JSON.stringify(selected)}) ? text.trim() : '';
  })()`);
  if (!confirmed) throw new Error(`WorkBuddy did not switch workspace: ${selected}`);
  return confirmed;
}

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
await send("Runtime.enable");

const newTask = await evaluate(`(() => {
  const button = document.querySelector(
    'button[data-track-id="agent_new_task_button_clicked"]',
  );
  if (!button) return false;
  button.click();
  return true;
})()`);
if (!newTask) throw new Error("WorkBuddy new-task button not found");

const ready = await waitFor(`Boolean(
  document.querySelector('[role="textbox"][contenteditable="true"]')
)`);
if (!ready) throw new Error("WorkBuddy chat input did not become ready");
await selectModel(requestedModel);
await ensureWorkspace();

const previousFrameIds = await evaluate(`JSON.stringify(
  [...document.querySelectorAll('.cr-frame')]
    .map((frame) => frame.getAttribute('data-cr-frame-id'))
    .filter(Boolean)
)`);
const focused = await evaluate(`(() => {
  const input = document.querySelector(
    '[role="textbox"][contenteditable="true"]',
  );
  if (!input) return false;
  input.focus();
  return document.activeElement === input;
})()`);
if (!focused) throw new Error("WorkBuddy chat input could not be focused");

for (const event of [
  { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 },
  { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 },
  { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
]) {
  await send("Input.dispatchKeyEvent", {
    ...event,
    nativeVirtualKeyCode: event.windowsVirtualKeyCode,
  });
}
await send("Input.insertText", { text: prompt });
await new Promise((resolve) => setTimeout(resolve, 300));

const inputText = await evaluate(`document.querySelector(
  '[role="textbox"][contenteditable="true"]',
)?.innerText || ""`);
if (!inputText.includes(prompt.trim().slice(0, 120))) {
  throw new Error("Prompt text did not reach the WorkBuddy input");
}

const enter = {
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
};
await send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
await send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });

const startedAt = Date.now();
let result = null;
while (Date.now() - startedAt < timeoutMs) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  result = await evaluate(`(() => {
    const previous = new Set(${previousFrameIds});
    const userText = ${JSON.stringify(prompt.trim().slice(0, 120))};
    const userFrame = [...document.querySelectorAll('.cr-frame--right')]
      .reverse()
      .find((frame) => {
        const id = frame.getAttribute('data-cr-frame-id');
        return id && !previous.has(id) &&
          (frame.innerText || '').includes(userText);
      });
    if (!userFrame) return { state: 'waiting-for-turn' };

    let item = userFrame.closest('.cr-document__virtual-item');
    let assistantFrame = null;
    while (item && !assistantFrame) {
      item = item.nextElementSibling;
      if (!item) break;
      const candidate = item.querySelector('.cr-frame--left');
      const candidateId = candidate?.getAttribute('data-cr-frame-id') || '';
      if (candidate && !candidateId.startsWith('cr-synthetic')) {
        assistantFrame = candidate;
      }
    }
    if (!assistantFrame) {
      const errorText = [...document.querySelectorAll(
        '[role="alert"], [data-status="error"], [class*="error"]',
      )].map((element) => (element.innerText || '').trim())
        .find((text) => /额度|免费次数|上限|余额不足|quota|rate.?limit|insufficient|credit/i.test(text));
      if (errorText) {
        return { state: 'quota-exhausted', error: errorText.slice(-1200) };
      }
      return {
        state: 'running',
        userFrameId: userFrame.getAttribute('data-cr-frame-id'),
      };
    }
    const status = assistantFrame.getAttribute('data-status');
    const finished = Boolean(
      assistantFrame.querySelector(
        '[data-testid="conversation-finished-footer"]',
      ),
    );
    const markdowns = [
      ...assistantFrame.querySelectorAll('[data-markdown-content="true"]'),
    ];
    const answer = (markdowns.at(-1)?.innerText || '').trim();
    if (/额度|免费次数|上限|余额不足|quota|rate.?limit|insufficient|credit/i.test(
      assistantFrame.innerText || '',
    ) && status !== 'complete') {
      return {
        state: 'quota-exhausted',
        error: (assistantFrame.innerText || '').slice(-1200),
      };
    }
    if (status === 'complete' && finished && answer) {
      return {
        state: 'completed',
        userFrameId: userFrame.getAttribute('data-cr-frame-id'),
        assistantFrameId: assistantFrame.getAttribute('data-cr-frame-id'),
        answer,
      };
    }
    return {
      state: status === 'complete' && finished ? 'empty-answer' : 'running',
      userFrameId: userFrame.getAttribute('data-cr-frame-id'),
      assistantFrameId: assistantFrame.getAttribute('data-cr-frame-id'),
      preview: assistantFrame.innerText.slice(-1000),
    };
  })()`);
  if (
    result?.state === "completed" ||
    result?.state === "empty-answer" ||
    result?.state === "quota-exhausted"
  ) break;
}

if (result?.state === "quota-exhausted") {
  console.log(JSON.stringify(result));
  socket.close();
  process.exit(0);
}

if (result?.state !== "completed") {
  console.error(
    JSON.stringify(
      {
        error: "Timed out waiting for WorkBuddy to finish",
        result,
        body: (await evaluate("document.body.innerText")).slice(-4000),
      },
      null,
      2,
    ),
  );
  socket.close();
  process.exit(1);
}

console.log(JSON.stringify(result));
socket.close();
