# Test fixtures: fundus images

Four small fundus photographs for the PHC capture → sync → result flow
(`tests/e2e/`, `phc-local-app/backend/test/`). Public-dataset images only
(`CLAUDE.md`): no real patient data.

## Source and licence

All four come from **IDRiD**, the *Indian Diabetic Retinopathy Image Dataset*
(Porwal P., Pachade S., Kamble R., Kokare M., Deshmukh G., Sahasrabuddhe V.,
Meriaudeau F. *Indian Diabetic Retinopathy Image Dataset (IDRiD): A Database for
Diabetic Retinopathy Screening Research.* Data 2018, 3(3), 25;
IEEE DataPort, doi:10.21227/H25W98), Disease Grading sub-challenge, Original
Images. IEEE DataPort lists the dataset under **CC BY 4.0**, which permits
redistribution of these images and adaptations of them with attribution. That is
the reason they may sit in git, and it is the attribution. **Check the licence
on the dataset page before copying these outside this repository**; the
challenge site (idrid.grand-challenge.org) has its own terms, and
`datasets/README.md` records that some fundus datasets restrict redistribution.

The images carry no patient identifiers. They are single research photographs,
not this project's patients.

## Files

| File | From | What was done | Local MATLAB gate (`cameraDeviceId=unknown`) |
|---|---|---|---|
| `idrid_163_good_borderline.jpg` | `IDRiD_163` (DR grade 0) | none: byte-for-byte the original, 4288×2848 | `borderline` (accepted) |
| `idrid_003_good_borderline.jpg` | `IDRiD_003` (DR grade 2) | none: byte-for-byte the original | `borderline` (accepted) |
| `idrid_010_good_pass_w1800.jpg` | `IDRiD_010` (DR grade 4) | downscaled to 1800 px wide, JPEG q95 | `pass` |
| `idrid_164_bad_blur_dark.jpg` | `IDRiD_164` (DR grade 0) | **degraded on purpose**: resized to 1500 px, Gaussian blur σ=12, brightness ×0.35, JPEG q90 | `retake` / `low_illumination` |

`build_fixtures.js` reproduces them (it needs the IDRiD download, which is not
in git). The grades are IDRiD's own labels and are given only so a reader knows
the images span the disease range; **the tests do not assert a DR grade**.

## Why these three "good" images

The gate's focus metric is resolution-dependent by design
(`quality-gate-matlab/assessFocus.m`) and was fitted on IDRiD at native size, so:

- the native IDRiD files are accepted, as `borderline` (composite score under
  0.7), and never reach `pass`;
- a 1024 px downscale of the same photograph is **wrongly rejected**
  (`retake` / `motion_artifact`, measured with `IDRiD_163`);
- a ~1800 px downscale lands as `pass`.

Two `borderline` files and one `pass` file give the tests both outcomes the gate
can accept, which matters because `borderline` captures are queued as
high-urgency and `pass` as low (`captureHandler.provisionalPriority`), and the
sync order is urgency first, then age.

Measured 2026-09-26 with the real gate (`matlab -batch`, R2026a). The values
depend on the gate's thresholds (`cameraPresets.json`) and will move if they do.

## Not committed

The large-image (chunked upload) tests build a >2 MB image at run time by
upscaling a fixture. It is not stored here.
