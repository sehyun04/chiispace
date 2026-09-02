# 정지 그림 한 장에서 "일하는 중" 움직임을 만든다.
#
#   python scripts/make-motion.py             # faces 의 모든 그림
#   python scripts/make-motion.py hachiware   # 한 명만
#   python scripts/make-motion.py --force     # 이미 있는 것도 다시 만든다
#
# <slug>.png -> <slug>-work.png (APNG). 앱은 그 칸이 일하는 중일 때 그것을 쓰고,
# 있으면 CSS 로 통통 뛰게 만들지 않는다 — 움직임이 둘이면 산만해서다.
#
# 프레임을 따로 그리지 않는 이유: 스무 명분을 손으로 그릴 수 없고, 생성 AI 로
# 프레임을 뽑으면 장마다 캐릭터가 미세하게 달라져 떨린다. 한 장을 눌렀다 펴는
# 편이 오히려 손그림처럼 보인다 — 2D 애니메이션의 squash & stretch 그대로다.

import math
import sys
from pathlib import Path

from PIL import Image

FACES = Path(__file__).resolve().parent.parent / "ui" / "assets" / "faces"

FRAMES = 14
SIZE = 256  # 화면에서는 84px 이 최대라 이 정도면 충분하다
MS = 70  # 프레임 간격. 14프레임이면 한 번 뛰는 데 약 1초

# 움직임의 세기. 크게 주면 귀엽기보다 정신없다.
LIFT = 0.13  # 뜨는 높이(그림 높이 대비)
SQUASH = 0.10  # 바닥에서 눌리는 정도
TILT = 2.5  # 기울기(도)


def frame(base: Image.Image, t: float) -> Image.Image:
    """위상 t(0..1) 에서의 한 장. t=0 이 바닥, t=0.5 가 꼭대기다."""
    w, h = base.size
    lift = math.sin(math.pi * t)  # 0 -> 1 -> 0
    ground = (1.0 - lift) ** 2  # 바닥에 가까울수록 1

    # 뜰 때는 살짝 길쭉해지고, 닿을 때는 눌리면서 옆으로 퍼진다.
    sx = 1.0 + SQUASH * ground - 0.4 * SQUASH * lift
    sy = 1.0 - SQUASH * ground + 0.4 * SQUASH * lift

    body = base.resize((max(1, int(w * sx)), max(1, int(h * sy))), Image.LANCZOS)
    if TILT:
        body = body.rotate(TILT * math.sin(2 * math.pi * t), resample=Image.BICUBIC, expand=True)

    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    # 바닥은 붙여 두고 위로만 뜬다. 가운데 정렬로 두면 뛰는 게 아니라 떠 있게 보인다.
    x = (w - body.width) // 2
    y = h - body.height - int(h * LIFT * lift)
    canvas.alpha_composite(body, (x, max(0, y)))
    return canvas


def fit(src: Image.Image, size: int) -> Image.Image:
    """정사각 캔버스 안에 넣는다. 뛸 자리를 위쪽에 비워 둔다."""
    img = src.convert("RGBA")
    room = int(size * (1.0 - LIFT))  # 뜨는 높이만큼 캐릭터를 작게
    img.thumbnail((room, room), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(img, ((size - img.width) // 2, size - img.height))
    return canvas


def build(png: Path, force: bool) -> str:
    out = png.with_name(f"{png.stem}-work.png")
    if out.exists() and not force:
        return f"{png.stem}: 이미 있어서 건너뜀 (--force 로 다시 만든다)"
    base = fit(Image.open(png), SIZE)
    frames = [frame(base, i / FRAMES) for i in range(FRAMES)]
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=MS,
        loop=0,
        disposal=2,  # 매 장 지우고 그린다. 안 그러면 잔상이 겹쳐 뭉개진다.
    )
    return f"{png.stem}: {out.name} ({len(frames)}장, {out.stat().st_size // 1024}KB)"


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    force = "--force" in sys.argv
    pngs = sorted(
        p
        for p in FACES.glob("*.png")
        if not p.stem.endswith("-work") and (not args or p.stem in args)
    )
    if not pngs:
        print(f"만들 그림이 없다: {FACES}")
        return 1
    for p in pngs:
        print(build(p, force))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
