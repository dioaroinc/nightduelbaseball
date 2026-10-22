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

## Loading bar

`loader.html` is the shared loading screen (dark screen with a LOADING bar). `python3 tools/apply-loader.py` copies it into every page (hub, tennis, clay, bowling, and `index.src.html` for baseball; run `node build.js` and copy `dist/web/index.html` to `baseball/index.html` after). The same script makes the Google Fonts stylesheet load without blocking the first paint and adds `defer` to `firebase-config.js` / `track.js`. The baseball page loads the Firebase SDK only when a friend game opens (`window.ndLoadFirebase`), and prefetches it once the page is idle.

## Break Point Tennis

`tennis/index.html` is a self-contained page (no build step) served at weplaysportsgames.com/tennis/. One set against the CPU with real scoring (tiebreak at 6-6), hard/clay/grass courts, right- or left-handed player. Hold to start a one-second power gauge, slide to aim, let go as the ball arrives. It loads the shared `firebase-config.js` and `track.js`, so visits and games show under tennis on the admin page.

## Sky Shot Clay

`clay/index.html` is a self-contained page (no build step) served at weplaysportsgames.com/clay/. Clay shooting against your own score: 6 rounds of 15 targets (trap straight, trap wide, skeet high house, skeet low house, driven birds, fast mixed), Easy/Normal/Pro. One thumb: press and hold (FIRE button or anywhere) to call PULL and mount the gun, slide the thumb to swing the gun (the view turns with it), let go to fire. The sight ring grows as the gauge fills, then shrinks if held too long. Shot travels at a set speed, so crossing clays need lead. It loads the shared `firebase-config.js` and `track.js`, so visits and games show under 클레이 사격 on the admin page.

## Strike Lane Bowling

`bowling/index.html` is a self-contained page (no build step) served at weplaysportsgames.com/bowling/. Ten-pin bowling against your own score: 10 frames with real scoring (strike and spare bonuses, up to three balls in the 10th), Easy/Normal/Pro. Slide the left stick to move along the foul line, set the spin with the curved arrows (the ball skids through the oil, then hooks near the pins), hold the right THROW button and let go at the top of the gauge for full speed. Ball and pins run on a small top-down physics model (ball-pin and pin-pin collisions, falling pins knock over their neighbors). Easy has bumpers and shows the whole path; Normal and Pro show no path. It loads the shared `firebase-config.js` and `track.js`, so visits and games show under 볼링 on the admin page.
