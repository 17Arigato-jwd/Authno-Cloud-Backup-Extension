# Changelog

All notable, user-facing changes.

## 2.0.1

_Four things that made a copy less reliable than it looked._

- **A book that failed to upload is no longer forgotten.** After five failed
  attempts the book was dropped from the queue entirely, and the status went
  back to saying everything was copied. It now stays on the list, says so, and
  is tried again the next time AuthNo starts.
- **Editing a book you have already copied no longer looks like a clash.**
  The record of when a book last went up did not survive the upload that made
  it, so the next copy of the same book compared against nothing and reported
  that both sides had changed. Answering "keep the stored one" at that point
  would have replaced newer writing with the copy this extension had just made.
- **A clash stays on the list until you deal with it.** It was removed as soon
  as the question was asked, so dismissing the question left no trace that
  anything needed attention.
- **A long copy no longer ends in a sign-in error.** When a session expired
  part way through copying many books, the renewed sign-in was used once and
  then thrown away — and with providers that retire the old one each time, the
  next attempt presented one that no longer worked.

Removing the extension, disabling it, or updating it now always detaches its
commands; a fast enough disable used to leave them attached.

## 2.0.0

_Rewritten against AuthNo's second extension API. It asks before it does
anything, and it tells you what it is asking for in words._

**Needs AuthNo 1.1.20-beta.0 or newer.** The API this is written against does
not exist in earlier versions, and installing it on one will say so rather
than failing somewhere unhelpful.

### What you will notice

- **You are asked what it may do, and each answer is separate.** Five requests,
  each with the reason it wants that thing. Refusing one does not refuse the
  rest, and refusing all of them still installs the extension.
- **Its settings are drawn by AuthNo.** They match the rest of the app and
  follow your theme, because the app renders them rather than the extension.
- **A server you name is a permission you gave.** Type a WebDAV address and you
  are shown it, on its own, before anything connects to it. It appears
  afterwards in AuthNo's Extensions tab, where you can take it back.
- **Disconnecting an account really disconnects it**, rather than forgetting it
  locally and leaving the connection open at the other end.
- **Removing the extension removes what you allowed it to do.**

### Where copies can go

Google Drive, Dropbox, or a WebDAV server you run yourself.

### Under the surface

- Sign-in uses PKCE and a checked `state` value, so a sign-in that comes back
  differently from how it went out is refused.
- Uploads are queued, retried with a widening gap, and a conflict stops the
  entry rather than retrying it forever.
- A permanently failed upload gets one fresh attempt each time AuthNo starts,
  so a book that failed five times on a bad network is not stuck.
