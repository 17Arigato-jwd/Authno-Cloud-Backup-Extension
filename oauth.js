/**
 * oauth.js — the PKCE round trip, v2.
 *
 * This file is most of what the v2 port is worth, so it is worth saying what
 * used to be here.
 *
 * v1 ran the whole flow inside the extension: generate a verifier, open a
 * browser through a bridge, add a `__capacitor_app_url_open` listener, match
 * the incoming URL against a redirect prefix the extension chose itself, guard
 * against a duplicate listener with a `handled` flag, race a two-minute
 * timeout, and — because the OS can kill an app while its user is on a consent
 * screen — persist the pending state to `sessionStorage` so `activate()` could
 * re-dispatch the launch URL on the next cold start. Roughly 90 lines, four of
 * them fixing race conditions found in production, and every one of them in
 * every extension that wanted OAuth.
 *
 * All of it is now `authno.auth.oauth({ authUrl, redirect })`.
 *
 * The host owns the round trip, and that is a security property rather than a
 * convenience. In v1 the extension named the redirect prefix it wanted to be
 * woken by, so an extension could have asked for `authno://auth/google` — the
 * app's OWN sign-in coming home — and read the handoff that trades for an
 * account. The host now checks that prefix against the one scheme extensions
 * are allowed, in one place, for every extension.
 *
 * What is still ours: the PKCE verifier and challenge, the state parameter,
 * and the token exchange. Those involve a secret this extension generates and
 * a client id that belongs to it, and neither should pass through the host.
 */

const PKCE_VERIFIER_BYTES = 64;
const STATE_BYTES = 16;

function base64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function randomBase64url(n) {
  return base64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function sha256Base64url(str) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return base64url(new Uint8Array(hash));
}

/**
 * Authorise, and come back with tokens.
 *
 * @param {object} authno                 the v2 host API
 * @param {object} o
 * @param {string} o.authUrl              already carrying client_id, redirect_uri, response_type
 * @param {string} o.tokenUrl
 * @param {string} o.clientId
 * @param {string} o.redirectUri          must be on the app's oauth scheme; the host enforces it
 * @param {object} [o.extraTokenParams]
 */
export async function pkceOAuthFlow(authno, {
  authUrl, tokenUrl, clientId, redirectUri, extraTokenParams = {},
}) {
  const verifier = randomBase64url(PKCE_VERIFIER_BYTES);
  const challenge = await sha256Base64url(verifier);
  const state = randomBase64url(STATE_BYTES);

  const fullAuthUrl = `${authUrl}&${new URLSearchParams({
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })}`;

  // One call. It opens the browser, waits for the redirect to land on the
  // app's scheme, closes the browser, and resolves with the query parameters.
  const params = await authno.auth.oauth({ authUrl: fullAuthUrl, redirect: redirectUri });

  // `state` is still checked here rather than trusted from the host. The host
  // guarantees the redirect is ours; it cannot know that THIS flow is the one
  // that asked for it, and two connect attempts in a row would otherwise let
  // the first one's answer settle the second.
  if (params?.state !== state) throw new Error('That sign-in did not come back the way it went out. Try again.');

  const code = params?.code;
  if (!code) {
    // A provider that refuses says so in the redirect; passing its own words
    // through beats "No auth code", which reads as our bug rather than a
    // declined consent screen.
    const why = params?.error_description ?? params?.error;
    throw new Error(why ? `Your provider refused: ${why}` : 'Your provider sent no sign-in code back.');
  }

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      ...extraTokenParams,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    throw new Error(`Token exchange failed (${tokenRes.status})${body ? `: ${body}` : ''}`);
  }

  const tokens = await tokenRes.json();
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

/** Shared by every provider that has to turn a download into base64. */
export function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
