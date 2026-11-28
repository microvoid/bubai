"""Compare Maestro captures on the same iPhone, display scale and appearance."""
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter, ImageStat

# Normalized coordinates omit the live clock and fixture-dependent message times.
REGIONS = {
    "01-home": {"community header": (.02, .071, .98, .14), "floating controls": (.14, .86, .86, .965)},
    "02-channel": {"message text": (.17, .73, .78, .815), "reply preview": (.17, .831, .72, .874), "channel header": (.01, .068, .99, .137), "composer": (.01, .905, .99, .964)},
    "03-thread": {"root message": (.17, .184, .78, .274), "reply bubble": (.17, .38, .79, .431), "thread header": (.01, .068, .99, .137), "composer": (.01, .905, .99, .964)},
}


def compare(reference, capture):
    failures = []
    for screen, regions in REGIONS.items():
        expected, actual = [Image.open(Path(folder, screen + ".png")).convert("RGB") for folder in (reference, capture)]
        if actual.size != expected.size:
            failures.append(f"{screen}: expected {expected.size}, got {actual.size}")
            continue
        for name, bounds in regions.items():
            box = tuple(round(dim * bound) for dim, bound in zip(expected.size * 2, bounds))
            a, b = [im.crop(box).filter(ImageFilter.GaussianBlur(1)) for im in (expected, actual)]
            delta = ImageChops.difference(a, b).convert("L")
            changed = sum(delta.histogram()[20:]) / (delta.width * delta.height)
            mean = ImageStat.Stat(delta).mean[0]
            if changed > .018 or mean > 1.8:
                failures.append(f"{screen} / {name}: {changed:.1%} changed, mean difference {mean:.2f}")
    if failures:
        raise SystemExit("\n".join(failures))
    print("All navigation and composer regions match.")


if __name__ == "__main__":
    compare(*sys.argv[1:])
