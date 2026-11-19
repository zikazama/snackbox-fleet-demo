// Fetch shim for the static (GitHub Pages) deployment of the demo.
//
// When the page is served from a static host there is no HTTP API behind it,
// so /api/* is answered in-process by engine.js. Every rule of the demo
// (durable outbox, idempotent ingest, OTA health gate) still applies; only the
// transport is faked, and the store lives in memory. Locally (`node server.js`
// or `docker compose up`) the flag is never set and this file does nothing.
//
// Activated automatically on *.github.io, or when the URL has ?inprocess=1.

(function () {
  var STATIC = /(^|\.)github\.io$/.test(location.hostname) || /[?&]inprocess=1\b/.test(location.search);
  if (!STATIC) return;

  var handle = null;
  var ready = import('./engine.js').then(function (m) {
    handle = m.handle;
  });

  function response(status, payload) {
    return {
      ok: status >= 200 && status < 300,
      status: status,
      json: function () { return Promise.resolve(payload); },
    };
  }

  window.fetch = function (input, init) {
    var url = String(input);
    var method = (init && init.method) || 'GET';

    var match = url.match(/^([^?]*)(?:\?(.*))?$/);
    var rawPath = match ? match[1] : url;
    var path = rawPath.replace(/\/+$/, '') || '/';
    var query = new URLSearchParams(match && match[2] ? match[2] : '');

    if (path.indexOf('/api/') !== 0) {
      return Promise.reject(new Error('static build: not available'));
    }

    return ready.then(function () {
      var body = {};
      if (init && init.body) {
        try { body = JSON.parse(init.body); } catch (e) { body = {}; }
      }
      var result;
      try {
        result = handle(method, path, body, query);
      } catch (err) {
        result = { status: 500, json: { error: String((err && err.message) || err) } };
      }
      return response(result.status, result.json);
    });
  };

  // Make the shim visible in the header: this deployment has no server.
  window.addEventListener('DOMContentLoaded', function () {
    var brand = document.querySelector('.brand small');
    if (brand) brand.textContent = '20 simulated machines · static in-browser build · outbox + idempotent ingest + OTA gate';
  });
})();
