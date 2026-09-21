"""Build the local, equirectangular surface lookup used by the fixed dot grid.

Requires Python 3.11+ and Pillow (`python -m pip install Pillow`). The default
run downloads an 89 MB public-domain Natural Earth archive into a temporary
directory. Use --archive /path/to/NE2_50M_SR_W.zip to reuse an existing download.
Only the small PNG and its provenance JSON are written to the project.
"""

import argparse
import colorsys
import hashlib
import json
import tempfile
from io import BytesIO
from pathlib import Path
from urllib.request import Request, urlopen
from zipfile import ZipFile

from PIL import Image


SOURCE_URL = "https://naturalearth.s3.amazonaws.com/50m_raster/NE2_50M_SR_W.zip"
SOURCE_SHA256 = "7e0e07089b699a3cccad98dd1b2446390d8e3f8c5006359d477a329cebcafaa9"
SOURCE_TIFF = "NE2_50M_SR_W/NE2_50M_SR_W.tif"
OUTPUT = Path(__file__).resolve().parents[1] / "public" / "data"
SIZE = (1440, 720)


def smoothstep(start, end, value):
    amount = max(0, min(1, (value - start) / (end - start)))
    return amount * amount * (3 - 2 * amount)


def enhance_surface_color(pixel):
    """Emphasize the existing map colors without inventing geographic regions.

    Natural Earth II is an idealized land-cover map, not a live biome dataset.
    Its pastel hues already distinguish water, vegetation, and arid terrain.
    A continuous color ramp makes those distinctions readable in tiny dots.
    Near-neutral ice and mountain shading retain their source color.
    """
    channels = tuple(channel / 255 for channel in pixel)
    hue, saturation, value = colorsys.rgb_to_hsv(*channels)
    hue *= 360
    brightness = 0.60 + 0.40 * value
    if 175 <= hue <= 260:
        target = (0.22, 0.54, 0.94)  # Blue source pixels: water.
    else:
        vegetation = smoothstep(48, 100, hue) if hue < 175 else 0
        sand = (0.96, 0.73, 0.43)
        green = (0.33, 0.86, 0.47)
        target = tuple(
            dry + (leaf - dry) * vegetation for dry, leaf in zip(sand, green)
        )
    strength = smoothstep(0.035, 0.17, saturation)
    return tuple(
        round(255 * (original + (enhanced * brightness - original) * strength))
        for original, enhanced in zip(channels, target)
    )


def download_archive(destination):
    print(f"Downloading Natural Earth II from {SOURCE_URL}", flush=True)
    request = Request(SOURCE_URL, headers={"User-Agent": "interactive-dot-globe/1.0"})
    with urlopen(request, timeout=60) as response, destination.open("wb") as file:
        while block := response.read(1024 * 1024):
            file.write(block)


def generate(archive):
    with archive.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != SOURCE_SHA256:
        raise ValueError("Source archive checksum changed; verify upstream before regenerating.")

    with ZipFile(archive) as files:
        # Read once: TIFF decoding seeks frequently, which is slow on ZipExtFile.
        with Image.open(BytesIO(files.read(SOURCE_TIFF))) as source:
            if source.size != (10800, 5400):
                raise ValueError(f"Unexpected source extent: {source.size}")
            surface = source.convert("RGB").resize(SIZE, Image.Resampling.LANCZOS)

    surface.putdata([enhance_surface_color(pixel) for pixel in surface.getdata()])
    OUTPUT.mkdir(parents=True, exist_ok=True)
    surface.save(OUTPUT / "surface-map.png", optimize=True)
    metadata = {
        "title": "Natural Earth II surface colors for a fixed screen dot globe",
        "width": SIZE[0],
        "height": SIZE[1],
        "projection": "Equirectangular (WGS84)",
        "bounds": {"west": -180, "east": 180, "north": 90, "south": -90},
        "source": "Natural Earth II, 1:50m, shaded relief and water",
        "sourceUrl": SOURCE_URL,
        "sourceSha256": SOURCE_SHA256,
        "sourcePage": "https://www.naturalearthdata.com/downloads/50m-raster-data/50m-natural-earth-2/",
        "license": "Public domain",
        "licenseUrl": "https://www.naturalearthdata.com/about/terms-of-use/",
        "processing": "Lanczos downsampling; continuous blue/green/sand color enhancement from source hues; neutral ice retained.",
        "limitation": "Idealized historical land cover, not current satellite imagery or a precise biome classification.",
    }
    (OUTPUT / "surface-map.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote {OUTPUT / 'surface-map.png'} ({SIZE[0]} x {SIZE[1]})", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Reuse a downloaded source ZIP")
    args = parser.parse_args()
    if args.archive:
        generate(args.archive)
    else:
        with tempfile.TemporaryDirectory(prefix="interactive-dot-globe-") as temporary:
            archive = Path(temporary) / "NE2_50M_SR_W.zip"
            download_archive(archive)
            generate(archive)


if __name__ == "__main__":
    main()
