# Security

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/nicklashn/open-golf-tracer/security/advisories/new)
(the repository's *Security* tab → *Advisories* → *Report a vulnerability*). Only the maintainers
see the report.

Include what you found, how to reproduce it, which version (Settings → About) and how the app was
run (Windows installer or source, and `LISTEN_HOST` if you opened it to the network). Leave API
keys, tokens and private videos out of the report.

The maintainer aims to answer within a week. Fixes go into a new release, and the advisory is published once
an update is available, crediting you unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes. The app tells you when a newer version is out
(Settings → About → *Check for new versions*).

## Scope

Open Golf Tracer is a single-user app without a login that listens on 127.0.0.1 by default. Of
particular interest:

- other web sites or devices reading or changing projects (cross-site requests, DNS rebinding),
  also with `LISTEN_HOST` set;
- API keys or ChatGPT tokens reaching the browser, the logs, project data, exports or the
  diagnostics file;
- path traversal or code execution through uploaded files, project documents or exports.
