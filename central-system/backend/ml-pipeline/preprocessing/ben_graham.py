"""
ben_graham.py
=============
Ben Graham-style fundus image preprocessing for diabetic retinopathy models.

Reference: Ben Graham's Kaggle DR competition winning preprocessing approach.
Adapted for the SIH 2026 DR Screening pipeline (central-system grading pipeline).

Usage:
    from preprocessing.ben_graham import ben_graham_preprocess
    processed = ben_graham_preprocess(image, target_size=384)
"""

import cv2
import numpy as np


def ben_graham_preprocess(image: np.ndarray, target_size: int = 384) -> np.ndarray:
    """
    Apply Ben Graham-style preprocessing to a fundus photograph.

    Steps:
      1. Detect the circular retinal boundary using the green channel.
      2. Crop tightly to the bounding circle (removes black borders).
      3. Resize to target_size x target_size.
      4. Subtract a heavily-blurred Gaussian copy to boost local contrast
         (kernel size = largest odd integer <= target_size / 30).
         Formula:  out = clip(image * 4 - blurred * 4 + 128, 0, 255)

    Parameters
    ----------
    image : np.ndarray
        Input BGR fundus image, shape (H, W, 3), dtype uint8.
    target_size : int
        Output square side length in pixels. Default 384.

    Returns
    -------
    np.ndarray
        Preprocessed image, shape (target_size, target_size, 3), dtype uint8.
        Pixel values are in [0, 255].
    """
    if image is None or image.size == 0:
        raise ValueError("ben_graham_preprocess received an empty or None image.")
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError(
            f"Expected a 3-channel BGR image, got shape {image.shape}."
        )

    # ------------------------------------------------------------------ #
    # Step 1: Detect the retinal circle and crop to it                    #
    # ------------------------------------------------------------------ #
    x, y, w, h = retinal_crop_box(image)
    cropped = image[y : y + h, x : x + w]

    # Guard against degenerate crops.
    if cropped.size == 0:
        cropped = image

    # ------------------------------------------------------------------ #
    # Step 2: Resize to target_size x target_size                         #
    # ------------------------------------------------------------------ #
    resized = cv2.resize(cropped, (target_size, target_size), interpolation=cv2.INTER_AREA)

    # ------------------------------------------------------------------ #
    # Step 3: Local contrast enhancement via Gaussian subtraction         #
    # ------------------------------------------------------------------ #
    # Kernel size proportional to target_size / 30, must be odd and >= 1.
    sigma = target_size / 30.0
    ksize = int(sigma) * 2 + 1  # Always odd
    ksize = max(ksize, 1)

    blurred = cv2.GaussianBlur(resized, (ksize, ksize), sigma)

    # Ben Graham formula: addWeighted handles the clip to [0,255].
    # out = clip(4 * resized - 4 * blurred + 128, 0, 255)
    enhanced = cv2.addWeighted(resized, 4, blurred, -4, 128)

    return enhanced


def retinal_crop_box(image: np.ndarray):
    """The bounding box of the retinal circle, as (x, y, w, h).

    This is step 1 of ben_graham_preprocess, factored out because several
    callers need the GEOMETRY of the crop, not the cropped pixels:

      - The Grad-CAM overlay redoes crop+resize without the contrast step, so
        the heatmap aligns to a recognisable retina rather than a
        contrast-stretched one.
      - The lesion models (M4, M5) run in this cropped space, while the
        localization model (M3) runs on a plain squished resize of the ORIGINAL
        image. Mapping the optic disc from one space into the other requires
        this box. Without it, M4's optic-disc masking -- which the model does
        not apply itself, the caller must -- would blank out the wrong region.

    It is factored out rather than reimplemented because it had already been
    copied once, and a second definition of "inside the retina" drifting from
    this one would move lesion coordinates silently: the masks would still look
    plausible and would be assigned to the wrong quadrants, which is exactly
    the input the ICDR rule engine grades on.

    Returns the full image's box when no contour is found.
    """
    # Work on the green channel — highest contrast for fundus images.
    gray = image[:, :, 1]

    # Threshold: any pixel brighter than 7 is considered "inside the retina".
    _, mask = cv2.threshold(gray, 7, 255, cv2.THRESH_BINARY)

    # Morphological closing to fill gaps, then find the bounding box.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    if not contours:
        # Fallback: the full image if no contour found.
        return 0, 0, image.shape[1], image.shape[0]

    # Use the largest contour — the retinal disc boundary.
    largest = max(contours, key=cv2.contourArea)
    x, y, w, h = cv2.boundingRect(largest)
    # Ensure we stay within image bounds.
    x = max(0, x)
    y = max(0, y)
    w = min(w, image.shape[1] - x)
    h = min(h, image.shape[0] - y)
    return x, y, w, h
