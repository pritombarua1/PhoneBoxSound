# Privacy policy

PhoneBoxSound collects no personal data. It has no account, no telemetry, no analytics and no
advertising, and it sends nothing to its author or to any server run by the project.

## What stays on your PC

PhoneBoxSound runs on your own Windows PC and serves phones on your own local network. Its settings,
the list of paired phones, their permissions and the optional two-day activity record are stored only
on that PC, next to the program (encrypted with your password once you set one). You can switch the
activity record off and erase it at any time (Activity page).

## When it contacts the internet

Only when you switch on a feature that needs it, and only with the service named:

| Feature | Service | What is sent |
|---|---|---|
| Search | YouTube (yt-dlp or your own API key), Apple's iTunes Search API, Spotify | the words you search for |
| Spotify account link | Spotify Web API | your sign-in, done on Spotify's own page; then requests for your queue, likes and playlists |
| Warning-free https address | local-ip.sh | a request for a public certificate |
| `start.bat` (source code only) | python.org / winget, pypi.org, nodejs.org, npmjs.com | downloads of the parts it needs, once |

Those services' own privacy policies apply to what they receive.

## Contact

Questions: open an issue at https://github.com/pritombarua1/PhoneBoxSound/issues.
