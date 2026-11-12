import { normalizeYoutubeUrl } from "./youtube-url.js";
import { importInCoursifyTab } from "./coursify-api.js";

const ORIGINS = ["https://getcoursify.vercel.app", "https://coursify-v2.vercel.app"];
const PRIMARY_ORIGIN = ORIGINS[0];
const STATE_KEY = "importState";
const PREFERRED_KEY = "preferredOrigin";
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

// Remembers which Coursify deployment the user actually uses, so the fallback
// becomes the default once it has worked at least once.
async function readPreferredOrigin() {
  const stored = (await chrome.storage.local.get(PREFERRED_KEY))[PREFERRED_KEY];
  return ORIGINS.includes(stored) ? stored : PRIMARY_ORIGIN;
}

async function rememberOrigin(origin) {
  if (ORIGINS.includes(origin)) {
    await chrome.storage.local.set({ [PREFERRED_KEY]: origin });
  }
}

function orderedOrigins(preferred) {
  return [preferred, ...ORIGINS.filter((origin) => origin !== preferred)];
}

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
        finish(ORIGINS.includes(new URL(tab.url).origin) ? null : new Error("Unexpected tab origin"));
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
        finish(ORIGINS.includes(new URL(tab.url).origin) ? null : new Error("Unexpected tab origin"));
      }
    }).catch(finish);
  });
}

async function findCoursifyTab(origin) {
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  return tabs.find((tab) => tab.active) ?? tabs[0] ?? null;
}

async function closeIfTemporary(tabId, temporaryTab) {
  if (!temporaryTab || !tabId) return;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (ORIGINS.includes(new URL(tab.url).origin) && !tab.active) {
      await chrome.tabs.remove(tabId);
    }
  } catch {
    // The user may already have closed it.
  }
}

async function tryImport(url, tabId) {
  try {
    await waitForTab(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: importInCoursifyTab,
      args: [url],
    });
    return results[0]?.result ?? null;
  } catch (error) {
    console.error("Coursify attempt failed:", error);
    return null;
  }
}

async function finalize(origin, tabId, temporaryTab, result) {
  await closeIfTemporary(tabId, temporaryTab);
  const { retryable, ...rest } = result;
  return { ...rest, origin, tabId, temporaryTab, loginOpened: false };
}

async function openLogin(state, candidate) {
  // Reuse a temporary tab for the login screen; never navigate an existing
  // work tab the user has open.
  const tab = candidate.temporaryTab
    ? await chrome.tabs.update(candidate.tabId, { url: `${candidate.origin}/login`, active: true })
    : await chrome.tabs.create({ url: `${candidate.origin}/login`, active: true });

  await chrome.windows.update(tab.windowId, { focused: true });
  return {
    status: "waiting-login",
    message: "Log in to Coursify. Your import will resume automatically.",
    courseId: null,
    origin: candidate.origin,
    tabId: tab.id,
    temporaryTab: candidate.temporaryTab || !state.loginOpened,
    loginOpened: true,
  };
}

// Tries each Coursify deployment in order (the user's last used one first) and
// falls back to the next one whenever a tab needs login or cannot be reached.
async function attemptImport(state) {
  const order = orderedOrigins(await readPreferredOrigin());
  const loginCandidates = [];
  const attempted = new Set();
  let unreachable = false;

  // Prefer tabs the user already has open, so nothing is navigated or created.
  for (const origin of order) {
    const tab = await findCoursifyTab(origin);
    if (!tab) continue;

    attempted.add(origin);
    const result = await tryImport(state.url, tab.id);

    if (!result) {
      unreachable = true;
      continue;
    }

    if (result.status === "waiting-login") {
      loginCandidates.push({ tabId: tab.id, origin, temporaryTab: false });
      continue;
    }

    if (result.retryable) {
      unreachable = true;
      continue;
    }

    return finalize(origin, tab.id, false, result);
  }

  // A deployment that just needs login is a valid target, so stop there instead
  // of opening extra tabs. Otherwise try a fresh tab on each untried deployment.
  if (!loginCandidates.length) {
    for (const origin of order) {
      if (attempted.has(origin)) continue;

      const tab = await chrome.tabs.create({ url: `${origin}/login`, active: false });
      const result = await tryImport(state.url, tab.id);

      if (result?.status === "waiting-login") {
        loginCandidates.push({ tabId: tab.id, origin, temporaryTab: true });
        break;
      }

      if (!result || result.retryable) {
        unreachable = true;
        await closeIfTemporary(tab.id, true);
        continue;
      }

      return finalize(origin, tab.id, true, result);
    }
  }

  if (loginCandidates.length) {
    const candidate = loginCandidates[0];

    // A login tab is already open; keep waiting instead of opening another one.
    if (state.loginOpened) {
      return {
        status: "waiting-login",
        message: state.message,
        courseId: null,
        origin: candidate.origin,
        tabId: candidate.tabId,
        temporaryTab: candidate.temporaryTab,
        loginOpened: true,
      };
    }

    return openLogin(state, candidate);
  }

  return {
    status: "error",
    message: unreachable
      ? "Could not reach Coursify. Check your connection and try again."
      : "Could not finish the import. Check your library before retrying; Coursify may have received it.",
    courseId: null,
    origin: order[0],
    tabId: null,
    temporaryTab: false,
    loginOpened: false,
  };
}

async function finishImport(state) {
  const patch = await attemptImport(state);
  await rememberOrigin(patch.origin);
  return updateJob(state.id, patch);
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
      origin: PRIMARY_ORIGIN,
    };
    await writeState(state);

    try {
      await finishImport(state);
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
  if (!ORIGINS.includes(senderUrl.origin) || ["/login", "/register"].includes(senderUrl.pathname)) return;

  busy = true;
  try {
    const state = await readState();
    if (state?.status !== "waiting-login" || state.tabId !== sender.tab.id) return;
    const updated = await updateJob(state.id, { status: "importing", message: "Signed in. Importing your course…" });
    if (updated) await finishImport(updated);
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
    if (sender.frameId === 0 && sender.tab?.id && ORIGINS.some((o) => sender.url?.startsWith(`${o}/`))) {
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
