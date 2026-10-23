import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ORIGIN = "https://getcoursify.vercel.app";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const POPUP = "chrome-extension://test/popup.html";

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => {
      for (const listener of [...listeners]) listener(...args);
    },
    listeners,
  };
}

async function createHarness(t, tabs = [], results = []) {
  const originalChrome = globalThis.chrome;
  const state = { importState: null };
  const records = {
    created: [],
    updated: [],
    removed: [],
    executions: [],
    menus: [],
    badge: "",
    focused: [],
  };
  const tabMap = new Map(
    tabs.map((tab) => [tab.id, { windowId: 1, status: "complete", ...tab }]),
  );
  let nextId = 100;
  const chrome = {
    runtime: {
      id: "test",
      getURL: (path) => `chrome-extension://test/${path}`,
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
    },
    contextMenus: {
      removeAll: async () => {
        records.menus = [];
      },
      create: (options) => records.menus.push(options),
      onClicked: event(),
    },
    storage: {
      local: {
        get: async () => structuredClone(state),
        set: async (data) => {
          Object.assign(state, structuredClone(data));
        },
      },
    },
    action: {
      setBadgeText: async ({ text }) => {
        records.badge = text;
      },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      query: async (options) =>
        [...tabMap.values()].filter((tab) =>
          options.url ? tab.url.startsWith(`${ORIGIN}/`) : tab.active,
        ),
      get: async (id) => {
        if (!tabMap.has(id)) throw new Error("Tab not found");
        return { ...tabMap.get(id) };
      },
      create: async (options) => {
        const tab = {
          id: nextId++,
          windowId: 1,
          status: "complete",
          ...options,
        };
        tabMap.set(tab.id, tab);
        records.created.push({ ...tab });
        return { ...tab };
      },
      update: async (id, options) => {
        if (!tabMap.has(id)) throw new Error("Tab not found");
        const tab = { ...tabMap.get(id), ...options };
        tabMap.set(id, tab);
        records.updated.push({ id, ...options });
        return { ...tab };
      },
      remove: async (id) => {
        tabMap.delete(id);
        records.removed.push(id);
        chrome.tabs.onRemoved.emit(id);
      },
    },
    windows: {
      update: async (id, options) => {
        records.focused.push({ id, ...options });
      },
    },
    scripting: {
      executeScript: async (options) => {
        records.executions.push(options);
        const result = results.shift();
        assert.ok(result, "No unexpected import attempt");
        return [
          { result: typeof result === "function" ? await result() : result },
        ];
      },
    },
  };
  globalThis.chrome = chrome;
  const moduleUrl = new URL("../background.js", import.meta.url);
  moduleUrl.search = `test=${crypto.randomUUID()}`;
  await import(moduleUrl.href);
  t.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  });

  const send = (type, sender = { id: "test", url: POPUP }) =>
    new Promise((resolve) => {
      const keepChannel = [...chrome.runtime.onMessage.listeners].map(
        (listener) => listener({ type }, sender, resolve),
      );
      if (!keepChannel.includes(true)) resolve(undefined);
    });
  const waitForStatus = async (status) => {
    for (let i = 0; i < 100; i++) {
      if (state.importState?.status === status) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`Expected ${status}, got ${state.importState?.status}`);
  };
  return { chrome, state, records, tabMap, send, waitForStatus };
}

const success = {
  status: "success",
  message: "Imported",
  courseId: "course-id",
};
const loginNeeded = { status: "waiting-login", message: "Log in to continue." };

test("manifest is MV3 with narrowly scoped permissions and existing entry files", async () => {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", root), "utf8"),
  );
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, "module");
  assert.deepEqual(manifest.host_permissions, [`${ORIGIN}/*`]);
  assert.ok(!manifest.permissions.includes("cookies"));
  assert.ok(!manifest.permissions.includes("tabs"));
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((script) => script.js),
  ];
  for (const file of files)
    assert.ok((await readFile(new URL(file, root), "utf8")).length);
});

test("install creates Import course menus for links and video pages", async (t) => {
  const h = await createHarness(t);
  h.chrome.runtime.onInstalled.emit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.records.menus.length, 2);
  assert.ok(h.records.menus.every((menu) => menu.title === "Import course"));
  assert.ok(h.records.menus.find((menu) => menu.contexts.includes("link")));
  assert.ok(h.records.menus.find((menu) => menu.contexts.includes("video")));
});

test("signed-in import uses an existing Coursify tab without navigation", async (t) => {
  const h = await createHarness(
    t,
    [
      { id: 1, url: VIDEO, active: true },
      { id: 2, url: `${ORIGIN}/courses`, active: false },
    ],
    [success],
  );
  assert.deepEqual(await h.send("import-current"), { ok: true });
  assert.equal(h.state.importState.status, "success");
  assert.equal(h.state.importState.url, VIDEO);
  assert.equal(h.records.executions[0].target.tabId, 2);
  assert.equal(h.records.created.length, 0);
  assert.equal(h.records.updated.length, 0);
  assert.equal(h.records.removed.length, 0);
  assert.equal(h.records.badge, "OK");
});

test("without a Coursify tab, imports in an inactive tab and closes only that tab", async (t) => {
  const h = await createHarness(
    t,
    [{ id: 1, url: VIDEO, active: true }],
    [success],
  );
  await h.send("import-current");
  assert.equal(h.records.created[0].active, false);
  assert.equal(h.records.created[0].url, `${ORIGIN}/login`);
  assert.deepEqual(h.records.removed, [100]);
  assert.ok(h.tabMap.has(1));
  assert.equal(h.records.focused.length, 0);
});

