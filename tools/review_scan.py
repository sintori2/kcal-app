"""사진 폴더를 앱과 같은 방식(전체 + 겹치는 칸 훑기)으로 분석해, 눈으로 맞다/틀리다를 고르는 확인 페이지(HTML)를 만든다.
실행: venv/Scripts/python -I review_scan.py <폴더(meta.json 있으면 출처 표시)> <출력.html>
"""
import base64
import io
import json
import os
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(os.path.dirname(ROOT), 'model')
SIZE = 224
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
COLORS = ['#FF6B35', '#2EC4B6', '#E71D36', '#7B2CBF', '#FFB703', '#3A86FF', '#06D6A0', '#FB5607']


def probs(sess, im):
    a = (np.asarray(im.resize((SIZE, SIZE), Image.BILINEAR), dtype=np.float32) / 255 - MEAN) / STD
    lg = sess.run(None, {'image': a.transpose(2, 0, 1)[None]})[0][0]
    p = np.exp(lg - lg.max())
    return p / p.sum()


def trim_dark(im):
    g = np.asarray(im.convert('L'), dtype=np.float32)
    rows = np.where(g.mean(1) >= 14)[0]
    if not len(rows):
        return (0, 0, im.width, im.height)
    t, b = rows[0], rows[-1] + 1
    cols = np.where(g[t:b].mean(0) >= 14)[0]
    l, r = cols[0], cols[-1] + 1
    if (r - l) * (b - t) >= im.width * im.height * 0.9:
        return (0, 0, im.width, im.height)
    return (int(l), int(t), int(r), int(b))


def scan(sess, classes, im):
    x0, y0, x1, y1 = trim_dark(im)
    w, h = x1 - x0, y1 - y0
    short = min(w, h)
    cx, cy = x0 + (w - short) / 2, y0 + (h - short) / 2
    pw = probs(sess, im.crop((cx, cy, cx + short, cy + short)))
    whole = [(classes[i], float(pw[i])) for i in pw.argsort()[::-1][:4]]
    found = {}
    votes = {}
    nwin = 0
    for frac in (0.3, 0.45, 0.6):
        s = short * frac
        step = s / 2
        y = 0.0
        while y + s <= h + 1:
            x = 0.0
            while x + s <= w + 1:
                box = (x0 + x, y0 + y, x0 + x + s, y0 + y + s)
                p = probs(sess, im.crop(box))
                i = int(p.argmax())
                nwin += 1
                votes[classes[i]] = votes.get(classes[i], 0) + 1
                if p[i] >= 0.5 and (classes[i] not in found or p[i] > found[classes[i]][0]):
                    found[classes[i]] = (float(p[i]), box)
                x += step
            y += step
    dishes = sorted(found.items(), key=lambda kv: -kv[1][0])[:8]
    # 한 음식 사진: 전체로 봐도 확신(60%↑)하고, 칸들 중 그 음식이라고 본 칸이 25% 이상
    share = votes.get(whole[0][0], 0) / max(1, nwin)
    multi = len(dishes) >= 2 and not (whole[0][1] >= 0.6 and share >= 0.25)
    return whole, dishes, multi, share


def main():
    folder, out = sys.argv[1], sys.argv[2]
    classes = json.load(open(os.path.join(MODEL, 'classes.json'), encoding='utf-8'))
    sess = ort.InferenceSession(os.path.join(MODEL, 'food.onnx'), providers=['CPUExecutionProvider'])
    meta_path = os.path.join(folder, 'meta.json')
    if os.path.exists(meta_path):
        metas = json.load(open(meta_path, encoding='utf-8'))
        for m in metas:
            m['file'] = os.path.join(folder, os.path.basename(m['file']))
    else:
        metas = [{'file': os.path.join(folder, f), 'title': f} for f in sorted(os.listdir(folder)) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
    try:
        font = ImageFont.truetype('malgun.ttf', 18)
    except OSError:
        font = ImageFont.load_default()
    cards = []
    for n, m in enumerate(metas):
        im = ImageOps.exif_transpose(Image.open(m['file'])).convert('RGB')
        k = 640 / max(im.size)
        im = im.resize((round(im.width * k), round(im.height * k)))
        whole, dishes, multi, share = scan(sess, classes, im)
        shown = [(c, p, b) for c, (p, b) in dishes] if multi else [(whole[0][0], whole[0][1], None)]
        draw = ImageDraw.Draw(im)
        for j, (c, p, b) in enumerate(shown):
            if b:
                col = COLORS[j % len(COLORS)]
                draw.rectangle(b, outline=col, width=3)
                draw.text((b[0] + 4, b[1] + 2), f'{j + 1}', fill=col, font=font, stroke_width=2, stroke_fill='white')
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=78)
        cards.append({
            'n': n + 1, 'img': base64.b64encode(buf.getvalue()).decode(), 'title': m.get('title', ''), 'page': m.get('page', ''),
            'license': m.get('license', ''), 'multi': multi,
            'items': [{'name': c.replace('_', '·'), 'p': round(p * 100), 'pre': p >= 0.6 or not multi} for c, p, b in shown],
            'whole': [f'{c.replace("_", "·")} {p * 100:.0f}%' for c, p in whole],
        })
        print(n + 1, 'multi' if multi else 'single', flush=True)
    html = open(os.path.join(ROOT, 'review_template.html'), encoding='utf-8').read()
    open(out, 'w', encoding='utf-8').write(html.replace('/*DATA*/[]', json.dumps(cards, ensure_ascii=False)))
    print('saved', out)


if __name__ == '__main__':
    main()
