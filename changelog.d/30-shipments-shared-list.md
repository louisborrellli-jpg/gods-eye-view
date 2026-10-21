- The shipments list now lives on the app's own server when it runs, so
  everyone on the network sees the same containers and tracking keeps going
  with no page open (stored in `.gev-data/shipments.json`). A browser's earlier
  list is copied up once; a static host keeps the list in the browser as
  before. Tracking also reads the loading date at origin, shown as its own
  column on the Shipments page, in the detail timeline and under home-page
  search results (#30).
