# Contributing

Thanks for helping! Bug reports, test clips and pull requests are welcome. See the README for
setup and `npm run check` / `npm run test:py` for the checks a pull request must pass. Add
user-visible changes to [CHANGELOG.md](CHANGELOG.md) under *Unreleased*. Bug reports: attach the
diagnostics file (Settings → About → *Save diagnostics*). Security problems: [SECURITY.md](SECURITY.md).

## Python packages

`requirements*.txt` say what is needed; `requirements-lock.txt` (what the Windows installer ships)
and `requirements-dev-lock.txt` (the same plus the test tools, used by CI) pin every package with
its hashes for all platforms. After changing a requirements file, or to update the pins, run
`npm run lock:py` (needs [uv](https://docs.astral.sh/uv/); `-- --upgrade` updates everything).

## Releasing

1. Actions → **Prepare release** → *Run workflow* on `main` with the new version (e.g. `0.5.0`).
   It sets that version everywhere (root `package.json` is the single source; the API reads it)
   on a branch `release/v0.5.0` and opens a pull request. Merge it.
2. Run **Prepare release** again with the same version. It tags `v0.5.0` on `main`, runs all of
   CI (Linux and Windows), builds the installer, installs and starts it on a clean Windows runner,
   analyses the demo clip, updates and uninstalls it, and only then creates a **draft** release
   with generated notes and the installer attached.
3. Read the draft under *Releases*, edit the notes if you like, and click **Publish**.

Pushing a tag yourself (`git tag v0.5.0 && git push origin v0.5.0`) after step 1 runs the same
build. Better not create the release in the GitHub UI any more: it is public at once, before any
check has run, and a tag that does not match `package.json` fails the build on purpose (the
installer is still added to such a release when its tag matches and everything passes). The Node, Python, FFmpeg and Inno Setup versions
the installer bundles are updated by hand in `installer/versions.psd1` (Dependabot updates the
actions, npm and Python packages).

## Licence

Open Golf Tracer is MIT licensed. By opening a pull request you agree that your contribution is
released under the same [MIT licence](LICENSE), and you confirm that you wrote it yourself or
otherwise have the right to submit it.

## Third-party code and assets

New dependencies must use a permissive licence that allows commercial use (MIT, BSD, Apache-2.0,
ISC, MPL-2.0, LGPL, SIL OFL and similar) and be listed in [docs/licensing.md](docs/licensing.md).
The installer's `THIRD_PARTY_NOTICES.txt` is generated from what is installed
(`python scripts/third_party_notices.py`).
GPL/AGPL packages cannot be added to the default install. Do not commit model weights, golf
videos you do not own, music or stock images.
