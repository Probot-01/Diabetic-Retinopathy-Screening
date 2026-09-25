# Commands

> Commands are written for **PowerShell** (Windows), which has no `&&`: chained steps use `;`.
> In bash the same lines work unchanged.

## One command (recommended)

```bash
npm run dev:all          # Postgres (docker) + migrations + seed + all four services + MATLAB check
npm run dev:check        # same, then prints health and stops
```

See the README's "Run locally". The manual steps below still work.

## Install

```bash
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install timm segmentation-models-pytorch opencv-python numpy
```

```bash
cd central-system/backend; npm install
cd ../frontend; npm install
cd ../../phc-local-app/backend; npm install
cd ../frontend; npm install
```

```bash
createdb dr_screening_central
cd central-system/backend; npm run setup-db
cd ../../phc-local-app/backend; npm run setup-db
```

Each service has its own `.env` (copy its `.env.example`). A repo-root `.env`
is still read by both backends as a fallback:

```ini
# central-system/backend/.env
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/dr_screening_central
MATLAB_EXECUTABLE=matlab
MATLAB_TIMEOUT_MS=120000
SMS_DRY_RUN=1
# phc-local-app/backend/.env
CENTRAL_API_URL=http://localhost:5000
```

Frontend `.env` (or Vercel project settings):

```ini
VITE_DATA_MODE=live                           # mock = fixtures + DEMO DATA banner
VITE_CENTRAL_API_BASE=http://localhost:5000   # central-system/frontend
VITE_LOCAL_API_BASE=http://localhost:4000     # phc-local-app/frontend
```

## Run

```bash
cd central-system/backend; npm start
```

```bash
cd phc-local-app/backend; npm start
```

```bash
cd central-system/frontend; npm run dev
```

## Verify

### Environment

```bash
node -v
python --version
matlab -batch "disp(version)"
```

```bash
python -c "import torch,timm,cv2,numpy,segmentation_models_pytorch as smp; print('torch',torch.__version__,'timm',timm.__version__,'cv2',cv2.__version__,'smp',smp.__version__)"
```
`torch 2.14.0+cpu timm 1.0.29 cv2 5.0.0 smp 0.5.0`

```bash
matlab -batch "ver" 
```
Image Processing · Computer Vision · Medical Imaging

### Models

```bash
cd central-system/backend/ml-pipeline/inference; python modelPaths.py
```
`all five checkpoints resolved`

```bash
cd central-system/backend/ml-pipeline/inference; python branchAInfer.py ../../../../datasets/2.jpg
```
`"drGradeCnn": 3` · `"confidenceScore": 0.8173` · `"conformalTier": "B"`

```bash
cd central-system/backend/ml-pipeline/inference; python segInfer.py ../../../../datasets/2.jpg
```
`"redPerQuadrant": [43, 15, 82, 56]`

### Recipes reproduce published output

```bash
cd central-system/backend/ml-pipeline/inference; python verifyModel3.py
```
`77/78 (98.7%)` · `recipe REPRODUCES the model`

```bash
cd central-system/backend/ml-pipeline/inference; python verifySegModels.py
```
`linear exact 100.000%` · `max per-image diff 0.00047` · `all requested checks passed`

```bash
cd central-system/backend/ml-pipeline/experiments; python verifyRuleEngineCounts.py
```
`sum(red) exact: 14/14` · `rule-engine grade equal: 14/14`

### MATLAB

```bash
cd central-system/backend/ml-pipeline/grading; matlab -batch "testBranchB"
```
`54/54 passed`

```bash
cd central-system/backend/ml-pipeline/explainability; matlab -batch "testPhase7Explainability"
```
`58 checks, 0 failed`

```bash
cd phc-local-app/backend/quality-gate-matlab; matlab -batch "testQualityGateDeploy"
```
`22 checks, 0 failed`

```bash
node verify_fallback_parity.js
```
`720 cases x 8 fields, 0 mismatched`

### Live pipeline simulation

```bash
node scripts/exportSimCalibration.js
```
5 measured, 10 assumed

