"""
Convert ViTPose 17-keypoint (AP-10K) COCO JSON to 22-keypoint (DANNCE) format.

The 15 direct mappings carry over position and visibility.
Ears are extrapolated 1.5x from nose through eyes.
SpineM, wrists, and ankles are interpolated as midpoints.
Tail(mid) and Tail(end) are set to v=0 for manual placement.
"""

import argparse
import copy
import json
import sys
from pathlib import Path


# AP-10K source index -> DANNCE target index (direct positional copy)
DIRECT_MAP: dict[int, int] = {
    2: 2,    # Nose -> Snout
    3: 3,    # Neck -> SpineF
    4: 5,    # Root of tail -> Tail(base)
    5: 11,   # L_Shoulder -> ShoulderL
    6: 10,   # L_Elbow -> ElbowL
    7: 8,    # L_F_Paw -> ForepawL
    8: 15,   # R_Shoulder -> ShoulderR
    9: 14,   # R_Elbow -> ElbowR
    10: 12,  # R_F_Paw -> ForepawR
    12: 18,  # L_Knee -> KneeL
    13: 16,  # L_B_Paw -> HindpawL
    15: 21,  # R_Knee -> KneeR
    16: 19,  # R_B_Paw -> HindpawR
}

# Index pairs (DANNCE) for midpoint interpolation: target = (a + b) / 2
MIDPOINT_PAIRS: list[tuple[int, int, int]] = [
    (4, 3, 5),     # SpineM = midpoint(SpineF, Tail(base))
    (9, 8, 10),    # WristL = midpoint(ForepawL, ElbowL)
    (13, 12, 14),  # WristR = midpoint(ForepawR, ElbowR)
    (17, 16, 18),  # AnkleL = midpoint(HindpawL, KneeL)
    (20, 19, 21),  # AnkleR = midpoint(HindpawR, KneeR)
]

# DANNCE indices left at v=0 for manual placement
ZERO_INIT: list[int] = [6, 7]  # Tail(mid), Tail(end)

# Ear extrapolation factor
EAR_FACTOR = 1.5


def load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_kp(ann: dict, idx: int) -> tuple[float, float, float]:
    """Return (x, y, v) for keypoint index *idx* from source annotation."""
    kps = ann["keypoints"]
    return (kps[idx * 3], kps[idx * 3 + 1], kps[idx * 3 + 2])


def set_kp(kps: list, idx: int, x: float, y: float, v: int):
    kps[idx * 3] = x
    kps[idx * 3 + 1] = y
    kps[idx * 3 + 2] = v


def extrapolate_ear(nose_xy: tuple, eye_xy: tuple, img_w: int, img_h: int):
    """Extrapolate ear position from nose through eye by EAR_FACTOR."""
    nx, ny = nose_xy
    ex, ey = eye_xy
    ear_x = nx + (ex - nx) * EAR_FACTOR
    ear_y = ny + (ey - ny) * EAR_FACTOR
    ear_x = max(0, min(img_w - 1, ear_x))
    ear_y = max(0, min(img_h - 1, ear_y))
    return ear_x, ear_y


