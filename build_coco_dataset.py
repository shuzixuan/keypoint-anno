#!/usr/bin/env python
"""
Build a COCO-format keypoint dataset from SAM3 segmentation results.

Each instance folder (masks/obj_X/) has its own mask_quality.json.
Only instances with label == 'golden' are kept. If SAM3 detected 3+
objects, those extra obj dirs have no quality JSON and are ignored.

Pipeline:
    SAM3 results  →  this script  →  ViTPose  →  annotation_tool

Output:
    output_dir/
      annotations.json      # COCO keypoint format
      images/
        video_{id}/
          clip_{id}/
            frame.png
"""

import argparse
import json
import os
import shutil
from pathlib import Path
from collections import defaultdict

import numpy as np
from PIL import Image
from pycocotools import mask as maskUtils

# ── Lighting conditions ──────────────────────────────────────────
VIDEOS = {
    "working": [
        "0", "1", "2", "3", "4", "5", "6", "7", "8",
        "27", "28", "30", "31", "32", "34",
    ],
    "infrared_pink": [
        "9", "10", "11", "12", "13", "14", "15", "16", "17", "18",
        "29", "33", "35",
    ],
    "infrared_blue": [
        "19", "20", "21", "22", "23", "24", "25", "26", "supp_blue",
    ],
}
VIDEO_TO_LIGHTING = {}
for _light, _ids in VIDEOS.items():
    for _vid in _ids:
        VIDEO_TO_LIGHTING[_vid] = _light


def get_lighting(video_id: str) -> str:
    return VIDEO_TO_LIGHTING.get(video_id, "unknown")


# ── Mask processing ────────────────────────────────────────────
def mask_to_coco_rle(binary_mask: np.ndarray):
    """Convert a 2D binary mask to COCO RLE dict with decoded counts."""
    if binary_mask.sum() == 0:
        return None
    rle = maskUtils.encode(np.asfortranarray(binary_mask.astype(np.uint8)))
    # Decode bytes to string for JSON
    if isinstance(rle["counts"], bytes):
        rle["counts"] = rle["counts"].decode("utf-8")
    return rle


def mask_to_bbox(binary_mask: np.ndarray):
    """Compute COCO bbox [x, y, w, h] from binary mask."""
    ys, xs = np.where(binary_mask)
    if len(xs) == 0:
        return [0, 0, 0, 0]
    x, y = int(xs.min()), int(ys.min())
    w, h = int(xs.max() - x + 1), int(ys.max() - y + 1)
    return [x, y, w, h]


# ── Build skeleton edges from keypoint config ──────────────────
def build_coco_skeleton(config: dict):
    """Convert name-based skeleton to COCO index-based skeleton."""
    # Build name -> index map
    name_to_idx = {}
    for kp_id_str, info in config["keypoints"].items():
        name_to_idx[info["name"]] = int(kp_id_str)

    edges = []
    for sk_id_str, sk_info in config.get("skeleton", {}).items():
        link = sk_info["link"]
        if len(link) == 2:
            a, b = name_to_idx.get(link[0]), name_to_idx.get(link[1])
            if a is not None and b is not None:
                edges.append([a, b])
    return edges


def build_coco_categories(config: dict):
    """Build COCO categories list from keypoint config."""
    kp_names = []
    kp_ids = sorted(int(k) for k in config["keypoints"].keys())
    for kp_id in kp_ids:
        kp_names.append(config["keypoints"][str(kp_id)]["name"])

    skeleton = build_coco_skeleton(config)

    return [{
        "id": 1,
        "name": "mouse",
        "supercategory": "animal",
        "keypoints": kp_names,
        "skeleton": skeleton,
    }]


# ── Main processing ────────────────────────────────────────────
def process_sam3_root(input_root: Path):
    """
    Walk the SAM3 result tree and yield per-clip annotation data.

    Yields: (video_id, clip_id, lighting, clip_annotations, frame_count)
    where clip_annotations is a list of dicts with:
        obj_idx, frame_name, segmentation, bbox, area
    """
    for video_dir in sorted(input_root.iterdir()):
        if not video_dir.is_dir():
            continue
        video_id = video_dir.name
        lighting = get_lighting(video_id)

        for clip_dir in sorted(video_dir.iterdir()):
            if not clip_dir.is_dir():
                continue
            clip_id = clip_dir.name

            masks_dir = clip_dir / "masks"
            if not masks_dir.exists():
                print(f"  SKIP video_{video_id}/{clip_id}: no masks/ directory")
                continue

            # ── Find golden object directories ──────────
            # Each obj_X/ folder may have its own mask_quality.json
            all_obj_dirs = sorted(
                [d for d in masks_dir.iterdir()
                 if d.is_dir() and d.name.startswith("obj_")]
            )

            golden_obj_dirs = []
            skipped_objs = 0
            for obj_dir in all_obj_dirs:
                obj_name = obj_dir.name
                try:
                    obj_idx = int(obj_name.split("_")[1])
                except (IndexError, ValueError):
                    continue

                quality_json = obj_dir / "mask_quality.json"
                if not quality_json.exists():
                    skipped_objs += 1
                    continue
                with open(quality_json, "r") as f:
                    quality = json.load(f)
                if quality.get("label") != "golden":
                    print(f"  SKIP video_{video_id}/{clip_id}/{obj_name}: "
                          f"label={quality.get('label')}")
                    continue
                golden_obj_dirs.append((obj_idx, obj_dir))

            if not golden_obj_dirs:
                if skipped_objs == 0:
                    # All objects exist but none golden
                    pass
                print(f"  SKIP video_{video_id}/{clip_id}: "
                      f"0 golden instances out of {len(all_obj_dirs)}")
                continue

            # ── Warn if extra (non-golden) objects ──────
            if len(all_obj_dirs) > len(golden_obj_dirs) + skipped_objs:
                print(f"  NOTE video_{video_id}/{clip_id}: "
                      f"{len(all_obj_dirs)} total objects, "
                      f"{len(golden_obj_dirs)} golden kept")

            # ── Frame list ──────────────────────────────
            frames_dir = clip_dir / "frames"
            if not frames_dir.exists():
                print(f"  SKIP video_{video_id}/{clip_id}: no frames/ directory")
                continue
            frame_paths = sorted(frames_dir.glob("*.png"))
            if not frame_paths:
                print(f"  SKIP video_{video_id}/{clip_id}: no .png frames")
                continue

            # ── Process each frame ──────────────────────
            clip_annotations = []
            kept_frames = 0
            for frame_path in frame_paths:
                frame_name = frame_path.name
                frame_entries = []

                for obj_idx, obj_dir in golden_obj_dirs:
                    mask_path = obj_dir / frame_name
                    if not mask_path.exists():
                        break

                    mask = np.array(Image.open(mask_path))
                    binary = (mask > 0).astype(np.uint8)

                    seg = mask_to_coco_rle(binary)
                    if seg is None:
                        break

                    bbox = mask_to_bbox(binary)
                    area = int(binary.sum())

                    frame_entries.append({
                        "obj_idx": obj_idx,
                        "frame_name": frame_name,
                        "segmentation": seg,
                        "bbox": bbox,
                        "area": area,
                    })

                if len(frame_entries) == len(golden_obj_dirs):
                    clip_annotations.extend(frame_entries)
                    kept_frames += 1

            yield video_id, clip_id, lighting, clip_annotations, kept_frames


