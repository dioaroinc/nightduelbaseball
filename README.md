# Night Duel Baseball

A mobile web baseball game: pitcher vs. batter, one on one, forever. Roles switch every three outs.
Play against a league-average MLB CPU, or with a friend on another phone using a 4-digit room code.

## Play

Open the GitHub Pages link for this repository on your phone.

## Build

```
node build.js
```

- `engine.js` rules, pitch physics, CPU AI, batted-ball outcomes
- `game.js` rendering, controls, stats, multiplayer
- `index.src.html` page markup and styles
- `firebase-config.js` Firebase web config used by the public build for multiplayer
- `sim.js` simulates 60,000 CPU vs CPU plate appearances to check the MLB-average tuning (`node sim.js`)

The build writes `dist/web/index.html`; the published game is `baseball/index.html` (served at weplaysportsgames.com/baseball/).
The repository root `index.html` is the game picker for the site; each sport lives in its own folder (`baseball/`, later `tennis/` and so on) with its own manifest, service worker and icons. `admin/` is the usage stats page.

## Break Point Tennis

`tennis/index.html` is a self-contained page (no build step) served at weplaysportsgames.com/tennis/. One set against the CPU with real scoring (tiebreak at 6-6), hard/clay/grass courts, right- or left-handed player. Hold to start a one-second power gauge, slide to aim, let go as the ball arrives. It loads the shared `firebase-config.js` and `track.js`, so visits and games show under tennis on the admin page.