def convert_annotation(
    src_ann: dict, img_w: int, img_h: int, num_dst: int = 22
) -> dict:
    """Convert a single 17-kp annotation to 22-kp DANNCE format."""
    dst = copy.deepcopy(src_ann)
    dst["num_keypoints"] = num_dst

    # Build 22-kp keypoints array (all zeros)
    new_kps = [0.0] * (num_dst * 3)

    # Step 1: direct mappings
    for src_idx, dst_idx in DIRECT_MAP.items():
        x, y, v = get_kp(src_ann, src_idx)
        set_kp(new_kps, dst_idx, x, y, v)

    # Step 2: ear extrapolation (AP-10K eyes -> DANNCE ears)
    nose_x, nose_y, nose_v = get_kp(src_ann, 2)  # Nose
    # EarL from L_Eye (0)
    lx, ly, lv = get_kp(src_ann, 0)
    if nose_v > 0 and lv > 0:
        ex, ey = extrapolate_ear((nose_x, nose_y), (lx, ly), img_w, img_h)
        set_kp(new_kps, 0, ex, ey, 1)  # EarL, v=1 (estimated)
    # EarR from R_Eye (1)
    rx, ry, rv = get_kp(src_ann, 1)
    if nose_v > 0 and rv > 0:
        ex, ey = extrapolate_ear((nose_x, nose_y), (rx, ry), img_w, img_h)
        set_kp(new_kps, 1, ex, ey, 1)  # EarR, v=1 (estimated)

    # Step 3: midpoint interpolations
    for target, ia, ib in MIDPOINT_PAIRS:
        ax = new_kps[ia * 3]
        ay = new_kps[ia * 3 + 1]
        av = new_kps[ia * 3 + 2]
        bx = new_kps[ib * 3]
        by = new_kps[ib * 3 + 1]
        bv = new_kps[ib * 3 + 2]
        if av > 0 and bv > 0:
            set_kp(new_kps, target, (ax + bx) / 2, (ay + by) / 2, 1)
        # else stays v=0

    # Step 4: zero-init points stay at 0,0,0 (Tail(mid), Tail(end))

    dst["keypoints"] = new_kps

    # Build keypoint_status array
    status = []
    dn_idx_to_status: dict[int, str] = {}

    # Direct-mapped points get "predicted"
    for src_idx, dst_idx in DIRECT_MAP.items():
        _, _, v = get_kp(src_ann, src_idx)
        dn_idx_to_status[dst_idx] = "predicted" if v > 0 else "interpolated"

    # Ears get "interpolated"
    dn_idx_to_status[0] = "interpolated"
    dn_idx_to_status[1] = "interpolated"

    # Midpoints get "interpolated"
    for target, _, _ in MIDPOINT_PAIRS:
        if new_kps[target * 3 + 2] > 0:
            dn_idx_to_status[target] = "interpolated"
        else:
            dn_idx_to_status[target] = "interpolated"  # v=0 but still needs review

    # Zero-init points
    for idx in ZERO_INIT:
        dn_idx_to_status[idx] = "interpolated"

    for i in range(num_dst):
        status.append(dn_idx_to_status.get(i, "predicted"))

    dst["keypoint_status"] = status

    # Build keypoint_scores for the 22-kp output
    src_scores = src_ann.get("keypoint_scores")
    if src_scores:
        new_scores = [0.0] * num_dst
        for src_idx, dst_idx in DIRECT_MAP.items():
            new_scores[dst_idx] = src_scores[src_idx]
        # Ears: inherit eye scores (best approximation)
        if len(src_scores) > 0:
            new_scores[0] = src_scores[0]
        if len(src_scores) > 1:
            new_scores[1] = src_scores[1]
        # Midpoint interpolations: average of parents
        for target, ia, ib in MIDPOINT_PAIRS:
            new_scores[target] = (new_scores[ia] + new_scores[ib]) / 2
        dst["keypoint_scores"] = new_scores

    # Remove unused fields from source format
    if "score" not in dst:
        dst["score"] = 1.0

    return dst


def main():
    parser = argparse.ArgumentParser(
        description="Convert 17-keypoint (AP-10K) COCO JSON to 22-keypoint (DANNCE) format"
    )
    parser.add_argument("--input", "-i", required=True, help="Input COCO JSON (17 kp)")
    parser.add_argument("--output", "-o", required=True, help="Output COCO JSON (22 kp)")
    parser.add_argument(
        "--ap10k-config",
        default=None,
        help="AP-10K config JSON (default: config/ap10k.json next to input)",
    )
    parser.add_argument(
        "--dannce-config",
        default=None,
        help="DANNCE config JSON (default: config/dannce.json next to input)",
    )
    args = parser.parse_args()

    print(f"Loading: {args.input}")
    data = load_json(args.input)

    images = data.get("images", [])
    annotations = data.get("annotations", [])
    print(f"  {len(images)} images, {len(annotations)} annotations")

    # Build image id -> (width, height) lookup
    img_sizes: dict[int, tuple[int, int]] = {}
    for img in images:
        img_sizes[img["id"]] = (img.get("width", 0), img.get("height", 0))

    # Update categories to DANNCE skeleton
    script_dir = Path(__file__).resolve().parent
    dannce_config_path = args.dannce_config or str(script_dir / "config" / "dannce.json")
    dannce_config = load_json(dannce_config_path)

    # Build categories with keypoint names and skeleton
    kp_names = []
    for i in range(len(dannce_config["keypoints"])):
        kp_names.append(dannce_config["keypoints"][str(i)]["name"])

    skeleton_indices = []
    for sk_entry in dannce_config.get("skeleton", {}).values():
        link = sk_entry["link"]
        ia = kp_names.index(link[0])
        ib = kp_names.index(link[1])
        skeleton_indices.append([ia, ib])

    data["categories"] = [
        {
            "id": 1,
            "name": "mouse",
            "supercategory": "animal",
            "keypoints": kp_names,
            "skeleton": skeleton_indices,
        }
    ]

    # Convert each annotation
    converted = []
    for ann in annotations:
        img_id = ann["image_id"]
        w, h = img_sizes.get(img_id, (0, 0))
        converted.append(convert_annotation(ann, w, h))

    data["annotations"] = converted

    print(f"Writing: {args.output}")
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    # Summary
    predicted = sum(1 for s in converted[0]["keypoint_status"] if s == "predicted") if converted else 0
    interpolated = sum(1 for s in converted[0]["keypoint_status"] if s == "interpolated") if converted else 0
    print(f"  {len(converted)} annotations converted")
    print(f"  Per annotation: {predicted} predicted, {interpolated} interpolated = {predicted + interpolated} total")


if __name__ == "__main__":
    main()
