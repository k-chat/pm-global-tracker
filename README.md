# Prime Minister's Global Tracker

**Live: https://k-chat.github.io/pm-global-tracker/**

An interactive 3D globe of the Prime Minister's foreign tours (2014–2026): every
flight leg, country visit, chartered-flight cost, and estimated carbon footprint.

The site is fully static and is published with GitHub Pages.

## Local development

```sh
npm install
npm run dev      # http://localhost:3000
```

Any static file server works too, e.g. `npx serve .`.

## Layout

| Path | Purpose |
| --- | --- |
| `index.html` | The tracker page (data and rendering code inline) |
| `style.css` | Page styles and themes |
| `vendor/` | Pinned Three.js, D3, and TopoJSON browser builds |
| `world.json` | Country geometry for the globe |
| `globe.vert.glsl`, `globe.frag.glsl` | Globe shaders |
| `data/` | Flight routes, recorded flight paths, visit costs |
| `assets/` | Rendered map imagery |
| `scripts/` | Data import/scrape helpers |
| `server.js` | Express static server for local development |

## Data sources

Flight-path stats come from flightpaths.com commercial-route records. Chartered-flight
costs come from pmindia.gov.in/en/previous-foreign-visits (2014–2019) and MEA
visit-expenditure data (2021–2026). Air India One and Indian Air Force flights are not
included.