test("user-activated temporary tabs are not closed", async (t) => {
  let h;
  h = await createHarness(
    t,
    [{ id: 1, url: VIDEO, active: true }],
    [
      () => {
        h.tabMap.get(100).active = true;
        return success;
      },
    ],
  );
  await h.send("import-current");
  assert.deepEqual(h.records.removed, []);
});

test("signed-out import opens login and resumes after SPA navigation", async (t) => {
  const h = await createHarness(
    t,
    [{ id: 1, url: VIDEO, active: true }],
    [loginNeeded, success],
  );
  await h.send("import-current");
  assert.equal(h.state.importState.status, "waiting-login");
  assert.equal(h.state.importState.loginOpened, true);
  assert.deepEqual(h.records.updated, [
    { id: 100, url: `${ORIGIN}/login`, active: true },
  ]);
  assert.equal(h.records.badge, "IN");

  h.tabMap.get(100).url = `${ORIGIN}/dashboard`;
  await h.send("coursify-page-ready", {
    id: "test",
    frameId: 0,
    url: `${ORIGIN}/dashboard`,
    tab: h.tabMap.get(100),
  });
  await h.waitForStatus("success");
  assert.equal(h.records.executions.length, 2);
  assert.equal(h.records.created.length, 1);
  assert.equal(h.records.removed.length, 0);
});

test("signed-out existing work tabs are not redirected", async (t) => {
  const h = await createHarness(
    t,
    [
      { id: 1, url: VIDEO, active: true },
      { id: 2, url: `${ORIGIN}/courses`, active: false },
    ],
    [loginNeeded],
  );
  await h.send("import-current");
  assert.equal(h.tabMap.get(2).url, `${ORIGIN}/courses`);
  assert.equal(h.records.updated.length, 0);
  assert.equal(h.records.created[0].url, `${ORIGIN}/login`);
  assert.equal(h.records.created[0].active, true);
  assert.equal(h.state.importState.tabId, 100);
});

test("repeated clicks and unrelated ready messages cannot start another pending import", async (t) => {
  const h = await createHarness(
    t,
    [{ id: 1, url: VIDEO, active: true }],
    [loginNeeded],
  );
  await h.send("import-current");
  assert.equal((await h.send("import-current")).ok, false);
  for (const sender of [
    { id: "test", frameId: 0, url: `${ORIGIN}/dashboard`, tab: { id: 999 } },
    { id: "test", frameId: 1, url: `${ORIGIN}/dashboard`, tab: { id: 100 } },
    { id: "test", frameId: 0, url: `${ORIGIN}/login`, tab: { id: 100 } },
    {
      id: "test",
      frameId: 0,
      url: "https://other.example/dashboard",
      tab: { id: 100 },
    },
  ])
    await h.send("coursify-page-ready", sender);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.records.executions.length, 1);
});

test("pending login cancellation prevents later automatic import", async (t) => {
  const h = await createHarness(
    t,
    [{ id: 1, url: VIDEO, active: true }],
    [loginNeeded],
  );
  await h.send("import-current");
  assert.deepEqual(await h.send("cancel"), { ok: true });
  await h.send("coursify-page-ready", {
    id: "test",
    frameId: 0,
    url: `${ORIGIN}/dashboard`,
    tab: { id: 100 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.importState.status, "cancelled");
  assert.equal(h.records.executions.length, 1);
  assert.equal(h.records.badge, "");
});

test("closing the login tab makes the job retryable", async (t) => {
  const h = await createHarness(
    t,
    [{ id: 1, url: VIDEO, active: true }],
    [loginNeeded, success],
  );
  await h.send("import-current");
  await h.chrome.tabs.remove(100);
  await h.waitForStatus("error");
  await h.send("retry");
  assert.equal(h.state.importState.status, "success");
  assert.equal(h.records.created.length, 2);
});

test("invalid URLs and untrusted senders cannot trigger imports", async (t) => {
  const h = await createHarness(t, [
    { id: 1, url: "https://other.example/watch?v=dQw4w9WgXcQ", active: true },
  ]);
  assert.equal((await h.send("import-current")).ok, false);
  assert.equal(
    await h.send("import-current", { id: "test", url: `${ORIGIN}/dashboard` }),
    undefined,
  );
  assert.equal(
    await h.send("import-current", { id: "other", url: POPUP }),
    undefined,
  );
  assert.equal(h.records.created.length, 0);
  assert.equal(h.state.importState, null);
});

test("right-click video links use the clicked link, not the containing page", async (t) => {
  const h = await createHarness(
    t,
    [{ id: 2, url: `${ORIGIN}/courses`, active: false }],
    [success],
  );
  h.chrome.contextMenus.onClicked.emit({
    menuItemId: "import-youtube-link",
    linkUrl: "https://www.youtube.com/playlist?list=PL_course-123",
    pageUrl: "https://other.example/article",
  });
  await h.waitForStatus("success");
  assert.equal(
    h.records.executions[0].args[0],
    "https://www.youtube.com/playlist?list=PL_course-123",
  );
});

test("interrupted jobs recover without silently reissuing the POST", async (t) => {
  const h = await createHarness(t);
  h.state.importState = {
    id: "interrupted",
    status: "importing",
    updatedAt: Date.now() - 181_000,
    url: VIDEO,
  };
  await h.send("recover");
  assert.equal(h.state.importState.status, "error");
  assert.match(
    h.state.importState.message,
    /Check your library before retrying/,
  );
  assert.equal(h.records.executions.length, 0);
});
