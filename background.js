import { normalizeYoutubeUrl } from "./youtube-url.js";
import { importInCoursifyTab } from "./coursify-api.js";

const ORIGIN = "https://vishal-coursify.vercel.app";
const STATE_KEY = "importState";
const ACTIVE_STATUSES = new Set(["importing", "waiting-login"]);
const YOUTUBE_PATTERNS = [
  "*://*.youtube.com/watch?*",
  "*://*.youtube.com/playlist?*",
  "*://*.youtube.com/shorts/*",
  "*://*.youtube.com/live/*",
  "*://*.youtube.com/embed/*",
  "*://youtu.be/*",
  "*://www.youtu.be/*",
];

let busy = false;

const readState = async () => (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] ?? null;

async function writeState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  const badges = {
    importing: ["…", "#2563eb"],
    "waiting-login": ["IN", "#b45309"],
    success: ["OK", "#15803d"],
    error: ["!", "#b91c1c"],
  };
  const [text, color] = badges[state.status] ?? ["", "#64748b"];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title: `Coursify — ${state.message}` });
}

async function updateJob(id, patch) {
  const current = await readState();

  if (current?.id !== id || !ACTIVE_STATUSES.has(current.status)) {
    return null;
  }

  const state = { ...current, ...patch, updatedAt: Date.now() };
  await writeState(state);
  return state;
}

async function setupMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "import-youtube-link",
    title: "Import course",
    contexts: ["link"],
    targetUrlPatterns: YOUTUBE_PATTERNS,
  });
  chrome.contextMenus.create({
    id: "import-youtube-page",
    title: "Import course",
    contexts: ["page", "video"],
    documentUrlPatterns: YOUTUBE_PATTERNS,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void setupMenus().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  void setupMenus().catch(console.error);
});

async function waitForTab(tabId) {
  // Register before inspecting the tab, so a fast navigation cannot be missed.
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    const finish = (error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (id, change, tab) => {
      if (id === tabId && change.status === "complete") {
        finish(new URL(tab.url).origin === ORIGIN ? null : new Error("Unexpected tab origin"));
      }
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(new Error("Coursify tab closed"));
    };
    const timer = setTimeout(() => finish(new Error("Coursify took too long to load")), 30_000);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete" && !tab.pendingUrl) {
        finish(new URL(tab.url).origin === ORIGIN ? null : new Error("Unexpected tab origin"));
      }
    }).catch(finish);
  });
}

async function getCoursifyTab() {
  const tabs = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  const existing = tabs.find((tab) => tab.active) ?? tabs[0];

  if (existing) {
    return { tab: existing, temporaryTab: false };
  }

  // SameSite=Strict prevents checking the session directly from the service worker.
  // A tab on the site can send its cookie normally; it never takes focus.
  const tab = await chrome.tabs.create({ url: `${ORIGIN}/login`, active: false });
  return { tab, temporaryTab: true };
}

async function closeTemporaryTab(state) {
  if (!state.temporaryTab || state.loginOpened || !state.tabId) return;

  try {
    const tab = await chrome.tabs.get(state.tabId);
    if (new URL(tab.url).origin === ORIGIN && !tab.active) {
      await chrome.tabs.remove(state.tabId);
    }
  } catch {
    // The user may already have closed it.
  }
}

async function showLogin(state) {
  // Never navigate an existing Coursify tab away from work the user has open.
  let tab;

  if (state.temporaryTab || state.loginOpened) {
    tab = await chrome.tabs.update(state.tabId, { url: `${ORIGIN}/login`, active: true });
  } else {
    tab = await chrome.tabs.create({ url: `${ORIGIN}/login`, active: true });
  }

  await updateJob(state.id, {
    tabId: tab.id,
    temporaryTab: state.temporaryTab || !state.loginOpened,
    loginOpened: true,
    status: "waiting-login",
    message: "Log in to Coursify. Your import will resume automatically.",
  });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function runImport(state) {
  try {
    await waitForTab(state.tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: importInCoursifyTab,
      args: [state.url],
    });
    const result = results[0]?.result;

    if (!result) {
      throw new Error("No response from Coursify");
    }

    const updated = await updateJob(state.id, result);
    if (!updated) return;

    if (result.status === "waiting-login") {
      if (!updated.loginOpened) await showLogin(updated);
      return;
    }

    await closeTemporaryTab(updated);
  } catch (error) {
    const updated = await updateJob(state.id, {
      status: "error",
      message: "Could not finish the import. Check your library before retrying; Coursify may have received it.",
    });
    if (updated) await closeTemporaryTab(updated);
    console.error("Coursify import failed:", error);
  }
}

