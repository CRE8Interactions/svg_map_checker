# SVG Map Quality Checker

Upload a seat map SVG to quality check sections, rows, and seats.

## Features

- **Upload** – Choose an SVG file to load
- **100% preview** – Map displays at full scale with all identifiers visible
- **Zoom** – Use +/− to zoom 25–200%. When zoomed **in** (above 100%), identifier shapes fade to a faint grey so seats are exposed for QC
- **Side panel** – Section breakdown and total seat count
- **Three selection modes** (toolbar):
  - **Cursor** – Hover a seat: popover shows SEC, ROW, SEAT
  - **3 dots** – Hover a seat: highlights the full row; popover shows SEC, ROW, total seats in row
  - **Grid** – Hover a seat: highlights the whole section; popover shows SEC and total seats in section

## SVG format

Seats must be `<rect>` elements with classes like `sec-124-row-9-seat-12`.  
Identifiers (row/section labels) use classes containing `-label-` or `-path`.

## Usage

1. Open `index.html` in a browser
2. Click “Choose SVG file” and select your map SVG
3. Use the toolbar to switch between seat / row / section modes
4. Hover over seats to see popovers
5. Zoom in to fade identifiers and expose seats for detailed QC
