# Nanyang Kopi & Toast - Kiosk Menu & Kitchen Printer Notes

Owner: Mei (Menu & Store Experience Lead) & Arjun (Tech & POS Lead)
Last reviewed: 11 November 2026

## 1. What happened in yesterday's kiosk trial

- Out of 28 first-time expats, tourists, and younger CBD office workers in yesterday's Raffles Place trial, 19 (68%) froze for over 2 minutes at Step 2 (`Kopi O Kosong`, `Kopi C Siew Dai`, `Teh Halia`), backing the morning queue out the glass doors.
- 72% of confused first-timers never noticed the small top-right language toggle before tapping a drink button.

## 2. Kitchen printer and screen limits

- **Kitchen thermal docket (`ticket_label`):** In POS v2.4, button `display_name` prints straight onto the kitchen docket. Our 65-year-old kopi uncles read traditional shorthand (`Kopi O Kosong`) at a glance. When we tested English names (`Black Coffee No Sugar`) at Tampines, drink prep slowed by 15 seconds per cup, and local regulars mocked a rival shop on Reddit for calling Kopi O a "Local Americano".
- **15-inch touchscreen grid:** Each page fits 12 buttons (max 18 characters per line). Adding two-line subtitles under all 24 drinks pushes half the menu onto Page 2.

## 3. POS v2.4 technical specifications

- **Separate print label (`kitchen_print_name`):** POS v2.4 supports a separate `kitchen_print_name` field alongside the customer screen `display_name` (1 hour configuration time), keeping traditional Kopi shorthand on kitchen thermal dockets regardless of screen text.
- **2-step customisation modal:** POS v2.4 includes an optional 2-step Milk & Sugar pop-up modal triggered when a customer taps `Kopi` or `Teh` (1.5 hours configuration time).
