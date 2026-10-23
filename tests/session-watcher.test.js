import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../session-watcher.js", import.meta.url), "utf8");

async function watcher(initialState, pathname = "/login") {
  let listener;
  let nextTimerId = 0;
  const timers = new Map();
  const messages = [];
  const location = { pathname };
  runInNewContext(source, {
    location,
    chrome: {
      runtime: { sendMessage: async (message) => { messages.push(message); } },
      storage: {
        local: { get: async () => ({ importState: initialState }) },
        onChanged: { addListener: (fn) => { listener = fn; } },
      },
    },
    setInterval: (callback, interval) => {
      assert.equal(interval, 2_000);
      timers.set(++nextTimerId, callback);
      return nextTimerId;
    },
    clearInterval: (id) => timers.delete(id),
  });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    timers, messages, location,
    change: (state, area = "local") => listener({ importState: { newValue: state } }, area),
    tick: () => { for (const callback of [...timers.values()]) callback(); },
  };
}

test("watcher is idle unless an import is waiting for login", async () => {
  for (const state of [null, { status: "importing" }, { status: "success" }, { status: "error" }]) {
    const h = await watcher(state, "/dashboard");
    assert.equal(h.timers.size, 0);
    assert.equal(h.messages.length, 0);
  }
});

test("login and registration screens do not signal a completed login", async () => {
  const h = await watcher({ status: "waiting-login" });
  h.tick();
  h.location.pathname = "/register";
  h.tick();
  assert.equal(h.messages.length, 0);
  assert.equal(h.timers.size, 1);
});

test("SPA navigation resumes a pending import and stops polling once importing", async () => {
  const h = await watcher({ status: "waiting-login" });
  h.location.pathname = "/dashboard";
  h.tick();
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].type, "coursify-page-ready");
  h.change({ status: "importing" });
  assert.equal(h.timers.size, 0);
  h.tick();
  assert.equal(h.messages.length, 1);
});

test("reload after login signals readiness immediately", async () => {
  const h = await watcher({ status: "waiting-login" }, "/courses");
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].type, "coursify-page-ready");
});

test("storage transitions start and stop the watcher without duplicate timers", async () => {
  const h = await watcher(null);
  h.change({ status: "waiting-login" }, "sync");
  assert.equal(h.timers.size, 0);
  h.change({ status: "waiting-login" });
  h.change({ status: "waiting-login" });
  assert.equal(h.timers.size, 1);
  h.change({ status: "cancelled" });
  assert.equal(h.timers.size, 0);
});
