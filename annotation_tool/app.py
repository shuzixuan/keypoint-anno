import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi import Request


app = FastAPI(title="Keypoint Annotation Tool")

BASE_DIR = Path(__file__).resolve().parent
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# Global state — populated on startup
images_dir: Path = None
output_path: Path = None
coco_data: dict = {}
keypoint_config: dict = {}
annotations_by_image: dict = {}  # image_id -> list of annotation dicts
images_by_id: dict = {}
image_list: list = []
name_to_kp_idx: dict = {}  # keypoint name -> index in flattened array
reviewed_images: set = set()  # set of image ids marked as reviewed


def load_config(config_path: str) -> dict:
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_coco(predictions_path: str) -> dict:
    with open(predictions_path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_index():
    global annotations_by_image, images_by_id, image_list, name_to_kp_idx, reviewed_images

    # Build image lookup
    for img in coco_data.get("images", []):
        images_by_id[img["id"]] = img
        if img.get("reviewed"):
            reviewed_images.add(img["id"])

    # Resolve image file paths and filter to existing files
    valid_images = []
    for img in coco_data.get("images", []):
        file_name = img.get("file_name", "")
        img_path = images_dir / file_name
        if not img_path.exists():
            # Try just the basename
            img_path = images_dir / Path(file_name).name
        if img_path.exists():
            img["_resolved_path"] = str(img_path)
            valid_images.append(img)
        else:
            print(f"Warning: image file not found: {file_name}")

    image_list = valid_images

    # Build annotation index
    annotations_by_image = {}
    for ann in coco_data.get("annotations", []):
        img_id = ann["image_id"]
        if img_id not in annotations_by_image:
            annotations_by_image[img_id] = []
        annotations_by_image[img_id].append(ann)

    # Build keypoint name -> index mapping from config
    name_to_kp_idx = {}
    for kp_id_str, kp_info in keypoint_config.get("keypoints", {}).items():
        name_to_kp_idx[kp_info["name"]] = int(kp_id_str)


def resolve_image_path(file_name: str) -> Path:
    img_path = images_dir / file_name
    if not img_path.exists():
        img_path = images_dir / Path(file_name).name
    return img_path


# ── API Endpoints ──────────────────────────────────────────────


@app.get("/")
def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/api/config")
def get_config():
    return {
        "keypoints": keypoint_config.get("keypoints", {}),
        "skeleton": keypoint_config.get("skeleton", {}),
        "num_keypoints": len(keypoint_config.get("keypoints", {})),
    }


@app.get("/api/images")
def get_images():
    result = []
    for i, img in enumerate(image_list):
        result.append({
            "index": i,
            "id": img["id"],
            "file_name": img.get("file_name", ""),
            "width": img.get("width", 0),
            "height": img.get("height", 0),
            "annotation_count": len(annotations_by_image.get(img["id"], [])),
            "reviewed": img["id"] in reviewed_images,
        })
    return result


@app.post("/api/images/{image_id}/review")
def toggle_review(image_id: int):
    if image_id not in images_by_id:
        raise HTTPException(status_code=404, detail="Image not found")
    if image_id in reviewed_images:
        reviewed_images.discard(image_id)
        status = False
    else:
        reviewed_images.add(image_id)
        status = True
    return {"status": "ok", "reviewed": status, "image_id": image_id}


@app.get("/api/images/{image_id}")
def serve_image(image_id: int):
    img = images_by_id.get(image_id)
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    file_name = img.get("file_name", "")
    img_path = resolve_image_path(file_name)
    if img_path.exists():
        return FileResponse(
            str(img_path),
            headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
        )
    raise HTTPException(status_code=404, detail="Image file not found on disk")


@app.get("/api/annotations")
def get_annotations(image_id: int = Query(...)):
    anns = annotations_by_image.get(image_id, [])
    result = []
    num_kp = len(keypoint_config.get("keypoints", {}))
    for ann in anns:
        ann_copy = dict(ann)
        score = ann.get("score", 1.0)
        ann_copy["score"] = score
        # Fallback: ensure keypoint_status exists for legacy data
        if "keypoint_status" not in ann_copy:
            ann_copy["keypoint_status"] = ["predicted"] * num_kp
        result.append(ann_copy)
    return result


@app.put("/api/annotations/{annotation_id}")
async def update_annotation(annotation_id: int, request: Request):
    body = await request.json()
    new_keypoints = body.get("keypoints")
    if new_keypoints is None:
        raise HTTPException(status_code=400, detail="Missing keypoints")

    # Find and update the annotation
    for img_id, anns in annotations_by_image.items():
        for i, ann in enumerate(anns):
            if ann["id"] == annotation_id:
                anns[i]["keypoints"] = new_keypoints
                if "score" in body:
                    anns[i]["score"] = body["score"]
                if "keypoint_status" in body:
                    anns[i]["keypoint_status"] = body["keypoint_status"]
                return {"status": "ok"}

    raise HTTPException(status_code=404, detail="Annotation not found")


@app.post("/api/annotations")
async def create_annotation(request: Request):
    body = await request.json()
    image_id = body.get("image_id")
    if image_id is None:
        raise HTTPException(status_code=400, detail="Missing image_id")

    num_kp = len(keypoint_config.get("keypoints", {}))

    # Find max annotation id
    max_id = 0
    for anns in annotations_by_image.values():
        for ann in anns:
            if ann["id"] > max_id:
                max_id = ann["id"]

    new_ann = {
        "id": max_id + 1,
        "image_id": image_id,
        "category_id": body.get("category_id", 1),
        "keypoints": [0.0] * (num_kp * 3),
        "num_keypoints": num_kp,
        "score": body.get("score", 1.0),
        "keypoint_status": ["predicted"] * num_kp,
    }

    if image_id not in annotations_by_image:
        annotations_by_image[image_id] = []
    annotations_by_image[image_id].append(new_ann)

    return {"status": "ok", "annotation": new_ann}


@app.delete("/api/annotations/{annotation_id}")
def delete_annotation(annotation_id: int):
    for img_id, anns in annotations_by_image.items():
        for i, ann in enumerate(anns):
            if ann["id"] == annotation_id:
                del anns[i]
                return {"status": "ok"}
    raise HTTPException(status_code=404, detail="Annotation not found")


@app.post("/api/save")
def save_annotations():
    if output_path is None:
        raise HTTPException(status_code=400, detail="No output path configured")

    # Rebuild the COCO annotations list from in-memory state
    all_annotations = []
    for anns in annotations_by_image.values():
        for ann in anns:
            clean = {k: v for k, v in ann.items() if not k.startswith("_")}
            all_annotations.append(clean)

    # Attach reviewed status to images
    images_out = []
    for img in coco_data.get("images", []):
        img_copy = dict(img)
        img_copy["reviewed"] = img["id"] in reviewed_images
        # Strip internal fields from output
        for key in list(img_copy):
            if key.startswith("_"):
                del img_copy[key]
        images_out.append(img_copy)

    output_data = {
        "images": images_out,
        "annotations": all_annotations,
        "categories": coco_data.get("categories", []),
    }

    for key in coco_data:
        if key not in output_data:
            output_data[key] = coco_data[key]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic save: write to temp file then rename
    tmp_fd, tmp_path = tempfile.mkstemp(
        dir=str(output_path.parent), prefix=".tmp_", suffix=".json"
    )
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(output_data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, output_path)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise

    return {"status": "ok", "path": str(output_path), "count": len(all_annotations)}


@app.get("/api/export")
def export_annotations():
    all_annotations = []
    for anns in annotations_by_image.values():
        for ann in anns:
            clean = {k: v for k, v in ann.items() if not k.startswith("_")}
            all_annotations.append(clean)

    images_out = []
    for img in coco_data.get("images", []):
        img_copy = dict(img)
        img_copy["reviewed"] = img["id"] in reviewed_images
        # Strip internal fields from output
        for key in list(img_copy):
            if key.startswith("_"):
                del img_copy[key]
        images_out.append(img_copy)

    output_data = {
        "images": images_out,
        "annotations": all_annotations,
        "categories": coco_data.get("categories", []),
    }
    for key in coco_data:
        if key not in output_data:
            output_data[key] = coco_data[key]

    return JSONResponse(output_data)


def main():
    global images_dir, output_path, coco_data, keypoint_config

    parser = argparse.ArgumentParser(description="Animal Pose Keypoint Annotation Tool")
    parser.add_argument("--images-dir", required=True, help="Directory containing images")
    parser.add_argument("--input", "-i", default=None, help="COCO-format JSON to load (network predictions or previous corrections)")
    parser.add_argument("--predictions", default=None, help=argparse.SUPPRESS)  # deprecated alias
    parser.add_argument("--resume", "-r", default=None, help="Resume from a previous output file (same as --input FILE --output FILE)")
    parser.add_argument("--config", required=True, help="Keypoint configuration JSON")
    parser.add_argument("--output", "-o", default="./corrected_annotations.json", help="Output path for corrected annotations")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind to")
    args = parser.parse_args()

    images_dir = Path(args.images_dir)
    if not images_dir.exists():
        print(f"Error: images directory not found: {images_dir}")
        sys.exit(1)

    # Resolve --resume: shorthand for --input X --output X
    if args.resume:
        if args.input or args.predictions:
            print("Error: --resume is mutually exclusive with --input/--predictions")
            sys.exit(1)
        args.input = args.resume
        args.output = args.resume

    # Determine input file
    input_file = args.input or args.predictions
    if not input_file:
        print("Error: must specify --input (or --resume) to load annotations")
        sys.exit(1)

    output_path = Path(args.output)

    print(f"Loading config: {args.config}")
    keypoint_config = load_config(args.config)
    num_kp = len(keypoint_config.get("keypoints", {}))
    print(f"  {num_kp} keypoints defined")

    print(f"Loading annotations: {input_file}")
    coco_data = load_coco(input_file)
    reviewed_count = sum(1 for img in coco_data.get("images", []) if img.get("reviewed"))
    print(f"  {len(coco_data.get('images', []))} images ({reviewed_count} reviewed)")
    print(f"  {len(coco_data.get('annotations', []))} annotations")

    build_index()
    print(f"  {len(image_list)} images with files found")

    if args.resume:
        print(f"  Resume mode: reading and writing to {output_path}")

    import uvicorn
    print(f"\nStarting annotation server at http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
