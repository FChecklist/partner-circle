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
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach(function (x) { add(el, x); });
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  var money = function (m) { return 'Rs ' + (Number(m || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
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
  function api(method, path, body) {
    var h = { 'content-type': 'application/json' };
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
  var ADMIN_TABS = { queue: 'Approvals', users: 'People', policy: 'Policy and sites', schemes: 'Schemes', keys: 'API keys', audit: 'Action log', ai: 'AI actions' };
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
    var remember = E('input', { type: 'checkbox', style: 'width:auto' });
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
    return Promise.all([api('GET', '/v1/me/summary'), api('GET', '/v1/me/schemes'), api('GET', '/v1/me')]).then(function (r) {
      var s = r[0], sch = r[1].schemes, me = r[2], b = s.balance, l = s.last_30_days;
      var tile = function (big, label) { return card(E('div', { class: 'big' }, big), E('span', { class: 'mut' }, label)); };
      var nodes = [E('h1', null, 'Hello ' + (me.name || '')), E('p', { class: 'mut' }, ROLE_NAME[me.role] + (me.sponsor ? ' · sponsor: ' + me.sponsor.name : ''))];
      if (me.status !== 'active') nodes.push(E('div', { class: 'note' }, 'Your account is waiting for approval. You can finish your details now.'));
      if (!me.email_verified && me.role !== 'refer') nodes.push(E('div', { class: 'note' }, 'Verify your e-mail under My details; it is needed before your first payout.'));
      nodes.push(E('div', { class: 'grid' }, tile(l.clicks, 'clicks, last 30 days'), tile(l.leads, 'sign-ups'), tile(l.sales, 'sales'), tile(money(l.net_minor), 'sales value')));
      if (s.team_size) nodes.push(card(E('b', null, 'Your team'), E('p', null, s.team_size + ' people · team sales ' + money(l.team_net_minor) + ' in 30 days')));
      nodes.push(E('h2', null, 'Money'), E('div', { class: 'grid' }, tile(money(b.available_minor), 'ready to be paid'), tile(money(b.pending_minor), 'on hold (refund window)')));
      if (b.awaiting_razorpay_minor) nodes.push(E('div', { class: 'note' }, money(b.awaiting_razorpay_minor) + ' is waiting for the payment to be confirmed by Razorpay.'));
      if (sch.length) {
        nodes.push(E('h2', null, 'Schemes'));
        sch.forEach(function (x) { nodes.push(card(E('div', { class: 'row' }, E('b', null, x.name), E('span', null, x.percent + '%')), bar(x.percent), E('span', { class: 'mut' }, 'Bonus ' + money(x.bonus_minor) + ' · ends ' + day(x.ends_at)))); });
      }
      return E('div', null, nodes);
    });
  };
  function bar(p) { return E('div', { class: 'bar' }, E('i', { class: p >= 80 ? 'g' : p >= 40 ? 'a' : 'r', style: 'width:' + p + '%' })); }

  VIEWS.team = function () {
    return api('GET', '/v1/me/team').then(function (r) {
      return E('div', null, E('h1', null, 'My team'), E('p', { class: 'mut' }, 'Everyone who reports up to you.'),
        table(['Name', 'Role', 'Level', 'Status'], r.members.map(function (m) { return [m.name, ROLE_NAME[m.role], String(m.depth), pill(m.status, m.status === 'active' ? '' : 'o')]; })));
    });
  };

  VIEWS.links = function () {
    return Promise.all([api('GET', '/v1/me/links'), api('GET', '/v1/me/codes'), api('GET', '/v1/public/sites'), api('GET', '/v1/me')]).then(function (r) {
      var links = r[0].links, codes = r[1].codes, sites = r[2], me = r[3];
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
      }
      return E('div', null, nodes);
    });
  };

  VIEWS.earn = function () {
    return Promise.all([api('GET', '/v1/me/balance'), api('GET', '/v1/me/ledger'), api('GET', '/v1/me/payouts'), api('GET', '/v1/me/sales')]).then(function (r) {
      var b = r[0], led = r[1].entries, po = r[2].payouts, sales = r[3].sales;
      var open = po.some(function (p) { return ['pending_approval', 'approved', 'processing'].indexOf(p.status) >= 0; });
      return E('div', null, E('h1', null, 'Earnings and payouts'),
        E('div', { class: 'grid' }, card(E('div', { class: 'big' }, money(b.available_minor)), E('span', { class: 'mut' }, 'ready to be paid')), card(E('div', { class: 'big' }, money(b.pending_minor)), E('span', { class: 'mut' }, 'on hold')),
          card(E('div', { class: 'big' }, money(b.in_payout_minor)), E('span', { class: 'mut' }, 'in a payout')), card(E('div', { class: 'big' }, money(b.paid_minor)), E('span', { class: 'mut' }, 'paid so far'))),
        E('button', { class: 'btn', disabled: open || b.available_minor <= 0, on: { click: act(function () { return api('POST', '/v1/me/payouts'); }, 'Payout requested: waiting for approval') } }, 'Request payout'),
        E('div', { class: 'note' }, 'Commission is held until the product refund window plus 7 days has passed and Razorpay has confirmed the payment: about 37 days for Veridian products and PROJEXA, 7 days for games and Townhall. Payouts need your verified e-mail and payout details.'),
        E('h2', null, 'Payouts'), table(['Requested', 'Amount', 'After tax', 'Status', 'Paid to'], po.map(function (p) { return [when(p.created_at), money(p.gross_minor), money(p.net_minor), pill(p.status.replace('_', ' '), p.status === 'paid' ? '' : 'o'), p.destination_masked || '-']; })),
        E('h2', null, 'Sales'), table(['Date', 'Product', 'Amount', 'Result', 'Payable from'], sales.map(function (s) { return [day(s.paid_at), s.site_id, money(s.net_minor), s.status === 'recorded' ? pill(s.rzp_status === 'confirmed' ? 'confirmed' : 'awaiting payment confirmation', s.rzp_status === 'confirmed' ? '' : 'o') : pill(s.status + (s.block_reason ? ': ' + s.block_reason : ''), 'r'), day(s.eligible_at)]; })),
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

  VIEWS.queue = function () {
    return Promise.all([api('GET', '/v1/admin/queue'), api('GET', '/v1/admin/summary')]).then(function (r) {
      var q = r[0], s = r[1];
      var ownerOnly = function (btn) { return isOwner() ? btn : E('span', { class: 'mut' }, 'owner only'); };
      return E('div', null, E('h1', null, 'Approvals'),
        E('div', { class: 'grid' }, card(E('div', { class: 'big' }, String(q.partners.length)), E('span', { class: 'mut' }, 'people to approve')), card(E('div', { class: 'big' }, String(q.payouts.length)), E('span', { class: 'mut' }, 'payouts waiting')),
          card(E('div', { class: 'big' }, money(s.owed_minor)), E('span', { class: 'mut' }, 'owed to partners (ledger)')), card(E('div', { class: 'big' }, String(s.flagged_refunds)), E('span', { class: 'mut' }, 'refunds after payout (flagged)'))),
        E('h2', null, 'People'), table(['Name', 'Role', 'Country', 'Added', ''], q.partners.map(function (u) { return [u.name, ROLE_NAME[u.role], u.country, day(u.created_at),
          ownerOnly(E('button', { class: 'btn', on: { click: act(function () { return api('POST', '/v1/admin/users/' + u.id + '/approve'); }, 'Approved') } }, 'Approve'))]; })),
        E('h2', null, 'Payout details to check'), table(['Name', 'Country', 'Submitted', ''], q.kyc.map(function (k) { return [k.name, k.country, day(k.submitted_at),
          ownerOnly(E('span', null, E('button', { class: 'btn', on: { click: act(function () { return api('POST', '/v1/admin/users/' + k.user_id + '/kyc/review', { approve: true }); }, 'Verified') } }, 'Verify'), ' ',
            E('button', { class: 'btn ghost', on: { click: act(function () { return api('POST', '/v1/admin/users/' + k.user_id + '/kyc/review', { approve: false, note: 'rejected in console' }); }, 'Rejected') } }, 'Reject')))]; })),
        E('h2', null, 'Payouts'), table(['Partner', 'Gross', 'TDS', 'To pay', 'Flags', ''], q.payouts.map(function (p) { return [p.name, money(p.gross_minor), money(p.tds_minor), money(p.net_minor), p.flagged_refunds ? pill(p.flagged_refunds + ' refunded after sale', 'r') : '',
          ownerOnly(E('span', null, E('button', { class: 'btn', on: { click: act(function () { return api('POST', '/v1/admin/payouts/' + p.id + '/approve'); }, 'Approved and sent to the payout provider') } }, 'Approve'), ' ',
            E('button', { class: 'btn ghost', on: { click: act(function () { return api('POST', '/v1/admin/payouts/' + p.id + '/reject', { note: 'rejected in console' }); }, 'Rejected') } }, 'Reject')))]; })));
    });
  };

  VIEWS.users = function () {
    return api('GET', '/v1/admin/users').then(function (r) {
      var role = E('select', null, ['manager', 'leader', 'exec', 'partner'].map(function (x) { return E('option', { value: x }, ROLE_NAME[x]); }));
      var name = E('input'), email = E('input', { type: 'email' }), phone = E('input'), parent = E('input', { placeholder: 'reports to (user id, optional)' });
      var shown = E('div');
      return E('div', null, E('h1', null, 'People'),
        card(E('b', null, 'Add staff'), E('p', { class: 'mut' }, isOwner() ? 'Created active, with a login key shown once.' : 'Created as pending: the owner approves.'),
          field('Role', role), field('Name', name), field('E-mail', email), field('Mobile', phone), field('Reports to', parent),
          E('button', { class: 'btn', on: { click: function () {
            api('POST', '/v1/admin/users', { role: role.value, name: name.value, email: email.value, phone: phone.value, parent_id: parent.value || undefined }).then(function (x) {
              shown.textContent = ''; if (x.api_key) shown.appendChild(card(E('b', null, 'Login key (shown once)'), E('div', { class: 'code' }, x.api_key)));
              toast('Added'); }, function (e) { toast(e.message, true); });
          } } }, 'Add'), shown),
        table(['Name', 'Role', 'Status', 'KYC', 'ID', ''], r.users.map(function (u) { return [u.name, ROLE_NAME[u.role], pill(u.status, u.status === 'active' ? '' : 'o'), u.kyc_status, E('span', { class: 'code' }, u.id),
          u.status === 'active' ? E('button', { class: 'btn ghost', on: { click: act(function () { return api('POST', '/v1/admin/users/' + u.id + '/suspend', { why: 'console' }); }, 'Suspended') } }, 'Suspend') : null]; })));
    });
  };

  VIEWS.policy = function () {
    return Promise.all([api('GET', '/v1/admin/policy'), api('GET', '/v1/admin/sites')]).then(function (r) {
      var p = r[0], sites = r[1].sites;
      var min = E('input', { type: 'number', value: p.min_payout_minor / 100 }), win = E('input', { type: 'number', value: p.attribution_window_days }), tds = E('input', { type: 'number', step: '0.1', value: p.tds_bps_default / 100 });
      var ov = {}; ['exec', 'leader', 'manager'].forEach(function (k) { ov[k] = E('input', { type: 'number', step: '0.05', value: p.override_bps[k] / 100 }); });
      return E('div', null, E('h1', null, 'Policy and sites'),
        card(E('b', null, 'Global rules'), isOwner() ? null : E('p', { class: 'mut' }, 'Read only: policy changes are owner-only.'),
          field('Minimum payout (Rs)', min), field('Attribution window (days)', win), field('TDS % at payout (placeholder until a CA confirms)', tds),
          field('Override % to executive / team leader / manager on team sales', E('div', { class: 'grid' }, ov.exec, ov.leader, ov.manager)),
          isOwner() ? E('button', { class: 'btn', on: { click: act(function () {
            return api('PUT', '/v1/admin/policy', { min_payout_minor: Math.round(min.value * 100), attribution_window_days: Number(win.value), tds_bps_default: Math.round(tds.value * 100),
              override_bps: { exec: Math.round(ov.exec.value * 100), leader: Math.round(ov.leader.value * 100), manager: Math.round(ov.manager.value * 100) } });
          }, 'Policy saved') } }, 'Save') : null),
        E('h2', null, 'Sites'),
        table(['Site', 'Refund window', 'Commission', 'Refer', 'Max discount'], sites.map(function (s) { return [s.name + ' (' + s.host + ')', s.return_days + ' + ' + s.buffer_days + ' days', (s.commission_bps / 100) + '%', (s.refer_bps / 100) + '%', s.discount_allowed ? (s.max_discount_bps / 100) + '%' : 'none']; })),
        E('p', { class: 'mut' }, 'Site rates are changed through the API (PATCH /v1/admin/sites/:id); changes apply to future sales only.'));
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
      return E('div', null, E('h1', null, 'Action log'),
        card(E('b', null, 'Tamper check'), E('p', null, 'Ledger: ', pill(v.ledger.ok ? 'intact (' + v.ledger.rows + ' rows)' : 'BROKEN at ' + v.ledger.broken_at, v.ledger.ok ? '' : 'r'), ' Action log: ', pill(v.audit.ok ? 'intact (' + v.audit.rows + ' rows)' : 'BROKEN at ' + v.audit.broken_at, v.audit.ok ? '' : 'r')),
          E('p', { class: 'mut' }, 'Both are append-only hash chains: any edit or deletion breaks every later hash.')),
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
