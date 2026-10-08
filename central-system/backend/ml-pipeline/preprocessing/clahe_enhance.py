"""
clahe_enhance.py
================
CLAHE (Contrast Limited Adaptive Histogram Equalization) enhancement
for fundus photographs, applied to the L channel in LAB color space.

Reused across vessel segmentation, lesion segmentation, and grading
training scripts in the SIH 2026 DR Screening pipeline.

Usage:
    from preprocessing.clahe_enhance import clahe_enhance
    enhanced = clahe_enhance(image, clip_limit=2.0)
"""

import cv2
import numpy as np


def clahe_enhance(image: np.ndarray, clip_limit: float = 2.0, tile_grid_size: tuple = (8, 8)) -> np.ndarray:
    """
    Apply CLAHE to the L (luminance) channel of a fundus image in LAB space.

    Converts BGR → LAB, applies CLAHE on L only (preserves colour fidelity),
    then converts back to BGR. This avoids the colour distortion caused by
    applying histogram equalization directly to RGB/BGR channels independently.

    Parameters
    ----------
    image : np.ndarray
        Input BGR fundus image, shape (H, W, 3), dtype uint8.
    clip_limit : float
        Threshold for contrast limiting. Higher values give more aggressive
        enhancement but increase noise amplification. Default 2.0.
    tile_grid_size : tuple of (int, int)
        Size of the grid for histogram equalization. Default (8, 8).

    Returns
    -------
    np.ndarray
        CLAHE-enhanced image, shape (H, W, 3), dtype uint8.
        Same spatial dimensions as the input.
    """
    if image is None or image.size == 0:
        raise ValueError("clahe_enhance received an empty or None image.")
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError(
            f"Expected a 3-channel BGR image, got shape {image.shape}."
        )

    # Convert BGR → LAB
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)

    # Split into L, A, B channels
    l_channel, a_channel, b_channel = cv2.split(lab)

    # Apply CLAHE to L channel only
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=tile_grid_size)
    l_enhanced = clahe.apply(l_channel)

    # Merge back and convert to BGR
    lab_enhanced = cv2.merge([l_enhanced, a_channel, b_channel])
    enhanced = cv2.cvtColor(lab_enhanced, cv2.COLOR_LAB2BGR)

    return enhanced
