# Explainable AI for Diabetic Retinopathy Screening in Rural India (DR✦AI)

A dual-tier AI-powered clinical screening and diagnostic platform designed to detect Diabetic Retinopathy (DR) in low-resource rural Primary Health Centres (PHCs) and seamlessly triage patients to tertiary hospitals.

Inspired by cyber-brutalist and high-density telemetry dashboards, the platform prioritizes real-time explainability (Grad-CAM), offline-first resilience, and actionable clinical decision support.

---

## 🏗 System Architecture

The project consists of two core applications:

```
Explainable-AI-for-Diabetic-Retinopathy-in-Rural-India/
├── phc-local-app/             # Rural Clinic Edge Node
│   └── frontend/              # Offline-first React + Vite local screening client
├── central-system/            # Tertiary Hospital / Specialist Hub
│   └── frontend/              # Central review, explainability, & district administration
├── datasets/                  # Retinal fundus training & validation sets
├── simulink-model/            # Optical simulation & edge hardware models
└── docs/                      # Clinical protocols and architecture blueprints
```

---

## 🌟 Key Capabilities

### 1. PHC Local Screening Station (`phc-local-app`)
* **Offline-First Patient Registration**: Full demographic intake, vitals (BP, HbA1c, glucose), and diabetic history.
* **Retinal Fundus Image Acquisition**: Guided capture protocol with image quality assurance.
* **Edge Inference Engine**: Immediate classification across standard clinical stages (Normal, Mild NPDR, Moderate NPDR, Severe NPDR, PDR).
* **Local Sync Queue**: Encrypted offline store with store-and-forward sync when connectivity resumes.

### 2. Central Diagnostics & Triage Hub (`central-system`)
* **Dual-Role Access**: Dedicated portals for Ophthalmologists and District Health Administrators.
* **Explainable AI (Grad-CAM)**: Real-time visual heatmaps pinpointing microaneurysms, hemorrhages, and exudates.
* **Dual-Branch Comparison**: Multi-stage model cross-validation with feature attribution confidence scores.
* **Clinical Decision Support**: Specialist confirmation, severity override, referral dispatch, and longitudinal patient audit trail.
* **District Admin Analytics**: Bento-grid surveillance with screening rates, disease prevalence, and PHC node health.

---

## 🚀 Run locally

One command starts the whole system: Postgres, migrations, seed data, both
backends, both web frontends, and the persistent MATLAB session.

### Prerequisites

| | Version | Notes |
|---|---|---|
| **Node.js** | 18+ (22 LTS tested) | npm comes with it |
| **Docker** | Docker Desktop / Engine with Compose v2 | runs Postgres only; on Windows `dev-up` starts Docker Desktop if it is installed |
| **MATLAB** | R2026a (tested: Update 5) | required for the default engine (`INFERENCE_BACKEND=matlab`). Toolboxes: **Deep Learning**, **Image Processing**, **Statistics and Machine Learning**, **Medical Imaging**. Optional: **Simulink + SimEvents** (weekly co-validation of the resource model), **MATLAB Compiler** (standalone quality-gate exe). `matlab` must be on `PATH`, or set `MATLAB_EXECUTABLE` in `central-system/backend/.env` and `phc-local-app/backend/.env`. |
| **Python** | 3.11 (conda env `dr_screening`) | only for the Python segmentation worker / `INFERENCE_BACKEND=python`: `pip install -r central-system/backend/ml-pipeline/requirements.txt` (install the CUDA PyTorch wheel first, see that file). Point `PYTHON_EXECUTABLE` at it. |

No Redis: the grading queue runs in-process in the central backend.

### Start

```bash
git clone <repo> && cd SIH_2026
npm run dev:all              # or: scripts/dev-up.sh   |   .\scripts\dev-up.ps1  (Windows)
```

On the first run this:

