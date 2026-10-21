- Add Shipments. Enter a container number and its ship; the board counts
  down the port, rail-ramp and empty-return free time, sorts boxes by
  urgency and warns before storage or detention charges start ("book a
  truck", "truck booked after the last free day", holds, a ship reporting a
  later ETA). The ship is found in the live AIS feed through a new
  `/api/vessels/find` route and pinned on the globe. Shipments stay in this
  browser and never enter share links (louisborrellli-jpg, #26).
