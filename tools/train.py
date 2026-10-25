"""small/<음식>/*.jpg 로 음식 분류 모델 학습 → model.pt, classes.json, report.json
- MobileNetV3-Large(ImageNet 사전학습)에 한국 음식 150종을 추가로 가르침 (폰에서 빨리 돌아가는 크기)
- 음식마다 10%는 시험용으로 빼 두고 정확도를 잼
실행: venv/Scripts/python -I train.py [에폭 수]
"""
import json
import os
import random
import sys
import time

import torch
import torch.nn as nn
from PIL import Image, ImageFile
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms

ImageFile.LOAD_TRUNCATED_IMAGES = True
ROOT = os.path.dirname(os.path.abspath(__file__))
SMALL = os.path.join(ROOT, 'small')
EPOCHS = int(sys.argv[1]) if len(sys.argv) > 1 else 10
SIZE = 224
MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]


class Folder(Dataset):
    def __init__(self, items, tf):
        self.items, self.tf = items, tf

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        path, label = self.items[i]
        return self.tf(Image.open(path).convert('RGB')), label


def split():
    classes = sorted(d for d in os.listdir(SMALL) if os.listdir(os.path.join(SMALL, d)))
    rng = random.Random(42)
    train, val = [], []
    for ci, c in enumerate(classes):
        files = sorted(os.listdir(os.path.join(SMALL, c)))
        rng.shuffle(files)
        n_val = max(1, len(files) // 10)
        val += [(os.path.join(SMALL, c, f), ci) for f in files[:n_val]]
        train += [(os.path.join(SMALL, c, f), ci) for f in files[n_val:]]
    return classes, train, val


def evaluate(model, loader, dev):
    model.eval()
    top1 = top3 = n = 0
    with torch.no_grad(), torch.autocast('cuda', dtype=torch.float16):
        for x, y in loader:
            x, y = x.to(dev, non_blocking=True), y.to(dev)
            t3 = model(x).topk(3, 1).indices
            top1 += (t3[:, 0] == y).sum().item()
            top3 += (t3 == y[:, None]).any(1).sum().item()
            n += len(y)
    return top1 / n, top3 / n


def main():
    dev = 'cuda'
    classes, train, val = split()
    print(f'classes {len(classes)} train {len(train)} val {len(val)}', flush=True)
    tf_train = transforms.Compose([
        transforms.RandomResizedCrop(SIZE, scale=(0.45, 1.0)),
        transforms.RandomHorizontalFlip(),
        transforms.ColorJitter(0.25, 0.25, 0.2, 0.03),
        transforms.ToTensor(), transforms.Normalize(MEAN, STD),
    ])
    tf_val = transforms.Compose([transforms.Resize(SIZE), transforms.CenterCrop(SIZE), transforms.ToTensor(), transforms.Normalize(MEAN, STD)])
    tl = DataLoader(Folder(train, tf_train), batch_size=96, shuffle=True, num_workers=10, pin_memory=True, persistent_workers=True, drop_last=True)
    vl = DataLoader(Folder(val, tf_val), batch_size=192, num_workers=10, pin_memory=True, persistent_workers=True)

    model = models.mobilenet_v3_large(weights=models.MobileNet_V3_Large_Weights.IMAGENET1K_V2)
    model.classifier[3] = nn.Linear(model.classifier[3].in_features, len(classes))
    model.to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=0.05)
    steps = EPOCHS * len(tl)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=1e-3, total_steps=steps, pct_start=0.1)
    loss_fn = nn.CrossEntropyLoss(label_smoothing=0.1)
    scaler = torch.amp.GradScaler()

    best = 0.0
    history = []
    for ep in range(EPOCHS):
        model.train()
        t0 = time.time()
        for i, (x, y) in enumerate(tl):
            x = x.to(dev, non_blocking=True)
            y = y.to(dev, non_blocking=True)
            with torch.autocast('cuda', dtype=torch.float16):
                loss = loss_fn(model(x), y)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            sched.step()
            if i % 200 == 0:
                print(f'ep {ep + 1} step {i}/{len(tl)} loss {loss.item():.3f}', flush=True)
        a1, a3 = evaluate(model, vl, dev)
        history.append({'epoch': ep + 1, 'top1': round(a1, 4), 'top3': round(a3, 4), 'minutes': round((time.time() - t0) / 60, 1)})
        print(f'== ep {ep + 1} top1 {a1:.4f} top3 {a3:.4f} ({(time.time() - t0) / 60:.1f}분)', flush=True)
        if a1 > best:
            best = a1
            torch.save(model.state_dict(), os.path.join(ROOT, 'model.pt'))
    with open(os.path.join(ROOT, 'classes.json'), 'w', encoding='utf-8') as f:
        json.dump(classes, f, ensure_ascii=False)
    with open(os.path.join(ROOT, 'report.json'), 'w', encoding='utf-8') as f:
        json.dump({'best_top1': best, 'history': history, 'train': len(train), 'val': len(val)}, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
