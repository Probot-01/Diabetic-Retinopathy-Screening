"""
mcDropout.py
============
Task 6.1 -- epistemic uncertainty for Branch A by Monte-Carlo dropout.

    from mcDropout import mc_dropout
    result = mc_dropout(model, x, n_passes=20, temperature=T)

Fills grading_results.uncertainty_score, the last always-NULL Branch A column.
The ophthalmologist queue already ranks Tier C by it descending, falling back to
(1 - confidence) while it is NULL -- so this changes review ORDER, and a wrong
value here quietly reorders the queue rather than failing.

── THE FAILURE THIS IS WRITTEN AROUND ──────────────────────────────────────
Run MC-dropout on a network with no dropout active and every pass is identical,
so the variance is exactly 0. Zero variance is the value meaning MAXIMUM
CERTAINTY. The pipeline would store 0.0, tiering would read an unusually
confident case, and a case that was never actually sampled would be pushed
towards the front of the auto-clear end of the queue.

Nothing about that is visible downstream: no error, no warning, a perfectly
plausible number. So the dropout check RAISES rather than warns. An uncertainty
of 0 that means "not measured" is exactly the mistake this project refuses
everywhere else -- an unmeasured quantity is NaN or NULL, never 0.

── WHY NOT model.train() ───────────────────────────────────────────────────
The obvious way to re-enable dropout is model.train(). On this model that is
actively harmful: it has ONE Dropout module and FORTY-NINE BatchNorm layers.
train() switches every one of those to batch statistics, and inference runs at
batch size 1, so each BatchNorm would normalise using the mean and variance of
a single image instead of its learned running statistics. The output is not
merely noisier, it is a different function -- and it would still return five
plausible-looking probabilities.

So only nn.Dropout* modules are switched, BatchNorm is asserted to still be in
eval afterwards, and the model is restored to its exact prior mode on the way
out even if a pass raises.

── WHY THIS IS FAST DESPITE 20 PASSES ──────────────────────────────────────
M1 is head(dropout(backbone(x))): the single dropout sits AFTER the whole
convolutional trunk. The trunk is deterministic in eval mode, so its output is
identical on every pass and 20 full forwards would recompute the expensive part
19 times for nothing.

The trunk therefore runs once and only dropout+head are resampled. That is not
an approximation -- it is the same arithmetic -- but it is only valid for this
topology, so it is guarded by an explicit structure check and falls back to full
forward passes for any other model.

── WHAT THE NUMBER MEANS, AND WHAT IT DOES NOT ─────────────────────────────
MC-dropout approximates EPISTEMIC uncertainty: the model's uncertainty about its
own parameters, the kind more training data reduces. It does not capture
aleatoric uncertainty -- a genuinely ambiguous photograph -- and its quality
depends on where the dropout layers sit.

Here that limitation is sharp and must not be glossed. There is exactly ONE
dropout layer and it is on the classifier head, so this samples the HEAD's
uncertainty over a fixed feature vector. It cannot see uncertainty in the
learned representation itself. A genuinely out-of-distribution image whose
features land confidently in the wrong place will produce a LOW score.

So a low score is not evidence the grade is right. It means the model is
internally consistent about it, which a confidently wrong model also is. It is
one input to tiering, never a verdict. The conformal prediction set (Task 6.2)
is what carries an actual coverage guarantee; this only orders the queue.
"""

import numpy as np
import torch
import torch.nn as nn

DROPOUT_TYPES = (nn.Dropout, nn.Dropout1d, nn.Dropout2d, nn.Dropout3d,
                 nn.AlphaDropout, nn.FeatureAlphaDropout)


class NoDropout(RuntimeError):
    """No active dropout: sampling would report certainty it never measured."""


def dropout_modules(model):
    """Active dropout modules. p == 0 does not count -- it is a no-op layer and
    would produce identical passes, which is the zero-variance trap."""
    return [(name, m) for name, m in model.named_modules()
            if isinstance(m, DROPOUT_TYPES) and getattr(m, "p", 0) > 0]


def _softmax(z, axis=-1):
    z = z - z.max(axis=axis, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=axis, keepdims=True)


def _entropy(p, axis=-1):
    # 0 * log 0 is 0 by convention, but numpy makes it nan. Clipping keeps a
    # confident row from producing a nan that then poisons the whole score.
    return -(p * np.log(np.clip(p, 1e-12, None))).sum(axis=axis)


