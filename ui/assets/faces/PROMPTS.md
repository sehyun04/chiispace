# 캐릭터 얼굴 프롬프트
`ui/assets/faces/<slug>.png` 로 넣으면 앱이 알아서 집어 쓴다. 없으면 기본 도형으로 그린다.
묘사는 upstream kasaterm 의 `theme-src-chiikawa/<slug>/desc.txt` 에서 그대로 가져왔다 —
그림 생성에 넣으라고 만들어 둔 것이다.

**공통으로 덧붙이면 좋은 것**: 정사각형, 배경 없음(투명), 납작한 색면, 그림자 없음.
작게 줄여도 읽히도록.

## 파일 이름

| 넣는 이름 | 언제 쓰이나 |
|---|---|
| `<slug>.png` | 늘. 사이드바·pane 헤더·칸 안에 서는 그림 |
| `<slug>-work.png` | 그 칸이 일하는 중일 때만. 없으면 기본 그림이 통통 뛴다 |

**움직이는 그림은 만들어 준다.** 정지 그림만 넣고 이걸 돌리면 된다:

```powershell
python scripts/make-motion.py             # faces 의 모든 그림
python scripts/make-motion.py hachiware   # 한 명만
python scripts/make-motion.py --force     # 이미 있는 것도 다시
```

`<slug>.png` 한 장에서 `<slug>-work.png`(APNG)를 굽는다. 눌렀다 펴면서 뛰는 움직임이고,
프레임을 따로 그리지 않는다 — 스무 명분을 손으로 그릴 수 없고, 생성 AI 로 프레임을 뽑으면
장마다 캐릭터가 미세하게 달라져 떨린다. 세기는 스크립트 위쪽 상수(`LIFT`·`SQUASH`·`TILT`)로
조절한다.

**직접 만든 움직임을 넣어도 된다.** APNG 나 GIF 를 그 이름 그대로 넣으면 된다. 확장자는 `.png` 로 두어도
APNG 면 그냥 돌아간다 — `<img>` 가 알아서 재생하므로 코드는 손대지 않는다. upstream
kasaterm 도 걷기 동작을 APNG 로 갖고 있다. `-work.png` 를 따로 넣으면 우리가 통통 뛰게
만들지 않는다(움직임이 둘이면 산만해서).

**몸통까지 넣어도 된다.** 원 안에 통째로 앉히므로(`object-fit: contain`) 팔다리가
잘리지 않는다. 다만 캐릭터가 정사각형 한가운데에 오고 사방 여백이 비슷해야 원 안에서
치우쳐 보이지 않는다.

## 하치와레 · `hachiware.png`
색: `#6FB7E0` · 토벌대

```
Hachiware from the manga Chiikawa, a tiny two-head-tall round white cat creature: pure white pear-shaped body, very large round head merging into a small tapered lower body, a light blue bicolor fur marking painted flat across the top of the head with its lower edge dipping into two soft points just above the eyes, two small pointed cat ears, thick warm brown outline, two tiny black dot eyes set wide with short curved eyebrows above, a small w-shaped mouth, oval pink blush patches on both cheeks, four very short stubby limbs with no fingers, no clothes. No weapon.
```

## 치이카와 · `chiikawa.png`
색: `#B8A7C9` · 토벌대

```
Chiikawa from the manga Chiikawa, a tiny two-head-tall round white creature: pure white pear-shaped body, very large round head merging into a small tapered lower body, two small rounded ears on top, thick warm brown outline, two tiny black dot eyes set wide with short curved eyebrows above, a small w-shaped mouth, oval pink blush patches on both cheeks, four very short stubby limbs with no fingers, no clothes, no hair. No weapon.
```

## 우사기 · `usagi.png`
색: `#F2CE5B` · 토벌대

```
Usagi from the manga Chiikawa, a tiny two-head-tall round pale yellow rabbit creature: cream yellow pear-shaped body, very large round head merging into a small tapered lower body, two very long upright rabbit ears with pale pink inner lining, thick warm brown outline, two tiny black dot eyes set wide with short curved eyebrows above, a small w-shaped mouth, oval pink blush patches on both cheeks, four very short stubby limbs with no fingers, no clothes. No weapon.
```

## 모몽가 · `momonga.png`
색: `#8FCFE0` · 이웃

