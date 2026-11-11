"""Derive Pi Muse client icons from the confirmed plumber idle pose.

Deterministic, PIL-only (no network, no image models). Safe-zone rule follows
Android adaptive icons: every non-transparent foreground pixel stays inside the
central 66/108 diameter circle. The splash icon is byte-identical to the
adaptive foreground, matching the existing brand pipeline rule.
"""
from pathlib import Path
from PIL import Image

SOURCE = Path(__file__).parent / 'mascot' / 'plumber-idle.png'
# 用法：python3 build-plumber-icons.py <mobile-assets-dir>
import sys
OUT_MOBILE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd() / 'plumber-icons'
OUT_BRAND = Path(__file__).parent
BACKGROUND = (230, 244, 254)  # 与 app.json adaptiveIcon.backgroundColor (#E6F4FE) 一致
FULL_BLEED = 0.78   # 通用图标内人物占比
SAFE_DIAMETER = 66 / 108
MARGIN = 0.90       # 安全区内再留余量，覆盖缩放重采样在边缘引入的透明像素


def character() -> Image.Image:
    pose = Image.open(SOURCE).convert('RGBA')
    box = pose.getchannel('A').getbbox()
    assert box, 'pose has no visible pixels'
    return pose.crop(box)


def max_radius(image: Image.Image) -> float:
    """最远不透明像素到画布中心的距离；按 alpha 实测，不用外接框猜测。"""
    w, h = image.size
    alpha = image.getchannel('A')
    far = 0.0
    for y in range(h):
        for x in range(w):
            if alpha.getpixel((x, y)) > 0:
                far = max(far, ((x - w / 2) ** 2 + (y - h / 2) ** 2) ** 0.5)
    return far


pose = character()
radius = max_radius(pose)
span = max(pose.size)
# 缩放后最远点半径 = radius * size / span，须 ≤ (SAFE_DIAMETER/2)*MARGIN*canvas
safe_ratio = SAFE_DIAMETER / 2 * MARGIN * span / radius


def fit(size: int) -> Image.Image:
    """等比缩放到 size×size 盒内，不拉伸比例。"""
    scale = size / max(pose.size)
    return pose.resize((round(pose.width * scale), round(pose.height * scale)), Image.Resampling.LANCZOS)


def place(canvas: int, ratio: float, opaque_background: bool) -> Image.Image:
    layer = fit(round(canvas * ratio))
    image = Image.new('RGB' if opaque_background else 'RGBA', (canvas, canvas), BACKGROUND if opaque_background else (0, 0, 0, 0))
    image.paste(layer, ((canvas - layer.width) // 2, (canvas - layer.height) // 2), layer)
    return image


def monochrome(canvas: int, ratio: float) -> Image.Image:
    layer = fit(round(canvas * ratio))
    alpha = layer.getchannel('A')
    image = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    white = Image.new('RGBA', layer.size, (255, 255, 255, 255))
    image.paste(white, ((canvas - layer.width) // 2, (canvas - layer.height) // 2), alpha)
    return image


def assert_safe_zone(image: Image.Image) -> None:
    canvas = image.width
    limit = canvas * SAFE_DIAMETER / 2
    alpha = image.getchannel('A')
    for y in range(canvas):
        for x in range(canvas):
            if alpha.getpixel((x, y)) > 0:
                assert (x - canvas / 2) ** 2 + (y - canvas / 2) ** 2 <= limit ** 2, f'outside safe zone: {x},{y}'


print(f'character {pose.size}, farthest opaque radius {radius:.1f}px -> safe ratio {safe_ratio:.3f}')
assert safe_ratio > 0.4, 'safe ratio unexpectedly small'
foreground = place(1024, safe_ratio, opaque_background=False)
assert_safe_zone(foreground)
mono = monochrome(1024, safe_ratio)
assert_safe_zone(mono)

OUT_MOBILE.mkdir(exist_ok=True)
place(1024, FULL_BLEED, True).save(OUT_MOBILE / 'icon.png', optimize=True)
foreground.save(OUT_MOBILE / 'android-icon-foreground.png', optimize=True)
Image.new('RGB', (1024, 1024), BACKGROUND).save(OUT_MOBILE / 'android-icon-background.png', optimize=True)
mono.save(OUT_MOBILE / 'android-icon-monochrome.png', optimize=True)
foreground.save(OUT_MOBILE / 'splash-icon.png', optimize=True)
place(48, 0.9, True).save(OUT_MOBILE / 'favicon.png', optimize=True)

brand_mascot = OUT_BRAND / 'mascot'
brand_mascot.mkdir(exist_ok=True)
Image.open(SOURCE).save(brand_mascot / 'plumber-idle.png', optimize=True)
print('Generated client icons and archived the confirmed plumber idle source.')
