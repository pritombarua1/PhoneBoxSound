# Contributing

Thanks for helping! By sending a contribution you agree that it is published under the project's licence
(PolyForm Noncommercial 1.0.0, see NOTICE.md) and that Pritom Barua may also license it under other terms,
including commercial licences. The short version:

```
npm install        # web dependencies
npm run setup      # Python dependencies
npm run dev        # server + live-reloading UI at http://localhost:5173/dashboard
```

- **No Windows audio needed:** `python -m phoneboxsound --demo` runs with synthetic music and a pretend
  player, on any OS. `--test` uses a click track.
- **Before a pull request:** `npm run build` (type-checks and builds), `npm test` (Python unit tests) and
  `npm run docs` (drives the real UI with three simulated phones through every feature, and refreshes
  the screenshots). `npm run check:real` does a shorter run against a real, non-demo server on this PC.
- **Where things live:** see "Architecture" in the README. Audio timing code lives in
  `web/src/player/engine.ts` and `phoneboxsound/audio.py`; please keep it out of React render paths.
- **Bugs:** attach the diagnostics export (Dashboard → Settings → Diagnostics). It contains no tokens.
- **Security:** every message from a phone is checked on the server against that phone's permissions; a new
  message type needs its permission check, a test that a phone without it is refused, and nothing a phone
  sends may become an address, a file path or a command. See SECURITY.md for reporting a problem.
