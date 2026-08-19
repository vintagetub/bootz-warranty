#!/usr/bin/env python3
"""Generate print-ready QR codes for the Bootz registration page.

    python3 make_qr.py

Writes 1800px PNGs to assets/. Black is the production choice — highest
contrast, best scan reliability on a printed carton, and on-spec (Bootz print
colors are black / #2FC0CC / #EBEBEC). The navy variant is there for artwork
that already sits on a light panel and wants the brand highlight color.

Re-run this if the URL ever changes (custom domain, path change) and reprint.
"""
import os

import qrcode
from qrcode.constants import ERROR_CORRECT_H

URL = "https://bootz-warranty.vercel.app"
SIZE = 1800          # px — plenty for a 1–2 in. printed code at 300+ dpi
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")

VARIANTS = [
    ("bootz-warranty-qr.png", "#000000", "#FFFFFF"),          # production
    ("bootz-warranty-qr-navy.png", "#002D4B", "#FFFFFF"),     # brand highlight
]


def build(path: str, fg: str, bg: str) -> None:
    # ERROR_CORRECT_H (30%) keeps it readable through print wear and shrink-wrap.
    qr = qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_H, box_size=10, border=4)
    qr.add_data(URL)
    qr.make(fit=True)
    img = qr.make_image(fill_color=fg, back_color=bg).convert("RGB")
    img = img.resize((SIZE, SIZE), 0)  # NEAREST — keeps module edges crisp
    img.save(path)
    print(f"{os.path.basename(path):32s} {SIZE}x{SIZE}  {fg} on {bg}  ->  {URL}")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, fg, bg in VARIANTS:
        build(os.path.join(OUT, name), fg, bg)
