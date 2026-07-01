// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// googlechat-outbound-auth.ts — load-time patch that moves Google Chat OUTBOUND
// authentication off the in-sandbox service-account key and onto a
// gateway-minted token. Boot-injected into the OpenClaw gateway via
// runtime.nodePreloads, gated to when the googlechat channel is active.
//
// ── The story: what this changes, and why ────────────────────────────────────
// Out of the box @openclaw/googlechat mints its own OAuth token IN-PROCESS: it
// RS256-signs a JWT assertion with the service-account (SA) PRIVATE KEY and
// exchanges it at oauth2.googleapis.com for an access token. That requires the
// SA private key to live inside the sandbox (delivered today as a file), which
// deviates from NemoClaw's security model — secrets should never sit in the
// sandbox; the L7 egress proxy materializes them only on outbound requests.
//
// OpenShell can instead mint the Google access token GATEWAY-SIDE from the SA
// key (ProviderCredentialRefreshStrategy google_service_account_jwt) and inject
// it onto outbound chat.googleapis.com requests via the standard credential
// rewrite. In that model the sandbox only ever sees the placeholder
// `openshell:resolve:env:GOOGLE_CHAT_ACCESS_TOKEN`, never the key.
//
// The single producer of the outbound bearer in the plugin is
// `getGoogleChatAccessToken(account)` (auth.ts), funnelled through the one
// request wrapper that stamps `Authorization: Bearer <token>` on every
// chat.googleapis.com call. This preload rewrites that producer at module load
// so it returns the OpenShell-provided credential env value (the placeholder)
// instead of constructing a google-auth client and signing locally. The proxy
// then rewrites the placeholder in the Authorization header to the real minted
// token — the same outbound-placeholder path every other channel uses.
//
// INBOUND webhook JWT verification is untouched: it uses Google's PUBLIC certs
// + appPrincipal (no SA material) and a different code path, so it is unaffected
// by this patch (its cert fetch is handled by the separate
// googlechat-trusted-proxy-fetch patch).
//
// ── Contract with the B-side wiring ──────────────────────────────────────────
// The OpenShell provider's injectable credential key MUST be
// `GOOGLE_CHAT_ACCESS_TOKEN`. When the provider is wired the gateway env carries
// a REVISION-STAMPED placeholder `openshell:resolve:env:vNNN_GOOGLE_CHAT_ACCESS_TOKEN`.
// This patch detects the credential is wired (env set) and returns the REVISION-LESS
// alias `openshell:resolve:env:GOOGLE_CHAT_ACCESS_TOKEN` so the proxy always resolves
// to the LATEST refreshed token — the revision-stamped form pins to the boot token,
// which expires (~1h) and is not refreshed in a long-running process. When the env is
// UNSET (provider not wired) the patch falls through to the original in-process mint,
// so the channel keeps working on the legacy SA-file path — inert until the B-side lands.
//
// ── Long-term fix (remove this once it lands) ─────────────────────────────────
// The clean fix is upstream in OpenClaw: a native pre-minted-token auth mode
// (e.g. `accessToken`/`accessTokenRef`) on @openclaw/googlechat that skips
// in-process minting and sends the bearer directly. When that ships, drop this
// preload module and its `runtime.openclaw.nodePreloads` entry in the manifest.
//
// Mechanism mirrors slack-channel-guard.ts (load-time source rewrite of an
// @openclaw/* dist module via the module loader hooks).

