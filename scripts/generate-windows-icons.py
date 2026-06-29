#!/usr/bin/env python3
"""Generate Windows-compatible CCSwitchMulti icon assets."""

from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


REPO_ROOT = Path(__file__).resolve().parents[1]
TAURI_ICON_DIR = REPO_ROOT / "src-tauri" / "icons"
BRAND_ICON = REPO_ROOT / "assets" / "brand" / "ccswitchmulti-codex-app-icon-1024.png"
APP_ICON = REPO_ROOT / "src" / "assets" / "icons" / "app-icon.png"


def rounded_rectangle(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int, fill) -> None:
    """绘制圆角矩形，统一小尺寸和大尺寸图标的背景形状。"""
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_cloud(draw: ImageDraw.ImageDraw, scale: float, offset_x: float, offset_y: float, fill: str) -> None:
    """绘制简化云形主体，小尺寸下只保留高对比轮廓。"""
    def p(value: float) -> int:
        return int(round(value * scale))

    ox = int(round(offset_x))
    oy = int(round(offset_y))
    circles = [
        (15, 31, 25),
        (28, 24, 29),
        (44, 29, 27),
        (23, 43, 26),
        (41, 44, 26),
    ]
    for cx, cy, r in circles:
        draw.ellipse((ox + p(cx - r), oy + p(cy - r), ox + p(cx + r), oy + p(cy + r)), fill=fill)
    draw.rounded_rectangle((ox + p(12), oy + p(30), ox + p(58), oy + p(56)), radius=p(12), fill=fill)


def draw_small_icon(size: int) -> Image.Image:
    """生成专门给 Windows 任务栏使用的小尺寸图标，避免复杂阴影被缓存缩放成糊块。"""
    supersample = 4
    canvas_size = size * supersample
    image = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    s = canvas_size / 64

    rounded_rectangle(
        draw,
        (int(4 * s), int(4 * s), int(60 * s), int(60 * s)),
        int(14 * s),
        (15, 22, 29, 255),
    )
    draw_cloud(draw, s * 0.8, 4 * s, 8 * s, "#f4fbff")

    stroke = max(2, int(round(5.5 * s)))
    dark = (15, 24, 31, 255)
    draw.line(
        [(int(27 * s), int(27 * s)), (int(34 * s), int(38 * s)), (int(27 * s), int(49 * s))],
        fill=dark,
        width=stroke,
        joint="curve",
    )
    draw.line(
        [(int(39 * s), int(43 * s)), (int(50 * s), int(43 * s))],
        fill=dark,
        width=max(2, int(round(4.5 * s))),
    )

    if size >= 32:
        route_width = max(2, int(round(4 * s)))
        draw.line([(int(48 * s), int(25 * s)), (int(58 * s), int(23 * s))], fill=(247, 216, 106, 255), width=route_width)
        draw.line([(int(49 * s), int(34 * s)), (int(60 * s), int(34 * s))], fill=(119, 243, 208, 255), width=route_width)
        draw.line([(int(48 * s), int(43 * s)), (int(58 * s), int(45 * s))], fill=(103, 216, 255, 255), width=route_width)

    resample = Image.Resampling.LANCZOS if size >= 32 else Image.Resampling.BICUBIC
    return image.resize((size, size), resample)


def load_large_icon(size: int) -> Image.Image:
    """从 1024 品牌图生成大尺寸图标，保留发布页和安装器所需的完整视觉。"""
    source = Image.open(BRAND_ICON).convert("RGBA")
    return source.resize((size, size), Image.Resampling.LANCZOS)


def make_png_bytes(image: Image.Image) -> bytes:
    """把图像编码为 PNG bytes，供大尺寸 ICO 帧复用。"""
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def make_dib_bytes(image: Image.Image) -> bytes:
    """把 RGBA 图像编码为 32-bit DIB，提升 Windows shell 对小尺寸 ICO 帧的兼容性。"""
    rgba = image.convert("RGBA")
    width, height = rgba.size
    xor_rows = []
    pixels = rgba.load()
    for y in range(height - 1, -1, -1):
        row = bytearray()
        for x in range(width):
            r, g, b, a = pixels[x, y]
            row.extend((b, g, r, a))
        xor_rows.append(bytes(row))

    and_stride = ((width + 31) // 32) * 4
    and_mask = bytes(and_stride * height)
    header = struct.pack(
        "<IIIHHIIIIII",
        40,
        width,
        height * 2,
        1,
        32,
        0,
        width * height * 4 + len(and_mask),
        0,
        0,
        0,
        0,
    )
    return header + b"".join(xor_rows) + and_mask


def write_ico(path: Path, frames: list[tuple[int, bytes]]) -> None:
    """写入 ICO 文件；64px 及以下使用 DIB，其余使用 PNG。"""
    header_size = 6 + 16 * len(frames)
    offset = header_size
    directory = []
    payloads = []
    for size, data in frames:
        width_byte = 0 if size >= 256 else size
        directory.append(struct.pack("<BBBBHHII", width_byte, width_byte, 0, 0, 1, 32, len(data), offset))
        payloads.append(data)
        offset += len(data)

    path.write_bytes(struct.pack("<HHH", 0, 1, len(frames)) + b"".join(directory) + b"".join(payloads))


def save_icon_assets() -> None:
    """生成 Tauri、NSIS 和应用内 About 页面共享的图标资源。"""
    TAURI_ICON_DIR.mkdir(parents=True, exist_ok=True)

    small = {size: draw_small_icon(size) for size in (16, 24, 32, 48, 64)}
    large = {size: load_large_icon(size) for size in (128, 256, 512)}

    small[32].save(TAURI_ICON_DIR / "32x32.png")
    small[64].save(TAURI_ICON_DIR / "64x64.png")
    large[128].save(TAURI_ICON_DIR / "128x128.png")
    large[256].save(TAURI_ICON_DIR / "128x128@2x.png")
    large[512].save(TAURI_ICON_DIR / "icon.png")
    small[32].save(APP_ICON)

    square_sizes = {
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }
    for name, size in square_sizes.items():
        source = small[64] if size <= 89 else large[512]
        source.resize((size, size), Image.Resampling.LANCZOS).save(TAURI_ICON_DIR / name)

    frames = []
    for size in (16, 24, 32, 48, 64):
        frames.append((size, make_dib_bytes(small[size])))
    for size in (128, 256):
        frames.append((size, make_png_bytes(large[size])))
    write_ico(TAURI_ICON_DIR / "icon.ico", frames)


def main() -> None:
    """命令入口，用于本地和 release 前重新生成 Windows 图标。"""
    save_icon_assets()
    print(f"Generated Windows icon assets in {TAURI_ICON_DIR}")


if __name__ == "__main__":
    main()
