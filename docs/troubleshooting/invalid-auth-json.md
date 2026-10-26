---
title: auth.json does not contain valid JSON
sidebar_position: 3
description: Check malformed Composer auth.json without printing Magento credentials, broker tokens or parser excerpts.
---

`"./auth.json" does not contain valid JSON` is Composer's message when that authentication file cannot be parsed.

## Cause

Composer could not parse an authentication file. The complete message begins with the quoted file path and ends with `does not contain valid JSON`. The path identifies the file that failed to parse. Parser output may include file contents; keep the original failure private.

<!-- verify: composer-auth-json — maintainer / Composer CI: repeat the malformed-auth.json CLI fixture (offline reproduction: Composer 2.10.3) on the release's supported Composer versions; confirm message suffix and that the check below never prints credential material. Offline fixture: composer install exited 1 with expected tokens STRING or closing brace. -->

This is a local syntax failure, before a vendor can accept or refuse authentication. A syntactically valid file can still contain the wrong host entry or credentials.

## Check

From the directory containing `auth.json`, run this local check. It prints only a fixed result, never the parsed data, filename or parser exception. If Composer named another authentication file, run it in that file's directory instead. It checks JSON syntax and a top-level object; it does not validate every Composer authentication field.

<!-- verify: auth-json-check — maintainer / Composer CI: PHP CLI recipe; syntax and non-echo behavior checked offline with valid, truncated, missing and non-object fixtures. This is an operator diagnostic, not a broker command. -->

```sh
php -r '
try {
    $raw = @file_get_contents("auth.json");
    if ($raw === false) { throw new RuntimeException(); }
    $auth = json_decode($raw, false, 512, JSON_THROW_ON_ERROR);
    if (!is_object($auth)) { throw new RuntimeException(); }
    echo "Authentication JSON is readable and has an object root.\n";
} catch (Throwable $error) {
    fwrite(STDERR, "Authentication JSON is unreadable or invalid.\n");
    exit(1);
}
'
```

## Fix

Repair the named file locally using valid JSON: quoted property names and strings, no comments and no trailing comma. Keep authentication files out of version control. Do not paste their contents or the parser's surrounding lines into an issue.

For the broker host, restore the entry using [Composer client setup](../clients/composer.md). For vendor credentials held by the broker, use [Vendor repositories as sources](../guides/mirror-vendor-repositories.md); those source credentials are separate from Composer's broker install token. Use the [access model token table](../reference/access-model.md) when choosing that token.

If the file passes but CI still reports `does not contain valid JSON`, check the `auth.json` in the job's Composer home (`COMPOSER_HOME`); another authentication file can produce the same message. Malformed `COMPOSER_AUTH` instead produces `COMPOSER_AUTH environment variable is malformed, should be a valid JSON object`. Repair the protected input named by the failure. Supply `COMPOSER_AUTH` through the job's secret environment, without shell tracing or a command that prints its value.

<!-- source: scripts/bench-install.mjs:251 -->
<!-- verify: composer-auth-precedence — maintainer / Composer CI: exercise job-provided COMPOSER_AUTH, project auth.json and Composer-home auth.json with the release's supported client versions; verify effective host entries without printing values. -->

After syntax is corrected, retry the install from [Marketplace HTTP 401](magento-http-401.md#check). A new HTTP authentication failure means parsing succeeded and the next check is credential placement or validity.
