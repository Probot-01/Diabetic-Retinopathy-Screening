# Datasets

**None of these are in git.** They are fetched by hand per machine.

> **Status on this checkout, 2026-09-28:** DRIVE, IDRiD (grading, segmentation and
> localization) and CHASE_DB1 **are present**. The table below still reads
> "not downloaded" from when none of them were; treat the table as the list of
> what each dataset unblocks, not as the current state. `datasets/` also holds
> five loose sample fundus images (`1.webp`…`5.jpg`) used for smoke tests —
> `scripts/seedTestCase.js` defaults to `2.jpg`, which is why a seeded database
> can look like many cases of one eye.

This file is the blocker for Phase 4. Tasks 4.1–4.3 train U-Nets and cannot
start without DRIVE and IDRiD.

---

## What each dataset unblocks

| Dataset | Size | Labels | Needed by | Status |
|---|---|---|---|---|
| **DRIVE** | 40 images | pixel-level vessel masks | Task 4.1 vessel U-Net | ⬜ not downloaded |
| **IDRiD — segmentation** | 81 images | pixel-level lesion masks (MA, HE, EX, SE) | Tasks 4.2, 4.3 | ⬜ not downloaded |
| **IDRiD — grading** | 516 images | DR + DME grade 0–4 | Tasks 2.2/2.3 | ⬜ not downloaded |
| **IDRiD — localization** | 516 images | optic disc + fovea coordinates | Task 4.5 refinement, and its DoD | ⬜ not downloaded |
| **APTOS 2019** | 3,662 images | DR severity 0–4 (image-level) | Tasks 2.2/2.3 | ⬜ not downloaded |
| **Messidor-2** | ~1,748 images | adjudicated DR grading | Task 9.3 external validation | ⬜ not downloaded |

Task 4.5 (optic disc / fovea) and Task 4.4 (NV suspicion) are built and testable
**without** any of these — they are classical CV. Only the U-Nets and the
metric-reporting tasks are blocked.

---

## Where to get them

| Dataset | Source |
|---|---|
| DRIVE | <https://drive.grand-challenge.org/> — registration required |
| IDRiD | <https://idrid.grand-challenge.org/> — registration required; also mirrored on IEEE DataPort |
| APTOS 2019 | <https://www.kaggle.com/competitions/aptos2019-blindness-detection/data> — Kaggle account + competition rules acceptance |
| Messidor-2 | <https://www.adcis.net/en/third-party/messidor2/> — request form |

All four are free for research use but **all four require you to accept licence
terms**. Read them: some prohibit redistribution, which is a second reason (on
top of size) that none of this belongs in git.

---

## Expected layout

The code resolves these paths literally. Unzip to match exactly, or the
datastore builders in `training/` will silently find zero images and report a
successful run on an empty set.

```
datasets/
├── aptos2019/
│   ├── train_images/           *.png
│   └── train.csv               columns: id_code, diagnosis (0-4)
├── idrid/
│   ├── grading/
│   │   ├── images/             *.jpg
│   │   └── labels.csv          columns: Image name, Retinopathy grade, Risk of macular edema
│   ├── segmentation/
│   │   ├── images/             *.jpg
│   │   └── masks/
│   │       ├── microaneurysms/ *_MA.tif
│   │       ├── haemorrhages/   *_HE.tif
│   │       ├── hard_exudates/  *_EX.tif
│   │       └── soft_exudates/  *_SE.tif
│   └── localization/
│       ├── images/             *.jpg
│       └── coordinates.csv     columns: Image No, X- Coordinate, Y - Coordinate
├── drive/
│   ├── training/
│   │   ├── images/             *_training.tif
│   │   └── 1st_manual/         *_manual1.gif
│   └── test/
│       ├── images/             *_test.tif
│       └── 1st_manual/         *_manual1.gif
└── messidor2/
    ├── images/                 *.jpg
    └── messidor_data.csv
```

> The original archives do **not** use these folder names — IDRiD in particular
> ships deeply nested directories with spaces in them. Rename as you unzip.
> Verify with `scripts/checkDatasets.js` before starting a training run.

---

## Two warnings worth reading before training

**A near-empty datastore does not error.** `imageDatastore` over a folder that
does not match returns zero files, and training on it reports a clean run with
meaningless metrics. Always check the file count first.

**These are real patient images.** They are de-identified and licensed for
research, but they are still fundus photographs of real people. Do not commit
them, do not put them in a shared drive that is public, and do not paste them
into third-party services. `.gitignore` covers the folders listed above; if you
unzip somewhere else, add that path too.
