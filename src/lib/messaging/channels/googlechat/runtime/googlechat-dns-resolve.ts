// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// googlechat-dns-resolve.ts — TEMPORARY interim workaround that lets the Google
// Chat channel verify inbound request JWTs inside the proxy-only NemoClaw
// sandbox. Boot-injected into the gateway via runtime.nodePreloads, gated to
// when the googlechat channel is active.
//
// ── The story: what breaks, and why ──────────────────────────────────────────
// NemoClaw runs the OpenClaw gateway inside an OpenShell sandbox network
// namespace that is intentionally DNS-LESS: it has only `lo` plus a veth to the
// L7 egress proxy (10.200.0.1). There is no eth0 and no reachable resolver —
// Docker's embedded resolver (127.0.0.11) lives in the *main* container netns,
// which the sandbox netns cannot reach (its 127/8 loopback is empty). By design
// every name lookup is the proxy's job: the gateway dials the proxy and the
// proxy resolves + policy-checks the hostname (this is why inference and
// web_fetch work). `scripts/nemoclaw-start.sh` even warns that forcing a direct
// in-sandbox DNS lookup is broken.
//
// Google Chat verifies each inbound webhook by fetching Google's signing certs
// (google-auth-library `getFederatedSignonCerts`). OpenClaw runs that fetch
// through `fetchWithSsrFGuard`, which — in its default STRICT / managed-proxy
// modes — performs a LOCAL `getaddrinfo(www.googleapis.com)` to SSRF-check the
// target BEFORE the proxied request. In this DNS-less netns that local lookup
// fails with `EAI_AGAIN`, so cert retrieval fails, every inbound JWT is
// rejected, and the bot silently never replies.
//
// ── What we tried / ruled out ─────────────────────────────────────────────────
//   • Confirmed the secret-file delivery + webhook registration already work;
//     only the cert-fetch DNS step fails.
//   • Confirmed the proxied fetch itself works: a `fetch()` to
//     https://www.googleapis.com/oauth2/v1/certs through the proxy returns 200,
//     and the channel's network-policy preset already allows the host. So once
//     resolution succeeds the cert fetch goes through the proxy by hostname.
//   • Confirmed only OpenClaw's TRUSTED_ENV_PROXY guard mode skips the local
//     lookup — that is a caller (OpenClaw) decision; no NemoClaw env/config knob
//     flips it.
//   • Rejected a UDP DNS forwarder / resolv.conf repoint: it would re-introduce
//     general local DNS into a deliberately DNS-less sandbox — a DNS-exfil /
//     policy-bypass egress regression. The entrypoint also runs as the
//     unprivileged `sandbox` user here and cannot write /etc/hosts.
//
// ── What this preload does (narrow + isolation-preserving) ────────────────────
// It patches Node's DNS `lookup` to answer ONLY the three Google Chat API hosts
// with a fixed public sentinel IP, so OpenClaw's SSRF guard sees a public
// address and proceeds. The address is never dialed: the real connection still
// goes through the L7 proxy BY HOSTNAME (proven), so this opens no new DNS or
// egress channel — every other hostname still resolves the normal way (i.e.
// still has no local DNS and still goes via the proxy). The sentinel only has to
// pass OpenClaw's "is this a public IP?" gate.
//
// ── Long-term fix (remove this once it lands) ─────────────────────────────────
// The correct fix is upstream in OpenClaw: make the Google Chat / google-auth
// cert fetch use the trusted-env-proxy guard mode (no local pre-resolution) when
// a managed/env proxy is configured — the same change OpenClaw already shipped
// for web_fetch (openclaw#50650). When that ships, delete this preload module
// and its `runtime.openclaw.nodePreloads` entry in the googlechat manifest.

(function () {
  "use strict";

  // Any stable public IPv4 works: it is only used to pass OpenClaw's SSRF
  // "public address" gate. The actual TLS connection is made by the L7 proxy
  // using the hostname, so this address is never connected to.
  var SENTINEL_PUBLIC_IPV4 = "142.250.190.78";

  // Hosts the Google Chat channel resolves: cert verification + OAuth token +
  // outbound message send. Keep in sync with the googlechat network-policy
  // preset (nemoclaw-blueprint/policies/presets/googlechat.yaml).
  var GOOGLECHAT_HOSTS = {
    "www.googleapis.com": true,
    "oauth2.googleapis.com": true,
    "chat.googleapis.com": true,
  };

  function isGooglechatHost(hostname) {
    return Object.prototype.hasOwnProperty.call(GOOGLECHAT_HOSTS, String(hostname || "").toLowerCase());
  }

  function patchCallbackLookup(mod) {
    if (!mod || mod.__nemoclawGooglechatDnsPatched) return;
    var orig = mod.lookup;
    if (typeof orig === "function") {
      mod.lookup = function (hostname, options, callback) {
        var cb = typeof options === "function" ? options : callback;
        var opts = typeof options === "function" ? {} : options || {};
        if (typeof cb === "function" && isGooglechatHost(hostname)) {
          var record = { address: SENTINEL_PUBLIC_IPV4, family: 4 };
          if (opts && opts.all) {
            process.nextTick(cb, null, [record]);
          } else {
            process.nextTick(cb, null, record.address, record.family);
          }
          return;
        }
        return orig.call(this, hostname, options, callback);
      };
    }
    try {
      Object.defineProperty(mod, "__nemoclawGooglechatDnsPatched", { value: true });
    } catch (_e) {
      mod.__nemoclawGooglechatDnsPatched = true;
    }
  }

  function patchPromiseLookup(mod) {
    if (!mod || mod.__nemoclawGooglechatDnsPatched) return;
    var orig = mod.lookup;
    if (typeof orig === "function") {
      mod.lookup = function (hostname, options) {
        var opts = options || {};
        if (isGooglechatHost(hostname)) {
          var record = { address: SENTINEL_PUBLIC_IPV4, family: 4 };
          return Promise.resolve(opts.all ? [record] : record);
        }
        return orig.call(this, hostname, options);
      };
    }
    try {
      Object.defineProperty(mod, "__nemoclawGooglechatDnsPatched", { value: true });
    } catch (_e) {
      mod.__nemoclawGooglechatDnsPatched = true;
    }
  }

  try {
    var dns = require("node:dns");
    patchCallbackLookup(dns);
    if (dns && dns.promises) patchPromiseLookup(dns.promises);
    patchPromiseLookup(require("node:dns/promises"));
    process.stderr.write(
      "[channels] [googlechat] DNS resolver shim active for googleapis hosts " +
        "(interim sandbox DNS workaround; resolution still proxied by hostname)\n",
    );
  } catch (_e) {
    // Never break gateway startup: if the shim cannot install, the channel
    // simply remains in its pre-fix (cert-fetch EAI_AGAIN) state.
  }
})();
