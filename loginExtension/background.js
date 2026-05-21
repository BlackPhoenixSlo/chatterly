// Service worker — coordinates capture flow.
// Responsibilities:
//   1. Wake/log on capture messages from bridge.js
//   2. Reset lastCapture when the user explicitly starts a new sign-in
//   3. Expose getCookies() to the popup (popup can't read onlyfans cookies
//      directly, only the SW can via chrome.cookies + host permission)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "capture") {
    // Just log — bridge.js already wrote storage. Useful for debugging.
    console.log("[Chatterly] capture received", {
      user_id: msg.payload?.headers?.["user-id"],
      x_of_rev: msg.payload?.headers?.["x-of-rev"],
      at: msg.payload?.capturedAt,
    });
    return;
  }

  if (msg.type === "getCookies") {
    chrome.cookies.getAll({ domain: "onlyfans.com" }).then((cookies) => {
      sendResponse({ cookies: cookies || [] });
    }).catch((err) => {
      sendResponse({ cookies: [], error: String(err && err.message || err) });
    });
    return true;  // async response
  }

  if (msg.type === "resetCapture") {
    chrome.storage.local.remove(["lastCapture"]).then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Chatterly] login capture extension installed");
});
