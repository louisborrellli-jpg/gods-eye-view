- Switching Cameras on selects the camera nearest the view instead of the first
  one in the catalog. The catalog is ordered by source pack, so "first" meant
  whichever pack loads first — Austin, for anyone who had not retuned
  `CCTV_AUSTIN_*`. Someone looking at Windsor now gets the nearest camera to
  Windsor. Nearest is measured from the viewer rather than a configured home
  city, since the current view is the only thing that knows where the operator
  is; with no viewer position yet the pick falls back to catalog order, and an
  exact tie keeps the earlier entry so the same catalog always yields the same
  camera.
