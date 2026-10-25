"""model.pt → ../model/food.onnx (+ 8비트 압축본) 내보내고, 시험용 사진으로 정확도를 다시 잼
실행: venv/Scripts/python -I export.py
"""
import json
import os
import shutil
import tempfile

import numpy as np
import onnxruntime as ort
import torch
import torch.nn as nn
from onnxruntime.quantization import QuantType, quantize_dynamic
from PIL import Image
from torchvision import models

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(ROOT), 'model')
SIZE = 224
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def load_val(classes):
    # train.py와 같은 방식(seed 42, 음식마다 10%)으로 시험용 사진을 다시 고름
    import random
    rng = random.Random(42)
    val = []
    for ci, c in enumerate(classes):
        files = sorted(os.listdir(os.path.join(ROOT, 'small', c)))
        rng.shuffle(files)
        val += [(os.path.join(ROOT, 'small', c, f), ci) for f in files[:max(1, len(files) // 10)]]
    return val


def prep(path):
    # 앱(브라우저)에서 하는 것과 같은 전처리: 짧은 변 224로 줄이고 가운데 224×224
    im = Image.open(path).convert('RGB')
    k = SIZE / min(im.size)
    im = im.resize((round(im.width * k), round(im.height * k)), Image.BILINEAR)
    l, t = (im.width - SIZE) // 2, (im.height - SIZE) // 2
    a = (np.asarray(im.crop((l, t, l + SIZE, t + SIZE)), dtype=np.float32) / 255 - MEAN) / STD
    return a.transpose(2, 0, 1)[None]


def accuracy(path, val):
    s = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
    top1 = top3 = 0
    for p, y in val:
        out = s.run(None, {'image': prep(p)})[0][0]
        t3 = out.argsort()[::-1][:3]
        top1 += t3[0] == y
        top3 += y in t3
    return top1 / len(val), top3 / len(val)


def main():
    classes = json.load(open(os.path.join(ROOT, 'classes.json'), encoding='utf-8'))
    model = models.mobilenet_v3_large()
    model.classifier[3] = nn.Linear(model.classifier[3].in_features, len(classes))
    model.load_state_dict(torch.load(os.path.join(ROOT, 'model.pt'), map_location='cpu'))
    model.eval()
    os.makedirs(OUT, exist_ok=True)
    # onnx 도구가 한글 경로를 못 읽어서 영문 임시 폴더에서 작업
    work = tempfile.mkdtemp(prefix='kcal_onnx_')
    fp32 = os.path.join(work, 'food_fp32.onnx')
    torch.onnx.export(model, torch.randn(1, 3, SIZE, SIZE), fp32, input_names=['image'], output_names=['logits'],
                      opset_version=17, dynamo=False)
    q8 = os.path.join(work, 'food_q8.onnx')
    quantize_dynamic(fp32, q8, weight_type=QuantType.QUInt8)

    rng = np.random.default_rng(0)
    val = load_val(classes)
    sample = [val[i] for i in rng.choice(len(val), size=min(3000, len(val)), replace=False)]
    res = {}
    for name, p in (('fp32', fp32), ('q8', q8)):
        a1, a3 = accuracy(p, sample)
        res[name] = {'top1': round(float(a1), 4), 'top3': round(float(a3), 4), 'MB': round(os.path.getsize(p) / 1e6, 1)}
        print(name, res[name], flush=True)
    # 정확도가 1%p 넘게 안 떨어지면 작은 쪽을 앱에 넣음
    pick = 'q8' if res['fp32']['top1'] - res['q8']['top1'] <= 0.01 else 'fp32'
    shutil.copyfile(q8 if pick == 'q8' else fp32, os.path.join(OUT, 'food.onnx'))
    with open(os.path.join(OUT, 'classes.json'), 'w', encoding='utf-8') as f:
        json.dump(classes, f, ensure_ascii=False)
    json.dump({'picked': pick, **res, 'val_sample': len(sample)}, open(os.path.join(ROOT, 'export_report.json'), 'w'), indent=1)
    print('picked', pick, flush=True)


if __name__ == '__main__':
    main()
