# Code signing policy

Releases of PhoneBoxSound for Windows are built, tested and published automatically by GitHub Actions
from the public source code in this repository ([.github/workflows/release.yml](.github/workflows/release.yml)).
No release file is built on a personal computer.

Free code signing for open-source projects is requested from [SignPath.io](https://signpath.io), with a
certificate by the [SignPath Foundation](https://signpath.org). Until it is granted, releases are
published unsigned, and the release notes say so.

## Roles

| Role | Who |
|---|---|
| Committers and reviewers | [Pritom Barua](https://github.com/pritombarua1) |
| Approvers (approve each signing request) | [Pritom Barua](https://github.com/pritombarua1) |

Every release is approved by hand before it is signed. Contributions from others are reviewed before
they are merged.

## What gets signed

Only `PhoneBoxSound.exe` and the files built from this repository's source for the Windows download.
Third-party files bundled with it keep their own publishers' signatures.

## Privacy

PhoneBoxSound does not send any information to the author or to any other networked system unless the
user asks for it: it serves phones on the user's own local network, and contacts outside services
(Spotify, YouTube, iTunes search, the local-ip.sh certificate) only when the user switches those features
on. There is no telemetry, analytics or account. See [DISCLAIMER.md](DISCLAIMER.md).
