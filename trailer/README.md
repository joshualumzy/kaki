# Kaki trailer

The 2–3 minute Kaki trailer, made in code with [Remotion](https://www.remotion.dev/). Everything on screen (the café, the characters, the call UI, the product cards) is drawn in the composition, so a change is a code or audio edit followed by a re-render.

## One-time setup

```sh
npm ci
```

`src/film/media.ts` is generated (it embeds the voice, music and sound-effect bytes) and is not in git; `npm run build` creates it.

## Preview and edit

```sh
npm run studio
```

The composition is `FilmV10` (`src/index.ts` → `src/Root.tsx`).

## Change a voice line

1. Replace the file in `audio/voices/` with the same id (e.g. `vo-open.wav`, `mei1.wav`), 48 kHz mono WAV, any length. The ids and the script are in `audio/RECORDING-LIST.md`.
2. Regenerate the timing and embedded media: `npm run build`.
3. Render again: `npm run render`.

The human sounds `src/film/sfx/mei-sigh.wav` and `raj-groan.wav` are ElevenLabs recordings. `make-sfx.mjs` regenerates the other sound effects and overwrites these two with synthetic placeholders, so put the recordings back after running it.

## Where the scenes live

- `src/film/FilmV10.tsx` — the composition: scene order, camera, audio, music and end card.
- `src/film/world.tsx` — the café counter, laptop and the street/kitchen sets.
- `src/film/stage.tsx` — the video-call UI (tiles, controls, captions).
- `src/film/cards.tsx` — the product cards (answer, catch-up, task, draft, minutes).
- `src/film/rig.tsx` — the rigged character portraits.
- `src/film/act.ts` — gestures keyed to the dialogue.
- `src/film/motion.ts` — easing and camera helpers.
- `src/film/tools.tsx` — the four tool windows (Mattermost, Gitea, calendar, Wiki.js).
- `src/film/wiki.tsx` — the team-wiki screen.
- `src/film/timeline.ts` — typed accessors for the timing data.
- `src/film/timeline.json` — generated timing data.
- `src/film/build-timeline.mjs` — rebuilds `timeline.json` and `media.ts` from the WAV lengths and levels.
- `src/film/make-sfx.mjs` — synthesises the sound effects in `src/film/sfx/`.
- `src/film/primitives.tsx` — the shared palette and spring.

The build reads the cup logo from `web/public/kaki-cup.svg` in the repo, so keep that file in place when rendering.

## Render and check

```sh
npm run render
npm run check
```

`render` writes `out/kaki-trailer.mp4` using the installed Google Chrome (macOS path; change `--browser-executable` in `package.json` for another OS). `check` needs `ffmpeg` on the PATH and fails loudly if a frame was painted as a one-frame glitch, which means re-rendering that part.

## Timing rules that still matter

- Lines are placed back-to-back with fixed gaps; the build fails if two lines come closer than 12 frames.
- Cue points inside a line (tool arrivals, the letter, edit start, the nudge card) are fractions of that line's measured duration, so they stay in proportion when a recording changes.
- The end card must sit on a bar line of the 115.02 bpm track; `FilmV10.tsx` throws if it does not. Check the cues after any re-timing.
- Keep the laptop lid in flat 2D. A 3D-transformed lid next to the flat base made Chrome flicker the base in and out.

## Credits

Voices by ElevenLabs (narrator, sighs) and Azure Speech; music: funk-joyful-rhythm-walk.
