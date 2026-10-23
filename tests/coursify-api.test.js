import test from "node:test";
import assert from "node:assert/strict";
import { importInCoursifyTab } from "../coursify-api.js";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const ORIGIN = "https://vishal-coursify.vercel.app";
const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function mockRequests(t, responses, origin = ORIGIN) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { origin };
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    const result = responses.shift();
    if (result instanceof Error) throw result;
    assert.ok(result, "No unexpected API request");
    return result;
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  });
  return calls;
}

test("imports with the site session and never returns tokens", async (t) => {
  const calls = mockRequests(t, [
    response(200, { success: true, data: { accessToken: "secret-token" } }),
    response(200, { success: true, data: { _id: "course-id" } }),
  ]);
  const result = await importInCoursifyTab(URL);
  assert.deepEqual(result, { status: "success", message: "Course imported! It is now in your Coursify library.", courseId: "course-id" });
  assert.equal(calls[0].path, "/api/v1/auth/refresh");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[1].path, "/api/v1/youtube/import");
  assert.equal(calls[1].options.headers.Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(calls[1].options.body), { url: URL });
  for (const call of calls) assert.equal(call.options.credentials, "include");
  assert.ok(!JSON.stringify(result).includes("secret-token"));
});

test("an absent session waits for login without attempting import", async (t) => {
  const calls = mockRequests(t, [response(401, { success: false, message: "Unauthorized" })]);
  assert.equal((await importInCoursifyTab(URL)).status, "waiting-login");
  assert.equal(calls.length, 1);
});

test("server failures do not masquerade as a logged-out session", async (t) => {
  const calls = mockRequests(t, [response(503, { success: false, message: "Database unavailable" })]);
  assert.deepEqual(await importInCoursifyTab(URL), { status: "error", message: "Database unavailable" });
  assert.equal(calls.length, 1);
});

test("malformed session responses never issue an import", async (t) => {
  const calls = mockRequests(t, [response(200, { success: true, data: {} })]);
  assert.equal((await importInCoursifyTab(URL)).status, "error");
  assert.equal(calls.length, 1);
});

test("an expired import authorization waits for login", async (t) => {
  mockRequests(t, [
    response(200, { success: true, data: { accessToken: "secret-token" } }),
    response(401, { success: false }),
  ]);
  assert.equal((await importInCoursifyTab(URL)).status, "waiting-login");
});

test("duplicate and rate-limit errors retain the backend message", async (t) => {
  mockRequests(t, [
    response(200, { success: true, data: { accessToken: "secret-token" } }),
    response(400, { success: false, message: "Course already exists in your library." }),
    response(200, { success: true, data: { accessToken: "secret-token" } }),
    response(429, { success: false, message: "Too many YouTube requests." }),
  ]);
  assert.deepEqual(await importInCoursifyTab(URL), { status: "error", message: "Course already exists in your library." });
  assert.deepEqual(await importInCoursifyTab(URL), { status: "error", message: "Too many YouTube requests." });
});

test("network failure before import is reported without redirecting", async (t) => {
  const calls = mockRequests(t, [new Error("offline")]);
  assert.match((await importInCoursifyTab(URL)).message, /Could not reach Coursify/);
  assert.equal(calls.length, 1);
});

test("network failure after sending import warns about uncertain completion", async (t) => {
  mockRequests(t, [
    response(200, { success: true, data: { accessToken: "secret-token" } }),
    new Error("timeout"),
  ]);
  assert.match((await importInCoursifyTab(URL)).message, /Check your library before retrying/);
});

test("non-JSON API failures become a readable error", async (t) => {
  mockRequests(t, [{ ok: false, status: 502, json: async () => { throw new Error("HTML error page"); } }]);
  assert.equal((await importInCoursifyTab(URL)).status, "error");
});

test("a tab navigated off-site cannot issue credentialed requests", async (t) => {
  const calls = mockRequests(t, [], "https://other.example");
  assert.equal((await importInCoursifyTab(URL)).status, "error");
  assert.equal(calls.length, 0);
});

test("long imports keep the service worker alive and clear the timer afterwards", async () => {
  const source = await readFile(new globalThis.URL("../coursify-api.js", import.meta.url), "utf8");
  let timerCallback;
  let interval;
  let cleared;
  const messages = [];
  const responses = [
    response(200, { success: true, data: { accessToken: "secret-token" } }),
    response(200, { success: true, data: { _id: "course-id" } }),
  ];
  const context = {
    location: { origin: ORIGIN },
    AbortSignal,
    setInterval: (callback, ms) => { timerCallback = callback; interval = ms; return 7; },
    clearInterval: (id) => { cleared = id; },
    chrome: { runtime: { sendMessage: async (message) => { messages.push(message.type); } } },
    fetch: async () => {
      if (responses.length === 1) timerCallback();
      return responses.shift();
    },
  };
  const run = runInNewContext(`${source.replace("export async function", "async function")}\nimportInCoursifyTab`, context);
  assert.equal((await run(URL)).status, "success");
  assert.equal(interval, 20_000);
  assert.deepEqual(messages, ["coursify-import-alive"]);
  assert.equal(cleared, 7);
});
