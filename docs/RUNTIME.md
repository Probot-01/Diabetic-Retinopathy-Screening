# RUNTIME — what a grading deployment actually needs

**Measured 2026-09-26** on the dev machine (Windows 11, 23.7 GB RAM), branch
`laneb/engine-provenance`, with the defaults `INFERENCE_BACKEND=matlab`,
`SEG_INFERENCE_BACKEND=matlab`, `BRANCH_A_MODEL_VERSION=branchA_v2c` and
`RED_LESION_MODEL_VERSION=v2`. This file is the input to the deployment
decision. Every line below was observed on a running system, and the
**Evidence** section lists the commands. Anything that was not observed is
marked **not verified**.

Rule of thumb: the central grading server needs **both** MATLAB and Python,
whichever engine a model runs on. The MATLAB classifier path still preprocesses
its input in Python, and the red-lesion model (M5) has no MATLAB conversion.
The preprocessing step reads four metadata fields from the classifier's
PyTorch checkpoint. Since the later 2026-09-26 update they are cached on disk,
so torch is no longer imported per case.

---

## 1. Which engine runs what (live default path)

| Output | Engine | Where the dispatch is | Env switch |
|---|---|---|---|
| Branch A classifier (grade, calibration, conformal tier, Grad-CAM) | **MATLAB** persistent session (`branchAInferMatlab.m`), input tensor made by **Python** (`preprocessBranchATensor.py`) | `gradingOrchestrator.js` `runBranchA = INFERENCE_BACKEND === 'matlab' ? …` in `processCase` | `INFERENCE_BACKEND=matlab\|python` |
| M2 vessel U-Net (`vessel_unet_v1`) | **MATLAB** session forward pass; pre/post-processing in `segInfer.py` | `segInfer.py` `_run()` → `matlabSessionClient.forward` | `SEG_INFERENCE_BACKEND=matlab\|python` |
| M3 optic disc / fovea (`localization_v1`) | **MATLAB** session forward pass | same | same |
| M4 hard exudate (`bright_lesion_unet_v1`) | **MATLAB** session forward pass | same | same |
| M5 red lesion (`red_lesion_unet_v2`, 3-class) | **Python** (PyTorch), always. There is no MATLAB conversion of v2. | `segInfer.py` `_lesion_prob_v2` | none |
| Rule engine, branch agreement, camera check, NV score, lesion-attention, evidence text, urgency score | **MATLAB** session (`runCasePipeline.m`), falling back to `matlab -batch` (still MATLAB) when the session can't take the request | `gradingOrchestrator.js` `runCasePipelineMatlab` | `MATLAB_ALLOW_FALLBACK=1` allows the JS port **only** when MATLAB can't be spawned at all |
| PHC quality gate | **MATLAB**, via `matlab -batch` or the compiled exe on the MATLAB Runtime, at the PHC | `phc-local-app/backend/services/qualityGateClient.js` | `QUALITY_GATE_EXE`, `QUALITY_GATE_ALLOW_FALLBACK=1` |

Every graded case stores this per output as `engineProvenance` (see
`docs/api-contracts.md`, 2026-09-26).

## 2. MATLAB

