"""data/ 원본 사진 → small/<음식>/*.jpg (짧은 변 256px)
학습 때마다 큰 원본을 읽으면 느려서 한 번 줄여 둔다. crop_area.properties가 있으면 음식 부분만 잘라 씀.
실행: venv/Scripts/python -I prep.py
"""
import os
import sys
from concurrent.futures import ProcessPoolExecutor

from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True
ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'data')
DST = os.path.join(ROOT, 'small')
SIDE = 256
IMG = ('.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp')


def read_crops(folder):
    # crop_area.properties: "<파일이름(확장자 제외)>=x,y,w,h"
    crops = {}
    for fn in os.listdir(folder):
        if fn.endswith('.properties'):
            with open(os.path.join(folder, fn), encoding='utf-8', errors='ignore') as f:
                for line in f:
                    if '=' not in line:
                        continue
                    k, v = line.strip().split('=', 1)
                    try:
                        x, y, w, h = (int(float(t)) for t in v.split(','))
                        if w > 20 and h > 20:
                            crops[k.strip()] = (x, y, x + w, y + h)
                    except ValueError:
                        pass
    return crops


def job(args):
    src, dst, box = args
    if os.path.exists(dst):
        return 1
    try:
        im = Image.open(src)
        im = im.convert('RGB')
        if box:
            # 음식 상자보다 10%씩 넓게 잘라 접시 일부도 보이게 (실제 폰 사진과 비슷하게)
            x0, y0, x1, y1 = box
            mx, my = (x1 - x0) * 0.1, (y1 - y0) * 0.1
            im = im.crop((max(0, x0 - mx), max(0, y0 - my), min(im.width, x1 + mx), min(im.height, y1 + my)))
        k = SIDE / min(im.size)
        if k < 1:
            im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.BILINEAR)
        im.save(dst, 'JPEG', quality=88)
        return 1
    except Exception:
        return 0


def main():
    tasks = []
    for dirpath, _, files in os.walk(SRC):
        imgs = [f for f in files if f.lower().endswith(IMG)]
        if not imgs:
            continue
        food = os.path.basename(dirpath)
        crops = read_crops(dirpath)
        out = os.path.join(DST, food)
        os.makedirs(out, exist_ok=True)
        for f in imgs:
            stem = os.path.splitext(f)[0]
            tasks.append((os.path.join(dirpath, f), os.path.join(out, stem + '.jpg'), crops.get(stem)))
    print('images', len(tasks), 'classes', len(os.listdir(DST)), flush=True)
    ok = 0
    with ProcessPoolExecutor(max_workers=os.cpu_count()) as ex:
        for i, r in enumerate(ex.map(job, tasks, chunksize=64)):
            ok += r
            if i % 10000 == 0:
                print(i, flush=True)
    print('ok', ok, 'failed', len(tasks) - ok, flush=True)


if __name__ == '__main__':
    sys.exit(main())
