"""
Generate an empty COCO-format keypoint dataset from an image directory.
All keypoints are initialized to v=0 (unlabeled) for pure manual annotation.
"""

import argparse
import json
import sys
from pathlib import Path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".webp"}


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_categories(config: dict) -> list[dict]:
    kp_names = []
    kp_dict = config.get("keypoints", {})
    for i in range(len(kp_dict)):
        kp_names.append(kp_dict[str(i)]["name"])

    skeleton = []
    for entry in config.get("skeleton", {}).values():
        link = entry["link"]
        skeleton.append([kp_names.index(link[0]), kp_names.index(link[1])])

    return [
        {
            "id": 1,
            "name": "mouse",
            "supercategory": "animal",
            "keypoints": kp_names,
            "skeleton": skeleton,
        }
    ]


def main():
    parser = argparse.ArgumentParser(
        description="Generate empty COCO keypoint dataset from image directory"
    )
    parser.add_argument("--images-dir", "-i", required=True, help="Directory containing images")
    parser.add_argument("--output", "-o", required=True, help="Output COCO JSON path")
    parser.add_argument("--config", required=True, help="Keypoint config (e.g. config/dannce.json)")
    parser.add_argument("--instances-per-image", type=int, default=1,
                        help="Number of empty annotation instances per image (default: 1)")
    parser.add_argument("--pattern", default="*", help="Glob pattern under images-dir (default: *)")
    parser.add_argument("--recurse", action="store_true", help="Recurse into subdirectories")
    args = parser.parse_args()

    images_dir = Path(args.images_dir)
    if not images_dir.exists():
        print(f"Error: images directory not found: {images_dir}")
        sys.exit(1)

    config = load_config(args.config)
    num_kp = len(config.get("keypoints", {}))
    print(f"Config: {args.config} ({num_kp} keypoints)")

    # Collect images
    if args.recurse:
        candidates = []
        for root, _, files in images_dir.walk():
            for f in files:
                if Path(f).suffix.lower() in IMAGE_EXTS:
                    candidates.append(Path(root) / f)
    else:
        candidates = [p for p in images_dir.glob(args.pattern) if p.suffix.lower() in IMAGE_EXTS]

    if not candidates:
        print(f"Error: no image files found in {images_dir}")
        sys.exit(1)

    images = []
    img_id = 1

    for img_path in sorted(candidates):
        # Try to read dimensions
        try:
            from PIL import Image
            with Image.open(img_path) as im:
                w, h = im.size
        except ImportError:
            print("Warning: PIL not available, setting width/height to 0")
            w, h = 0, 0
        except Exception as e:
            print(f"Warning: could not read {img_path}: {e}")
            w, h = 0, 0

        rel_path = img_path.relative_to(images_dir)
        # Build a clean relative path for file_name
        file_name = str(rel_path).replace("\\", "/")

        images.append({
            "id": img_id,
            "file_name": file_name,
            "width": w,
            "height": h,
        })
        img_id += 1

    print(f"Found {len(images)} images")

    # Create empty annotations
    annotations = []
    ann_id = 1
    for img in images:
        for _ in range(args.instances_per_image):
            annotations.append({
                "id": ann_id,
                "image_id": img["id"],
                "category_id": 1,
                "keypoints": [0.0] * (num_kp * 3),
                "num_keypoints": num_kp,
                "score": 1.0,
                "keypoint_status": ["interpolated"] * num_kp,
            })
            ann_id += 1

    print(f"Created {len(annotations)} empty annotations "
          f"({args.instances_per_image} per image)")

    output = {
        "images": images,
        "annotations": annotations,
        "categories": build_categories(config),
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"Written to {args.output}")


if __name__ == "__main__":
    main()
