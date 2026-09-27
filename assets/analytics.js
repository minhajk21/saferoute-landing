// /assets/analytics.js: the one place the site decides whether to count a visit.
//
// Cloudflare Web Analytics is cookieless and stores nothing on the device, but
// a visitor must still be able to say no. The UK analytics exemption (Data
// (Use and Access) Act 2025) asks for a simple, free way to object. So the
// beacon loads only when the visitor has not objected:
//   - never when the browser sends Global Privacy Control
//     (navigator.globalPrivacyControl), which needs no action from them at all;
//   - never after they switch it off at /privacy-choices/, which keeps ONE
//     flag in this browser's localStorage ("sr:analytics-optout" = "1").
// Nothing else is ever stored, and nothing is stored unless they opt out.
//
// Every page includes this file instead of the beacon tag, so the rule cannot
// drift between the ~2,700 generated pages and the hand-written ones. The
// token is public by design: it ships in every page Cloudflare's own snippet
// would be on.
(function () {
  var KEY = 'sr:analytics-optout';
  try {
    if (navigator.globalPrivacyControl) return;
    if (window.localStorage && localStorage.getItem(KEY) === '1') return;
  } catch (e) { /* storage blocked: nobody could have opted out through it */ }
  var s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.setAttribute('data-cf-beacon', '{"token": "a7d4a481ed8b4512a43225404078e7ab"}');
  document.head.appendChild(s);
})();
