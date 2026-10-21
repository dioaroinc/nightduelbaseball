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

The build writes `dist/web/index.html`; the published site is `index.html` at the repository root.
