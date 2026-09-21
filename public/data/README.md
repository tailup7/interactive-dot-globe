# World surface data

## Surface color map used by the fixed dots

`surface-map.png` is a 1440 × 720 RGB lookup map. It is served locally with the
application: there is no map service, API key, or remote data request at runtime.
The renderer samples this map at the geographic location under each fixed screen
dot. Its projection is equirectangular (geographic coordinates, WGS84): longitude
−180° is the left edge, +180° the right edge, latitude +90° the top, and −90°
the bottom. Pixel centers follow that extent; longitude wraps at the date line.

The source is [Natural Earth II, 1:50m, with shaded relief and water](https://www.naturalearthdata.com/downloads/50m-raster-data/50m-natural-earth-2/).
The [official ZIP archive](https://naturalearth.s3.amazonaws.com/50m_raster/NE2_50M_SR_W.zip)
contains a 10800 × 5400 TIFF, its geographic world file, and projection notes.
Natural Earth raster and vector map data is [public domain](https://www.naturalearthdata.com/about/terms-of-use/).
Made with Natural Earth.

Natural Earth II depicts **idealized land cover**. The greens, sand/brown tones,
and pale ice are derived from that map; they are not a current satellite image
or an exact scientific classification of vegetation and desert boundaries.
The generator downsamples the real geographic map using Lanczos resampling and
emphasizes its existing blue, green, and sand hues using a continuous color ramp
so tiny dots remain distinguishable. Near-neutral ice and mountain shading keep
their source color. No procedural continents or hand-drawn desert polygons are
used. Very small islands and details may be lost at this resolution.

`surface-map.json` records the source URL, coordinate extent, processing, and
SHA-256 checksum. The generator verifies that checksum before processing, making
an upstream source change explicit.

To regenerate, install Python 3.11+ and Pillow, then run from the project root:

```sh
python -m pip install Pillow
python scripts/generate-surface-map.py
```

On Windows with the Python launcher, use `py -3.13` in place of `python`.
The generator downloads approximately 89 MB into a temporary directory and
writes only the PNG and JSON into the project. To reuse a downloaded archive:

```sh
python scripts/generate-surface-map.py --archive /path/to/NE2_50M_SR_W.zip
```
