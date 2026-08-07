# McPherson Flash Cards

This static web application imports the flash-card manuscript into three learner interactions:

- **Drag and Drop** — learners match shuffled anatomy terms to the image's lettered callouts. It also supports a keyboard- and touch-friendly select-then-place workflow.
- **Fill in the Blank** — every highlighted span in the card title or body becomes an independently graded blank. The manuscript’s lettered back-of-card structure is preserved, each inline answer gives feedback on blur, and Enter checks the current blank before advancing.
- **Select All That Apply** — options marked with `*` in the manuscript are graded as correct; the asterisks are not shown to learners.

The app retains section and anatomical card-type filters, search, automatic grading, image zoom, study stacks, shuffling, progress saved in the browser, and responsive layouts.

## Import a manuscript revision

Python 3 is the only requirement. From the project root, run:

```powershell
python scripts/import_manuscript.py "\\pubfile.hkusa.com\PubActive\Development\ACADEMIC\2-Active\McPherson - X002783\01 Book - L1344\Manuscript\HKPropel MS Prep\McPherson_Flash_Cards_Manuscript_With_Thumbnails.docx" --clean-assets
```

The import is deterministic and produces:

- `data/cards.js` — all browser-ready card content and answer data.
- `data/import-report.json` — counts plus card-specific editorial warnings/errors.
- `Assets/Cards/<Image file>.png` — the embedded thumbnail associated with each card.

Do not edit generated files by hand. Make content corrections in the manuscript and rerun the importer. `--clean-assets` only removes stale image files from the exact `Assets/Cards` directory. Use `--check-only` to validate a manuscript without changing generated files, or `--strict` when any warning should fail a production check.

## Manuscript authoring contract

Each card must remain under a `Section N` heading and use these fields:

```text
Card ID: 1.1
Image file: L1344_760012
Title: Gross Anatomy
Activity Interaction: Drag and Drop
Back-of-Card Content:
```

Interaction-specific rules:

1. **Drag and Drop**
   - Use `Activity Interaction: Drag and Drop`.
   - Put one mapping on each content line, such as `a. Parietal bone`.
   - The callout key before the period must match the callout shown in the art.

2. **Fill in the Blank**
   - Use `Activity Interaction: fill-in-the-blank`.
   - Highlight only the exact answer text in the title or back-of-card content.
   - Every separate highlighted span becomes a separate answer blank. A highlighted phrase may contain spaces and punctuation.

3. **Select All That Apply**
   - Use `Activity Interaction: Select all that apply`.
   - On cards categorized as Muscles, the importer automatically converts the complete title into a required blank that is graded together with the select-all response.
   - Start groups with `Proximal insertion:`, `Distal insertion:`, `Innervation:`, or `Action:`.
   - Put answer options on the following lines and add `*` next to every correct option.
   - A heading with text on the same line is imported as reference text rather than as a selectable group.

Keep one embedded thumbnail with each card. If a card contains more than one image, the importer selects the image with the largest pixel area and reports the exception.

## Editorial validation

The importer never silently invents missing answer data. In the current six-section build it found:

- 244 total cards and 244 mapped thumbnails.
- 50 drag-and-drop cards.
- 27 fill-in-the-blank cards.
- 167 select-all-that-apply cards.
- 244 cards ready to grade and no editorial drafts.
- 0 structural errors and 1 warning.

The remaining warning identifies a duplicate embedded image on card 1.27; the importer selects the image with the largest pixel area. As the manuscript is edited, rerun the importer and use the new report as the editorial punch list.

## Preview and verify

Serve the project over HTTP:

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000/`. A dependency-free browser smoke test is available at `http://localhost:8000/tests/smoke.html`; it exercises all three interactions and draft-card handling.

Before publishing a revision:

1. Run the importer and confirm it reports zero errors.
2. Review `data/import-report.json`, especially new or changed warnings.
3. Open representative cards from each interaction and section.
4. Run `tests/smoke.html` in a current browser and confirm it reports `PASS`.
5. Verify final production artwork has replaced draft thumbnails when it becomes available.
