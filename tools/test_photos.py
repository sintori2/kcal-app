"""대표님이 찍은 사진 폴더를 앱과 같은 방식(model/food.onnx)으로 인식해 결과표를 만든다.
실행: venv/Scripts/python -I test_photos.py <사진 폴더>  → <사진 폴더>/결과.csv
"""
import csv
import json
import os
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener  # 아이폰·갤럭시 HEIC 사진
    register_heif_opener()
except ImportError:
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(os.path.dirname(ROOT), 'model')
SIZE = 224
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
EXT = ('.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp')


def prep(path):
    # 앱과 같음: 회전 정보 반영 → 짧은 변 224 → 가운데 224×224
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    k = SIZE / min(im.size)
    im = im.resize((round(im.width * k), round(im.height * k)), Image.BILINEAR)
    l, t = (im.width - SIZE) // 2, (im.height - SIZE) // 2
    a = (np.asarray(im.crop((l, t, l + SIZE, t + SIZE)), dtype=np.float32) / 255 - MEAN) / STD
    return a.transpose(2, 0, 1)[None]


def main():
    folder = sys.argv[1]
    classes = json.load(open(os.path.join(MODEL, 'classes.json'), encoding='utf-8'))
    s = ort.InferenceSession(os.path.join(MODEL, 'food.onnx'), providers=['CPUExecutionProvider'])
    rows = []
    for fn in sorted(os.listdir(folder)):
        if not fn.lower().endswith(EXT):
            continue
        logits = s.run(None, {'image': prep(os.path.join(folder, fn))})[0][0]
        p = np.exp(logits - logits.max())
        p /= p.sum()
        top = p.argsort()[::-1][:4]
        rows.append([fn] + [f'{classes[i]} {p[i] * 100:.0f}%' for i in top])
    with open(os.path.join(folder, '결과.csv'), 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['사진', '1순위', '2순위', '3순위', '4순위'])
        w.writerows(rows)
    print(len(rows), 'photos')


if __name__ == '__main__':
    main()
