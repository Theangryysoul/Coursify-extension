const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

export function normalizeYoutubeUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    !["https:", "http:"].includes(url.protocol) ||
    !YOUTUBE_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }

  const shortLink = url.hostname.endsWith("youtu.be");
  const videoPath = /^\/(shorts|live|embed)\/([^/]+)\/?$/.exec(url.pathname);
  const supportedPath = shortLink || videoPath || ["/watch", "/playlist"].includes(url.pathname);

  if (!supportedPath) {
    return null;
  }

  // A watch link containing `list` imports the whole playlist, just like Coursify.
  const playlistId = url.searchParams.get("list");

  if (playlistId) {
    return /^[A-Za-z0-9_-]{2,200}$/.test(playlistId)
      ? `https://www.youtube.com/playlist?list=${playlistId}`
      : null;
  }

  const videoId = shortLink
    ? url.pathname.slice(1).replace(/\/$/, "")
    : videoPath?.[2] ?? (url.pathname === "/watch" ? url.searchParams.get("v") : null);

  return /^[A-Za-z0-9_-]{11}$/.test(videoId ?? "")
    ? `https://www.youtube.com/watch?v=${videoId}`
    : null;
}
