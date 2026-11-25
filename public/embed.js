/* Partner Circle embed snippet (<1 KB idea, no dependencies). Add to any of our sites:
   <script src="https://<partner-circle-host>/embed.js" async></script>
   It remembers the partner click id (?pc=ck_...) and optional discount code (?pcode=...) for 30 days on the site's own domain.
   Your server then passes them to Partner Circle with the sale: click_id / code. Nothing personal is stored or sent from the browser. */
(function (w, d) {
  'use strict';
  var DAYS = 30, CK = 'pc_click', CC = 'pc_code';
  function setC(n, v) { try { d.cookie = n + '=' + encodeURIComponent(v) + ';max-age=' + DAYS * 86400 + ';path=/;SameSite=Lax' + (location.protocol === 'https:' ? ';Secure' : ''); } catch (e) {} try { w.localStorage.setItem(n, v); } catch (e) {} }
  function getC(n) {
    var m = (d.cookie || '').match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    if (m) return decodeURIComponent(m[1]);
    try { return w.localStorage.getItem(n) || ''; } catch (e) { return ''; }
  }
  try {
    if (w.top !== w.self) throw 0; // framed (for example a hidden iframe on another site): never store attribution
    var q = new URL(w.location.href).searchParams;
    var c = q.get('pc'), k = q.get('pcode');
    if (c && /^ck_[0-9a-f]{16}$/.test(c)) setC(CK, c);
    if (k && /^[A-Za-z0-9-]{3,24}$/.test(k)) setC(CC, k.toUpperCase());
  } catch (e) {}
  w.PartnerCircle = {
    clickId: function () { return getC(CK); },
    code: function () { return getC(CC); },
    /* Adds hidden fields to a form so your backend receives them with the order. */
    attach: function (form) {
      [['pc_click_id', this.clickId()], ['pc_code', this.code()]].forEach(function (p) {
        if (!p[1]) return;
        var i = d.createElement('input'); i.type = 'hidden'; i.name = p[0]; i.value = p[1]; form.appendChild(i);
      });
    }
  };
})(window, document);
