"""
Generate PNG icon files for the Saisoku Chrome extension.
Creates 16x16, 48x48, and 128x128 icons with a blue bell/notification design
and the kanji character "催".
"""

from PIL import Image, ImageDraw, ImageFont
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BG_COLOR = "#3498db"
WHITE = "#ffffff"
SIZES = [16, 48, 128]


def draw_bell_shape(draw, size):
    """Draw a simplified bell/notification icon shape."""
    s = size / 128.0

    # Bell dome (upper ellipse)
    bell_top = int(20 * s)
    bell_left = int(25 * s)
    bell_right = int(103 * s)
    draw.ellipse(
        [bell_left, bell_top, bell_right, int(75 * s)],
        fill=WHITE,
    )

    # Bell body (rectangle connecting dome to base)
    bell_bottom = int(95 * s)
    draw.rectangle(
        [bell_left, int(50 * s), bell_right, bell_bottom],
        fill=WHITE,
    )

    # Bell base (wider rectangle)
    base_extend = int(8 * s)
    draw.rectangle(
        [bell_left - base_extend, int(85 * s), bell_right + base_extend, bell_bottom + int(5 * s)],
        fill=WHITE,
    )

    # Clapper/ball at bottom center
    clapper_radius = int(8 * s)
    center_x = size // 2
    clapper_y = bell_bottom + int(8 * s)
    draw.ellipse(
        [center_x - clapper_radius, clapper_y - clapper_radius,
         center_x + clapper_radius, clapper_y + clapper_radius],
        fill=WHITE,
    )

    # Handle/knob at top
    knob_radius = int(6 * s)
    knob_y = bell_top - int(2 * s)
    draw.ellipse(
        [center_x - knob_radius, knob_y - knob_radius,
         center_x + knob_radius, knob_y + knob_radius],
        fill=WHITE,
    )


def draw_kanji_overlay(draw, size):
    """Draw the kanji on top of the bell in the background color."""
    font_size = int(size * 0.42)
    font = None

    font_candidates = [
        "C:/Windows/Fonts/msgothic.ttc",
        "C:/Windows/Fonts/meiryo.ttc",
        "C:/Windows/Fonts/YuGothM.ttc",
        "C:/Windows/Fonts/msmincho.ttc",
    ]

    for font_path in font_candidates:
        if os.path.exists(font_path):
            try:
                font = ImageFont.truetype(font_path, font_size)
                bbox = draw.textbbox((0, 0), "\u50ac", font=font)
                if bbox[2] - bbox[0] > 1:
                    break
            except Exception:
                font = None
                continue

    if font is None:
        font = ImageFont.load_default()

    text = "\u50ac"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    x = (size - text_w) // 2 - bbox[0]
    y = int(size * 0.28) - bbox[1]

    draw.text((x, y), text, fill=BG_COLOR, font=font)


def generate_icon(size):
    """Generate a single icon at the given size."""
    img = Image.new("RGBA", (size, size), BG_COLOR)
    draw = ImageDraw.Draw(img)

    margin = max(1, int(size * 0.02))
    radius = int(size * 0.18)
    draw.rounded_rectangle(
        [margin, margin, size - margin - 1, size - margin - 1],
        radius=radius,
        fill=BG_COLOR,
    )

    draw_bell_shape(draw, size)
    draw_kanji_overlay(draw, size)

    # Red notification dot in top-right (only for larger sizes)
    if size >= 48:
        dot_radius = int(size * 0.1)
        dot_x = size - int(size * 0.2)
        dot_y = int(size * 0.15)
        draw.ellipse(
            [dot_x - dot_radius, dot_y - dot_radius,
             dot_x + dot_radius, dot_y + dot_radius],
            fill="#e74c3c",
        )

    return img


def main():
    for size in SIZES:
        img = generate_icon(size)
        output_path = os.path.join(SCRIPT_DIR, f"icon{size}.png")
        img.save(output_path, "PNG")
        print(f"Generated: {output_path} ({size}x{size})")

    print("\nAll icons generated successfully.")


if __name__ == "__main__":
    main()
