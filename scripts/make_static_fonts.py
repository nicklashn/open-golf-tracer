"""Builds the static, Latin-subset font instances in assets/fonts/static from the variable fonts.

Usage: python scripts/make_static_fonts.py

The renderer draws glyph outlines itself (packages/render/src/text.ts), so it needs one static
file per weight. Subsets are "Modified Versions" under the SIL OFL; fonts with a Reserved Font
Name are renamed (see docs/licensing.md).
"""
from __future__ import annotations

from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets/fonts"
OUT = SRC / "static"

# (source file, output stem, weights, renamed family or None)
FONTS = [
    ("Inter-Variable.ttf", "Inter", [400, 500, 600, 700, 800, 900], None),
    ("Oswald-Variable.ttf", "Oswald", [400, 500, 600, 700], None),
    ("BebasNeue-Regular.ttf", "BebasNeue", [400], None),
    ("BarlowCondensed-Medium.ttf", "BarlowCondensed", [500], None),
    ("BarlowCondensed-SemiBold.ttf", "BarlowCondensed", [600], None),
    ("BarlowCondensed-Bold.ttf", "BarlowCondensed", [700], None),
    ("PlayfairDisplay-Variable.ttf", "SerifDisplay", [400, 600, 700, 800], ("Playfair Display", "GT Serif Display")),
]
# Basic Latin, Latin-1, Latin Extended-A, general punctuation, degree/multiply signs, € and arrows.
UNICODES = [*range(0x20, 0x7F), *range(0xA0, 0x180), *range(0x2010, 0x2050), 0x20AC, *range(0x2190, 0x2194), 0x2212]


def build(src: str, stem: str, weight: int, rename: tuple[str, str] | None) -> Path:
    font = TTFont(SRC / src)
    if "fvar" in font:
        # Pin every axis (Inter also has optical size) so the result is fully static.
        loc = {a.axisTag: (weight if a.axisTag == "wght" else a.defaultValue) for a in font["fvar"].axes}
        font = instancer.instantiateVariableFont(font, loc)
    opts = subset.Options()
    opts.layout_features = ["kern", "liga", "tnum", "lnum"]
    opts.name_IDs = ["*"]
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=UNICODES)
    sub.subset(font)
    if rename:
        old, new = rename
        for rec in font["name"].names:
            s = rec.toUnicode()
            if old in s or old.replace(" ", "") in s:
                rec.string = s.replace(old, new).replace(old.replace(" ", ""), new.replace(" ", ""))
    out = OUT / f"{stem}-{weight}.ttf"
    font.save(out)
    return out


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for src, stem, weights, rename in FONTS:
        for w in weights:
            print(build(src, stem, w, rename).relative_to(ROOT))
    for lic in SRC.glob("*-OFL.txt"):
        (OUT / lic.name).write_bytes(lic.read_bytes())


if __name__ == "__main__":
    main()
