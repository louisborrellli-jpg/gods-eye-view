- Add Shipments. Enter a container number and nothing else: with a FindTEU
  key (ADD KEYS) the board fills in the ship, ETAs, unloading, the rail leg
  when the line reports it, pickup and empty return, and counts down the
  port, rail-ramp and empty-return free time from free days set once. It
  sorts boxes by urgency and warns before storage or detention charges start
  ("book a truck", "truck booked after the last free day", holds, a ship
  reporting a later ETA). The ship is found in the live AIS feed through a
  new `/api/vessels/find` route and pinned on the globe; with a Terminal49
  key each container is also registered there for its rail view. Shipments
  stay in this browser and never enter share links (louisborrellli-jpg, #26).
