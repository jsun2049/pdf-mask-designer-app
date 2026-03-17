#!/usr/bin/env python3
"""Batch-apply white rectangle masks to PDF files in a directory."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from mask_pdf_region import (
    build_page_rect_map_from_config,
    load_config,
    mask_page_rects,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Apply one mask config to all matching PDFs in a directory."
    )
    parser.add_argument(
        "input_dir",
        type=Path,
        help="Directory containing source PDF files.",
    )
    parser.add_argument(
        "--config",
        type=Path,
        required=True,
        help="JSON config exported by the coordinate picker UI.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Directory for masked PDFs. Defaults to '<input_dir>-masked'.",
    )
    parser.add_argument(
        "--pattern",
        default="*.pdf",
        help="Glob pattern for matching PDF files. Default: *.pdf",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Search for PDFs recursively under input_dir.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing output PDFs.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print detailed progress for each file.",
    )
    return parser.parse_args()


def default_output_dir(input_dir: Path) -> Path:
    return input_dir.with_name(f"{input_dir.name}-masked")


def iter_input_pdfs(input_dir: Path, pattern: str, recursive: bool) -> list[Path]:
    iterator = input_dir.rglob(pattern) if recursive else input_dir.glob(pattern)
    return sorted(path.resolve() for path in iterator if path.is_file())


def should_skip(path: Path, output_dir: Path) -> bool:
    try:
        return path.resolve().is_relative_to(output_dir.resolve())
    except ValueError:
        return False


def resolve_output_path(input_pdf: Path, input_dir: Path, output_dir: Path) -> Path:
    relative_path = input_pdf.relative_to(input_dir)
    return output_dir / relative_path.parent / f"{input_pdf.stem}-masked.pdf"


def main() -> int:
    args = parse_args()
    input_dir = args.input_dir.expanduser().resolve()
    output_dir = (args.output_dir or default_output_dir(input_dir)).expanduser().resolve()

    if not input_dir.exists() or not input_dir.is_dir():
        raise SystemExit(f"Input directory does not exist: {input_dir}")

    config = load_config(args.config)

    input_pdfs = [
        path for path in iter_input_pdfs(input_dir, args.pattern, args.recursive)
        if not should_skip(path, output_dir)
    ]
    if not input_pdfs:
        raise SystemExit(f"No PDFs matched in {input_dir} with pattern '{args.pattern}'.")

    processed = 0
    skipped = 0

    for input_pdf in input_pdfs:
        output_pdf = resolve_output_path(input_pdf, input_dir, output_dir)
        if output_pdf.exists() and not args.force:
            skipped += 1
            print(f"Skip existing: {output_pdf}", file=sys.stderr)
            continue
        if output_pdf.exists():
            output_pdf.unlink()

        try:
            from fitz import open as fitz_open

            with fitz_open(input_pdf) as doc:
                page_rects = build_page_rect_map_from_config(config, len(doc))
        except ValueError as exc:
            raise SystemExit(f"{input_pdf}: {exc}") from exc

        if args.verbose:
            print(f"Masking: {input_pdf} -> {output_pdf}", file=sys.stderr)
        mask_page_rects(input_pdf, output_pdf, page_rects, args.verbose)
        processed += 1

    print(
        f"Finished. processed={processed} skipped={skipped} output_dir={output_dir}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
