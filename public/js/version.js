// Shows the product version in the footer (from /version.json; silent if it cannot load).
fetch('version.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
  if (!v || !v.version) return;
  var f = document.querySelector('footer.foot'); if (!f) return;
  var s = document.createElement('div'); s.className = 'mut';
  s.textContent = (v.product || 'Partner Circle') + ' v' + String(v.version).slice(0, 20) + ' · ' + String(v.releasedAtIST || '').slice(0, 40);
  f.appendChild(s);
}).catch(function () {});
