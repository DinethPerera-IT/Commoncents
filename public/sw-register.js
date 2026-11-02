// Registers the service worker. A separate file (not an inline <script>) so the
// Content-Security-Policy can forbid inline scripts entirely.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