def mc_dropout(model, x, n_passes=20, temperature=1.0, seed=12345,
               require_dropout=True):
    """Returns a dict of uncertainty measures over n_passes stochastic passes.

    seed is fixed by default so the same image yields the same uncertainty.
    A clinical result that changes between two runs of the same photograph
    cannot be audited, and a reviewer who reloads a case and sees a different
    number has no way to tell which one the routing decision used.
    """
    if n_passes < 2:
        raise ValueError("n_passes must be at least 2; "
                         "variance over a single pass is meaningless")

    active = dropout_modules(model)
    if not active:
        if require_dropout:
            raise NoDropout(
                "no active dropout modules: every pass would be identical and "
                "the variance would be exactly 0, which downstream reads as "
                "maximum certainty. Refusing to report an unmeasured 0.")
        return None

    was_training = model.training
    bn_before = [m.training for m in model.modules()
                 if isinstance(m, nn.modules.batchnorm._BatchNorm)]

    gen = torch.Generator().manual_seed(seed)
    prior = torch.random.get_rng_state()
    torch.random.manual_seed(int(torch.randint(0, 2**31 - 1, (1,), generator=gen)))

    try:
        model.eval()                      # everything deterministic ...
        for _name, m in active:
            m.train()                     # ... except dropout

        # BatchNorm must NOT have been switched. Asserted rather than assumed:
        # this is the difference between sampling a model and evaluating a
        # different one, and it is invisible in the output.
        bn_after = [m.training for m in model.modules()
                    if isinstance(m, nn.modules.batchnorm._BatchNorm)]
        if any(bn_after):
            raise RuntimeError("BatchNorm is in training mode during MC-dropout; "
                               "at batch size 1 it would normalise by a single "
                               "image's own statistics")

        logits = _sample(model, x, n_passes, active)
    finally:
        torch.random.set_rng_state(prior)
        model.train(was_training)
        for m, state in zip((m for m in model.modules()
                             if isinstance(m, nn.modules.batchnorm._BatchNorm)),
                            bn_before):
            m.train(state)

    probs = _softmax(logits / float(temperature), axis=1)   # passes x classes
    mean = probs.mean(axis=0)
    var = probs.var(axis=0)

    # Total = aleatoric + epistemic, the standard decomposition.
    #   predictive entropy H[mean p]           total uncertainty
    #   expected entropy  E[H[p]]              aleatoric part
    #   mutual information = the difference    epistemic part
    # Reported separately because they mean different things operationally: MI
    # is what more data would reduce; the aleatoric part is what a better
    # photograph would reduce.
    predictive_entropy = float(_entropy(mean))
    expected_entropy = float(_entropy(probs, axis=1).mean())
    mutual_information = max(0.0, predictive_entropy - expected_entropy)

    n_classes = probs.shape[1]
    max_entropy = float(np.log(n_classes))

    # The single scalar written to uncertainty_score. Normalised predictive
    # entropy, so it is comparable across cases and bounded [0,1] -- the column
    # is a ranking key, and a raw nat-valued entropy would rank identically but
    # be meaningless to read on a case detail page.
    score = float(np.clip(predictive_entropy / max_entropy, 0.0, 1.0))

    return {
        "uncertaintyScore": score,
        "predictiveEntropy": predictive_entropy,
        "expectedEntropy": expected_entropy,
        "mutualInformation": mutual_information,
        "normalisedMutualInformation": float(mutual_information / max_entropy),
        "meanProbabilities": [float(v) for v in mean],
        "perClassVariance": [float(v) for v in var],
        "totalVariance": float(var.sum()),
        "meanGrade": int(mean.argmax()),
        "passes": int(n_passes),
        "seed": int(seed),
        "dropoutLayers": [name for name, _ in active],
        "dropoutP": [float(m.p) for _, m in active],
        # Stated in the payload because the scope of the measurement is not
        # recoverable from the number, and it changes how the number should be
        # read on a case page.
        "scope": ("head only -- the single dropout layer sits after the "
                  "convolutional trunk, so this samples classifier uncertainty "
                  "over fixed features and cannot see representation "
                  "uncertainty. A confident out-of-distribution image scores "
                  "LOW."),
    }


def _has_split_head(model, active):
    """True when the model is head(dropout(backbone(x))) with that one dropout."""
    return (len(active) == 1
            and all(hasattr(model, a) for a in ("backbone", "dropout", "head"))
            and active[0][1] is model.dropout)


def _sample(model, x, n_passes, active):
    """n_passes x n_classes logits."""
    with torch.no_grad():
        if _has_split_head(model, active):
            # Trunk once; only the stochastic tail repeats. Identical
            # arithmetic to a full forward -- see the module docstring.
            feats = model.backbone(x)
            return np.stack([model.head(model.dropout(feats))[0].numpy()
                             for _ in range(n_passes)])
        return np.stack([model(x)[0].numpy() for _ in range(n_passes)])
