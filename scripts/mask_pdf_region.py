#!/usr/bin/env python3
"""Cover fixed regions on selected PDF pages with white rectangles."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

try:
    import fitz  # PyMuPDF
except ModuleNotFoundError as exc:
    raise SystemExit(
        "Missing dependency: PyMuPDF\n"
        "Install it with: python3 -m pip install -r requirements-pdf-tools.txt"
    ) from exc


MM_TO_PT = 72 / 25.4


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Cover one or more rectangular regions on specific PDF pages."
    )
    parser.add_argument("input_pdf", type=Path, help="Path to the source PDF file.")
    parser.add_argument(
        "--config",
        type=Path,
        help="Optional JSON config exported by the coordinate picker UI.",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Path to the output PDF file. Defaults to '<input>-masked.pdf'.",
    )
    parser.add_argument(
        "--pages",
        help="1-based page selection, e.g. '3-18' or '1,3,5-7'.",
    )
    parser.add_argument(
        "--rect",
        action="append",
        help=(
            "Rectangle coordinates. Pass multiple times for multiple white blocks. "
            "Format depends on --rect-mode."
        ),
    )
    parser.add_argument(
        "--rect-mode",
        choices=("xyxy", "xywh"),
        default=None,
        help="Interpret rectangles as x0,y0,x1,y1 or x,y,width,height.",
    )
    parser.add_argument(
        "--unit",
        choices=("pt", "mm"),
        default=None,
        help="Coordinate unit for --rect values.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print matched page numbers and page sizes during processing.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite the output file if it already exists.",
    )
    return parser.parse_args()


def default_output_path(input_pdf: Path) -> Path:
    return input_pdf.with_name(f"{input_pdf.stem}-masked.pdf")


def load_config(config_path: Path) -> dict:
    resolved = config_path.expanduser().resolve()
    if not resolved.exists():
        raise ValueError(f"Config file does not exist: {resolved}")

    try:
        data = json.loads(resolved.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON config: {resolved}") from exc

    if not isinstance(data, dict):
        raise ValueError("Config root must be a JSON object.")

    return data


def parse_page_range(start: int, end: int, page_count: int) -> list[int]:
    if start > end:
        raise ValueError(f"Invalid page range: start {start} is greater than end {end}")
    if start < 1 or end > page_count:
        raise ValueError(f"Pages out of range 1-{page_count}: {start}-{end}")
    return list(range(start, end + 1))


def parse_pages(page_spec: str, page_count: int) -> list[int]:
    pages: set[int] = set()
    for part in page_spec.split(","):
        token = part.strip()
        if not token:
            continue
        if "-" in token:
            start_raw, end_raw = token.split("-", 1)
            start = int(start_raw)
            end = int(end_raw)
            if start > end:
                raise ValueError(f"Invalid page range: '{token}'")
            pages.update(range(start, end + 1))
            continue
        pages.add(int(token))

    if not pages:
        raise ValueError("No valid pages were provided.")

    invalid = sorted(page for page in pages if page < 1 or page > page_count)
    if invalid:
        invalid_str = ", ".join(str(page) for page in invalid)
        raise ValueError(f"Pages out of range 1-{page_count}: {invalid_str}")

    return sorted(pages)


def parse_pages_from_config(config: dict, page_count: int) -> list[int]:
    page_range = config.get("page_range")
    if page_range is not None:
        if not isinstance(page_range, dict):
            raise ValueError("Config field 'page_range' must be an object.")
        try:
            start = int(page_range["start"])
            end = int(page_range["end"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("Config field 'page_range' must contain integer start and end.") from exc
        return parse_page_range(start, end, page_count)

    page_spec = config.get("pages")
    if page_spec is None:
        raise ValueError("Config must contain 'pages' or 'page_range'.")
    return parse_pages(str(page_spec), page_count)


def rect_specs_from_config(config: dict) -> list[str]:
    raw_rects = config.get("rects")
    if raw_rects is None:
        return []
    if not isinstance(raw_rects, list):
        raise ValueError("Config field 'rects' must be a list.")

    rect_specs: list[str] = []
    for index, item in enumerate(raw_rects, start=1):
        if isinstance(item, str):
            rect_specs.append(item)
            continue
        if not isinstance(item, dict):
            raise ValueError(f"Config rect #{index} must be an object or string.")

        if {"x0", "y0", "x1", "y1"} <= set(item):
            rect_specs.append(f"{item['x0']},{item['y0']},{item['x1']},{item['y1']}")
            continue
        if {"x", "y", "width", "height"} <= set(item):
            rect_specs.append(f"{item['x']},{item['y']},{item['width']},{item['height']}")
            continue

        raise ValueError(
            f"Config rect #{index} must contain either x0,y0,x1,y1 or x,y,width,height."
        )

    return rect_specs


def filter_pages_by_mode(pages: list[int], apply_to: str) -> list[int]:
    if apply_to == "all":
        return pages
    if apply_to == "odd":
        return [page for page in pages if page % 2 == 1]
    if apply_to == "even":
        return [page for page in pages if page % 2 == 0]
    raise ValueError(f"Unsupported apply_to mode: {apply_to}")


def parse_rect(rect_spec: str, rect_mode: str, unit: str) -> fitz.Rect:
    try:
        values = [float(item.strip()) for item in rect_spec.split(",")]
    except ValueError as exc:
        raise ValueError(f"Invalid rect '{rect_spec}': coordinates must be numbers.") from exc

    if len(values) != 4:
        raise ValueError(f"Invalid rect '{rect_spec}': expected 4 numbers.")

    if unit == "mm":
        values = [value * MM_TO_PT for value in values]

    if rect_mode == "xywh":
        x, y, width, height = values
        if width <= 0 or height <= 0:
            raise ValueError(f"Invalid rect '{rect_spec}': width and height must be > 0.")
        rect = fitz.Rect(x, y, x + width, y + height)
    else:
        x0, y0, x1, y1 = values
        rect = fitz.Rect(x0, y0, x1, y1)

    if rect.is_empty or rect.is_infinite:
        raise ValueError(f"Invalid rect '{rect_spec}': empty or infinite rectangle.")

    return rect


def build_page_rect_map(base_pages: list[int], rects: list[fitz.Rect]) -> dict[int, list[fitz.Rect]]:
    return {page: list(rects) for page in base_pages}


def build_page_rect_map_from_config(config: dict, page_count: int) -> dict[int, list[fitz.Rect]]:
    base_pages = parse_pages_from_config(config, page_count)
    page_rects: dict[int, list[fitz.Rect]] = {}

    if "rules" in config:
        raw_rules = config.get("rules")
        if not isinstance(raw_rules, list):
            raise ValueError("Config field 'rules' must be a list.")

        for index, rule in enumerate(raw_rules, start=1):
            if not isinstance(rule, dict):
                raise ValueError(f"Config rule #{index} must be an object.")
            if rule.get("enabled", True) is False:
                continue

            rect_mode = rule.get("rect_mode") or config.get("rect_mode") or "xyxy"
            unit = rule.get("unit") or config.get("unit") or "pt"
            apply_to = rule.get("apply_to") or rule.get("page_mode") or "all"
            rect_specs = rect_specs_from_config(rule)
            rects = [parse_rect(rect_spec, rect_mode, unit) for rect_spec in rect_specs]
            for page in filter_pages_by_mode(base_pages, str(apply_to)):
                page_rects.setdefault(page, []).extend(rects)

        return page_rects

    rect_mode = config.get("rect_mode") or "xyxy"
    unit = config.get("unit") or "pt"
    rect_specs = rect_specs_from_config(config)
    rects = [parse_rect(rect_spec, rect_mode, unit) for rect_spec in rect_specs]
    return build_page_rect_map(base_pages, rects)


def mask_page_rects(
    input_pdf: Path,
    output_pdf: Path,
    page_rects: dict[int, list[fitz.Rect]],
    verbose: bool,
) -> None:
    with fitz.open(input_pdf) as doc:
        for page_number in sorted(page_rects):
            page = doc[page_number - 1]
            page_rect = page.rect
            if verbose:
                print(
                    f"Page {page_number}: size={page_rect.width:.2f}pt x {page_rect.height:.2f}pt",
                    file=sys.stderr,
                )

            for rect in page_rects[page_number]:
                page.draw_rect(
                    rect,
                    color=(1, 1, 1),
                    fill=(1, 1, 1),
                    width=0,
                    overlay=True,
                    stroke_opacity=1,
                    fill_opacity=1,
                )

        output_pdf.parent.mkdir(parents=True, exist_ok=True)
        doc.save(output_pdf, garbage=4, deflate=True)


def mask_regions(
    input_pdf: Path,
    output_pdf: Path,
    pages: list[int],
    rects: list[fitz.Rect],
    verbose: bool,
) -> None:
    mask_page_rects(input_pdf, output_pdf, build_page_rect_map(pages, rects), verbose)


def main() -> int:
    args = parse_args()
    input_pdf = args.input_pdf.expanduser().resolve()
    output_pdf = (args.output or default_output_path(input_pdf)).expanduser().resolve()

    if not input_pdf.exists():
        raise SystemExit(f"Input PDF does not exist: {input_pdf}")
    if output_pdf == input_pdf:
        raise SystemExit("Output PDF must be different from the input PDF.")
    if output_pdf.exists():
        if not args.force:
            raise SystemExit(f"Output PDF already exists: {output_pdf}\nUse --force to overwrite it.")
        output_pdf.unlink()

    try:
        config = load_config(args.config) if args.config else {}
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    with fitz.open(input_pdf) as doc:
        try:
            if args.config:
                page_rects = build_page_rect_map_from_config(config, len(doc))
            else:
                if not args.pages:
                    raise ValueError("Missing pages. Provide --pages.")
                if not args.rect:
                    raise ValueError("Missing rectangles. Provide --rect.")
                rect_mode = args.rect_mode or "xyxy"
                unit = args.unit or "pt"
                pages = parse_pages(args.pages, len(doc))
                rects = [parse_rect(rect_spec, rect_mode, unit) for rect_spec in args.rect]
                page_rects = build_page_rect_map(pages, rects)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc

    mask_page_rects(input_pdf, output_pdf, page_rects, args.verbose)
    print(f"Saved masked PDF to: {output_pdf}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
