/*!
 * Aretia Finance -- Connect Wallet
 * ---------------------------------------------------------------------
 * Wallet-agnostic Solana wallet connection using the Wallet Standard
 * discovery protocol (https://github.com/wallet-standard/wallet-standard),
 * implemented by hand rather than via @wallet-standard/app: the whole
 * protocol is two window CustomEvents, so pulling in a package (and a
 * bundler this static site doesn't have) to do it buys nothing.
 *
 * This module establishes a connection, reads public balances, and
 * exposes the connected wallet's own signing features to the Jupiter
 * Terminal swap widget already embedded on the homepage (see "Jupiter
 * Terminal passthrough" below) -- so a user who connects here can trade
 * without connecting a second time inside that widget. It never requests
 * a seed phrase or private key, never stores one, and never signs or
 * sends anything itself: every signature happens inside the wallet
 * extension's own popup, only when the user explicitly approves a swap
 * Jupiter's widget presents to them. Outside of that one bridge, every
 * wallet feature this file calls on its own is 'standard:connect',
 * 'standard:disconnect', and 'standard:events' -- account discovery and
 * lifecycle, nothing that moves funds.
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
  // Jupiter Terminal passthrough -- lets the swap widget already embedded
  // on the homepage (window.Jupiter, loaded from terminal.jup.ag) use this
  // SAME connection instead of asking the user to connect a second time
  // inside its own UI. This is the one place this file can produce a
  // signature: signTransaction/signAllTransactions/signMessage below are
  // wired to the wallet's own Wallet Standard signing features, but they
  // are only ever invoked by Jupiter's widget, and only at the moment a
  // user explicitly clicks "Swap" and approves the prompt in their own
  // wallet extension. Nothing here signs or sends anything on its own,
  // and nothing here ever touches a seed phrase or private key -- signing
  // happens inside the wallet extension, not in this file.
  // ------------------------------------------------------------------
  function getStandardFeature(name) {
    var wallet = state.connectedWallet;
    if (!wallet || !wallet.features) return null;
    return wallet.features[name] || null;
  }

  function toPublicKey() {
    if (!state.account || !window.solanaWeb3) return null;
    try { return new window.solanaWeb3.PublicKey(state.account.address); } catch (e) { return null; }
  }

  function isVersioned(tx) {
    return typeof tx.version !== "undefined";
  }

  function signTransactionShim(tx) {
    var feature = getStandardFeature("solana:signTransaction");
    if (!feature || !state.account) return Promise.reject(new Error("wallet does not support signing"));
    var bytes = isVersioned(tx) ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return feature
      .signTransaction({ transaction: new Uint8Array(bytes), account: state.account })
      .then(function (outputs) {
        var signed = outputs[0].signedTransaction;
        return isVersioned(tx) ? window.solanaWeb3.VersionedTransaction.deserialize(signed) : window.solanaWeb3.Transaction.from(signed);
      });
  }

  function signAllTransactionsShim(txs) {
    return Promise.all(txs.map(signTransactionShim));
  }

  function signMessageShim(message) {
    var feature = getStandardFeature("solana:signMessage");
    if (!feature || !state.account) return Promise.reject(new Error("wallet does not support signing"));
    return feature.signMessage({ message: message, account: state.account }).then(function (outputs) {
      return outputs[0].signature;
    });
  }

  function sendTransactionShim(tx, connection, options) {
    return signTransactionShim(tx).then(function (signed) {
      return connection.sendRawTransaction(signed.serialize(), options);
    });
  }

  function getWalletContextState() {
    var connected = !!state.account;
    return {
      autoConnect: false, // Aretia never auto-connects in a way that could surprise a returning user; see attemptEagerReconnect
      publicKey: toPublicKey(),
      wallet: state.connectedWallet ? { adapter: { name: state.connectedWallet.name } } : null,
      connected: connected,
      connecting: state.connecting,
      disconnecting: false,
      wallets: [],
      signIn: undefined,
      // Wallet selection is handled entirely by Aretia's own Connect Wallet
      // button; Jupiter's widget is configured (see index.html) to hide its
      // own connect UI via enableWalletPassthrough, so this is only called
      // if the widget falls back to it -- routing back to our own modal
      // rather than opening a second, redundant wallet picker.
      select: function () { onConnectButtonClick(); },
      connect: function () { onConnectButtonClick(); return Promise.resolve(); },
      disconnect: disconnectWallet,
      signTransaction: connected ? signTransactionShim : undefined,
      signAllTransactions: connected ? signAllTransactionsShim : undefined,
      signMessage: connected ? signMessageShim : undefined,
      sendTransaction: connected ? sendTransactionShim : undefined,
    };
  }

  function syncJupiterPassthrough() {
    if (window.Jupiter && typeof window.Jupiter.syncProps === "function") {
      try {
        window.Jupiter.syncProps({ passthroughWalletContextState: getWalletContextState() });
      } catch (e) {
        /* Jupiter Terminal not finished initializing yet, or rejected the shape -- not fatal */
      }
    }
  }
  listeners.push(syncJupiterPassthrough);

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
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiB2aWV3Qm94PSIwIDAgMTA4IDEwOCIgZmlsbD0ibm9uZSI+CjxyZWN0IHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiByeD0iMjYiIGZpbGw9IiNBQjlGRjIiLz4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik00Ni41MjY3IDY5LjkyMjlDNDIuMDA1NCA3Ni44NTA5IDM0LjQyOTIgODUuNjE4MiAyNC4zNDggODUuNjE4MkMxOS41ODI0IDg1LjYxODIgMTUgODMuNjU2MyAxNSA3NS4xMzQyQzE1IDUzLjQzMDUgNDQuNjMyNiAxOS44MzI3IDcyLjEyNjggMTkuODMyN0M4Ny43NjggMTkuODMyNyA5NCAzMC42ODQ2IDk0IDQzLjAwNzlDOTQgNTguODI1OCA4My43MzU1IDc2LjkxMjIgNzMuNTMyMSA3Ni45MTIyQzcwLjI5MzkgNzYuOTEyMiA2OC43MDUzIDc1LjEzNDIgNjguNzA1MyA3Mi4zMTRDNjguNzA1MyA3MS41NzgzIDY4LjgyNzUgNzAuNzgxMiA2OS4wNzE5IDY5LjkyMjlDNjUuNTg5MyA3NS44Njk5IDU4Ljg2ODUgODEuMzg3OCA1Mi41NzU0IDgxLjM4NzhDNDcuOTkzIDgxLjM4NzggNDUuNjcxMyA3OC41MDYzIDQ1LjY3MTMgNzQuNDU5OEM0NS42NzEzIDcyLjk4ODQgNDUuOTc2OCA3MS40NTU2IDQ2LjUyNjcgNjkuOTIyOVpNODMuNjc2MSA0Mi41Nzk0QzgzLjY3NjEgNDYuMTcwNCA4MS41NTc1IDQ3Ljk2NTggNzkuMTg3NSA0Ny45NjU4Qzc2Ljc4MTYgNDcuOTY1OCA3NC42OTg5IDQ2LjE3MDQgNzQuNjk4OSA0Mi41Nzk0Qzc0LjY5ODkgMzguOTg4NSA3Ni43ODE2IDM3LjE5MzEgNzkuMTg3NSAzNy4xOTMxQzgxLjU1NzUgMzcuMTkzMSA4My42NzYxIDM4Ljk4ODUgODMuNjc2MSA0Mi41Nzk0Wk03MC4yMTAzIDQyLjU3OTVDNzAuMjEwMyA0Ni4xNzA0IDY4LjA5MTYgNDcuOTY1OCA2NS43MjE2IDQ3Ljk2NThDNjMuMzE1NyA0Ny45NjU4IDYxLjIzMyA0Ni4xNzA0IDYxLjIzMyA0Mi41Nzk1QzYxLjIzMyAzOC45ODg1IDYzLjMxNTcgMzcuMTkzMSA2NS43MjE2IDM3LjE5MzFDNjguMDkxNiAzNy4xOTMxIDcwLjIxMDMgMzguOTg4NSA3MC4yMTAzIDQyLjU3OTVaIiBmaWxsPSIjRkZGREY4Ii8+Cjwvc3ZnPg==",
    },
    {
      name: "Solflare",
      installUrl: "https://solflare.com",
      icon: "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c3ZnIGlkPSJTIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MCA1MCI+PGRlZnM+PHN0eWxlPi5jbHMtMXtmaWxsOiMwMjA1MGE7c3Ryb2tlOiNmZmVmNDY7c3Ryb2tlLW1pdGVybGltaXQ6MTA7c3Ryb2tlLXdpZHRoOi41cHg7fS5jbHMtMntmaWxsOiNmZmVmNDY7fTwvc3R5bGU+PC9kZWZzPjxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMCIgd2lkdGg9IjUwIiBoZWlnaHQ9IjUwIiByeD0iMTIiIHJ5PSIxMiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTI0LjIzLDI2LjQybDIuNDYtMi4zOCw0LjU5LDEuNWMzLjAxLDEsNC41MSwyLjg0LDQuNTEsNS40MywwLDEuOTYtLjc1LDMuMjYtMi4yNSw0LjkzbC0uNDYuNS4xNy0xLjE3Yy42Ny00LjI2LS41OC02LjA5LTQuNzItNy40M2wtNC4zLTEuMzhoMFpNMTguMDUsMTEuODVsMTIuNTIsNC4xNy0yLjcxLDIuNTktNi41MS0yLjE3Yy0yLjI1LS43NS0zLjAxLTEuOTYtMy4zLTQuNTF2LS4wOGgwWk0xNy4zLDMzLjA2bDIuODQtMi43MSw1LjM0LDEuNzVjMi44LjkyLDMuNzYsMi4xMywzLjQ2LDUuMThsLTExLjY1LTQuMjJoMFpNMTMuNzEsMjAuOTVjMC0uNzkuNDItMS41NCwxLjEzLTIuMTcuNzUsMS4wOSwyLjA1LDIuMDUsNC4wOSwyLjcxbDQuNDIsMS40Ni0yLjQ2LDIuMzgtNC4zNC0xLjQyYy0yLS42Ny0yLjg0LTEuNjctMi44NC0yLjk2TTI2LjgyLDQyLjg3YzkuMTgtNi4wOSwxNC4xMS0xMC4yMywxNC4xMS0xNS4zMiwwLTMuMzgtMi01LjI2LTYuNDMtNi43MmwtMy4zNC0xLjEzLDkuMTQtOC43Ny0xLjg0LTEuOTYtMi43MSwyLjM4LTEyLjgxLTQuMjJjLTMuOTcsMS4yOS04Ljk3LDUuMDktOC45Nyw4Ljg5LDAsLjQyLjA0LjgzLjE3LDEuMjktMy4zLDEuODgtNC42MywzLjYzLTQuNjMsNS44LDAsMi4wNSwxLjA5LDQuMDksNC41NSw1LjIybDIuNzUuOTItOS41Miw5LjE0LDEuODQsMS45NiwyLjk2LTIuNzEsMTQuNzMsNS4yMmgwWiIvPjwvc3ZnPg==",
    },
    {
      name: "Coinbase Wallet",
      installUrl: "https://chrome.google.com/webstore/detail/coinbase-wallet-extension/hnfanknocfeofbddgcijnmhnfnkdnaad",
      icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAyNCIgaGVpZ2h0PSIxMDI0IiB2aWV3Qm94PSIwIDAgMTAyNCAxMDI0IiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgo8Y2lyY2xlIGN4PSI1MTIiIGN5PSI1MTIiIHI9IjUxMiIgZmlsbD0iIzAwNTJGRiIvPgo8cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGNsaXAtcnVsZT0iZXZlbm9kZCIgZD0iTTE1MiA1MTJDMTUyIDcxMC44MjMgMzEzLjE3NyA4NzIgNTEyIDg3MkM3MTAuODIzIDg3MiA4NzIgNzEwLjgyMyA4NzIgNTEyQzg3MiAzMTMuMTc3IDcxMC44MjMgMTUyIDUxMiAxNTJDMzEzLjE3NyAxNTIgMTUyIDMxMy4xNzcgMTUyIDUxMlpNNDIwIDM5NkM0MDYuNzQ1IDM5NiAzOTYgNDA2Ljc0NSAzOTYgNDIwVjYwNEMzOTYgNjE3LjI1NSA0MDYuNzQ1IDYyOCA0MjAgNjI4SDYwNEM2MTcuMjU1IDYyOCA2MjggNjE3LjI1NSA2MjggNjA0VjQyMEM2MjggNDA2Ljc0NSA2MTcuMjU1IDM5NiA2MDQgMzk2SDQyMFoiIGZpbGw9IndoaXRlIi8+Cjwvc3ZnPgo=",
    },
    {
      name: "Trust",
      installUrl: "https://trustwallet.com",
      icon: "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c3ZnIGlkPSJMYXllcl8xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB2aWV3Qm94PSIwIDAgMTkyMCAxMDgwIj48ZGVmcz48c3R5bGU+LmNscy0xe2ZpbGw6dXJsKCNsaW5lYXItZ3JhZGllbnQpO30uY2xzLTJ7ZmlsbDojMDUwMGZmO308L3N0eWxlPjxsaW5lYXJHcmFkaWVudCBpZD0ibGluZWFyLWdyYWRpZW50IiB4MT0iMTEyMy4yNiIgeTE9IjE4NjUuNzgiIHgyPSI5NTQuNjEiIHkyPSIxMzM3LjUiIGdyYWRpZW50VHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCAyMTgyKSBzY2FsZSgxIC0xKSIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIG9mZnNldD0iLjAyIiBzdG9wLWNvbG9yPSJibHVlIi8+PHN0b3Agb2Zmc2V0PSIuMDgiIHN0b3AtY29sb3I9IiMwMDk0ZmYiLz48c3RvcCBvZmZzZXQ9Ii4xNiIgc3RvcC1jb2xvcj0iIzQ4ZmY5MSIvPjxzdG9wIG9mZnNldD0iLjQyIiBzdG9wLWNvbG9yPSIjMDA5NGZmIi8+PHN0b3Agb2Zmc2V0PSIuNjgiIHN0b3AtY29sb3I9IiMwMDM4ZmYiLz48c3RvcCBvZmZzZXQ9Ii45IiBzdG9wLWNvbG9yPSIjMDUwMGZmIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHBhdGggY2xhc3M9ImNscy0yIiBkPSJtNzM4LjcxLDQyMy40MWwyMjEuNDUtNzIuM3Y1MDAuNTJjLTE1OC4xOC02Ni43NC0yMjEuNDUtMTk0LjY1LTIyMS40NS0yNjYuOTR2LTE2MS4yOFoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Im0xMTgxLjYyLDQyMy40MWwtMjIxLjQ1LTcyLjN2NTAwLjUyYzE1OC4xOC02Ni43NCwyMjEuNDUtMTk0LjY1LDIyMS40NS0yNjYuOTR2LTE2MS4yOFoiLz48cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Im04MjUuOTEsMjMwLjg1aDMwLjl2MTcuMzFjMTAuMTMtMTUuNTYsMjEuNzgtMTcuMzEsMzguODQtMTcuMzF2MzAuNmgtNy43N2MtMjAuNDQsMC0zMC4yMyw5LjYyLTMwLjIzLDI4LjY3djMyLjUyaC0zMS43NXYtOTEuNzlaIi8+PHBhdGggY2xhc3M9ImNscy0yIiBkPSJtOTk4Ljc4LDMyMi42M2gtMzEuNzV2LTguNzVjLTYuOTMsOC4wNS0xNi4zOCwxMS41NC0yOC4wMywxMS41NC0yMi4xMiwwLTM0LjYyLTEzLjExLTM0LjYyLTM3LjI0di01Ny4zNGgzMS43NXY1MC4xOGMwLDExLjM2LDUuNTcsMTgsMTUuMDIsMThzMTUuODgtNi40NywxNS44OC0xNy40OHYtNTAuN2gzMS43NXY5MS43OVoiLz48cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Im0xMDA2LjU0LDI5NC4zaDI5LjczYzEuMzYsNi42NCw1LjkxLDkuNDMsMTYuODgsOS40Myw4Ljk1LDAsMTQuMTktMi4wOSwxNC4xOS01Ljk0LDAtMi45OC0yLjU0LTQuOS05Ljc5LTYuNDdsLTIzLjk4LTUuNDJjLTE2LjA0LTMuNjYtMjQuMTUtMTIuOTMtMjQuMTUtMjcuOCwwLTE5LjU5LDE0LjM1LTI5LjczLDQyLjIxLTI5LjczczQxLjU0LDkuODgsNDMuOTEsMzEuMDRoLTI5LjU1Yy0uNS01LjU5LTYuMjUtOS4wMS0xNS43LTkuMDEtNy41OSwwLTEyLjQ5LDIuNDQtMTIuNDksNi4xMiwwLDMuMTQsMy4yLDUuNTksOS42Myw3LjE4bDI1LjE2LDYuMTJjMTYuNTQsNC4wMSwyNC40OSwxMi40MSwyNC40OSwyNi4wNSwwLDE4Ljg5LTE2LjM4LDMwLjA4LTQ0LjIzLDMwLjA4cy00Ni4yNy0xMi4wNi00Ni4yNy0zMS42NWgtLjAzWiIvPjxwYXRoIGNsYXNzPSJjbHMtMiIgZD0ibTExODEuNjIsMjU5LjR2LTI4LjU1aC03OC4zNXYyOC41NmgyMy4zOHY2My4yMmgzMS41OHYtNjMuMjRoMjMuMzlaIi8+PHBhdGggY2xhc3M9ImNscy0yIiBkPSJtODE3LjA4LDI1OS40di0yOC41NWgtNzguMzV2MjguNTZoMjMuMzh2NjMuMjJoMzEuNTh2LTYzLjI0aDIzLjM4WiIvPjwvc3ZnPg==",
    },
    {
      name: "Ledger",
      bg: "#000",
      installUrl: "https://ledger.com",
      icon: "data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMzUgMzUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGcgZmlsbD0iI2ZmZiI+PHBhdGggZD0ibTIzLjU4OCAwaC0xNnYyMS41ODNoMjEuNnYtMTZhNS41ODUgNS41ODUgMCAwIDAgLTUuNi01LjU4M3oiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDUuNzM5KSIvPjxwYXRoIGQ9Im04LjM0MiAwaC0yLjc1N2E1LjU4NSA1LjU4NSAwIDAgMCAtNS41ODUgNS41ODV2Mi43NTdoOC4zNDJ6Ii8+PHBhdGggZD0ibTAgNy41OWg4LjM0MnY4LjM0MmgtOC4zNDJ6IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwIDUuNzM5KSIvPjxwYXRoIGQ9Im0xNS4xOCAyMy40NTFoMi43NTdhNS41ODUgNS41ODUgMCAwIDAgNS41ODUtNS42di0yLjY3MWgtOC4zNDJ6IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMS40NzggMTEuNDc4KSIvPjxwYXRoIGQ9Im03LjU5IDE1LjE4aDguMzQydjguMzQyaC04LjM0MnoiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDUuNzM5IDExLjQ3OCkiLz48cGF0aCBkPSJtMCAxNS4xOHYyLjc1N2E1LjU4NSA1LjU4NSAwIDAgMCA1LjU4NSA1LjU4NWgyLjc1N3YtOC4zNDJ6IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwIDExLjQ3OCkiLz48L2c+PC9zdmc+",
    },
    {
      name: "Torus",
      installUrl: "https://tor.us",
      icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzMiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMyAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTYuNSIgY3k9IjE2IiByPSIxNiIgZmlsbD0iIzAzNjRGRiIvPgo8cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGNsaXAtcnVsZT0iZXZlbm9kZCIgZD0iTTExLjIxODYgOS40OTIxOUMxMC40NTM5IDkuNDkyMTkgOS44MzM5OCAxMC4xMTIxIDkuODMzOTggMTAuODc2OFYxMi40ODk4QzkuODMzOTggMTMuMjU0NSAxMC40NTM5IDEzLjg3NDQgMTEuMjE4NiAxMy44NzQ0SDEzLjY2ODRWMjIuODk3NkMxMy42Njg0IDIzLjY2MjMgMTQuMjg4MyAyNC4yODIyIDE1LjA1MyAyNC4yODIySDE2LjY2NkMxNy40MzA3IDI0LjI4MjIgMTguMDUwNiAyMy42NjIzIDE4LjA1MDYgMjIuODk3NlYxMi41MDE1QzE4LjA1MDYgMTIuNDk3NiAxOC4wNTA2IDEyLjQ5MzcgMTguMDUwNiAxMi40ODk4VjEwLjg3NjhDMTguMDUwNiAxMC4xMTIxIDE3LjQzMDcgOS40OTIxOSAxNi42NjYgOS40OTIxOUgxNS4wNTNIMTEuMjE4NloiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0yMS4zMzc2IDEzLjg3NDRDMjIuNTQ3NyAxMy44NzQ0IDIzLjUyODcgMTIuODkzNCAyMy41Mjg3IDExLjY4MzNDMjMuNTI4NyAxMC40NzMyIDIyLjU0NzcgOS40OTIxOSAyMS4zMzc2IDkuNDkyMTlDMjAuMTI3NSA5LjQ5MjE5IDE5LjE0NjUgMTAuNDczMiAxOS4xNDY1IDExLjY4MzNDMTkuMTQ2NSAxMi44OTM0IDIwLjEyNzUgMTMuODc0NCAyMS4zMzc2IDEzLjg3NDRaIiBmaWxsPSJ3aGl0ZSIvPgo8L3N2Zz4K",
    },
    {
      name: "Coin98",
      installUrl: "https://coin98.com",
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3NiA3NSI+CiAgPGRlZnM+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIxMDEuNjgxJSIgeDI9Ii0xLjU1NyUiIHkxPSIxNS4yNjglIiB5Mj0iODQuOTE3JSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNGMUQ5NjEiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjQ0RBMTQ2Ii8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogIDwvZGVmcz4KICA8ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPgogICAgPHJlY3Qgd2lkdGg9Ijc1IiBoZWlnaHQ9Ijc1IiBmaWxsPSIjMDAwIiByeD0iMTYiLz4KICAgIDxwYXRoIGZpbGw9InVybCgjYSkiIGZpbGwtcnVsZT0ibm9uemVybyIgZD0iTTYxLjQ0IDBhMTMuNzE0IDEzLjcxNCAwIDAgMSA5LjY4IDQuMDEgMTMuNjYxIDEzLjY2MSAwIDAgMSA0LjAwOCA5LjY2OHY0Ny42NDZhMTMuNjYgMTMuNjYgMCAwIDEtNC4wMDcgOS42NjZBMTMuNzEzIDEzLjcxMyAwIDAgMSA2MS40NCA3NUgxMy42ODZhMTMuNzEzIDEzLjcxMyAwIDAgMS05LjY4LTQuMDFBMTMuNjYgMTMuNjYgMCAwIDEgMCA2MS4zMjRWMTMuNjc4YzAtMy42MjUgMS40NC03LjEwMiA0LjAwNy05LjY2N0ExMy43MTQgMTMuNzE0IDAgMCAxIDEzLjY4NyAwWk0yMC4wNjMgNDYuMjMxaC00LjgyNWExMC4wMzIgMTAuMDMyIDAgMCAwIDIuOTQ2IDcuMDg2IDEwLjA3IDEwLjA3IDAgMCAwIDcuMSAyLjk0MiAxMC4wNjUgMTAuMDY1IDAgMCAwIDcuMTA4LTIuOTM1IDEwLjAzIDEwLjAzIDAgMCAwIDIuOTQ2LTcuMDkzaC00LjgyNGE1LjIwNyA1LjIwNyAwIDAgMS0xLjUzIDMuNjg4IDUuMjI1IDUuMjI1IDAgMCAxLTMuNjk2IDEuNTI4IDUuMjM0IDUuMjM0IDAgMCAxLTMuNjk1LTEuNTI4IDUuMjEzIDUuMjEzIDAgMCAxLTEuNTMtMy42ODhaTTU0LjMzIDMzLjcxNmExMS43NjMgMTEuNzYzIDAgMCAwLTEyLjc5OSAyLjUzOEExMS42OTcgMTEuNjk3IDAgMCAwIDM4Ljk5IDQ5LjAzYTExLjcyMyAxMS43MjMgMCAwIDAgNC4zMjggNS4yNTkgMTEuNzU3IDExLjc1NyAwIDAgMCA2LjUyNiAxLjk3IDExLjc2NiAxMS43NjYgMCAwIDAgOC4yOS0zLjQzNSAxMS43MiAxMS43MiAwIDAgMCAzLjQ0Mi04LjI3NCAxMS43MDIgMTEuNzAyIDAgMCAwLTEuOTc1LTYuNTE0IDExLjczNiAxMS43MzYgMCAwIDAtNS4yNjktNC4zMlptLTQuNDg4IDMuOTJhNi45MzcgNi45MzcgMCAwIDEgNC45IDIuMDI1IDYuOTEgNi45MSAwIDAgMSAyLjAyOCA0Ljg5MiA2Ljg5NyA2Ljg5NyAwIDAgMS0xLjE3IDMuODM0IDYuOTMyIDYuOTMyIDAgMCAxLTEwLjY0MyAxLjA0MiA2LjkwMiA2LjkwMiAwIDAgMS0xLjUtNy41MjIgNi45MDkgNi45MDkgMCAwIDEgMi41NDQtMy4xIDYuOTI4IDYuOTI4IDAgMCAxIDMuODQxLTEuMTY3Wm0uMTcgNC41NTJhMi40MzEgMi40MzEgMCAwIDAtMi4yNDEgMS4xNTQgMi40MTggMi40MTggMCAwIDAtLjM1NiAxLjI1NyAyLjM5NSAyLjM5NSAwIDAgMCAxLjYxOSAyLjI5djEuNzUzaDEuNjE4di0xLjc1NGEyLjQyNyAyLjQyNyAwIDAgMCAxLjU5NC0xLjk1IDIuNDE4IDIuNDE4IDAgMCAwLTEtMi4zMSAyLjQzMSAyLjQzMSAwIDAgMC0xLjIzNC0uNDRabS0yMC4yMi0yMi41NTJhMTEuNzYyIDExLjc2MiAwIDAgMC0xMi43OTYgMi41MzEgMTEuNjk3IDExLjY5NyAwIDAgMC0yLjU1NCAxMi43NjkgMTEuNzIzIDExLjcyMyAwIDAgMCA0LjMyIDUuMjYyIDExLjc1NyAxMS43NTcgMCAwIDAgMTQuODI1LTEuNDQ2IDExLjcxNyAxMS43MTcgMCAwIDAgMy40NDUtOC4yODQgMTEuNzAzIDExLjcwMyAwIDAgMC0xLjk3NC02LjUxMiAxMS43MzYgMTEuNzM2IDAgMCAwLTUuMjY2LTQuMzJabS00LjUxIDMuOTE3YTYuOTQ1IDYuOTQ1IDAgMCAxIDQuODk3IDIuMDI5IDYuOTE4IDYuOTE4IDAgMCAxIDIuMDMyIDQuODg2IDYuOTA2IDYuOTA2IDAgMCAxLTEuMTY4IDMuODQyIDYuOTQgNi45NCAwIDAgMS0xMC42NiAxLjA0OCA2LjkxMSA2LjkxMSAwIDAgMS0xLjUtNy41MzYgNi45MTggNi45MTggMCAwIDEgMi41NS0zLjEwMyA2LjkzNyA2LjkzNyAwIDAgMSAzLjg1LTEuMTY2Wm0yNC41Ni00LjgxYTEwLjA1OSAxMC4wNTkgMCAwIDAtNy4xMDMgMi45NCAxMC4wMiAxMC4wMiAwIDAgMC0yLjk0IDcuMDkgOS45IDkuOSAwIDAgMCAxLjIzIDQuNzk1IDEzLjU3NSAxMy41NzUgMCAwIDEgNC4yMTQtMi4zMjIgNS4wODIgNS4wODIgMCAwIDEtLjYyNS0yLjQ3NyA1LjIwNiA1LjIwNiAwIDAgMSAxLjUwMy0zLjczNiA1LjIyMyA1LjIyMyAwIDAgMSAzLjcyMi0xLjU1NCA1LjIzNCA1LjIzNCAwIDAgMSAzLjcyIDEuNTU0IDUuMjEzIDUuMjEzIDAgMCAxIDEuNTA1IDMuNzM2IDUuMjc5IDUuMjc5IDAgMCAxLS42MjMgMi40NzMgMTMuNTc0IDEzLjU3NCAwIDAgMSA0LjIxMyAyLjMyMiA5LjkwMyA5LjkwMyAwIDAgMCAxLjIzLTQuNzk1IDEwLjAzMiAxMC4wMzIgMCAwIDAtMi45NDYtNy4wODYgMTAuMDcgMTAuMDcgMCAwIDAtNy4xLTIuOTRabS0yMy43NSA3Ljk5aC0xLjYxN3YxLjc1YTIuNDE5IDIuNDE5IDAgMCAwLTEuNTgyIDIuNjg3IDIuNDE0IDIuNDE0IDAgMCAwIDIuMzkgMi4wMDYgMi40NSAyLjQ1IDAgMCAwIDEuNTU1LS41NzQgMi40MTQgMi40MTQgMCAwIDAtLjc0Ni00LjExOXYtMS43NVoiLz4KICA8L2c+Cjwvc3ZnPgo=",
    },
    {
      name: "TokenPocket",
      installUrl: "https://tokenpocket.pro",
      icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTIwIiBoZWlnaHQ9IjEyMCIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGc+CjxwYXRoIGQ9Ik0xMDQxLjUyIDBILTI3VjEwMjRIMTA0MS41MlYwWiIgZmlsbD0iIzI5ODBGRSIvPgo8ZyBjbGlwLXBhdGg9InVybCgjY2xpcDBfNDA4XzIyNSkiPgo8cGF0aCBkPSJNNDA2Ljc5NiA0MzguNjQzSDQwNi45MjdDNDA2Ljc5NiA0MzcuODU3IDQwNi43OTYgNDM2Ljk0IDQwNi43OTYgNDM2LjE1NFY0MzguNjQzWiIgZmlsbD0iIzI5QUVGRiIvPgo8cGF0aCBkPSJNNjY3LjYwMiA0NjMuNTMzSDUyMy4yNDlWNzI0LjA3NkM1MjMuMjQ5IDczNi4zODkgNTMzLjIwNCA3NDYuMzQ1IDU0NS41MTcgNzQ2LjM0NUg2NDUuMzMzQzY1Ny42NDcgNzQ2LjM0NSA2NjcuNjAyIDczNi4zODkgNjY3LjYwMiA3MjQuMDc2VjQ2My41MzNaIiBmaWxsPSJ3aGl0ZSIvPgo8cGF0aCBkPSJNNDUzLjU2MyAyNzdINDQ4LjcxNkgxOTAuMjY5QzE3Ny45NTUgMjc3IDE2OCAyODYuOTU1IDE2OCAyOTkuMjY5VjM4OS42NTNDMTY4IDQwMS45NjcgMTc3Ljk1NSA0MTEuOTIyIDE5MC4yNjkgNDExLjkyMkgyNTAuOTE4SDI3NS4wMjFWNDM4LjY0NFY3MjQuNzMxQzI3NS4wMjEgNzM3LjA0NSAyODQuOTc2IDc0NyAyOTcuMjg5IDc0N0gzOTIuMTI4QzQwNC40NDEgNzQ3IDQxNC4zOTYgNzM3LjA0NSA0MTQuMzk2IDcyNC43MzFWNDM4LjY0NFY0MzYuMTU2VjQxMS45MjJINDM4LjQ5OUg0NDguMzIzSDQ1My4xN0M0OTAuMzcyIDQxMS45MjIgNTIwLjYzMSAzODEuNjYzIDUyMC42MzEgMzQ0LjQ2MUM1MjEuMDI0IDMwNy4yNTkgNDkwLjc2NSAyNzcgNDUzLjU2MyAyNzdaIiBmaWxsPSJ3aGl0ZSIvPgo8cGF0aCBkPSJNNjY3LjczNSA0NjMuNTMzVjY0NS4zNUM2NzIuNzEzIDY0Ni41MjkgNjc3LjgyMSA2NDcuNDQ2IDY4My4wNjEgNjQ4LjIzMkM2OTAuMzk3IDY0OS4yOCA2OTcuOTk0IDY0OS45MzUgNzA1LjU5MiA2NTAuMDY2QzcwNS45ODUgNjUwLjA2NiA3MDYuMzc4IDY1MC4wNjYgNzA2LjkwMiA2NTAuMDY2VjUwNS40NUM2ODUuMDI2IDUwNC4wMDkgNjY3LjczNSA0ODUuODAxIDY2Ny43MzUgNDYzLjUzM1oiIGZpbGw9InVybCgjcGFpbnQwX2xpbmVhcl80MDhfMjI1KSIvPgo8cGF0aCBkPSJNNzA5Ljc4MSAyNzdDNjA2LjgyMiAyNzcgNTIzLjI0OSAzNjAuNTczIDUyMy4yNDkgNDYzLjUzM0M1MjMuMjQ5IDU1Mi4wODQgNTg0Ljk0NiA2MjYuMjI1IDY2Ny43MzMgNjQ1LjM1VjQ2My41MzNDNjY3LjczMyA0NDAuMzQ3IDY4Ni41OTYgNDIxLjQ4NCA3MDkuNzgxIDQyMS40ODRDNzMyLjk2NyA0MjEuNDg0IDc1MS44MyA0NDAuMzQ3IDc1MS44MyA0NjMuNTMzQzc1MS44MyA0ODMuMDUxIDczOC42IDQ5OS40MjUgNzIwLjUyMyA1MDQuMTRDNzE3LjExNyA1MDUuMDU3IDcxMy40NDkgNTA1LjU4MSA3MDkuNzgxIDUwNS41ODFWNjUwLjA2NkM3MTMuNDQ5IDY1MC4wNjYgNzE2Ljk4NiA2NDkuOTM1IDcyMC41MjMgNjQ5LjgwNEM4MTguNTA1IDY0NC4xNzEgODk2LjMxNCA1NjIuOTU2IDg5Ni4zMTQgNDYzLjUzM0M4OTYuNDQ1IDM2MC41NzMgODEyLjg3MiAyNzcgNzA5Ljc4MSAyNzdaIiBmaWxsPSJ3aGl0ZSIvPgo8cGF0aCBkPSJNNzA5Ljc4IDY1MC4wNjZWNTA1LjU4MUM3MDguNzMzIDUwNS41ODEgNzA3LjgxNiA1MDUuNTgxIDcwNi43NjggNTA1LjQ1VjY1MC4wNjZDNzA3LjgxNiA2NTAuMDY2IDcwOC44NjQgNjUwLjA2NiA3MDkuNzggNjUwLjA2NloiIGZpbGw9IndoaXRlIi8+CjwvZz4KPC9nPgo8ZGVmcz4KPGxpbmVhckdyYWRpZW50IGlkPSJwYWludDBfbGluZWFyXzQwOF8yMjUiIHgxPSI3MDkuODQ0IiB5MT0iNTU2LjgyNyIgeDI9IjY2Ny43NTMiIHkyPSI1NTYuODI3IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CjxzdG9wIHN0b3AtY29sb3I9IndoaXRlIi8+CjxzdG9wIG9mZnNldD0iMC45NjY3IiBzdG9wLWNvbG9yPSJ3aGl0ZSIgc3RvcC1vcGFjaXR5PSIwLjMyMzMiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSJ3aGl0ZSIgc3RvcC1vcGFjaXR5PSIwLjMiLz4KPC9saW5lYXJHcmFkaWVudD4KPGNsaXBQYXRoIGlkPSJjbGlwMF80MDhfMjI1Ij4KPHJlY3Qgd2lkdGg9IjcyOC40NDgiIGhlaWdodD0iNDcwIiBmaWxsPSJ3aGl0ZSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTY4IDI3NykiLz4KPC9jbGlwUGF0aD4KPC9kZWZzPgo8L3N2Zz4K",
    },
    {
      name: "MathWallet",
      bg: "#000",
      installUrl: "https://mathwallet.org",
      icon: "data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjEyOCIgdmlld0JveD0iMCAwIDEyOCAxMjgiIHdpZHRoPSIxMjgiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGcgZmlsbD0iI2ZmZiIgZmlsbC1ydWxlPSJldmVub2RkIj48cGF0aCBkPSJtMCAwaDEyOHYxMjhoLTEyOHoiIG9wYWNpdHk9IjAiLz48cGF0aCBkPSJtOTAuODQ3MDA4NiA1Ny43NjEwMDIzYy0yLjI3NzAzNjMtMi4yNzcwMzYzLTIuMjc3MDM2My01Ljk2ODg0MTYgMC04LjI0NTg3NzggMi4yNzcwMzYyLTIuMjc3MDM2MyA1Ljk2ODg0MTUtMi4yNzcwMzYzIDguMjQ1ODc3OCAwIDIuMjc3MDM2NiAyLjI3NzAzNjIgMi4yNzcwMzY2IDUuOTY4ODQxNSAwIDguMjQ1ODc3OC0yLjI3NzAzNjMgMi4yNzcwMzYyLTUuOTY4ODQxNiAyLjI3NzAzNjItOC4yNDU4Nzc4IDB6bS0xOS41ODM5NTk4IDE5LjU4Mzk1OTdjLTEuNzA3Nzc3Mi0xLjcwNzc3NzItMS43MDc3NzcyLTQuNDc2NjMxMSAwLTYuMTg0NDA4M3M0LjQ3NjYzMTEtMS43MDc3NzcyIDYuMTg0NDA4MyAwIDEuNzA3Nzc3MiA0LjQ3NjYzMTEgMCA2LjE4NDQwODMtNC40NzY2MzExIDEuNzA3Nzc3Mi02LjE4NDQwODMgMHptMzAuOTIyMDQyMi0xMC4zMDczNDcyYy0xLjcwNzc3OC0xLjcwNzc3NzItMS43MDc3NzgtNC40NzY2MzEyIDAtNi4xODQ0MDg0IDEuNzA3Nzc3LTEuNzA3Nzc3MiA0LjQ3NjYzMS0xLjcwNzc3NzIgNi4xODQ0MDggMHMxLjcwNzc3NyA0LjQ3NjYzMTIgMCA2LjE4NDQwODQtNC40NzY2MzEgMS43MDc3NzcyLTYuMTg0NDA4IDB6bS0xMC4zMDczNDc3IDEwLjMwNzM0NzJjLTEuNzA3Nzc3Mi0xLjcwNzc3NzItMS43MDc3NzcyLTQuNDc2NjMxMSAwLTYuMTg0NDA4M3M0LjQ3NjYzMTEtMS43MDc3NzcyIDYuMTg0NDA4MyAwIDEuNzA3Nzc3MiA0LjQ3NjYzMTEgMCA2LjE4NDQwODMtNC40NzY2MzExIDEuNzA3Nzc3Mi02LjE4NDQwODMgMHptMjEuNjQ1NDI4Ny0xLjAzMDczNDdjLTEuMTM4NTE4LTEuMTM4NTE4MS0xLjEzODUxOC0yLjk4NDQyMDggMC00LjEyMjkzODkgMS4xMzg1MTktMS4xMzg1MTgxIDIuOTg0NDIxLTEuMTM4NTE4MSA0LjEyMjkzOSAwIDEuMTM4NTE5IDEuMTM4NTE4MSAxLjEzODUxOSAyLjk4NDQyMDggMCA0LjEyMjkzODktMS4xMzg1MTggMS4xMzg1MTgxLTIuOTg0NDIgMS4xMzg1MTgxLTQuMTIyOTM5IDB6bS0xMC4zMDczNDcgMTAuMzA3MzQ3MmMtMS4xMzg1MTgtMS4xMzg1MTgxLTEuMTM4NTE4LTIuOTg0NDIwNyAwLTQuMTIyOTM4OSAxLjEzODUxOC0xLjEzODUxODEgMi45ODQ0MjEtMS4xMzg1MTgxIDQuMTIyOTM5IDAgMS4xMzg1MTggMS4xMzg1MTgyIDEuMTM4NTE4IDIuOTg0NDIwOCAwIDQuMTIyOTM4OS0xLjEzODUxOCAxLjEzODUxODItMi45ODQ0MjEgMS4xMzg1MTgyLTQuMTIyOTM5IDB6bS0yMi42NzYxNjM3LTE4LjU1MzIyNWMtMi4yNzcwMzYzLTIuMjc3MDM2My0yLjI3NzAzNjMtNS45Njg4NDE1IDAtOC4yNDU4Nzc4czUuOTY4ODQxNS0yLjI3NzAzNjMgOC4yNDU4Nzc4IDAgMi4yNzcwMzYzIDUuOTY4ODQxNSAwIDguMjQ1ODc3OC01Ljk2ODg0MTUgMi4yNzcwMzYzLTguMjQ1ODc3OCAwem0wLTIwLjYxNDY5NDVjLTIuMjc3MDM2My0yLjI3NzAzNjMtMi4yNzcwMzYzLTUuOTY4ODQxNSAwLTguMjQ1ODc3OHM1Ljk2ODg0MTUtMi4yNzcwMzYzIDguMjQ1ODc3OCAwIDIuMjc3MDM2MyA1Ljk2ODg0MTUgMCA4LjI0NTg3NzgtNS45Njg4NDE1IDIuMjc3MDM2My04LjI0NTg3NzggMHptLTEwLjMwNzM0NzIgMTAuMzA3MzQ3M2MtMi4yNzcwMzYzLTIuMjc3MDM2My0yLjI3NzAzNjMtNS45Njg4NDE2IDAtOC4yNDU4Nzc4IDIuMjc3MDM2Mi0yLjI3NzAzNjMgNS45Njg4NDE1LTIuMjc3MDM2MyA4LjI0NTg3NzggMCAyLjI3NzAzNjIgMi4yNzcwMzYyIDIuMjc3MDM2MiA1Ljk2ODg0MTUgMCA4LjI0NTg3NzgtMi4yNzcwMzYzIDIuMjc3MDM2Mi01Ljk2ODg0MTYgMi4yNzcwMzYyLTguMjQ1ODc3OCAwem0tMjAuNzEwNTA2IDBjLTIuMjc3MDM2Mi0yLjI3NzAzNjMtMi4yNzcwMzYyLTUuOTY4ODQxNiAwLTguMjQ1ODc3OCAyLjI3NzAzNjMtMi4yNzcwMzYzIDUuOTY4ODQxNi0yLjI3NzAzNjMgOC4yNDU4Nzc4IDAgMi4yNzcwMzYzIDIuMjc3MDM2MiAyLjI3NzAzNjMgNS45Njg4NDE1IDAgOC4yNDU4Nzc4LTIuMjc3MDM2MiAyLjI3NzAzNjItNS45Njg4NDE1IDIuMjc3MDM2Mi04LjI0NTg3NzggMHptLTE5LjU4Mzk1OTcgMTkuNTgzOTU5N2MtMS43MDc3NzcyLTEuNzA3Nzc3Mi0xLjcwNzc3NzItNC40NzY2MzExIDAtNi4xODQ0MDgzczQuNDc2NjMxMS0xLjcwNzc3NzIgNi4xODQ0MDgzIDAgMS43MDc3NzcyIDQuNDc2NjMxMSAwIDYuMTg0NDA4My00LjQ3NjYzMTEgMS43MDc3NzcyLTYuMTg0NDA4MyAwem0zMC45MjIwNDE3LTEwLjMwNzM0NzJjLTEuNzA3Nzc3Mi0xLjcwNzc3NzItMS43MDc3NzcyLTQuNDc2NjMxMiAwLTYuMTg0NDA4NHM0LjQ3NjYzMTItMS43MDc3NzcyIDYuMTg0NDA4NCAwIDEuNzA3Nzc3MiA0LjQ3NjYzMTIgMCA2LjE4NDQwODQtNC40NzY2MzEyIDEuNzA3Nzc3Mi02LjE4NDQwODQgMHptLTEwLjMwNzM0NzIgMTAuMzA3MzQ3MmMtMS43MDc3NzcyLTEuNzA3Nzc3Mi0xLjcwNzc3NzItNC40NzY2MzExIDAtNi4xODQ0MDgzczQuNDc2NjMxMS0xLjcwNzc3NzIgNi4xODQ0MDgzIDAgMS43MDc3NzcyIDQuNDc2NjMxMSAwIDYuMTg0NDA4My00LjQ3NjYzMTEgMS43MDc3NzcyLTYuMTg0NDA4MyAwem0tNDAuMTk4NjU0My0xLjAzMDczNDdjLTEuMTM4NTE4MTMtMS4xMzg1MTgxLTEuMTM4NTE4MTMtMi45ODQ0MjA4IDAtNC4xMjI5Mzg5IDEuMTM4NTE4MS0xLjEzODUxODEgMi45ODQ0MjA4LTEuMTM4NTE4MSA0LjEyMjkzODkgMHMxLjEzODUxODEgMi45ODQ0MjA4IDAgNC4xMjI5Mzg5LTIuOTg0NDIwOCAxLjEzODUxODEtNC4xMjI5Mzg5IDB6bTEwLjMwNzM0NzMgMTAuMzA3MzQ3MmMtMS4xMzg1MTgyLTEuMTM4NTE4MS0xLjEzODUxODItMi45ODQ0MjA3IDAtNC4xMjI5Mzg5IDEuMTM4NTE4MS0xLjEzODUxODEgMi45ODQ0MjA3LTEuMTM4NTE4MSA0LjEyMjkzODggMCAxLjEzODUxODIgMS4xMzg1MTgyIDEuMTM4NTE4MiAyLjk4NDQyMDggMCA0LjEyMjkzODktMS4xMzg1MTgxIDEuMTM4NTE4Mi0yLjk4NDQyMDcgMS4xMzg1MTgyLTQuMTIyOTM4OCAwem00MS4yMjkzODg5IDBjLTEuMTM4NTE4MS0xLjEzODUxODEtMS4xMzg1MTgxLTIuOTg0NDIwNyAwLTQuMTIyOTM4OSAxLjEzODUxODItMS4xMzg1MTgxIDIuOTg0NDIwOC0xLjEzODUxODEgNC4xMjI5Mzg5IDAgMS4xMzg1MTgyIDEuMTM4NTE4MiAxLjEzODUxODIgMi45ODQ0MjA4IDAgNC4xMjI5Mzg5LTEuMTM4NTE4MSAxLjEzODUxODItMi45ODQ0MjA3IDEuMTM4NTE4Mi00LjEyMjkzODkgMHptLTQyLjI2MDEyMzctMTkuNTgzOTU5N2MtMS43MDc3NzcyLTEuNzA3Nzc3Mi0xLjcwNzc3NzItNC40NzY2MzEyIDAtNi4xODQ0MDg0czQuNDc2NjMxMi0xLjcwNzc3NzIgNi4xODQ0MDg0IDAgMS43MDc3NzcyIDQuNDc2NjMxMiAwIDYuMTg0NDA4NC00LjQ3NjYzMTIgMS43MDc3NzcyLTYuMTg0NDA4NCAwem0xOS41ODM5NTk4IDEuMDMwNzM0N2MtMi4yNzcwMzYzLTIuMjc3MDM2My0yLjI3NzAzNjMtNS45Njg4NDE1IDAtOC4yNDU4Nzc4czUuOTY4ODQxNS0yLjI3NzAzNjMgOC4yNDU4Nzc4IDAgMi4yNzcwMzYzIDUuOTY4ODQxNSAwIDguMjQ1ODc3OC01Ljk2ODg0MTUgMi4yNzcwMzYzLTguMjQ1ODc3OCAwem0wLTIwLjYxNDY5NDVjLTIuMjc3MDM2My0yLjI3NzAzNjMtMi4yNzcwMzYzLTUuOTY4ODQxNSAwLTguMjQ1ODc3OHM1Ljk2ODg0MTUtMi4yNzcwMzYzIDguMjQ1ODc3OCAwIDIuMjc3MDM2MyA1Ljk2ODg0MTUgMCA4LjI0NTg3NzgtNS45Njg4NDE1IDIuMjc3MDM2My04LjI0NTg3NzggMHptLTEwLjMwNzM0NzMgMTAuMzA3MzQ3M2MtMi4yNzcwMzYyLTIuMjc3MDM2My0yLjI3NzAzNjItNS45Njg4NDE2IDAtOC4yNDU4Nzc4IDIuMjc3MDM2My0yLjI3NzAzNjMgNS45Njg4NDE2LTIuMjc3MDM2MyA4LjI0NTg3NzggMCAyLjI3NzAzNjMgMi4yNzcwMzYyIDIuMjc3MDM2MyA1Ljk2ODg0MTUgMCA4LjI0NTg3NzgtMi4yNzcwMzYyIDIuMjc3MDM2Mi01Ljk2ODg0MTUgMi4yNzcwMzYyLTguMjQ1ODc3OCAweiIvPjwvZz48L3N2Zz4=",
    },
    {
      name: "Clover",
      installUrl: "https://clv.org",
      icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTM2LjQ4IDBIMTEuNTJDNS4xNTc2OCAwIDAgNS4xNTc2OCAwIDExLjUyVjM2LjQ4QzAgNDIuODQyMyA1LjE1NzY4IDQ4IDExLjUyIDQ4SDM2LjQ4QzQyLjg0MjMgNDggNDggNDIuODQyMyA0OCAzNi40OFYxMS41MkM0OCA1LjE1NzY4IDQyLjg0MjMgMCAzNi40OCAwWiIgZmlsbD0idXJsKCNwYWludDBfbGluZWFyXzc5MTBfMTYzMzUxKSIvPgo8cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGNsaXAtcnVsZT0iZXZlbm9kZCIgZD0iTTI0LjAwMDYgMzkuMzYwNkMzMi40ODM3IDM5LjM2MDYgMzkuMzYwNiAzMi40ODM3IDM5LjM2MDYgMjQuMDAwNkMzOS4zNjA2IDE1LjUxNzUgMzIuNDgzNyA4LjY0MDYyIDI0LjAwMDYgOC42NDA2MkMxNS41MTc1IDguNjQwNjIgOC42NDA2MiAxNS41MTc1IDguNjQwNjIgMjQuMDAwNkM4LjY0MDYyIDMyLjQ4MzcgMTUuNTE3NSAzOS4zNjA2IDI0LjAwMDYgMzkuMzYwNlpNMjEuMjg5OSAxNS44Njg4SDI2LjcxMVYyMS4zNDdIMjEuMjkwNFYyNi42NTRIMjYuNzExVjMyLjEzMjJIMjEuMjg5OVYyNi44MjUySDE1Ljg2OTNWMjEuMzQ3SDIxLjI4OTlWMTUuODY4OFpNMjYuNzEyIDIxLjM0N0gzMi4xMzMxVjI2LjgyNTJIMjYuNzEyVjIxLjM0N1oiIGZpbGw9ImJsYWNrIi8+CjxkZWZzPgo8bGluZWFyR3JhZGllbnQgaWQ9InBhaW50MF9saW5lYXJfNzkxMF8xNjMzNTEiIHgxPSI0OCIgeTE9Ii0xLjQzMDUxZS0wNiIgeDI9IjEuNDMwNTFlLTA2IiB5Mj0iNDgiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KPHN0b3Agc3RvcC1jb2xvcj0iI0E5RkZFMCIvPgo8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM4NkQ1RkYiLz4KPC9saW5lYXJHcmFkaWVudD4KPC9kZWZzPgo8L3N2Zz4=",
    },
    {
      name: "Bitpie",
      installUrl: "https://bitpiecn.com",
      icon: "data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjY0IiB2aWV3Qm94PSIwIDAgNjQgNjQiIHdpZHRoPSI2NCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4bWxuczp4bGluaz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94bGluayI+PGxpbmVhckdyYWRpZW50IGlkPSJhIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiMxZTNkYTAiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMzNzUwZGUiLz48L2xpbmVhckdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBpZD0iYiIgeDE9IjUyLjU0NTc1JSIgeDI9IjUyLjU0NTc1JSIgeGxpbms6aHJlZj0iI2EiIHkxPSIxMDAlIiB5Mj0iMCUiLz48bGluZWFyR3JhZGllbnQgaWQ9ImMiIHgxPSI1MCUiIHgyPSI1MCUiIHkxPSIwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzFkM2JhMyIgc3RvcC1vcGFjaXR5PSIwIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMTczNzkzIiBzdG9wLW9wYWNpdHk9Ii42NTI5MzgiLz48L2xpbmVhckdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBpZD0iZCIgeDE9IjUwJSIgeDI9IjUwJSIgeGxpbms6aHJlZj0iI2EiIHkxPSIxMDAlIiB5Mj0iMCUiLz48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxwYXRoIGQ9Im0xOCAwaDI4YzkuOTQxMTI1NSAwIDE4IDguMDU4ODc0NSAxOCAxOHYyOGMwIDkuOTQxMTI1NS04LjA1ODg3NDUgMTgtMTggMThoLTI4Yy05Ljk0MTEyNTUgMC0xOC04LjA1ODg3NDUtMTgtMTh2LTI4YzAtOS45NDExMjU1IDguMDU4ODc0NS0xOCAxOC0xOHoiIGZpbGw9InVybCgjYikiLz48Y2lyY2xlIGN4PSIzMi4yODU3MTQiIGN5PSIzMi4yODU3MTQiIGZpbGw9IiNmZmYiIHI9IjI0LjI4NTcxNCIvPjxwYXRoIGQ9Im0zMiAwYzE3LjY3MzExMiAwIDMyIDE0LjMyNjg4OCAzMiAzMnMtMTQuMzI2ODg4IDMyLTMyIDMyLTMyLTE0LjMyNjg4OC0zMi0zMiAxNC4zMjY4ODgtMzIgMzItMzJ6bS0uMTQzNDk3OCA3LjYwNTM4MTE3Yy0xMy40NzI3NzU5IDAtMjQuMzk0NjE4NzkgMTAuOTIxODQyODMtMjQuMzk0NjE4NzkgMjQuMzk0NjE4ODNzMTAuOTIxODQyODkgMjQuMzk0NjE4OCAyNC4zOTQ2MTg3OSAyNC4zOTQ2MTg4YzEzLjQ3Mjc3NiAwIDI0LjM5NDYxODktMTAuOTIxODQyOCAyNC4zOTQ2MTg5LTI0LjM5NDYxODhzLTEwLjkyMTg0MjktMjQuMzk0NjE4ODMtMjQuMzk0NjE4OS0yNC4zOTQ2MTg4M3oiIGZpbGw9InVybCgjYykiLz48cGF0aCBkPSJtMjkuMDkwOTA5MSA0NC4zNjM2MzY0YzAgMi4wMDgzMDgxLTEuNjI4MDU1NSAzLjYzNjM2MzYtMy42MzYzNjM2IDMuNjM2MzYzNi0yLjAwODMwODIgMC0zLjYzNjM2MzctMS42MjgwNTU1LTMuNjM2MzYzNy0zLjYzNjM2MzZsLS4wMDAxODE4LTIuMTgyNjM2NC0yLjE4MTYzNjQuMDAwODE4MmMtMi4wMDgzMDgxIDAtMy42MzYzNjM2LTEuNjI4MDU1NS0zLjYzNjM2MzYtMy42MzYzNjM3IDAtMi4wMDgzMDgxIDEuNjI4MDU1NS0zLjYzNjM2MzYgMy42MzYzNjM2LTMuNjM2MzYzNmwyLjE4MTYzNjQtLjAwMDA5MDl2LTUuODE5bC0yLjE4MTYzNjQuMDAwOTA5MWMtMi4wMDgzMDgxIDAtMy42MzYzNjM2LTEuNjI4MDU1NS0zLjYzNjM2MzYtMy42MzYzNjM2IDAtMi4wMDgzMDgyIDEuNjI4MDU1NS0zLjYzNjM2MzcgMy42MzYzNjM2LTMuNjM2MzYzN2wyLjE4MTYzNjQtLjAwMDE4MTguMDAwMTgxOC0yLjE4MTYzNjRjMC0yLjAwODMwODEgMS42MjgwNTU1LTMuNjM2MzYzNiAzLjYzNjM2MzctMy42MzYzNjM2IDIuMDA4MzA4MSAwIDMuNjM2MzYzNiAxLjYyODA1NTUgMy42MzYzNjM2IDMuNjM2MzYzNmwtLjAwMDkwOTEgMi4xODE2MzY0aDUuODE5bC4wMDAwOTA5LTIuMTgxNjM2NGMwLTIuMDA4MzA4MSAxLjYyODA1NTUtMy42MzYzNjM2IDMuNjM2MzYzNi0zLjYzNjM2MzYgMi4wMDgzMDgyIDAgMy42MzYzNjM3IDEuNjI4MDU1NSAzLjYzNjM2MzcgMy42MzYzNjM2bC0uMDAwODE4MiAyLjE4MTYzNjQgMi4xODI2MzY0LjAwMDE4MThjMi4wMDgzMDgxIDAgMy42MzYzNjM2IDEuNjI4MDU1NSAzLjYzNjM2MzYgMy42MzYzNjM3IDAgMi4wMDgzMDgxLTEuNjI4MDU1NSAzLjYzNjM2MzYtMy42MzYzNjM2IDMuNjM2MzYzNmwtMi4xODI2MzY0LS4wMDA5MDkxdjUuODE5bDIuMTgyNjM2NC4wMDAwOTA5YzIuMDA4MzA4MSAwIDMuNjM2MzYzNiAxLjYyODA1NTUgMy42MzYzNjM2IDMuNjM2MzYzNiAwIDIuMDA4MzA4Mi0xLjYyODA1NTUgMy42MzYzNjM3LTMuNjM2MzYzNiAzLjYzNjM2MzdsLTIuMTgyNjM2NC0uMDAwODE4Mi4wMDA4MTgyIDIuMTgyNjM2NGMwIDIuMDA4MzA4MS0xLjYyODA1NTUgMy42MzYzNjM2LTMuNjM2MzYzNyAzLjYzNjM2MzYtMi4wMDgzMDgxIDAtMy42MzYzNjM2LTEuNjI4MDU1NS0zLjYzNjM2MzYtMy42MzYzNjM2bC0uMDAwMDkwOS0yLjE4MjYzNjRoLTUuODE5em0tLjAwMDkwOTEtOS40NTQ2MzY0aDUuODE5di01LjgxOWgtNS44MTl6IiBmaWxsPSJ1cmwoI2QpIiB0cmFuc2Zvcm09Im1hdHJpeCguODY2MDI1NCAtLjUgLjUgLjg2NjAyNTQgLTExLjcxMjgxMyAyMC4yODcxODcpIi8+PC9nPjwvc3ZnPg==",
    },
    {
      name: "SafePal",
      installUrl: "https://safepal.io",
      icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAMAAABg3Am1AAAAP1BMVEUAAABKIe9MIO9LIO9KIe5KIO9KIe9KIO5JIO1KIu1KIO1KIe////+kkPfo4/1hPfFgPfGZgvaOdPWDZvRVL/CpQHckAAAAC3RSTlMA7yC/oDDfgJCQkAOmnXUAAADnSURBVEjHlZbtjoJAEAR7BwTvmvUO9f2f1USNk81MRrp+VxFY9gsvbJ0aC9r0Y3Bs5gHmT3JqPMRy0nyyPQtbeJhmAGYKzIBRwvBLiRUTJSY0SjQw4X7tI//8kAV/l22k04HoE6JPiD4h+oToE8HfWYLwfNZg9EOQvpL7Mag+et+SoBrWWxaUP64nQT01ehLUk6/nwXYLgRdpsIfAiyy4VAuoc8B9D0rcPxbs7sfAB8oJPiH6hOgTok+IPiH4YQH1keudCfJmrG/3KyXO8pGlH4ow4bMX0w/2Z7EIvnY5cez87fqzvvUH/qNgaUlN588AAAAASUVORK5CYII=",
    },
    {
      name: "Nightly",
      installUrl: "https://nightly.app",
      icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iOTYiIGhlaWdodD0iOTYiIHZpZXdCb3g9IjAgMCA5NiA5NiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQ4IDk2Qzc0LjUwOTcgOTYgOTYgNzQuNTA5NyA5NiA0OEM5NiAyMS40OTAzIDc0LjUwOTcgMCA0OCAwQzIxLjQ5MDMgMCAwIDIxLjQ5MDMgMCA0OEMwIDc0LjUwOTcgMjEuNDkwMyA5NiA0OCA5NloiIGZpbGw9IiM2RDczRjgiLz4KPHBhdGggZD0iTTQ4IDg1LjYzNTZDNDggODUuNjM1NiA1Mi40NTMzIDg1LjYzNTYgNTUuNDQgODIuNTg2N0M1OC45MTU1IDc5LjI4MDEgNTcuMzUxMSA3NS40MzEyIDYyLjI3NTUgNzEuNDMxMkM2Ni45ODY2IDY3LjY0NDUgNzIuOTI0NCA3MC4zMzc5IDcyLjkyNDQgNzAuMzM3OUM3Ny4wMjIyIDYyLjEyNDUgNzQuNzkxMSA1Mi41NjkgNzQuNzkxMSA1Mi41NjlDODEuNzY4OCAzNC4yNTc5IDc1Ljk2NDQgMjEuMTU1NyA3NC40NDQ0IDE3LjM2MDFDNjkuNDQ4OCAyNC4zMzc5IDYzLjE5MTEgMjkuMTczNCA1NS43OTU1IDMyLjQwOUM1My4yMjY2IDMxLjcwNjggNTAuNTk1NSAzMS4zMzM0IDQ4IDMxLjM2MDFDNDUuNDEzMyAzMS4zMzM0IDQyLjc3MzMgMzEuNzA2OCA0MC4yMDQ0IDMyLjQwOUMzMi44MTc3IDI5LjE2NDUgMjYuNTUxMSAyNC4zMzc5IDIxLjU1NTUgMTcuMzYwMUMyMC4wMzU1IDIxLjE1NTcgMTQuMjMxMSAzNC4yNTc5IDIxLjIwODkgNTIuNTY5QzIxLjIwODkgNTIuNTY5IDE4Ljk3NzggNjIuMTI0NSAyMy4wNzU1IDcwLjMzNzlDMjMuMDc1NSA3MC4zMzc5IDI5LjAxMzMgNjcuNjQ0NSAzMy43MjQ0IDcxLjQzMTJDMzguNjU3NyA3NS40MzEyIDM3LjA4NDQgNzkuMjgwMSA0MC41NiA4Mi41ODY3QzQzLjU0NjYgODUuNjM1NiA0OCA4NS42MzU2IDQ4IDg1LjYzNTZaIiBmaWxsPSJ3aGl0ZSIvPgo8cGF0aCBkPSJNNDIuNDc5OSA2NS4yOThDNDIuMjkzMyA1OS4yMTggMzYuMzAyMSA1Ny4yNjI0IDMyLjIxMzMgNTkuODIyNEMzMi4yMTMzIDU5LjgyMjQgMzIuODUzMyA2Mi40MzU4IDM1LjgzOTkgNjMuNzUxM0MzOC4yNzU1IDY0LjgyNjkgMzkuMzI0NCA2My4zODY5IDQyLjQ3OTkgNjUuMjk4WiIgZmlsbD0iIzdCODFGOSIvPgo8cGF0aCBkPSJNMjIuNDk3NyAyMy4wOTM1QzIwLjA4ODggMzEuNTQ2OCAyMS4xMjg4IDQyLjI0MDIgMjQuOTMzMyA1MC4wMjY5QzI4LjgyNjYgNDcuMjcxMyAzMi45MTU1IDQzLjAxMzUgMzUuMDkzMyAzOC41MDY5QzI5Ljk2NDQgMzQuNzExMyAyNS42NjIyIDMxLjEwMjQgMjIuNDk3NyAyMy4wOTM1WiIgZmlsbD0iIzdCODFGOSIvPgo8cGF0aCBkPSJNNTMuNTE5OSA2NS4yOThDNTMuNzA2NiA1OS4yMTggNTkuNjk3NyA1Ny4yNjI0IDYzLjc4NjYgNTkuODIyNEM2My43ODY2IDU5LjgyMjQgNjMuMTQ2NiA2Mi40MzU4IDYwLjE1OTkgNjMuNzUxM0M1Ny43MjQzIDY0LjgyNjkgNTYuNjc1NSA2My4zODY5IDUzLjUxOTkgNjUuMjk4WiIgZmlsbD0iIzdCODFGOSIvPgo8cGF0aCBkPSJNNzMuNTAyMiAyMy4wOTM1Qzc1LjkxMTEgMzEuNTQ2OCA3NC44NzExIDQyLjI0MDIgNzEuMDY2NiA1MC4wMjY5QzY3LjE3MzMgNDcuMjcxMyA2My4wODQ0IDQzLjAxMzUgNjAuOTA2NiAzOC41MDY5QzY2LjAzNTUgMzQuNzExMyA3MC4zMzc3IDMxLjEwMjQgNzMuNTAyMiAyMy4wOTM1WiIgZmlsbD0iIzdCODFGOSIvPgo8cGF0aCBkPSJNNDcuOTk5OSA4NS4zMDY5QzUwLjE0MDQgODUuMzA2OSA1MS44NzU1IDgzLjc3ODcgNTEuODc1NSA4MS44OTM2QzUxLjg3NTUgODAuMDA4NCA1MC4xNDA0IDc4LjQ4MDIgNDcuOTk5OSA3OC40ODAyQzQ1Ljg1OTUgNzguNDgwMiA0NC4xMjQ0IDgwLjAwODQgNDQuMTI0NCA4MS44OTM2QzQ0LjEyNDQgODMuNzc4NyA0NS44NTk1IDg1LjMwNjkgNDcuOTk5OSA4NS4zMDY5WiIgZmlsbD0iIzdCODFGOSIvPgo8L3N2Zz4K",
    },
    {
      name: "ONTO",
      installUrl: "https://onto.app",
      icon: "data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMSIgZGF0YS1uYW1lPSJMYXllciAxIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyODggMjg4Ij4KICA8dGl0bGU+T05UTyBMT0dPXzI4OHgyODg8L3RpdGxlPgogIDxnIGlkPSJMT0dPIj4KICAgIDxwYXRoIGlkPSLlvaLnirbnu5PlkIgiIGQ9Ik0zMCwxMS4xNSw3MS4xOSw1Mi4zMkExMTUsMTE1LDAsMCwxLDI1OCwxMzguNjdMMjU4LDE0MlYyNzYuODVsLTQxLjE5LTQxLjE2QTExNSwxMTUsMCwwLDEsMzAuMDUsMTQ5LjM0TDMwLDE0NlptMjguMTcsNjhWMTQ2YTg2Ljc5LDg2Ljc5LDAsMCwwLDEzNS4xNSw3MmwyLjIzLTEuNTVMNjMuNjcsODQuNjVaTTk0LjY4LDcwbC0yLjIzLDEuNTVMMjI0LjMzLDIwMy4zNmw1LjUsNS41VjE0MkE4Ni43OSw4Ni43OSwwLDAsMCw5NC42OCw3MFoiLz4KICA8L2c+Cjwvc3ZnPg==",
    },
    {
      name: "Trezor",
      installUrl: "https://trezor.io",
      icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTA4IiBoZWlnaHQ9IjEwOCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBjbGlwLXBhdGg9InVybCgjYSkiPjxwYXRoIGQ9Ik01NCAwYzI5LjgyNCAwIDU0IDI0LjE3NiA1NCA1NHMtMjQuMTc2IDU0LTU0IDU0UzAgODMuODI0IDAgNTQgMjQuMTc2IDAgNTQgMHoiIGZpbGw9IiNmZmYiLz48cGF0aCBkPSJNNzUuMjUgMzMuMzA1Qzc1LjI1IDIyLjIwNSA2NS42NjIgMTMgNTQgMTNjLTExLjY3MiAwLTIxLjI1OCA5LjIxMi0yMS4yNTggMjAuMzA1djYuNDlIMjR2NDYuNjgzTDUzLjk5IDEwMC41IDg0IDg2LjQ3NXYtNDYuNDdoLTguNzQ1bC0uMDA3LTYuNjk4LjAwMi0uMDAyem0tMzEuNjcgMGMwLTUuMjMyIDQuNTg1LTkuNDIgMTAuNDE4LTkuNDIgNS44MzUgMCAxMC40MTcgNC4xODggMTAuNDE3IDkuNDJ2Ni40OUg0My41OHYtNi40OXptMjguMzM1IDQ1LjYzN0w1My45OSA4Ny4zMmwtMTcuOTItOC4zNzJWNTAuODloMzUuODQ1djI4LjA1MnoiIGZpbGw9IiMxNzE3MTciLz48L2c+PGRlZnM+PGNsaXBQYXRoIGlkPSJhIj48cGF0aCBmaWxsPSIjZmZmIiBkPSJNMCAwaDEwOHYxMDhIMHoiLz48L2NsaXBQYXRoPjwvZGVmcz48L3N2Zz4=",
    },
    {
      name: "HuobiWallet",
      installUrl: "https://www.huobiwallet.io",
      icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjI0IiBoZWlnaHQ9IjIyNCIgdmlld0JveD0iMCAwIDIyNCAyMjQiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBkPSJNMCAwTDIyNCAwVjIyNEgwTDAgMFoiIGZpbGw9IiMyMTU3RTIiLz4KPHBhdGggZD0iTTEzMS4wNTkgODEuMTc3MUMxMzEuMDU5IDU3Ljc1MzEgMTE5LjQ1OCAzNy42MzE1IDExMC42MjUgMzEuMDcyOEMxMTAuNjI1IDMxLjA3MjggMTA5Ljk1MyAzMC43MDQyIDExMCAzMS42MjU4VjMxLjYyNThDMTA5LjI2NSA3Ni44MzAzIDg1Ljc2NzIgODkuMDg3NSA3Mi44MzggMTA1LjU4NEM0My4wMjQxIDE0My42NzcgNzAuNzU4NyAxODUuNDU2IDk4Ljk5MzUgMTkzLjEzNkMxMTQuNzk5IDE5Ny40NTIgOTUuMzUwOCAxODUuNDU2IDkyLjg0OTQgMTYwLjIzNUM4OS44MDA3IDEyOS43NDUgMTMxLjA1OSAxMDYuNDQ0IDEzMS4wNTkgODEuMTc3MVoiIGZpbGw9InVybCgjcGFpbnQwX2xpbmVhcl8xMTAxXzEyNSkiLz4KPHBhdGggZD0iTTE0My41OTcgOTYuMzE3NEMxNDMuNDA5IDk2LjE5NDMgMTQzLjE1OCA5Ni4xMDIgMTQyLjk4NiA5Ni4zOTQzQzE0Mi40ODQgMTAyLjEwMiAxMzYuNTYgMTE0LjI4NiAxMjkuMDM3IDEyNS40ODZDMTAzLjU1MiAxNjMuNDU1IDExOC4wNjUgMTgxLjc2MiAxMjYuMjQ3IDE5MS42MzlDMTMwLjk0OSAxOTcuMzQ3IDEyNi4yNDcgMTkxLjYzOSAxMzguMDk2IDE4NS44MDhDMTUyLjczNSAxNzcuMDkyIDE2Mi4yMzQgMTYyLjAyIDE2My42NDMgMTQ1LjI3QzE2NS4yMzMgMTI2Ljc1OCAxNTcuNzk4IDEwOC42IDE0My41OTcgOTYuMzE3NFoiIGZpbGw9InVybCgjcGFpbnQxX2xpbmVhcl8xMTAxXzEyNSkiLz4KPGRlZnM+CjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl8xMTAxXzEyNSIgeDE9IjEyMi40MDEiIHkxPSIyMDkuMjk1IiB4Mj0iMTc4LjY2MiIgeTI9IjExMC40NDciIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KPHN0b3Agc3RvcC1jb2xvcj0iI0Y3RjZGRiIvPgo8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IndoaXRlIi8+CjwvbGluZWFyR3JhZGllbnQ+CjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQxX2xpbmVhcl8xMTAxXzEyNSIgeDE9IjE1Ny44NjEiIHkxPSIyMDMuMTc3IiB4Mj0iMTg5LjAxNCIgeTI9IjE0MC4wMjIiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KPHN0b3Agc3RvcC1jb2xvcj0iI0Y3RjZGRiIvPgo8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IndoaXRlIi8+CjwvbGluZWFyR3JhZGllbnQ+CjwvZGVmcz4KPC9zdmc+Cg==",
    },
    {
      name: "Bitget",
      installUrl: "https://web3.bitget.com",
      icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgdmlld0JveD0iMCAwIDUxMiA1MTIiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiBmaWxsPSIjMDAxRjI5Ii8+CjxwYXRoIGQ9Ik0yMTkuOTQ4IDk1LjcwMjJDMjAxLjYyMyA5NS42OTI5IDE4My4zMyA5NS42ODM1IDE2NC45NDEgOTUuNzExNkMxNTMuODIyIDk1LjcxMTYgMTQ5LjY1MSAxMDkuNjcxIDE1Ny45MjEgMTE3LjkzOUwyODMuMDk4IDI0My4xMTdDMjg3LjAwNCAyNDYuNjkgMjg5LjQ0MSAyNTAuNTc0IDI4OS41MyAyNTUuNjkzQzI4OS40NDEgMjYwLjgxMiAyODcuMDA0IDI2NC42OTYgMjgzLjA5OCAyNjguMjY5TDE1Ny45MjEgMzkzLjQ0NkMxNDkuNjUxIDQwMS43MTUgMTUzLjgyMiA0MTUuNjc0IDE2NC45NDEgNDE1LjY3NEMxODMuMzMgNDE1LjcwMiAyMDEuNjIzIDQxNS42OTMgMjE5Ljk0OCA0MTUuNjgzQzIyOS4xMjIgNDE1LjY3OSAyMzguMzA1IDQxNS42NzQgMjQ3LjUxMSA0MTUuNjc0QzI1OS41NTUgNDE1LjY3NCAyNjYuNzIgNDA5LjI0IDI3My4xNTQgNDAyLjgwNUwzODYuMDQ3IDI4OS45MTJDMzk1LjA1NyAyODAuOTAyIDQwMy4xMTkgMjY4LjkzOSA0MDMuMDA5IDI1NS42OTNDNDAzLjExOSAyNDIuNDQ3IDM5NS4wNTcgMjMwLjQ4NCAzODYuMDQ3IDIyMS40NzRMMjczLjE1NCAxMDguNThDMjY2LjcyIDEwMi4xNDYgMjU5LjU1NSA5NS43MTE2IDI0Ny41MTEgOTUuNzExNkMyMzguMzA1IDk1LjcxMTYgMjI5LjEyMiA5NS43MDY5IDIxOS45NDggOTUuNzAyMloiIGZpbGw9IiMwMEYwRkYiLz4KPC9zdmc+Cg==",
    },
    {
      name: "Coinhub",
      installUrl: "https://coinhub.org",
      icon: "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyB3aWR0aD0iMTAwcHgiIGhlaWdodD0iMTAwcHgiIHZpZXdCb3g9IjAgMCAxMDAgMTAwIiB2ZXJzaW9uPSIxLjEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiPgogICAgPHRpdGxlPuefqeW9ojwvdGl0bGU+CiAgICA8ZyBpZD0i6aG16Z2iLTEiIHN0cm9rZT0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIxIiBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPgogICAgICAgIDxnIGlkPSLkuIvovb3pobVpb3MiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC0xMzguMDAwMDAwLCAtOTQuMDAwMDAwKSI+CiAgICAgICAgICAgIDxnIGlkPSJDb2luaHViLSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTM4LjAwMDAwMCwgOTQuMDAwMDAwKSI+CiAgICAgICAgICAgICAgICA8cmVjdCBpZD0i55+p5b2iIiB4PSIwIiB5PSIwIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCI+PC9yZWN0PgogICAgICAgICAgICAgICAgPGcgaWQ9Iue8lue7hCIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMy4zMzMzMzMsIDMuMzMzMzMzKSIgZmlsbC1ydWxlPSJub256ZXJvIj4KICAgICAgICAgICAgICAgICAgICA8cGF0aCBkPSJNNTcuOTU2MzU0Miw0MC43MDQ2MzE2IEM1Ny45NTYzNTQyLDQwLjcwNDYzMTYgNjIuNzc2ODc1LDU2LjM0NTIxMDUgODEuNjE1OTg5Niw1OC41MTY2ODQyIEM4NC43MzEzNTQyLDU4Ljg3NTUyNjMgODguMjYwNTIwOCw1OS4yNjM4NDIxIDkxLjg2ODQzNzUsNTguMTg4MDUyNiBDOTIuMDIyMjkxNyw1OC4xOTc2MzE2IDkyLjE3MjUsNTguMjQwNzM2OCA5Mi4zMDgxMjUsNTguMzE0MDUyNiBDOTIuNDQ0MTE0Niw1OC4zODczNjg0IDkyLjU2Mjk2ODgsNTguNDg5MDUyNiA5Mi42NTY2NjY3LDU4LjYxMjg0MjEgQzkyLjc1LDU4LjczNjYzMTYgOTIuODE1OTg5Niw1OC44Nzk1Nzg5IDkyLjg1MDI2MDQsNTkuMDMxMzY4NCBDOTIuODg0NTMxMyw1OS4xODMxNTc5IDkyLjg4NTYyNSw1OS4zNDA0NzM3IDkyLjg1NDI3MDgsNTkuNDkzIEM5Mi4zMjM4MDIxLDYzLjE1MTc4OTUgOTEuMTIzNTkzNyw2Ni42Nzg2ODQyIDg5LjMxNTI2MDQsNjkuODkzNTI2MyBDODQuNzQxMTk3OSw3OC4xMTE4OTQ3IDc0LjY5NTQ2ODgsODguOTgwNjg0MiA1Mi4wMTE4MjI5LDkyLjgwNiBDNTAuODA5MDYyNSw5Mi44MDYgNDguNDMzMDcyOSw5MS43NDAxNTc5IDQ3LjMyOTExNDYsOTEuOTI5NTI2MyBDNDcuMzI5MTE0Niw5MS45MDkyNjMyIDE5Ljk3MjUzMTIsNjcuNjUyMDUyNiA1Ny45NTYzNTQyLDQwLjcwNDYzMTYgWiIgaWQ9Iui3r+W+hCIgZmlsbD0iI0NGQkZBMyI+PC9wYXRoPgogICAgICAgICAgICAgICAgICAgIDxwYXRoIGQ9Ik01Mi4wMTE0NTgzLDkyLjgwNiBDNTIuMDExNDU4Myw5Mi44MDYgMzIuMTk2NSw2NC4xNzUyNjMyIDYzLjMwOTE2NjcsNDkuNTExIEw1OS40MzQ3Mzk2LDQ0LjQxMDU3ODkgQzU5LjQzNDczOTYsNDQuNDEwNTc4OSAxOS4xNDQxOTc5LDY1LjE5MTM2ODQgNTIuMDExNDU4Myw5Mi44MDYgWiIgaWQ9Iui3r+W+hCIgZmlsbD0iI0I5QTc5OCI+PC9wYXRoPgogICAgICAgICAgICAgICAgICAgIDxwYXRoIGQ9Ik05Mi44NTQ2MzU0LDU5LjUzMzE1NzkgQzkyLjIzOTU4MzMsNjMuMzYxMDUyNiA5MC45NDAyMDgzLDY3LjA0Mzc4OTUgODkuMDE5OTQ3OSw3MC40MDE1Nzg5IEw4My4yNjI0NDc5LDU4LjY5NjEwNTMgQzg1LjkzMDEwNDIsNTkuMDU0OTQ3NCA4OC42Mzk2ODc1LDU4LjkxNjQyMTEgOTEuMjU3NzYwNCw1OC4yODc4OTQ3IEM5Mi41MDk3Mzk2LDU3Ljk5OTA1MjYgOTMuMDUxODc1LDU4LjQxNzIxMDUgOTIuODU0NjM1NCw1OS41MzMxNTc5IFoiIGlkPSLot6/lvoQiIGZpbGw9IiM4QzY3NDIiPjwvcGF0aD4KICAgICAgICAgICAgICAgICAgICA8cGF0aCBkPSJNNTkuNzk5Njg3NSw2Ny41MzIzMTU4IEM2Mi4wMTU2MjUsNjcuNTMyMzE1OCA2My44MTE5MjcxLDY1LjcxNzEwNTMgNjMuODExOTI3MSw2My40Nzc4NDIxIEM2My44MTE5MjcxLDYxLjIzODU3ODkgNjIuMDE1NjI1LDU5LjQyMzM2ODQgNTkuNzk5Njg3NSw1OS40MjMzNjg0IEM1Ny41ODM3NSw1OS40MjMzNjg0IDU1Ljc4NzQ0NzksNjEuMjM4NTc4OSA1NS43ODc0NDc5LDYzLjQ3Nzg0MjEgQzU1Ljc4NzQ0NzksNjUuNzE3MTA1MyA1Ny41ODM3NSw2Ny41MzIzMTU4IDU5Ljc5OTY4NzUsNjcuNTMyMzE1OCBaIiBpZD0i6Lev5b6EIiBmaWxsPSIjMjIyMjIyIj48L3BhdGg+CiAgICAgICAgICAgICAgICAgICAgPHBhdGggZD0iTTYwLjU1OTExNDYsNi44MTQwMjEwNSBMNjMuODkxMDQxNywxLjI3NTEzNDc0IEM1OC4yNzI4MTI1LDIuMjE4NjEzMTYgNTIuNzc3MDgzMywzLjc5NTg0MjExIDQ3LjUwNjY2NjcsNS45NzcxODk0NyBDNDYuMTIzODAyMSw2LjEwODQ5NDc0IDQ0Ljc0ODU5MzcsNi4zMTEzMTA1MyA0My4zODYxNDU4LDYuNTg0ODYzMTYgTDUwLjA2MDIwODMsMy40NjI0NjIyOWUtMTMgQzQzLjQ2MzA3MjksMS42MzEzMDk0NyAzNy40ODkzNzUsNS4xOTM3NDIxMSAzMi44ODcwNTczLDEwLjI0MDkyNjMgQzMyLjIwNjgxNzcsMTAuNTc5NjUyNiAzMS41MzY0NTgzLDEwLjk0ODI1NzkgMzAuOTE1MzkwNiwxMS4zMzY3NTc5IEwzNi4xNTAxMTQ2LDEuNTkzOTI1NzkgQzI5LjA0OTE5NzksNS40NjMyNDIxMSAyMy40ODAzMzMzLDExLjY4MTYzNjggMjAuMzc2OTYzNSwxOS4yMDY3NDc0IEwyMy42MTA0NTMxLDcuODUwMDU3ODkgQzIzLjYxMDQ1MzEsNy44NTAwNTc4OSAxNS40Mzc5ODk2LDE0LjEwNjIxNTggMTMuOTg4ODQzNywyOS41MzczNDc0IEMxMy44MDE1MjA4LDI5LjkxNTkgMTMuNjE0MTk3OSwzMC4yOTQ0NTI2IDEzLjQzNjc1NTIsMzAuNjgyOTUyNiBMMTIuNTQ5NTQxNywxNi44NTU3MDUzIEMxMi41NDk1NDE3LDE2Ljg1NTcwNTMgNC42MDM4MTI1LDI5LjY1Njg2MzIgOS43MTAzNDg5Niw0NC4xMzE2ODQyIEw0LjE2MDE4NzUsMzAuMTg0ODQ3NCBDNC4xNjAxODc1LDMwLjE4NDg0NzQgMC43MTk2NTEwNDIsNDEuMTQzMDUyNiA5LjA4OTI4MTI1LDU1LjM0OSBMLTIuNzYzMjIxNzVlLTE0LDQ0LjcwOTM2ODQgQy0yLjc2MzIyMTc1ZS0xNCw0NC43MDkzNjg0IDAuODc3MzgwNzI5LDYzLjA2OTI2MzIgMTEuMjY3OTU4Myw3My4wMDE1MjYzIEMxMS4yNjc5NTgzLDczLjAwMTUyNjMgMTUuMDA0MjA4Myw3MS44NzYgMTcuMzAxMTkyNyw3NC41NDU1Nzg5IEMyMC45NjAyMjQsNzkuOTIzNDIxMSAyNS44MDI5NDc5LDg0LjM3MSAzMS40NDkxNzcxLDg3LjUzOTQyMTEgQzM3LjA5NTI2MDQsOTAuNzA3NDczNyA0My4zOTE2MTQ2LDkyLjUxMDUyNjMgNDkuODQzMjgxMiw5Mi44MDYgQzUwLjM4NTQxNjcsOTIuODA2IDUxLjQ2OTY4NzUsOTIuODA2IDUxLjQ2OTY4NzUsOTIuODA2IEM1MS40Njk2ODc1LDkyLjgwNiAzMi4xODcwOTM3LDc1Ljk4MDIxMDUgNTAuNzY5Njg3NSw1MS45NjE3MzY4IEM2OS4zNjIzNDM3LDI5Ljg1NjEwNTMgOTMuMzg2OTI3MSw0NS4yMjczNjg0IDkzLjE2MDE1NjIsNDMuMjQ0ODk0NyBDOTIuMDM3NjA0MiwzNC41NDI2Nzg5IDg4LjMxNTU3MjksMjYuMzkzMjA1MyA4Mi40OTA2MjUsMTkuODgzOTc4OSBDNzYuNjY1Njc3MSwxMy4zNzQ3NTI2IDY5LjAxNDg5NTgsOC44MTUzMjEwNSA2MC41NTkxMTQ2LDYuODE0MDIxMDUgTDYwLjU1OTExNDYsNi44MTQwMjEwNSBaIiBpZD0i6Lev5b6EIiBmaWxsPSIjMjJBMDc5Ij48L3BhdGg+CiAgICAgICAgICAgICAgICAgICAgPHBhdGggZD0iTTQzLjM0NjQwNjMsNzguNTgwMTU3OSBDNDMuMzQ2NDA2Myw3OC41ODAxNTc5IDIyLjA2MjQzMjMsODYuMDgxNTc4OSAyLjI4NjgzNDM4LDU3LjAzMjMxNTggQzQuNDA4MTc3MDgsNjQuNjU0MjEwNSA4LjIwNjE1MTA0LDcxLjY5MzI2MzIgMTMuMzk3MDUyMSw3Ny42MjM3MzY4IEMyMC42MjMxMzAyLDg2LjAyMTg5NDcgMzQuOTc2NzM5Niw5My4zMTQwNTI2IDUyLjAxMTgyMjksOTIuNzg2MTA1MyBDNDkuOTUzNzUsOTEuMTc5NDIxMSA0OC4yMzcyOTE3LDg5LjE3MDQyMTEgNDYuOTY0MTY2Nyw4Ni44Nzg0NzM3IEM0NS40OTM4MDIxLDg0LjIzOCA0NC4yODE5MjcxLDgxLjQ1OSA0My4zNDY0MDYzLDc4LjU4MDE1NzkgTDQzLjM0NjQwNjMsNzguNTgwMTU3OSBaIiBpZD0i6Lev5b6EIiBmaWxsPSIjMUI4MDYxIj48L3BhdGg+CiAgICAgICAgICAgICAgICA8L2c+CiAgICAgICAgICAgIDwvZz4KICAgICAgICA8L2c+CiAgICA8L2c+Cjwvc3ZnPg==",
    },
    {
      name: "Keystone",
      installUrl: "https://keyst.one",
      icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICAgIDxjaXJjbGUgY3g9IjE2IiBjeT0iMTYiIHI9IjE2IiBmaWxsPSJ3aGl0ZSIvPgogICAgPHJlY3QgeD0iNSIgeT0iNSIgd2lkdGg9IjIyIiBoZWlnaHQ9IjIyIiBmaWxsPSJ3aGl0ZSIgZmlsbC1vcGFjaXR5PSIxIi8+CiAgICA8cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGNsaXAtcnVsZT0iZXZlbm9kZCIgZD0iTTE0LjY5NjUgNS40MzQ4N0MxNS4wOTEgNC43NTMxNiAxNi4wNzQ5IDQuNzUyMTEgMTYuNDcwOCA1LjQzMjk5TDE3LjMzOTggNi45MjcxOUMxNy42NDkgNy40NTg5NiAxNy42NDg3IDguMTE1ODggMTcuMzM4OSA4LjY0NzM0TDkuNjMxMjEgMjEuODcxQzkuMjE4NTEgMjIuNTc5MSA4LjE5NjIzIDIyLjU4MTEgNy43ODA3NiAyMS44NzQ2QzcuNzMxMzIgMjEuNzkwNiA3LjY5MzU4IDIxLjcwMDEgNy42Njg1OCAyMS42MDU4TDcuMzcwODggMjAuNDgyOUM3LjA5MjY2IDE5LjQzMzQgNy4yNDE4IDE4LjMxNjQgNy43ODU2MyAxNy4zNzY3TDE0LjY5NjUgNS40MzQ4N1pNMTIuNjYzNiAxOS4yODU4QzEzLjA2MzUgMTguNTk5NyAxNC4wMDM1IDE4LjQ3NTcgMTQuNTY3NyAxOS4wMzQ1TDE3LjQyODggMjEuODY4NkMxOC44NjA1IDIzLjI4NjcgMTguODU2NSAyNS42MDE2IDE3LjQyIDI3LjAxNDlDMTcuMjA0NSAyNy4yMjY5IDE2Ljg3OTggMjcuMjgyNSAxNi42MDYgMjcuMTU0MkwxMS42MDAyIDI0LjgwODFDMTAuNjkwNyAyNC4zODE5IDEwLjM0MyAyMy4yNjcxIDEwLjg0ODcgMjIuMzk5NEwxMi42NjM2IDE5LjI4NThaTTIwLjQzNSAxNi4zMzcyQzIxLjQ4OTcgMTYuMzM3MiAyMi4xNDc0IDE1LjE5MzkgMjEuNjE3MiAxNC4yODIyTDE5Ljc4MjggMTEuMTI4QzE5LjI1NTggMTAuMjIxOCAxNy45NDcxIDEwLjIyMTIgMTcuNDE5MiAxMS4xMjY5TDE1LjQzMDkgMTQuNTM4MUMxNC45NjYgMTUuMzM1OCAxNS41NDE0IDE2LjMzNzIgMTYuNDY0NyAxNi4zMzcyTDIwLjQzNSAxNi4zMzcyWiIgZmlsbD0iYmxhY2siLz4KICAgIDxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBkPSJNMjEuNzMwMyAxNy42NDU5QzIyLjg3MTMgMTcuNjQ1OSAyMy45MjYxIDE4LjI1MjcgMjQuNDk5OCAxOS4yMzlWMTkuMjM5QzI0LjY3NjMgMTkuNTQyNyAyNC42MjQ3IDE5LjkyNzQgMjQuMzc0MyAyMC4xNzM3TDIyLjA1MTEgMjIuNDU5QzIxLjQ1MDkgMjMuMDQ5NCAyMC40ODc3IDIzLjA0NzggMTkuODg5NSAyMi40NTUzTDE2LjUxMDEgMTkuMTA3OEMxNS45Njc3IDE4LjU3MDYgMTYuMzQ4MSAxNy42NDU5IDE3LjExMTYgMTcuNjQ1OUwyMS43MzAzIDE3LjY0NTlaIiBmaWxsPSIjMjE2MUZGIi8+Cjwvc3ZnPgo=",
    },
    {
      name: "XDEFI",
      bg: "#000",
      installUrl: "https://xdefi.io",
      icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTE0LjI2MjggMTMuNDAxM0MxMi40MjI4IDE0LjUzMDcgOS45NTk5NyAxNS4xMTI0IDcuNDY1NjkgMTQuOTg4MUM1LjM2ODU1IDE0Ljg4NjUgMy42NDg1NSAxNC4xNDExIDIuNjA4NTUgMTIuOTE1N0MxLjY5NDI2IDExLjgyMDEgMS4zMzk5OCAxMC4zNzQ1IDEuNTc5OTggOC43MTE0M0MxLjY2MTMyIDguMTU4NzQgMS44MjgwMiA3LjYyMTY2IDIuMDc0MjYgNy4xMTg5NkwyLjEwODU1IDcuMDQ4MzdDMi45NzE4IDUuNDA1OTUgNC4yNTI5MyA0LjAxMzk3IDUuODI1ODQgMy4wMDk0MkM3LjM5ODc1IDIuMDA0ODYgOS4yMDkyNCAxLjQyMjM2IDExLjA3OTEgMS4zMTkyNEMxMi45NDkgMS4yMTYxMSAxNC44MTM4IDEuNTk1OTIgMTYuNDkwMSAyLjQyMTI4QzE4LjE2NjMgMy4yNDY2NSAxOS41OTYyIDQuNDg5MTIgMjAuNjM5IDYuMDI2NDFDMjEuNjgxOSA3LjU2MzcxIDIyLjMwMTcgOS4zNDI4NSAyMi40Mzc0IDExLjE4ODdDMjIuNTczMiAxMy4wMzQ2IDIyLjIyMDMgMTQuODgzNiAyMS40MTM0IDE2LjU1MzhDMjAuNjA2NSAxOC4yMjQgMTkuMzczNSAxOS42NTc3IDE3LjgzNTYgMjAuNzE0QzE2LjI5NzggMjEuNzcwMiAxNC41MDgxIDIyLjQxMjYgMTIuNjQyOCAyMi41Nzc4TDEyLjc1NzEgMjMuODczOEMxNC44NTE0IDIzLjY4OTQgMTYuODYxIDIyLjk2OTEgMTguNTg3OCAyMS43ODM3QzIwLjMxNDcgMjAuNTk4NCAyMS42OTkzIDE4Ljk4ODkgMjIuNjA1MiAxNy4xMTM4QzIzLjUxMTEgMTUuMjM4NyAyMy45MDcxIDEzLjE2MjcgMjMuNzU0MiAxMS4wOTA0QzIzLjYwMTIgOS4wMTgwOCAyMi45MDQ2IDcuMDIwODggMjEuNzMyOSA1LjI5NTU1QzIwLjU2MTMgMy41NzAyMiAxOC45NTUgMi4xNzYzIDE3LjA3MjQgMS4yNTExMUMxNS4xODk4IDAuMzI1OTA5IDEzLjA5NTcgLTAuMDk4NjQxMSAxMC45OTY1IDAuMDE5Mjc4N0M4Ljg5NzMzIDAuMTM3MTk4IDYuODY1NDQgMC43OTM1MiA1LjEwMTAyIDEuOTIzNTlDMy4zMzY2IDMuMDUzNjUgMS45MDA1MyA0LjYxODQ4IDAuOTM0MjY0IDYuNDYzOUwwLjg4ODU0OCA2LjU1NzA3QzAuNTgzMDgzIDcuMTgwOSAwLjM3Njg0NyA3Ljg0NzU2IDAuMjc3MTIgOC41MzM1NEMtMC4wMDg1OTQ1IDEwLjU2MDggMC40MzQyNiAxMi4zNjUxIDEuNTkxNCAxMy43NTQyQzIuODU3MTIgMTUuMjczMyA0LjkxNzEyIDE2LjE3NjggNy4zODg1NSAxNi4yOTU0QzEwLjM5NzEgMTYuNDQ1MSAxMy4zODg1IDE1LjYzNDcgMTUuNTExNCAxNC4xNDM5TDE0LjI2MjggMTMuNDAxM1oiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0xNi43OCAxNC44NzUxQzE1LjU4MjkgMTUuOTAyOSAxMi44IDE3Ljc2NjQgOC4xODI4NiAxOC4wMjA1QzMuMDE0MjkgMTguMzAyOSAwLjg2MDAwMSAxNi42NDI3IDAuODQwMDAxIDE2LjYyNTdMMC40MjI4NTYgMTcuMTMzOUwwLjg0Mjg1NiAxNi42MzQyTDAgMTcuNjMzN0MwLjA5MTQyODYgMTcuNzA5OSAyLjE1NzE0IDE5LjM1ODkgNy4wMDg1NyAxOS4zNTg5QzcuNDA1NzEgMTkuMzU4OSA3LjgyMjg2IDE5LjM1ODkgOC4yNTcxNCAxOS4zMjVDMTMuODM3MSAxOS4wMTcyIDE2LjkwMjkgMTYuNjExNiAxNy45NzE0IDE1LjU4MzhMMTYuNzggMTQuODc1MVoiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0xOS4wMiAxNi4yMTkyQzE4LjMxMjEgMTcuMTM4NyAxNy40NDA4IDE3LjkyMzMgMTYuNDQ4NiAxOC41MzQ1QzEyLjk1MTUgMjAuNzY1IDguNTAyODkgMjEuMDUzIDUuMzg4NiAyMC44OTc4TDUuMzIyODkgMjIuMTk5NEM1Ljg0NTc1IDIyLjIyNDggNi4zNDg2MSAyMi4yMzYxIDYuODM3MTggMjIuMjM2MUMxNS42MiAyMi4yMzYxIDE5LjE2ODYgMTguMjgzMiAyMC4xNiAxNi44NzE0TDE5LjAxNzIgMTYuMjA3OSIgZmlsbD0id2hpdGUiLz4KPHBhdGggZD0iTTE4LjY4NTcgMTEuMjkyMkMxOS4yNjggMTEuMjkyMiAxOS43NCAxMC44MjU3IDE5Ljc0IDEwLjI1MDNDMTkuNzQgOS42NzQ4OSAxOS4yNjggOS4yMDg0MiAxOC42ODU3IDkuMjA4NDJDMTguMTAzNCA5LjIwODQyIDE3LjYzMTQgOS42NzQ4OSAxNy42MzE0IDEwLjI1MDNDMTcuNjMxNCAxMC44MjU3IDE4LjEwMzQgMTEuMjkyMiAxOC42ODU3IDExLjI5MjJaIiBmaWxsPSJ3aGl0ZSIvPgo8L3N2Zz4K",
    },
  ];

  // Real Wallet-Standard detections only -- these are the wallets a click
  // can actually connect to right now, so they get the full row (name +
  // state + chevron) in the primary list.
  function getDisplayWallets() {
    return state.wallets.map(function (wallet) {
      return { name: wallet.name, icon: walletIconSrc(wallet), installed: true, wallet: wallet };
    });
  }

  // The known-wallet stubs, minus any already covered by a real detection
  // above (so a genuinely installed Phantom is never duplicated as its own
  // stub). Rendered as a logo-only grid further down: clicking a logo here
  // always opens that wallet's install page, since by construction none of
  // these are currently connectable.
  function getKnownWalletsGrid() {
    var detectedNames = {};
    state.wallets.forEach(function (wallet) { detectedNames[wallet.name] = true; });
    return KNOWN_WALLETS.filter(function (known) { return !detectedNames[known.name]; });
  }

  // Above this many entries, a search box appears (real Wallet Standard
  // detection is usually a handful of wallets, but this scales cleanly if a
  // browser ever has many installed at once).
  var SEARCH_THRESHOLD = 6;
  var VISIBLE = 4;

  function buildItem(display, errorBox, autofocus) {
    var li = document.createElement("li");
    var item = document.createElement("button");
    item.type = "button";
    item.className = "aw-item";
    if (autofocus) item.setAttribute("data-autofocus", "");
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
    return li;
  }

  // Logo-only entry for the "popular wallets" grid: no name/state text, just
  // the icon, with the name carried in title/aria-label for accessibility.
  // Always opens the install page -- these are, by construction, wallets
  // Wallet Standard hasn't detected in this browser.
  function buildGridItem(known) {
    var li = document.createElement("li");
    var item = document.createElement("button");
    item.type = "button";
    item.className = "aw-icon-btn";
    item.title = known.name;
    item.setAttribute("aria-label", known.name + " -- not installed, opens install page in a new tab");
    item.innerHTML = '<img src="' + known.icon + '" alt="" />';
    // A few wallets ship a white-only glyph with no background of their own
    // (drawn assuming an arbitrary colored backing); give those a dark
    // backing so the glyph doesn't disappear against the default white one.
    if (known.bg) item.querySelector("img").style.background = known.bg;
    item.addEventListener("click", function () {
      window.open(known.installUrl, "_blank", "noopener");
    });
    li.appendChild(item);
    return li;
  }

  function renderWalletList() {
    var wallets = getDisplayWallets();
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

    var searchInput = null;
    var showSearch = wallets.length > SEARCH_THRESHOLD;
    if (showSearch) {
      var searchWrap = document.createElement("div");
      searchWrap.className = "aw-search-wrap";
      searchInput = document.createElement("input");
      searchInput.type = "search";
      searchInput.className = "aw-search";
      searchInput.placeholder = "Search wallets";
      searchInput.setAttribute("aria-label", "Search Solana wallets");
      searchInput.setAttribute("data-autofocus", "");
      searchWrap.appendChild(searchInput);
      body.appendChild(searchWrap);
    }

    var list = document.createElement("ul");
    list.className = "aw-list";
    body.appendChild(list);

    var moreToggle = document.createElement("button");
    moreToggle.type = "button";
    moreToggle.className = "aw-more-toggle";
    moreToggle.hidden = true;
    var emptyMsg = document.createElement("p");
    emptyMsg.className = "aw-sheet-sub";
    emptyMsg.textContent = "No wallets match your search.";
    emptyMsg.hidden = true;

    var expanded = false;

    function paint(filterText) {
      list.innerHTML = "";
      var query = (filterText || "").trim().toLowerCase();
      var matches = query ? wallets.filter(function (w) { return w.name.toLowerCase().indexOf(query) !== -1; }) : wallets;

      // Only a real, empty-handed search should show "no matches" -- an
      // empty list with no query just means nothing's been detected yet,
      // already covered by the note above and the popular-wallets grid.
      emptyMsg.hidden = matches.length > 0 || !query;

      var shown = query || expanded ? matches : matches.slice(0, VISIBLE);
      shown.forEach(function (display, index) {
        list.appendChild(buildItem(display, errorBox, index === 0 && !searchInput));
      });

      var hiddenCount = query ? 0 : matches.length - shown.length;
      if (hiddenCount > 0) {
        moreToggle.hidden = false;
        moreToggle.textContent = "More wallets (" + hiddenCount + ")";
      } else if (!query && expanded && matches.length > VISIBLE) {
        moreToggle.hidden = false;
        moreToggle.textContent = "Show fewer wallets";
      } else {
        moreToggle.hidden = true;
      }
    }

    moreToggle.addEventListener("click", function () {
      expanded = !expanded;
      paint(searchInput ? searchInput.value : "");
    });

    if (searchInput) {
      searchInput.addEventListener("input", function () {
        paint(searchInput.value);
      });
    }

    paint("");
    body.appendChild(emptyMsg);
    body.appendChild(moreToggle);

    var knownGrid = getKnownWalletsGrid();
    if (knownGrid.length > 0) {
      var gridLabel = document.createElement("div");
      gridLabel.className = "aw-grid-label";
      gridLabel.textContent = "Popular wallets";
      body.appendChild(gridLabel);

      var grid = document.createElement("ul");
      grid.className = "aw-icon-grid";
      knownGrid.forEach(function (known) {
        grid.appendChild(buildGridItem(known));
      });
      body.appendChild(grid);
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
      '  <button type="button" class="aw-trade-btn">Buy / Sell ACT</button>' +
      '  <a class="aw-account-link" href="https://solscan.io/account/' + encodeURIComponent(address) + '" target="_blank" rel="noopener">View on Solscan ↗</a>' +
      '  <button type="button" class="aw-disconnect-btn">Disconnect</button>' +
      "</div>";
    body.appendChild(wrap);

    // All ACT trading is meant to happen through the single Jupiter Terminal
    // widget already embedded on the homepage (see index.html's trade
    // drawer) rather than a second, duplicate swap surface -- this button
    // is the wallet panel's entry point into that same widget. On the
    // homepage it opens the drawer directly; anywhere else it navigates
    // there and asks it to auto-open once loaded (see the hash check in
    // index.html's trade-drawer script).
    wrap.querySelector(".aw-trade-btn").addEventListener("click", function () {
      if (typeof window.__aretiaOpenTradeDrawer === "function") {
        closeModal();
        window.__aretiaOpenTradeDrawer();
      } else {
        window.location.href = "/#trade-act";
      }
    });

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
    // Gives Jupiter Terminal a valid (if disconnected) passthrough state as
    // soon as this file is ready, rather than only after the first real
    // connect/disconnect/discovery event -- otherwise, on a page where no
    // wallet extension is installed, syncJupiterPassthrough might never run
    // at all and the widget would fall back to its own wallet UI.
    syncJupiterPassthrough();
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
    // For Jupiter Terminal's enableWalletPassthrough / passthroughWalletContextState
    // (see index.html) -- kept up to date automatically on every connect/
    // disconnect/account-change via the listeners array, but exposed here
    // too for the widget's own initial Jupiter.init() call.
    getWalletContextState: getWalletContextState,
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