```
Momonga from the manga Chiikawa, a tiny two-head-tall round white flying squirrel creature: pure white pear-shaped body, very large round head merging into a small tapered lower body, two rounded ears with light blue inner lining, a large fluffy light blue and white striped tail curving up behind the body, thick warm brown outline, two closed crescent smiling eyes, a small light blue dot nose, a small w-shaped mouth, round pink blush patches on both cheeks, four very short stubby limbs with no fingers, no clothes. No weapon.
```

## 쿠리만쥬 · `kurimanju.png`
색: `#A87346` · 이웃

```
Kuri-Manju from the manga Chiikawa, a tiny two-head-tall round chestnut bun creature: cream beige pear-shaped body, very large round head merging into a small tapered lower body, the upper half of the head capped by a smooth dark brown chestnut shell like a bowl cut, no ears, thick warm brown outline, two tiny black dot eyes set wide, a small w-shaped mouth, oval pink blush patches on both cheeks, four very short stubby limbs with no fingers, no clothes. No weapon.
```

## 시사 · `shisa.png`
색: `#E89A5B` · 토벌대

```
Shisa from the manga Chiikawa, a tiny two-head-tall round cream colored lion-dog creature: pale cream pear-shaped body, very large round head merging into a small tapered lower body, a short mane of rounded orange curls framing both sides of the face, two small rounded ears on top, short orange curved eyebrows, thick warm brown outline, two tiny black dot eyes set wide, a small w-shaped mouth, oval pink blush patches on both cheeks, four very short stubby limbs with no fingers, no clothes. No weapon.
```

## 랏코 · `rakko.png`
색: `#C7A87E` · 토벌대

```
Rakko from the manga Chiikawa, a tiny two-head-tall round sea otter creature: pale cream pear-shaped body edged all around with short spiky fur tufts, very large round head merging into a small tapered lower body, a small pale cross-shaped scar on the forehead, a white cloth scarf wrapped around the neck, dark brown paws, thick warm brown outline, two tiny black dot eyes set wide with straight serious eyebrows, a small flat mouth, oval pink blush patches on both cheeks, four very short stubby limbs with no fingers. No weapon.
```

## 아노코 · `anoko.png`
색: `#7FA98A` · 토벌대

```
Anoko from the manga Chiikawa, a tiny two-head-tall round white creature: pure white pear-shaped body covered in soft shaggy fur, very large round head merging into a small tapered lower body, a single curved dark green horn with pale ridges growing upward from the top of the head, a small orange diamond mark on the forehead, thick warm brown outline, two tiny black dot eyes set wide, a small w-shaped mouth, four very short stubby limbs with no fingers, no clothes. No weapon.
```

## 치이카부 · `chiikabu.png`
색: `#8B5E3C` · 이웃

```
Chiikabu from the manga Chiikawa, a tiny two-head-tall round white creature wearing a thick dark brown ring-shaped costume that wraps all the way around its body and leaves only the round white face showing in the center, a small brown loop standing on top of the costume, thick warm brown outline, two tiny black dot eyes set wide, a small w-shaped mouth, oval pink blush patches on both cheeks, two short brown stubby legs at the bottom, no hair. No weapon.
```

## 데카츠요 · `dekatsuyo.png`
색: `#E8D44D` · 토벌 대상

```
Dekatsuyo from the manga Chiikawa, a large shaggy monster drawn in the same simple cartoon style: a bulky body entirely covered in long ragged bright yellow fur, a pale white face set in the middle of the fur, two curved cream horns on the head, two round eyes with red irises, a wide grinning mouth full of small pointed teeth with a long red tongue hanging out, thin dark limbs, thick dark outline, no clothes. No weapon.
```

## 헌책방 · `furuhonya.png`
색: `#F0A8BC` · 이웃

```
Furuhonya from the manga Chiikawa, a tiny two-head-tall round pale pink creature: pale pink pear-shaped body, very large round head merging into a small tapered lower body, a darker pink headband worn flat across the top of the head, two small rounded pink ears standing above the headband, thick warm brown outline, two tiny black dot eyes set wide with short curved eyebrows above, a small w-shaped mouth, oval pink blush patches on both cheeks, four very short stubby limbs with no fingers. No weapon.
```

## 마녀 · `majo.png`
색: `#4A4458` · 토벌 대상