**Release:** R2026a Update 5 (`26.1.0.3346908`), `matlabroot` = `D:\`.

### Licensed products actually checked out by the live grading path

`license('inuse')` was read after the same process had:
- loaded all five session networks and run a segmentation forward pass,
- run `branchAInferMatlab` on a real IDRiD tensor (`branchA_v2c`, grade 4),
- run `runCasePipeline` on a real case input (rule-engine grade 1),
- run `qualityGateMain` on a real IDRiD image.

| Feature (license name) | Product | Needed for |
|---|---|---|
| `matlab` | MATLAB | everything |
| `neural_network_toolbox` | **Deep Learning Toolbox** | loading and running the ONNX-imported networks (`dlarray`, `predict`) |
| `image_toolbox` | **Image Processing Toolbox** | quality gate, preprocessing and segmentation helpers |
| `statistics_toolbox` | **Statistics and Machine Learning Toolbox** | checked out during `runCasePipeline` (the urgency-score forest) |

### Support package, required but not a license feature

- **Deep Learning Toolbox Converter for ONNX Model Format** 26.1.7. Every
  network `.mat` in `models/` came from `importNetworkFromONNX`. Without this
  support package they deserialize into broken objects that only fail at
  `predict()`, and `ensureOnnxSupportOnPath.m` warns about it at session start.
  Each network also needs its generated `models/+<name>/` package folder on the
  path (tracked in git).

### Not installed here, and needed by one feature

- **MATLAB Report Generator.** `explainability/generateReport.m` (the downloadable evidence-report PDF behind `GET /api/v1/cases/:caseId/report`) uses `mlreportgen.dom`, which needs this product. It is **not installed on this machine**, so the report fails with a 502 and the Case Detail button shows the failure. Grading does not depend on it, which is why it is absent from the licensed-products table above. A deployment that serves reports must install it.

### Installed here but not needed by grading

| Product | Used by | Needed for a grading deployment? |
|---|---|---|
| Simulink, SimEvents | `simulink-model/runDistrictScreeningModel.m`, the weekly Simulink validation (`SIMULINK_VALIDATION_ENABLED`) | No, only if that weekly job runs on the same box |
| MATLAB Compiler | building the PHC quality-gate exe | No, a build-machine tool. PHCs run the exe on the free MATLAB Runtime |
| Medical Imaging Toolbox | not checked out by anything exercised | No evidence it is needed |

### Static analysis, and why it is not the source of truth here

- **`matlab.codetools.requiredFilesAndProducts` did not finish on this
  machine.** It ran for about 30 CPU-minutes on `runMatlabInferenceSession.m`
  before I killed it. It then passed 7 minutes on `qualityGateMain.m`, and
  10+ minutes on a one-line test function that only calls `rgb2gray`. So the
  slowness is in this MATLAB install, not the project code. Likely causes are
  the hand-patched `pathdef.m` from the MATLAB Compiler install, or D: at
  3.1 GB free. It should be re-run on a clean install.
- **`dependencies.toolboxDependencyAnalysis` did finish, but it is shallow.**
  It only reads the named file, not what it calls.

  | Entry point | Toolboxes it reports |
  |---|---|
  | `runMatlabInferenceSession.m`, `branchAInferMatlab.m` | Deep Learning Toolbox, MATLAB |
  | `runCasePipeline.m`, `generateReport.m`, `qualityGateMain.m`, `referenceQueueingModel.m` | MATLAB |
  | `runDistrictScreeningModel.m` | MATLAB, Simulink (SimEvents blocks in the `.slx` are not visible to it) |

  That is why the dynamic `license('inuse')` table above is the answer, not
  this one.
- **Not verified dynamically:** `generateReport.m` (the clinical-rationale PDF),
  `referenceQueueingModel.m` and `runDistrictScreeningModel.m`. Nothing on the
  grading path calls them, so they add nothing to the grading list above.

### RAM: the persistent MATLAB session with all models loaded

| Measurement | Value |
|---|---|
| `MATLAB.exe` private bytes, session serving live cases, **after lazy loading** (M2–M4 + `branchA_v2c`, after grading a case) | **≈ 2.1 GB** (2,088 MB) |
| `MATLAB.exe` working set, same | ≈ 2.1 GB (2,107 MB) |
| Before lazy loading (all 5 networks + `branchA_v2c`) | 2,216 MB and 2,228 MB private on two runs |
| `memory().MemUsedMATLAB` in a batch process: before loading, then with the same networks loaded after one run of each entry point | 1.5 GB → **3.0 GB** |
| `matlab.exe` launcher process | ≈ 11 MB |

**Lazy loading (later 2026-09-26).** The session loads only what its configured
backends need:
- M2–M4 when `SEG_INFERENCE_BACKEND=matlab`.
- The classifier, through `branchAInferMatlab.m`'s warm-up, when
  `INFERENCE_BACKEND=matlab`.

It no longer loads the never-served `branchA_v1` and `red_lesion_unet_v1`.
The saving measured about 130 MB private.

Start-up: the heartbeat appears within about a minute of launch on this
machine, including the three network loads (about 17 s) and a warm-up
inference. The supervisor
allows 240 s by default (`MATLAB_STARTUP_GRACE_MS`).

## 3. Python

**Interpreter:** CPython **3.11.16** (conda env `dr_screening`,
`C:\Users\Tanuj\miniconda3\envs\dr_screening\python.exe`). Set
`PYTHON_EXECUTABLE` to it.

### Distributions actually loaded by the live Python path

These were loaded after `preprocessBranchATensor.py` ran and `segInfer.run_one`
ran on a real IDRiD image, taken from `sys.modules` and mapped to
distributions (`importlib.metadata.packages_distributions`):

| Direct dependency | Version |
|---|---|
| torch | 2.5.1+cu121 |
| torchvision | 0.20.1+cu121 |
| timm | 1.0.29 |
| segmentation_models_pytorch | 0.5.0 |
| numpy | 2.4.6 |
| opencv-python | 5.0.0.93 |
| scipy | 1.17.1 |
| pillow | 12.3.0 |

Pulled in transitively by torch, timm and smp (install with them, and don't
pin separately unless needed): `huggingface_hub 1.30.0`, `safetensors 0.8.0`,
`httpx 0.28.1`, `httpcore 1.0.9`, `h11 0.16.0`, `anyio 4.15.1`, `idna 3.19`,
`certifi 2026.7.22`, `filelock 3.32.3`, `tqdm 4.70.0`, `PyYAML 6.0.3`,
`packaging 26.3`, `typing_extensions 4.16.0`, `sympy 1.13.1`, `mpmath 1.3.0`,
`threadpoolctl 3.6.0`, `click 8.5.0`, `colorama 0.4.6`, `Pygments 2.21.0`,
`setuptools 83.0.0`.

Notes for the deployment image:
- **`opencv-python-headless 5.0.0.93` is also installed** next to
  `opencv-python`. Both provide `cv2`, so whichever was installed last wins. A
  server image should install exactly one, headless.
- `ml-pipeline/requirements.txt` also lists `torchaudio`, `albumentations`,
  `pandas`, `scikit-learn` and `matplotlib`. **None of them is loaded on the
  grading path**; they are for training and analysis. `albumentations` and
  `matplotlib` are known to crash natively with opencv 5 on this machine.
- The CUDA build of torch is installed, but grading runs on CPU
  (`map_location="cpu"`). A CPU-only torch wheel is enough for a server
  without a GPU. **Not verified**: the outputs weren't compared on a CPU-only
  wheel.
- `GET /health` → `components.python` checks the interpreter and these six
  imports: `numpy`, `cv2`, `scipy`, `torch`, `timm`, `segmentation_models_pytorch`.

### RAM: Python processes

| Process | Private bytes |
|---|---|
| Persistent segmentation worker (`segSession/runSegWorker.py`), after serving a case, **after lazy loading** | **≈ 1.0 GB** (1,032 MB) |
| Same, before lazy loading (all four PyTorch models preloaded) | 2,021 MB |
| Per-case `preprocessBranchATensor.py` (short-lived, one per case) | not measured separately |

The worker preloads a PyTorch copy only for the roles that will run in PyTorch
(`runSegWorker.py` `_roles`). With the defaults that is M5 alone. M2–M4 are
added only with `SEG_INFERENCE_BACKEND=python` or `SEG_ALLOW_PYTHON_FALLBACK=1`.

## 4. Model files read at runtime

All paths are relative to `central-system/backend/ml-pipeline/models/`. The
weights are git-ignored and must be copied onto the server. The `+<name>/`
package folders are tracked.

### MATLAB session

| File | Size | Format | Used? |
|---|---|---|---|
| `branchA_v2c.mat` + `+branchA_v2c/` (39 files, 113 KB) | 15,006,999 B | ONNX-imported `dlnetwork` (`net`) | **yes**: the classifier |
| `calibration_branchA_v2c.json` | 1.1 KB | JSON (temperature, conformal) | **yes** |
| `vessel_unet_v1.mat` + `+vessel_unet_v1/` (27 files) | 90,954,651 B | ONNX-imported network | **yes**: M2 forward pass |
| `localization_v1.mat` + `+localization_v1/` (27 files) | 53,338,371 B | ONNX-imported network | **yes**: M3 |
| `bright_lesion_unet_v1.mat` + `+bright_lesion_unet_v1/` (27 files) | 91,003,465 B | ONNX-imported network | **yes**: M4 |
| `branchA_v1.mat`, `red_lesion_unet_v1.mat` | 15 MB, 91 MB | ONNX-imported networks | **no longer loaded** (lazy loading) |

### Python

| File | Size | Format | Used? |
|---|---|---|---|
| `Model1/v2c/branchA_v2c.pt` | 16,365,355 B | PyTorch checkpoint | **yes, but no longer per case**: `preprocessBranchATensor.py` reads its four preprocessing fields through `branchAInfer.load_preprocess_meta()`. That caches them in `%TEMP%\netrasetu_branchA_v2c_preprocess_meta.json`, keyed by path, size, mtime and version. Per-case preprocessing went from 2.96 s to 0.79 s. It is also the model when `INFERENCE_BACKEND=python`. |
| `red_lesion_unet_v2.pt` | 97,924,708 B | PyTorch checkpoint (3-class U-Net) | **yes**: M5 |
| `red_lesion_v2_config.json` | 2.1 KB | JSON (MA/HE area floors) | **yes** |
| `vessel_predictions(Model2)/vessel_unet_v1.pt` | 97,896,252 B | PyTorch checkpoint | loaded only on the Python seg path or with `SEG_ALLOW_PYTHON_FALLBACK=1` |
| `Model3/localization_v1.pt` | 57,426,675 B | PyTorch checkpoint | same |
| `Model4/bright_lesion_unet_v1.pt` | 293,539,147 B | PyTorch checkpoint | same |

### Rule-engine inputs

| File | Size | Format |
|---|---|---|
| `rule_thresholds_by_red_version.json` | 4.1 KB | JSON, read by `gradingOrchestrator.js` (thresholds per M5 version) |

### PHC (per site, not central)

`phc-local-app/backend/quality-gate-matlab/` holds `qualityGateMain.m` and
helpers plus `cameraPresets.json`, about 65 KB of source. It needs MATLAB with
Image Processing Toolbox, or the compiled exe on the MATLAB Runtime. The exe
build is still pending (see the MATLAB Compiler notes).

## 5. Other runtime pieces

- Node.js 22.19.0 for both backends.
- PostgreSQL 17 (`docker-compose.dev.yml` for dev).
- Two supervised long-lived workers per central server: the MATLAB session and
  the Python segmentation worker. Both are started and restarted by the
  backend through `manageMatlabSession.ps1` and `manageSegWorker.ps1`, so a
  Windows host is required as written. The restart path is PowerShell-only
  (`workerSupervisor.js`).
- **Peak RAM estimate for one central grading box:** MATLAB session ≈ 2.1 GB
  plus seg worker ≈ 1.0 GB (with lazy loading) plus Node and Postgres. A cold `matlab -batch`
  (report PDF, or the case-pipeline fallback) adds another MATLAB process of
  1.5 GB or more while it runs. Plan for **≥ 8 GB**.

## Evidence (commands run, 2026-09-26)

- Live grading, three IDRiD test images through `POST /api/v1/cases` on the
  lane-B stack: the MATLAB session log showed `seg … localization_v1`,
  `vessel_unet_v1`, `bright_lesion_unet_v1`, `branchA_…` and `casePipeline`
  requests. The seg worker log showed the per-case request, which ran M5 in
  PyTorch.
- RAM: `Get-CimInstance Win32_Process` (`PrivatePageCount`, `WorkingSetSize`)
  on `MATLAB.exe` and the seg worker's `python.exe` right after a graded case.
- MATLAB: `matlab -batch "cd('<scratch>'); runtimeDeps"`. It prints `version`,
  exercises the entry points, prints `license('inuse')`,
  `matlab.addons.installedAddons` and `memory()`, and runs
  `requiredFilesAndProducts` (killed, see above). Then
  `dependencies.toolboxDependencyAnalysis({...})` on each entry point.
- Python: a script importing `preprocessBranchATensor`, `branchAInfer`,
  `segInfer`, `gradcam`, `mcDropout` and `matlabSessionClient`, running the
  preprocessing and `segInfer.run_one` on IDRiD_005, then mapping `sys.modules`
  to distributions.
- Sizes: `stat -c %s` in `models/`, and `modelPaths.resolve()` for the `.pt`
  locations.
