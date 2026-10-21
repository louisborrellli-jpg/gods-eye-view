- Add a Detroit Open Data layer: City of Detroit official open data on the
  globe, drawn by map area and toggled by category — traffic signals (civic),
  recent crime (incidents) and roadwork/closures (road, from Michigan DOT Mi
  Drive). Points and lines are coloured by dataset and a click shows the
  record's details; data loads only while the view is over metro Detroit and
  zoomed in, through a cached `/api/detroit/<dataset>` proxy that builds every
  query itself (louisborrellli-jpg, #17).
