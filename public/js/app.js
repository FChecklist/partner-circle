/* Partner Circle web app: talks only to the /v1 API. All text goes through textContent (no innerHTML with data). */
(function () {
  'use strict';
  var KEYSTORE = 'pc_key';
  var $ = function (s) { return document.querySelector(s); };
  var state = { key: null, who: null, sites: [] };

  // ---- tiny DOM builder -------------------------------------------------------------------------------------
  function E(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (k === 'class') el.className = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else if (k === 'style') setStyle(el, v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  // The deployed CSP is style-src 'self': a style="" attribute (or setAttribute('style')) is blocked, but assigning el.style.x is allowed.
  function setStyle(el, v) {
    if (typeof v === 'string') {
      v.split(';').forEach(function (d) { var i = d.indexOf(':'); if (i > 0) el.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim()); });
    } else Object.keys(v).forEach(function (n) { el.style[n] = v[n]; });
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach(function (x) { add(el, x); });
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  var money = function (m) { return '₹' + (Number(m || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var when = function (t) { return t ? new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '-'; };
  var day = function (t) { return t ? new Date(t).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '-'; };
  var pill = function (t, cls) { return E('span', { class: 'pill' + (cls ? ' ' + cls : '') }, t); };
  var card = function () { return E.apply(null, ['div', { class: 'card' }].concat([].slice.call(arguments))); };
  function table(head, rows) {
    return E('div', { class: 'wrap' }, E('table', null, E('tr', null, head.map(function (h) { return E('th', null, h); })),
      rows.length ? rows.map(function (r) { return E('tr', null, r.map(function (c) { return E('td', null, c); })); }) : E('tr', null, E('td', { colspan: head.length, class: 'mut' }, 'Nothing here yet.'))));
  }
  function toast(t, bad) {
    var d = E('div', { class: 'toast' + (bad ? ' bad' : '') }, t);
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 3500);
  }

  // ---- API -------------------------------------------------------------------------------------------------
  function api(method, path, body, extra) {
    var h = { 'content-type': 'application/json' };
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    if (state.key) h.authorization = 'Bearer ' + state.key;
    return fetch(path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* non-json */ }
        if (!r.ok) { var e = new Error((j && j.error && j.error.message) || ('Request failed (' + r.status + ')')); e.status = r.status; e.code = j && j.error && j.error.code; throw e; }
        return j;
      });
    });
  }
  function act(fn, okMsg) { // run an action, toast result, re-render
    return function () {
      Promise.resolve().then(fn).then(function () { if (okMsg) toast(okMsg); route(); }, function (e) { toast(e.message, true); });
    };
  }
  function field(label, input) { return E('div', null, E('label', null, label), input); }

  // ---- shell -----------------------------------------------------------------------------------------------
  var USER_TABS = { dash: 'Dashboard', team: 'Team', links: 'Links and codes', earn: 'Earnings', profile: 'My details', logs: 'Logs' };
  var ADMIN_TABS = { queue: 'Approvals', payouts: 'Payouts', users: 'People', policy: 'Policy and sites', schemes: 'Schemes', suite: 'Suite', keys: 'API keys', audit: 'Action log', ai: 'AI actions' };
  var ROLE_NAME = { refer: 'Refer and Earn', partner: 'Growth Partner', exec: 'Sales Executive', leader: 'Sales Team Leader', manager: 'Sales Manager', owner: 'Owner', ai: 'AI master' };

  function tabs(map, cur) {
    return E('div', { class: 'tabs' }, Object.keys(map).map(function (k) { return E('a', { href: '#/' + k, class: k === cur ? 'on' : '' }, map[k]); }));
  }
  function signOut() { state.key = null; state.who = null; try { sessionStorage.removeItem(KEYSTORE); localStorage.removeItem(KEYSTORE); } catch (e) { /* ignore */ } location.hash = '#/'; route(); }

  var VIEWS = {};
  function render(node) { var app = $('#app'); app.textContent = ''; app.appendChild(node); window.scrollTo(0, 0); }

  function route() {
    var page = (location.hash.replace(/^#\//, '') || '').split('?')[0];
    if (!state.key) return render(page === 'register' ? VIEWS.register() : VIEWS.login());
    if (!state.who) {
      return api('GET', '/v1/whoami').then(function (w) { state.who = w; chrome(); route(); }, function () { signOut(); toast('That key is not valid any more.', true); });
    }
    chrome();
    var admin = state.who.kind === 'owner' || state.who.kind === 'ai';
    var map = admin ? ADMIN_TABS : USER_TABS;
    if (!map[page]) page = admin ? 'queue' : 'dash';
    var wrap = E('div', null, tabs(map, page), E('div', { id: 'view' }, E('p', { class: 'mut' }, 'Loading…')));
    render(wrap);
    Promise.resolve(VIEWS[page]()).then(function (v) { var el = wrap.querySelector('#view'); el.textContent = ''; el.appendChild(v); },
      function (e) { var el = wrap.querySelector('#view'); el.textContent = ''; el.appendChild(card(E('b', null, 'Could not load this page'), E('p', { class: 'mut' }, e.message))); });
  }
  function chrome() {
    var w = state.who; var who = $('#who'); var bar = $('#roleBar');
    who.hidden = false; who.textContent = (w.user ? w.user.name + ' · ' : '') + ROLE_NAME[w.user ? w.user.role : w.kind];
    bar.hidden = false; bar.textContent = '';
    bar.appendChild(E('span', { class: 'mut' }, w.kind === 'owner' ? 'Owner console' : w.kind === 'ai' ? 'AI master (scoped key: proposes, owner approves)' : 'Signed in'));
    bar.appendChild(E('a', { href: '#', on: { click: function (e) { e.preventDefault(); signOut(); } } }, 'Sign out'));
  }

  // ---- sign in / register ----------------------------------------------------------------------------------
  VIEWS.login = function () {
    var input = E('input', { id: 'k', placeholder: 'pck_…', autocomplete: 'off', spellcheck: 'false' });
    var remember = E('input', { type: 'checkbox', class: 'auto' });
    return E('div', null,
      E('h1', null, 'Welcome to Partner Circle'),
      E('p', null, 'One place for every site we run: share, earn, grow.'),
      card(E('b', null, 'Sign in with your key'), E('p', { class: 'mut' }, 'You received a key when you registered. It is shown only once; keep it safe.'),
        field('Your key', input), E('label', null, remember, ' Remember on this device'),
        E('p', null, E('button', { class: 'btn', on: { click: function () {
          var k = input.value.trim(); if (!/^pck_[0-9a-f]+\.[0-9a-f]+$/.test(k)) return toast('That does not look like a key.', true);
          state.key = k; try { (remember.checked ? localStorage : sessionStorage).setItem(KEYSTORE, k); } catch (e) { /* ignore */ }
          route();
        } } }, 'Sign in'))),
      card(E('b', null, 'New here?'), E('p', { class: 'mut' }, 'Join as a Growth Partner, or as a Refer and Earn member (no e-mail needed to start sharing).'),
        E('a', { class: 'btn alt', href: '#/register' }, 'Register')));
  };

  VIEWS.register = function () {
    var role = E('select', { id: 'role' }, E('option', { value: 'partner' }, 'Growth Partner (e-mail and mobile needed)'), E('option', { value: 'refer' }, 'Refer and Earn (just a name to start)'));
    var name = E('input', { id: 'n' }), email = E('input', { id: 'e', type: 'email' }), phone = E('input', { id: 'p', inputmode: 'tel' }), sponsor = E('input', { id: 's', placeholder: 'optional' });
    var out = E('div');
    var q = (location.hash.split('sponsor=')[1] || '').replace(/[^a-z0-9]/gi, ''); if (q) sponsor.value = q;
    return E('div', null, E('h1', null, 'Join Partner Circle'),
      card(field('I want to join as', role), field('Full name', name), field('E-mail', email), field('Mobile number', phone), field('Sponsor code (if someone invited you)', sponsor),
        E('p', { class: 'mut' }, 'We keep your name, e-mail and mobile number to run your account, track your sales and pay you. We share your name and e-mail with Moneypenny and Corporate Monopoly so you do not need a second login, and payout details (kept encrypted) with Razorpay when you are paid. You can see your data, rotate your key or ask for erasure from your account. Read the full privacy notice at /privacy.html.'),
        E('p', { class: 'mut' }, 'You can read our ', E('a', { href: '/terms.html', target: '_blank', rel: 'noopener' }, 'Terms and Conditions'), ' and ', E('a', { href: '/privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy notice'), ' at any time.'),
        E('button', { class: 'btn', on: { click: function () {
          var body = { role: role.value, name: name.value, email: email.value || undefined, phone: phone.value || undefined, sponsor: sponsor.value || undefined };
          api('POST', '/v1/register', body).then(function (r) {
            out.textContent = '';
            out.appendChild(card(E('b', null, 'You are in. Save your key now.'), E('p', { class: 'mut' }, 'This is your login. It is shown only once.'), E('div', { class: 'code' }, r.api_key),
              E('p', { class: 'mut' }, r.user.status === 'pending' ? 'Your request is with the team; your links appear once you are approved.' : 'You can start sharing right away.'),
              E('button', { class: 'btn alt', on: { click: function () { state.key = r.api_key; try { sessionStorage.setItem(KEYSTORE, r.api_key); } catch (e) { /* ignore */ } location.hash = '#/'; route(); } } }, 'Continue')));
          }, function (e) { toast(e.message, true); });
        } } }, 'Create my account'), out),
      E('p', null, E('a', { href: '#/' }, 'Back to sign in')));
  };

  // ---- member views ----------------------------------------------------------------------------------------
  VIEWS.dash = function () {
    return Promise.all([api('GET', '/v1/me/summary'), api('GET', '/v1/me/schemes'), api('GET', '/v1/me'), api('GET', '/v1/me/dashboard').catch(function () { return null; })]).then(function (r) {
      var s = r[0], sch = r[1].schemes, me = r[2], b = s.balance, l = s.last_30_days, suite = r[3];
      var tile = function (big, label) { return card(E('div', { class: 'big' }, big), E('span', { class: 'mut' }, label)); };
      var nodes = [E('h1', null, 'Hello ' + (me.name || '')), E('p', { class: 'mut' }, ROLE_NAME[me.role] + (me.sponsor ? ' · sponsor: ' + me.sponsor.name : ''))];
      if (me.status !== 'active') nodes.push(E('div', { class: 'note' }, 'Your account is waiting for approval. You can finish your details now.'));
      if (!me.email_verified && me.role !== 'refer') nodes.push(E('div', { class: 'note' }, 'Verify your e-mail under My details; it is needed before your first payout.'));
      nodes.push(E('div', { class: 'grid' }, tile(l.clicks, 'clicks, last 30 days'), tile(l.leads, 'sign-ups'), tile(l.sales, 'sales'), tile(money(l.net_minor), 'sales value')));
      if (s.team_size) nodes.push(card(E('b', null, 'Your team'), E('p', null, s.team_size + ' people · team sales ' + money(l.team_net_minor) + ' in 30 days')));
      nodes.push(E('h2', null, 'Money'), E('div', { class: 'grid' }, tile(money(b.available_minor), 'ready to be paid'), tile(money(b.pending_minor), 'on hold (refund window)')));
      if (b.awaiting_razorpay_minor) nodes.push(E('div', { class: 'note' }, money(b.awaiting_razorpay_minor) + ' is waiting for the payment to be confirmed by Razorpay.'));
      if (suite) nodes.push(suiteWidgets(suite, me));
      if (sch.length) {
        nodes.push(E('h2', null, 'Schemes'));
        sch.forEach(function (x) { nodes.push(card(E('div', { class: 'row' }, E('b', null, x.name), E('span', null, x.percent + '%')), bar(x.percent), E('span', { class: 'mut' }, 'Bonus ' + money(x.bonus_minor) + ' · ends ' + day(x.ends_at)))); });
      }
      return E('div', null, nodes);
    });
  };
  // Moneypenny credits, Monopoly targets and achievements, and where commissions go. Everything is read through Partner Circle: no second login.
  function suiteWidgets(d, me) {
    var cur = d.brand.currency_label, mp = d.moneypenny, mo = d.monopoly, c = d.commissions;
    var soft = function (st) { return st === 'live' ? null : E('p', { class: 'mut' }, st === 'stale' ? 'Showing the last numbers we saw; they refresh in a moment.' : st === 'setting_up' ? 'Your account is being set up here. Check again in a minute.' : st === 'not_connected' || st === 'off' ? 'Not switched on yet.' : 'Refreshing, back in a moment.'); };
    var nodes = [E('h2', null, cur + ' (credits)')];
    if (mp.lines) {
      var body = [E('div', { class: 'big' }, mp.credits.toLocaleString('en-IN')), E('span', { class: 'mut' }, mp.lines.owned), E('p', { class: 'mut' }, mp.lines.rate)];
      if (mp.lines.convert) body.push(E('p', null, mp.lines.convert));
      if (mp.lines.settling) body.push(E('p', { class: 'mut' }, mp.lines.settling));
      if (mp.can_convert > 0 && mp.conversion_enabled && me.status === 'active') {
        var amt = E('input', { type: 'number', min: '1', max: String(mp.can_convert), value: String(mp.can_convert) });
        var convKey = 'w' + Date.now() + Math.random().toString(16).slice(2, 10); // one key per render: a double click is the same request
        body.push(field('How many ' + cur + ' to convert', amt), E('button', { class: 'btn alt', on: { click: act(function () {
          return api('POST', '/v1/me/moneypenny/convert-request', { credits: Number(amt.value) }, { 'idempotency-key': convKey });
        }, 'Request sent. A person approves it before any money moves.') } }, 'Ask to convert'));
      }
      nodes.push(card.apply(null, body.concat([soft(mp.status)])));
    } else nodes.push(card(soft(mp.status) || E('p', { class: 'mut' }, 'Nothing to show yet.')));
    nodes.push(E('h2', null, 'Targets and achievements'));
    var t = mo.targets || [];
    if (t.length) t.forEach(function (x) { var pc = x.goal ? Math.round((x.progress / x.goal) * 100) : 0; nodes.push(card(E('div', { class: 'row' }, E('b', null, x.name), E('span', null, x.progress + ' / ' + x.goal + (x.unit ? ' ' + x.unit : ''))), bar(pc), E('span', { class: 'mut' }, x.period + (x.ends_at ? ' · ends ' + day(x.ends_at) : '')))); });
    else nodes.push(card(E('p', { class: 'mut' }, mo.status === 'live' || mo.status === 'stale' ? 'No targets set for you yet.' : 'Targets appear here once they are connected.'), soft(mo.status === 'live' ? 'live' : mo.status)));
    var a = mo.achievements || { badges: [] };
    if (a.level != null || (a.badges && a.badges.length)) nodes.push(card(E('b', null, 'Level ' + (a.level == null ? '-' : a.level)), E('p', null, (a.badges || []).map(function (bd) { return pill(bd.name); }))));
    if (c.destination === 'moneypenny') nodes.push(E('div', { class: 'note' }, 'Your matured commissions are paid to you as ' + cur + '. Sent so far: ' + money(c.sent_to_moneypenny_minor) + (c.on_the_way_to_moneypenny_minor ? ' · on the way: ' + money(c.on_the_way_to_moneypenny_minor) : '') + '.'));
    return E('div', null, nodes);
  }
  function bar(p) { return E('div', { class: 'bar' }, E('i', { class: p >= 80 ? 'g' : p >= 40 ? 'a' : 'r', style: { width: Math.max(0, Math.min(100, Number(p) || 0)) + '%' } })); }

  // ---- suite console (owner changes; the AI master can only look) -----------------------------------------------
  VIEWS.suite = function () {
    var owner = state.who.kind === 'owner';
    return Promise.all([api('GET', '/v1/admin/suite/status'), api('GET', '/v1/admin/tenant')]).then(function (r) {
      var st = r[0], t = r[1];
      var nm = E('input', { value: t.product_name }), ac = E('input', { value: t.accent }), cl = E('input', { value: t.currency_label });
      var dest = E('select', null, E('option', { value: 'ledger' }, 'Pay through the owner-approved payout flow (current policy)'), E('option', { value: 'moneypenny' }, 'Pay as Moneypenny credits'));
      dest.value = t.commission_dest;
      var sw = function (key, label) { var s = E('select', null, E('option', { value: '1' }, 'On'), E('option', { value: '0' }, 'Off')); s.value = String(t[key]); return [field(label, s), s]; };
      var m = sw('mnp_enabled', 'Moneypenny'), o = sw('mono_enabled', 'Monopoly');
      var nodes = [E('h1', null, 'Suite'), E('p', { class: 'mut' }, 'Payout mode: ' + st.payout_mode + ' · Moneypenny ' + (st.engines.moneypenny.configured ? 'connected' : 'not connected') + ' · Monopoly ' + (st.engines.monopoly.configured ? 'connected' : 'not connected'))];
      if (owner) nodes.push(card(E('b', null, 'Brand and wording'), field('Product name', nm), field('Accent colour (#rrggbb)', ac), field('Currency name', cl), field('Where matured commissions are paid', dest), m[0], o[0],
        E('button', { class: 'btn', on: { click: act(function () { return api('PUT', '/v1/admin/tenant', { product_name: nm.value, accent: ac.value, currency_label: cl.value, commission_dest: dest.value, mnp_enabled: Number(m[1].value), mono_enabled: Number(o[1].value) }); }, 'Saved') } }, 'Save'),
        E('button', { class: 'btn alt', on: { click: act(function () { return api('POST', '/v1/admin/suite/sweep'); }, 'Sweep done') } }, 'Send matured commissions now')));
      nodes.push(E('h2', null, 'Commissions sent to Moneypenny'), table(['State', 'Entries', 'Amount'], st.postings.map(function (p) { return [p.state, String(p.n), money(p.amount_minor)]; })));
      nodes.push(E('h2', null, 'Needs the owner'), table(['Entry', 'State', 'Why', 'Amount', ''], st.exceptions.map(function (x) { return [String(x.ledger_seq), x.state, x.last_error || '-', money(x.amount_minor),
        owner ? E('button', { class: 'btn ghost', on: { click: act(function () { return api('POST', '/v1/admin/suite/postings/' + x.ledger_seq + '/requeue'); }, 'Back in the queue') } }, 'Try again') : '']; })));
      return E('div', null, nodes);
    });
  };

  VIEWS.team = function () {
    return api('GET', '/v1/me/team').then(function (r) {
      return E('div', null, E('h1', null, 'My team'), E('p', { class: 'mut' }, 'Everyone who reports up to you.'),
        table(['Name', 'Role', 'Level', 'Status'], r.members.map(function (m) { return [m.name, ROLE_NAME[m.role], String(m.depth), pill(m.status, m.status === 'active' ? '' : 'o')]; })));
    });
  };

  VIEWS.links = function () {
    return Promise.all([api('GET', '/v1/me/links'), api('GET', '/v1/me/codes'), api('GET', '/v1/public/sites'), api('GET', '/v1/me'), api('GET', '/v1/me/prospects')]).then(function (r) {
      var links = r[0].links, codes = r[1].codes, sites = r[2], me = r[3], prospects = r[4].prospects;
      var site = E('select', null, sites.map(function (s) { return E('option', { value: s.id }, s.name); }));
      var path = E('input', { value: '/', placeholder: '/' });
      var origin = location.origin;
      var nodes = [E('h1', null, 'My links' + (me.role === 'refer' ? '' : ' and codes')), E('p', { class: 'mut' }, 'One personal link per product and page. Every click is logged.'),
        card(field('Product', site), field('Page on that site', path), E('button', { class: 'btn', on: { click: act(function () { return api('POST', '/v1/me/links', { site_id: site.value, path: path.value }); }, 'Link ready') } }, 'Create link')),
        E('h2', null, 'My links'),
        table(['Product', 'Link', 'Clicks'], links.map(function (l) { return [l.site_name + ' ' + l.path, E('span', { class: 'code' }, origin + l.url), String(l.clicks)]; }))];
      if (me.role !== 'refer') {
        var cs = E('select', null, sites.filter(function (s) { return s.discount_allowed; }).map(function (s) { return E('option', { value: s.id }, s.name + ' (max ' + (s.max_discount_bps / 100) + '%)'); }));
        var pctIn = E('input', { type: 'number', min: '0.5', step: '0.5', value: '5' }), uses = E('input', { type: 'number', min: '1', value: '3' });
        nodes.push(E('h2', null, 'Create a discount code'), card(E('p', { class: 'mut' }, 'Only products that allow discounts are listed.'), field('Product', cs), field('Discount %', pctIn), field('Number of uses', uses),
          E('button', { class: 'btn alt', on: { click: act(function () { return api('POST', '/v1/me/codes', { site_id: cs.value, discount_bps: Math.round(Number(pctIn.value) * 100), max_uses: Number(uses.value) }); }, 'Code created') } }, 'Create code')),
          E('h2', null, 'My codes'),
          table(['Code', 'Off', 'Used', 'Expires', ''], codes.map(function (c) { return [E('span', { class: 'code' }, c.code), (c.discount_bps / 100) + '%', c.used_count + ' / ' + c.max_uses, day(c.expires_at),
            c.active ? E('button', { class: 'btn ghost', on: { click: act(function () { return api('DELETE', '/v1/me/codes/' + c.code); }, 'Code switched off') } }, 'Switch off') : pill('off', 'o')]; })));
        var ps = E('select', null, sites.map(function (s) { return E('option', { value: s.id }, s.name); })), pe = E('input', { type: 'email', placeholder: 'their e-mail' });
        nodes.push(E('h2', null, 'Register a prospect'), card(E('p', { class: 'mut' }, 'Tell us who you are working with. You are protected for 14 days against other partners links. Their e-mail is stored only as a one-way code; a note you add is stored as you type it, so keep personal details out of it.'),
          field('Product', ps), field('Prospect e-mail', pe),
          E('button', { class: 'btn alt', on: { click: act(function () { return api('POST', '/v1/me/prospects', { site_id: ps.value, customer_email: pe.value }); }, 'Prospect registered') } }, 'Register')),
          table(['Product', 'Registered'], prospects.map(function (x) { return [x.site_id, day(x.registered_at)]; })));
      }
      return E('div', null, nodes);
    });
  };

  VIEWS.earn = function () {
    return Promise.all([api('GET', '/v1/me/balance'), api('GET', '/v1/me/ledger'), api('GET', '/v1/me/payouts'), api('GET', '/v1/me/sales'), api('GET', '/v1/me/summary'), api('GET', '/v1/public/sites')]).then(function (r) {
      var b = r[0], led = r[1].entries, po = r[2].payouts, sales = r[3].sales, sm = r[4], sites = r[5];
      var jb = sm.joining_bonus || { state: 'none' };
      var bonusLine = {
        open: 'Joining bonus: ' + money(jb.amount_minor) + ' comes with the first sale paid by ' + day(jb.expires_at) + '.',
        earned: 'Joining bonus of ' + money(jb.amount_minor) + ' earned with the first sale.',
        voided: 'The joining bonus went back together with the refunded first sale.',
        gone: 'The joining bonus window has closed.',
      }[jb.state];
      var open = po.some(function (p) { return ['pending_approval', 'approved', 'processing'].indexOf(p.status) >= 0; });
      return E('div', null, E('h1', null, 'Earnings and payouts'),
        E('div', { class: 'grid' }, card(E('div', { class: 'big' }, money(b.available_minor)), E('span', { class: 'mut' }, 'ready to be paid')), card(E('div', { class: 'big' }, money(b.pending_minor)), E('span', { class: 'mut' }, 'on hold')),
          card(E('div', { class: 'big' }, money(b.in_payout_minor)), E('span', { class: 'mut' }, 'in a payout')), card(E('div', { class: 'big' }, money(b.paid_minor)), E('span', { class: 'mut' }, 'paid so far'))),
        E('button', { class: 'btn', disabled: open || b.available_minor <= 0, on: { click: act(function () { return api('POST', '/v1/me/payouts'); }, 'Payout requested: waiting for approval') } }, 'Request payout'),
        E('div', { class: 'note' }, 'Commission is paid after the wait shown for each product, once Razorpay has confirmed the payment and no refund or claim is open. Payouts need a verified e-mail and verified payout details.'),
        E('ul', { class: 'mut' }, sites.map(function (s) { return E('li', null, s.name + ': ' + s.payout_wait); })),
        sm.next_pay_day ? E('div', { class: 'note' }, 'Payouts are made on fixed pay days. The next pay day is ' + day(sm.next_pay_day) + '.') : null,
        bonusLine ? E('div', { class: 'note' }, bonusLine) : null,
        E('h2', null, 'Payouts'), table(['Requested', 'Pay day', 'Amount', 'After tax', 'Status', 'Paid to'], po.map(function (p) { return [when(p.created_at), p.pay_on ? day(p.pay_on) : '-', money(p.gross_minor), money(p.net_minor), pill(p.status.replace('_', ' '), p.status === 'paid' ? '' : 'o'), p.destination_masked || '-']; })),
        E('h2', null, 'Sales'), table(['Date', 'Product', 'Amount', 'Result', 'Payable from'], sales.map(function (s) { return [day(s.paid_at), s.site_id, money(s.net_minor), s.status === 'recorded' ? pill(s.rzp_status === 'confirmed' ? 'confirmed' : 'awaiting payment confirmation', s.rzp_status === 'confirmed' ? '' : 'o') : pill(s.status + (s.block_reason ? ': ' + s.block_reason : ''), 'r'), (s.early_release_bps ? day(s.early_eligible_at) + ' (' + (s.early_release_bps / 100) + '%), the rest ' + day(s.eligible_at) : day(s.eligible_at))]; })),
        E('h2', null, 'Ledger'), table(['#', 'When', 'Type', 'Amount', 'Note'], led.map(function (e) { return [String(e.seq), when(e.ts), e.kind, money(e.amount_minor), e.memo || '']; })));
    });
  };

  VIEWS.profile = function () {
    return api('GET', '/v1/me').then(function (me) {
      var k = me.kyc, india = me.country === 'IN';
      var code = E('input', { inputmode: 'numeric', maxlength: '6', placeholder: '6-digit code' });
      var pan = E('input', { placeholder: 'ABCDE1234F', maxlength: '10' }), upi = E('input', { placeholder: 'name@bank' });
      var tax = E('input'), acct = E('input'), ifsc = E('input'), bank = E('input');
      var email = E('input', { type: 'email', placeholder: 'you@example.com' });
      return E('div', null, E('h1', null, 'My details'),
        card(E('div', { class: 'row' }, E('b', null, 'E-mail'), me.email_verified ? pill('verified') : pill('not verified', 'o')), E('p', null, me.email_masked || 'none yet'),
          field('Add or change e-mail', email), E('button', { class: 'btn ghost', on: { click: act(function () { return api('PATCH', '/v1/me', { email: email.value }); }, 'E-mail saved') } }, 'Save e-mail'),
          me.email_masked && !me.email_verified ? E('div', null, E('p', null, E('button', { class: 'btn', on: { click: act(function () { return api('POST', '/v1/me/email/send-code'); }, 'Code sent') } }, 'Send me a code')), field('Code', code),
            E('button', { class: 'btn alt', on: { click: act(function () { return api('POST', '/v1/me/email/verify', { code: code.value }); }, 'E-mail verified') } }, 'Verify')) : null),
        card(E('div', { class: 'row' }, E('b', null, 'Payout details'), pill(k.status, k.status === 'verified' ? '' : 'o')),
          E('p', { class: 'mut' }, india ? 'India: PAN and UPI id. Shown masked; stored encrypted.' : 'Outside India: government tax/ID number and bank details.'),
          k.pan_masked ? E('p', null, 'PAN ' + k.pan_masked + ' · UPI ' + (k.upi_masked || '-')) : null,
          india ? [field('PAN', pan), field('UPI id', upi)] : [field('Tax / ID number', tax), field('Bank account', acct), field('IFSC / SWIFT', ifsc), field('Bank name', bank)],
          E('button', { class: 'btn', disabled: !me.email_verified, on: { click: act(function () {
            return api('PUT', '/v1/me/kyc', india ? { pan: pan.value, upi_id: upi.value } : { tax_id: tax.value, bank_account: acct.value, bank_ifsc_swift: ifsc.value, bank_name: bank.value });
          }, 'Details submitted for checking') } }, 'Submit for checking'),
          me.email_verified ? null : E('p', { class: 'mut' }, 'Verify your e-mail first.')),
        card(E('b', null, 'Your data and privacy'), E('p', { class: 'mut' }, 'See what we hold about you, rotate your key if you think it leaked, or ask for erasure. Read the privacy notice at /privacy.html.'),
          E('p', null,
            E('button', { class: 'btn ghost', on: { click: act(function () { return api('GET', '/v1/me/export').then(function (d) { var a = E('a', { href: URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })), download: 'my-partner-circle-data.json' }); document.body.appendChild(a); a.click(); a.remove(); }); }, 'Your data was downloaded') } }, 'Download my data'), ' ',
            E('button', { class: 'btn ghost', on: { click: act(function () { return api('POST', '/v1/me/keys/rotate').then(function (r) { state.key = r.api_key; try { (localStorage.getItem(KEYSTORE) ? localStorage : sessionStorage).setItem(KEYSTORE, r.api_key); } catch (e) { /* storage unavailable */ } window.prompt('Your NEW key (copy it now, the old one no longer works):', r.api_key); }); }, 'Key rotated') } }, 'Rotate my key'), ' ',
            E('button', { class: 'btn ghost', on: { click: act(function () { return api('POST', '/v1/me/erase-request'); }, 'Erasure requested; the owner will contact you') } }, 'Ask for erasure'))),
        card(E('b', null, 'Invite someone to your team'), E('p', { class: 'mut' }, 'Share this sponsor code; they enter it when registering:'), E('div', { class: 'code' }, me.handle), E('p', { class: 'mut' }, 'or ' + location.origin + '/#/register?sponsor=' + me.handle)));
    });
  };

  VIEWS.logs = function () {
    return api('GET', '/v1/me/logs').then(function (r) {
      return E('div', null, E('h1', null, 'Activity log'), E('p', { class: 'mut' }, 'Clicks, sign-ups, sales, payouts and your own actions.'),
        table(['When', 'Type', 'What', 'Result'], r.logs.map(function (l) { return [when(l.ts), l.type, l.what || '', l.result || '']; })));
    });
  };

  // ---- owner / AI views ------------------------------------------------------------------------------------
  var isOwner = function () { return state.who.kind === 'owner'; };
  var ownerOnly = function (btn) { return isOwner() ? btn : E('span', { class: 'mut' }, 'owner only'); };
  var failToast = function (e) { toast(e.message, true); };
  var btn = function (label, cls, fn) { return E('button', { class: 'btn ' + cls, on: { click: fn } }, label); };
  var post = function (path, body, ok, ask) {
    return btn(ok.label, ok.cls || '', function () { if (ask && !window.confirm(ask)) return; act(function () { return api('POST', path, body); }, ok.done)(); });
  };

  // masked KYC for the owner to recognise; the full values only on a click, which is written to the action log
  function kycCell(k) {
    var d = k.details || {};
    var line = k.country === 'IN' ? ['PAN ' + d.pan, 'UPI ' + d.upi_id] : ['Tax ID ' + d.tax_id, (d.bank_name || '') + ' ' + (d.bank_account || ''), 'IFSC/SWIFT ' + d.bank_ifsc_swift];
    var full = E('div', { class: 'code' });
    full.hidden = true;
    var show = isOwner() ? E('button', { class: 'btn ghost', on: { click: function () {
      api('GET', '/v1/admin/users/' + k.user_id + '/kyc').then(function (x) {
        full.hidden = false;
        full.textContent = k.country === 'IN' ? 'PAN ' + x.pan + ' · UPI ' + x.upi_id : 'Tax ID ' + x.tax_id + ' · ' + x.bank_name + ' ' + x.bank_account + ' · ' + x.bank_ifsc_swift;
      }, failToast);
    } } }, 'Show full details (logged)') : null;
    return E('div', null, E('div', null, line.join(' · ')), full, show);
  }

  VIEWS.queue = function () {
    return Promise.all([api('GET', '/v1/admin/queue'), api('GET', '/v1/admin/summary')]).then(function (r) {
      var q = r[0], s = r[1];
      var tile = function (big, label) { return card(E('div', { class: 'big' }, big), E('span', { class: 'mut' }, label)); };
      return E('div', null, E('h1', null, 'Approvals'),
        s.payout_mode === 'mock' ? E('div', { class: 'note' }, 'Payouts are in MOCK mode: no real money moves. Live payouts need the Razorpay payout keys and PAYOUT_MODE=live.') : E('div', { class: 'note' }, 'Payout mode: ' + s.payout_mode + '. Approving a payout sends it to Razorpay.'),
        q.tds_confirmed ? null : E('div', { class: 'note' }, 'TDS rate is not confirmed by a CA yet. Payouts carry the TDS % set under Policy and sites (now a placeholder).'),
        E('div', { class: 'grid' }, tile(String(q.partners.length), 'people to approve'), tile(String(q.payouts.length), 'payouts waiting'),
          tile(money(s.owed_minor), 'owed to partners (ledger)'), tile(String(s.open_claims), 'claims on hold')),
        s.flagged_refunds || s.refunds_without_usage_proof ? E('div', { class: 'note' }, s.flagged_refunds + ' refund(s) came after the payout was sent (not clawed back). ' + s.refunds_without_usage_proof + ' refund(s) have no usage proof from the site.') : null,
        E('h2', null, 'People'), table(['Name', 'Role', 'Country', 'Added', ''], q.partners.map(function (u) { return [u.name, ROLE_NAME[u.role], u.country, day(u.created_at),
          ownerOnly(post('/v1/admin/users/' + u.id + '/approve', undefined, { label: 'Approve', done: 'Approved' }))]; })),
        E('h2', null, 'Erasure requests (' + (q.erase_requests || []).length + ')'), (q.erase_requests || []).length ? table(['Name', 'Handle', 'Asked on'], q.erase_requests.map(function (e) { return [e.name, e.handle, day(e.requested_at)]; })) : E('p', { class: 'mut' }, 'None waiting.'),
        E('h2', null, 'Payout details to check'), table(['Name', 'Details', 'Submitted', ''], q.kyc.map(function (k) { return [k.name, kycCell(k), day(k.submitted_at),
          ownerOnly(E('span', null, post('/v1/admin/users/' + k.user_id + '/kyc/review', { approve: true }, { label: 'Verify', done: 'Verified' }), ' ',
            post('/v1/admin/users/' + k.user_id + '/kyc/review', { approve: false, note: 'rejected in console' }, { label: 'Reject', cls: 'ghost', done: 'Rejected' })))]; })),
        E('h2', null, 'Payouts waiting'), table(['Partner', 'Pay to', 'Gross', 'TDS', 'To pay', 'Pay day', 'Flags', ''], q.payouts.map(function (p) { return [p.name, (p.method === 'upi' ? 'UPI ' : 'Bank ') + (p.destination_masked || '-'), money(p.gross_minor), money(p.tds_minor), money(p.net_minor), p.pay_on ? day(p.pay_on) : '-',
          p.flagged_refunds ? pill(p.flagged_refunds + ' refunded after sale', 'r') : '',
          ownerOnly(E('span', null, post('/v1/admin/payouts/' + p.id + '/approve', undefined, { label: 'Approve', done: 'Approved and sent to the payout provider' }), ' ',
            p.pay_on && p.pay_on > Date.now() ? post('/v1/admin/payouts/' + p.id + '/approve', { early: true }, { label: 'Approve early', cls: 'ghost', done: 'Approved early and sent' }, 'This is before the pay day (' + day(p.pay_on) + '). Send it now?') : null, ' ',
            post('/v1/admin/payouts/' + p.id + '/reject', { note: 'rejected in console' }, { label: 'Reject', cls: 'ghost', done: 'Rejected' })))]; })),
        E('h2', null, 'Claims on hold'), table(['Partner', 'Product', 'Order', 'Amount', 'Since', ''], q.claims.map(function (c) { return [c.name || '-', c.site_id, c.order_id, money(c.net_minor), day(c.disputed_at),
          ownerOnly(E('span', null, post('/v1/admin/sales/' + c.id + '/claim', { action: 'won', note: 'cleared in console' }, { label: 'Claim cleared', done: 'Released' }), ' ',
            post('/v1/admin/sales/' + c.id + '/claim', { action: 'lost', note: 'lost, refunded in console' }, { label: 'Refund it', cls: 'ghost', done: 'Refunded' }, 'Refund this sale and void its commission?')))]; })));
    });
  };

  // every payout in every state, with the action that state allows (so nothing can get stuck without a button)
  function payoutActions(p, mode) {
    if (!isOwner()) return E('span', { class: 'mut' }, 'owner only');
    var base = '/v1/admin/payouts/' + p.id;
    if (p.status === 'pending_approval') return E('span', null, post(base + '/approve', undefined, { label: 'Approve', done: 'Approved and sent' }), ' ', post(base + '/reject', { note: 'rejected in console' }, { label: 'Reject', cls: 'ghost', done: 'Rejected' }));
    if (p.status === 'approved') return E('span', null, post(base + '/execute', undefined, { label: 'Send again', done: 'Sent to the provider' }), ' ', post(base + '/reject', { note: 'rejected in console' }, { label: 'Reject', cls: 'ghost', done: 'Rejected' }));
    if (p.status === 'processing' && p.provider === 'manual') {
      var ref = E('input', { placeholder: 'bank reference / UTR' });
      var where = E('div', { class: 'code' });
      where.hidden = true;
      return E('div', null, btn('Where to pay (logged)', 'ghost', function () {
        api('GET', base + '/destination').then(function (x) { where.hidden = false; var d = x.destination; where.textContent = 'Pay ' + money(x.net_minor) + ' to ' + d.name + ' · ' + d.bank_name + ' · A/c ' + d.bank_account + ' · ' + d.bank_ifsc_swift; }, failToast);
      }), where, ref,
      btn('Mark paid', '', function () { act(function () { return api('POST', base + '/mark-paid', { reference: ref.value }); }, 'Recorded as paid')(); }), ' ',
      post(base + '/mark-failed', { reason: 'transfer failed' }, { label: 'Transfer failed', cls: 'ghost', done: 'Released back to the partner' }, 'The transfer did not happen? The money goes back to the partner balance.'));
    }
    if (p.status === 'processing') {
      return E('span', null, mode === 'mock' ? post(base + '/mock-settle', undefined, { label: 'Mock settle', cls: 'alt', done: 'Mock-settled' }) : pill('waiting for the provider', 'o'), ' ',
        post(base + '/mark-failed', { reason: 'marked failed in console' }, { label: 'Mark failed', cls: 'ghost', done: 'Released back to the partner' }, 'Mark this payout failed and return the money to the partner balance?'));
    }
    return p.reversed_at ? pill('reversed by provider', 'r') : '';
  }
  VIEWS.payouts = function () {
    return Promise.all([api('GET', '/v1/admin/payouts'), api('GET', '/v1/admin/summary')]).then(function (r) {
      var mode = r[1].payout_mode;
      return E('div', null, E('h1', null, 'Payouts'), E('p', { class: 'mut' }, 'Payout mode: ' + mode + '. Every payout, newest first.'),
        table(['When', 'Partner', 'Pay to', 'To pay', 'Status', 'Ref', 'Action'], r[0].payouts.map(function (p) { return [when(p.created_at), p.name || p.user_id, (p.method === 'upi' ? 'UPI ' : 'Bank ') + (p.destination_masked || '-'), money(p.net_minor),
          pill(p.status.replace('_', ' ') + (p.reversed_at ? ' (reversed)' : ''), p.status === 'paid' ? '' : p.status === 'failed' || p.status === 'rejected' ? 'r' : 'o'), p.paid_ref || p.provider_ref || '', payoutActions(p, mode)]; })));
    });
  };

  VIEWS.users = function () {
    return api('GET', '/v1/admin/users').then(function (r) {
      var role = E('select', null, ['manager', 'leader', 'exec', 'partner'].map(function (x) { return E('option', { value: x }, ROLE_NAME[x]); }));
      var name = E('input'), email = E('input', { type: 'email' }), phone = E('input'), parent = E('input', { placeholder: 'reports to (user id, optional)' });
      var shown = E('div');
      var pid = E('input', { placeholder: 'person id (click Move on a row)' });
      var prole = E('select', null, E('option', { value: '' }, 'keep role'), ['manager', 'leader', 'exec', 'partner', 'refer'].map(function (x) { return E('option', { value: x }, ROLE_NAME[x]); }));
      var pparent = E('input', { placeholder: 'new boss id (blank = keep, "none" = nobody)' });
      return E('div', null, E('h1', null, 'People'),
        card(E('b', null, 'Add staff'), E('p', { class: 'mut' }, isOwner() ? 'Created active, with a login key shown once.' : 'Created as pending: the owner approves.'),
          field('Role', role), field('Name', name), field('E-mail', email), field('Mobile', phone), field('Reports to', parent),
          E('button', { class: 'btn', on: { click: function () {
            api('POST', '/v1/admin/users', { role: role.value, name: name.value, email: email.value, phone: phone.value, parent_id: parent.value || undefined }).then(function (x) {
              shown.textContent = ''; if (x.api_key) shown.appendChild(card(E('b', null, 'Login key (shown once)'), E('div', { class: 'code' }, x.api_key)));
              toast('Added'); }, failToast);
          } } }, 'Add'), shown),
        isOwner() ? card(E('b', null, 'Promote or move someone'), E('p', { class: 'mut' }, 'Applies to future sales only; money already earned stays as posted.'), field('Person', pid), field('New role', prole), field('Reports to', pparent),
          btn('Save', 'alt', function () {
            var body = {}; if (prole.value) body.role = prole.value; if (pparent.value) body.parent_id = pparent.value === 'none' ? null : pparent.value;
            act(function () { return api('POST', '/v1/admin/users/' + pid.value.trim() + '/placement', body); }, 'Saved')();
          })) : null,
        table(['Name', 'Role', 'Status', 'KYC', 'E-mail', 'ID', ''], r.users.map(function (u) { return [u.name, ROLE_NAME[u.role], pill(u.status, u.status === 'active' ? '' : 'o'), u.kyc_status, u.email_masked ? pill(u.email_verified ? 'verified' : 'not verified', u.email_verified ? '' : 'o') : '-', E('span', { class: 'code' }, u.id),
          E('span', null,
            u.status === 'active' ? post('/v1/admin/users/' + u.id + '/suspend', { why: 'console' }, { label: 'Suspend', cls: 'ghost', done: 'Suspended' }) : u.status === 'suspended' && isOwner() ? post('/v1/admin/users/' + u.id + '/reinstate', undefined, { label: 'Reinstate', cls: 'ghost', done: 'Reinstated' }) : null, ' ',
            isOwner() && u.email_masked && !u.email_verified ? post('/v1/admin/users/' + u.id + '/verify-email', undefined, { label: 'I verify the e-mail', cls: 'ghost', done: 'E-mail marked verified' }, 'Mark this e-mail as verified by you?') : null, ' ',
            isOwner() ? btn('Move', 'ghost', function () { pid.value = u.id; window.scrollTo(0, 0); }) : null, ' ',
            isOwner() ? post('/v1/admin/users/' + u.id + '/erase', undefined, { label: 'Erase', cls: 'ghost', done: 'Personal details erased' }, 'Erase this person\'s personal details? The money trail stays; this cannot be undone.') : null)]; })));
    });
  };

  VIEWS.policy = function () {
    return Promise.all([api('GET', '/v1/admin/policy'), api('GET', '/v1/admin/sites')]).then(function (r) {
      var p = r[0], sites = r[1].sites;
      var bonus = E('input', { type: 'number', value: (p.joining_bonus_minor || 0) / 100 }), bonusDays = E('input', { type: 'number', value: p.joining_bonus_valid_days || 30 }), payDays = E('input', { value: (p.pay_days || []).join(', ') });
      var min = E('input', { type: 'number', value: p.min_payout_minor / 100 }), win = E('input', { type: 'number', value: p.attribution_window_days }), tds = E('input', { type: 'number', step: '0.1', value: p.tds_bps_default / 100 });
      var tdsOk = E('input', { type: 'checkbox', class: 'auto' }); tdsOk.checked = !!p.tds_confirmed;
      var ov = {}; ['exec', 'leader', 'manager'].forEach(function (k) { ov[k] = E('input', { type: 'number', step: '0.05', value: p.override_bps[k] / 100 }); });

      var sel = E('select', null, sites.map(function (s) { return E('option', { value: s.id }, s.name + (s.active ? '' : ' (off)')); }));
      var f = {
        host: E('input'), commission: E('input', { type: 'number', step: '0.1' }), refer: E('input', { type: 'number', step: '0.1' }), ret: E('input', { type: 'number' }), buf: E('input', { type: 'number' }),
        early: E('input', { type: 'number', step: '0.1' }), disc: E('input', { type: 'number', step: '0.1' }), refund: E('textarea', { rows: '3' }),
        discOn: E('input', { type: 'checkbox', class: 'auto' }), confirmed: E('input', { type: 'checkbox', class: 'auto' }), active: E('input', { type: 'checkbox', class: 'auto' }),
      };
      var cur = function () { return sites.filter(function (s) { return s.id === sel.value; })[0]; };
      var fill = function () {
        var s = cur();
        f.host.value = s.host; f.commission.value = s.commission_bps / 100; f.refer.value = s.refer_bps / 100; f.ret.value = s.return_days; f.buf.value = s.buffer_days; f.early.value = (s.early_release_bps || 0) / 100;
        f.disc.value = s.max_discount_bps / 100; f.refund.value = s.refund_terms || ''; f.discOn.checked = !!s.discount_allowed; f.confirmed.checked = !!s.host_confirmed; f.active.checked = !!s.active;
      };
      sel.addEventListener('change', fill); fill();
      return E('div', null, E('h1', null, 'Policy and sites'),
        card(E('b', null, 'Global rules'), isOwner() ? null : E('p', { class: 'mut' }, 'Read only: policy changes are owner-only.'),
          field('Minimum payout (₹)', min), field('Pay days of the month (the last day is written as 31)', payDays), field('Joining bonus (₹, 0 = none)', bonus), field('Joining bonus valid for (days after approval)', bonusDays), field('Attribution window (days)', win), field('TDS % at payout (placeholder until a CA confirms)', tds),
          E('label', null, tdsOk, ' A CA has confirmed this TDS rate'),
          field('Override % to executive / team leader / manager on team sales', E('div', { class: 'grid' }, ov.exec, ov.leader, ov.manager)),
          E('p', { class: 'mut' }, 'Partner links may only send visitors to: ' + p.owned_domains.join(', ')),
          isOwner() ? E('button', { class: 'btn', on: { click: act(function () {
            return api('PUT', '/v1/admin/policy', { min_payout_minor: Math.round(min.value * 100), pay_days: payDays.value.split(',').map(function (x) { return Number(x.trim()); }).filter(function (x) { return x > 0; }), joining_bonus_minor: Math.round(bonus.value * 100), joining_bonus_valid_days: Number(bonusDays.value), attribution_window_days: Number(win.value), tds_bps_default: Math.round(tds.value * 100), tds_confirmed: tdsOk.checked,
              override_bps: { exec: Math.round(ov.exec.value * 100), leader: Math.round(ov.leader.value * 100), manager: Math.round(ov.manager.value * 100) } });
          }, 'Policy saved') } }, 'Save') : null),
        E('h2', null, 'Sites'),
        table(['Site', 'Refund window', 'Paid early', 'Commission', 'Refer', 'Max discount', 'Status'], sites.map(function (s) { return [s.name + ' (' + s.host + ')', s.return_days + ' + ' + s.buffer_days + ' days', s.early_release_bps ? (s.early_release_bps / 100) + '% after ' + s.buffer_days + ' days' : 'no split', (s.commission_bps / 100) + '%', (s.refer_bps / 100) + '%', s.discount_allowed ? (s.max_discount_bps / 100) + '%' : 'none',
          s.active ? pill('live') : pill(s.host_confirmed ? 'off' : 'host not confirmed', 'o')]; })),
        isOwner() ? card(E('b', null, 'Edit a site'), E('p', { class: 'mut' }, 'Changes apply to future sales only. A site goes live only after you confirm its host.'), field('Site', sel), field('Host (must be on an owned domain)', f.host),
          E('div', { class: 'grid' }, field('Commission %', f.commission), field('Refer and Earn %', f.refer), field('Refund window (days)', f.ret), field('Buffer (days)', f.buf), field('Paid early after the buffer, % of each commission (0 = no split)', f.early)),
          E('label', null, f.discOn, ' Discount codes allowed'), field('Max discount %', f.disc), field('Refund terms shown to buyers before they pay (blank = draft default)', f.refund),
          E('label', null, f.confirmed, ' I confirm this host is right'), E('label', null, f.active, ' Site is live'),
          E('p', null, E('button', { class: 'btn', on: { click: act(function () {
            return api('PATCH', '/v1/admin/sites/' + sel.value, { host: f.host.value.trim(), commission_bps: Math.round(f.commission.value * 100), refer_bps: Math.round(f.refer.value * 100), return_days: Number(f.ret.value), buffer_days: Number(f.buf.value), early_release_bps: Math.round(f.early.value * 100),
              discount_allowed: f.discOn.checked ? 1 : 0, max_discount_bps: Math.round(f.disc.value * 100), refund_terms: f.refund.value.trim() || null, host_confirmed: f.confirmed.checked ? 1 : 0, active: f.active.checked ? 1 : 0 });
          }, 'Site saved') } }, 'Save site'))) : E('p', { class: 'mut' }, 'Site rates are edited by the owner.'));
    });
  };

  VIEWS.schemes = function () {
    return api('GET', '/v1/admin/schemes').then(function (r) {
      var name = E('input'), period = E('select', null, ['weekly', 'monthly', 'quarterly', 'custom'].map(function (x) { return E('option', { value: x }, x); }));
      var metric = E('select', null, E('option', { value: 'sales_count' }, 'number of sales'), E('option', { value: 'net_minor' }, 'sales value (Rs)'));
      var target = E('input', { type: 'number', value: '5' }), bonus = E('input', { type: 'number', value: '500' }), days = E('input', { type: 'number', value: '7' });
      return E('div', null, E('h1', null, 'Schemes'),
        card(E('b', null, 'New scheme (draft)'), field('Name', name), field('Period', period), field('Counts', metric), field('Target', target), field('Bonus (Rs)', bonus), field('Runs for (days from now)', days),
          E('button', { class: 'btn', on: { click: act(function () {
            var now = Date.now(); var t = Number(target.value);
            return api('POST', '/v1/admin/schemes', { name: name.value, period: period.value, metric: metric.value, target: metric.value === 'net_minor' ? Math.round(t * 100) : t, bonus_minor: Math.round(bonus.value * 100), starts_at: now, ends_at: now + Number(days.value) * 86400000 });
          }, 'Draft saved') } }, 'Save draft')),
        table(['Name', 'Window', 'Target', 'Bonus', 'Status', ''], r.schemes.map(function (s) { return [s.name, day(s.starts_at) + ' to ' + day(s.ends_at), s.metric === 'net_minor' ? money(s.target) : String(s.target), money(s.bonus_minor), pill(s.status, s.status === 'active' ? '' : 'o'),
          !isOwner() ? '' : s.status === 'draft' ? E('button', { class: 'btn', on: { click: act(function () { return api('POST', '/v1/admin/schemes/' + s.id + '/activate'); }, 'Scheme is live') } }, 'Activate')
            : s.status === 'active' ? E('button', { class: 'btn alt', on: { click: act(function () { return api('POST', '/v1/admin/schemes/' + s.id + '/settle'); }, 'Settled') } }, 'Settle') : '']; })));
    });
  };

  VIEWS.keys = function () {
    if (!isOwner()) return card(E('b', null, 'API keys are owner-only.'));
    return api('GET', '/v1/admin/keys').then(function (r) {
      var kind = E('select', null, ['ai', 'site', 'owner'].map(function (x) { return E('option', { value: x }, x); })), label = E('input'), siteId = E('input', { placeholder: 'site id (for site keys), e.g. mom' });
      var shown = E('div');
      return E('div', null, E('h1', null, 'API keys'),
        card(E('b', null, 'New key'), E('p', { class: 'mut' }, 'AI keys can read and propose but can never approve payouts, verify KYC, change policy or mint keys.'), field('Kind', kind), field('Label', label), field('Site', siteId),
          E('button', { class: 'btn', on: { click: function () {
            api('POST', '/v1/admin/keys', { kind: kind.value, label: label.value || undefined, site_id: kind.value === 'site' ? siteId.value : undefined }).then(function (k) {
              shown.textContent = ''; shown.appendChild(card(E('b', null, 'Copy this key now'), E('div', { class: 'code' }, k.token))); toast('Key created'); }, function (e) { toast(e.message, true); });
          } } }, 'Create key'), shown),
        table(['ID', 'Kind', 'Label', 'Last used', ''], r.keys.map(function (k) { return [E('span', { class: 'code' }, k.id), k.kind, k.label || '', k.last_used_at ? when(k.last_used_at) : 'never',
          k.revoked_at ? pill('revoked', 'r') : E('button', { class: 'btn ghost', on: { click: act(function () { return api('DELETE', '/v1/admin/keys/' + k.id); }, 'Revoked') } }, 'Revoke')]; })));
    });
  };

  function auditTable(entries) {
    return table(['#', 'When', 'Who', 'Action', 'Target', 'Detail'], entries.map(function (e) { return [String(e.seq), when(e.ts), e.actor_type + (e.key_id ? ' ·' + e.key_id.slice(0, 6) : ''), e.action, e.target || '', e.meta ? JSON.stringify(e.meta).slice(0, 120) : '']; }));
  }
  VIEWS.audit = function () {
    return Promise.all([api('GET', '/v1/admin/audit?limit=100'), api('GET', '/v1/admin/verify')]).then(function (r) {
      var v = r[1];
      var line = function (c) { return c.ok ? pill('intact (' + c.rows + ' rows' + (c.checked != null ? ', checked ' + c.checked + ' new' + (c.complete ? '' : ', more to check') : '') + ')') : pill('BROKEN at ' + c.broken_at + (c.reason ? ': ' + c.reason : ''), 'r'); };
      return E('div', null, E('h1', null, 'Action log'),
        card(E('b', null, 'Tamper check'), E('p', null, 'Ledger: ', line(v.ledger), ' Action log: ', line(v.audit)),
          E('p', { class: 'mut' }, 'Both are append-only hash chains: any edit or deletion breaks every later hash. This check continues from where the last one stopped; "Check everything" re-hashes from the start.'),
          E('button', { class: 'btn ghost', on: { click: function () {
            api('GET', '/v1/admin/verify?full=1').then(function (x) { toast(x.ledger.ok && x.audit.ok ? 'Everything checks out' : 'A chain is BROKEN', !(x.ledger.ok && x.audit.ok)); route(); }, failToast);
          } } }, 'Check everything')),
        auditTable(r[0].entries));
    });
  };
  VIEWS.ai = function () {
    return api('GET', '/v1/admin/audit?actor_type=ai&limit=100').then(function (r) {
      return E('div', null, E('h1', null, 'AI actions'), E('p', { class: 'mut' }, 'Everything the AI master key did, newest first. The AI proposes; only the owner approves.'), auditTable(r.entries));
    });
  };

  // ---- boot ------------------------------------------------------------------------------------------------
  try { state.key = sessionStorage.getItem(KEYSTORE) || localStorage.getItem(KEYSTORE); } catch (e) { /* storage blocked */ }
  window.addEventListener('hashchange', route);
  route();
})();
