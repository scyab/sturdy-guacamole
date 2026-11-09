// Clabbe's additions to PrimeTime's quiz. nginx puts this script first in
// <head> on every page of the build (nginx/snippets/html-headers.conf), so it
// runs before the game's own app; PrimeTime's files in public/ are unchanged.
//
// The start screen is a gate. A player must see "Börja spela!", with the
// notice under it that their details go to the quiz's sponsor, and press it
// before playing — on every load, signed in or not, live show or not. The
// game itself sends a signed-in player straight past it (route middleware
// `requires-guest`), so this script:
//
//   - takes `requires-guest` off the start screen's route, so a signed-in
//     player can be shown it;
//   - until the button is pressed, sends every navigation back to the start
//     screen (a router guard), and keeps the game hidden until the start
//     screen is what it shows;
//   - when a signed-in player presses the button, takes them to the lobby —
//     from where the game goes on to a running live show by itself — instead
//     of asking their age and sending them to sign in again;
//   - holds the button until the sponsor notice is known. The page that
//     frames the game (Clabbe's game panel) sends it as { source: "clabbe",
//     version: 1, type: "startMessage", payload: { text, terms, links } },
//     null, "" or [] for none, and answers every { source: "ptw", version:
//     1, type: "ready" } — sent by this script, and from build 1.5.8 by the
//     game too.
//     In a frame the button does nothing until that answer has come, so no
//     one passes the gate before the notice is on screen; after
//     NOTICE_WAIT_MS without an answer it works anyway;
//   - shows the notice's text under the button when the game doesn't. From
//     build 1.5.8 the game shows it itself (GAME_NOTICE), and this script's
//     own copy steps aside;
//   - when the message carries the sponsor's terms (payload.terms: { label,
//     text, body }), ends the notice — the game's or ours — with a link that
//     opens them in a dialog inside the game: players read them without
//     leaving it. `body` is the terms as a few kinds of block — paragraphs,
//     subheadings, lists — holding runs of text, bold or italic, and links
//     ({ href, content }); `text` is the same as plain text, a blank line
//     between paragraphs, shown when a body is missing or not one this
//     script reads. Both are built into elements one by one, text as text,
//     never as markup: nothing in them runs;
//   - when the message carries links (payload.links: [{ label, url }]) — the
//     sponsor's privacy policy, say — ends the notice with them too, after
//     the terms link.
//
// Every link to another site, under the button or in the terms, is an https
// address this script has checked itself (safeUrl), and opens in a new tab:
// the game stays where it is.
//
// The game's buttons are pressed by pointer, not by click: its
// useSpringPress fires on pointerdown + pointerup over the button, and
// ignores a button marked aria-disabled="true". So the waiting button is
// marked aria-disabled — the game's own code then refuses it — and the
// presses this script acts on are pointer presses, seen first, at capture.
//
// It works through the game's own app — the Vue app on #__nuxt, its router
// and its Pinia store "authentication" — and fails closed: when those cannot
// be found, or the start screen never shows, it puts up a gate of its own
// (the notice and a "Börja spela!" button) rather than letting the game
// through. Every PrimeTime build is tested with this script before it is
// deployed (README).
(function () {
  "use strict";

  var START_ROUTE = "index";
  var SIGNED_IN_NEXT = "lobby";
  var START_SCREEN = ".login__main";
  var NOTICE_CLASS = "clabbe-start-notice";
  // The game's own notice under its button (from build 1.5.8), and its colour.
  var GAME_NOTICE = ".login__start-message";
  var NOTICE_THEME = "text-StartMessageText";
  var MAX_NOTICE = 300;
  var TERMS_LINK_CLASS = "clabbe-terms-link";
  var TERMS_TAIL_CLASS = "clabbe-terms-tail";
  var TERMS_CLASS = "clabbe-terms";
  // The game's start button: the start screen's buttons but our terms link.
  var START_BUTTON = START_SCREEN + " button:not(." + TERMS_LINK_CLASS + ")";
  // Escaped: nginx sends this file without a charset.
  var DEFAULT_TERMS_LABEL = "L\u00e4s villkoren";
  var CLOSE_TERMS = "St\u00e4ng";
  var MAX_TERMS_LABEL = 80;
  var MAX_TERMS = 20000;
  var LINK_CLASS = "clabbe-start-link";
  var MAX_LINKS = 4;
  var MAX_LINK_LABEL = 80;
  var MAX_URL = 2000;
  // Escaped: nginx sends this file without a charset.
  var NEW_TAB = " (\u00f6ppnas i en ny flik)";
  // Between the links at the end of the notice: the dot keeps to the link
  // before it when the line wraps.
  var BETWEEN_LINKS = "\u00a0\u00b7 ";
  var NOTICE_WAIT_MS = 4000;
  var OWN_GATE_AFTER_MS = 8000;

  var framed = window.parent !== window;
  var passed = false; // the button was pressed during this load
  var notice = null; // the sponsor notice, or null for none
  var terms = null; // the sponsor's terms, { label, text, body }, or null for none
  var links = []; // the sponsor's links to other sites, [{ label, url }]
  var noticeKnown = !framed; // the framing page has answered, or there is none
  var app = null; // { router, auth } once the game's app is up
  var ownGate = null; // our own gate, when the game's could not be shown

  var head = document.head || document.documentElement;

  // The game stays hidden until the start screen is what it shows.
  var hidden = document.createElement("style");
  hidden.textContent = "#__nuxt{visibility:hidden}";
  head.appendChild(hidden);
  function reveal() {
    if (hidden.parentNode) hidden.parentNode.removeChild(hidden);
  }

  var look = document.createElement("style");
  look.textContent =
    "." + NOTICE_CLASS + "{margin:1.5rem auto 0;max-width:36rem;padding:0 1rem;text-align:center;" +
    "font-size:1rem;line-height:1.5;white-space:pre-line;overflow-wrap:anywhere}" +
    // Our copy of the notice is laid out like the game's own and wears its
    // colour (NOTICE_THEME). The grey is for a build without that class: it
    // sits in a cascade layer named before the game's Tailwind layers, so any
    // of theirs wins over it, while the rules above stay unlayered and beat
    // their base styles (which would zero the margin).
    "@layer clabbe-fallback{." + NOTICE_CLASS + "{color:#6b6b70}}" +
    START_SCREEN + " button[aria-busy=true]{opacity:.6;cursor:progress}" +
    ".clabbe-gate{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;" +
    "align-items:center;justify-content:center;gap:1.25rem;padding:2rem 1rem;background:#fff;color:#111;" +
    "font:16px/1.4 system-ui,sans-serif;text-align:center}" +
    ".clabbe-gate p:empty{display:none}" +
    ".clabbe-gate__start{font:inherit;font-weight:600;font-size:1.125rem;padding:1rem 2rem;border:0;" +
    "border-radius:1rem;background:#111;color:#fff;cursor:pointer;width:min(36rem,100%)}" +
    // The link at the end of the notice: text in the notice's own colour.
    "." + TERMS_LINK_CLASS + "{all:unset;display:inline;color:inherit;font:inherit;text-decoration:underline;" +
    "text-underline-offset:.15em;cursor:pointer}" +
    "." + TERMS_LINK_CLASS + ":focus-visible{outline:2px solid currentColor;outline-offset:2px;border-radius:2px}" +
    // Links to other sites, under the button and in the terms: the text
    // they sit in, underlined.
    "." + LINK_CLASS + "{color:inherit;font:inherit;text-decoration:underline;text-underline-offset:.15em;" +
    "overflow-wrap:anywhere}" +
    "." + LINK_CLASS + ":focus-visible{outline:2px solid currentColor;outline-offset:2px;border-radius:2px}" +
    ".clabbe-visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;" +
    "clip:rect(0 0 0 0);white-space:nowrap;border:0}" +
    // The terms dialog. Also laid out without the browser's own dialog
    // support (then it is only shown and hidden by its open attribute).
    "." + TERMS_CLASS + ":not([open]){display:none}" +
    "." + TERMS_CLASS + "{position:fixed;inset:0;margin:auto;z-index:2147483647;box-sizing:border-box;" +
    "width:min(36rem,calc(100% - 2rem));max-width:none;height:fit-content;max-height:calc(100vh - 2rem);" +
    "max-height:calc(100dvh - 2rem);padding:0;border:0;border-radius:1rem;background:#fff;color:#111;" +
    "font-family:inherit;font-size:1rem;line-height:1.5;box-shadow:0 1rem 3rem rgba(0,0,0,.35);overflow:hidden}" +
    "." + TERMS_CLASS + "::backdrop{background:rgba(0,0,0,.55)}" +
    "." + TERMS_CLASS + "__box{display:flex;flex-direction:column;max-height:calc(100vh - 2rem);" +
    "max-height:calc(100dvh - 2rem)}" +
    "." + TERMS_CLASS + "__title{margin:0;padding:1.25rem 1.5rem .75rem;font-size:1.25rem;font-weight:700;" +
    "line-height:1.3;overflow-wrap:anywhere}" +
    "." + TERMS_CLASS + "__text{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;" +
    "padding:0 1.5rem;white-space:pre-line;overflow-wrap:anywhere}" +
    "." + TERMS_CLASS + "__text p," + "." + TERMS_CLASS + "__text ul," + "." + TERMS_CLASS + "__text ol{margin:0 0 1em}" +
    "." + TERMS_CLASS + "__text h3{margin:1.25em 0 .5em;font-size:1.0625rem;font-weight:700;line-height:1.3}" +
    "." + TERMS_CLASS + "__text h3:first-child{margin-top:0}" +
    "." + TERMS_CLASS + "__text ul," + "." + TERMS_CLASS + "__text ol{padding-left:1.5em}" +
    "." + TERMS_CLASS + "__text ul{list-style:disc}" +
    "." + TERMS_CLASS + "__text ol{list-style:decimal}" +
    "." + TERMS_CLASS + "__text li{margin:0 0 .25em}" +
    "." + TERMS_CLASS + "__text strong{font-weight:700}" +
    "." + TERMS_CLASS + "__text em{font-style:italic}" +
    "." + TERMS_CLASS + "__text:focus-visible{outline:2px solid #111;outline-offset:-2px}" +
    "." + TERMS_CLASS + "__close{flex:none;margin:.75rem 1.5rem 1.25rem;padding:.875rem 1.5rem;border:0;" +
    "border-radius:1rem;background:#111;color:#fff;font:inherit;font-weight:600;cursor:pointer}";
  head.appendChild(look);

  function stop(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function signedIn() {
    return Boolean(app && app.auth && app.auth.isAuthenticated === true);
  }

  // --- the sponsor notice

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || event.origin !== location.origin) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.source !== "clabbe" || data.type !== "startMessage") return;
    var text = data.payload && data.payload.text;
    notice = typeof text === "string" && text.trim() ? text.trim().slice(0, MAX_NOTICE) : null;
    terms = termsFrom(data.payload && data.payload.terms);
    links = linksFrom(data.payload && data.payload.links);
    noticeKnown = true;
    render();
  });

  function termsFrom(value) {
    if (!value || typeof value !== "object" || typeof value.text !== "string" || !value.text.trim()) return null;
    var label = typeof value.label === "string" && value.label.trim() ? value.label.trim() : DEFAULT_TERMS_LABEL;
    return { label: label.slice(0, MAX_TERMS_LABEL), text: value.text.trim().slice(0, MAX_TERMS), body: bodyFrom(value.body) };
  }

  // An address a player may be sent to: https, a host with a dot in it, no
  // user name or password in front of it. The address as the browser writes
  // it, or null.
  function safeUrl(value) {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_URL) return null;
    var url;
    try {
      url = new URL(value.trim());
    } catch (e) {
      return null;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hostname.indexOf(".") === -1) return null;
    return url.href;
  }

  // The links under the button: the complete ones, at most MAX_LINKS.
  function linksFrom(value) {
    if (!Array.isArray(value)) return [];
    var found = [];
    for (var i = 0; i < value.length && found.length < MAX_LINKS; i++) {
      var link = value[i];
      var url = link && typeof link === "object" ? safeUrl(link.url) : null;
      var label = url && typeof link.label === "string" ? link.label.trim().slice(0, MAX_LINK_LABEL) : "";
      if (url && label) found.push({ label: label, url: url });
    }
    return found;
  }

  // The terms' blocks, exactly as Clabbe sends them, or null — the plain
  // text is shown then. Every part is checked; an unknown one refuses the
  // whole body rather than showing part of the terms.
  function isRun(part) {
    return Boolean(part) && typeof part === "object" && typeof part.text === "string" &&
      (part.bold === undefined || part.bold === true) && (part.italic === undefined || part.italic === true);
  }
  function isInline(part) {
    if (!part || typeof part !== "object") return false;
    if ("br" in part) return part.br === true;
    if ("href" in part) {
      return safeUrl(part.href) === part.href && Array.isArray(part.content) && part.content.length > 0 && part.content.every(isRun);
    }
    return isRun(part);
  }
  function isInlineList(list) {
    return Array.isArray(list) && list.every(isInline);
  }
  function bodyFrom(value) {
    if (!Array.isArray(value) || !value.length) return null;
    var ok = value.every(function (block) {
      if (!block || typeof block !== "object") return false;
      if (block.type === "p" || block.type === "h") return isInlineList(block.content);
      if (block.type === "ul" || block.type === "ol") return Array.isArray(block.items) && block.items.every(isInlineList);
      return false;
    });
    return ok ? value : null;
  }

  function announce() {
    if (!framed) return;
    try {
      window.parent.postMessage({ source: "ptw", version: 1, type: "ready" }, location.origin);
    } catch (e) {
      // Framed by a page we do not answer to: nothing to announce.
    }
  }

  setTimeout(function () {
    if (noticeKnown) return;
    noticeKnown = true;
    render();
  }, NOTICE_WAIT_MS);

  // A link to another site: its words, opening its address in a new tab
  // (which a screen reader is told).
  function externalLink(content, href) {
    var link = document.createElement("a");
    link.className = LINK_CLASS;
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.appendChild(content);
    var hint = document.createElement("span");
    hint.className = "clabbe-visually-hidden";
    hint.textContent = NEW_TAB;
    link.appendChild(hint);
    return link;
  }

  // What ends a notice: the terms link, then the links to other sites, as a
  // key for knowing when it is stale.
  function tailKey() {
    return JSON.stringify([ terms ? terms.label : null, links ]);
  }

  // " " and the links, to end a notice with. The space comes with the
  // first, so the links can wrap to a line of their own; at the start of a
  // line the notice's white-space: pre-line drops it.
  function buildTail() {
    var tail = document.createElement("span");
    tail.className = TERMS_TAIL_CLASS;
    tail.setAttribute("data-clabbe-tail", tailKey());
    var parts = [];
    if (terms) {
      var termsLink = document.createElement("button");
      termsLink.type = "button";
      termsLink.className = TERMS_LINK_CLASS;
      termsLink.setAttribute("aria-haspopup", "dialog");
      termsLink.textContent = terms.label;
      parts.push(termsLink);
    }
    links.forEach(function (link) {
      parts.push(externalLink(document.createTextNode(link.label), link.url));
    });
    parts.forEach(function (part, i) {
      tail.appendChild(document.createTextNode(i === 0 ? " " : BETWEEN_LINKS));
      tail.appendChild(part);
    });
    return tail;
  }

  // Ends a notice with the terms link and the links, or with nothing when
  // there are none. Touches the page only when they are missing, out of
  // place or stale: render runs on every change to the page, ours included.
  function endWithTail(el) {
    var tail = el.querySelector(":scope > ." + TERMS_TAIL_CLASS);
    var wanted = Boolean(terms || links.length);
    if (tail && wanted && el.lastChild === tail && tail.getAttribute("data-clabbe-tail") === tailKey()) return;
    if (tail) el.removeChild(tail);
    if (wanted) el.appendChild(buildTail());
  }

  // Our own copy of the notice: its text, then the terms link.
  function fillNotice(el) {
    var key = JSON.stringify(notice);
    if (el.getAttribute("data-clabbe-notice") !== key) {
      el.setAttribute("data-clabbe-notice", key);
      while (el.firstChild) el.removeChild(el.firstChild);
      if (notice) el.appendChild(document.createTextNode(notice));
    }
    endWithTail(el);
  }

  // Puts the notice under the game's start button, and the gate's state on
  // it. Idempotent: called on every change to the page.
  function render() {
    var screen = document.querySelector(START_SCREEN);
    if (screen) {
      var own = screen.querySelector(":scope > ." + NOTICE_CLASS);
      // The game's own notice, when it shows one: ours steps aside and only
      // the terms link and the links are added, at its end. The game puts
      // its text in anew whenever the notice changes, which takes them with
      // it; the render that change sets off puts them back.
      var game = screen.querySelector(":scope > " + GAME_NOTICE);
      if (game) {
        if (own) screen.removeChild(own);
        endWithTail(game);
      } else if (notice || terms || links.length) {
        if (!own) {
          own = document.createElement("p");
          own.className = NOTICE_CLASS + " " + NOTICE_THEME;
        }
        if (screen.lastElementChild !== own) screen.appendChild(own);
        fillNotice(own);
      } else if (own) {
        screen.removeChild(own);
      }
      var button = screen.querySelector(START_BUTTON);
      if (button) {
        if (noticeKnown) {
          if (button.hasAttribute("aria-busy")) {
            button.removeAttribute("aria-busy");
            button.removeAttribute("aria-disabled");
          }
        } else if (button.getAttribute("aria-busy") !== "true" || button.getAttribute("aria-disabled") !== "true") {
          button.setAttribute("aria-busy", "true");
          button.setAttribute("aria-disabled", "true");
        }
      }
      reveal();
    }
    if (ownGate) {
      fillNotice(ownGate.querySelector("p"));
      ownGate.querySelector(".clabbe-gate__start").setAttribute("aria-busy", noticeKnown ? "false" : "true");
    }
    syncTerms();
  }

  var queued = false;
  new MutationObserver(function () {
    if (queued) return;
    queued = true;
    Promise.resolve().then(function () {
      queued = false;
      render();
    });
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    // The game re-rendering its button can drop the waiting marks.
    attributes: true,
    attributeFilter: [ "aria-disabled", "disabled" ],
  });

  // --- the gate

  function startButtonOf(event) {
    return event.target instanceof Element ? event.target.closest(START_BUTTON) : null;
  }

  // A press is a pointerdown on the start button and a pointerup still over
  // it — the game's own rule (useSpringPress).
  var pressed = null;
  document.addEventListener(
    "pointerdown",
    function (event) {
      var button = startButtonOf(event);
      pressed = null;
      if (!button) return;
      if (!noticeKnown) {
        stop(event);
        return;
      }
      pressed = button;
    },
    true
  );
  document.addEventListener(
    "pointerup",
    function (event) {
      var button = pressed;
      pressed = null;
      if (!button || !noticeKnown) return;
      var box = button.getBoundingClientRect();
      var over = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!over) return;
      passed = true;
      // A guest goes on the game's own way: their age, then signing in.
      if (signedIn()) {
        stop(event);
        app.router.push({ name: SIGNED_IN_NEXT });
      }
    },
    true
  );
  // Clicks, too, never reach a waiting button (a keyboard, or a later game
  // that listens for them).
  document.addEventListener(
    "click",
    function (event) {
      if (!noticeKnown && startButtonOf(event)) stop(event);
    },
    true
  );

  function showOwnGate() {
    if (passed || ownGate || !document.body) return;
    ownGate = document.createElement("div");
    ownGate.className = "clabbe-gate";
    ownGate.setAttribute("role", "dialog");
    ownGate.setAttribute("aria-modal", "true");
    var text = document.createElement("p");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "clabbe-gate__start";
    // Escaped: nginx sends this file without a charset.
    button.textContent = "B\u00f6rja spela!";
    button.addEventListener("click", function () {
      if (!noticeKnown) return;
      passed = true;
      ownGate.parentNode.removeChild(ownGate);
      ownGate = null;
      reveal();
    });
    ownGate.appendChild(text);
    ownGate.appendChild(button);
    document.body.appendChild(ownGate);
    render();
  }

  setTimeout(function () {
    if (!passed && hidden.parentNode) showOwnGate();
  }, OWN_GATE_AFTER_MS);

  // --- the terms

  var termsDialog = null;
  var termsOpener = null; // the link that opened them, focused again on close
  var nativeDialog = typeof HTMLDialogElement === "function" && typeof HTMLDialogElement.prototype.showModal === "function";

  function part(tag, name) {
    var el = document.createElement(tag);
    if (name) el.className = TERMS_CLASS + "__" + name;
    return el;
  }

  function buildTerms() {
    termsDialog = document.createElement(nativeDialog ? "dialog" : "div");
    termsDialog.className = TERMS_CLASS;
    termsDialog.setAttribute("aria-labelledby", "clabbe-terms-title");
    if (!nativeDialog) {
      termsDialog.setAttribute("role", "dialog");
      termsDialog.setAttribute("aria-modal", "true");
    }
    var box = part("div", "box");
    var title = part("h2", "title");
    title.id = "clabbe-terms-title";
    var text = part("div", "text");
    // Scrollable from the keyboard too.
    text.tabIndex = 0;
    var close = part("button", "close");
    close.type = "button";
    close.textContent = CLOSE_TERMS;
    // Focused as the dialog opens: it sits below the text, outside the part
    // that scrolls, so the terms open at their top.
    close.autofocus = true;
    close.addEventListener("click", closeTerms);
    box.appendChild(title);
    box.appendChild(text);
    box.appendChild(close);
    termsDialog.appendChild(box);
    // A press on the dimmed page around the dialog closes it.
    termsDialog.addEventListener("click", function (event) {
      if (event.target === termsDialog) closeTerms();
    });
    termsDialog.addEventListener("close", afterClose);
    termsDialog.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !nativeDialog) closeTerms();
    });
    document.body.appendChild(termsDialog);
  }

  // A run of text: a text node, in <strong> and <em> when it is bold or
  // italic. `room` counts down the characters the terms may still show.
  function runNode(run, room) {
    var node = document.createTextNode(run.text.slice(0, Math.max(room.left, 0)));
    room.left -= run.text.length;
    if (run.italic) {
      var em = document.createElement("em");
      em.appendChild(node);
      node = em;
    }
    if (run.bold) {
      var strong = document.createElement("strong");
      strong.appendChild(node);
      node = strong;
    }
    return node;
  }

  function fillInline(el, content, room) {
    content.forEach(function (part) {
      if (room.left <= 0) return;
      if (part.br) {
        el.appendChild(document.createElement("br"));
      } else if (part.href) {
        var words = document.createDocumentFragment();
        part.content.forEach(function (run) {
          words.appendChild(runNode(run, room));
        });
        el.appendChild(externalLink(words, part.href));
      } else {
        el.appendChild(runNode(part, room));
      }
    });
  }

  // The terms' blocks, at most MAX_TERMS characters of them.
  function fillBody(text, body) {
    var room = { left: MAX_TERMS };
    body.forEach(function (block) {
      if (room.left <= 0) return;
      if (block.type === "ul" || block.type === "ol") {
        var list = document.createElement(block.type);
        block.items.forEach(function (item) {
          if (room.left <= 0) return;
          var li = document.createElement("li");
          fillInline(li, item, room);
          list.appendChild(li);
        });
        text.appendChild(list);
        return;
      }
      var el = document.createElement(block.type === "h" ? "h3" : "p");
      fillInline(el, block.content, room);
      text.appendChild(el);
    });
  }

  // The plain text, a blank line between paragraphs.
  function fillText(text) {
    terms.text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n\s*/).forEach(function (paragraph) {
      if (!paragraph.trim()) return;
      var p = document.createElement("p");
      p.textContent = paragraph.trim();
      text.appendChild(p);
    });
  }

  // The dialog's heading and text, from the terms now. Rebuilt only when
  // they have changed.
  function fillTerms() {
    var key = JSON.stringify([ terms.label, terms.text, terms.body ]);
    if (termsDialog.getAttribute("data-clabbe-terms") === key) return;
    termsDialog.setAttribute("data-clabbe-terms", key);
    termsDialog.querySelector("." + TERMS_CLASS + "__title").textContent = terms.label;
    var text = termsDialog.querySelector("." + TERMS_CLASS + "__text");
    while (text.firstChild) text.removeChild(text.firstChild);
    if (terms.body) fillBody(text, terms.body);
    else fillText(text);
    text.scrollTop = 0;
  }

  function openTerms(opener) {
    if (!terms || !document.body) return;
    if (!termsDialog) buildTerms();
    fillTerms();
    termsOpener = opener;
    if (termsDialog.hasAttribute("open")) return;
    if (nativeDialog) {
      termsDialog.showModal();
    } else {
      termsDialog.setAttribute("open", "");
      termsDialog.querySelector("." + TERMS_CLASS + "__close").focus();
    }
  }

  function closeTerms() {
    if (!termsDialog || !termsDialog.hasAttribute("open")) return;
    if (nativeDialog) {
      termsDialog.close();
    } else {
      termsDialog.removeAttribute("open");
      afterClose();
    }
  }

  function afterClose() {
    var opener = termsOpener && termsOpener.isConnected ? termsOpener : document.querySelector("." + TERMS_LINK_CLASS);
    termsOpener = null;
    if (opener) opener.focus();
  }

  // The terms follow the notice: another window's replace them, even open;
  // none close them.
  function syncTerms() {
    if (!termsDialog) return;
    if (terms) fillTerms();
    else closeTerms();
  }

  // Seen first, at capture: the game never takes a press on our link for its
  // own.
  document.addEventListener(
    "click",
    function (event) {
      var link = event.target instanceof Element ? event.target.closest("." + TERMS_LINK_CLASS) : null;
      if (!link) return;
      stop(event);
      openTerms(link);
    },
    true
  );

  // --- the game's app

  function findApp() {
    var root = document.getElementById("__nuxt");
    var vue = root && root.__vue_app__;
    var props = vue && vue.config && vue.config.globalProperties;
    var router = props && props.$router;
    if (!router || typeof router.beforeEach !== "function" || typeof router.getRoutes !== "function") return null;
    var stores = props.$pinia && props.$pinia._s;
    return { router: router, auth: stores && typeof stores.get === "function" ? stores.get("authentication") : null };
  }

  // The start screen without `requires-guest`, so signed-in players can be
  // shown it. False when the game has no such route.
  function openStartToEveryone(router) {
    var start = router.getRoutes().filter(function (route) {
      return route.name === START_ROUTE;
    })[0];
    if (!start) return false;
    var middleware = start.meta && start.meta.middleware;
    if (Array.isArray(middleware) && middleware.indexOf("requires-guest") !== -1) {
      router.addRoute({
        path: start.path,
        name: START_ROUTE,
        components: start.components,
        meta: Object.assign({}, start.meta, {
          middleware: middleware.filter(function (name) {
            return name !== "requires-guest";
          }),
        }),
      });
    }
    return true;
  }

  function hook(found) {
    app = found;
    var router = app.router;
    if (!openStartToEveryone(router)) {
      showOwnGate();
      return;
    }
    router.beforeEach(function (to) {
      if (passed || to.name === START_ROUTE) return true;
      return { name: START_ROUTE, replace: true };
    });
    var ready = typeof router.isReady === "function" ? router.isReady() : Promise.resolve();
    ready
      .then(function () {
        if (!passed && router.currentRoute.value.name !== START_ROUTE) return router.replace({ name: START_ROUTE });
        return undefined;
      })
      .then(render, showOwnGate);
    announce();
  }

  announce();
  (function poll(tries) {
    var found = findApp();
    if (found) {
      hook(found);
      return;
    }
    if (tries > 0) setTimeout(poll, 50, tries - 1);
  })(160);
})();
