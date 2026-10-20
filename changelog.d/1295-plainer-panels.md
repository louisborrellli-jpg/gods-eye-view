- Control labels say what they do. `GNSS Integrity` is now `GPS Interference`,
  `Local ADS-B` is `My Receiver (ADS-B)`, `ALPR Cameras` are `License Plate
  Readers`, `FIRMS Active Fires` are `Active Fires (NASA)`, `Live AIS Vessels`
  are `Ships (AIS)`, and the visual filters read `Night Vision` and `Thermal`
  rather than `NVG` and `FLIR`. Acronyms that are the searchable term for a
  thing are kept in parentheses rather than dropped.
- The Data Layers groups collapse. Movement, Cameras, Infrastructure, Events,
  Weather and Utilities already existed as headings; each is now a button that
  folds its own rows away, so a thirty-row list can be read as six groups.
- Detect's label-placement tuning (allocation, fade, outside opacity) moves
  behind an `Advanced` disclosure, leaving Density in place as the common
  adjustment. Display drops from twenty visible controls to seventeen. The
  rows keep their ids and their `.visible` class, so the existing show/hide
  when Detect turns on and off is untouched.