```bash
cd simulink-model; matlab -batch "buildFullPipelineModel"
```
`Blocks: 68`

```bash
matlab -sd "$PWD\simulink-model" -r "runFullPipelineModel"
```
opens the MATLAB desktop and the model; `-batch` cannot show a window

```bash
cd simulink-model; matlab -batch "runFullPipelineModel('Pace',0,'Show',false)"
```
122 auto-cleared · 31 referred · 24 cleared · queues empty

### Parallel (Parallel Computing Toolbox)

```bash
cd simulink-model; matlab -batch "sweepDistrictScenarios('Workers',4)"
```
18 scenarios, ~185 s on 4 workers

```bash
cd simulink-model; matlab -batch "monteCarloQueueing('Replications',20,'Workers',4)"
```
4 scenarios x 20 seeds, ~3 s, each figure with a 95% CI

```bash
cd phc-local-app/backend/quality-gate-matlab; matlab -batch "calibrateQualityThresholds('N',40,'Workers',4)"
```
focus 0.17 -> 97.5% clean accepted, 100% JPEG-10 rejected

```bash
cd central-system/backend/ml-pipeline/explainability; matlab -batch "batchGenerateReports('<dir of case JSONs>')"
```
6 PDFs: 24.2 s serial, 8.6 s on 3 workers

### Training corpus from reviews

```bash
node scripts/exportTrainingSet.js --list
```
counts per grade and label source

```bash
node scripts/exportTrainingSet.js --out exports/batch1 --copy-images
```
`labels.csv` · `DATASET_CARD.md` · `images/`

### CORS

```bash
cd central-system/backend; node middleware/testCors.js
```
`all checks passed`

```bash
curl -i -X OPTIONS http://localhost:5000/api/v1/ophthalmologist/queue -H "Origin: https://demo.vercel.app" -H "Access-Control-Request-Method: GET"
```
`204` · `Access-Control-Allow-Origin: https://demo.vercel.app`

```bash
curl -i http://localhost:5000/api/v1/ophthalmologist/queue -H "Origin: https://evil-vercel.app"
```
no `Access-Control-Allow-Origin`

### End to end

```bash
curl http://localhost:5000/health
```
`{"status":"ok"}`

```bash
node verify_task33.js
```
`Task 3.3 DoD met`

```bash
node verify_task34.js
```
`Task 3.4 DoD met`

### Database state

```bash
psql "$DATABASE_URL" -c "\dt"
```
12 tables

```bash
cd central-system/backend; node -e "const p=require('./db/pgClient');(async()=>{const r=await p.query(\`SELECT g.dr_grade_cnn cnn,g.dr_grade_rule_engine rule,g.branch_agreement agree,g.conformal_tier tier,g.uncertainty_score unc,e.lesion_attention_consistency_score lac,e.gradcam_path IS NOT NULL gradcam,s.lesion_counts->>'redTotal' red FROM grading_results g LEFT JOIN explainability_outputs e USING(case_id) LEFT JOIN segmentation_outputs s USING(case_id) ORDER BY g.graded_at DESC LIMIT 1\`);console.table(r.rows);process.exit(0)})()"
```
`cnn` `tier` `unc` `lac` `gradcam` `red` non-null · `agree` may be null

```bash
cd central-system/backend; node -e "const p=require('./db/pgClient');(async()=>{const r=await p.query(\"SELECT status,count(*) FROM cases GROUP BY status\");console.table(r.rows);process.exit(0)})()"
```
no rows stuck on `processing`

### Timing

```bash
cd central-system/backend; node -e "const {processCase}=require('./services/gradingOrchestrator');const p=require('./db/pgClient');(async()=>{const r=await p.query(\"SELECT case_id FROM cases WHERE status='graded' ORDER BY received_at DESC LIMIT 1\");const t=Date.now();await processCase(r.rows[0].case_id);console.log(((Date.now()-t)/1000).toFixed(1)+'s');process.exit(0)})()"
```
`~12.5s`