async function startImport(value) {
  const url = normalizeYoutubeUrl(value);
  if (!url) return { ok: false, message: "Choose a YouTube video or playlist link." };
  if (busy) return { ok: false, message: "An import is already running." };

  busy = true;
  try {
    const previous = await readState();
    if (ACTIVE_STATUSES.has(previous?.status)) {
      return { ok: false, message: "Finish or cancel the pending import first." };
    }

    let state = {
      id: crypto.randomUUID(),
      url,
      status: "importing",
      message: "Importing your course…",
      updatedAt: Date.now(),
      tabId: null,
      temporaryTab: false,
      loginOpened: false,
      courseId: null,
    };
    await writeState(state);

    try {
      const { tab, temporaryTab } = await getCoursifyTab();
      state = await updateJob(state.id, { tabId: tab.id, temporaryTab });
      if (state) await runImport(state);
    } catch {
      await updateJob(state.id, {
        status: "error",
        message: "Could not open Coursify. Please try again.",
      });
    }
    return { ok: true };
  } finally {
    busy = false;
  }
}

async function resumeAfterLogin(sender) {
  if (busy || sender.frameId !== 0 || !sender.tab?.id) return;
  const senderUrl = new URL(sender.url ?? sender.tab.url);
  if (senderUrl.origin !== ORIGIN || ["/login", "/register"].includes(senderUrl.pathname)) return;

  busy = true;
  try {
    const state = await readState();
    if (state?.status !== "waiting-login" || state.tabId !== sender.tab.id) return;
    const updated = await updateJob(state.id, { status: "importing", message: "Signed in. Importing your course…" });
    if (updated) await runImport(updated);
  } finally {
    busy = false;
  }
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (!["import-youtube-link", "import-youtube-page"].includes(info.menuItemId)) return;
  const value = info.menuItemId === "import-youtube-link" ? info.linkUrl : info.frameUrl ?? info.pageUrl;
  void startImport(value).then(async (result) => {
    if (!result.ok) await chrome.action.setTitle({ title: `Coursify — ${result.message}` });
  }).catch(console.error);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void readState().then(async (state) => {
    if (state?.tabId === tabId && state.status === "waiting-login") {
      await updateJob(state.id, {
        status: "error",
        message: "Login tab closed. Click Retry to import this course when you are ready.",
      });
    }
  }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (message?.type === "coursify-import-alive") {
    if (sender.frameId === 0 && sender.tab?.id && sender.url?.startsWith(`${ORIGIN}/`)) {
      sendResponse({ ok: true });
    }
    return;
  }

  if (message?.type === "coursify-page-ready") {
    void resumeAfterLogin(sender).catch(console.error);
    return;
  }

  // Only the packaged toolbar popup can start, cancel, or retry an import.
  if (sender.url !== chrome.runtime.getURL("popup.html")) return;

  const handle = async () => {
    switch (message?.type) {
      case "import-current": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return startImport(tab?.url);
      }
      case "retry": {
        const state = await readState();
        return startImport(state?.url);
      }
      case "focus-login": {
        const state = await readState();
        if (state?.status !== "waiting-login" || !state.tabId) {
          return { ok: false, message: "There is no pending login." };
        }
        const tab = await chrome.tabs.update(state.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      }
      case "cancel": {
        const state = await readState();
        if (!state || state.status !== "waiting-login" || busy) {
          return { ok: false, message: "An import is running. Wait for it to finish." };
        }
        await writeState({ ...state, status: "cancelled", message: "Pending import cancelled.", updatedAt: Date.now() });
        return { ok: true };
      }
      case "recover": {
        const state = await readState();
        if (state?.status === "importing" && !busy && Date.now() - state.updatedAt > 180_000) {
          await updateJob(state.id, {
            status: "error",
            message: "The import was interrupted. Check your library before retrying.",
          });
        }
        return { ok: true };
      }
      default:
        return { ok: false, message: "Unknown action." };
    }
  };

  handle().then(sendResponse).catch(() => sendResponse({ ok: false, message: "The extension could not finish this action." }));
  return true;
});
