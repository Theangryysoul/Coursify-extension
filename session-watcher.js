(() => {
  let timer = null;

  function notifyWhenSignedIn() {
    // Password, registration, and Google login all navigate away from auth pages.
    // The worker still verifies the cookie before importing anything.
    if (["/login", "/register"].includes(location.pathname)) return;
    chrome.runtime.sendMessage({ type: "coursify-page-ready" }).catch(() => {});
  }

  function watch(state) {
    if (timer !== null) clearInterval(timer);
    timer = null;

    if (state?.status !== "waiting-login") return;

    // React Router navigation does not reload the page or trigger tabs.onUpdated.
    // Poll only while an import is waiting, including login in an already open tab.
    timer = setInterval(notifyWhenSignedIn, 2_000);
    notifyWhenSignedIn();
  }

  chrome.storage.local.get("importState").then(({ importState }) => watch(importState)).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.importState) watch(changes.importState.newValue);
  });
})();
