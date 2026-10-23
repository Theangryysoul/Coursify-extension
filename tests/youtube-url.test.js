import test from "node:test";
import assert from "node:assert/strict";
import { normalizeYoutubeUrl } from "../youtube-url.js";

const ID = "dQw4w9WgXcQ";
const VIDEO = `https://www.youtube.com/watch?v=${ID}`;

test("normalizes all supported video formats", () => {
  for (const value of [
    `${VIDEO}&t=42&si=tracking`,
    `http://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}?si=tracking`,
    `https://www.youtu.be/${ID}/`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
  ]) {
    assert.equal(normalizeYoutubeUrl(value), VIDEO, value);
  }
});

test("playlist parameters take precedence, matching the existing backend", () => {
  for (const value of [
    "https://www.youtube.com/playlist?list=PL_course-123&index=2",
    `${VIDEO}&list=PL_course-123&index=2`,
    `https://youtu.be/${ID}?list=PL_course-123`,
  ]) {
    assert.equal(normalizeYoutubeUrl(value), "https://www.youtube.com/playlist?list=PL_course-123");
  }
});

test("rejects unsupported, malformed, and lookalike URLs", () => {
  for (const value of [
    undefined, "", "not a url", "/watch?v=dQw4w9WgXcQ",
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://evil.example/watch?v=${ID}`,
    `https://www.youtube.com@evil.example/watch?v=${ID}`,
    `https://user:secret@www.youtube.com/watch?v=${ID}`,
    `ftp://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com:444/watch?v=${ID}`,
    "https://www.youtube.com/", "https://www.youtube.com/@channel",
    "https://www.youtube.com/results?search_query=courses",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQextra",
    "https://www.youtube.com/playlist?list=",
    "https://www.youtube.com/playlist?list=bad%26value",
    `https://youtu.be/${ID}/extra`,
    `https://www.youtube.com/channel/${ID}?list=PL_course-123`,
  ]) {
    assert.equal(normalizeYoutubeUrl(value), null, String(value));
  }
});
