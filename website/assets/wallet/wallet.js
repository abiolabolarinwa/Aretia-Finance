/*!
 * Aretia Finance -- Connect Wallet
 * ---------------------------------------------------------------------
 * Wallet-agnostic Solana wallet connection using the Wallet Standard
 * discovery protocol (https://github.com/wallet-standard/wallet-standard),
 * implemented by hand rather than via @wallet-standard/app: the whole
 * protocol is two window CustomEvents, so pulling in a package (and a
 * bundler this static site doesn't have) to do it buys nothing.
 *
 * This module ONLY establishes a connection and reads public balances.
 * It never requests a seed phrase or private key, never stores one, and
 * never signs or sends a transaction. Every wallet feature this file
 * calls is 'standard:connect', 'standard:disconnect', and
 * 'standard:events' -- account discovery and lifecycle, nothing that
 * moves funds.
 *
 * Depends on the @solana/web3.js UMD build already loaded by the page
 * (window.solanaWeb3) -- no new dependency for RPC calls, reusing
 * exactly what index.html/verify.html/apply.html already load.
 *
 * Mount point: any element with [data-aretia-wallet-mount]. Call
 * AretiaWallet.init() once the DOM is ready (this file self-inits on
 * DOMContentLoaded, so a page just needs the mount element + this
 * script tag, nothing else).
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------
  // Configuration -- the single source of truth for the canonical ACT
  // mint. Change this one constant, nowhere else, if it ever moves.
  // ------------------------------------------------------------------
  var ACT_MINT_ADDRESS = "7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG";
  var TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  var ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  // Solana's production network for Aretia: ACT itself is deployed here.
  // api.mainnet-beta.solana.com returns 403 for direct browser-origin
  // requests (confirmed elsewhere in this codebase); these two publicnode
  // endpoints are the same pair already relied on by the homepage's own
  // live-data cards.
  var RPC_ENDPOINTS = ["https://solana-rpc.publicnode.com", "https://solana.publicnode.com"];
  var LAST_WALLET_KEY = "aretia:lastWalletName";
  var CONNECT_TIMEOUT_MS = 30000;

  var STORAGE_AVAILABLE = (function () {
    try {
      var k = "__aretia_test__";
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false; // private browsing / storage disabled -- degrade to no persistence
    }
  })();

  // ------------------------------------------------------------------
  // Utilities (exported on window.AretiaWallet.utils for reuse/testing)
  // ------------------------------------------------------------------

  function shortenAddress(address, chars) {
    chars = chars || 4;
    if (!address || typeof address !== "string") return "";
    if (address.length <= chars * 2 + 1) return address;
    return address.slice(0, chars) + "…" + address.slice(-chars);
  }

  function isValidBase58Pubkey(address) {
    if (!address || typeof address !== "string") return false;
    if (!window.solanaWeb3 || !window.solanaWeb3.PublicKey) return false;
    try {
      var pk = new window.solanaWeb3.PublicKey(address);
      // PublicKey accepts some malformed input silently in older versions;
      // round-tripping through toBase58 catches anything that didn't
      // actually decode to a real 32-byte key.
      return pk.toBase58() === address || pk.toBuffer().length === 32;
    } catch (e) {
      return false;
    }
  }

  // Human, non-technical copy for every failure path this integration can
  // hit. Never surfaces err.stack, err.name, or a raw error class -- only
  // these fixed strings.
  function formatWalletError(err) {
    var msg = (err && (err.message || String(err))) || "";
    var lower = msg.toLowerCase();
    if (lower.indexOf("reject") !== -1 || lower.indexOf("denied") !== -1 || lower.indexOf("cancel") !== -1) {
      return "Wallet connection was cancelled.";
    }
    if (lower.indexOf("not installed") !== -1 || lower.indexOf("not found") !== -1) {
      return "That wallet isn't installed in this browser.";
    }
    if (lower.indexOf("timeout") !== -1 || lower.indexOf("timed out") !== -1) {
      return "The connection attempt timed out. Please try again.";
    }
    if (lower.indexOf("network") !== -1 || lower.indexOf("fetch") !== -1 || lower.indexOf("rpc") !== -1) {
      return "We couldn't reach the Solana network. Please try again.";
    }
    if (lower.indexOf("unsupported") !== -1) {
      return "That wallet doesn't support the connection method Aretia uses.";
    }
    if (lower.indexOf("no accounts") !== -1) {
      return "No account was returned by that wallet. Please try again.";
    }
    return "Something went wrong connecting your wallet. Please try again.";
  }

  // ------------------------------------------------------------------
  // Wallet Standard discovery -- the entire protocol, hand-rolled.
  // Spec: a wallet dispatches 'wallet-standard:register-wallet' on
  // window with a callback in event.detail; the app calls that callback
  // with { register(...wallets) }. Symmetrically, the app dispatches
  // 'wallet-standard:app-ready' with { register(...wallets) } in its own
  // detail, so wallets that already loaded before this script ran can
  // register retroactively.
  // ------------------------------------------------------------------
  function walletSupportsSolana(wallet) {
    if (!wallet.chains) return false;
    for (var i = 0; i < wallet.chains.length; i++) {
      if (String(wallet.chains[i]).indexOf("solana:") === 0) return true;
    }
    return false;
  }

  function discoverWallets(onChange) {
    var byName = new Map();

    function registerMany() {
      var wallets = Array.prototype.slice.call(arguments);
      var added = false;
      wallets.forEach(function (wallet) {
        if (!wallet || !wallet.name || !walletSupportsSolana(wallet)) return;
        if (!byName.has(wallet.name)) {
          byName.set(wallet.name, wallet);
          added = true;
        }
      });
      if (added) onChange(Array.from(byName.values()));
    }

    // 1. Wallets that announce themselves after we start listening.
    window.addEventListener("wallet-standard:register-wallet", function (event) {
      try {
        event.detail({ register: registerMany });
      } catch (e) {
        /* ignore a broken wallet extension, don't let it break discovery */
      }
    });

    // 2. Wallets already loaded before this script ran: announce
    //    readiness so they can register retroactively.
    try {
      window.dispatchEvent(
        new CustomEvent("wallet-standard:app-ready", { detail: { register: registerMany } })
      );
    } catch (e) {
      /* CustomEvent unsupported is not a realistic case in 2026, but don't throw */
    }

    return { getAll: function () { return Array.from(byName.values()); } };
  }

  // ------------------------------------------------------------------
  // Connection state machine
  // ------------------------------------------------------------------
  var state = {
    wallets: [],
    connectedWallet: null, // the Wallet Standard wallet object
    account: null, // { address, publicKey }
    connecting: false,
  };

  var listeners = [];
  function emit() {
    listeners.forEach(function (fn) {
      try { fn(state); } catch (e) { /* one bad subscriber shouldn't break the rest */ }
    });
  }

  var registry = discoverWallets(function (wallets) {
    state.wallets = wallets;
    emit();
    maybeRenderList();
  });

  var accountChangeUnsub = null;

  function withTimeout(promise, ms, timeoutMessage) {
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error(timeoutMessage || "timeout")); }, ms);
    });
    return Promise.race([promise, timeout]).finally(function () { clearTimeout(timer); });
  }

  function connectToWallet(wallet) {
    var connectFeature = wallet.features && wallet.features["standard:connect"];
    if (!connectFeature) {
      return Promise.reject(new Error("unsupported wallet"));
    }
    state.connecting = true;
    emit();
    return withTimeout(connectFeature.connect(), CONNECT_TIMEOUT_MS, "connection timed out")
      .then(function (result) {
        var accounts = result && result.accounts;
        if (!accounts || accounts.length === 0) throw new Error("no accounts returned");
        onConnected(wallet, accounts[0]);
        return accounts[0];
      })
      .finally(function () {
        state.connecting = false;
        emit();
      });
  }

  function tryEagerConnect(wallet) {
    var connectFeature = wallet.features && wallet.features["standard:connect"];
    if (!connectFeature) return Promise.resolve(null);
    return connectFeature
      .connect({ silent: true })
      .then(function (result) {
        var accounts = result && result.accounts;
        if (accounts && accounts.length > 0) {
          onConnected(wallet, accounts[0]);
          return accounts[0];
        }
        return null;
      })
      .catch(function () {
        return null; // silent means silent: no error surfaced, no prompt expected
      });
  }

  function onConnected(wallet, account) {
    state.connectedWallet = wallet;
    state.account = account;
    if (STORAGE_AVAILABLE) {
      try { window.localStorage.setItem(LAST_WALLET_KEY, wallet.name); } catch (e) {}
    }
    subscribeToWalletEvents(wallet);
    emit();
  }

  function subscribeToWalletEvents(wallet) {
    if (accountChangeUnsub) { try { accountChangeUnsub(); } catch (e) {} accountChangeUnsub = null; }
    var eventsFeature = wallet.features && wallet.features["standard:events"];
    if (!eventsFeature) return;
    try {
      accountChangeUnsub = eventsFeature.on("change", function (props) {
        if (!props) return;
        if (props.accounts) {
          if (props.accounts.length === 0) {
            disconnectWallet(); // wallet revoked access or user switched to an account we can't see
          } else if (state.account && props.accounts[0].address !== state.account.address) {
            state.account = props.accounts[0];
            emit();
          }
        }
      });
    } catch (e) { /* an events feature that throws on subscribe is not fatal */ }
  }

  function disconnectWallet() {
    var wallet = state.connectedWallet;
    var cleanup = Promise.resolve();
    if (wallet) {
      var disconnectFeature = wallet.features && wallet.features["standard:disconnect"];
      if (disconnectFeature) {
        cleanup = disconnectFeature.disconnect().catch(function () {
          /* if the wallet's own disconnect call fails, still clear our local state below */
        });
      }
    }
    return cleanup.finally(function () {
      if (accountChangeUnsub) { try { accountChangeUnsub(); } catch (e) {} accountChangeUnsub = null; }
      state.connectedWallet = null;
      state.account = null;
      if (STORAGE_AVAILABLE) {
        try { window.localStorage.removeItem(LAST_WALLET_KEY); } catch (e) {}
      }
      emit();
    });
  }

  // Attempt a silent reconnect to whichever wallet the user used last,
  // once, shortly after load (giving wallet extensions a moment to
  // announce themselves). Never shows a popup and never surfaces an
  // error if it fails -- a returning user who declines to reconnect (or
  // whose wallet no longer trusts this origin) just sees "Connect Wallet"
  // again, exactly as if nothing happened.
  function attemptEagerReconnect() {
    if (!STORAGE_AVAILABLE) return;
    var lastName;
    try { lastName = window.localStorage.getItem(LAST_WALLET_KEY); } catch (e) { return; }
    if (!lastName) return;
    setTimeout(function () {
      var match = state.wallets.filter(function (w) { return w.name === lastName; })[0];
      if (match) tryEagerConnect(match);
    }, 350);
  }

  // ------------------------------------------------------------------
  // Balance retrieval -- reuses window.solanaWeb3 (already loaded) and
  // the same manual Token-2022 ATA read the homepage's live-data cards
  // use, since ACT's mint is Token-2022, which getParsedTokenAccountsByOwner
  // does not reliably surface without the right program-id filter.
  // ------------------------------------------------------------------
  var mintIsValid = isValidBase58Pubkey(ACT_MINT_ADDRESS);
  var cachedConnection = null;

  function getConnection() {
    if (cachedConnection) return Promise.resolve(cachedConnection);
    var i = 0;
    function tryNext() {
      if (i >= RPC_ENDPOINTS.length) return Promise.reject(new Error("rpc unavailable"));
      var endpoint = RPC_ENDPOINTS[i++];
      var conn = new window.solanaWeb3.Connection(endpoint, "confirmed");
      return conn.getSlot().then(function () { cachedConnection = conn; return conn; }).catch(tryNext);
    }
    return tryNext();
  }

  function readU64LE(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
  }

  function findAta(owner, mint, tokenProgramId) {
    var seeds = [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()];
    return window.solanaWeb3.PublicKey.findProgramAddressSync(
      seeds,
      new window.solanaWeb3.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
    )[0];
  }

  function getSolBalance(address) {
    return getConnection().then(function (connection) {
      return connection.getBalance(new window.solanaWeb3.PublicKey(address), "confirmed");
    }).then(function (lamports) {
      return lamports / window.solanaWeb3.LAMPORTS_PER_SOL;
    });
  }

  function getActBalance(address) {
    if (!mintIsValid) return Promise.resolve(null); // "ACT balance unavailable", not a fabricated number
    return getConnection().then(function (connection) {
      var ata = findAta(
        new window.solanaWeb3.PublicKey(address),
        new window.solanaWeb3.PublicKey(ACT_MINT_ADDRESS),
        new window.solanaWeb3.PublicKey(TOKEN_2022_PROGRAM_ID)
      );
      return connection.getAccountInfo(ata, "confirmed");
    }).then(function (info) {
      if (!info) return 0; // no ATA yet == a real, honest zero balance
      return Number(readU64LE(new Uint8Array(info.data), 64)) / 1e9;
    });
  }

  // ==================================================================
  // UI layer
  // ==================================================================
  var els = {};
  var focusedBeforeModal = null;
  var listRenderPending = false;

  function maybeRenderList() {
    if (els.overlay && els.overlay.dataset.open === "true" && els.overlay.dataset.mode === "select") {
      renderWalletList();
    }
  }

  function buildDom(mount) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "aw-connect-btn";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.innerHTML =
      '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 7H5a2 2 0 0 1 0-4h12v4"/><path d="M3 7v11a2 2 0 0 0 2 2h16v-6"/><path d="M17 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/></svg>' +
      '<span class="aw-dot" aria-hidden="true"></span>' +
      '<span class="aw-spinner" aria-hidden="true"></span>' +
      '<span class="aw-label">Connect Wallet</span>';
    mount.appendChild(btn);

    var overlay = document.createElement("div");
    overlay.className = "aw-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="aw-sheet" role="dialog" aria-modal="true" aria-labelledby="aw-sheet-title">' +
      '  <div class="aw-sheet-header">' +
      '    <h2 class="aw-sheet-title" id="aw-sheet-title">Connect Wallet</h2>' +
      '    <button type="button" class="aw-sheet-close" aria-label="Close">×</button>' +
      "  </div>" +
      '  <div class="aw-sheet-body"></div>' +
      "</div>";
    document.body.appendChild(overlay);

    els.mount = mount;
    els.btn = btn;
    els.label = btn.querySelector(".aw-label");
    els.overlay = overlay;
    els.sheet = overlay.querySelector(".aw-sheet");
    els.sheetTitle = overlay.querySelector(".aw-sheet-title");
    els.sheetBody = overlay.querySelector(".aw-sheet-body");
    els.sheetClose = overlay.querySelector(".aw-sheet-close");

    btn.addEventListener("click", onConnectButtonClick);
    els.sheetClose.addEventListener("click", closeModal);
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && els.overlay.dataset.open === "true") closeModal();
      if (e.key === "Tab" && els.overlay.dataset.open === "true") trapFocus(e);
    });
  }

  function trapFocus(e) {
    var focusable = els.sheet.querySelectorAll(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function openModal(mode) {
    focusedBeforeModal = document.activeElement;
    els.overlay.hidden = false;
    els.overlay.dataset.mode = mode;
    // next frame so the transition actually runs
    requestAnimationFrame(function () {
      els.overlay.dataset.open = "true";
    });
    if (mode === "select") {
      els.sheetTitle.textContent = "Connect Wallet";
      renderWalletList();
    } else {
      els.sheetTitle.textContent = "Wallet";
      renderAccountPanel();
    }
    setTimeout(function () {
      var target = els.sheet.querySelector("[data-autofocus]") || els.sheetClose;
      if (target) target.focus();
    }, 50);
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    els.overlay.dataset.open = "false";
    document.body.style.overflow = "";
    setTimeout(function () {
      els.overlay.hidden = true;
      if (focusedBeforeModal && typeof focusedBeforeModal.focus === "function") {
        focusedBeforeModal.focus();
      }
    }, 200);
  }

  function onConnectButtonClick() {
    if (state.account) {
      openModal("account");
    } else {
      openModal("select");
    }
  }

  function walletIconSrc(wallet) {
    if (wallet.icon) return wallet.icon; // Wallet Standard wallets embed their own data-URI icon
    return "";
  }

  // Phantom is shown even when not yet detected, per product decision, so
  // it's never absent from the list -- but it is never shown as connected
  // or connectable unless Wallet Standard actually detects it. Clicking an
  // undetected entry only ever opens the install page; it never simulates
  // a connection. If Wallet Standard does detect Phantom, the real wallet
  // object below is used instead and this stub is skipped entirely.
  var KNOWN_WALLETS = [
    {
      name: "Phantom",
      installUrl: "https://phantom.app",
      icon:
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="128" fill="#4C3896"/><path d="M9 402.313C9 458.146 37.7123 471 67.5731 471C130.74 471 178.211 413.56 206.541 368.171C203.095 378.212 201.181 388.254 201.181 397.895C201.181 424.405 215.729 443.284 244.441 443.284C283.872 443.284 325.984 407.133 347.805 368.171C346.274 373.794 345.508 379.016 345.508 383.836C345.508 402.313 355.462 413.962 375.752 413.962C439.684 413.962 504 295.467 504 191.834C504 111.097 464.951 40 366.947 40C194.673 40 9 260.119 9 402.313ZM307.608 182.997C307.608 162.913 318.327 148.855 334.023 148.855C349.336 148.855 360.056 162.913 360.056 182.997C360.056 203.081 349.336 217.541 334.023 217.541C318.327 217.541 307.608 203.081 307.608 182.997ZM389.534 182.997C389.534 162.913 400.253 148.855 415.949 148.855C431.262 148.855 441.981 162.913 441.981 182.997C441.981 203.081 431.262 217.541 415.949 217.541C400.253 217.541 389.534 203.081 389.534 182.997Z" fill="#AB9FF2"/></svg>'
        ),
    },
  ];

  // Merges real Wallet-Standard detections with the always-shown known-wallet
  // stubs, real detections taking priority by name so a genuinely installed
  // Phantom is never shadowed by its own stub.
  function getDisplayWallets() {
    var detectedNames = {};
    var display = state.wallets.map(function (wallet) {
      detectedNames[wallet.name] = true;
      return { name: wallet.name, icon: walletIconSrc(wallet), installed: true, wallet: wallet };
    });
    KNOWN_WALLETS.forEach(function (known) {
      if (!detectedNames[known.name]) {
        display.push({ name: known.name, icon: known.icon, installed: false, installUrl: known.installUrl });
      }
    });
    return display;
  }

  function renderWalletList() {
    var wallets = getDisplayWallets();
    var VISIBLE = 4;
    var body = els.sheetBody;
    body.innerHTML = "";

    var sub = document.createElement("p");
    sub.className = "aw-sheet-sub";
    sub.textContent = "Choose a wallet to continue.";
    body.appendChild(sub);

    var errorBox = document.createElement("div");
    errorBox.className = "aw-error";
    errorBox.hidden = true;
    body.appendChild(errorBox);

    var anyInstalled = wallets.some(function (w) { return w.installed; });
    if (!anyInstalled) {
      var note = document.createElement("p");
      note.className = "aw-sheet-sub";
      note.style.marginTop = "-10px";
      note.textContent = "No Solana wallet was detected in this browser yet.";
      body.appendChild(note);
    }

    var list = document.createElement("ul");
    list.className = "aw-list";
    body.appendChild(list);

    var moreToggle = null;
    var extraWrap = null;

    wallets.forEach(function (display, index) {
      var li = document.createElement("li");
      var item = document.createElement("button");
      item.type = "button";
      item.className = "aw-item";
      if (index === 0) item.setAttribute("data-autofocus", "");
      var iconSrc = display.icon;
      item.innerHTML =
        (iconSrc ? '<img class="aw-item-icon" src="' + iconSrc + '" alt="" />' : '<span class="aw-item-icon" aria-hidden="true"></span>') +
        '<span class="aw-item-name">' + escapeHtml(display.name) + "</span>" +
        '<span class="aw-item-state">' + (display.installed ? "" : "Not installed") + '</span>' +
        '<span class="aw-item-chevron" aria-hidden="true">›</span>';
      if (display.installed) {
        item.addEventListener("click", function () {
          handleWalletSelect(display.wallet, item, errorBox);
        });
      } else {
        item.setAttribute("aria-label", display.name + " -- not installed, opens install page in a new tab");
        item.addEventListener("click", function () {
          window.open(display.installUrl, "_blank", "noopener");
        });
      }
      li.appendChild(item);

      if (index < VISIBLE) {
        list.appendChild(li);
      } else {
        if (!extraWrap) {
          extraWrap = document.createElement("ul");
          extraWrap.className = "aw-list";
          extraWrap.hidden = true;
          extraWrap.style.marginTop = "8px";
        }
        extraWrap.appendChild(li);
      }
    });

    if (extraWrap) {
      moreToggle = document.createElement("button");
      moreToggle.type = "button";
      moreToggle.className = "aw-more-toggle";
      moreToggle.textContent = "More wallets";
      moreToggle.addEventListener("click", function () {
        var willShow = extraWrap.hidden;
        extraWrap.hidden = !willShow;
        moreToggle.textContent = willShow ? "Show fewer wallets" : "More wallets";
      });
      body.appendChild(moreToggle);
      body.appendChild(extraWrap);
    }

    appendFoot(body);
  }

  function handleWalletSelect(wallet, itemEl, errorBox) {
    var stateEl = itemEl.querySelector(".aw-item-state");
    var allItems = els.sheetBody.querySelectorAll(".aw-item");
    allItems.forEach(function (el) { el.disabled = true; });
    if (stateEl) { stateEl.textContent = "Connecting…"; stateEl.dataset.connecting = "true"; }
    errorBox.hidden = true;

    connectToWallet(wallet)
      .then(function () {
        closeModal();
      })
      .catch(function (err) {
        allItems.forEach(function (el) { el.disabled = false; });
        if (stateEl) { stateEl.textContent = ""; stateEl.dataset.connecting = "false"; }
        errorBox.textContent = formatWalletError(err);
        errorBox.hidden = false;
      });
  }

  function appendFoot(body) {
    var foot = document.createElement("p");
    foot.className = "aw-foot";
    foot.textContent = "Connecting only shares your public address. Aretia will never ask for your seed phrase or private key, and never signs a transaction without your explicit approval.";
    body.appendChild(foot);
  }

  function renderAccountPanel() {
    var body = els.sheetBody;
    body.innerHTML = "";
    if (!state.account) { closeModal(); return; }

    var address = state.account.address;
    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<div class="aw-account-row">' +
      '  <span class="aw-account-label">Wallet</span>' +
      '  <span class="aw-account-value">' + escapeHtml(shortenAddress(address)) +
      '    <button type="button" class="aw-copy-btn" data-autofocus>Copy</button>' +
      "  </span>" +
      "</div>" +
      '<div class="aw-account-row">' +
      '  <span class="aw-account-label">ACT Balance</span>' +
      '  <span class="aw-account-value" data-loading="true" id="aw-act-balance">Loading…</span>' +
      "</div>" +
      '<div class="aw-account-row">' +
      '  <span class="aw-account-label">SOL Balance</span>' +
      '  <span class="aw-account-value" data-loading="true" id="aw-sol-balance">Loading…</span>' +
      "</div>" +
      '<div class="aw-account-actions">' +
      '  <a class="aw-account-link" href="https://solscan.io/account/' + encodeURIComponent(address) + '" target="_blank" rel="noopener">View on Solscan ↗</a>' +
      '  <button type="button" class="aw-disconnect-btn">Disconnect</button>' +
      "</div>";
    body.appendChild(wrap);

    wrap.querySelector(".aw-copy-btn").addEventListener("click", function (e) {
      var el = e.currentTarget;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(address).then(function () {
          var original = el.textContent;
          el.textContent = "Copied";
          setTimeout(function () { el.textContent = original; }, 1400);
        }).catch(function () {});
      }
    });

    var disconnectBtn = wrap.querySelector(".aw-disconnect-btn");
    disconnectBtn.addEventListener("click", function () {
      disconnectBtn.disabled = true;
      disconnectBtn.textContent = "Disconnecting…";
      disconnectWallet().then(closeModal);
    });

    var solEl = wrap.querySelector("#aw-sol-balance");
    var actEl = wrap.querySelector("#aw-act-balance");

    getSolBalance(address)
      .then(function (bal) {
        solEl.textContent = formatSol(bal) + " SOL";
        solEl.removeAttribute("data-loading");
      })
      .catch(function () {
        solEl.textContent = "Unavailable";
        solEl.removeAttribute("data-loading");
      });

    getActBalance(address)
      .then(function (bal) {
        if (bal === null) {
          actEl.textContent = "ACT balance unavailable";
        } else {
          actEl.textContent = formatAct(bal) + " ACT";
        }
        actEl.removeAttribute("data-loading");
      })
      .catch(function () {
        actEl.textContent = "ACT balance unavailable";
        actEl.removeAttribute("data-loading");
      });
  }

  function formatSol(n) {
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  function formatAct(n) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function updateButton() {
    if (!els.btn) return;
    if (state.connecting) {
      els.btn.dataset.loading = "true";
      els.label.textContent = "Connecting…";
      els.btn.disabled = true;
      return;
    }
    els.btn.disabled = false;
    els.btn.dataset.loading = "false";
    if (state.account) {
      els.btn.dataset.connected = "true";
      els.label.textContent = shortenAddress(state.account.address);
      els.btn.setAttribute("aria-label", "Wallet connected: " + state.account.address + ". Open account panel.");
    } else {
      els.btn.dataset.connected = "false";
      els.label.textContent = "Connect Wallet";
      els.btn.removeAttribute("aria-label");
    }
    // if the account panel is open and the account changed under us, re-render it
    if (els.overlay && els.overlay.dataset.open === "true" && els.overlay.dataset.mode === "account") {
      renderAccountPanel();
    }
    if (els.overlay && els.overlay.dataset.open === "true" && els.overlay.dataset.mode === "select" && state.account) {
      closeModal();
    }
  }

  listeners.push(updateButton);

  // ------------------------------------------------------------------
  // Public init -- one mount point per page (the nav). Safe to call
  // more than once; only the first mount element found is used.
  // ------------------------------------------------------------------
  function init() {
    var mount = document.querySelector("[data-aretia-wallet-mount]");
    if (!mount || els.mount) return;
    buildDom(mount);
    updateButton();
    attemptEagerReconnect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for reuse/testing, per the "create utilities, don't duplicate
  // logic" brief -- other pages/scripts can read connection state or
  // reuse the pure functions without re-implementing them.
  window.AretiaWallet = {
    init: init,
    getState: function () { return { account: state.account, connecting: state.connecting, wallets: state.wallets.map(function (w) { return w.name; }) }; },
    disconnect: disconnectWallet,
    utils: {
      shortenAddress: shortenAddress,
      formatWalletError: formatWalletError,
      isValidBase58Pubkey: isValidBase58Pubkey,
      getSolBalance: getSolBalance,
      getActBalance: getActBalance,
    },
    config: { ACT_MINT_ADDRESS: ACT_MINT_ADDRESS, mintIsValid: mintIsValid, network: "mainnet-beta" },
  };
})();
