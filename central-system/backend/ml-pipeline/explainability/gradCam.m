function [outputPath, camMap] = gradCam(net, preprocessedImg, predictedClassIdx, outputPath)
% GRADCAM  Compute Grad-CAM heatmap and write an overlaid PNG to disk.
%
%   outputPath = gradCam(net, preprocessedImg, predictedClassIdx, outputPath)
%
%   Inputs:
%     net               - dlnetwork or DAGNetwork — the Branch A classifier.
%     preprocessedImg   - 512×512×3 uint8, output of the preprocessing
%                         pipeline (benGrahamCrop → claheEnhance →
%                         illuminationNormalize).
%     predictedClassIdx - 1-based MATLAB class index (predictedGrade + 1),
%                         i.e. grade 0 → index 1, grade 4 → index 5.
%     outputPath        - char / string, full path to write the output PNG.
%                         Parent directory must exist.
%
%   Outputs:
%     outputPath - same as the input path (returned for caller convenience).
%     camMap     - the RAW Grad-CAM map, at the last conv layer's own
%                  resolution and normalised to [0,1], BEFORE the upsample and
%                  the colour map. Optional: callers that only want the PNG
%                  ask for one output and are unaffected.
%
%                  This is the same thing branchAInfer.py returns as
%                  `gradcamMap`, at the same stage and for the same reason:
%                  Task 7.1 (lesionAttentionConsistency) scores attention
%                  against a lesion mask and needs the MAP, and the overlay
%                  PNG cannot be turned back into one -- it has already been
%                  colour-mapped and alpha-blended with the fundus. Raw rather
%                  than upsampled because it then travels as a few hundred
%                  floats of JSON instead of a quarter of a million, and
%                  runCasePipeline.m resizes it to the mask anyway.
%
%   Implementation note — manual Grad-CAM (not built-in gradCAM()):
%     MATLAB's built-in gradCAM() rejects networks with residual / skip
%     connections ("Network must have a single input layer and a single
%     output layer"), which excludes ResNet-50 and any other skip-connection
%     architecture. This implementation uses dlfeval + dlgradient + forward
%     with explicit layer outputs, which has no such restriction.
%     The math is identical to the built-in's algorithm:
%       1. Forward pass → capture last-conv feature maps + class logits.
%       2. Backprop class score → feature maps via dlgradient.
%       3. Global-average-pool the gradients → per-channel importance α.
%       4. Weighted sum of feature map channels: L = ReLU(Σ αk * Ak).
%       5. Normalise to [0,1], resize, colorise, alpha-blend.
%
%   Overlay blending:
%     heatmapRGB = jet colormap applied to normalised heatmap.
%     overlay    = 0.60 × original_RGB + 0.40 × heatmapRGB.
%
%   ⚠️  STUB-MODEL LIMITATION:
%     Until branchA_v1.mat is replaced with real trained weights, this
%     function will produce visually meaningless heatmaps (random
%     activations from an untrained network). The plumbing (PNG output,
%     correct dimensions, correct blending) is verified at this stage.
%     RE-VERIFY once the real model is swapped in — expect:
%       - Grades 1–4: high-activation (red) regions over lesion locations.
%       - Grade 0: diffuse low-activation map, slight disc highlight.
%
%   Reference:
%     Selvaraju et al., "Grad-CAM: Visual Explanations from Deep Networks
%     via Gradient-based Localization", ICCV 2017.

% ── Step 1: find the target layer (last conv layer in the network) ────────────
lastConvName = findLastConvLayer(net);

% Output layer name for class scores (last layer of our stub = 'softmax_dr')
outputLayerName = net.Layers(end).Name;

% ── Step 2: prepare dlarray input ────────────────────────────────────────────
% CORRECTION (2026-09-18): the network's own input contract is ImageNet-
% normalized float, not raw 0-255 uint8 -- see classifyBranchA.m's matching
% correction for how this was found (logits landing at +38/-105 instead of
% single digits). preprocessedImg itself stays uint8 below (Step 4/6 need the
% original pixel values for resizing and the visual overlay); only the copy
% fed to the network is normalized.
IMAGENET_MEAN = reshape([0.485 0.456 0.406], 1, 1, 3);
IMAGENET_STD  = reshape([0.229 0.224 0.225], 1, 1, 3);
netInput = (single(preprocessedImg) ./ 255) - IMAGENET_MEAN;
netInput = netInput ./ IMAGENET_STD;

img4D = reshape(netInput, [size(netInput,1), size(netInput,2), size(netInput,3), 1]);
X = dlarray(single(img4D), 'SSCB');

% ── Step 2b: initialize dlnetwork if needed (same guard as classifyBranchA) ──
% addLayers/connectLayers de-initializes a dlnetwork. Any net loaded from a
% stub .mat (saved without initialize()) will be uninitialized. Calling
% forward() or dlfeval on an uninitialized net throws immediately.
if isa(net, 'dlnetwork') && ~net.Initialized
    net = initialize(net, X);
end

% ── Step 3: compute Grad-CAM inside dlfeval (enables dlgradient) ─────────────
heatmap = dlfeval(@gradCamCore, net, X, lastConvName, outputLayerName, ...
                  predictedClassIdx);
heatmap = double(heatmap);

% The raw map is the second output, captured BEFORE the upsample below.
camMap = heatmap;

% ── Step 4: resize heatmap to match input image ───────────────────────────────
[H, W, ~] = size(preprocessedImg);
heatmap = imresize(heatmap, [H, W]);

% ── Step 5: colorise with jet colormap ───────────────────────────────────────
heatmapRGB = ind2rgb(im2uint8(heatmap), jet(256));   % H×W×3 double in [0,1]

% ── Step 6: alpha-blend at 40% heatmap opacity ───────────────────────────────
origD   = double(preprocessedImg) / 255;             % H×W×3 double in [0,1]
overlay = 0.60 .* origD + 0.40 .* heatmapRGB;
overlay = uint8(max(0, min(255, overlay * 255)));

% ── Step 7: write PNG ─────────────────────────────────────────────────────────
imwrite(overlay, char(outputPath));

end

% ── Local functions ───────────────────────────────────────────────────────────

function heatmap = gradCamCore(net, X, featureLayerName, outputLayerName, classIdx)
% GRADCAMCORE  Core Grad-CAM computation — must run inside dlfeval.
%
%   dlfeval enables dlgradient tracking across the forward pass.
%   'Outputs' requests intermediate activations alongside the final output.

% Forward pass — capture both class output and target-layer feature maps
[classOut, featureMaps] = forward(net, X, ...
    'Outputs', {outputLayerName, featureLayerName});

% --- Class score (scalar, gradient-tracked) ----------------------------------
% classOut is a dlarray; shape after global avg pool + FC + softmax:
%   '11CB' or 'SSCB' format with spatial dims = 1 → squeeze to 1-D vector.
classVec   = stripdims(squeeze(classOut));   % 1-D dlarray, length = numClasses
classScore = classVec(classIdx);             % scalar dlarray (gradient-tracked)

% --- Gradient of class score w.r.t. feature maps ----------------------------
grads = dlgradient(classScore, featureMaps);  % same shape as featureMaps

% --- Global average pool gradients → per-channel importance weights ----------
grads_np = extractdata(grads);               % H×W×C×N (numeric)
grads_np = squeeze(grads_np);               % H×W×C  (N=1 dropped)
if ndims(grads_np) < 3                       % guard: single-channel edge case
    grads_np = reshape(grads_np, [size(grads_np,1), size(grads_np,2), 1]);
end
alpha = squeeze(mean(grads_np, [1,2]));      % C-element column vector

% --- Weighted combination of feature maps ------------------------------------
maps_np = extractdata(featureMaps);          % H×W×C×N (numeric)
maps_np = squeeze(maps_np);                 % H×W×C
if ndims(maps_np) < 3
    maps_np = reshape(maps_np, [size(maps_np,1), size(maps_np,2), 1]);
end

% Vectorised: broadcast α over spatial dims and sum over channels
weighted = sum(maps_np .* reshape(double(alpha), [1, 1, numel(alpha)]), 3);
weighted = squeeze(weighted);               % H×W

% --- ReLU + normalise to [0,1] -----------------------------------------------
heatmap = max(weighted, 0);
maxVal  = max(heatmap(:));
if maxVal > 0
    heatmap = heatmap / maxVal;
end

end

function layerName = findLastConvLayer(net)
% FINDLASTCONVLAYER  Return the name of the last Convolution2DLayer.
%
%   Grad-CAM needs the last convolutional feature map before the FC head.
%   In ResNet-50, this is the final conv in the last residual block
%   (before global average pooling).  Searching from the end guarantees
%   we get that layer regardless of the exact name across MATLAB versions.

layerName = '';
for i = numel(net.Layers):-1:1
    if isa(net.Layers(i), 'nnet.cnn.layer.Convolution2DLayer')
        layerName = net.Layers(i).Name;
        return;
    end
end
error('gradCam: No Convolution2DLayer found in network. ' + ...
      'Check that the network is a CNN (not MLP).');
end
