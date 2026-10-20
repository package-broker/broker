# Set up the first administrator

A new broker has one organization and no way to sign in. The command that creates the first administrator, `pb admin bootstrap` or `pb cloudflare setup`, issues a one-time setup token. You spend that token once, either in the browser or with two HTTP calls, to choose a password and connect an authenticator app. After that you sign in with your e-mail address, your password and a six digit code.

## What you need

- The address of the broker, for example `https://broker.example.com`. This is the public address the broker was configured with. Requests from any other origin are refused.
- The setup token. It is delivered separately from this page: printed once by the command, or written to the file you named with `--token-file`. Treat it like a password.
- An authenticator app that supports time based codes (6 digits, 30 seconds, SHA-1), or any tool that can compute them from a base32 key.

The token expires after 24 hours and works once. If it expired, was lost or was already used, run the command again to issue a fresh one; asking for a new token invalidates the old one.

## In the browser

1. Open `<broker address>/_pb/ui/setup`. The address contains no token.
2. Paste the setup token and continue.
3. Scan the QR code with your authenticator app. If you cannot scan it, type the setup key shown below the code into the app. The key is the same secret the QR code carries.
4. Choose a password, repeat it, enter the current six digit code and finish.
5. The page confirms that setup is complete and offers a button to open the broker. You are already signed in.

The token is never part of the address, so it does not reach browser history, server logs or a `Referer` header. The page keeps the token, password, setup key and code in memory only: nothing is written to browser storage, nothing is copied to the clipboard, and everything is cleared when setup finishes or you leave the page. The QR code is drawn in your browser; no external service sees the key.

If the broker gives no clear answer to the final step, the page says so and does not retry on its own. Keep the password and authenticator enrollment, then use the local-login API described below. The ordinary UI requires a session and currently has no sign-in form. If sign-in fails, ask for a fresh token and start again.

A token that is wrong, expired or already used gets the same generic refusal. The page does not say which, and it never reveals whether an account exists.

## With curl

Use this when no browser is available. Send both calls from a machine you trust, with the broker's own address in the `Origin` header and a JSON content type. The routes are the same ones the browser page uses.

Run this from a private terminal on a trusted machine. Do not use shell tracing, terminal recording or a CI job to enroll credentials. Create a private temporary directory first; the restrictive umask applies to request bodies, responses and the cookie jar. Keep the same shell open for the following steps:

```sh
set +x
umask 077
setup_dir=$(mktemp -d)
trap 'rm -rf "$setup_dir"' EXIT HUP INT TERM
```

Use a trusted local editor to create `$setup_dir/start.json` containing `{"token":"<setup token>"}`. Read the token from its separate delivery, rather than putting it in the command line or shell history. Start setup; only the HTTP status is printed:

```sh
curl --silent --show-error --fail \
  --header 'Content-Type: application/json' \
  --header "Origin: $BROKER" \
  --data-binary "@$setup_dir/start.json" \
  --output "$setup_dir/start-response.json" \
  --write-out '%{http_code}\n' \
  "$BROKER/_pb/auth/local/setup/start"
```

A `200` response file contains `provisioningUri` and `secret`. Open it in a trusted local viewer that does not upload, log, back up or retain the content. Enter `secret` in your authenticator, or render `provisioningUri` locally. Do not print this file to the terminal or paste it into a ticket, chat or CI log.

Create `$setup_dir/finish.json` in the private editor with `{"token":"<setup token>","password":"<password>","code":"<six digit code>"}`. Finish setup, saving the response and session cookies privately:

```sh
curl --silent --show-error --fail \
  --header 'Content-Type: application/json' \
  --header "Origin: $BROKER" \
  --data-binary "@$setup_dir/finish.json" \
  --output "$setup_dir/finish-response.json" \
  --cookie-jar "$setup_dir/cookies" \
  --write-out '%{http_code}\n' \
  "$BROKER/_pb/auth/local/setup/finish"
```

Success is `204`; the cookie jar holds the session for subsequent curl requests with `--cookie "$setup_dir/cookies"`. A weak password returns `400`, and a refused token or code returns `401`. Do not retry setup automatically after a connection failure: it may have finished. Use the sign-in call below with a fresh code instead. Curl cookies belong to that client; opening the ordinary UI in a separate browser does not transfer that session.

To sign in after an uncertain finish, create `$setup_dir/login.json` privately with `{"email":"<administrator e-mail address>","password":"<chosen password>","code":"<fresh six digit code>"}`. Use the same origin and protected response handling:

```sh
curl --silent --show-error --fail \
  --header 'Content-Type: application/json' \
  --header "Origin: $BROKER" \
  --data-binary "@$setup_dir/login.json" \
  --output "$setup_dir/login-response.json" \
  --cookie-jar "$setup_dir/cookies" \
  --write-out '%{http_code}\n' \
  "$BROKER/_pb/auth/local/login"
```

A `204` confirms sign-in. If it is refused, obtain a fresh setup token explicitly and restart setup. When finished, close the viewer and editor without retaining credential-bearing backups and remove all request, response and cookie files. The exit trap also removes the private directory:

```sh
rm -rf "$setup_dir"
```

## After setup

Later sign-ins use your e-mail address, password and a current code, sent to `POST /_pb/auth/local/login`. A setup token cannot be reused, and it never resets an account that has finished setup. To reset a local login on purpose, run `pb admin reset-local`.
