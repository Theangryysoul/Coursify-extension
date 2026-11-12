// Everything runs in the isolated extension world on the Coursify origin.
// The HTTP-only, SameSite=Strict cookie never needs to leave the browser.
//
// This function is injected with chrome.scripting.executeScript, which only
// serializes the function itself. It must stay self-contained: module-scope
// values are not available in the injected page, so keep the origin list inline.
export async function importInCoursifyTab(courseUrl) {
  const allowedOrigins = ["https://getcoursify.vercel.app", "https://coursify-v2.vercel.app"];

  if (!allowedOrigins.includes(location.origin)) {
    return { status: "error", message: "The Coursify tab changed. Please try again." };
  }

  const request = async (path, options = {}) => {
    const response = await fetch(`/api/v1${path}`, {
      ...options,
      credentials: "include",
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
    const data = await response.json().catch(() => null);
    return { response, data };
  };

  let importStarted = false;
  // A large playlist can take longer than a service worker's 30-second idle limit.
  // Extension messages keep its job alive until the same-origin request finishes.
  const keepAlive = setInterval(() => {
    chrome.runtime.sendMessage({ type: "coursify-import-alive" }).catch(() => {});
  }, 20_000);

  try {
    const session = await request("/auth/refresh", { method: "POST" });

    if (session.response.status === 401) {
      return { status: "waiting-login", message: "Log in to Coursify. Your import will resume automatically." };
    }

    const accessToken = session.data?.data?.accessToken;

    if (!session.response.ok || session.data?.success !== true || !accessToken) {
      // A 404 or non-JSON response means this deployment has no Coursify API
      // (e.g. an older site), so the other deployment may still work.
      const retryable = session.data === null || session.response.status === 404;
      return {
        status: "error",
        message: session.data?.message ?? "Could not check your Coursify session. Please try again.",
        ...(retryable ? { retryable: true } : {}),
      };
    }

    importStarted = true;
    const result = await request("/youtube/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ url: courseUrl }),
    });

    if (result.response.status === 401) {
      return { status: "waiting-login", message: "Your session expired. Log in to resume this import." };
    }

    if (result.response.ok && result.data?.success === true) {
      return {
        status: "success",
        message: "Course imported! It is now in your Coursify library.",
        courseId: result.data?.data?._id ?? null,
      };
    }

    return {
      status: "error",
      message: result.data?.message ?? `Coursify returned an error (${result.response.status}). Please try again.`,
    };
  } catch {
    return {
      status: "error",
      message: importStarted
        ? "The connection ended before import was confirmed. Check your library before retrying."
        : "Could not reach Coursify. Check your connection and try again.",
      // The import never reached the server, so another Coursify deployment
      // can safely be tried without risking a duplicate course.
      retryable: !importStarted,
    };
  } finally {
    clearInterval(keepAlive);
  }
}
