"""앱 아이콘(PNG) 생성 — 외부 라이브러리 없이 순수 파이썬.
실행: python tools/make_icons.py  → icons/icon-192.png, icons/icon-512.png
"""
import os
import struct
import zlib

BG = (255, 138, 91)      # 주황 배경
PLATE = (255, 255, 255)  # 접시
RIM = (255, 214, 196)    # 접시 안쪽 테
DOT = (76, 175, 80)      # 초록 잎


def color_at(x, y):
    # 0~1 좌표에서 색 결정
    dx, dy = x - 0.5, y - 0.5
    r = (dx * dx + dy * dy) ** 0.5
    lx, ly = x - 0.60, y - 0.40
    if (lx * lx) / 0.006 + (ly * ly) / 0.0025 <= 1:
        return DOT
    if r <= 0.20:
        return PLATE
    if r <= 0.24:
        return RIM
    if r <= 0.32:
        return PLATE
    return BG


def render(size, ss=3):
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG 필터 바이트
        for px in range(size):
            acc = [0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    c = color_at((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size)
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
            n = ss * ss
            row += bytes((acc[0] // n, acc[1] // n, acc[2] // n))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out, exist_ok=True)
    for s in (192, 512):
        with open(os.path.join(out, f"icon-{s}.png"), "wb") as f:
            f.write(render(s))
        print(f"icon-{s}.png")
