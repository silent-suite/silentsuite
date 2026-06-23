#!/usr/bin/env python3
"""
Bake branded caption bars onto SilentSuite Google Play screenshots.

Takes raw Android captures (any resolution) and produces 1080x1920 24-bit PNGs
(no alpha, Google Play compliant) with a consistent dark-navy footer caption bar,
emerald accent line, and white caption text.

Usage:
  ~/.silentsuite-screenshot-venv/bin/python bake_captions.py \
    --input-dir /path/to/raw-captures \
    --output-dir /path/to/output \
    --manifest captions.json

The manifest maps output filename -> {capture: "raw.png", caption: "text"}.
If a capture is missing, that screenshot is skipped with a warning (so you can
produce a subset). Captions are auto-wrapped to fit the bar width.

Brand:
  dark navy   #0A1018  (footer bar background)
  emerald     #34d399  (accent top border, optional highlighted word)
  emerald-dk  #10b981  (secondary accent)
  white       #FFFFFF  (caption text)

No em dashes in any text (founder preference). The script does not introduce
them; verify your caption strings before running.
"""

import argparse
import json
import os
import sys
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Brand colors
NAVY = (0x0A, 0x10, 0x18)
EMERALD = (0x34, 0xD3, 0x99)
EMERALD_DK = (0x10, 0xB9, 0x81)
WHITE = (0xFF, 0xFF, 0xFF)

# Output spec (Google Play phone screenshot, 16:9 portrait)
OUT_W = 1080
OUT_H = 1920

# Footer caption bar
BAR_H = 180  # ~9% of frame height
ACCENT_LINE_H = 3
PAD_X = 80  # left/right padding inside the bar


def find_font(weight="bold"):
    """Find a sans-serif font on the system."""
    candidates = {
        "bold": [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        ],
        "regular": [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        ],
    }
    for p in candidates.get(weight, candidates["bold"]):
        if os.path.exists(p):
            return p
    return None


def load_font(size, weight="bold"):
    path = find_font(weight)
    if path:
        return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def fit_font_size(text, max_width, start_size, weight="bold", min_size=28):
    """Shrink font size until the text fits within max_width on one line."""
    size = start_size
    while size >= min_size:
        font = load_font(size, weight)
        bbox = font.getbbox(text)
        w = bbox[2] - bbox[0]
        if w <= max_width:
            return font, w
        size -= 2
    return load_font(min_size, weight), 0


def scale_capture_to_canvas(img):
    """
    Scale the raw capture to fit the content area (OUT_W x (OUT_H - BAR_H))
    preserving aspect ratio, centering horizontally, padding top/bottom with
    navy if needed. This keeps the screenshot content above the caption bar.
    """
    content_w = OUT_W
    content_h = OUT_H - BAR_H
    bg = Image.new("RGB", (OUT_W, OUT_H), NAVY)
    content_area = Image.new("RGB", (content_w, content_h), NAVY)

    # Scale to fit
    src_w, src_h = img.size
    scale = min(content_w / src_w, content_h / src_h)
    new_w = max(1, int(src_w * scale))
    new_h = max(1, int(src_h * scale))
    resized = img.resize((new_w, new_h), Image.LANCZOS)

    # Center in content area
    x = (content_w - new_w) // 2
    y = (content_h - new_h) // 2
    content_area.paste(resized, (x, y))
    bg.paste(content_area, (0, 0))
    return bg


def draw_caption_bar(canvas, caption):
    """Draw the footer bar with accent line and centered caption text."""
    draw = ImageDraw.Draw(canvas)
    bar_top = OUT_H - BAR_H

    # Accent line at the top of the bar
    draw.rectangle([0, bar_top, OUT_W, bar_top + ACCENT_LINE_H], fill=EMERALD)

    # Bar background (already navy from canvas, but be explicit)
    draw.rectangle([0, bar_top + ACCENT_LINE_H, OUT_W, OUT_H], fill=NAVY)

    # Fit caption text
    max_text_w = OUT_W - 2 * PAD_X
    font, text_w = fit_font_size(caption, max_text_w, start_size=64, weight="bold")

    # Vertically center in the bar (below the accent line)
    bbox = font.getbbox(caption)
    text_h = bbox[3] - bbox[1]
    text_x = (OUT_W - text_w) // 2
    text_y = bar_top + ACCENT_LINE_H + (BAR_H - ACCENT_LINE_H - text_h) // 2 - bbox[1]

    draw.text((text_x, text_y), caption, font=font, fill=WHITE)


def process(manifest, input_dir, output_dir):
    input_dir = Path(input_dir)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    produced = 0
    skipped = 0
    for out_name, spec in manifest.items():
        capture = spec.get("capture")
        caption = spec.get("caption", "")
        if not capture:
            print(f"SKIP {out_name}: no capture specified", file=sys.stderr)
            skipped += 1
            continue
        cap_path = input_dir / capture
        if not cap_path.exists():
            print(f"SKIP {out_name}: capture not found: {cap_path}", file=sys.stderr)
            skipped += 1
            continue
        try:
            img = Image.open(cap_path).convert("RGB")
        except Exception as e:
            print(f"SKIP {out_name}: cannot open {cap_path}: {e}", file=sys.stderr)
            skipped += 1
            continue

        canvas = scale_capture_to_canvas(img)
        if caption:
            draw_caption_bar(canvas, caption)

        out_path = output_dir / out_name
        canvas.save(out_path, "PNG")
        w_out, h_out = canvas.size
        print(f"OK   {out_name} <- {capture}  ({w_out}x{h_out})")
        produced += 1

    print(f"\nDone: {produced} produced, {skipped} skipped.")
    return produced


def main():
    ap = argparse.ArgumentParser(description="Bake branded caption bars onto SilentSuite Play screenshots.")
    ap.add_argument("--input-dir", required=True, help="Directory of raw captures")
    ap.add_argument("--output-dir", required=True, help="Directory for output PNGs")
    ap.add_argument("--manifest", required=True, help="JSON manifest: {filename: {capture, caption}}")
    args = ap.parse_args()

    with open(args.manifest) as f:
        manifest = json.load(f)

    n = process(manifest, args.input_dir, args.output_dir)
    sys.exit(0 if n > 0 else 1)


if __name__ == "__main__":
    main()
