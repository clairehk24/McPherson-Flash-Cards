#!/usr/bin/env python3
"""Import McPherson flash-card data and thumbnails from the editorial DOCX.

The importer intentionally uses only the Python standard library so it can run
on a clean production workstation without installing a DOCX package.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Iterable
from xml.etree import ElementTree as ET


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"w": W_NS, "a": A_NS, "r": R_NS, "rel": PKG_REL_NS}
W = lambda name: f"{{{W_NS}}}{name}"
A = lambda name: f"{{{A_NS}}}{name}"
R = lambda name: f"{{{R_NS}}}{name}"

SECTION_MAP = {
    "1": {
        "id": "head-neck",
        "name": "Head and Neck",
        "colorClass": "section-1",
    },
    "2": {
        "id": "lumbar-region",
        "name": "Lumbar Region",
        "colorClass": "section-2",
    },
    "3": {
        "id": "thorax-abdomen",
        "name": "Thorax and Abdomen",
        "colorClass": "section-3",
    },
    "4": {
        "id": "pelvic-bones",
        "name": "Pelvic Bones",
        "colorClass": "section-4",
    },
    "5": {
        "id": "upper-extremity",
        "name": "Upper Extremity",
        "colorClass": "section-5",
    },
    "6": {
        "id": "lower-extremity",
        "name": "Lower Extremity",
        "colorClass": "section-6",
    },
}

# Editorial card-type ranges are independent of interaction type. Add later
# sections here as their final manuscripts and category boundaries are approved.
CARD_TYPE_RANGES = {
    "1": [
        (1, 9, "bones", "Bones"),
        (10, 16, "ligaments", "Ligaments"),
        (17, 56, "muscles", "Muscles"),
    ],
    "2": [
        (1, 2, "bones", "Bones"),
        (3, 3, "ligaments", "Ligaments"),
        (4, 8, "muscles", "Muscles"),
    ],
    "3": [
        (1, 7, "bones", "Bones"),
        (8, 9, "ligaments", "Ligaments"),
        (10, 23, "muscles", "Muscles"),
    ],
    "4": [
        (1, 4, "bones", "Bones"),
        (5, 6, "ligaments", "Ligaments"),
        (7, 13, "muscles", "Muscles"),
    ],
    "5": [
        (1, 13, "bones", "Bones"),
        (14, 22, "ligaments", "Ligaments"),
        (23, 73, "muscles", "Muscles"),
    ],
}

GROUP_PATTERN = re.compile(
    r"^(Proximal insertion|Distal insertion|Innervation|Action):\s*(.*)$",
    re.IGNORECASE,
)
LABEL_PATTERN = re.compile(r"^([a-z]{1,2}|\d+)[.)]\s*(.+)$", re.IGNORECASE)
LIST_PREFIX_PATTERN = re.compile(r"^[a-z][.)]\s*", re.IGNORECASE)


@dataclass
class TextSegment:
    text: str
    highlighted: bool = False


@dataclass
class Paragraph:
    segments: list[TextSegment]
    image_relationship_ids: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "".join(segment.text for segment in self.segments)


@dataclass
class RawCard:
    card_id: str
    section_number: str
    section_heading: str
    title: str = ""
    title_segments: list[TextSegment] = field(default_factory=list)
    image_source: str = ""
    interaction_raw: str = ""
    content: list[Paragraph] = field(default_factory=list)
    image_relationship_ids: list[str] = field(default_factory=list)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def append_segment(segments: list[TextSegment], text: str, highlighted: bool) -> None:
    if not text:
        return
    if segments and segments[-1].highlighted == highlighted:
        segments[-1].text += text
    else:
        segments.append(TextSegment(text=text, highlighted=highlighted))


def run_is_highlighted(run: ET.Element) -> bool:
    highlight = run.find("./w:rPr/w:highlight", NS)
    if highlight is None:
        return False
    value = highlight.get(W("val"), "")
    return value.lower() not in {"", "none"}


def collect_text_segments(node: ET.Element) -> list[TextSegment]:
    """Collect visible run text while respecting highlights and tracked changes."""

    segments: list[TextSegment] = []

    def visit(element: ET.Element, inherited_highlight: bool = False) -> None:
        name = local_name(element.tag)
        if element.tag in {W("del"), W("moveFrom")}:
            return

        highlighted = (
            run_is_highlighted(element) if element.tag == W("r") else inherited_highlight
        )

        if element.tag == W("t"):
            append_segment(segments, element.text or "", highlighted)
            return
        if element.tag == W("tab"):
            append_segment(segments, "\t", highlighted)
            return
        if element.tag in {W("br"), W("cr")}:
            append_segment(segments, "\n", highlighted)
            return
        if name in {"delText", "instrText"}:
            return

        for child in element:
            visit(child, highlighted)

    visit(node)
    return segments


def slice_segments(segments: list[TextSegment], start: int) -> list[TextSegment]:
    result: list[TextSegment] = []
    offset = 0
    for segment in segments:
        end = offset + len(segment.text)
        if end > start:
            text = segment.text[max(0, start - offset) :]
            append_segment(result, text, segment.highlighted)
        offset = end
    return trim_segments(result)


def trim_segments(segments: list[TextSegment]) -> list[TextSegment]:
    result = [TextSegment(item.text, item.highlighted) for item in segments if item.text]
    if not result:
        return result
    result[0].text = result[0].text.lstrip()
    result[-1].text = result[-1].text.rstrip()
    return [item for item in result if item.text]


def paragraph_from_xml(paragraph: ET.Element) -> Paragraph:
    relationships = [
        blip.get(R("embed"), "")
        for blip in paragraph.findall(".//a:blip", NS)
        if blip.get(R("embed"))
    ]
    return Paragraph(
        segments=collect_text_segments(paragraph),
        image_relationship_ids=relationships,
    )


def paragraph_style(paragraph: ET.Element) -> str:
    style = paragraph.find("./w:pPr/w:pStyle", NS)
    return style.get(W("val"), "") if style is not None else ""


def parse_raw_cards(document_root: ET.Element) -> tuple[list[RawCard], list[str]]:
    cards: list[RawCard] = []
    section_heading = ""
    section_number = ""
    current: RawCard | None = None
    in_content = False

    body = document_root.find(".//w:body", NS)
    if body is None:
        raise ValueError("The DOCX does not contain a Word document body.")

    for block in body:
        if block.tag != W("p"):
            continue
        paragraph = paragraph_from_xml(block)
        text = paragraph.text.strip()
        style = paragraph_style(block)

        if style == "Heading1":
            section_heading = text
            match = re.search(r"\bSection\s+(\d+)", text, re.IGNORECASE)
            section_number = match.group(1) if match else ""
            continue

        card_match = re.match(r"^Card ID:\s*(.+)$", text, re.IGNORECASE)
        if card_match:
            if current is not None:
                cards.append(current)
            card_id = card_match.group(1).strip()
            card_section = card_id.split(".", 1)[0] if "." in card_id else section_number
            current = RawCard(
                card_id=card_id,
                section_number=card_section,
                section_heading=section_heading,
            )
            in_content = False
            continue

        if current is None:
            continue

        current.image_relationship_ids.extend(paragraph.image_relationship_ids)

        image_match = re.match(r"^Image file:\s*(.*)$", text, re.IGNORECASE)
        if image_match:
            current.image_source = image_match.group(1).strip()
            continue

        title_match = re.match(r"^Title:\s*(.*)$", text, re.IGNORECASE)
        if title_match:
            current.title = title_match.group(1).strip()
            prefix_end = re.match(r"^Title:\s*", paragraph.text, re.IGNORECASE)
            current.title_segments = slice_segments(
                paragraph.segments, prefix_end.end() if prefix_end else 0
            )
            continue

        interaction_match = re.match(
            r"^Activity Interaction:\s*(.*)$", text, re.IGNORECASE
        )
        if interaction_match:
            current.interaction_raw = interaction_match.group(1).strip()
            continue

        if re.match(r"^Back-of-Card Content:\s*$", text, re.IGNORECASE):
            in_content = True
            continue

        if in_content and (text or paragraph.image_relationship_ids):
            current.content.append(paragraph)

    if current is not None:
        cards.append(current)

    headings = list(dict.fromkeys(card.section_heading for card in cards))
    return cards, headings


def normalize_interaction(raw_value: str) -> str | None:
    value = re.sub(r"[^a-z]+", " ", raw_value.lower()).strip()
    if value == "drag and drop":
        return "drag-drop"
    if value == "fill in the blank":
        return "fill-blank"
    if value == "select all that apply":
        return "select-all"
    return None


def image_dimensions(data: bytes) -> tuple[int | None, int | None]:
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return struct.unpack(">II", data[16:24])

    if data.startswith(b"\xff\xd8"):
        cursor = 2
        while cursor + 9 < len(data):
            if data[cursor] != 0xFF:
                cursor += 1
                continue
            marker = data[cursor + 1]
            cursor += 2
            if marker in {0xD8, 0xD9}:
                continue
            if cursor + 2 > len(data):
                break
            length = struct.unpack(">H", data[cursor : cursor + 2])[0]
            if marker in {
                0xC0,
                0xC1,
                0xC2,
                0xC3,
                0xC5,
                0xC6,
                0xC7,
                0xC9,
                0xCA,
                0xCB,
                0xCD,
                0xCE,
                0xCF,
            }:
                height, width = struct.unpack(">HH", data[cursor + 3 : cursor + 7])
                return width, height
            cursor += length

    return None, None


def sanitize_asset_stem(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._")
    return cleaned or "unnamed-card-image"


def card_type_for(card_id: str, section_number: str) -> dict[str, str]:
    match = re.match(r"^\d+\.(\d+)$", card_id)
    card_number = int(match.group(1)) if match else -1
    for start, end, type_id, type_label in CARD_TYPE_RANGES.get(
        section_number, []
    ):
        if start <= card_number <= end:
            return {"id": type_id, "label": type_label}
    return {"id": "uncategorized", "label": "Uncategorized"}


def make_templates(
    paragraphs: Iterable[list[TextSegment]],
) -> tuple[list[list[dict[str, str]]], list[dict[str, str]]]:
    blank_number = 0
    blanks: list[dict[str, str]] = []
    templates: list[list[dict[str, str]]] = []

    for paragraph_segments in paragraphs:
        template: list[dict[str, str]] = []
        for segment in paragraph_segments:
            if not segment.highlighted or not segment.text.strip():
                if segment.text:
                    if template and template[-1]["type"] == "text":
                        template[-1]["text"] += segment.text
                    else:
                        template.append({"type": "text", "text": segment.text})
                continue

            leading = segment.text[: len(segment.text) - len(segment.text.lstrip())]
            trailing = segment.text[len(segment.text.rstrip()) :]
            answer = segment.text.strip()
            if leading:
                template.append({"type": "text", "text": leading})

            blank_number += 1
            blank_id = f"blank-{blank_number}"
            template.append({"type": "blank", "id": blank_id})
            blanks.append({"id": blank_id, "answer": answer})

            if trailing:
                template.append({"type": "text", "text": trailing})

        templates.append(template)

    return templates, blanks


def clean_select_option(text: str) -> str:
    without_prefix = LIST_PREFIX_PATTERN.sub("", text.strip())
    return re.sub(r"\s+", " ", without_prefix.replace("*", " ")).strip()


def issue(
    issues: list[dict[str, str]],
    severity: str,
    code: str,
    message: str,
    card_id: str = "",
) -> None:
    record = {"severity": severity, "code": code, "message": message}
    if card_id:
        record["cardId"] = card_id
    issues.append(record)


def select_largest_image(
    raw_card: RawCard,
    relationships: dict[str, str],
    package: zipfile.ZipFile,
    issues: list[dict[str, str]],
) -> tuple[str, bytes, int | None, int | None] | None:
    candidates: list[tuple[int, int, str, bytes, int | None, int | None]] = []

    for relationship_id in dict.fromkeys(raw_card.image_relationship_ids):
        target = relationships.get(relationship_id)
        if not target:
            issue(
                issues,
                "error",
                "missing_image_relationship",
                f"Image relationship {relationship_id} has no package target.",
                raw_card.card_id,
            )
            continue

        package_path = str(PurePosixPath("word") / PurePosixPath(target))
        try:
            data = package.read(package_path)
        except KeyError:
            issue(
                issues,
                "error",
                "missing_embedded_image",
                f"Embedded image {package_path} is missing from the DOCX.",
                raw_card.card_id,
            )
            continue

        width, height = image_dimensions(data)
        area = (width or 0) * (height or 0)
        candidates.append((area, len(data), package_path, data, width, height))

    if not candidates:
        issue(
            issues,
            "error",
            "card_has_no_image",
            "No embedded thumbnail was found for this card.",
            raw_card.card_id,
        )
        return None

    if len(candidates) > 1:
        issue(
            issues,
            "warning",
            "multiple_card_images",
            (
                f"Found {len(candidates)} embedded images; the largest image was selected "
                "as the card thumbnail."
            ),
            raw_card.card_id,
        )

    _, _, package_path, data, width, height = max(
        candidates, key=lambda item: (item[0], item[1])
    )
    return package_path, data, width, height


def build_drag_interaction(
    raw_card: RawCard, issues: list[dict[str, str]]
) -> tuple[dict[str, Any], bool]:
    labels: list[dict[str, str]] = []
    for paragraph in raw_card.content:
        text = paragraph.text.strip()
        match = LABEL_PATTERN.match(text)
        if not match:
            issue(
                issues,
                "warning",
                "unparsed_drag_content",
                f"Could not parse drag-and-drop label line: {text}",
                raw_card.card_id,
            )
            continue
        target, answer = match.groups()
        labels.append(
            {
                "id": f"label-{target.lower()}",
                "target": target.lower(),
                "answer": answer.strip(),
            }
        )

    targets = [label["target"] for label in labels]
    if not labels:
        issue(
            issues,
            "error",
            "drag_card_has_no_labels",
            "No label/answer pairs were found for this drag-and-drop card.",
            raw_card.card_id,
        )
    if len(targets) != len(set(targets)):
        issue(
            issues,
            "error",
            "duplicate_drag_targets",
            "The drag-and-drop target letters are not unique.",
            raw_card.card_id,
        )

    return {"labels": labels}, bool(labels) and len(targets) == len(set(targets))


def build_fill_interaction(
    raw_card: RawCard, issues: list[dict[str, str]]
) -> tuple[dict[str, Any], bool]:
    title_templates, title_blanks = make_templates([raw_card.title_segments])
    content_templates, content_blanks = make_templates(
        paragraph.segments for paragraph in raw_card.content
    )

    # make_templates numbers each collection from one, so renumber content blanks.
    blank_offset = len(title_blanks)
    if blank_offset:
        for template in content_templates:
            for segment in template:
                if segment["type"] == "blank":
                    number = int(segment["id"].split("-")[-1]) + blank_offset
                    segment["id"] = f"blank-{number}"
        for blank in content_blanks:
            number = int(blank["id"].split("-")[-1]) + blank_offset
            blank["id"] = f"blank-{number}"

    blanks = title_blanks + content_blanks
    if not blanks:
        issue(
            issues,
            "warning",
            "fill_card_has_no_highlights",
            (
                "No highlighted answer text was found. The card was imported as a "
                "visible draft but cannot be graded yet."
            ),
            raw_card.card_id,
        )

    has_unexpected_marker = any("*" in paragraph.text for paragraph in raw_card.content)
    if has_unexpected_marker:
        issue(
            issues,
            "warning",
            "unexpected_correct_marker",
            (
                "An asterisk appears on a fill-in-the-blank card. Correct-answer "
                "asterisks are only interpreted for select-all-that-apply cards."
            ),
            raw_card.card_id,
        )

    return (
        {
            "titleTemplate": title_templates[0] if title_templates else [],
            "paragraphs": content_templates,
            "blanks": blanks,
        },
        bool(blanks) and not has_unexpected_marker,
    )


def build_select_interaction(
    raw_card: RawCard, issues: list[dict[str, str]]
) -> tuple[dict[str, Any], bool]:
    groups: list[dict[str, Any]] = []
    current_group: dict[str, Any] | None = None
    ungrouped: list[str] = []

    for paragraph in raw_card.content:
        text = paragraph.text.strip()
        if not text:
            continue

        header_match = GROUP_PATTERN.match(text)
        if header_match:
            label, inline_text = header_match.groups()
            current_group = {
                "id": re.sub(r"[^a-z]+", "-", label.lower()).strip("-"),
                "label": label,
                "staticText": inline_text.strip(),
                "options": [],
            }
            groups.append(current_group)
            continue

        if current_group is None:
            ungrouped.append(text)
            continue

        current_group["options"].append(
            {
                "id": f"{current_group['id']}-option-{len(current_group['options']) + 1}",
                "text": clean_select_option(text),
                "correct": "*" in text,
            }
        )

    if ungrouped:
        issue(
            issues,
            "warning",
            "ungrouped_select_content",
            f"Content appeared before the first select-all group: {' | '.join(ungrouped)}",
            raw_card.card_id,
        )

    interactive_groups = [group for group in groups if group["options"]]
    ready = bool(interactive_groups)
    if not interactive_groups:
        issue(
            issues,
            "error",
            "select_card_has_no_options",
            "No selectable answer options were found.",
            raw_card.card_id,
        )

    for group in interactive_groups:
        if not any(option["correct"] for option in group["options"]):
            ready = False
            issue(
                issues,
                "error",
                "select_group_has_no_correct_answer",
                f"The {group['label']} group has no asterisked correct answer.",
                raw_card.card_id,
            )
        if any(not option["text"] for option in group["options"]):
            ready = False
            issue(
                issues,
                "error",
                "empty_select_option",
                f"The {group['label']} group contains an empty answer option.",
                raw_card.card_id,
            )

    return {"groups": groups}, ready


def build_card_data(
    raw_cards: list[RawCard],
    relationships: dict[str, str],
    package: zipfile.ZipFile,
    assets_directory: Path,
    write_files: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, str]], set[Path]]:
    cards: list[dict[str, Any]] = []
    issues: list[dict[str, str]] = []
    written_assets: set[Path] = set()
    seen_ids: set[str] = set()
    seen_image_sources: dict[str, str] = {}

    for order, raw_card in enumerate(raw_cards):
        card_issue_start = len(issues)
        if raw_card.card_id in seen_ids:
            issue(
                issues,
                "error",
                "duplicate_card_id",
                "This card ID appears more than once.",
                raw_card.card_id,
            )
        seen_ids.add(raw_card.card_id)

        section = SECTION_MAP.get(raw_card.section_number)
        card_type = card_type_for(raw_card.card_id, raw_card.section_number)
        if section is None:
            section = {
                "id": f"section-{raw_card.section_number or 'unknown'}",
                "name": raw_card.section_heading or "Unknown section",
                "colorClass": "section-1",
            }
            issue(
                issues,
                "error",
                "unknown_section",
                f"No canonical section mapping exists for section {raw_card.section_number}.",
                raw_card.card_id,
            )

        interaction = normalize_interaction(raw_card.interaction_raw)
        interaction_inferred = False
        if interaction is None and not raw_card.interaction_raw:
            interaction = "fill-blank"
            interaction_inferred = True
            issue(
                issues,
                "warning",
                "missing_interaction_inferred",
                (
                    "The interaction field is blank. Fill-in-the-blank was inferred from "
                    "the surrounding manuscript sequence; editorial confirmation is required."
                ),
                raw_card.card_id,
            )
        elif interaction is None:
            interaction = "unknown"
            issue(
                issues,
                "error",
                "unknown_interaction",
                f"Unrecognized interaction value: {raw_card.interaction_raw}",
                raw_card.card_id,
            )

        if not raw_card.title:
            issue(
                issues,
                "error",
                "missing_title",
                "The card has no title.",
                raw_card.card_id,
            )

        if not raw_card.image_source:
            issue(
                issues,
                "error",
                "missing_image_source",
                "The card has no source image filename.",
                raw_card.card_id,
            )
        elif raw_card.image_source in seen_image_sources:
            issue(
                issues,
                "warning",
                "duplicate_image_source",
                (
                    f"The source image is also used by card "
                    f"{seen_image_sources[raw_card.image_source]}."
                ),
                raw_card.card_id,
            )
        else:
            seen_image_sources[raw_card.image_source] = raw_card.card_id

        selected_image = select_largest_image(
            raw_card, relationships, package, issues
        )
        image_record: dict[str, Any] = {
            "sourceFile": raw_card.image_source,
            "src": "",
            "width": None,
            "height": None,
            "alt": f"{raw_card.title} anatomical reference illustration",
            "draftThumbnail": True,
        }
        if selected_image is not None:
            package_path, image_bytes, width, height = selected_image
            extension = Path(package_path).suffix.lower() or ".png"
            asset_name = f"{sanitize_asset_stem(raw_card.image_source)}{extension}"
            asset_path = assets_directory / asset_name
            image_record.update(
                {
                    "src": f"Assets/Cards/{asset_name}",
                    "width": width,
                    "height": height,
                    "packageSource": package_path,
                }
            )
            if write_files:
                assets_directory.mkdir(parents=True, exist_ok=True)
                asset_path.write_bytes(image_bytes)
            written_assets.add(asset_path.resolve())

        if interaction == "drag-drop":
            interaction_data, ready = build_drag_interaction(raw_card, issues)
        elif interaction == "fill-blank":
            interaction_data, ready = build_fill_interaction(raw_card, issues)
        elif interaction == "select-all":
            interaction_data, ready = build_select_interaction(raw_card, issues)
            if card_type["id"] == "muscles":
                title_templates, title_blanks = make_templates(
                    [raw_card.title_segments]
                )
                if not title_blanks:
                    title_templates = [[{"type": "blank", "id": "blank-1"}]]
                    title_blanks = [{"id": "blank-1", "answer": raw_card.title}]
                interaction_data.update(
                    {
                        "titleTemplate": title_templates[0],
                        "blanks": title_blanks,
                    }
                )
        else:
            interaction_data = {
                "paragraphs": [
                    [{"type": "text", "text": paragraph.text}]
                    for paragraph in raw_card.content
                ]
            }
            ready = False

        if interaction_inferred:
            ready = False

        draft_reason_codes = []
        if not ready:
            draft_reason_codes = list(
                dict.fromkeys(
                    item["code"]
                    for item in issues[card_issue_start:]
                    if item.get("cardId") == raw_card.card_id
                    and item["code"]
                    in {
                        "fill_card_has_no_highlights",
                        "unexpected_correct_marker",
                        "missing_interaction_inferred",
                        "unknown_interaction",
                        "drag_card_has_no_labels",
                        "duplicate_drag_targets",
                        "select_card_has_no_options",
                        "select_group_has_no_correct_answer",
                        "empty_select_option",
                    }
                )
            )

        searchable_text = " ".join(
            [
                raw_card.card_id,
                section["name"],
                card_type["label"],
                raw_card.title,
                raw_card.image_source,
                *(paragraph.text for paragraph in raw_card.content),
            ]
        )

        cards.append(
            {
                "id": raw_card.card_id,
                "order": order,
                "sectionId": section["id"],
                "sectionName": section["name"],
                "sectionColorClass": section["colorClass"],
                "cardType": card_type["id"],
                "cardTypeLabel": card_type["label"],
                "manuscriptSectionHeading": raw_card.section_heading,
                "title": raw_card.title,
                "interaction": interaction,
                "interactionLabel": {
                    "drag-drop": "Drag and Drop",
                    "fill-blank": "Fill in the Blank",
                    "select-all": "Select All That Apply",
                    "unknown": "Unassigned",
                }[interaction],
                "interactionInferred": interaction_inferred,
                "ready": ready,
                "draftReasonCodes": draft_reason_codes,
                "image": image_record,
                "searchText": re.sub(r"\s+", " ", searchable_text).strip().lower(),
                **interaction_data,
            }
        )

    return cards, issues, written_assets


def read_relationships(package: zipfile.ZipFile) -> dict[str, str]:
    root = ET.fromstring(package.read("word/_rels/document.xml.rels"))
    return {
        relationship.get("Id", ""): relationship.get("Target", "")
        for relationship in root.findall("rel:Relationship", NS)
    }


def build_sections(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts = Counter(card["sectionId"] for card in cards)
    sections = []
    for section in SECTION_MAP.values():
        sections.append({**section, "cardCount": counts[section["id"]]})
    return sections


def clean_stale_assets(assets_directory: Path, expected_assets: set[Path]) -> int:
    if not assets_directory.exists():
        return 0
    removed = 0
    for path in assets_directory.iterdir():
        if (
            path.is_file()
            and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"}
            and path.resolve() not in expected_assets
        ):
            path.unlink()
            removed += 1
    return removed


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8", newline="\n")
    temporary.replace(path)


def read_generated_payload(path: Path) -> dict[str, Any]:
    marker = "window.MCPHERSON_CARD_DATA = "
    content = path.read_text(encoding="utf-8")
    if not content.startswith("/* Generated by scripts/import_manuscript.py."):
        raise ValueError(f"The merge source is not a generated card-data file: {path}")
    if marker not in content:
        raise ValueError(f"Could not find the card-data assignment in {path}")
    serialized = content.split(marker, 1)[1].strip()
    if serialized.endswith(";"):
        serialized = serialized[:-1]
    payload = json.loads(serialized)
    if not isinstance(payload.get("cards"), list):
        raise ValueError(f"The merge source does not contain a cards array: {path}")
    return payload


def card_sort_key(card: dict[str, Any]) -> tuple[int, int, str]:
    card_id = str(card.get("id", ""))
    match = re.match(r"^(\d+)\.(\d+)$", card_id)
    if match:
        return int(match.group(1)), int(match.group(2)), card_id
    return sys.maxsize, sys.maxsize, card_id


def parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Import McPherson flash-card content from a DOCX manuscript."
    )
    parser.add_argument("manuscript", type=Path, help="Path to the source .docx")
    parser.add_argument(
        "--output",
        type=Path,
        default=project_root / "data" / "cards.js",
        help="Generated browser data file",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=project_root / "data" / "import-report.json",
        help="Generated validation report",
    )
    parser.add_argument(
        "--assets-dir",
        type=Path,
        default=project_root / "Assets" / "Cards",
        help="Directory for extracted card thumbnails",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Parse and validate without writing generated files",
    )
    parser.add_argument(
        "--clean-assets",
        action="store_true",
        help="Remove stale image files from the exact card-assets directory",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Return a failure status for warnings as well as errors",
    )
    parser.add_argument(
        "--merge-existing",
        action="store_true",
        help=(
            "Replace only the imported manuscript sections in the existing output "
            "while preserving cards from all other sections"
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manuscript = args.manuscript.resolve()
    if not manuscript.is_file():
        print(f"Manuscript not found: {manuscript}", file=sys.stderr)
        return 2
    if manuscript.suffix.lower() != ".docx":
        print("The manuscript must be a .docx file.", file=sys.stderr)
        return 2

    try:
        with zipfile.ZipFile(manuscript) as package:
            document_root = ET.fromstring(package.read("word/document.xml"))
            relationships = read_relationships(package)
            raw_cards, manuscript_headings = parse_raw_cards(document_root)
            cards, issues, expected_assets = build_card_data(
                raw_cards=raw_cards,
                relationships=relationships,
                package=package,
                assets_directory=args.assets_dir.resolve(),
                write_files=not args.check_only,
            )
    except (KeyError, ET.ParseError, zipfile.BadZipFile, ValueError) as error:
        print(f"Could not parse manuscript: {error}", file=sys.stderr)
        return 2

    imported_asset_count = len(expected_assets)
    source_record = {
        "filename": manuscript.name,
        "sha256": sha256_file(manuscript),
        "manuscriptSectionHeadings": manuscript_headings,
    }
    merge_record: dict[str, Any] | None = None
    if args.merge_existing:
        output_path = args.output.resolve()
        if not output_path.is_file():
            print(
                f"Cannot merge because the existing output was not found: {output_path}",
                file=sys.stderr,
            )
            return 2
        try:
            existing_payload = read_generated_payload(output_path)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            print(f"Could not read the existing card data for merging: {error}", file=sys.stderr)
            return 2

        incoming_section_ids = {card["sectionId"] for card in cards}
        existing_cards = existing_payload["cards"]
        replaced_card_ids = {
            card["id"]
            for card in existing_cards
            if card.get("sectionId") in incoming_section_ids
        }
        preserved_cards = [
            card
            for card in existing_cards
            if card.get("sectionId") not in incoming_section_ids
        ]
        cards = sorted([*preserved_cards, *cards], key=card_sort_key)
        for order, card in enumerate(cards):
            card["order"] = order

        if args.report.resolve().is_file():
            try:
                existing_report = json.loads(
                    args.report.resolve().read_text(encoding="utf-8")
                )
                preserved_issues = [
                    item
                    for item in existing_report.get("issues", [])
                    if item.get("cardId") not in replaced_card_ids
                ]
                issues = [*preserved_issues, *issues]
            except (OSError, json.JSONDecodeError):
                pass

        for card in preserved_cards:
            image_src = card.get("image", {}).get("src", "")
            if image_src:
                expected_assets.add(
                    (args.assets_dir.resolve() / Path(image_src).name).resolve()
                )

        combined_headings = list(
            dict.fromkeys(
                card.get("manuscriptSectionHeading", "")
                for card in cards
                if card.get("manuscriptSectionHeading")
            )
        )
        source_record["manuscriptSectionHeadings"] = combined_headings
        merge_record = {
            "replacedSectionIds": sorted(incoming_section_ids),
            "replacedCards": len(replaced_card_ids),
            "preservedCards": len(preserved_cards),
        }
        source_record["merge"] = merge_record

    severity_counts = Counter(item["severity"] for item in issues)
    interaction_counts = Counter(card["interaction"] for card in cards)
    ready_counts = Counter("ready" if card["ready"] else "draft" for card in cards)

    payload = {
        "schemaVersion": 2,
        "source": source_record,
        "sections": build_sections(cards),
        "cards": cards,
    }
    report = {
        "source": payload["source"],
        "summary": {
            "cards": len(cards),
            "readyCards": ready_counts["ready"],
            "draftCards": ready_counts["draft"],
            "interactions": dict(sorted(interaction_counts.items())),
            "errors": severity_counts["error"],
            "warnings": severity_counts["warning"],
        },
        "issues": issues,
    }

    removed_assets = 0
    if not args.check_only:
        javascript = (
            "/* Generated by scripts/import_manuscript.py. Do not edit by hand. */\n"
            "window.MCPHERSON_CARD_DATA = "
            + json.dumps(payload, ensure_ascii=False, indent=2)
            + ";\n"
        )
        atomic_write_text(args.output.resolve(), javascript)
        atomic_write_text(
            args.report.resolve(),
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        )
        if args.clean_assets:
            removed_assets = clean_stale_assets(
                args.assets_dir.resolve(), expected_assets
            )

    print(
        (
            f"Parsed {len(cards)} cards: {ready_counts['ready']} ready, "
            f"{ready_counts['draft']} draft; "
            f"{severity_counts['error']} errors, "
            f"{severity_counts['warning']} warnings."
        )
    )
    print(
        "Interactions: "
        + ", ".join(
            f"{name}={count}" for name, count in sorted(interaction_counts.items())
        )
    )
    if not args.check_only:
        print(f"Wrote {args.output.resolve()}")
        print(f"Wrote {args.report.resolve()}")
        print(f"Extracted {imported_asset_count} card thumbnails.")
        if merge_record is not None:
            print(
                f"Preserved {merge_record['preservedCards']} cards and their existing assets."
            )
        if args.clean_assets:
            print(f"Removed {removed_assets} stale card thumbnails.")

    if severity_counts["error"]:
        return 1
    if args.strict and severity_counts["warning"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
