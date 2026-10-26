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

`loader.html` is the shared loading screen (dark screen with a LOADING bar). `python3 tools/apply-loader.py` copies it into every page (hub, tennis, clay, bowling, soccer, basketball, ballboy, and `index.src.html` for baseball; run `node build.js` and copy `dist/web/index.html` to `baseball/index.html` after). The same script makes the Google Fonts stylesheet load without blocking the first paint and adds `defer` to `firebase-config.js` / `track.js`. The baseball page loads the Firebase SDK only when a friend game opens (`window.ndLoadFirebase`), and prefetches it once the page is idle.

## Daily play limit

`playtime.js` limits play to 30 minutes a day per device (localStorage, resets at local midnight). It counts time on game pages while the tab is visible and the player touched the screen in the last minute; the hub shows the time left. When time runs out mid-game a note says to finish the game, and after 3 more minutes (or when a new game starts) a "That's all for today" screen covers the page. A device logged in to `admin/` has no limit. Change `LIMIT_MIN` / `GRACE_MIN` at the top of `playtime.js`, then run `python3 tools/apply-loader.py`, `node build.js` and copy `dist/web/index.html` to `baseball/index.html`, since the script is copied inline into every page.

## Break Point Tennis

`tennis/index.html` is a self-contained page (no build step) served at weplaysportsgames.com/tennis/. One set against the CPU with real scoring (tiebreak at 6-6), hard/clay/grass courts, right- or left-handed player. Hold to start a one-second power gauge, slide to aim, let go as the ball arrives. It loads the shared `firebase-config.js` and `track.js`, so visits and games show under tennis on the admin page.

## Sky Shot Clay

`clay/index.html` is a self-contained page (no build step) served at weplaysportsgames.com/clay/. Clay shooting against your own score: 6 rounds of 15 targets (trap straight, trap wide, skeet high house, skeet low house, driven birds, fast mixed), Easy/Normal/Pro. One thumb: press and hold (FIRE button or anywhere) to call PULL and mount the gun, slide the thumb to swing the gun (the view turns with it), let go to fire. The sight ring grows as the gauge fills, then shrinks if held too long. Shot travels at a set speed, so crossing clays need lead. Friend games use the same 4-digit room codes as baseball (Firebase `rooms/nd-<code>`): the room creator's phone throws each clay with a launch time on the server clock so both phones fly the same clay together, each phone judges its own shot, and the creator gives the point to whoever hit first (15, 45 or 90 clays). It loads the shared `firebase-config.js` and `track.js`, so visits and games show under 클레이 사격 on the admin page.

## Strike Lane Bowling

`bowling/index.html` is a self-contained page (no build step) served at weplaysportsgames.com/bowling/. Ten-pin bowling against your own score: 10 frames with real scoring (strike and spare bonuses, up to three balls in the 10th), Easy/Normal/Pro. Slide the left stick to move along the foul line, set the spin with the curved arrows (the ball skids through the oil, then hooks near the pins), hold the right THROW button and let go at the top of the gauge for full speed. Ball and pins run on a small top-down physics model (ball-pin and pin-pin collisions, falling pins knock over their neighbors). Easy has bumpers and shows the whole path; Normal and Pro show no path. It loads the shared `firebase-config.js` and `track.js`, so visits and games show under 볼링 on the admin page.

## Spot Kick Showdown

`soccer/index.html` is a self-contained page (no build step) served at weplaysportsgames.com/soccer/. A penalty shootout against the CPU: you take turns shooting and keeping goal, 5 kicks each, then sudden death. Easy/Normal/Pro. One thumb: when you shoot, hold anywhere to fill the power (let go while it says FULL; past that the ball rises), slide to move the target in the goal, let go to kick. In goal, hold once the kicker starts the run-up, slide the glove to where you think the ball is going, let go to dive. Dive too early and the CPU kicker may put it the other way; on Easy the kicker gives the side away. The rules and kick physics sit between `// CORE-START` and `// CORE-END` (no DOM), so they can be run in node to tune the levels. Friend games use the same 4-digit room codes (Firebase `rooms/nd-<code>`): the room creator shoots first; the kicker's phone sends the ball's path and the moment it is struck (server clock, one run-up ahead), the keeper's phone sends when and where it dived, and both phones work out the same result (5 or 10 kicks each). It loads the shared `firebase-config.js` and `track.js`, so visits and games show under 축구 on the admin page.

## Swish Shot Basketball

`basketball/index.html` is a self-contained page (no build step) served at weplaysportsgames.com/basketball/. A 60-second shooting game: score as many points as you can from five spots around the key (you move to the next spot every 3 shots). A basket is 2, a clean swish (no rim, no board) is 3, and 3 in a row puts you on fire (+1 per basket until you miss). Easy/Normal/Pro. One thumb: hold anywhere to fill the power, let go at the top while it says SWISH (early is short, late is long; on Normal and Pro the fill speed changes a little from shot to shot), and slide left or right while holding to keep the target on the rim against the hand's drift. The ball flies on real projectile physics and bounces off the rim, the backboard and the floor; the rules and physics sit between `// CORE-START` and `// CORE-END` (no DOM), so they can be run in node to tune the levels. Modes: vs the CPU (its score ticks up on its own hoop), solo against your best for the level, and friend games with the same 4-digit room codes (Firebase `rooms/nd-<code>`): the room creator sets a start time on the server clock, both phones shoot for the same 60 seconds and share their live score. It loads the shared `firebase-config.js` and `track.js`, so visits and games show under 농구 on the admin page.

`ballboy/index.html` is a self-contained page (no build step) served at weplaysportsgames.com/ballboy/. Ball Boy Dash: your tennis lesson just ended and you pick up the 100 balls you hit while the next student's lesson starts on the same court, so their shots come at you (a dodge game in the style of a top-down shooter). The lesson starts straight away: the coach feeds 100 balls in four drills (rally, volley bursts, lobs and smashes, rapid basket drill) and the student hits each one into your half. One thumb: push the wheel in the strip under the court to run (further = faster), run over balls to pick them up. The camera sits a little behind your baseline, so your half is big and the far half small, and the view is cropped to the court (from your back fence to the far baseline); `fitCam` picks the lowest camera angle that still fills the screen height. A red circle marks where each shot will land (on Beginner from the coach's feed, otherwise from the student's hit). The level is the next student: Beginner (slow, 3 hits allowed), Club (2 hits), Tour pro (very fast, aimed at you more, 1 hit). A hit knocks up to 4 balls out of your basket. Score: 10 per ball picked up, 5 per shot that lands without hitting you, plus a bonus for clearing the court early and for no hits. Level and lesson rules sit between `// CORE-START` and `// CORE-END`. It loads the shared `firebase-config.js` and `track.js`, so visits and games show under 볼보이 on the admin page.