(function () {
  "use strict";

  // The injectable OpenShell credential key (and sandbox env var) that carries
  // the outbound bearer placeholder. Co-designed with the B-side provider:
  // `provider refresh configure --credential-key GOOGLE_CHAT_ACCESS_TOKEN`.
  var ENV_VAR = "GOOGLE_CHAT_ACCESS_TOKEN";

  // Idempotency / shape markers.
  var CALL_MARKER = "nemoclaw: googlechat outbound bearer via gateway-minted credential";
  var DEF_SIGNATURE = "function getGoogleChatAccessToken";

  if (process.__nemoclawGooglechatOutboundAuthInstalled) return;
  try {
    Object.defineProperty(process, "__nemoclawGooglechatOutboundAuthInstalled", { value: true });
  } catch (_e) {
    process.__nemoclawGooglechatOutboundAuthInstalled = true;
  }

  function isOpenClawGooglechatFile(filename) {
    var normalized = String(filename || "").replace(/\\/g, "/");
    return normalized.indexOf("/@openclaw/googlechat/") !== -1 && normalized.endsWith(".js");
  }

  // The guard injected at the top of getGoogleChatAccessToken's body. When the
  // OpenShell-provided credential is present (the env var is set), return the
  // REVISION-LESS placeholder `openshell:resolve:env:<KEY>` — NOT the env var's
  // own value. The sandbox env holds a *revision-stamped* placeholder
  // (`openshell:resolve:env:vNNN_<KEY>`) that the proxy pins to the BOOT token;
  // that token expires (~1h, Google SA tokens) and is NOT refreshed inside a
  // long-running gateway process, so returning it directly makes outbound replies
  // die after the first token lifetime ("credential is expired"). The revision-less
  // alias always resolves to the LATEST refreshed token (gateway re-mints on
  // schedule). Falls back to the raw value for non-OpenShell deployments. Built as
  // a single line (no template-literal escaping) for a clean source rewrite.
  function buildBearerShortCircuitSource() {
    var canonical = "openshell:resolve:env:" + ENV_VAR;
    return (
      'try { var __nemoGcRaw = (typeof process !== "undefined" && process.env) ' +
      "? process.env." +
      ENV_VAR +
      ' : void 0; if (typeof __nemoGcRaw === "string" && __nemoGcRaw.length > 0) { ' +
      'return __nemoGcRaw.indexOf("openshell:resolve:env:") === 0 ? "' +
      canonical +
      '" : __nemoGcRaw; } } catch (_e) {} /* ' +
      CALL_MARKER +
      " */"
    );
  }

  function patchGooglechatOutboundAuthSource(source, filename) {
    // Only the dist chunk that DEFINES the producer is a patch target; files that
    // merely call/import it (substring without the `function` keyword) pass through.
    if (source.indexOf(DEF_SIGNATURE) === -1) return source;
    // Already patched (idempotent across repeated --require of this preload).
    if (source.indexOf(CALL_MARKER) !== -1) return source;

    var anchor = /((?:async\s+)?function getGoogleChatAccessToken\s*\(([^)]*)\)\s*\{)/;
    if (!anchor.test(source)) {
      // The definition substring is present but not in the expected shape — the
      // bundled plugin drifted. Fail loud (named patch error) rather than silently
      // leave outbound auth on the in-process SA path.
      throw new Error(
        "OpenClaw Google Chat getGoogleChatAccessToken definition shape not recognized in " +
          filename +
          "; outbound-auth patch not applied",
      );
    }
    return source.replace(anchor, "$1\n  " + buildBearerShortCircuitSource());
  }

  function isGooglechatOutboundAuthPatchError(reason) {
    var msg = String((reason && reason.message) || reason || "");
    return (
      msg.indexOf("OpenClaw Google Chat getGoogleChatAccessToken") !== -1 &&
      msg.indexOf("shape not recognized") !== -1
    );
  }

  function fileNameFromModuleUrl(urlValue) {
    if (typeof urlValue !== "string" || !urlValue.startsWith("file:")) return "";
    try {
      return require("url").fileURLToPath(urlValue);
    } catch (_e) {
      return "";
    }
  }

  function sourceToText(source) {
    if (typeof source === "string") return source;
    if (typeof Buffer !== "undefined") {
      if (Buffer.isBuffer(source)) return source.toString("utf8");
      if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
      if (source instanceof ArrayBuffer) return Buffer.from(source).toString("utf8");
    }
    return null;
  }

  function installGooglechatOutboundAuthPatch() {
    var Module = require("module");
    var fs = require("fs");
    var originalJsLoader = Module._extensions && Module._extensions[".js"];
    if (typeof originalJsLoader === "function") {
      Module._extensions[".js"] = function nemoclawGooglechatJsLoader(mod, filename) {
        if (isOpenClawGooglechatFile(filename)) {
          var source = fs.readFileSync(filename, "utf8");
          var patched = patchGooglechatOutboundAuthSource(source, filename);
          if (patched !== source) {
            return mod._compile(patched, filename);
          }
        }
        return originalJsLoader.apply(this, arguments);
      };
    }

    if (typeof Module.registerHooks === "function") {
      Module.registerHooks({
        load: function nemoclawGooglechatLoadHook(urlValue, context, nextLoad) {
          var result = nextLoad(urlValue, context);
          var filename = fileNameFromModuleUrl(urlValue);
          if (!isOpenClawGooglechatFile(filename)) return result;
          var sourceText = sourceToText(result && result.source);
          if (sourceText === null) return result;
          var patched = patchGooglechatOutboundAuthSource(sourceText, filename);
          if (patched === sourceText) return result;
          return Object.assign({}, result, { source: patched });
        },
      });
    }
  }

  try {
    installGooglechatOutboundAuthPatch();
    process.stderr.write(
      "[channels] [googlechat] outbound-auth patch active " +
        "(gateway-minted bearer via " +
        ENV_VAR +
        " when wired; falls back to in-process mint otherwise)\n",
    );
  } catch (e) {
    if (isGooglechatOutboundAuthPatchError(e)) {
      // Shape drift: surface loudly but do not crash gateway startup — the
      // channel degrades to the legacy in-process SA mint.
      process.stderr.write(
        "[channels] [googlechat] outbound-auth patch NOT applied: " + String(e && e.message) + "\n",
      );
    }
    // Any other failure: never break gateway boot.
  }
})();
