# Contributing

Thanks for helping! Bug reports, test clips and pull requests are welcome. See the README for
setup and `npm run check` / `npm run test:py` for the checks a pull request must pass. Add
user-visible changes to [CHANGELOG.md](CHANGELOG.md) under *Unreleased*. Bug reports: attach the
diagnostics file (Settings → About → *Save diagnostics*). Security problems: [SECURITY.md](SECURITY.md).

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
