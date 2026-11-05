"""Convert design/Anton-Regular.ttf into Three.js typeface JSON, locally and offline.

Three's TTFLoader imports its parser from a CDN, so this build uses fontTools instead.
Only the characters the menu needs are exported. Run with: python scripts/ttf_to_typeface.py
"""
from pathlib import Path
import json
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'design' / 'Anton-Regular.ttf'
OUTPUT = ROOT / 'design' / 'anton.typeface.json'
CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -'


class TypefacePen(BasePen):
    """Writes Three.js FontLoader commands: m/l x y, q x y cx cy, b x y c1x c1y c2x c2y."""
    def __init__(self, glyph_set):
        super().__init__(glyph_set)
        self.parts = []

    def _add(self, *values):
        self.parts.extend(str(round(v)) if not isinstance(v, str) else v for v in values)

    def _moveTo(self, p): self._add('m', *p)
    def _lineTo(self, p): self._add('l', *p)
    def _qCurveToOne(self, c, p): self._add('q', *p, *c)
    def _curveToOne(self, c1, c2, p): self._add('b', *p, *c1, *c2)
    def _closePath(self): pass


font = TTFont(SOURCE)
glyph_set = font.getGlyphSet()
cmap = font.getBestCmap()
head, post, hhea = font['head'], font['post'], font['hhea']
glyphs = {}
for char in CHARS:
    name = cmap[ord(char)]
    pen = TypefacePen(glyph_set)
    glyph_set[name].draw(pen)
    advance, lsb = font['hmtx'][name]
    glyph = font['glyf'][name]
    glyphs[char] = {'ha': advance, 'x_min': getattr(glyph, 'xMin', 0), 'x_max': getattr(glyph, 'xMax', advance), 'o': ' '.join(pen.parts)}
name_table = font['name']
OUTPUT.write_text(json.dumps({
    'glyphs': glyphs,
    'familyName': name_table.getDebugName(1), 'ascender': hhea.ascent, 'descender': hhea.descent,
    'underlinePosition': post.underlinePosition, 'underlineThickness': post.underlineThickness,
    'boundingBox': {'xMin': head.xMin, 'yMin': head.yMin, 'xMax': head.xMax, 'yMax': head.yMax},
    'resolution': head.unitsPerEm, 'original_font_information': {'source': SOURCE.name, 'license': 'SIL Open Font License 1.1, see ANTON-OFL.txt'},
}, separators=(',', ':')))
print(f'Wrote {OUTPUT.name}: {len(glyphs)} glyphs, {head.unitsPerEm} units/em')