1. copies every service's `.env.example` to `.env` (existing `.env` files are never touched);
2. runs `npm install` in each service that has no `node_modules`;
3. starts Postgres in Docker (`docker-compose.dev.yml`, host port **5433**, named volume `netrasetu_pgdata`);
4. applies the migrations (`central-system/backend/db/migrations`, node-pg-migrate);
5. seeds two demo users and two PHC sites and **prints their passwords and API keys once**. PHC001's `PHC_ID`/`PHC_API_KEY` are written into `phc-local-app/backend/.env`. If the PHC's local database has no technician, one (`technician`) is created and its password printed once. **No cases are seeded.** Cases only enter through capture → sync → grading;
6. starts the central API, PHC local API, central web and PHC web, checks each health endpoint, waits for the MATLAB session heartbeat, and prints:

| Service | URL |
|---|---|
| PHC web (technician) | http://localhost:5173 |
| Central web (ophthalmologist / district admin) | http://localhost:5174 |
| Central API | http://localhost:5000 (`/health`) |
| PHC local API | http://localhost:4000 (`/health`) |
| Postgres | `localhost:5433`, user `netrasetu`, db `dr_screening_central` |

Ctrl+C stops the four services. Postgres keeps running (`npm run db:down` stops it). The MATLAB session is a separate process and keeps running too; the next run reuses it.

`npm run dev:check` does the same, prints the summary, then stops the services and exits non-zero if anything is unhealthy.

Lost the printed credentials? `node scripts/seed-demo.js --force --write-phc-env` issues new ones (the old ones stop working).

### Configuration

Every service reads its config from its own `.env`; each `.env.example` lists every variable that service reads, with comments:

| File | Key variables |
|---|---|
| `central-system/backend/.env` | `DATABASE_URL`, `CORS_ALLOWED_ORIGINS` (comma-separated; `*` refused), `AUTH_ENABLED`, `JWT_SECRET`, `PHC_AUTH_ENABLED`, `MATLAB_EXECUTABLE`, `INFERENCE_BACKEND` |
| `phc-local-app/backend/.env` | `CENTRAL_API_URL`, `PHC_CODE`, `PHC_ID`, `PHC_API_KEY`, `MATLAB_EXECUTABLE` |
| `central-system/frontend/.env` | `VITE_CENTRAL_API_BASE`, `VITE_DATA_MODE` |
| `phc-local-app/frontend/.env` | `VITE_LOCAL_API_BASE`, `VITE_DATA_MODE` |
| `phc-local-app/mobile/.env` | `EXPO_PUBLIC_CENTRAL_API_URL`, `EXPO_PUBLIC_PHC_API_KEY`, `EXPO_PUBLIC_PHC_CODE` |

No app has a built-in server URL: an unset URL is reported as an error on screen. A `<repo root>/.env` is still read by both backends as a fallback after their own `.env`.

### Data mode: live vs. demo

`VITE_DATA_MODE` in each web frontend's `.env`:

- **`live`** (default): every screen calls the real backend. A failed request shows an error state. It is never replaced with mock data.
- **`mock`**: fixture data only, no backend needed, with a permanent **"DEMO DATA — not real results"** banner on every page.

Nothing switches between the two at runtime. The Vercel demo deployments are
set to mock in each frontend's `vercel.json`
(`buildCommand: VITE_DATA_MODE=${VITE_DATA_MODE:-mock} npm run build`), so they
carry the banner. Setting `VITE_DATA_MODE=live` in the Vercel project's env
vars overrides this.

### Running a service on its own

```bash
npm run db:up && npm run db:migrate && npm run db:seed    # database only
cd central-system/backend  && npm start                    # :5000
cd phc-local-app/backend   && npm start                    # :4000
cd central-system/frontend && npm run dev                  # :5174 (strictPort)
cd phc-local-app/frontend  && npm run dev                  # :5173 (strictPort)
```

---

## 🎨 Design Philosophy

* High-contrast brutalist aesthetics with dark-room clinical palette (`#E63B2E` / `#0A0A0A`).
* Interactive canvas waves depicting retinal pulse frequencies.
* Monospace telemetry logs and tactile cyber-clinical controls.

