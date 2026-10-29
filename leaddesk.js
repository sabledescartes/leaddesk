/*! Lead Desk website form. MIT licensed. https://github.com/sabledescartes/leaddesk
 *
 * Add it to any web page with:
 *   <div id="leaddesk"></div>
 *   <script src="https://YOUR-SITE.netlify.app/leaddesk.js" data-business="Your Co" defer></script>
 *
 * Options (all optional) are data- attributes on the script tag:
 *   data-business   your company name, used in the thank-you message
 *   data-title      heading above the form
 *   data-intro      one short line under the heading
 *   data-button     text on the submit button
 *   data-color      button color, as #rrggbb
 *   data-services   choices for the service menu, separated by |
 *   data-phone      phone number shown if something goes wrong
 *   data-target     CSS selector of the element to put the form in (default: #leaddesk,
 *                   or right after the script tag)
 */
(function () {
  'use strict';

  var script = document.currentScript || document.querySelector('script[src*="leaddesk.js"]');

  function hexOk(c) { return /^#[0-9a-fA-F]{6}$/.test(c || ''); }
  function lum(hex) {
    var c = [1, 3, 5].map(function (i) {
      var v = parseInt(hex.substr(i, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function inkOn(hex) { return lum(hex) > 0.4 ? '#111111' : '#ffffff'; }

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (attrs[k] === false || attrs[k] === null || attrs[k] === undefined) continue;
      if (k === 'text') el.textContent = attrs[k]; else el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }

  function css(accent, ink, ring) {
    return '' +
      ':host{display:block;}' +
      '*,*::before,*::after{box-sizing:border-box;}' +
      '.ld{max-width:520px;margin:0 auto;padding:24px;background:#fff;color:#1b1b1b;border:1px solid #d3d8dc;border-radius:12px;font-family:inherit;font-size:16px;line-height:1.5;text-align:left;}' +
      '.ld h2{margin:0 0 4px;font-size:1.375rem;line-height:1.25;font-weight:700;font-family:inherit;color:#1b1b1b;}' +
      '.ld p{margin:0;}' +
      '.intro{color:#4a5359;margin-bottom:4px;}' +
      '.f{margin-top:16px;}' +
      'label{display:block;font-weight:600;font-size:.9375rem;margin-bottom:6px;}' +
      '.opt{font-weight:400;color:#4a5359;}' +
      'input,select,textarea{display:block;width:100%;min-height:48px;padding:11px 12px;font:inherit;font-size:16px;color:#1b1b1b;background:#fff;border:1px solid #7b858c;border-radius:8px;}' +
      'textarea{min-height:96px;resize:vertical;}' +
      'input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid ' + ring + ';outline-offset:2px;}' +
      '[aria-invalid="true"]{border-color:#b3261e;border-width:2px;padding:10px 11px;}' +
      '.row{display:grid;grid-template-columns:1fr 1fr;gap:12px;}' +
      '@media (max-width:460px){.row{grid-template-columns:1fr;}.ld{padding:18px;}}' +
      'button.go{display:block;width:100%;min-height:50px;margin-top:20px;padding:13px 16px;font:inherit;font-size:1rem;font-weight:700;color:' + ink + ';background:' + accent + ';border:2px solid ' + (lum(accent) > 0.85 ? '#1b1b1b' : accent) + ';border-radius:8px;cursor:pointer;}' +
      'button.go:hover{filter:brightness(.94);}' +
      'button.go[disabled]{opacity:.65;cursor:default;filter:none;}' +
      '.err{min-height:1.5em;margin-top:12px;color:#b3261e;font-weight:600;font-size:.9375rem;}' +
      '.fine{margin-top:12px;color:#4a5359;font-size:.8125rem;}' +
      '.hp{position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;}' +
      '.ok{padding:8px 0;}' +
      '.ok h2{margin-bottom:8px;}' +
      '.ok a{color:inherit;font-weight:700;}' +
      '.pv{margin-top:14px;padding:8px 10px;background:#fff6d6;color:#4a3b00;border-radius:6px;font-size:.8125rem;}';
  }

  function render(mount, cfg, opts) {
    opts = opts || {};
    cfg = cfg || {};
    var accent = hexOk(cfg.color) ? cfg.color : '#1f6feb';
    var ink = inkOn(accent);
    var ring = lum(accent) > 0.4 ? '#111111' : accent;
    var services = (cfg.services || []).filter(Boolean);
    var endpoint = String(opts.endpoint || '').replace(/\/$/, '');
    var shownAt = Date.now();

    var host = h('div');
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.appendChild(h('style', { text: css(accent, ink, ring) }));

    var card = h('div', { 'class': 'ld' });
    root.appendChild(card);

    var uid = 'ld' + Math.random().toString(36).slice(2, 7);
    function field(id, label, optional, control) {
      var lab = h('label', { 'for': uid + id });
      lab.appendChild(document.createTextNode(label));
      if (optional) lab.appendChild(h('span', { 'class': 'opt', text: ' (optional)' }));
      control.id = uid + id;
      return h('div', { 'class': 'f' }, [lab, control]);
    }

    var name = h('input', { name: 'name', type: 'text', autocomplete: 'name', required: false });
    var phone = h('input', { name: 'phone', type: 'tel', autocomplete: 'tel', inputmode: 'tel' });
    var email = h('input', { name: 'email', type: 'email', autocomplete: 'email', inputmode: 'email' });
    var city = h('input', { name: 'city', type: 'text' });
    var service = null;
    if (services.length) {
      service = h('select', { name: 'service' });
      service.appendChild(h('option', { value: '', text: 'Choose a service' }));
      services.forEach(function (s) { service.appendChild(h('option', { value: s, text: s })); });
    }
    var message = h('textarea', { name: 'message', rows: '3' });
    var website = h('input', { name: 'website', type: 'text', tabindex: '-1', autocomplete: 'off' });
    var err = h('div', { 'class': 'err', role: 'alert', 'aria-live': 'assertive' });
    var btn = h('button', { 'class': 'go', type: 'submit', text: cfg.button || 'Request my estimate' });

    var form = h('form', { novalidate: true }, [
      h('div', { 'class': 'hp', 'aria-hidden': 'true' }, [h('label', { text: 'Leave this field empty' }), website]),
      field('n', 'Your name', false, name),
      h('div', { 'class': 'row' }, [field('p', 'Phone', false, phone), field('e', 'Email', true, email)]),
      h('div', { 'class': 'row' }, [field('c', 'City or ZIP code', true, city), service ? field('s', 'Service', true, service) : null]),
      field('m', 'Tell us about the project', true, message),
      err,
      btn,
      h('p', { 'class': 'fine', text: 'We use your details only to answer your request.' }),
      opts.preview ? h('p', { 'class': 'pv', text: 'Preview: nothing is sent from here.' }) : null
    ]);

    card.appendChild(h('h2', { text: cfg.title || 'Request a free estimate' }));
    if (cfg.intro) card.appendChild(h('p', { 'class': 'intro', text: cfg.intro }));
    card.appendChild(form);

    function bad(el, msg) {
      [name, phone, email].forEach(function (x) { x.removeAttribute('aria-invalid'); });
      if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
      err.textContent = msg || '';
    }

    function thanks(first) {
      card.innerHTML = '';
      var who = cfg.business ? cfg.business : 'We';
      var box = h('div', { 'class': 'ok', role: 'status', tabindex: '-1' }, [
        h('h2', { text: 'Thanks' + (first ? ', ' + first : '') + '. We got your request.' }),
        h('p', { text: who + (cfg.business ? ' will' : ' will') + ' call you soon to talk about your project.' })
      ]);
      var tel = String(cfg.phone || '').replace(/[^\d+]/g, '');
      if (tel) {
        var p = h('p', { style: 'margin-top:10px' });
        p.appendChild(document.createTextNode('Need us sooner? Call '));
        p.appendChild(h('a', { href: 'tel:' + tel, text: cfg.phone }));
        p.appendChild(document.createTextNode('.'));
        box.appendChild(p);
      }
      card.appendChild(box);
      box.focus();
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var d = {
        name: name.value.trim(), phone: phone.value.trim(), email: email.value.trim(),
        city: city.value.trim(), service: service ? service.value : '', message: message.value.trim()
      };
      if (!d.name) return bad(name, 'Please enter your name.');
      if (d.phone.replace(/\D/g, '').length < 10) return bad(phone, 'Please enter a phone number with area code.');
      if (d.email && !/^\S+@\S+\.\S+$/.test(d.email)) return bad(email, 'That email address does not look right.');
      bad(null, '');

      var first = d.name.split(/\s+/)[0];
      btn.disabled = true; btn.textContent = 'Sending...';

      if (opts.preview) {
        host.dispatchEvent(new CustomEvent('leaddesk:preview-submit', { detail: d, bubbles: true, composed: true }));
        return setTimeout(function () { thanks(first); }, 350);
      }

      var q = new URLSearchParams(location.search);
      var payload = {
        name: d.name, phone: d.phone, email: d.email, city: d.city, service: d.service, message: d.message,
        website: website.value, t: shownAt,
        page: location.origin + location.pathname,
        utm_source: q.get('utm_source') || '', utm_medium: q.get('utm_medium') || '',
        utm_campaign: q.get('utm_campaign') || '', gclid: q.get('gclid') || ''
      };
      var fail = function (msg) {
        btn.disabled = false; btn.textContent = cfg.button || 'Request my estimate';
        var tail = cfg.phone ? ' Please call ' + cfg.phone + '.' : ' Please try again in a minute.';
        err.textContent = (msg || 'We could not send your request.') + (msg && /call/i.test(msg) ? '' : tail);
      };
      fetch(endpoint + '/api/lead', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok) thanks(first); else fail(r.status === 400 ? j.error : r.status === 429 ? j.error : '');
        });
      }).catch(function () { fail(''); });
    });

    mount.innerHTML = '';
    mount.appendChild(host);
    return host;
  }

  window.LeadDesk = { render: render };

  // ---- automatic mount from the script tag ----
  if (!script || script.hasAttribute('data-manual')) return;
  var d = script.dataset || {};
  var endpoint = '';
  try { endpoint = new URL(script.src, location.href).origin; } catch (e) {}
  var cfg = {
    business: d.business || '', title: d.title || '', intro: d.intro || '', button: d.button || '',
    color: d.color || '', phone: d.phone || '',
    services: (d.services || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean)
  };

  function start() {
    var target = d.target ? document.querySelector(d.target) : document.getElementById('leaddesk');
    if (!target) {
      target = document.createElement('div');
      script.parentNode.insertBefore(target, script.nextSibling);
    }
    render(target, cfg, { endpoint: endpoint });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
