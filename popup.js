const statusBox = document.querySelector(".status");
const label = document.querySelector("#status-label");
const message = document.querySelector("#status-message");
const url = document.querySelector("#course-url");
const feedback = document.querySelector("#feedback");
const importButton = document.querySelector("#import-current");
const retryButton = document.querySelector("#retry");
const loginButton = document.querySelector("#login");
const cancelButton = document.querySelector("#cancel");
let currentState = null;
let submitting = false;

function render(state) {
  currentState = state;
  const labels = {
    importing: "Importing course…",
    "waiting-login": "Sign in to continue",
    success: "Course imported",
    error: "Import needs attention",
    cancelled: "Import cancelled",
  };

  statusBox.dataset.status = state?.status ?? "ready";
  label.textContent = labels[state?.status] ?? "Ready to import";
  message.textContent = state?.message ?? "Already signed in? Your course imports without leaving YouTube.";
  url.textContent = state?.url ?? "";
  url.hidden = !state?.url;
  importButton.disabled = submitting || ["importing", "waiting-login"].includes(state?.status);
  retryButton.hidden = !state?.url || !["error", "cancelled"].includes(state?.status);
  retryButton.disabled = submitting;
  loginButton.hidden = state?.status !== "waiting-login";
  loginButton.disabled = submitting;
  cancelButton.hidden = state?.status !== "waiting-login";
  cancelButton.disabled = submitting;
}

async function send(type) {
  submitting = true;
  feedback.hidden = true;
  render(currentState);

  try {
    const result = await chrome.runtime.sendMessage({ type });
    if (!result?.ok) {
      feedback.textContent = result?.message ?? "Could not finish this action. Please try again.";
      feedback.hidden = false;
    }
  } catch {
    feedback.textContent = "The extension was reloaded. Reopen this popup and try again.";
    feedback.hidden = false;
  } finally {
    submitting = false;
    render(currentState);
  }
}

importButton.addEventListener("click", () => void send("import-current"));
retryButton.addEventListener("click", () => void send("retry"));
loginButton.addEventListener("click", () => void send("focus-login"));
cancelButton.addEventListener("click", () => void send("cancel"));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.importState) render(changes.importState.newValue);
});

await chrome.runtime.sendMessage({ type: "recover" }).catch(() => {});
const { importState } = await chrome.storage.local.get("importState");
render(importState);
