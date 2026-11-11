"""Build the approved B penguin's eight runtime PNGs with Pillow only.

Run from any directory:
  python3 build-pack.py [--output-dir DIR] [--mobile-assets DIR]

Sources are hash-bound to sources/manifest.json. No network or model calls.
Only background/edge alpha preparation and aspect-preserving framing are applied.
The optional client copy occurs only after every state passes validation.
"""
from collections import deque
from pathlib import Path
from statistics import median
import argparse
import hashlib
import json
import shutil
from PIL import Image, ImageFilter

STATES = ['idle', 'thinking', 'responding', 'working', 'waiting-approval', 'success', 'error', 'stopped']
SIZE = 512
CONTENT_SIZE = 448
BASELINE = 480


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def adjacent(index, width, height):
    x = index % width
    return ([index - 1] if x else []) + ([index + 1] if x < width - 1 else []) + \
        ([index - width] if index >= width else []) + ([index + width] if index < width * (height - 1) else [])


def background_rows(rgb):
    width, height = rgb.size
    pixels = rgb.load()
    strip = max(4, width // 32)
    columns = list(range(strip)) + list(range(width - strip, width))
    return [tuple(int(median(pixels[x, y][channel] for x in columns)) for channel in range(3))
            for y in range(height)]


def extract(rgb, state):
    width, height = rgb.size
    raw = rgb.tobytes()
    pixels = list(zip(raw[0::3], raw[1::3], raw[2::3]))
    backgrounds = background_rows(rgb)
    candidates = bytearray(width * height)
    feet = [(i % width, i // width) for i, (r, g, b) in enumerate(pixels)
            if i // width >= height * .68 and r > 160 and r - g > 25 and g - b > 20]
    foot_top = min((y for _, y in feet), default=height)
    foot_bottom = max((y for _, y in feet), default=height)
    foot_right = max((x for x, _ in feet), default=0)
    floor_seeds = []
    for i, (r, g, b) in enumerate(pixels):
        x, y = i % width, i // width
        br, bg, bb = backgrounds[y]
        near = max(abs(r - br), abs(g - bg), abs(b - bb)) <= 18
        neutral = max(abs((r - g) - (br - bg)), abs((g - b) - (bg - bb)), abs((r - b) - (br - bb))) <= 8
        chroma = max(r, g, b) - min(r, g, b)
        # 两张原稿的地面接触阴影需单独处理，范围绑定橙色脚的位置；不抹掉腹部或笔记本。
        floor = (state == 'error' and chroma <= 36 and
                 ((y >= foot_top - 2 and b >= r - 2) or y >= foot_bottom - 10)) or \
                (state == 'working' and y >= foot_top - 2 and x <= foot_right + 4 and chroma <= 36)
        candidates[i] = near or neutral or floor
        if floor:
            floor_seeds.append(i)
    removed = bytearray(width * height)
    queue = deque()
    edge_seeds = list(range(width)) + list(range((height - 1) * width, height * width)) + \
        [y * width + x for y in range(height) for x in (0, width - 1)]
    # 封闭在人物内部的白纸和眼部保留；脚间的已知地面阴影则可显式作为背景种子。
    for i in floor_seeds + edge_seeds:
        if candidates[i] and not removed[i]:
            removed[i] = 1
            queue.append(i)
    while queue:
        for neighbor in adjacent(queue.popleft(), width, height):
            if candidates[neighbor] and not removed[neighbor]:
                removed[neighbor] = 1
                queue.append(neighbor)
    mask = bytearray(0 if value else 255 for value in removed)
    visited = bytearray(width * height)
    minimum_component = max(24, width * height // 10000)
    for i, value in enumerate(mask):
        if not value or visited[i]:
            continue
        component = []
        queue = deque([i])
        visited[i] = 1
        while queue:
            point = queue.popleft()
            component.append(point)
            for neighbor in adjacent(point, width, height):
                if mask[neighbor] and not visited[neighbor]:
                    visited[neighbor] = 1
                    queue.append(neighbor)
        if len(component) < minimum_component:
            for point in component:
                mask[point] = 0
    hard = Image.frombytes('L', (width, height), bytes(mask))
    core = hard.filter(ImageFilter.MinFilter(5)).tobytes()
    ring = hard.filter(ImageFilter.MaxFilter(5)).tobytes()
    alpha, output = bytearray(mask), list(pixels)
    floor_mask = bytearray(width * height)
    for i in floor_seeds:
        floor_mask[i] = 1
    offsets = sorted([(dx, dy) for dy in range(-5, 6) for dx in range(-5, 6) if dx or dy],
                     key=lambda pair: pair[0] ** 2 + pair[1] ** 2)
    for i, near_edge in enumerate(ring):
        if floor_mask[i]:
            alpha[i], output[i] = 0, (0, 0, 0)
            continue
        if not near_edge or core[i]:
            continue
        x, y, neighbor_color = i % width, i // width, None
        for dx, dy in offsets:
            xx, yy = x + dx, y + dy
            if 0 <= xx < width and 0 <= yy < height and core[yy * width + xx]:
                neighbor_color = pixels[yy * width + xx]
                break
        if neighbor_color is None:
            continue
        pixel, background = pixels[i], backgrounds[y]
        direction = [neighbor_color[c] - background[c] for c in range(3)]
        norm = sum(value * value for value in direction)
        if norm < 225:
            continue
        coverage = max(0.0, min(1.0, sum((pixel[c] - background[c]) * direction[c] for c in range(3)) / norm))
        if coverage < .04:
            alpha[i], output[i] = 0, (0, 0, 0)
            continue
        alpha[i] = round(coverage * 255)
        output[i] = tuple(max(0, min(255, round(background[c] + (pixel[c] - background[c]) / coverage))) for c in range(3))
    if state == 'error':
        # 以真实橙色脚底收边，不保留把双脚连起来的细地面接触线。
        for y in range(max(0, foot_bottom - 2), height):
            for x in range(width):
                i = y * width + x
                r, g, b = pixels[i]
                if y > foot_bottom or not (r - g > 25 and g - b > 20):
                    alpha[i], output[i] = 0, (0, 0, 0)
    result = Image.new('RGBA', (width, height))
    result.putdata([(*color, value) if value else (0, 0, 0, 0) for color, value in zip(output, alpha)])
    return result


def normalize(image):
    box = image.getchannel('A').getbbox()
    if not box:
        raise ValueError('Empty foreground')
    layer = image.crop(box)
    ratio = min(CONTENT_SIZE / layer.width, CONTENT_SIZE / layer.height)
    layer = layer.resize((round(layer.width * ratio), round(layer.height * ratio)), Image.Resampling.LANCZOS)
    result = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    result.alpha_composite(layer, ((SIZE - layer.width) // 2, BASELINE - layer.height))
    return result


def validate(path):
    image = Image.open(path)
    assert image.format == 'PNG' and image.mode == 'RGBA' and image.size == (SIZE, SIZE), path
    assert path.stat().st_size <= 786432, path
    alpha = image.getchannel('A')
    assert alpha.getextrema() == (0, 255), path
    assert all(alpha.getpixel(point) == 0 for point in [(0, 0), (511, 0), (0, 511), (511, 511)]), path
    box = alpha.getbbox()
    assert box and min(box[0], box[1], SIZE - box[2], SIZE - box[3]) >= 16, path
    return {'state': path.stem, 'file': path.name, 'sha256': digest(path), 'bytes': path.stat().st_size,
            'alphaBounds': list(box)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--mobile-assets', type=Path, help='Explicit target: client assets/images/avatar directory')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    source_manifest = root / 'sources/manifest.json'
    source = json.loads(source_manifest.read_text())
    assert [image['state'] for image in source['images']] == STATES
    reference = (source_manifest.parent / source['canonicalReference']).resolve()
    assert digest(reference) == source['canonicalReferenceSha256']
    args.output_dir.mkdir(parents=True, exist_ok=True)
    exports = []
    for entry in source['images']:
        original = (source_manifest.parent / entry['file']).resolve()
        assert digest(original) == entry['sha256'], original
        image = Image.open(original)
        cutout = image.convert('RGBA') if entry['state'] == 'idle' else extract(image.convert('RGB'), entry['state'])
        target = args.output_dir / (entry['state'] + '.png')
        normalize(cutout).save(target, optimize=True)
        exports.append(validate(target))
        print(entry['state'], exports[-1]['bytes'], exports[-1]['alphaBounds'], flush=True)
    manifest = {'schemaVersion': 1, 'identity': 'brand-penguin-b', 'builtinKey': 'builtin:penguin', 'displayName': '冰蓝企鹅',
                'canonicalReference': {'repository': 'yaotutu/pi-muse', 'path': 'docs/assets/brand/previews/neutral-icon-master.png',
                                       'sha256': source['canonicalReferenceSha256']},
                'artworkApproval': 'user-approved-static-poses', 'size': [SIZE, SIZE], 'format': 'PNG', 'mode': 'RGBA',
                'preparation': 'local neutral-background removal, edge unmatting and aspect-preserving framing; no model calls',
                'states': exports}
    text = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    (args.output_dir / 'manifest.json').write_text(text)
    if args.mobile_assets:
        # 整套验证后才复制；构建失败不会把半套新图与旧 C 混进客户端。
        args.mobile_assets.mkdir(parents=True, exist_ok=True)
        for entry in exports:
            shutil.copyfile(args.output_dir / entry['file'], args.mobile_assets / entry['file'])
        (args.mobile_assets / 'manifest.json').write_text(text)
        print('Copied all eight validated states to the explicit client target.')


if __name__ == '__main__':
    main()