# ── Entry point ────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Build COCO keypoint dataset from SAM3 segmentation results"
    )
    parser.add_argument(
        "--input-root", required=True,
        help="Root directory of SAM3 results (e.g. sam3_res_10frames/)",
    )
    parser.add_argument(
        "--output-dir", required=True,
        help="Output directory for images/ and annotations.json",
    )
    parser.add_argument(
        "--config", required=True,
        help="Keypoint configuration JSON (defines keypoint names and skeleton)",
    )
    args = parser.parse_args()

    input_root = Path(args.input_root)
    if not input_root.exists():
        print(f"Error: input root not found: {input_root}")
        return

    output_dir = Path(args.output_dir)
    images_out_dir = output_dir / "images"
    images_out_dir.mkdir(parents=True, exist_ok=True)

    # Load keypoint config
    with open(args.config, "r") as f:
        kp_config = json.load(f)
    num_keypoints = len(kp_config["keypoints"])

    coco_images = []
    coco_annotations = []
    image_id_counter = 1
    annotation_id_counter = 1
    total_frames = 0
    total_clips = 0

    print(f"Scanning: {input_root}")
    print()

    for video_id, clip_id, lighting, clip_anns, n_frames in process_sam3_root(input_root):
        print(f"  video_{video_id}/{clip_id}: {n_frames} frames, {len(clip_anns)} annotations "
              f"({len(clip_anns) // n_frames} obj/frame), lighting={lighting}")

        if n_frames == 0:
            continue

        total_clips += 1
        total_frames += n_frames

        # ── Collect frame names in order ────────────────
        frame_names = sorted(set(a["frame_name"] for a in clip_anns))

        # ── Copy images and create COCO image entries ──
        clip_images_dir = images_out_dir / f"video_{video_id}" / f"clip_{clip_id}"
        clip_images_dir.mkdir(parents=True, exist_ok=True)

        src_frames_dir = input_root / video_id / clip_id / "frames"

        for fname in frame_names:
            src = src_frames_dir / fname
            dst = clip_images_dir / fname

            # Get image dimensions before copying
            with Image.open(src) as pil_img:
                w, h = pil_img.size

            # Copy if not already done
            if not dst.exists():
                shutil.copy2(src, dst)

            img_id = image_id_counter
            image_id_counter += 1

            coco_images.append({
                "id": img_id,
                "file_name": str(Path(f"video_{video_id}") / f"clip_{clip_id}" / fname),
                "width": w,
                "height": h,
                "video_id": video_id,
                "clip_id": clip_id,
                "lighting": lighting,
            })

            # ── Create annotation entries for this frame ──
            frame_anns = [a for a in clip_anns if a["frame_name"] == fname]
            for ann_data in frame_anns:
                ann_id = annotation_id_counter
                annotation_id_counter += 1

                coco_annotations.append({
                    "id": ann_id,
                    "image_id": img_id,
                    "category_id": 1,
                    "track_id": ann_data["obj_idx"],
                    "segmentation": ann_data["segmentation"],
                    "bbox": ann_data["bbox"],
                    "area": ann_data["area"],
                    "iscrowd": 0,
                    "keypoints": [0.0] * (num_keypoints * 3),
                    "num_keypoints": num_keypoints,
                })

    # ── Write annotations.json ────────────────────────
    coco_categories = build_coco_categories(kp_config)

    output_json = {
        "images": coco_images,
        "annotations": coco_annotations,
        "categories": coco_categories,
    }

    json_path = output_dir / "annotations.json"
    with open(json_path, "w") as f:
        json.dump(output_json, f, indent=2, ensure_ascii=False)

    print()
    print(f"Done: {total_clips} clips, {total_frames} frames, "
          f"{len(coco_images)} images, {len(coco_annotations)} annotations")
    print(f"Output: {json_path}")
    print(f"Images: {images_out_dir}")


if __name__ == "__main__":
    main()
