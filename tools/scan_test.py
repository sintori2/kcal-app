"""한 사진에 여러 음식이 있을 때: 사진을 겹치는 칸들로 나눠 훑고, 확신 높은 음식을 각각 찾는 방식 시험
실행: venv/Scripts/python -I scan_test.py <사진> [임계값]
"""
import json
import os
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(os.path.dirname(ROOT), 'model')
SIZE = 224
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def tensor(im):
    im = im.resize((SIZE, SIZE), Image.BILINEAR)
    a = (np.asarray(im, dtype=np.float32) / 255 - MEAN) / STD
    return a.transpose(2, 0, 1)


def windows(w, h):
    # 짧은 변의 40%·60% 크기 정사각 칸을 절반씩 겹치게
    out = []
    for frac in (0.3, 0.45, 0.6):
        s = int(min(w, h) * frac)
        step = s // 2
        for y in range(0, max(1, h - s + 1), step):
            for x in range(0, max(1, w - s + 1), step):
                out.append((x, y, x + s, y + s))
    return out


def main():
    path = sys.argv[1]
    th = float(sys.argv[2]) if len(sys.argv) > 2 else 0.6
    classes = json.load(open(os.path.join(MODEL, 'classes.json'), encoding='utf-8'))
    s = ort.InferenceSession(os.path.join(MODEL, 'food.onnx'), providers=['CPUExecutionProvider'])
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    k = 640 / max(im.size)
    im = im.resize((round(im.width * k), round(im.height * k)))
    boxes = windows(*im.size)
    found = {}
    for b in boxes:
        logits = s.run(None, {'image': tensor(im.crop(b))[None]})[0][0]
        p = np.exp(logits - logits.max())
        p /= p.sum()
        i = int(p.argmax())
        if p[i] >= th and (classes[i] not in found or p[i] > found[classes[i]][0]):
            found[classes[i]] = (float(p[i]), b)
    print(len(boxes), 'windows', im.size)
    for c, (p, b) in sorted(found.items(), key=lambda x: -x[1][0]):
        print(f'{c} {p * 100:.0f}% {b}')


if __name__ == '__main__':
    main()