```
Majo from the manga Chiikawa, a tall rounded pitch black creature drawn in the same simple cartoon style: a smooth solid black teardrop-shaped body with no visible limbs, two large white circular eyes with small black pupils set side by side near the top, a row of pale green leaf-shaped fronds spreading across the lower front of the body, thick dark outline, no clothes, no hair, no mouth. No weapon.
```

## 무챠우만 · `muchauman.png`
색: `#7FB2D9` · 이웃

```
Muchauman from the manga Chiikawa, a standing ceramic jar creature drawn in the same simple cartoon style: a tall smooth cylindrical jar body in light warm grey (clearly grey, never pure white) slightly wider at the top with a raised rim and a small round loop handle on the rim, two tiny black dot eyes set wide apart on the upper front of the jar body, no mouth and no nose, a light blue cape fastened at the shoulders and hanging down the back, a light blue belt around the waist, two short grey arms ending in rounded fists, two short grey legs, a thick dark brown outline drawn all the way around every part of the body and limbs, no hair. No weapon.
```

## 오데 · `ode.png`
색: `#E3D07A` · 토벌대

```
Ode from the manga Chiikawa, a tiny two-head-tall round pale yellow creature: pale yellow pear-shaped body, very large round head merging into a small tapered lower body, a small sprig of green broccoli florets sitting on top of the head, a black and white horizontally striped shirt covering the lower body, thick dark outline, two round white eyes with small black pupils, a wide open mouth showing a row of small teeth, four very short stubby limbs with no fingers. No weapon.
```

## 포셰트 요로이산 · `pochetteyoroi.png`
색: `#B9BCC2` · 요로이산

```
Pochette Yoroi-san from the manga Chiikawa, a slim five-head-tall knight drawn in the same simple cartoon style: a full suit of pale grey plate armour covering the whole body, a rounded helmet with a horizontal slit visor and a small grille over the mouth, segmented arms and legs with rounded joints, a small pink pig-faced pouch hanging at the waist, thin dark outline, flat cel shading, no skin showing, no face visible. No weapon.
```

## 라멘 요로이산 · `ramenyoroi.png`
색: `#C7B54A` · 요로이산

```
Ramen Yoroi-san from the manga Chiikawa, a slim five-head-tall knight drawn in the same simple cartoon style: a full suit of mustard yellow plate armour covering the whole body, a rounded helmet with a white crown and a horizontal slit visor with a small grille over the mouth, segmented arms and legs with rounded joints, thin dark outline, flat cel shading, no skin showing, no face visible. No weapon.
```

## 노동 요로이산 · `laboryoroi.png`
색: `#B0A79A` · 요로이산

```
Labor Yoroi-san from the manga Chiikawa, a slim five-head-tall knight drawn in the same simple cartoon style: a full suit of warm beige grey plate armour covering the whole body, a rounded helmet with a horizontal slit visor and a small grille over the mouth, segmented arms and legs with rounded joints, thin dark outline, flat cel shading, no skin showing, no face visible. No weapon.
```

## 검은별 · `blackstar.png`
색: `#4B4F58` · 밤하늘

```
Black Star from the manga Chiikawa, a small five-pointed star creature drawn in the same simple cartoon style: a solid dark charcoal grey star-shaped body with soft rounded points, two small white oval eyes with black pupils set side by side, a tiny open oval mouth below them, thick dark outline, no limbs, no clothes, no hair. No weapon.
```

## 유성 · `shootingstar.png`
색: `#F2D64B` · 밤하늘

```
Shooting Star from the manga Chiikawa, a small five-pointed star creature drawn in the same simple cartoon style: a solid bright yellow star-shaped body with soft rounded points, two small black dot eyes set close together, a small wavy mouth below them, thick dark outline, no limbs, no clothes, no hair. No weapon.
```

## 고블린 · `goblin.png`
색: `#9DBE87` · 토벌 대상

```
Goblin from the manga Chiikawa, a tiny two-head-tall round pale green creature: pale sage green pear-shaped body, very large round head merging into a small tapered lower body, two small pointed ears sticking out sideways, a dark brown fur loincloth around the waist, thick warm brown outline, two tiny black dot eyes set wide, a small w-shaped mouth, oval pink blush patches on both cheeks, four very short stubby limbs with no fingers. No weapon.
```
