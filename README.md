# Taipei: View of Elephant Mountain

**Live:** https://jhsiehm.github.io/Taipei-View-of-Elephant-Mountain/

A living pixel-art window onto Taipei 101 from the forest trail on Elephant Mountain (象山). The painted leaves sway in real wind, the city lights come on at dusk, rain rolls through, birds cross the sky, and a generated forest soundscape (insects, frogs, wind, rain) plays underneath. Everything runs in the browser from a single offline HTML file.

- **`index.html`**: the full-screen immersive view. It runs itself, with a ~10-minute day cycle, passing showers and wandering gusts. Move the mouse or tap to reveal a settings button in the top-right corner.
- **`studio.html`**: the same scene with a full control panel, a timeline scrubber, PNG save and frame-sequence export.

Both files are self-contained (all images embedded, no network requests), so you can open them by double-clicking or host them on GitHub Pages as they are.

## Using it

**Immersive view (`index.html`)**
- Tap once to start the sound (and fullscreen, on desktop). Browsers won't play audio before an interaction.
- Click or tap the scene to send a gust of wind from that spot.
- The settings button opens a menu with these options:
  - **Time:** Auto cycle, Dawn, Day, Golden hour, Blue hour, Night, or My local time
  - **Weather:** Changing, Clear, or Rain
  - **Scene:** Illustrated or Photo study
  - **View:** Immersive, Whole picture, or Close-up
- Your choices are remembered between visits.
- Keys: `O` menu · `Space` pause · `F` fullscreen · `M` sound · `Esc` close menu
- URL options: `?time=night`, `?weather=rain`, `?scene=faithful`, `?view=whole`, `?speed=20` (time-lapse).

**Studio (`studio.html`)**
- Keys: `Space` play/pause · `R` restart · `G` gust · `F` fullscreen · `S` save PNG
- Export frames writes a ZIP of numbered PNGs plus `manifest.json`. Choose 48, 240 or 480 frames over the 20-second loop; 480 frames equals 24 fps.
- Scripting hooks: `window.renderAt(t)` and `window.exportFrames(n)`.

## How it works

The two base paintings are flat images, so nothing in them is a separate layer to begin with. A preprocessing step (`tools/prep.py`) analyses each painting and produces:

| File | Contents |
|---|---|
| `assets/generated/cls_*.png` | **R:** which pixels are foliage that can move. **G:** how flexible each area is (leaf tips more than branches, near foliage more than distant trees). **B:** the layer class (sky, distant city, foliage, foreground objects, Taipei 101). **A:** the order in which window lights turn on at night. |
| `assets/generated/plate_*.png` | A clean plate: the sky and city inpainted behind the edges of the leaves, so a moving leaf never reveals a frozen copy of itself. |
| `assets/generated/falling/*.png` | Falling-leaf sprites with stray sprite-sheet fragments removed. |

At runtime, `src/taipei-engine.js` composites the scene in a WebGL fragment shader:

- **Wind:** a per-pixel wind field that bends the real painted foliage. It combines a broad gust that travels left to right, local flutter, a delayed spring response on leaf tips, and clickable radial gusts.
- **Light:** separate colour grades for sky, foliage, city and tower across day, golden hour, blue hour and night, with procedural cloud wisps, haze, light rays, stars and city lights.
- **Birds:** pixel-snapped birds that fly behind the canopy.
- **Overlay layer:** a Canvas 2D pass on top handles falling leaves, fireflies, rain and the lantern halo.
- **Deterministic loop:** all motion is a pure function of time on a 20-second loop, so frame exports are repeatable and the loop has no visible jump.
- **Fallback:** without WebGL the static painting is shown with the overlays.
- **Sound:** synthesised live with the Web Audio API. There are no audio files.

## Project layout

```
index.html            built: immersive full-screen view (open this)
studio.html           built: control-panel version
src/
  taipei-engine.js    renderer, shader, wind/light/weather model, audio, export
  immersive.html      page shell for index.html
  studio.html         page shell for studio.html
assets/
  source/             original paintings + falling-leaf sprites
  generated/          masks, flex maps, clean plates (made by tools/prep.py)
tools/
  prep.py             regenerate assets/generated from assets/source
  build.py            embed assets + engine into index.html and studio.html
```

## Building

The built HTML files are committed, so you only need this after changing the source.

```bash
pip install -r requirements.txt   # only needed for prep.py
python3 tools/prep.py             # after changing a base painting (add --debug out/ for mask previews)
python3 tools/build.py            # after changing src/ or assets/
```

`build.py` needs only the Python standard library.

## Publishing on GitHub Pages

In the repository settings, open **Pages** and set the source to deploy from the `main` branch, root folder. The site is then served at https://jhsiehm.github.io/Taipei-View-of-Elephant-Mountain/ (the first deploy takes a minute or two).

## Credits

Built by Joshua Metters. The pixel artwork comes from the Taipei asset pack this project started from. Masks, plates, renderer and sound were made for this project.
