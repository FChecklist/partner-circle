// Fills every <span data-payee> with the payee's name, read from the payee record (GET /v1/public/brand).
// The name is never written into a page: the owner changes it in one place (PUT /v1/admin/tenant { payee_name }) and every page follows.
// If the record cannot be read, the words already inside the span stay as they are.
(function () {
  var spans = document.querySelectorAll('[data-payee]');
  if (!spans.length || !window.fetch) return;
  fetch('/v1/public/brand', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (b) {
      var name = b && typeof b.payee_name === 'string' ? b.payee_name.trim() : '';
      if (!name) return;
      for (var i = 0; i < spans.length; i++) spans[i].textContent = name;
    })
    .catch(function () { /* keep the words already on the page */ });
})();
